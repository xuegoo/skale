#!/usr/local/bin/node

'use strict';

var net = require('net');
var util = require('util');
var stream = require('stream');
var uuidGen = require('node-uuid');
var UgridClient = require('../lib/ugrid-client.js');
var webSocketServer = require('ws').Server;
var websocket = require('websocket-stream');

var opt = require('node-getopt').create([
	['h', 'help', 'print this help text'],
	['H', 'Host=ARG', 'primary server host (default none)'],
	['n', 'name=ARG', 'advertised server name (default localhost)'],
	['P', 'Port=ARG', 'primary server port (default none)'],
	['p', 'port=ARG', 'server port (default 12346)'],
	['s', 'statistics', 'print periodic statistics'],
	['w', 'wsport=ARG', 'listen on websocket port (default none)'],
	['v', 'version', 'print version']
]).bindHelp().parseSystem();

var clients = {};
var clientMax = 4;
var topics = [];
var topicMax = 0;
var topicIndex = {};
//var name = opt.options.name || 'localhost';
var port = opt.options.port || 12346;
var msgCount = 0;
var wss;
var crossbar = [], crossn = 4;
var minMulticast = 4294901760;	 // 2^32 - 2^16

function SwitchBoard(sock) {
	if (!(this instanceof SwitchBoard))
		return new SwitchBoard(sock);
	stream.Transform.call(this, {objectMode: true});
	this.crossIndex = sock.crossIndex = crossn++;
	crossbar[this.crossIndex] = sock;
	this.sock = sock;
}
util.inherits(SwitchBoard, stream.Transform);

SwitchBoard.prototype._transform = function (chunk, encoding, done) {
	var o = {}, to = chunk.readUInt32LE(0, true);
	if (to >= minMulticast)	{	// Multicast
		var sub = topics[to - minMulticast].sub, len = sub.length, n = 0;
		for (var i in sub) {
			if (crossbar[sub[i]])
				crossbar[sub[i]].write(chunk, function () {
					if (++n == len) done();
				});
			else if (!--len) done();
		}
	} else if (to > 3) {		// Unicast
		if (crossbar[to]) crossbar[to].write(chunk, done);
		else done();
//	} else if (to === 3) {	// Foreign
//	} else if (to === 2) {	// Multicast
//	} else if (to === 1) {	// Broadcast
	} else if (to === 0) {	// Server request
		try {
			o = JSON.parse(chunk.slice(8));
			if (!(o.cmd in clientCommand)) throw 'Invalid command: ' + o.cmd;
			o.data = clientCommand[o.cmd](this.sock, o);
		} catch (error) {
			console.error(o);
			o.error = error;
			console.error(error);
		}
		o.cmd = 'reply';
		this.sock.write(UgridClient.encode(o), done);
	}
};

var clientCommand = {
	connect: function (sock, msg) {
		return register(null, msg, sock);
	},
	devices: function (sock, msg) {
		return devices(msg.data);
	},
	get: function (sock, msg) {
		return clients[msg.data] ? clients[msg.data].data : 'error: not found';
	},
	id: function (sock, msg) {
		return msg.data in clients ? clients[msg.data].index : null;
	},
	tid: function (sock, msg) {
		return getTopicId(msg.data);
	},
	subscribe: function (sock, msg) {
		return subscribe(sock.client, msg.data);
	},
	unsubscribe: function (sock, msg) {
		return unsubscribe(sock.client, msg.data);
	}
};

// Start a websocket server if a listening port is specified on command line
if (opt.options.wsport) {
	wss = new webSocketServer({port: opt.options.wsport});
	wss.on('connection', function (ws) {
		console.log('websocket connect');
		var sock = websocket(ws);
		sock.ws = true;
		handleConnect(sock);
		ws.on('close', function () {
			console.log('## connection end');
			if (sock.client) sock.client.sock = null;
			if (sock.crossIndex) delete crossbar[sock.crossIndex];
		});
	});
}

// Start a TCP server
net.createServer(handleConnect).listen(port);
console.log("## Started " + Date());

function handleConnect(sock) {
	if (sock.ws) { 
		console.log('Connect websocket from ' + sock.socket.upgradeReq.headers.origin);
	} else {
		console.log('Connect tcp ' + sock.remoteAddress + ' ' + sock.remotePort);
		sock.setNoDelay();
	}
	sock.pipe(new UgridClient.FromGrid()).pipe(new SwitchBoard(sock));
	sock.on('end', function () {
		if (sock.client) sock.client.sock = null;
		if (sock.crossIndex) delete crossbar[sock.crossIndex];
		console.log('## connection end');
	});
	sock.on('error', function (error) {
		console.log('## connection error');
		console.log(error);
		console.log(sock);
	});
}

function register(from, msg, sock)
{
	var uuid = msg.uuid || uuidGen.v1(), index = clientMax++;
	// sock.client = clients[uuid] = {
	clients[uuid] = {
		index: index,
		uuid: uuid,
		owner: from ? from : uuid,
		data: msg.data || {},
		sock: sock,
		subscribed: {},
		published: {}
	};
	sock.client = clients[uuid];
	return {uuid: uuid, token: 0, id: index};
}

function devices(query) {
	var result = [];
	for (var i in clients) {
		if (!clients[i].sock) continue;
		var match = true;
		for (var j in query)
			if (!clients[i].data || clients[i].data[j] != query[j]) {
				match = false;
				break;
			}
		if (match)
			result.push({uuid: i, id: clients[i].index, ip: clients[i].sock.remoteAddress});
	}
	return result;
}

function getTopicId(topic) {
	if (topic in topicIndex) return topicIndex[topic];
	topics[topicMax] = {name: topic, id: topicMax, sub: []};
	topicIndex[topic] = topicMax++;
	return topicIndex[topic]
}

function subscribe(client, topic) {
	var sub = topics[getTopicId(topic)].sub
	if (sub.indexOf(client.index) < 0) sub.push(client.index);
}

function unsubscribe(client, topic) {
	if (!(topic in topicIndex)) return;
	var sub = topics[topicIndex[topic]].sub, i = sub.indexOf(client.index);
	if (i >= 0) sub.splice(i, 1);
}

if (opt.options.statistics) {
	setInterval(function () {
		console.log('msg: ' + (msgCount / 5) + ' msg/s');
		msgCount = 0;
	}, 10000);
}
