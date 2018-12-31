var program = require('commander');
var version = require('./version');
var Server = require('./server').Server;
var User = require('./user').User;
var log = require("./logger")._system;

'use strict';

module.exports = function() {

  program
    .version(version)
    .option('-U, --user-storage-path [path]', 'look for alexa user files at [path] instead of the default location (~/.alexa)', function(p) { User.setStoragePath(p); })
    .option('-D, --debug', 'turn on debug level logging', function() { require('./logger').setDebugEnabled(true) })
    .option('-p, --use-proxy', 'use a proxy', function() { Server.useProxy(true) })
    .option('-P, --proxy', 'run as proxy', function() { Server.asProxy(true) })
    .parse(process.argv);

  var server = new Server();

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
