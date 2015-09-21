#!/usr/local/bin/node --harmony
'use strict';

// démo calcul du churn rate à partir d'une liste de connexion stockée dans mongoDB
// export des points de mesure vers postgreSQL pour utilisation dans tableau
// CREATE TABLE churnrate2 (value numeric, timestamp date);
var co = require('co'), pg = require('pg'), thenify = require('thenify');
var MongoClient = require('mongodb').MongoClient;
var ugrid = require('../');
require('child_process').execSync('rm -rf /tmp/ugrid/');

var MongoConnect = thenify(MongoClient.connect);
var client = new pg.Client('postgres://cedricartigue@localhost/cedricartigue');

var lambda = 30;                                    // Number of inactive days before churn is considered effective
var P = 30;                                         // Number of day included in calculus window         
var nDays = 100;                                    // Number of day since begining

client.connect(function(err) {
    if(err) return console.error('could not connect to postgres', err);    
    co(function *() {
        var uc = yield ugrid.context();
        var db = yield MongoConnect('mongodb://localhost:27017/ugrid');
        var N = 100000;  // Hard limit to be released in ugrid stream engine

        function computeChurnRate(prebegin, begin, end, callback) {
            var cursor = db.collection('connexions').find({date: {$gte: prebegin, $lte: end}}, {_id: false});

            var acc = [], date = new Date(begin);
            for (var i = 0; i < P; i++) {
                date.setHours(date.getHours() + 24);
                acc.push({date: new Date(date), customer: 0, churner: 0});
            }

            function combiner(acc, data) {
                for (var i in acc) {
                    acc[i].customer += data[i].customer;
                    acc[i].churner += data[i].churner;
                }
                return acc;
            }

            // Ici il me faudrait lambda comme paramètre
            function reducer(acc, data) {
                for (var day in acc) {                                  // Loop over day in time period P
                    var ts_day = new Date(acc[day].date).getTime();     // convert to timestamp
                    // Step 1: Active client
                    for (var i in data[1]) {
                        var ts_connexion = new Date(data[1][i]).getTime();
                        var elapsed = (ts_day - ts_connexion) / (1000 * 3600 * 24);
                        if (elapsed < 0) continue;                      // connexion occurs after day x
                        if (elapsed <= 30) {                             // connexion occurs during the last 30 days, customer has not churned, move on
                            acc[day].customer++;
                            break;
                        }
                    }
                    // Step 2: Did customer churn on day x ? si event tous après x
                    var churned = true, not_yet_a_customer = true;
                    for (var i in data[1]) {
                        var ts_connexion = new Date(data[1][i]).getTime();
                        var elapsed = (ts_day - ts_connexion) / (1000 * 3600 * 24);
                        // console.log('elapsed = ' + elapsed)
                        if (elapsed < 0) continue;                          // connexion occurs after day x
                        elapsed = Math.floor(elapsed);
                        if (not_yet_a_customer) not_yet_a_customer = false;
                        if (elapsed != 30) churned = false;                 // si déjà compatibilisé comme churner avant x ou connexion < lambda jour
                    }
                    if (!not_yet_a_customer && churned) acc[day].churner++;
                }
                return acc;
            }

            uc.objectStream(cursor, {N: N})
                .map(function (connexion) {return [connexion.customer_id, connexion.date];})
                .groupByKey()
                .aggregate(reducer, combiner, acc, function(err, res) {
                    var num = 0, denom = 0;
                    for (var x = 0; x < res.length; x++) {
                        num += res[x].churner;
                        denom += res[x].customer;  // experimental ICI
                    }
                    callback(Math.round(num / denom * lambda * 100) / 100);
                });
        }

        function done(churnrate) {
            console.log('churnrate on ' + end + ' = ' + churnrate);
            var date = new Date(end);
            // date.setHours(date.getHours() + 24 * Math.round(Math.random() * 4000));

            client.query('INSERT INTO cr VALUES ($1, $2)', [churnrate, date], function(err, result) {
                if (err) return console.error('error running query', err);
                if (++n < nDays) {
                    prebegin.setHours(prebegin.getHours() + 24);
                    begin.setHours(begin.getHours() + 24);
                    end.setHours(end.getHours() + 24);
                    computeChurnRate(prebegin, begin, end, done);
                } else {
                    db.close();
                    client.end();
                    uc.end();
                }
            });
        }

        var now = new Date(), oneYearAgo = new Date(now);   // Begin to compute one year ago from now
        oneYearAgo.setFullYear(now.getFullYear() - 1);
        var begin = new Date(oneYearAgo), end = new Date(begin), prebegin = new Date(begin);
        end.setHours(end.getHours() + (24 * P));
        prebegin.setHours(prebegin.getHours() - (24 * lambda));
        var n = 0;
        computeChurnRate(prebegin, begin, end, done);
    }).catch(ugrid.onError);
});