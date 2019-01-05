var program = require('commander');
var version = require('./version');
var Server = require('./server').Server;
var User = require('./user').User;
var log = require("./logger")._system;
var FHEM = require('./fhem').FHEM;

'use strict';

module.exports = function() {

  program
    .version(version)
    .option('-U, --user-storage-path [path]', 'look for alexa user files at [path] instead of the default location (~/.alexa)', function(p) { User.setStoragePath(p); })
    .option('-c, --config-file [file]', 'use [file] as config file instead of the default (~/.alexa/config.json)', function(f) { User.setConfigFile(f); })
    .option('-D, --debug', 'turn on debug level logging', function() { require('./logger').setDebugEnabled(true) })
    .option('-p, --use-proxy', 'use a proxy', function() { Server.useProxy(true) })
    .option('-P, --proxy', 'run as proxy', function() { Server.asProxy(true) })
    .option('-a, --auth [auth]', 'user:password for fhem connection', function(a) { FHEM.auth(a) })
    .option('-s, --ssl', 'use https for fhem connection', function() { FHEM.useSSL(true) })
    .parse(process.argv);

  var server = new Server();

  process.on('disconnect', function() {
    console.log('parent exited')
    server.shutdown();
  });

  process.stdin.on( 'end', function() {
    console.log('STDIN EOF')
    server.shutdown();
  });

  var signals = { 'SIGINT': 2, 'SIGTERM': 15 };
  Object.keys(signals).forEach(function (signal) {
    process.on(signal, function () {
      log.info("Got %s, shutting down alexa-fhem...", signal);

      server.shutdown();

      process.exit(128 + signals[signal]);
    });
  });

  server.run();
}
