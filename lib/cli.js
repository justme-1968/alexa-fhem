
var program = require('commander');
var version = require('./version');
var Server = require('./server').Server;
var User = require('./user').User;
var log = require("./logger")._system;
var FHEM = require('./fhem').FHEM;

'use strict';

module.exports = function() {

  // What has to be done before we can start the servers? Default: nothing;
  let startupPromise = new Promise(function (resolve) {
    resolve();
  });

  var server;

  program
    .version(version)
    .option('-U, --user-storage-path [path]', 'look for alexa user files at [path] instead of the default location (~/.alexa)', function(p) { User.setStoragePath(p); })
    .option('-c, --config-file [file]', 'use [file] as config file instead of the default (~/.alexa/config.json)', function(f) { User.setConfigFile(f); })
    .option('-D, --debug', 'turn on debug level logging', function() { require('./logger').setDebugEnabled(true) })
    //.option('-p, --use-proxy', 'use a proxy', function() { Server.useProxy(true) })
    //.option('-P, --proxy', 'run as proxy', function() { Server.asProxy(true) })
    .option('-a, --auth [auth]', 'user:password for fhem connection', function(a) { FHEM.auth(a); User.auth(a) })
    .option('-s, --ssl', 'use https for fhem connection', function() { FHEM.useSSL(true); User.useSSL(true) })
    .option('-A, --autoconfig', 'automatically try to create config, find FHEM and prepare for public skill',
       function() {
//      startupPromise = User.autoConfig(true);
         console.log ("Sorry, option -A will be available soon again!");
         process.exit();
    })
    .parse(process.argv);

  startupPromise.then(() => {
    server = new Server();

    process.on('disconnect', function () {
      console.log('parent exited')
      server.shutdown();
    });

    //process.stdout.resume();
    process.stdout.on('end', function() {
      console.log('STDOUT EOF')
      server.shutdown();
    });

    process.stdin.resume();
    process.stdin.on('end', function () {
      console.log('STDIN EOF')
      server.shutdown();
    });

    var signals = {'SIGINT': 2, 'SIGTERM': 15};
    Object.keys(signals).forEach(function (signal) {
      process.on(signal, function () {
        log.info("Got %s, shutting down alexa-fhem...", signal);

        server.shutdown();
      });
    });

    server.run();


  }).catch((reason) => {
    console.error("Startup rejected. Reason: " + reason);
  })
}
