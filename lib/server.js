
'use strict';

const PORT=3000;

var path = require('path');
var fs = require('fs');

var version = require('./version');

var User = require('./user').User;

var log = require("./logger")._system;
var Logger = require('./logger').Logger;

var FHEM = require('./fhem').FHEM;

const util = require('util');

// For ssh proxy: Readings for Amazon provisioned token and SSH status:
const BEARERTOKEN_NAME = "alexaFHEM.bearerToken";
const SSHSTATUS_NAME = "alexaFHEM.ProxyConnection";

module.exports = {
  Server: Server
}

function Server() {
  this._config = this._loadConfig();

  if( Server.as_proxy )
    this._config.alexa = this._config['alexa-proxy'];

  if( !this._config.alexa && !this._config.sshproxy ) {
    log.error( 'error: neither alexa nor proxy config found, nothing to do' );
    process.exit(-1);
  }

  if( this._config.alexa && this._config.alexa.port === undefined )
    this._config.alexa.port = PORT;

  if( this._config.alexa && this._config.sshproxy
    && this._config.alexa.port !== undefined && this._config.alexa.port === this._config.sshproxy.port ) {
    log.error( 'error: alexa and proxy ports are identical' );
    process.exit(-1);
  }

  if (this._config.sshproxy) {
    this._config.sshproxy.options = [ '-i', path.join(User.sshKeyPath(), 'id_rsa'), '-p', 58824, 'fhem-va.fhem.de' ];
  }

}

Server.as_proxy = false;
Server.use_proxy = false;
Server.asProxy = function(as_proxy) {
  try {
    require.resolve('socket.io')
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') {
      throw e;
    }

    log.error( 'error: socket.io not installed' );
    process.exit(-1);
  }

  if( Server.use_proxy ) {
    log.error( 'error: can\'t run as proxy with use-proxy' );
    process.exit(-1);
  }

  Server.as_proxy = as_proxy;
}

Server.useProxy = function(use_proxy) {
  try {
    require.resolve('socket.io-client')
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') {
      throw e;
    }

    log.error( 'error: socket.io-client not installed' );
    process.exit(-1);
  }

  if( Server.as_proxy ) {
    log.error( 'error: can\'t run with use-proxy as proxy' );
    process.exit(-1);
  }

  Server.use_proxy = use_proxy;
}


Server.prototype._loadConfig = function() {
  // Look for the configuration file
  var configPath = User.configPath();
  log.info("using config from " + configPath );

  var config;
  // Complain and exit if it doesn't exist yet
  if( !fs.existsSync(configPath) ) {
      log.error("Couldn't find a config file at '"+configPath+"'. Look at config-sample.json for an example.");
      process.exit(1);
  }

  // Load up the configuration file
  try {
    config = JSON.parse(fs.readFileSync(configPath));
  }
  catch (err) {
    log.error("There was a problem reading your config.json file.");
    log.error("Please try pasting your config.json file here to validate it: http://jsonlint.com");
    log.error("");
    throw err;
  }

  if( config.alexa ) {
    if( config.alexa.applicationId !== undefined && typeof config.alexa.applicationId !== 'object' )
      config.alexa.applicationId = [config.alexa.applicationId];

    if( config.alexa.oauthClientID !== undefined && typeof config.alexa.oauthClientID !== 'object' )
      config.alexa.oauthClientID = [config.alexa.oauthClientID];

    var username = config.alexa.username;
  }

  console.log( '*** CONFIG: parsed completely' );

  return config;
}

Server.prototype.startProxy = function(fhem, alexaDevName) {
  if( this._config.sshproxy.server !== undefined ) {
    return;
  }

  function processRequest(request, response){
    //console.log( request );
    //console.log( request.url );

    var body = '';
    request.on('data', function(chunk){body += chunk});
    request.on('end', function() {

      function processBody(response, body) {
        log.info (">>>> [ssh] " + body.replace(/[\r\n]/gm, ' '));
        var event = JSON.parse(body);
        verifyToken.bind(this)(true, event, function(ret, error) {
          if( error )
            log.error( 'ERROR: ' + error + ' from ' + request.connection.remoteAddress );

          const rsp = JSON.stringify(ret);
          log.info('<<<< [ssh] '+ rsp);
          response.end(rsp); });
      }

      if( 1 ) {
        try {
          processBody.bind(this)(response, body);

        } catch( e ) {
          log.error( 'ERROR: ' + util.inspect(e) + ' from ' + request.connection.remoteAddress );
          const rsp = JSON.stringify(createError(ERROR_UNSUPPORTED_OPERATION));
          log.error('<<<< [ssh] '+ rsp);
          response.end(rsp);

        }// try-catch

      } else {
        processBody.bind(this)(response, body);

      }
    }.bind(this));
  }


  var server = require('http').createServer(processRequest.bind(this));

  server.on('error', (res) => {
    log.error ("Server emitted error: " + JSON.stringify(res));
    if (res.syscall === "listen") {
      log.info ("Terminating - starting the listener not possible (another instance running?)");
      process.exit(1);
    }
  });

  if( this._config.sshproxy['bind-ip'] === undefined ) this._config.sshproxy['bind-ip'] = '127.0.0.1';

  server.setTimeout(0);
  server.listen(this._config.sshproxy.port, this._config.sshproxy['bind-ip'], function(){
    log.info("Server listening on: http://%s:%s for proxy connections", server.address().address, server.address().port);
    this._config.sshproxy.server = server;

    log.info ("*** SSH: checking proxy configuration");
    var startupPromise = User.autoConfig(false, this._config, fhem, alexaDevName);
    startupPromise.then ( (r) => {
      log.info("*** SSH: proxy configuration set up done");
      this.open_ssh(this._config.sshproxy);
      // This fixes (hopefully) a race condition: Initial SSH setup takes longer than server setup
      if (typeof r === "object" && r.hasOwnProperty('bearerToken')) {
        log.info ('SSH setup completed with new bearer token');
        published_tokens.push(r.bearerToken);
      }
    }).catch((e) => {
      log.error('*** SSH: proxy configuration failed: ' + e);
      setTimeout( ()=>{ this.set_ssh_state( 'error', e ); }, 1000);
    });

  }.bind(this) );
}

Server.prototype.startProxy2 = function(fhem, alexaDevName) {
  if( this._config.sshproxy.server !== undefined ) {
    return;
  }

  var Client = null;
  try {
    Client = require('ssh2').Client;
  } catch(e) {
    if( e.code !== 'MODULE_NOT_FOUND' )
      throw e;

    console.error( 'ssh2 not available, falling back to external ssh' );
    this.startProxy(fhem, alexaDevName);
    return;
  }


  var conn = new Client();
  conn.on('ready', function() {
    log.info('*** SSH: proxy connection established');

    conn.shell({ window: false }, function(err, stream) {
      if (err) throw err;

      stream.on('close', function() {
        log.info('*** SSH: closed');
        conn.end();

      }).on('data', function(data) {
        log.info('SSH: ' + data);

      });
    });

    conn.forwardIn('127.0.0.1', 1234, function(err) {
      if (err) throw err;
      log.info('*** SSH: tunnel connection established');
    });

  }).on('tcp connection', function(info, accept, reject) {
    //console.log('TCP :: INCOMING CONNECTION:');
    //console.dir(info);
    let session = accept();

    session.on('close', function() {
      //console.log('TCP :: CLOSED');
    }).on('error', function(e) {
      //console.log('TCP :: ERROR ' + e);
    }).on('data', function(data) {
      //console.log('TCP :: DATA: ' + data);

      var parts = data.toString().split( '\r\n\r\n' );
      let body = parts[1];

      function processBody(conn, body) {
        log.info (">>>> [ssh] " + body.replace(/[\r\n]/gm, ' '));
        var event = JSON.parse(body);
        verifyToken.bind(this)(true, event, function(ret, error) {
          if( error )
            log.error( 'ERROR: ' + error );

          const rsp = JSON.stringify(ret);
          log.info('<<<< [ssh] '+ rsp);
          var header = 'HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length:'+ rsp.length +'\r\n';
          session.end(header + '\r\n' +rsp); });
      }

      if( 1 ) {
        try {
          processBody.bind(this)(conn, body);

        } catch( e ) {
          log.error( 'ERROR: ' + util.inspect(e) );
          const rsp = JSON.stringify(createError(ERROR_UNSUPPORTED_OPERATION));
          log.error('<<<< [ssh] '+ rsp);
          var header = 'HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length:'+ rsp.length +'\r\n';
          session.end(header + '\r\n' +rsp);

        }// try-catch

      } else {
        processBody.bind(this)(conn, body);

      }
    }.bind(this));
  }.bind(this)).connect({
    host: 'fhem-va.fhem.de',
    port: 58824,
    username: 'xxx',
    keepaliveInterval: 90*1000,
    privateKey: require('fs').readFileSync('./key')
  });
}

var sockets = {};
Server.prototype.startServer = function() {
  function processRequest(request, response){
    //console.log( request );
    //console.log( request.url );

    var body = '';
    request.on('data', function(chunk){body += chunk});
    request.on('end', function() {
      if( request.url === '/favicon.ico' ) {
        response.writeHead(404);
        response.end('');
        return;
      }

      function processBody(response, body) {
        log.info (">>>> [srv] " + body.replace(/[\r\n]/gm, ' '));
        var event = JSON.parse(body);
        verifyToken.bind(this)(false, event, function(ret, error) {
          if( error )
            log.error( 'ERROR: ' + error + ' from ' + request.connection.remoteAddress );
          const rsp = JSON.stringify(ret);
          log.info ("<<<< [srv] " + rsp);
          response.end(rsp); });
      }

      if( 1 ) {
        try {
          processBody.bind(this)(response, body);

        } catch( e ) {
          log.error( 'ERROR: ' + util.inspect(e) + ' from ' + request.connection.remoteAddress );

          const rsp = JSON.stringify(createError(ERROR_UNSUPPORTED_OPERATION));
          log.error ("<<<< [srv] " + rsp);
          response.end(rsp);

        }// try-catch

      } else {
        processBody.bind(this)(response, body);

      }
    }.bind(this));
  }


  var server;
  if( this._config.alexa.ssl === false ) {
    server = require('http').createServer(processRequest.bind(this));
  } else {
    let options = {
      key: fs.readFileSync(this._config.alexa.keyFile || './key.pem'),
      cert: fs.readFileSync( this._config.alexa.certFile || './cert.pem'),
    };
    server = require('https').createServer(options,processRequest.bind(this));
  }

  server.on('error', (res) => {
    log.error ("Server emitted error: " + JSON.stringify(res));
    if (res.syscall === "listen") {
      log.info ("Terminating - starting the listener not possible (another instance running?)");
      process.exit(1);
    }
  });

  server.listen(this._config.alexa.port, this._config.alexa['bind-ip'], function(){
    log.info("Server listening on: http%s://%s:%s for direct connections", this._config.alexa.ssl === false?'':'s',
                                                                           server.address().address, server.address().port);

    if( Server.as_proxy ) {
      var io = require('socket.io');
      io = io.listen(server);
      io.on('connection', function(socket){
        console.log('a user connected');

        socket.on('register', function(msg){
          console.log('user registered');
          socket.id = msg;
          sockets[msg] = socket;
        });

        socket.on('disconnect', function(){
          delete sockets[socket.id];
          console.log('user disconnected');
        });
      });
    }

  }.bind(this) );
}

Server.prototype.connectToProxy = function() {
  log.info('trying to connect to proxy ');

  const io = require('socket.io-client');

  const socket = io('https://'+ this._config.alexa.proxy, {rejectUnauthorized: false});

  socket.on('event', function(msg,callback) {
    try {
      log.info (">>>> [prx] " + msg.replace(/[\r\n]/gm, ' '));
      var event = JSON.parse(msg);
      verifyToken.bind(this)(false, event, function(ret, error) {
        if( error )
          log.error( 'ERROR: ' + error + ' from proxy'  );

        const rsp = JSON.stringify(ret);
        log.info( "<<<< [prx] " + rsp);
        callback(rsp);
      });
    } catch( e ) {
      if( e )
        log.error( 'ERROR: ' + util.inspect(e) + ' from proxy' );
      const rsp = JSON.stringify(createError(ERROR_UNSUPPORTED_OPERATION));
      log.info( "<<<< [prx] " + rsp);
      callback(rsp);

    }// try-catch
  }.bind(this));

  socket.on('connect', () => {
    log.info('connected to proxy: ' +this._config.alexa.proxy);
    for( let i = 0; i < this._config.alexa.oauthClientID.length; ++i ) {
      socket.emit('register', this._config.alexa.oauthClientID[i]);
    }
  });

  socket.on('disconnect', (reason) => {
    log.info('disconnect from proxy: ' +reason);
    log.info('trying to reconnect to proxy ');
  });
}

var ssh_client;
var ssh_client_state;
var ssh_client_laststderr;
var ssh_client_reconnectdelay = undefined;

Server.prototype.set_ssh_state = function( state, txt ) {
  ssh_client_state = state;
  if( txt === undefined )
    this.setreading( SSHSTATUS_NAME, state );
  else
    this.setreading( SSHSTATUS_NAME, state +";; "+ txt );
}
Server.prototype.unregister_ssh = function() {
  const proxy_config = this._config.sshproxy;
  const execSync = require('child_process').spawnSync;
  const prc = execSync( proxy_config.ssh, proxy_config.options.concat(['unregister']));
  if (prc.error) {
    log.warn ("Error executing unregister: " + prc.error.message);
    return;
  }
  if (prc.status !== 0) {
    log.warn ( "ssh unregister returned error - " + (prc.output[2].toString()));
    return;
  }
  log.info ("ssh unregister: Result is " + prc.output[1].toString().replace(/[\r\n]/gm, ' '));
  if (ssh_client) {
    ssh_client.removeAllListeners('close');
    ssh_client.kill();
    this.set_ssh_state( 'stopped', ssh_client_laststderr);
  }
}

Server.prototype.open_ssh = function() {
  if( !ssh_client ) {
    this.set_ssh_state( 'starting', 'starting SSH' );
    ssh_client_laststderr = undefined;
    ssh_client_reconnectdelay = undefined;

    const proxy_config = this._config.sshproxy;

    if( proxy_config.server === undefined ) {
      this.set_ssh_state( 'stopped', 'server for reverse tunnel not started');
      log.warn ("*** SSH: server for reverse tunnel not started");
      return;
    }

    const exec = require('child_process').spawn;
    const args = ['-R', '1234:' + proxy_config['bind-ip']+ ':' + proxy_config.server.address().port,
          '-oServerAliveInterval=90'].concat(proxy_config.options);
    log.info ("Starting SSH with " + args.join(' '));
    ssh_client = exec( proxy_config.ssh, args);

    ssh_client.stdout.on('data', (data) => {
      const delayReconnectRegex = /\(retry: (\d+) seconds\)/m;
      const str = data.toString();

      if (str.indexOf('Welcome at the reverse proxy')>=0) {
        this.set_ssh_state('running', 'SSH connected')
        log.info ("*** SSH: proxy connection established");
      } else {
        log.info ("*** SSH: stdout message: " + str);
        const match = delayReconnectRegex.exec(str);
        if (match) {
          ssh_client_reconnectdelay = parseInt(match[1])*1000;
        }
        this.set_ssh_state('running', data.toString());
      }

      log.info('SSH: ' + str.replace(/[\r\n]/gm, ' '));
    });

    ssh_client.stderr.on('data', (data) => {
      const str = data.toString();
      // Ignore Pseudo-terminal will not be allocated because stdin is not a terminal.
      if (str.toLowerCase().indexOf('pseudo-terminal')<0) {
        const stderrmsg = str.replace(/[\r\n]/gm, ' ');
        this.set_ssh_state('running', 'stderr=' + stderrmsg);
        log.info ("*** SSH: stderr: " + stderrmsg);
        ssh_client_laststderr = stderrmsg;
      }
    });

    ssh_client.on('close', (code) => {
      if( ssh_client_state !== 'running' ) {
        this.set_ssh_state( 'stopped', ssh_client_laststderr);
        log.warn ("*** SSH: exited with " + (ssh_client_laststderr ? ssh_client_laststderr : code));
        return;
      }
      // Wait some time (15-135 seconds) not to overload the server...
      const delay = ssh_client_reconnectdelay ? ssh_client_reconnectdelay : 15000 + Math.random()*120000;
      const date = new Date(new Date().getTime()+delay);
      let d = [ date.getHours(), date.getMinutes(), date.getSeconds()];
      d = d.map(d => { return d<10 ? "0" + d.toString() : d.toString()});
      log.error('SSH: exited with ' + code + ' - will restart in ' + delay/1000 + ' seconds');
      ssh_client = undefined;
      this.set_ssh_state( 'stopped', 'Terminated with ' +
        (ssh_client_laststderr ? ssh_client_laststderr : code) + ', ssh will restart at ' + d.join(':') );
      setTimeout(()=>{ this.open_ssh(proxy_config) }, delay);
    });

/*
    process.on('exit', (code) => {
      this.set_ssh_state( 'stopping', 'alexa-fhem terminating' );
      if( ssh_client ) {
        log.info('Killing SSH on event process.exit');
        ssh_client.kill();
        console.log('done!');
      }
    });
*/
  }
}

Server.prototype.addDevice = function(device, fhem) {
  if( !device.isInScope('alexa.*') ) {
    log.info( 'ignoring '+ device.name +' for alexa' );
    return;
  }

  if( device.proactiveEvents === undefined )
    device.proactiveEvents = fhem.connection.proactiveEvents;

  device.alexaName = device.alexaName.toLowerCase().replace( /\+/g, ' ' );
  //device.alexaName = device.alexaName.replace( /\+/g, ' ' );
  device.alexaNames = device.alexaName;
  device.alexaName = device.alexaName.replace(/,.*/g,'');
  device.hasName = function(name) {
    if( this.alexaNames.match( '(^|,)('+name+')(,|\$)' ) ) return true;
    return  this.alexaName === name;
  }.bind(device);

  this.devices[device.device.toLowerCase()] = device;

  for( let characteristic_type in device.mappings )
    device.subscribe( device.mappings[characteristic_type] );

  if( device.alexaRoom ) {
    device.alexaRoom = device.alexaRoom.toLowerCase().replace( /\+/g, ' ' );

    this.namesOfRoom = {};
    this.roomsOfName = {};

    for( let d in this.devices ) {
      var device = this.devices[d];
      if( !device ) continue;
      var room = device.alexaRoom?device.alexaRoom:undefined;
      var name = device.alexaName;

      if( room ) {
        for( let r of room.split(',') ) {
          if( !this.namesOfRoom[r] ) this.namesOfRoom[r] = [];
          this.namesOfRoom[r].push( name );
        }
      }

      if( !this.roomsOfName[name] ) this.roomsOfName[name] = [];
      this.roomsOfName[name].push( room );
    }
  }
}

Server.prototype.setreading = function(reading, value) {
  log.info ("Reading " + reading + " set to " + value);
  if ( this.connections )
    for( let fhem of this.connections ) {
      if (!fhem.alexa_device) continue;
      fhem.execute('setreading ' + fhem.alexa_device.Name + ' ' + reading + ' ' + value);
    }
}

Server.prototype.run = function() {
  log.info( 'this is alexa-fhem '+ version +(Server.as_proxy?'; as proxy':'') +(Server.use_proxy?'; use proxy':'') );

  if( !this._config.connections ) {
    log.error( 'no connections in config file' );
    process.exit( -1 );
  }

  if( Server.use_proxy )
    this.connectToProxy();

  if( this._config.alexa ) {
    if( !Server.use_proxy || Server.as_proxy )
      this.startServer();

    this.roomOfIntent = {};
    if( this._config.alexa.applicationId )
      for( let i = 0; i < this._config.alexa.applicationId.length; ++i ) {
        var parts = this._config.alexa.applicationId[i].split( ':', 2 );
        if( parts.length == 2 ) {
          this.roomOfIntent[parts[0]] = parts[1].toLowerCase();
          this._config.alexa.applicationId[i] = parts[0];
        }
      }
    if( this._config.alexa.oauthClientID )
      for( let i = 0; i < this._config.alexa.oauthClientID.length; ++i ) {
        var parts = this._config.alexa.oauthClientID[i].split( ':', 2 );
        if( parts.length == 2 ) {
          this.roomOfIntent[parts[0]] = parts[1].toLowerCase();
          this._config.alexa.oauthClientID[i] = parts[0];
        }
      }
  }


  if( !Server.as_proxy )
    log.info('connecting to FHEM ...');

  this.devices = {};
  this.roomOfEcho = {};
  this.personOfId = {};
  this.connections = [];
  this.namesOfRoom = {};
  this.roomsOfName = {};

  if( !Server.as_proxy ) {
    let isFirstConnection = true;
    for (let connection of this._config.connections) {
      var fhem = new FHEM(Logger.withPrefix(connection.name), connection);

      //fhem.on( 'DEFINED', function() {log.error( 'DEFINED' )}.bind(this) );

      fhem.on('customSlotTypes', function (fhem, cl) {
        var ret = '';
        ret += 'Custom Slot Types:';
        ret += '\n  FHEM_Device';

        var seen = {};
        for (let d in this.devices) {
          let device = this.devices[d];
          for (let name of device.alexaNames.split(',')) {
            if (seen[name])
              continue;
            seen[name] = 1;
            ret += '\n';
            ret += '    ' + name;
          }
        }
        for (let c of this.connections) {
          if (!c.alexaTypes) continue;
          for (let type in c.alexaTypes) {
            for (let name of c.alexaTypes[type]) {
              if (!seen[name])
                ret += '\n    ' + name;
              seen[name] = 1;
            }
          }
        }

        if (!seen['lampe'])
          ret += '\n    lampe';
        if (!seen['licht'])
          ret += '\n    licht';
        if (!seen['lampen'])
          ret += '\n    lampen';
        if (!seen['rolläden'])
          ret += '\n    rolläden';
        if (!seen['jalousien'])
          ret += '\n    jalousien';
        if (!seen['rollos'])
          ret += '\n    rollos';

        ret += '\n  FHEM_Room';
        for (let room in this.namesOfRoom) {
          ret += '\n';
          ret += '    ' + room;
        }

        log.error(ret);
        if (cl) {
          fhem.execute('{asyncOutput($defs{"' + cl + '"}, "' + ret + '")}');
        }
      }.bind(this, fhem));

      fhem.on('RELOAD', function (fhem, n) {
        if (n)
          log.info('reloading ' + n + ' from ' + fhem.connection.base_url);
        else
          log.info('reloading ' + fhem.connection.base_url);

        for (let d in this.devices) {
          var device = this.devices[d];
          if (!device) continue;
          if (n && device.name !== n) continue;
          if (device.fhem.connection.base_url !== fhem.connection.base_url) continue;

          log.info('removing ' + device.name + ' from ' + device.fhem.connection.base_url);

          fhem = device.fhem;

          device.unsubscribe();

          delete this.devices[device.name];
        }

        if (n) {
          fhem.connect(function (fhem, devices) {
            for (let device of devices) {
              this.addDevice(device, fhem);

              this.postReportOrUpdate(device);

            }
          }.bind(this, fhem), 'NAME=' + n);
        } else {
          for (let fhem of this.connections) {
            fhem.connect(function (fhem, devices) {
              for (let device of devices) {
                this.addDevice(device, fhem);

                this.postReportOrUpdate(device);
              }
            }.bind(this, fhem));
          }
        }

      }.bind(this, fhem));

      fhem.on('ALEXA DEVICE', function (fhem, n) {
        if (this._config.sshproxy) {
          getProxyToken(fhem);
          if (fhem === this.connections[0]) {
            if( this._config.sshproxy.ssh === '-' )
              this.startProxy2(fhem, n);
            else
              this.startProxy(fhem, n);
          }
        }

        if (fhem.alexa_device) {
          function lcfirst(str) {
            str += '';
            return str.charAt(0).toLowerCase() + str.substr(1);
          }

          function append(a, b, v) {
            if (a[b] === undefined)
              a[b] = {};
            a[b][v] = true;
          }

          fhem.perfectOfVerb = {'stelle': 'gestellt', 'schalte': 'geschaltet', 'färbe': 'gefärbt', 'mach': 'gemacht'};
          fhem.verbsOfIntent = [];
          fhem.intentsOfVerb = {}
          fhem.valuesOfIntent = {}
          fhem.intentsOfCharacteristic = {}
          fhem.characteristicsOfIntent = {}
          fhem.prefixOfIntent = {}
          fhem.suffixOfIntent = {}
          for( let characteristic in fhem.alexaMapping ) {
            var mappings = fhem.alexaMapping[characteristic];
            if (!Array.isArray(mappings))
              mappings = [mappings];

            var i = 0;
            for (let mapping of mappings) {
	      if( mapping.action2value ) {
		mappings.action2value = mapping.action2value;
	        continue;
	      }
              if( !mapping.verb ) continue;

              var intent = characteristic;
              if (mapping.valueSuffix) intent = lcfirst(mapping.valueSuffix);
              intent += 'Intent';
              if (!mapping.valueSuffix)
                intent += i ? String.fromCharCode(65 + i) : '';

              if (mapping.articles) mapping.articles = mapping.articles.split(';');

              if (mapping.perfect)
                fhem.perfectOfVerb[mapping.verb] = mapping.perfect;
              //append(fhem.verbsOfIntent, intent, mapping.verb );
              if (fhem.verbsOfIntent[intent] === undefined) {
                fhem.verbsOfIntent[intent] = [mapping.verb];
              } else if (fhem.verbsOfIntent[intent].indexOf(mapping.verb) == -1) {
                fhem.verbsOfIntent[intent].push(mapping.verb);
              }
              append(fhem.intentsOfVerb, mapping.verb, intent);
              //append(fhem.valuesOfIntent, intent, join( ',', @{$values} ) );
              append(fhem.intentsOfCharacteristic, characteristic, intent);
              //append(fhem.characteristicsOfIntent, intent, characteristic );
              if (fhem.characteristicsOfIntent[intent] === undefined) {
                fhem.characteristicsOfIntent[intent] = [characteristic];
              } else if (fhem.characteristicsOfIntent[intent].indexOf(characteristic) == -1) {
                fhem.characteristicsOfIntent[intent].push(characteristic);
              }
              fhem.prefixOfIntent[intent] = mapping.valuePrefix;
              fhem.suffixOfIntent[intent] = mapping.valueSuffix;
              ++i;
            }
          }
          log.debug('perfectOfVerb:');
          log.debug(fhem.perfectOfVerb);
          log.debug('verbsOfIntent:');
          log.debug(fhem.verbsOfIntent);
//log.debug(fhem.intentsOfVerb);
//log.debug(fhem.valuesOfIntent);
//log.debug(fhem.intentsOfCharacteristic);
          log.debug('characteristicsOfIntent:');
          log.debug(fhem.characteristicsOfIntent);
          log.debug('prefixOfIntent:');
          log.debug(fhem.prefixOfIntent);
          log.debug('suffixOfIntent:');
          log.debug(fhem.suffixOfIntent);
        }

        if (fhem.alexaTypes) {
          var types = {};
          for (let type of fhem.alexaTypes.split(/ |\n/)) {
            if (!type)
              continue;
            if (type.match(/^#/))
              continue;

            var match = type.match(/(^.*?)(:|=)(.*)/);
            if (!match || match.length < 4 || !match[3]) {
              log.error('  wrong syntax: ' + type);
              continue;
            }
            var name = match[1];
            var aliases = match[3].split(/,|;/);

            types[name] = aliases;
          }
          fhem.alexaTypes = types;
          log.debug('alexaTypes:');
          log.debug(fhem.alexaTypes);
        }

        if (fhem.echoRooms) {
          for (let line of fhem.echoRooms.split(/ |\n/)) {
            if (!line)
              continue;
            if (line.match(/^#/))
              continue;

            var match = line.match(/(^.*?)(:|=)(.*)/);
            if (!match || match.length < 4 || !match[3]) {
              log.error('  wrong syntax: ' + line);
              continue;
            }
            var echoId = match[1];
            var room = match[3];

            this.roomOfEcho[echoId] = room.toLowerCase();
          }
          log.debug('roomOfEcho:');
          log.debug(this.roomOfEcho);
        }

        if (fhem.persons) {
          for (let line of fhem.persons.split(/ |\n/)) {
            if (!line)
              continue;
            if (line.match(/^#/))
              continue;

            var match = line.match(/(^.*?)(:|=)(.*)/);
            if (!match || match.length < 4 || !match[3]) {
              log.error('  wrong syntax: ' + line);
              continue;
            }
            var echoId = match[1];
            var person = match[3];

            this.personOfId[echoId] = person.toLowerCase();
          }
          log.debug('personOfId:');
          log.debug(this.personOfId);
        }

        if (fhem.fhemIntents) {
          var intents = {}
          for (let intent of fhem.fhemIntents.split(/\n/)) {
            if (!intent)
              continue;
            if (intent.match(/^#/))
              continue;

            var match = intent.match(/(^.*?)(:|=)(.*)/);
            if (!match || match.length < 4 || !match[3]) {
              this.log.error('  wrong syntax: ' + intent);
              continue;
            }

            var name = match[1];
            var params = match[3];

            var intent_name = 'FHEM' + name + 'Intent';
            if (match = name.match(/^(set|get|attr)\s/)) {
              intent_name = 'FHEM' + match[1] + 'Intent';
              var i = 1;
              while (intents[intent_name] !== undefined) {
                intent_name = 'FHEM' + match[1] + 'Intent' + String.fromCharCode(65 + i);
                ++i;
              }
            } else if (name.match(/^{.*}$/)) {
              intent_name = 'FHEMperlCodeIntent';
              var i = 1;
              while (intents[intent_name] !== undefined) {
                if (i < 26)
                  intent_name = 'FHEMperlCodeIntent' + String.fromCharCode(65 + i);
                else
                  intent_name = 'FHEMperlCodeIntent' + String.fromCharCode(64 + i / 26) + String.fromCharCode(65 + i % 26);
                ++i;
              }
            }
            intent_name = intent_name.replace(/ /g, '');

            intents[intent_name] = name;

          }
          fhem.fhemIntents = intents;
          log.debug('fhemIntents:');
          log.debug(fhem.fhemIntents);
        }

        if (fhem.alexaConfirmationLevel === undefined)
          fhem.alexaConfirmationLevel = 2;

        if (fhem.alexaStatusLevel === undefined)
          fhem.alexaStatusLevel = 2;

	if( fhem.alexa_device !== undefined )
        fhem.execute('list ' + fhem.alexa_device.Name + ' .eventToken', function (fhem, result) {
          var match;
          if (match = result.match(/\{.*\}$/)) {
            try {
              fhem.eventToken = JSON.parse(match[0]);
              fhem.log.info("got .eventToken");

              event_token = fhem.eventToken;
              this.updateEventToken(fhem);

            } catch (e) {
              fhem.log.error("failed to parse .eventToken: " + util.inspect(e));
            }
          }
        }.bind(this, fhem));
      }.bind(this, fhem));

      fhem.on('VALUE CHANGED', function (fhem, device, reading, value) {
	if( fhem.alexa_device && fhem.alexa_device.proactiveEvents === false ) {
          fhem.log.debug( 'proactive events are disable for this fhem connection' );
          return;
	}
        //fhem.log.error( device +":"+ reading +":"+ value );
        device = this.devices[device.toLowerCase()];
        if( !device )
          return;

        if( !device.proactiveEvents ) {
          fhem.log.debug( 'not sending proactive event for: '+ device.name +":"+ reading +":"+ value );
          return;
	}

        var header = createHeader(NAMESPACE_ALEXA, REPORT_STATE)
        header.payloadVersion = "3";
        //createDirective( header, payload, event )
	var properties = propertiesFromDevice(device, device.name +'-' + reading);
	if( !properties.length ) {
          fhem.log.debug( 'not sending empty proactive event for: '+ device.name +":"+ reading +":"+ value );
	  return;
        }

        this.postEvent({
          "event": {
            "header": header,
            "payload": {
              "change": {
                "cause": {"type": "PHYSICAL_INTERACTION"},
                "properties": properties
              },
            },
            "endpoint": {
              "scope": {
                "type": "BearerToken",
                "token": "access-token-from-Amazon"
              },
              "endpointId": device.uuid_base.replace(/[^\w_\-=#;:?@&]/g, '_'),
            }
          }
        });
      }.bind(this, fhem));

      fhem.on('ATTR', function (fhem, device, attribute, value) {
        //fhem.log.error( device +":"+ attribute +":"+ value );

        device = this.devices[device.toLowerCase()];
        if (!device)
          return;

	if( attribute === 'alexaProactiveEvents' ) {
          if( value === undefined )
	    delete device.proactiveEvents;
          else
	    device.proactiveEvents = parseInt(value) == true;

          this.addDevice(device, fhem);
          this.postReportOrUpdate(device);

	} else if( attribute === 'alexaName' ) {
          if( value === undefined )
            device.alexaName = device.alias;
          else
            device.alexaName = value;

          this.addDevice(device, fhem);
          this.postReportOrUpdate(device);
	}

      }.bind(this, fhem));

      fhem.on('CONNECTED', function (f) {
        for (let fhem of this.connections) {
          if (f.connection.base_url !== fhem.connection.base_url) continue;

          fhem.connect(function (fhem, devices) {
            for (let device of devices) {
              this.addDevice(device, fhem);
            }
          }.bind(this, fhem))
        }
      }.bind(this, fhem));

      fhem.on('UNREGISTER SSHPROXY', function () {
        this.unregister_ssh();
      }.bind(this));

      this.connections.push(fhem);
      isFirstConnection = false;
    } // connections loop
  }
}

Server.prototype.shutdown = function() {
  if( this._config.sshproxy )
    this.set_ssh_state( 'stopping', 'alexa-fhem terminating' );

  if( ssh_client ) {
    log.info('Stopping SSH ...');
    ssh_client.kill();

    setTimeout(() => { process.exit() }, 2000);
  } else
    process.exit();
}




// namespaces
// https://developer.amazon.com/public/solutions/alexa/alexa-skills-kit/docs/smart-home-skill-api-reference#payload
const NAMESPACE_SmartHome_DISCOVERY = "Alexa.ConnectedHome.Discovery";
const NAMESPACE_SmartHome_SYSTEM = "Alexa.ConnectedHome.System";
const NAMESPACE_SmartHome_CONTROL = "Alexa.ConnectedHome.Control";
const NAMESPACE_SmartHome_QUERY = "Alexa.ConnectedHome.Query";
const NAMESPACE_DISCOVERY = "Alexa.Discovery";

const NAMESPACE_PowerController = "Alexa.PowerController";
const NAMESPACE_BrightnessController = "Alexa.BrightnessController";
const NAMESPACE_ColorController = "Alexa.ColorController";
const NAMESPACE_ColorTemperatureController = "Alexa.ColorTemperatureController";
const NAMESPACE_PercentageController = "Alexa.PercentageController";
const NAMESPACE_Speaker = "Alexa.Speaker";
const NAMESPACE_ThermostatController = "Alexa.ThermostatController";
const NAMESPACE_LockController = "Alexa.LockController";
const NAMESPACE_SceneController = "Alexa.SceneController";
const NAMESPACE_ChannelController = "Alexa.ChannelController";
const NAMESPACE_InputController = "Alexa.InputController";
const NAMESPACE_PlaybackController = "Alexa.PlaybackController";
const NAMESPACE_RangeController = "Alexa.RangeController";
const NAMESPACE_ModeController = "Alexa.ModeController";

const NAMESPACE_TemperatureSensor = "Alexa.TemperatureSensor";
const NAMESPACE_ContactSensor = "Alexa.ContactSensor";
const NAMESPACE_MotionSensor = "Alexa.MotionSensor";

const NAMESPACE_SecurityPanelController = "Alexa.SecurityPanelController";

const NAMESPACE_Authorization = "Alexa.Authorization";

const NAMESPACE_ALEXA = "Alexa";

// discovery
const REQUEST_DISCOVER_APPLIANCES = "DiscoverAppliancesRequest";
const RESPONSE_DISCOVER_APPLIANCES = "DiscoverAppliancesResponse";

const REQUEST_DISCOVER = "Discover";
const RESPONSE_DISCOVER = "Discover.Response";
const REPORT_ADD_OR_UPDATE = "AddOrUpdateReport";
const REPORT_DELETE = "DeleteReport";


// system
const REQUEST_HEALTH_CHECK = "HealthCheckRequest";
const RESPONSE_HEALTH_CHECK = "HealthCheckResponse";

// control
const REQUEST_TURN_ON = "TurnOnRequest";
const RESPONSE_TURN_ON = "TurnOnConfirmation";

const REQUEST_TURN_OFF = "TurnOffRequest";
const RESPONSE_TURN_OFF = "TurnOffConfirmation";

const REQUEST_SET_PERCENTAGE = "SetPercentageRequest";
const RESPONSE_SET_PERCENTAGE = "SetPercentageConfirmation";

const REQUEST_INCREMENT_PERCENTAGE = "IncrementPercentageRequest";
const RESPONSE_INCREMENT_PERCENTAGE = "IncrementPercentageConfirmation";

const REQUEST_DECREMENT_PERCENTAGE = "DecrementPercentageRequest";
const RESPONSE_DECREMENT_PERCENTAGE = "DecrementPercentageConfirmation";


const REQUEST_SET_TARGET_TEMPERATURE = "SetTargetTemperatureRequest";
const RESPONSE_SET_TARGET_TEMPERATURE = "SetTargetTemperatureConfirmation";

const REQUEST_INCREMENT_TARGET_TEMPERATURE = "IncrementTargetTemperatureRequest";
const RESPONSE_INCREMENT_TARGET_TEMPERATURE = "IncrementTargetTemperatureConfirmation";

const REQUEST_DECREMENT_TARGET_TEMPERATURE = "DecrementTargetTemperatureRequest";
const RESPONSE_DECREMENT_TARGET_TEMPERATURE = "DecrementTargetTemperatureConfirmation";

const REQUEST_SET_LOCK_STATE = "SetLockStateRequest";
const CONFIRMATION_SET_LOCK_STATE = "SetLockStateConfirmation";


//https://developer.amazon.com/public/solutions/alexa/alexa-skills-kit/docs/smart-home-skill-api-reference#tunable-lighting-control-messages
const REQUEST_SET_COLOR = "SetColorRequest";
const RESPONSE_SET_COLOR = "SetColorConfirmation";

const REQUEST_SET_COLOR_TEMPERATURE = "SetColorTemperatureRequest";
const RESPONSE_SET_COLOR_TEMPERATURE = "SetColorTemperatureConfirmation";

const REQUEST_INCREMENT_COLOR_TEMPERATURE = "IncrementColorTemperatureRequest";
const RESPONSE_INCREMENT_COLOR_TEMPERATURE = "IncrementColorTemperatureConfirmation";

const REQUEST_DECREMENT_COLOR_TEMPERATURE = "DecrementColorTemperatureRequest";
const RESPONSE_DECREMENT_COLOR_TEMPERATURE = "DecrementColorTemperatureConfirmation";


// query
const REQUEST_GET_TEMPERATURE_READING = "GetTemperatureReadingRequest";
const RESPONSE_GET_TEMPERATURE_READING = "GetTemperatureReadingResponse";

const REQUEST_GET_TARGET_TEMPERATURE = "GetTargetTemperatureRequest";
const RESPONSE_GET_TARGET_TEMPERATURE = "GetTargetTemperatureResponse";

const REQUEST_GET_LOCK_STATE = "GetLockStateRequest";
const RESPONSE_GET_LOCK_STATE = "GetLockStateResponse";

//state
const REQUEST_STATE = "ReportState";
const RESPONSE_STATE = "StateReport";
const REPORT_STATE = "ChangeReport";


// errors
const ERROR_VALUE_OUT_OF_RANGE = "ValueOutOfRangeError";;
const ERROR_UNSUPPORTED_OPERATION = "UnsupportedOperationError";
const ERROR_UNSUPPORTED_TARGET = "UnsupportedTargetError";
const ERROR_INVALID_ACCESS_TOKEN = "InvalidAccessTokenError";

const ERROR3_INVALID_AUTHORIZATION_CREDENTIAL = "INVALID_AUTHORIZATION_CREDENTIAL";
const ERROR3_BRIDGE_UNREACHABLE = "BRIDGE_UNREACHABLE";
const ERROR3_NO_SUCH_ENDPOINT = "NO_SUCH_ENDPOINT";
const ERROR3_ENDPOINT_UNREACHABLE = "ENDPOINT_UNREACHABLE";
const ERROR3_INVALID_DIRECTIVE = "INVALID_DIRECTIVE";
const ERROR3_TEMPERATURE_VALUE_OUT_OF_RANGE = "TEMPERATURE_VALUE_OUT_OF_RANGE";
const ERROR3_VALUE_OUT_OF_RANGE = "VALUE_OUT_OF_RANGE";



Server.prototype.postReportOrUpdate = function(device) {
  var endpoints = deviceToEndpoints(device);
  if( !Array.isArray(endpoints) )
    return;

  var header = createHeader(NAMESPACE_DISCOVERY,REPORT_ADD_OR_UPDATE)
  header.payloadVersion = "3";
  //createDirective( header, payload, event )
  this.postEvent( { "event": { "header": header,
                               "payload": { "endpoints":  endpoints,
                                            "scope": { "type": "BearerToken",
                                                       "token": "access-token-from-Amazon"
                                                     }
                                          }
                              }
                   } );
}

Server.prototype.postEvent = function(event) {
  if( !event_token || !event_token.access_token ) {
    log.error( 'no event token available' );
    return;
  }
  if( Date.now() >= event_token.expires_in ) {
    this.updateEventToken(undefined, function(event) { this.postEvent(event); }.bind(this, event) );
    return;
  }
  log.info( JSON.stringify(event) );

  if( event && event.event && event.event.endpoint && event.event.endpoint.scope )
    event.event.endpoint.scope.token = event_token.access_token;
  else if( event && event.event && event.event.payload && event.event.payload.endpoints && event.event.payload.endpoints[0] && event.event.payload.endpoints[0].scope )
    event.event.payload.endpoints[0].scope.token = event_token.access_token;

    log.info( 'posting skill event' );
    //var request = require('request');
    //require('request-debug')(request);
    //request.post('https://api.eu.amazonalexa.com/v3/events',
    require('postman-request').post('https://api.eu.amazonalexa.com/v3/events',
                            { headers :{ 'Content-Type': 'application/json',
                                         'Authorization': 'Bearer '+ event_token.access_token },
                                 //body: '{"data":{ "sampleMessage": "Sample Message"}, "expiresAfterSeconds": 60 }' },
                                 body: JSON.stringify(event) },
                            function(err, httpResponse, body) {
                              if( err ) {
                                log.error( 'failed to post event: '+ httpResponse.statusCode + ': ' +err);
                                return;
                              }

                              log.info( 'posted skill event: '+ httpResponse.statusCode + ': ' +body );
                            } );
}

Server.prototype.refreshToken = function(token, callback) {
  var permissions = {};
  var url = 'https://api.amazon.com/auth/O2/token';
  if( !this._config.alexa || !this._config.alexa.permissions ) {
    if( this._config.sshproxy ) {
      url = 'https://va.fhem.de/proxy/oauth';
    } else {
      log.error('no permissions in config.json');
      return;
    }
  } else
    permissions = this._config.alexa.permissions[Object.keys(this._config.alexa.permissions)[0]];

  log.info( 'refreshing token' );
  //var request = require('request');
  //require('request-debug')(request);
  //request.post(url,
  require('postman-request').post(url,
                          { form :{ 'grant_type': 'refresh_token',
                                    'refresh_token': token.refresh_token,
                                    'client_id': permissions.client_id?permissions.client_id:'',
                                    'client_secret': permissions.client_secret?permissions.client_secret:'' } },
                          function(err, httpResponse, body) {
                            if( err ) {
                              log.error( 'failed to refresh token: '+ err);
                              return;
                            }

                            const contentType = httpResponse.headers['content-type'];
                            if( contentType && contentType.match('application/json') ) {
                              var json = JSON.parse(body);
                              if( json.error ) {
                                log.error( 'failed to refresh token: '+ json.error +': \''+ json.error_description +'\'');
                                return;
                              }

                              log.info( 'got fresh token' );
                              json.expires_in = json.expires_in * 1000 + Date.now();
                              for( let key in json )
                                token[key] = json[key];

                              if( callback ) callback(token);

                            } else {
                              log.error( 'failed to refresh token: '+ body);
                              return;
                            }

                          }.bind(this) );
}

var event_token = {'expires': 0};
Server.prototype.updateEventToken = function(grant,callback) {
  if( Date.now() < event_token.expires_in ) {
    if( callback ) callback();

  } else if( event_token.refresh_token ) {
    this.refreshToken(event_token, function(token) { event_token = token; if( callback ) callback(); }.bind(this) );

  } else {
    if( !grant ) {
      log.error('no grant for event token update');
      return;
    }

    var permissions = {};
    var url = 'https://api.amazon.com/auth/O2/token';
    if( !this._config.alexa || !this._config.alexa.permissions ) {
      if( this._config.sshproxy ) {
        url = 'https://va.fhem.de/proxy/oauth';
      } else {
        log.error('no permissions in config.json');
        return;
      }
    } else
      permissions = this._config.alexa.permissions[Object.keys(this._config.alexa.permissions)[0]];

    log.info( 'requesting event token' );
    //log.error( grant );
    //var request = require('request');
    //require('request-debug')(request);
    //request.post(url,
    require('postman-request').post(url,
                            { form :{ 'grant_type': 'authorization_code',
                                      'code': grant.grant.code,
                                      'client_id': permissions.client_id?permissions.client_id:'',
                                      'client_secret': permissions.client_secret?permissions.client_secret:'' } },
                            function(err, httpResponse, body) {
                              if( err ) {
                                log.error( 'failed to get event token: '+ err);
                                return;
                              }

                              const contentType = httpResponse.headers['content-type'];
                              if( contentType && contentType.match('application/json') ) {
                                var json = JSON.parse(body);
                                if( json.error ) {
                                  log.error( 'failed to get event token: '+ json.error +': \''+ json.error_description +'\'');
                                  return;
                                }

                                this.setreading( '.eventToken', body );

                                log.info( 'got event token' );
                                event_token = json;
                                event_token.expires_in = event_token.expires_in * 1000 + Date.now();

                                if( callback ) callback();

                              } else {
                                log.error( 'failed to get event token: '+ body);
                                return;
                              }

                            }.bind(this) );
  }
}

// Token by classic developer skill mode (created by Amazon:)
var accepted_token = {'token': undefined, 'oauthClientID': undefined, 'expires': 0};
// Token in sshproxy mode, created by ourself and stored in FHEM (bearerToken):
const published_tokens = [];

const getProxyToken = function(fhem) {
  if( !fhem.alexa_device ) {
    log.error('No Alexa device defined - this will not work with sshproxy mode');
    return;
  }

  fhem.execute( 'get ' + fhem.alexa_device.Name + ' proxyToken', function(fhem, token) {

    if( !token ) {
      log.warn('No reading "' + BEARERTOKEN_NAME + '" found in "' + fhem.alexa_device.Name +
          '" - incoming Cloud requests cannot be validated.');
      return;
    }
    log.info("BearerToken '" + token.replace(/^.*(.....)$/, "...$1") + "' read from " + fhem.alexa_device.Name);

    published_tokens.push(token);
  }.bind(this, fhem) );
};


var verifyToken = function(sshproxy, event, callback) {
  var token;
  if( event.directive && event.directive.endpoint && event.directive.endpoint.scope && event.directive.endpoint.scope.token )
    token = event.directive.endpoint.scope.token;
  else if( event.directive && event.directive.payload && event.directive.payload.scope && event.directive.payload.scope.token )
    token = event.directive.payload.scope.token;
  else if( event.context && event.context.System && event.context.System.user && event.context.System.user.accessToken )
    token = event.context.System.user.accessToken;
  else if( event.session && event.session.user && event.session.user.accessToken )
    token = event.session.user.accessToken;
  else if( event.payload )
    token = event.payload.accessToken;
  else
    token = undefined;

  // Token w/o routing ID in case of sshproxy mode
  let ptoken = undefined;
  if( sshproxy && token && token.lastIndexOf('-')>=0 )
    ptoken = token.substring(token.lastIndexOf('-')+1);


  if( event.directive && event.directive.header && event.directive.header.namespace === NAMESPACE_Authorization && event.directive.header.name === "AcceptGrant" ) {
    handler.bind(this)( event, callback );

    // Trust the token either:
    // 1) This token is in the array of bearerToken(s) we read from FHEM (instances) - sshproxy mode.
  } else if( sshproxy && ptoken && published_tokens.indexOf(ptoken)>=0 ) {
    handler.bind(this)( event, callback );

    // 2) If we validated it via Amazon OAuth (classic approach)
  } else if( !sshproxy && (token === accepted_token.token && Date.now() < accepted_token.expires) ) {
    handler.bind(this)( event, callback );

  } else if( token ) {
    var url = "https://api.amazon.com/auth/O2/tokeninfo?access_token="+token.replace('|', '%7C');
    require('https').get( url, function(result) {
      const statusCode = result.statusCode;
      const contentType = result.headers['content-type'];

      var error;
      if(statusCode !== 200 && statusCode !== 400) {
        error = new Error('Request Failed.\n'+
                          'Status Code: '+ statusCode);
      } else if(!/^application\/json/.test(contentType)) {
        error = new Error('Invalid content-type.\n'+
                          'Expected application/json but received '+ contentType);
      }
      if(error) {
        log.error(error.message);
        // consume response data to free up memory
        result.resume();
        callback( createError(ERROR_INVALID_ACCESS_TOKEN), ERROR_INVALID_ACCESS_TOKEN );
        return;
      }

      result.setEncoding('utf8');
      var body = '';
      result.on('data', function(chunk){body += chunk});
      result.on('end', function() {
        try {
          var parsedData = JSON.parse(body);
          if( parsedData.error ) {
            log.error( 'client not authorized: '+ body );

            callback( createError(ERROR_INVALID_ACCESS_TOKEN), ERROR_INVALID_ACCESS_TOKEN );

          } else if( !this._config.alexa.oauthClientID || this._config.alexa.oauthClientID.indexOf(parsedData.aud) >= 0 ) {
            log.info('accepted new token');
            //log.info('accepted new token for: '+ parsedData.aud);
            log.debug(parsedData);
            accepted_token.token = token;
            accepted_token.oauthClientID = parsedData.aud;
            accepted_token.expires = Date.now() + parsedData.exp;

            if( Server.as_proxy ) {
              if( sockets[accepted_token.oauthClientID] ) {
                sockets[accepted_token.oauthClientID].emit('event', JSON.stringify(event), function(ret) {
                  //log.error(ret);
                  callback(ret);
                });
              } else
                log.error('proxy: no registration for id');

            } else
              handler.bind(this)( event, callback );

          } else {
            log.error('clientID '+ parsedData.aud  +' not authorized');
            log.debug(parsedData);
            callback( createError(ERROR_INVALID_ACCESS_TOKEN), ERROR_INVALID_ACCESS_TOKEN );
          }
        } catch (e) {
          log.error(e);
          callback( createError(ERROR_INVALID_ACCESS_TOKEN), ERROR_INVALID_ACCESS_TOKEN );
        }
      }.bind(this));
    }.bind(this)).on('error', function(e){
      console.log('Got error: '+ e.message);
      callback( createError(ERROR_INVALID_ACCESS_TOKEN), ERROR_INVALID_ACCESS_TOKEN );
    });

  } else if( event.session ) {
    //console.log(event);
    if( event.session.application && event.session.application.applicationId
        && this._config.alexa.applicationId.indexOf(event.session.application.applicationId) >= 0  ) {
      handler.bind(this)( event, callback );

    } else if( event.session.application && event.session.application.applicationId ) {
      log.error( 'applicationId '+ event.session.application.applicationId +' not authorized' );
      callback( createError(ERROR_INVALID_ACCESS_TOKEN), ERROR_INVALID_ACCESS_TOKEN );

    } else {
      log.error( 'event not authorized' );
      callback( createError(ERROR_INVALID_ACCESS_TOKEN), ERROR_INVALID_ACCESS_TOKEN );
    }

  } else {
    log.error( event );
    log.error( 'event not supported' );
    callback( createError(ERROR_UNSUPPORTED_OPERATION), ERROR_UNSUPPORTED_OPERATION );
  }

}

var sessions = {};
var handleCustom = function(event, callback) {
    var session = event.session.sessionId;
    var in_session = false;
    if( sessions[session] )
      in_session = sessions[session].in_session;
    else
      sessions[session] = {};

    var consentToken;
    if( event.context && event.context.System && event.context.System.user && event.context.System.user.permissions && event.context.System.user.permissions.consentToken )
      consentToken = event.context.System.user.permissions.consentToken;
    else if( event.session && event.session.user && event.session.user.permissions && event.session.user.permissions.consentToken )
      consentToken = event.session.user.permissions.consentToken;
    else
      consentToken = undefined;
    //this.setreading( '.consentToken', consentToken );

    var personId = 'unknown';
    if( event.context && event.context.System && event.context.System.person && event.context.System.person.personId )
      personId = event.context.System.person.personId;

    var echoId = 'unknown';
    if( event.context && event.context.System && event.context.System.device && event.context.System.device.deviceId )
      echoId = event.context.System.device.deviceId;

    var echoRoom = 'unknown';
    if( this.roomOfEcho[echoId] )
      echoRoom = this.roomOfEcho[echoId];

    var person = personId;
    if( this.personOfId[personId] )
      person = this.personOfId[personId];

    var skillRoom = 'unknown';
    if( event.session.application !== undefined && this.roomOfIntent[event.session.application.applicationId] )
      skillRoom = this.roomOfIntent[event.session.application.applicationId];

    var response = { version: '1.0',
                     sessionAttributes: {},
                     response: {
                       outputSpeech: {
                         type: 'PlainText',
                         text: 'Hallo.'
                       },
                       shouldEndSession: !in_session
                     }
                   };

    if( event.request.type === 'LaunchRequest' ) {
      in_session = true;
      response.response.outputSpeech.text = 'Hallo. Wie kann ich helfen?';
if( 0 ) {
      response.response.directives = [
      {
        "type": "AudioPlayer.Play",
        "playBehavior": "REPLACE_ALL",
        "audioItem": {
          "stream": {
            "token": "string",
            "url": "string",
            "offsetInMilliseconds": 0
          }
        }
      }
    ];
}
      if( fhem && fhem.alexaConfirmationLevel < 2 )
        response.response.outputSpeech.text = 'Hallo.';

      response.response.reprompt = { outputSpeech: {type: 'PlainText', text: 'Noch jemand da?' } };

      this.setreading( 'intent', event.request.type );
      this.setreading( 'person', person );
      this.setreading( 'echoId', echoId );
      this.setreading( 'echoRoom', echoRoom );

    } else if( event.request.type === 'SessionEndedRequest' ) {
      in_session = false;
      response.response.outputSpeech.text = 'Bye';

      this.setreading( 'intent', event.request.type );
      //this.setreading( 'person', person );
      this.setreading( 'echoId', echoId );
      this.setreading( 'echoRoom', echoRoom );

    } else if( event.request.type === 'IntentRequest' ) {
      var intent_name = event.request.intent.name;
log.info( intent_name );

      var match = false;
      for( let fhem of this.connections ) {
        if( !fhem.fhemIntents ) continue;
        if( fhem.fhemIntents[intent_name] !== undefined ) {
          match = true;

          var name = fhem.fhemIntents[intent_name];

log.info( event.request.intent.confirmationStatus );
          if (event.request.intent.confirmationStatus !== "DENIED") {
            var applicationId = '';
            if( this._config.alexa.applicationId.length > 1 && event.session.application && event.session.application.applicationId ) {
              applicationId = event.session.application.applicationId;
              //applicationId = this._config.alexa.applicationId.indexOf(event.session.application.applicationId);
              //if( applicationId < 0 ) applicationId = '';
            }

            if( name.match(/^(set|get|attr)\s/) ) {
              if( applicationId !== '' ) applicationId = ' :' +applicationId;
              //fhem.execute( 'setreading '+ fhem.alexa_device.Name +' fhemIntent '+ intent_name + applicationId );
              fhem.execute( 'setreading '+ fhem.alexa_device.Name +' fhemIntent '+ intent_name + applicationId + ';setreading '+ fhem.alexa_device.Name +' person '+ person + ';setreading '+ fhem.alexa_device.Name +' echoId '+ echoId + ';setreading '+ fhem.alexa_device.Name +' echoRoom '+ echoRoom +';'+ name, function(result) {
                response.response.outputSpeech.text = result;
                callback( response );
              } );
              return;

            } else if( name.match(/^{.*}$/) ) {
              if( applicationId !== '' ) applicationId = ' :' +applicationId;
              //fhem.execute( 'setreading '+ fhem.alexa_device.Name +' fhemIntent '+ intent_name + applicationId );

              var specials ='';
              if( echoRoom !== 'unknown' )
                specials += '"%Room" => "'+ echoRoom +'",';
              if( skillRoom !== 'unknown' )
                specials += '"%Room" => "'+ skillRoom +'",';

              if( event.request.intent.slots ) {
                for( let slot in event.request.intent.slots ) {
                  slot = event.request.intent.slots[slot];
                  var n = slot.name.replace( intent_name+'_', '' );
                  var v = slot.value;
  //console.log(n +': '+ v);
                  if( v !== undefined )
                    specials += '"%'+ n +'" => "'+ v +'",';
                  else
                    specials += '"%'+ n +'" => "",';
                }

                specials += '"%_person" => "'+ person +'",';
                specials += '"%_echoId" => "'+ echoId +'",';
                if( event.session.application !== undefined && event.session.application.applicationId !== undefined )
                  specials += '"%_applicationId" => "'+ event.session.application.applicationId +'",';
                if( echoRoom !== 'unknown' )
                  specials += '"%_echoRoom" => "'+ echoRoom +'",';
                if( skillRoom !== 'unknown' )
                  specials += '"%_skillRoom" => "'+ skillRoom +'",';
              }
  console.log(specials);

              name = '{my %specials=('+specials+');; my $exec = EvalSpecials(\''+name+'\', %specials);; return AnalyzePerlCommand($defs{"'+fhem.alexa_device.Name+'"}, $exec)}';
  //console.log(name);

              fhem.execute( 'setreading '+ fhem.alexa_device.Name +' fhemIntent '+ intent_name + applicationId + ';setreading '+ fhem.alexa_device.Name +' person '+ person +';setreading '+ fhem.alexa_device.Name +' echoId '+ echoId + ';setreading '+ fhem.alexa_device.Name +' echoRoom '+ echoRoom +';'+ name, function(result) {
                if( match = result.match( /^&(.*)/ ) ) {
                  result = match[1];
                  response.response.shouldEndSession = false;
                }
                response.response.outputSpeech.text = result;

                if( match = result.match( /^<speak>(.*)<\/speak>$/ ) ) {
                  delete response.response.outputSpeech.text;
                  response.response.outputSpeech.type = "SSML";
                  response.response.outputSpeech.ssml = result;
                }

                callback( response );
              } );
              return;

            } else {
              if( applicationId !== '' ) applicationId = ' :' +applicationId;
              fhem.execute( 'setreading '+ fhem.alexa_device.Name +' person '+ person + ';setreading '+ fhem.alexa_device.Name +' echoId '+ echoId + ';setreading '+ fhem.alexa_device.Name +' echoRoom '+ echoRoom + ';' + 'setreading '+ fhem.alexa_device.Name +' fhemIntent '+ name + applicationId );
            }
          }
        }
      }
      if( match ) {
        response.response.outputSpeech.text = 'OK.';
        callback( response );
        return;
      }

      var command;
      if( sessions[session] && intent_name == 'RoomAnswerIntent' ) {
        command = sessions[session].command;
        intent_name = command.intent_name;
        delete sessions[session].command;

      } else {
        delete sessions[session].command;
        command = { verb: undefined, article: '', device: undefined, preposition: undefined, room: undefined,
                    prefix: undefined, value: undefined, suffix: undefined,
                    characteristic: undefined, index: undefined };

      }

      this.setreading( 'intent', event.request.type +' '+ intent_name );
      this.setreading( 'person', person );
      this.setreading( 'echoId', echoId );
      this.setreading( 'echoRoom', echoRoom );

      var match;
      if( match = intent_name.match( /(.+)Intent([A-Z])?$/ ) ) {
        command.characteristic = match[1];
        command.index = match[2]?match[2].charCodeAt(0)-65:0;
log.debug('index: '+ command.index);
      }
log.debug( 'characteristic: ' + command.characteristic );
      if( command.characteristic ) {
        var c = intent_name.replace( /Intent.?$/, '' );
        function Value(c, slots) {
          if( typeof slots  !== 'object' ) return undefined;
          for( let slot in slots ) {
            if( slot.match('^'+c+'.?_') )
              return slots[slot].value;
          }
          return undefined;
        };
        var value = Value(c, event.request.intent.slots);
        if( value !== undefined )
          command.value = value;
      }
log.debug( 'value: ' + command.value );

      if( event.request.intent.slots && event.request.intent.slots.article && event.request.intent.slots.article.value )
        command.article = event.request.intent.slots.article.value.toLowerCase();

      if( event.request.intent.slots && event.request.intent.slots.Device && event.request.intent.slots.Device.value )
        command.device = event.request.intent.slots.Device.value.toLowerCase();

      if( event.request.intent.slots && event.request.intent.slots.preposition && event.request.intent.slots.preposition.value )
        command.preposition = event.request.intent.slots.preposition.value.toLowerCase();

      if( event.request.intent.slots && event.request.intent.slots.Room && event.request.intent.slots.Room.value )
        command.room = event.request.intent.slots.Room.value.toLowerCase();

      if( !command.room && skillRoom !== 'unknown' )
        command.room = skillRoom;
      else if( !command.room && echoRoom !== 'unknown' )
        command.room = echoRoom;

      function findDevice(device, room) {
        var found;
        for( var d in this.devices ) {
          var d = this.devices[d];
          if( !d ) continue;
          if( room && !d.isInRoom(room) ) continue;
          if( !d.isInScope('alexa') && !d.isInScope('alexa-custom') ) continue;
          if( d.hasName(device) ) {
            if( found ) {
              log.error(device +' -> '+ found.name +':'+ found.alexaName +'('+found.alexaRoom+'),'
                                      + d.name +':'+ d.alexaName +'('+d.alexaRoom+')' );
              if( room )
                response.response.outputSpeech.text = 'Ich habe mehr als ein Gerät mit Namen '+ device +' im Raum '+ room +' gefunden.';
              else
                response.response.outputSpeech.text = 'Ich habe mehr als ein Gerät mit Namen '+ device +' gefunden. In welchem Raum meinst du?';

              command.intent_name = intent_name;
              sessions[session].command = command;

              response.response.shouldEndSession = false;

              callback( response );
              return -1;
            }

            found = d;
          }
        }

        return found;
      }

      var device;
      if( command.device ) {
        if( !command.room ) // FIXME: still needed ?
          device = this.devices[command.device];

        if( !device && command.room )
          device = findDevice.bind(this)( command.device, command.room );

        if( !device ) {  // fallback to device only search, required for using unique device names from an echo with a room default
          device = findDevice.bind(this)( command.device );
          if( device )
            command.room = device.alexaRoom;
        }

        if( !device ) // fallback to check fhem device name
          device = this.devices[command.device];
      }

      if( device === -1 ) // found multiple devices
        return;

      var type;
      if( !device && command.device ) {
        if( !device ) {
          for( let c of this.connections ) {
            if( !c.alexaTypes ) continue;
            for( let t in c.alexaTypes ) {
              for( let name of c.alexaTypes[t] ) {
                if( name === command.device ) {
                  type = t;
                  break;
                }
              }
              if( type ) break;
            }
            if( type ) break;
          }
        }

        if( !device ) {
          if( command.device === 'licht' || command.device === 'lampe' || command.device === 'lampen' ) {
            type = 'light';
          } else if( command.device === 'rolladen' || command.device === 'jalousie' || command.device === 'rollo'
                     || command.device === 'rolläden' || command.device === 'jalousien' || command.device === 'rollos' ) {
            type = 'blind';
          }
        }
        if( type ) {
          command.type_name = command.device
          command.device = undefined;
          command.article = '';
        }
        if( !device && !type ) {
          if( command.room )
            response.response.outputSpeech.text = 'Ich habe kein Gerät mit Namen '+ command.device +' im Raum '+ command.room +' gefunden.';
          else
            response.response.outputSpeech.text = 'Ich habe kein Gerät mit Namen '+ command.device +' gefunden.';

          callback( response );
          return;
        }
      }

log.debug('type: '+ type );
log.debug('room: '+ command.room );
log.debug('name: '+ command.device );
log.debug('device: '+ device );

      let mappings = device ? device.mappings : undefined;
      let cached = device ? device.fhem.cached : undefined;

      if( event.request.intent.name === 'AMAZON.StopIntent' ) {
        in_session = false;
        response.response.outputSpeech.text = 'Bis bald.';

        this.setreading( 'intent', event.request.intent.name );
        //this.setreading( 'person', person );
        this.setreading( 'echoId', echoId );
        this.setreading( 'echoRoom', echoRoom );

      } else if( event.request.intent.name === 'AMAZON.CancelIntent' ) {
        delete sessions[session].command;
        response.response.outputSpeech.text = 'OK.';

        this.setreading( 'intent', event.request.intent.name );
        //this.setreading( 'person', person );
        this.setreading( 'echoId', echoId );
        this.setreading( 'echoRoom', echoRoom );

      } else if( event.request.intent.name === 'AMAZON.HelpIntent' ) {
        response.response.outputSpeech.text = 'HILFE';

      } else if( intent_name === 'StatusIntent' ) {
        response.response.outputSpeech.text = '';
        function status(device, room) {
          var state = '';

          //for( let characteristic_type in mappings ) {
          //  if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
          //  state += 'hat den status '+ cached(mappings[characteristic_type].informId);
          //}

          var mapping;
          if( mapping = mappings.On ) {
            var current = device.fhem.reading2homekit(mapping, cached(mapping.informId));
            if( current.toLowerCase() === 'off' )
              current = false;
            else if( !isNaN(current) )
              current = parseInt(current);
            state = 'ist '+ (current?'an':'aus');
          }
          if( mapping = mappings.CurrentTemperature ) {
            if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
            state += ' misst '+ cached(mapping.informId).replace('.',',') +' Grad';
          }
          if( mapping = mappings.TargetTemperature ) {
            if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
            state += 'steht auf '+ cached(mapping.informId).replace('.',',') +' Grad';
          }
          if( mapping = mappings.TargetPosition ) {
            if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
            state += 'steht auf '+ cached(mapping.informId) +' Prozent';
          } else if( mapping = mappings.CurrentPosition ) {
            if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
            state += 'steht auf '+ cached(mapping.informId) +' Prozent';
          }
          if( mapping = mappings.CurrentAmbientLightLevel ) {
            if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
            state += 'misst '+ cached(mapping.informId) +' Lux';
          }
          if( mapping = mappings.AirQuality ) {
            if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
            state += cached(mapping.informId) +' misst xxx luftqualität';
          }
          if( mapping = mappings.CarbonDioxideLevel ) {
            if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
            state += 'misst '+ cached(mapping.informId) +' ppm co2';
          }
          if( mapping = mappings.BatteryLevel ) {
            if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
            state += 'der Batteriestand ist '+ cached(mapping.informId).replace('.',',');
          } else if( mapping = mappings.StatusLowBattery ) {
            var current = device.fhem.reading2homekit(mapping, cached(mapping.informId));
            if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
            state += 'der Batteriestand ist '+ ((current==='BATTERY_LEVEL_NORMAL')?'in ordnung':'niedrig');

          }
	  if( mapping = mappings.CurrentDoorState ) {
            var current = device.fhem.reading2homekit(mapping, cached(mapping.informId));
	    if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
	    state += 'ist '+ ((current==='OPEN')?'geöffnet':'geschlossen');
          } else if( mapping = mappings.ContactSensorState ) {
            var current = device.fhem.reading2homekit(mapping, cached(mapping.informId));
	    if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
	    state += 'ist '+ ((current==='CONTACT_NOT_DETECTED')?'geöffnet':'geschlossen');
          }
          if( mapping = mappings[FHEM.CustomUUIDs.Volume] ) {
            if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
            state += 'steht auf '+ cached(mapping.informId) +' Prozent';
          }

          if( !state ) {
            for( let characteristic_type in mappings ) {
              if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
              state += 'hat den status '+ cached(mappings[characteristic_type].informId);
            }
          }

          if( !state )
            return 'Ich kann das Gerät mit Namen '+ device.alexaName +' nicht abfragei.';

          var name = device.alexaName;
          if( room )
            return name +' im Raum '+ room +' '+ state;

          if( !room && device.alexaRoom && this.roomsOfName &&  this.roomsOfName[name] && this.roomsOfName[name].length > 1 )
            return name +' im Raum '+ device.alexaRoom +' '+ state;

          return name +' '+ state;
        }
        if( device ) {
          response.response.outputSpeech.text = status.bind(this)(device, command.room);

        } else if( command.room || type ) {
          for( let d in this.devices ) {
            var device = this.devices[d];
            if( !device ) continue;
            if( type && !device.isOfType(type) ) continue;
            if( command.room && !device.isInRoom(command.room) ) continue;
            if( !device.isInScope('alexa') && !device.isInScope('alexa-custom') ) continue;


            if( response.response.outputSpeech.text ) response.response.outputSpeech.text += ', ';
            response.response.outputSpeech.text += status.bind(this)(device, command.room);
          }
          if( command.room && response.response.outputSpeech.text === '' )
            response.response.outputSpeech.text = 'Ich habe keinen Raum '+ command.room +' mit Geräten '+ (type?'vom Typ '+command.type_name:'') +' gefunden.';
          else if( type && response.response.outputSpeech.text === '' )
            response.response.outputSpeech.text = 'Ich habe keine Geräte vom Typ '+ command.type_name +' gefunden.';
          else {
            response.response.card = { type: 'Simple',
                                       title: (command.room?command.room:'') +'status',
                                       content: response.response.outputSpeech.text.replace( /, /g, '\n' ) };
          }

        } else {
          response.response.outputSpeech.text = 'Das habe ich leider nicht verstanden.';
        }

      } else if( command.characteristic == 'On' ) {
        function SwitchOnOff(device,value,ok) {
          if( !mappings.On ) {
            return 'Ich kann das Gerät mit Namen '+ command.device +' nicht schalten.';

          } else if( value === 'aus' ) {
            device.command( mappings.On, 0 );
            return ok;

          } else if( value === 'an' || value === 'ein' ) {
            device.command( mappings.On, 1 );
            return ok;

          } else if( value === 'um' ) {
            var current = device.fhem.reading2homekit(mappings.On, cached(mappings.On.informId))
            device.command( mappings.On, current?0:1 );
            return ok.replace( 'umgeschaltet', (current?'ausgeschaltet':'eingeschaltet') );

          } else
            return 'Ich kann das Gerät mit Namen '+ command.device +' nicht '+ value +'schalten.';
        }

        if( (command.room || type) && !device ) {
          response.response.outputSpeech.text = '';
          for( let d in this.devices ) {
            var device = this.devices[d];
            if( !device ) continue;
            if( command.device && !device.hasName(command.device) ) continue;
            if( type && !device.isOfType(type) ) continue;
            if( command.room && !device.isInRoom(command.room) ) continue;
            if( !device.isInScope('alexa') && !device.isInScope('alexa-custom') ) continue;

            response.response.outputSpeech.text = response.response.outputSpeech.text.replace( ' und ', ', ' );
            if( response.response.outputSpeech.text ) response.response.outputSpeech.text += ' und ';
            response.response.outputSpeech.text += SwitchOnOff( device, command.value, command.article +' '+ device.alexaName );
            var name = device.alexaName;
            if( !command.room && device.alexaRoom && this.roomsOfName &&  this.roomsOfName[name] && this.roomsOfName[name].length > 1 )
              response.response.outputSpeech.text += ' im Raum '+ device.alexaRoom;
          }
          if( command.room && response.response.outputSpeech.text === '' )
            response.response.outputSpeech.text = 'Ich habe keinen Raum '+ command.room +' mit Geräten '+ (type?'vom Typ '+command.type_name:'') +' gefunden.';
          else if( type && response.response.outputSpeech.text === '' )
            response.response.outputSpeech.text = 'Ich habe keine Geräte vom Typ '+ command.type_name +' gefunden.';
          else {
            response.response.outputSpeech.text += ' '+ command.value +'geschaltet.';
            response.response.card = { type: 'Simple',
                                       title: 'On',
                                       content: response.response.outputSpeech.text };
            response.response.outputSpeech.text = 'Ich habe '+ response.response.outputSpeech.text;
            if( !in_session && fhem && fhem.alexaConfirmationLevel < 1 )
              response.response.outputSpeech.text = '';
            else if( fhem && fhem.alexaConfirmationLevel < 2 )
              response.response.outputSpeech.text = 'OK.';
          }

        } else if( device ) {
          response.response.outputSpeech.text = 'OK.';
          if( command.room && command.device )
            response.response.outputSpeech.text = 'Ich habe '+ command.article +' '+ command.device +' im Raum '+ command.room +' '+ command.value +'geschaltet.';
          else if( command.device )
            response.response.outputSpeech.text = 'Ich habe '+ command.article +' '+ command.device +' '+ command.value +'geschaltet.';

          if( !in_session && fhem && fhem.alexaConfirmationLevel < 1 )
            response.response.outputSpeech.text = '';
          else if( fhem && fhem.alexaConfirmationLevel < 2 )
            response.response.outputSpeech.text = 'OK.';

          response.response.outputSpeech.text = SwitchOnOff( device, command.value, response.response.outputSpeech.text );

        } else
          response.response.outputSpeech.text = 'Ich habe kein Gerät gefunden.';

      } else if( intent_name === 'DeviceListIntent' ) {
        response.response.outputSpeech.text = '';
        for( let d in this.devices ) {
          var device = this.devices[d];
          if( !device ) continue;
          if( command.room && !device.isInRoom(command.room) ) continue;
          response.response.outputSpeech.text = response.response.outputSpeech.text.replace( ' und ', ', ' );
          if( response.response.outputSpeech.text ) response.response.outputSpeech.text += ' und ';
          response.response.outputSpeech.text += device.alexaName;
          var name = device.alexaName;
          if( !command.room && device.alexaRoom && this.roomsOfName &&  this.roomsOfName[name] && this.roomsOfName[name].length > 1 )
            response.response.outputSpeech.text += ' im Raum '+ device.alexaRoom;
        }
        response.response.card = { type: 'Simple',
                                   title: 'Geräteliste',
                                   content: response.response.outputSpeech.text.replace( ', ', '\n' ).replace( ' und ', '\n' ) };
        response.response.outputSpeech.text = 'Ich kenne: '+response.response.outputSpeech.text;

      } else if( intent_name === 'RoomListIntent' ) {
        response.response.outputSpeech.text = '';
        var rooms = {};
        for( let d in this.devices ) {
          let device = this.devices[d];
          if( !device.alexaRoom ) continue;
          var room = device.alexaRoom;
          rooms[room] = room;
        }
        for( let room in rooms ) {
          response.response.outputSpeech.text = response.response.outputSpeech.text.replace( ' und ', ', ' );
          if( response.response.outputSpeech.text ) response.response.outputSpeech.text += ' und ';
          response.response.outputSpeech.text += room;
        }
        response.response.card = { type: 'Simple',
                                   title: 'Raumliste',
                                   content: response.response.outputSpeech.text.replace( ', ', '\n' ).replace( ' und ', '\n' ) };
        response.response.outputSpeech.text = 'Ich kenne: '+response.response.outputSpeech.text;

      } else if( command.characteristic ) {
        var fhem;
        function Switch(device,command,value) {
          var characteristic = command.characteristic;
          var orig = value;

log.debug(characteristic);
log.debug(intent_name);
          if( mappings && !mappings[characteristic] ) {
log.debug(device.fhem.characteristicsOfIntent[intent_name]);
            if( device.fhem.characteristicsOfIntent[intent_name] !== undefined ) {
              for( c of device.fhem.characteristicsOfIntent[intent_name] ) {
log.debug(c);
                if( mappings[c] ) {
                  characteristic =  c;
                  break;
                }
              }
          }
log.info( intent_name +' -> '+ characteristic );
          }

          if( mappings && !mappings[characteristic] )
            return 'Ich kann '+ command.device +' nicht auf '+ value +' schalten.';

          var mapping = mappings[characteristic];

          if( device && device.fhem.alexaMapping && device.fhem.alexaMapping[characteristic] ) {
            var alexaMapping;
            if( command.index !== undefined && device.fhem.alexaMapping[characteristic][command.index] )
              alexaMapping = device.fhem.alexaMapping[characteristic][command.index];
            else if( device.fhem.alexaMapping[characteristic].values )
              alexaMapping = device.fhem.alexaMapping[characteristic];
            //else
              //return 'Ich kann '+ command.device +' nicht auf '+ value +' schalten.';

            if( alexaMapping ) {
              if( !command.type_name && !command.article && alexaMapping.articles )
                command.article = alexaMapping.articles[0];

              var mapped = value;
              if( typeof alexaMapping.value2homekit === 'object' )
                if( alexaMapping.value2homekit[value] !== undefined )
                  mapped = alexaMapping.value2homekit[value];

              if( value !== mapped )
                alexaMapping.log.debug(mapping.informId + ' values: value ' + value + ' mapped to ' + mapped);
              value = mapped;
              if( !isNaN(value) ) {
                value = parseFloat(value);
                if( alexaMapping.minValue !== undefined && value < alexaMapping.minValue )
                  value = alexaMapping.minValue;
                else if( alexaMapping.maxValue !== undefined && value > alexaMapping.maxValue )
                  value = mapping.maxValue;
                if( mapping.minValue !== undefined && value < mapping.minValue )
                  value = mapping.minValue;
                else if( mapping.maxValue !== undefined && value > mapping.maxValue )
                  value = mapping.maxValue;
              }
            }
            if( !fhem )
              fhem = device.fhem;

            device.command( mapping, value );

            var name = device.alexaName;
            if( device.alexaRoom && this.roomsOfName &&  this.roomsOfName[name] && this.roomsOfName[name].length > 1 )
              return command.article +' '+ device.alexaName +' im Raum '+ device.alexaRoom;
            else
              return command.article +' '+ device.alexaName;

          } else {
            return 'Ich kann nicht auf '+ value +'schalten.';
          }
        }

log.debug( event.request.intent.slots );
log.debug( command.value );

        response.response.outputSpeech.text = '';
        for( let d in this.devices ) {
          let device = this.devices[d];
          if( !device ) continue;
          if( command.device && !device.hasName(command.device) ) continue;
          if( type && !device.isOfType(type) ) continue;
          if( command.room && !device.isInRoom(command.room) ) continue;
          if( !device.isInScope('alexa') && !device.isInScope('alexa-custom') ) continue;

          response.response.outputSpeech.text = response.response.outputSpeech.text.replace( ' und ', ', ' );
          if( response.response.outputSpeech.text ) response.response.outputSpeech.text += ' und ';
          response.response.outputSpeech.text += Switch.bind(this)(device,command,command.value);
        }

        if( command.room && response.response.outputSpeech.text === '' )
          response.response.outputSpeech.text = 'Ich habe keinen Raum '+ command.room +' mit Geräten '+ (type?'vom Typ '+command.type_name:'') +' gefunden.';

        else if( type && response.response.outputSpeech.text === '' )
          response.response.outputSpeech.text = 'Ich habe keine Geräte vom Typ '+ command.type_name +' gefunden.';

        else if( command.device && command.room &&  response.response.outputSpeech.text === '' )
          response.response.outputSpeech.text = 'Ich habe kein Gerät mit Namen '+ command.device +' im Raum '+ command.room +' gefunden.';

        else if( command.device && response.response.outputSpeech.text === '' )
          response.response.outputSpeech.text = 'Ich habe kein Gerät mit Namen '+ command.device +' gefunden.';

        else {
          if( fhem )
            command.verb = fhem.verbsOfIntent[intent_name];
          if( fhem && fhem.prefixOfIntent[intent_name] !== undefined )
            response.response.outputSpeech.text += ' '+ fhem.prefixOfIntent[intent_name].replace( /;.*/g, '' );
          response.response.outputSpeech.text += ' '+ command.value;
          if( fhem && fhem.suffixOfIntent[intent_name] !== undefined )
            response.response.outputSpeech.text += ' '+ fhem.suffixOfIntent[intent_name].replace( /;.*/g, '' );
          if( fhem && fhem.perfectOfVerb[command.verb] !== undefined )
            response.response.outputSpeech.text += ' '+ fhem.perfectOfVerb[command.verb]
          else
            response.response.outputSpeech.text += ' gestellt';

          response.response.card = { type: 'Simple',
                                     title: intent_name,
                                     content: response.response.outputSpeech.text };
          response.response.outputSpeech.text = 'Ich habe '+ response.response.outputSpeech.text;
          if( !in_session && fhem && fhem.alexaConfirmationLevel < 1 )
            response.response.outputSpeech.text = '';
          else if( fhem && fhem.alexaConfirmationLevel < 2 )
            response.response.outputSpeech.text = 'OK.';
        }

      } else {
        response.response.outputSpeech.text = 'Das habe ich leider nicht verstanden';

      }
    }

    if( in_session ) {
      if( !sessions[session] )
        sessions[session] = {};
        sessions[session].in_session = true;

    } else
      delete sessions[session];

    response.response.shouldEndSession = !in_session;

    callback( response );
}

// entry
var handler = function(event, callback) {
  //log.info("Received Directive: "+ JSON.stringify(event));

  var response = null;

  if( event.request ) {
    response = handleCustom.bind(this)(event, callback);
    return;
  }

  var requestedNamespace;
  if( event.header )
    requestedNamespace = event.header.namespace;
  else if( event.directive && event.directive.header )
    requestedNamespace = event.directive.header.namespace;

  try {

    switch (requestedNamespace) {
      case NAMESPACE_SmartHome_DISCOVERY:
        response = handleDiscovery.bind(this)(event);
        break;

      case NAMESPACE_SmartHome_CONTROL:
        response = handleControl.bind(this)(event);
        break;

      case NAMESPACE_SmartHome_SYSTEM:
        response = handleSystem.bind(this)(event);
        break;

      case NAMESPACE_SmartHome_QUERY:
        response = handleQuery.bind(this)(event);
        break;


      case NAMESPACE_ALEXA:
        response = handleAlexa.bind(this)(event);
        break;

      case NAMESPACE_Authorization:
        response = handleAuthorization.bind(this)(event);
        break;

      case NAMESPACE_DISCOVERY:
        response = handleDiscovery3.bind(this)(event);
        break;

      case NAMESPACE_PowerController:
        response = handlePowerController.bind(this)(event);
        break;

      case NAMESPACE_BrightnessController:
        response = handleBrightnessController.bind(this)(event);
        break;

      case NAMESPACE_ColorController:
        response = handleColorController.bind(this)(event);
        break;

      case NAMESPACE_ColorTemperatureController:
        response = handleColorTemperatureController.bind(this)(event);
        break;

      case NAMESPACE_PercentageController:
        response = handlePercentageController.bind(this)(event);
        break;

      case NAMESPACE_LockController:
        response = handleLockController.bind(this)(event);
        break;

      case NAMESPACE_ThermostatController:
        response = handleThermostatController.bind(this)(event);
        break;

      case NAMESPACE_Speaker:
        response = handleSpeaker.bind(this)(event);
        break;

      case NAMESPACE_SceneController:
        response = handleScene.bind(this)(event);
        break;

      case NAMESPACE_ChannelController:
        response = handleChannel.bind(this)(event);
        break;

      case NAMESPACE_InputController:
        response = handleInput.bind(this)(event);
        break;

      case NAMESPACE_PlaybackController:
        response = handlePlayback.bind(this)(event);
        break;

      case NAMESPACE_RangeController:
        response = handleRangeController.bind(this)(event);
        break;

      case NAMESPACE_ModeController:
        response = handleModeController.bind(this)(event);
        break;

      default:
        log.error("Unsupported namespace: " + requestedNamespace);

        response = handleUnexpectedInfo(requestedNamespace);

        break;

    }// switch

  } catch (e) {
    log.error(util.inspect(e));

  }// try-catch

  callback( response );
  //return response;

}// exports.handler


var truncate = function(str, length = 128){
  if( !str ) return str;

  if( str.length > length ) {
    return str.substr(0, length-3) + "...";

  } else {
    return str;

  }
};

var handleDiscovery = function(event) {
  var response = null;

  var requestedName = event.header.name;
  switch (requestedName) {
    case REQUEST_DISCOVER_APPLIANCES :
      var header = createHeader(NAMESPACE_SmartHome_DISCOVERY, RESPONSE_DISCOVER_APPLIANCES);

      var payload = {
        discoveredAppliances: []
      };

      for( var d in this.devices ) {
        let device = this.devices[d];

        if( 0 && !device.isOfType('light') && !device.isOfType('thermostat') ) {
          log.info( 'ignoring '+ device.name +' for alxea ha skill' );
          continue;
        }

        if( !device.isInScope('alexa') && !device.isInScope('alexa-ha') ) {
          log.debug( 'ignoring '+ device.name +' for alxea ha skill' );
          continue;
        }

        let mappings = device ? device.mappings : undefined;

        var room = this.roomOfIntent[accepted_token.oauthClientID];
        //if( room && room !== device.alexaRoom ) {
        if( room && !device.alexaRoom.match( '(^|,)('+room+')(,|\$)' ) ) {
          log.debug( 'ignoring '+ device.name +' in room '+ device.alexaRoom +' for echo in room '+ room );
        }

        //console.log(device);
        var d = { applianceId: device.uuid_base.replace( /[^\w_\-=#;:?@&]/g, '_' ),
                  manufacturerName: 'FHEM'+device.type,
                  modelName: 'FHEM'+ (device.model ? device.model : '<unknown>'),
                  version: '<unknown>',
                  friendlyName: device.alexaName,
                  friendlyDescription: truncate( 'n: '+ device.name + (device.alexaRoom?', r: '+ device.alexaRoom:'') ),
                  isReachable: true,
                  actions: [],
                  applianceTypes: [],
                  additionalApplianceDetails: { device: device.device },
                };

        if( device.isOfType('outlet') )
          d.applianceTypes.push ( 'SMARTPLUG' );
        else if( device.isOfType('light') )
          d.applianceTypes.push ( 'LIGHT' );
        else if( device.isOfType('lock') )
          d.applianceTypes.push ( 'SMARTLOCK' );

        if( mappings.On ) {
          d.actions.push( "turnOn" );
          d.actions.push( "turnOff" );

          d.applianceTypes.push ( 'SWITCH' );
        }

        if( mappings.Brightness || mappings.TargetPosition || mappings[FHEM.CustomUUIDs.Volume] ) {
          d.actions.push( "setPercentage" );
          d.actions.push( "incrementPercentage" );
          d.actions.push( "decrementPercentage" );
        }

        if( mappings.TargetTemperature  ) {
          d.actions.push( "setTargetTemperature" );
          d.actions.push( "incrementTargetTemperature" );
          d.actions.push( "decrementTargetTemperature" );
          d.actions.push( "getTargetTemperature" );

          d.applianceTypes.push ( 'THERMOSTAT' );
        }

        if( mappings.CurrentTemperature  ) {
          d.actions.push( "getTemperatureReading" );
        }

        if( mappings.Hue  ) {
          d.actions.push( "setColor" );
        }

        if( mappings.ColorTemperature ||  mappings[FHEM.CustomUUIDs.ColorTemperature] || mappings[FHEM.CustomUUIDs.CT] ) {
          d.actions.push( "setColorTemperature" );
          d.actions.push( "incrementColorTemperature" );
          d.actions.push( "decrementColorTemperature" );
        }

        if( mappings.LockTargetState  ) {
          d.actions.push( "setLockState" );
        }

        if( mappings.LockCurrentState  ) {
          d.actions.push( "getLockState" );
        }


        if( d.actions.length )
          payload.discoveredAppliances.push( d );
      } // devices

      response = createDirective(header, payload);
      break;

    default:
      log.error("Unsupported operation" + requestedName);
      response = handleUnsupportedOperation();

      break;

  }// switch

  return response;

}// handleDiscovery

var handleSystem = function(event) {
  var response = null;

  var requestedName = event.header.name;
  switch (requestedName) {
    case REQUEST_HEALTH_CHECK :
      var header = createHeader(NAMESPACE_SmartHome_SYSTEM,RESPONSE_HEALTH_CHECK)
      var payload = { description: "The system is currently healthy",
                      isHealthy: true,
                    };

      response = createDirective(header, payload);
      break;

    default:
      log.error("Unsupported operation" + requestedName);
      response = handleUnsupportedOperation();

      break;

  }// switch

  return response;

} //handleSystem

var handleControl = function(event) {
  var response = null;

  var requestedName = event.header.name;
  switch (requestedName) {
    case REQUEST_TURN_ON :
      response = handleControlTurnOn.bind(this)(event);
      break;

    case REQUEST_TURN_OFF :
      response = handleControlTurnOff.bind(this)(event);
      break;

    case REQUEST_SET_PERCENTAGE :
      response = handleControlSetPercentage.bind(this)(event);
      break;

    case REQUEST_INCREMENT_PERCENTAGE :
      response = handleControlIncrementPercentage.bind(this)(event);
      break;

    case REQUEST_DECREMENT_PERCENTAGE :
      response = handleControlDecrementPercentage.bind(this)(event);
      break;

    case REQUEST_SET_TARGET_TEMPERATURE :
      response = handleControlSetTargetTemperature.bind(this)(event);
      break;

    case REQUEST_INCREMENT_TARGET_TEMPERATURE :
      response = handleControlIncrementTargetTemperature.bind(this)(event);
      break;

    case REQUEST_DECREMENT_TARGET_TEMPERATURE :
      response = handleControlDecrementTargetTemperature.bind(this)(event);
      break;

    case REQUEST_SET_COLOR :
      response = handleControlSetColor.bind(this)(event);
      break;

    case REQUEST_SET_COLOR_TEMPERATURE :
      response = handleControlSetColorTemperature.bind(this)(event);
      break;

    case REQUEST_INCREMENT_COLOR_TEMPERATURE :
      response = handleControlIncrementColorTemperature.bind(this)(event);
      break;

    case REQUEST_DECREMENT_COLOR_TEMPERATURE :
      response = handleControlDecrementColorTemperature.bind(this)(event);
      break;

    case REQUEST_SET_LOCK_STATE :
      response = handleControlSetLockState.bind(this)(event);
      break;


    default:
      log.error("Unsupported operation" + requestedName);
      response = handleUnsupportedOperation();

      break;

  }// switch

  return response;

}// handleControl

var handleQuery = function(event) {
  var response = null;

  var requestedName = event.header.name;
  switch (requestedName) {
    case REQUEST_GET_LOCK_STATE :
      response = handleControlGetLockState.bind(this)(event);
      break;

    case REQUEST_GET_TEMPERATURE_READING :
      response = handleQueryGetTemperatureReading.bind(this)(event);
      break;

    case REQUEST_GET_TARGET_TEMPERATURE :
      response = handleQueryGetTargetTemperature.bind(this)(event);
      break;

    default:
      log.error("Unsupported operation" + requestedName);
      response = handleUnsupportedOperation();

      break;

  }// switch

  return response;

} //handleQuery

var handleAlexa = function(event) {
  var response = null;

  var requestedName = event.directive.header.name;
  switch (requestedName) {
    case REQUEST_STATE :
      response = handleReportState.bind(this)(event);
      break;

    default:
      log.error("Unsupported operation" + requestedName);
      response = handleUnsupportedOperation();

      break;

  }// switch

  return response;

} //handleAlexa

var handleAuthorization = function(event) {
  var response = null;

  var requestedName = event.directive.header.name;
  switch (requestedName) {
    case 'AcceptGrant':
      this.updateEventToken(event.directive.payload);

      var header = createHeader("Alexa.Authorization", "AcceptGrant.Response", event);
      response = createDirective(header, {});
      response = { "event": response };
      break;

    default:
      log.error("Unsupported operation" + requestedName);
      response = handleUnsupportedOperation();

      break;

  }// switch

  return response;

} //handleAuthorization

function propertiesFromDevice(device, informId) {
  var properties = [];

  var mapping;
  if( mapping = device.mappings.On ) {
    if( informId === undefined || informId === mapping.informId ) {
      var current = device.fhem.reading2homekit(mapping, device.fhem.cached(mapping.informId));
      if( current !== undefined )
        properties.push( {
            "namespace": NAMESPACE_PowerController,
            "name": "powerState",
            "value": current?"ON":"OFF",
            "timeOfSample": new Date(Date.now()).toISOString(),
            "uncertaintyInMilliseconds": 500
        } );
    }
  }

  if( mapping = device.mappings.Brightness ) {
    if( informId === undefined || informId === mapping.informId ) {
      var current = device.fhem.reading2homekit(mapping, device.fhem.cached(mapping.informId));
      if( current !== undefined )
        properties.push( {
            "namespace": NAMESPACE_BrightnessController,
            "name": "brightness",
            "value": parseInt(current),
            "timeOfSample": new Date(Date.now()).toISOString(),
            "uncertaintyInMilliseconds": 500
        } );
    }
  }

  if( device.mappings.ColorTemperature || device.mappings[FHEM.CustomUUIDs.ColorTemperature] || device.mappings[FHEM.CustomUUIDs.CT] ) {
    if( device.mappings.ColorTemperature )
      mapping = device.mappings.ColorTemperature;
    else if( device.mappings[FHEM.CustomUUIDs.ColorTemperature] )
      mapping = device.mappings[FHEM.CustomUUIDs.ColorTemperature];
    else if( device.mappings[FHEM.CustomUUIDs.CT] )
      mapping = device.mappings[FHEM.CustomUUIDs.CT];

    if( informId === undefined || informId === mapping.informId ) {
      var current = parseInt(device.fhem.cached(mapping.informId));
      if( current < 1000 )
        current = 1000000 / current;

      if( current !== undefined )
        properties.push( {
        "namespace": NAMESPACE_ColorTemperatureController,
        "name": "colorTemperatureInKelvin",
        "value": parseInt(current),
        "timeOfSample": new Date(Date.now()).toISOString(),
        "uncertaintyInMilliseconds": 500
        } );
    }
  }

  if( device.mappings.Hue && device.mappings.Saturation && device.mappings.Brightness ) {
    if( informId === undefined
	|| informId === device.mappings.Hue.informId
	|| informId === device.mappings.Saturation.informId
	|| informId === device.mappings.Brightness.informId ) {
      var hue = device.fhem.reading2homekit(device.mappings.Hue, device.fhem.cached(device.mappings.Hue.informId));
      var saturation = device.fhem.reading2homekit(device.mappings.Saturation, device.fhem.cached(device.mappings.Saturation.informId));
      var brightness = device.fhem.reading2homekit(device.mappings.Brightness, device.fhem.cached(device.mappings.Brightness.informId));
    if( hue !== undefined )
      properties.push( {
            "namespace": NAMESPACE_ColorController,
            "name": "color",
            "value": { "hue": hue,
                       "saturation": saturation / 100,
                       "brightness": brightness / 100 },
            "timeOfSample": new Date(Date.now()).toISOString(),
            "uncertaintyInMilliseconds": 500
      } );
    }
  } else if( device.mappings.RGB ) {
    var rgb = device.fhem.reading2homekit(device.mappings.RGB, device.fhem.cached(device.mappings.RGB.informId));
    var hsv = FHEM.FHEM_rgb2hsv(rgb);
    var hue = parseInt( hsv[0] * 360.0 );
    var saturation = parseInt( hsv[1] * 100.0 );
    var brightness = parseInt( hsv[2] * 100.0 );

    properties.push( {
          "namespace": NAMESPACE_ColorController,
          "name": "color",
          "value": { "hue": hue,
                     "saturation": saturation / 100,
                     "brightness": brightness / 100 },
          "timeOfSample": new Date(Date.now()).toISOString(),
           "uncertaintyInMilliseconds": 500
    } );
  }


  if( mapping = device.mappings.TargetPosition ) {
    if( informId === undefined || informId === mapping.informId ) {
      var current = device.fhem.reading2homekit(mapping, device.fhem.cached(mapping.informId));
      if( device.isOfType('blind') && current !== undefined ) {
        properties.push( {
            "namespace": NAMESPACE_RangeController,
	    "instance": "Blind.Position",
            "name": "rangeValue",
            "value": parseInt(current),
            "timeOfSample": new Date(Date.now()).toISOString(),
            "uncertaintyInMilliseconds": 500
        } );
      } else if( current !== undefined ) {
        properties.push( {
            "namespace": NAMESPACE_PercentageController,
            "name": "percentage",
            "value": parseInt(current),
            "timeOfSample": new Date(Date.now()).toISOString(),
            "uncertaintyInMilliseconds": 500
        } );
      }
    }
  }

  if( mapping = device.mappings.ModeController ) {
    if( informId === undefined || informId === mapping.informId ) {
      //var current = device.fhem.reading2homekit(mapping, device.fhem.cached(mapping.informId));
      var current = device.fhem.cached(mapping.informId);
      properties.push( {
          "namespace": NAMESPACE_ModeController,
	  "instance": instanceForMode(device, mapping),
          "name": "mode",
          "value": valueForMode(device, mapping, current),
          "timeOfSample": new Date(Date.now()).toISOString(),
          "uncertaintyInMilliseconds": 500
      } );
    }
  }

  if( mapping = device.mappings.TargetTemperature ) {
    if( informId === undefined || informId === mapping.informId ) {
      var current = device.fhem.reading2homekit(mapping, device.fhem.cached(mapping.informId));
      if (current !== undefined)
        properties.push({
          "namespace": NAMESPACE_ThermostatController,
          "name": "targetSetpoint",
          "value": {"value": parseFloat(current), "scale": "CELSIUS"},
          "timeOfSample": new Date(Date.now()).toISOString(),
          "uncertaintyInMilliseconds": 500
        });
    }
  }

  if( mapping = device.mappings.TargetHeatingCoolingState ) {
    if( informId === undefined || informId === mapping.informId ) {
      var current = device.fhem.reading2homekit(mapping, device.fhem.cached(mapping.informId));
      if (current !== undefined)
        properties.push({
          "namespace": NAMESPACE_ThermostatController,
          "name": "thermostatMode",
          "value": current,
          "timeOfSample": new Date(Date.now()).toISOString(),
          "uncertaintyInMilliseconds": 500
        });
    }
  }

  if( mapping = device.mappings.CurrentTemperature ) {
    if( informId === undefined || informId === mapping.informId ) {
      var current = device.fhem.reading2homekit(mapping, device.fhem.cached(mapping.informId));
      if( current !== undefined )
        properties.push( {
            "namespace": NAMESPACE_TemperatureSensor,
            "name": "temperature",
            "value": { "value": parseFloat(current), "scale": "CELSIUS" },
            "timeOfSample": new Date(Date.now()).toISOString(),
            "uncertaintyInMilliseconds": 500
        } );
    }
  }

  if( mapping = device.mappings.ContactSensorState ) {
    if( informId === undefined || informId === mapping.informId ) {
      var current = device.fhem.reading2homekit(mapping, device.fhem.cached(mapping.informId));
      if( current === 'CONTACT_DETECTED' || current === 'Closed' || current === 'closed' )
        current = 'NOT_DETECTED';
      else
        current = 'DETECTED';
      if( current !== undefined ) {
        properties.push( {
            "namespace": NAMESPACE_ContactSensor,
            "name": "detectionState",
            "value": current,
            "timeOfSample": new Date(Date.now()).toISOString(),
            "uncertaintyInMilliseconds": 500
        } );
        if( !device.mappings.Reachable )
          properties.push({
              "namespace": "Alexa.EndpointHealth",
              "name": "connectivity",
              "value": {"value": "OK" },
              "timeOfSample": new Date(Date.now()).toISOString(),
              "uncertaintyInMilliseconds": 500
          } );
      }
    }

  } else if( mapping = device.mappings.CurrentDoorState ) {
    if( informId === undefined || informId === mapping.informId ) {
      var current = device.fhem.reading2homekit(mapping, device.fhem.cached(mapping.informId));
      if( current === 'CLOSED' || current === 'Closed' || current === 'closed' )
        current = 'NOT_DETECTED';
      else
        current = 'DETECTED';
      if( current !== undefined )
        properties.push( {
            "namespace": NAMESPACE_ContactSensor,
            "name": "detectionState",
            "value": current,
            "timeOfSample": new Date(Date.now()).toISOString(),
            "uncertaintyInMilliseconds": 500
        } );
    }
  }

  if( mapping = device.mappings.MotionDetected ) {
    if( informId === undefined || informId === mapping.informId ) {
      var current = device.fhem.reading2homekit(mapping, device.fhem.cached(mapping.informId));
      if( (typeof(current) === 'boolean' && current) || current === 'motion' || parseInt(current) == true )
        current = 'DETECTED';
      else
        current = 'NOT_DETECTED';
      if( current !== undefined ) {
        properties.push( {
            "namespace": NAMESPACE_MotionSensor,
            "name": "detectionState",
            "value": current,
            "timeOfSample": new Date(Date.now()).toISOString(),
            "uncertaintyInMilliseconds": 500
        } );
        if( !device.mappings.Reachable ) {
          properties.push({
              "namespace": "Alexa.EndpointHealth",
              "name": "connectivity",
              "value": {"value": "OK" },
              "timeOfSample": new Date(Date.now()).toISOString(),
              "uncertaintyInMilliseconds": 500
          } );
        }
      }
    }
  }

  if( mapping = device.mappings.LockCurrentState  ) {
    if( informId === undefined || informId === mapping.informId ) {
      var current = device.fhem.reading2homekit(mapping, device.fhem.cached(mapping.informId));
      if( current === 'SECURED' || current === 'locked' )
        current = 'LOCKED';
      else
        current = 'UNLOCKED';
      if( current !== undefined )
        properties.push( {
            "namespace": NAMESPACE_LockController,
            "name": "lockState",
            "value": current,
            "timeOfSample": new Date(Date.now()).toISOString(),
            "uncertaintyInMilliseconds": 500
        } );
    }
  }

  if( mapping = device.mappings.Alarm ) {
    if( informId === undefined || informId === mapping.informId ) {
      var current = device.fhem.reading2homekit(mapping, device.fhem.cached(mapping.informId));
      var match;
      if( current === undefined || (typeof(current) === 'boolean' && !current) || current === 'ok' || current.match(/^no/) )
        current = 'OK';
      else
        current = 'ALARM';
      var type = mapping.type || 'fireAlarm';
      if (current !== undefined)
        properties.push({
          "namespace": NAMESPACE_SecurityPanelController,
          "name": type,
          "value": current,
          "timeOfSample": new Date(Date.now()).toISOString(),
          "uncertaintyInMilliseconds": 500
        });
    }
  }


  if( properties.length )
    if( mapping = device.mappings.Reachable )
      properties.push({
          "namespace": "Alexa.EndpointHealth",
          "name": "connectivity",
          "value": {"value": device.fhem.cached(mapping.informId) ? "OK" : "UNREACHABLE" },
          "timeOfSample": new Date(Date.now()).toISOString(),
          "uncertaintyInMilliseconds": 500
      } );

  return properties;
}

var handleReportState = function(event) {
  var device = this.devices[event.directive.endpoint.cookie.device.toLowerCase()];
  if( !device )
    return createError(ERROR3_NO_SUCH_ENDPOINT, undefined, event);

  var context = { "properties": propertiesFromDevice(device) };

  var header = createHeader("Alexa", RESPONSE_STATE, event);
  var endpoint = { "scope": event.directive.endpoint.scope, "endpointId": event.directive.endpoint.endpointId};

  return { "context": context, "event": { "header": header, "endpoint": endpoint , "payload": {} } };
} //handleReportState

function instanceForMode(device, mapping) {
  var instance = 'fhem.';
      instance += device.name;
      instance += '.';
      instance += mapping.instance || mapping.mode || mapping.cmd || 'mode';
  return instance;
}
function valueForMode(device, mapping, value) {
  var instance = 'fhem.';
      instance += device.name;
      instance += '.';
      instance += mapping.mode || mapping.cmd || 'mode';
      instance += '.';
      instance += value;
  return instance;
}


function deviceToEndpoints(device) {
  log.error(device.mappings);
  //console.log(device);
  var d = { endpointId: device.uuid_base.replace( /[^\w_\-=#;:?@&]/g, '_' ),
            manufacturerName: device.type,
            description: truncate( 'n: '+ device.name + (device.alexaRoom?', r: '+ device.alexaRoom:'') ),
            friendlyName: device.alexaName,
            displayCategories: [],
            additionalAttributes: { "manufacturer": "FHEM", model: (device.model ? device.model : '<unknown>') },
            capabilities: [],
            //connections: [],
            cookie: { device: device.device, fuuid: device.fuuid },
          };

  // https://developer.amazon.com/en-US/docs/alexa/device-apis/alexa-interface.html
  d.capabilities.push( {
                         "type": "AlexaInterface",
                         "interface": "Alexa",
                         "version": "3",
                       }
                     );

  let mappings = device.mappings;
  if( device.isOfType('scene') ) {
    if( device.alexaRoom )
      d.friendlyName += ' '+ device.alexaRoom
    //d.description: 'n: '+ device.name + (device.alexaRoom?', r: '+ device.alexaRoom:''),
    if( device.type === 'harmony' || device.type === 'LightScene' )
      d.displayCategories.push ( 'ACTIVITY_TRIGGER' );
    else
      d.displayCategories.push ( 'SCENE_TRIGGER' );

    if( device.type === 'LightScene' ) {
      var match;
      if( match = device.PossibleSets.match(/(^| )scene:([^\s]*)/) ) {
        var template = d;
        d = [];
        var i = 0;
        for( let scene of match[2].split(',') ) {
          d.push( JSON.parse(JSON.stringify(template)) );

          d[i].endpointId += ' '+ scene;
          d[i].friendlyName = scene;
          if( device.alexaRoom )
            d[i].friendlyName += ' '+ device.alexaRoom

          d[i].cookie.device += ':'+ scene;
          d[i].cookie.scene = scene;

          d[i].capabilities.push( {
                                 "type": "AlexaInterface",
                                 "interface": NAMESPACE_SceneController,
                                 "version": "3",
                                 "supportsDeactivation": false
                               }
                             );
          ++i;
        }
      }

    } else if( device.type === 'structure' ) {
      d.capabilities.push( {
                             "type": "AlexaInterface",
                             "interface": NAMESPACE_SceneController,
                             "version": "3",
                             "supportsDeactivation": true
                           }
                         );

    } else if( mappings.On && mappings.On.cmdOn ) {
      d.capabilities.push( {
                             "type": "AlexaInterface",
                             "interface": NAMESPACE_SceneController,
                             "version": "3",
                             "supportsDeactivation": (mappings.On.cmdOff ? true : false)
                           }
                         );
    }

    if( Array.isArray(d) ) return d;
    return [d];
  }

  if( mappings.Reachable )
    d.capabilities.push( {
                           "type": "AlexaInterface",
                           "interface": "Alexa.EndpointHealth",
                           "version": "3",
                           "properties": {
                              "supported": [
                                 { "name": "connectivity" }
                              ],
                              "proactivelyReported": device.proactiveEvents,
                              "retrievable": true
                           }
                         }
                       );


  if( device.isOfType('outlet') )
    d.displayCategories.push ( 'SMARTPLUG' );
  else if( device.isOfType('light') )
    d.displayCategories.push ( 'LIGHT' );
  else if( device.isOfType('blind') ) {
    if( device.type === 'HUEDevice' )
      d.displayCategories.push ( 'INTERIOR_BLIND' );
    else
      d.displayCategories.push ( 'EXTERIOR_BLIND' );
  } else if( device.isOfType('lock') )
    d.displayCategories.push ( 'SMARTLOCK' );
  else if( device.isOfType('media') )
    d.displayCategories.push ( 'TV' );
  else if( device.isOfType('switch') )
    d.displayCategories.push ( 'SWITCH' );


  if( mappings.Brightness ) {
    d.capabilities.push( {
                           "type": "AlexaInterface",
                           "interface": NAMESPACE_BrightnessController,
                           "version": "3",
                           "properties": {
                             "supported": [
                               { "name": "brightness" }
                             ],
                             "proactivelyReported": device.proactiveEvents,
                             "retrievable": true
                           }
                         }
                       );
  }

  if( device.isOfType('blind') && mappings.TargetPosition ) {
    var mapping = mappings.TargetPosition;
    d.capabilities.push( {
                           "type": "AlexaInterface",
                           "interface": NAMESPACE_RangeController,
	                   "instance": "Blind.Position",
                           "version": "3",
                           "properties": {
                             "supported": [
                               { "name": "rangeValue" },
                             ],
                             "proactivelyReported": device.proactiveEvents,
                             "retrievable": true
                           },
	                   "capabilityResources": {
                             "friendlyNames": [
			       mapping.invert ?
			       {
                                 "@type": "text",
                                   "value": {
                                   "text": "Geschlossenheitsgrad",
                                   "locale": "de-DE"
                                 }
                               } : {
                                 "@type": "asset",
                                 "value": {
                                   "assetId": "Alexa.Setting.Opening"
                                 }
                               }
                             ]
                           },
                           "configuration": {
                             "supportedRange": {
                               "minimumValue": mapping.minValue || 0,
                               "maximumValue": mapping.maxValue || 100,
                               "precision": mapping.minStep || 1
                             },
                             "unitOfMeasure": "Alexa.Unit.Percent"
                           },
	                   /*"presets": [
                             {
                               "rangeValue": 0,
                               "presetResources": {
                                 "friendlyNames": [
                                   {
                                     "@type": "asset",
                                     "value": {
                                       "assetId": "Alexa.Value.Close"
                                     }
                                   },
                                   {
                                     "@type": "asset",
                                     "value": {
                                       "assetId": "Alexa.Value.Low"
                                     }
                                   },
                                   {
                                     "@type": "text",
                                     "value": {
                                       "text": "runter",
                                       "locale": "de-DE"
                                     }
                                   }
                                 ]
                               }
                             },
                             {
                               "rangeValue": 50,
                               "presetResources": {
                                 "friendlyNames": [
                                   {
                                     "@type": "asset",
                                     "value": {
                                       "assetId": "Alexa.Value.Medium"
                                     }
                                   },
                                   {
                                     "@type": "text",
                                     "value": {
                                       "text": "mitte",
                                       "locale": "de-DE"
                                     }
                                   }
                                 ]
                               }
                             },
                             {
                               "rangeValue": 100,
                               "presetResources": {
                                 "friendlyNames": [
                                   {
                                     "@type": "asset",
                                     "value": {
                                       "assetId": "Alexa.Value.Open"
                                     }
                                   },
                                   {
                                     "@type": "asset",
                                     "value": {
                                       "assetId": "Alexa.Value.High"
                                     }
                                   },
                                   {
                                     "@type": "text",
                                     "value": {
                                       "text": "hoch",
                                       "locale": "de-DE"
                                     }
                                   }
                                 ]
                               }
                             }
                           ], */
                           "semantics": {
                             "actionMappings": [
                               {
                                 "@type": "ActionsToDirective",
                                 "actions": ["Alexa.Actions.Close"],
                                 "directive": {
                                   "name": "SetRangeValue",
                                   "payload": {
                                     "rangeValue": mapping.invert ? (mapping.minValue || 100) : (mapping.maxValue || 0)
                                   }
                                 }
                               },
                               {
                                 "@type": "ActionsToDirective",
                                 "actions": ["Alexa.Actions.Open"],
                                 "directive": {
                                   "name": "SetRangeValue",
                                   "payload": {
                                     "rangeValue": mapping.invert ? (mapping.minValue || 0) : (mapping.maxValue || 100)
                                   }
                                 }
                               },
                               {
                                 "@type": "ActionsToDirective",
                                 "actions": ["Alexa.Actions.Lower"],
                                 "directive": {
                                   "name": "AdjustRangeValue",
                                   "payload": {
                                     "rangeValueDelta": mapping.invert ? (mapping.minStep || 10) : (-mapping.minStep || -10),
                                     "rangeValueDeltaDefault": false
                                   }
                                 }
                               },
                               {
                                 "@type": "ActionsToDirective",
                                 "actions": ["Alexa.Actions.Raise"],
                                 "directive": {
                                   "name": "AdjustRangeValue",
                                   "payload": {
                                     "rangeValueDelta": mapping.invert ? (-mapping.minStep || -10) : (mapping.minStep || 10),
                                     "rangeValueDeltaDefault": false
                                   }
                                 }
                               }
                             ] ,
                             "stateMappings": [
                               {
                                 "@type": "StatesToValue",
                                 "states": ["Alexa.States.Closed"],
                                 "value": mapping.minValue || 0
                               },
                               {
                                 "@type": "StatesToRange",
                                 "states": ["Alexa.States.Open"],
                                 "range": {
                                   "minimumValue": mapping.minValue ? mapping.minValue + 1 : 1,
                                   "maximumValue": mapping.maxValue || 100
                                 }
                               }
                             ]
                           }
                         }
                       );

    log.error(mapping.invert?'true':'false');
    if( device.fhem.alexaMapping && device.fhem.alexaMapping.TargetPosition && device.fhem.alexaMapping.TargetPosition.action2value  ) {
      let action2value = device.fhem.alexaMapping.TargetPosition.action2value;
      let semantics = d.capabilities[d.capabilities.length-1].semantics;
      log.error(semantics);
      let actionMappings = [];
      for( let action of Object.keys(action2value) ) {
        let value = action2value[action];
	if( value.match( '^[+-]' ) )
	  actionMappings.push( {
                                 "@type": "ActionsToDirective",
                                 "actions": ["Alexa.Actions."+ action],
                                 "directive": {
                                   "name": "AdjustRangeValue",
                                   "payload": {
                                     "rangeValueDelta": parseInt(value),
                                     "rangeValueDeltaDefault": false
                                   }
                                 }
	                       } );
	else
	  actionMappings.push( {
                                 "@type": "ActionsToDirective",
                                 "actions": ["Alexa.Actions."+ action],
                                 "directive": {
                                   "name": "SetRangeValue",
                                   "payload": {
                                     "rangeValue": parseInt(value)
                                   }
                                 }
	                       } );
      }
      semantics.actionMappings = actionMappings;
      log.error(semantics);
    }

  } else if( mappings.TargetPosition ) {
    d.capabilities.push( {
                           "type": "AlexaInterface",
                           "interface": NAMESPACE_PercentageController,
                           "version": "3",
                           "properties": {
                             "supported": [
                               { "name": "percentage" },
                             ],
                             "proactivelyReported": device.proactiveEvents,
                             "retrievable": true
                           }
                         }
                       );
  }

  if( device.isOfType('mode') && mappings.ModeController ) {
    var mapping = mappings.ModeController;
    d.capabilities.push( {
                           "type": "AlexaInterface",
                           "interface": NAMESPACE_ModeController,
	                   "instance": instanceForMode(device, mapping),
                           "version": "3",
                           "properties": {
                             "supported": [
                               { "name": "mode" },
                             ],
                             "proactivelyReported": device.proactiveEvents,
                             "retrievable": true,
		             "nonControllable": false
                           },
	                   "capabilityResources": {
                             "friendlyNames": [
                               {
                                 "@type": "text",
                                 "value": {
                                   "text": mapping.mode || "mode",
                                   "locale": mapping.locale || "de-DE"
                                 }
                               }
                             ]
                           },
                           "configuration": {
		             "ordered": (mapping.ordered?true:false) || false,
                             "supportedModes": [
                             ]
                           },
                           "semantics": {
                           }
                         }
                       );

	
    if( typeof mapping.value2homekit === 'object' ) {
      let modes = [];
      for( let from of Object.keys(mapping.value2homekit) ) {
        let to = mapping.value2homekit[from];
        modes.push( {
		      "value": valueForMode(device, mapping, from),
		      "modeResources": {
		        "friendlyNames": [
		          {
                            "@type": "text",
                            "value": {
                              "text": to,
                              "locale": mapping.locale || "de-DE"
                            }
                          }
		        ]
                      }
                    } );
      }
      let configuration = d.capabilities[d.capabilities.length-1].configuration;
      configuration.supportedModes = modes;
      //log.error(d.capabilities);
    }

    if( !d.displayCategories.length )
      d.displayCategories.push ( 'OTHER' );
  }

  if( mappings.Hue || mappings.RGB ) {
    d.capabilities.push( {
                           "type": "AlexaInterface",
                           "interface": NAMESPACE_ColorController,
                           "version": "3",
                           "properties": {
                             "supported": [
                               { "name": "color" }
                             ],
                             "proactivelyReported": device.proactiveEvents,
                             "retrievable": ((mappings.Saturation && mappings.Brightness) ? true : false)
                           }
                         }
                       );
  }

  if( mappings.ColorTemperature || mappings[FHEM.CustomUUIDs.ColorTemperature] || mappings[FHEM.CustomUUIDs.CT] ) {
    d.capabilities.push( {
                           "type": "AlexaInterface",
                           "interface": NAMESPACE_ColorTemperatureController,
                           "version": "3",
                           "properties": {
                             "supported": [
                               { "name": "colorTemperatureInKelvin" }
                             ],
                             "proactivelyReported": device.proactiveEvents,
                             "retrievable": true
                           }
                         }
                       );
  }

  if( mappings.ContactSensorState || mappings.CurrentDoorState   ) {
    d.capabilities.push( {
                           "type": "AlexaInterface",
                           "interface": NAMESPACE_ContactSensor,
                           "version": "3",
                           "properties": {
                             "supported": [
                               { "name": "detectionState" }
                             ],
                             "proactivelyReported": device.proactiveEvents,
                             "retrievable": true
                           }
                         }
                       );

    if( !d.displayCategories.length )
      d.displayCategories.push ( 'CONTACT_SENSOR' );
  }

  if( mappings.MotionDetected ) {
    d.capabilities.push( {
                           "type": "AlexaInterface",
                           "interface": NAMESPACE_MotionSensor,
                           "version": "3",
                           "properties": {
                             "supported": [
                               { "name": "detectionState" }
                             ],
                             "proactivelyReported": device.proactiveEvents,
                             "retrievable": true
                           }
                         }
                       );

    if( !d.displayCategories.length )
      d.displayCategories.push ( 'MOTION_SENSOR' );
  }

  if( mappings.Alarm ) {
    var type = mappings.Alarm.type || 'fireAlarm';
    d.capabilities.push( {
                           "type": "AlexaInterface",
                           "interface": NAMESPACE_SecurityPanelController,
                           "version": "3",
                           "properties": {
                             "supported": [
                               { "name": type }
                             ],
                             "proactivelyReported": device.proactiveEvents,
                             "retrievable": true
                           }
                         }
                       );

    if( !d.displayCategories.length )
      d.displayCategories.push ( 'SECURITY_PANEL' );
  }

  if( mappings.TargetTemperature  ) {
    const capability = {
      "type": "AlexaInterface",
      "interface": NAMESPACE_ThermostatController,
      "version": "3",
      "properties": {
        "supported": [
          { "name": "targetSetpoint" }
        ],
        "configuration": {
          "supportsScheduling": false
        },
        "proactivelyReported": device.proactiveEvents,
        "retrievable": true
      }
    };
    let tModes = [];
    // https://developer.amazon.com/docs/device-apis/alexa-property-schemas.html#thermostat-mode-values
    // additionally: CUSTOM is possible
    if ( mappings.TargetHeatingCoolingState && mappings.TargetHeatingCoolingState.cmds ) {
      mappings.TargetHeatingCoolingState.cmds.map((s)=>{
        const m = s.match("^(AUTO|COOL|ECO|HEAT|OFF|CUSTOM):.*");
        if (m)
          tModes.push(m[1]);
      });
    }
    // ThermostatModes supported?
    if (tModes.length>0) {
      capability.properties.supported.push ({ "name": "thermostatMode" });
      capability.properties.configuration.supportedModes = tModes;
    }

    d.capabilities.push( capability );

    d.displayCategories.push ( 'THERMOSTAT' );
  }

  if( mappings.CurrentTemperature  ) {
    d.capabilities.push( {
                           "type": "AlexaInterface",
                           "interface": NAMESPACE_TemperatureSensor,
                           "version": "3",
                           "properties": {
                             "supported": [
                               { "name": "temperature" }
                             ],
                             "proactivelyReported": device.proactiveEvents,
                             "retrievable": true
                           }
                         }
                       );

    if( !d.displayCategories.length )
      d.displayCategories.push ( 'TEMPERATURE_SENSOR' );
  }

  if( mappings.LockTargetState
      || mappings.LockCurrentState  )
    d.capabilities.push( {
                           "type": "AlexaInterface",
                           "interface": NAMESPACE_LockController,
                           "version": "3",
                           "properties": {
                             "supported": [
                               { "name": "lockState" }
                             ],
                             "proactivelyReported": device.proactiveEvents,
                             "retrievable": true
                           }
                         }
                       );

  if( mappings.ChannelController ) {
    if( d.displayCategories.indexOf('TV') === -1 )
      d.displayCategories.push ( 'TV' );
    d.capabilities.push( {
                           "type": "AlexaInterface",
                           "interface": NAMESPACE_ChannelController,
                           "version": "3",
                           "properties": {
                             "supported": [
                               { "name": "channel" }
                             ],
                             "proactivelyReported": device.proactiveEvents,
                             "retrievable": true
                           }
                         }
                       );
  }

  if( mappings.InputController ) {
    if( d.displayCategories.indexOf('TV') === -1 )
      d.displayCategories.push ( 'TV' );
    let inputs = [];
    if( typeof mappings.InputController.value2homekit === 'object' )
      for( var input in mappings.InputController.value2homekit )
        inputs.push( {name : input} );
    d.capabilities.push( {
                           "type": "AlexaInterface",
                           "interface": NAMESPACE_InputController,
                           "version": "3",
                           "inputs": inputs
                         }
                       );
  }

  if( mappings.PlaybackController ) {
    if( d.displayCategories.indexOf('TV') === -1 )
      d.displayCategories.push ( 'TV' );
    let operations = [];
    if( typeof mappings.PlaybackController.value2homekit === 'object' )
      for( var operation in mappings.PlaybackController.value2homekit )
        operations.push( operation );
    d.capabilities.push( {
                           "type": "AlexaInterface",
                           "interface": NAMESPACE_PlaybackController,
                           "version": "3",
                           "properties": {},
                           "supportedOperations": operations
                         }
                       );
  }

  if( mappings[FHEM.CustomUUIDs.Volume] || mappings.Mute ) {
    d.displayCategories.push ( 'SPEAKER' );
    var capability = {
                       "type": "AlexaInterface",
                       "interface": NAMESPACE_Speaker,
                       "version": "3",
                       "properties": {
                         "supported": [
                         ],
                         "proactivelyReported": device.proactiveEvents,
                         "retrievable": true
                       }
                     };
    if( mappings.Mute ) capability.properties.supported.push( { "name": "mute" } );
    if( mappings[FHEM.CustomUUIDs.Volume] ) capability.properties.supported.push( { "name": "volume" } );
    d.capabilities.push( capability );
  }

  if( mappings.On ) {
    if( !d.displayCategories.length ) d.displayCategories.push ( 'SWITCH' );
    d.capabilities.push( {
                           "type": "AlexaInterface",
                           "interface": NAMESPACE_PowerController,
                           "version": "3",
                           "properties": {
                             "supported": [
                               { "name": "powerState" }
                             ],
                             "proactivelyReported": device.proactiveEvents,
                             "retrievable": true
                           }
                         }
                       );
  }

  return [d];
}

var handleDiscovery3 = function(event) {
  var response = null;

  var requestedName = event.directive.header.name;
  switch (requestedName) {
    case REQUEST_DISCOVER :
      var header = createHeader(NAMESPACE_DISCOVERY, RESPONSE_DISCOVER, event);

      var payload = {
        endpoints: []
      };

      for( var d in this.devices ) {
        let device = this.devices[d];

        if( !device.isInScope('alexa') && !device.isInScope('alexa-ha') ) {
          log.debug( 'ignoring '+ device.name +' for alxea ha skill' );
          continue;
        }

        if( accepted_token.oauthClientID ) {
          var room = this.roomOfIntent[accepted_token.oauthClientID];
          //if( room && room !== device.alexaRoom ) {
          if( room && !device.alexaRoom.match( '(^|,)('+room+')(,|\$)' ) ) {
            log.debug( 'ignoring '+ device.name +' in room '+ device.alexaRoom +' for echo in room '+ room );
          }
        }

        var endpoints = deviceToEndpoints(device);
        for( let endpoint of endpoints )
          if( endpoint.capabilities.length )
            payload.endpoints.push( endpoint );

      } // devices

      log.info( "found "+ payload.endpoints.length +" device(s)" );

      response = createDirective(header, payload);
      response = { "event": response };
      break;

    default:
      log.error("Unsupported operation" + requestedName);
      response = handleUnsupportedOperation();

      break;

  }// switch

  return response;

}// handleDiscovery3


var handlePowerController = function(event) {
  var device = this.devices[event.directive.endpoint.cookie.device.toLowerCase()];
  if( !device )
    return createError(ERROR3_NO_SUCH_ENDPOINT, undefined, event);

  var requestedName = event.directive.header.name;
  switch (requestedName) {
    case 'TurnOn':
      device.command( device.mappings.On, 1 );
      break;
    case 'TurnOff':
      device.command( device.mappings.On, 0 );
      break;
    default:
      return createError(ERROR3_INVALID_DIRECTIVE, undefined, event);
      break;
  }

  var header = createHeader("Alexa", "Response", event);
  var context = {
    "properties": [ {
      "namespace": NAMESPACE_PowerController,
      "name": "powerState",
      "value": (requestedName === 'TurnOn')?"ON":"OFF",
      "timeOfSample": new Date(Date.now()).toISOString(),
      "uncertaintyInMilliseconds": 500
    } ]
  };
  var endpoint = { "scope": event.directive.endpoint.scope, "endpointId": event.directive.endpoint.endpointId};

  return { "context": context, "event": { "header": header, "endpoint": endpoint , "payload": {} } };

}// handlePowerController

var handleBrightnessController = function(event) {
  var device = this.devices[event.directive.endpoint.cookie.device.toLowerCase()];
  if( !device )
    return createError(ERROR3_NO_SUCH_ENDPOINT, undefined, event);

  var mapping = device.mappings.Brightness;
  var current = parseInt(device.fhem.reading2homekit(mapping, device.fhem.cached(mapping.informId)));

  var target = event.directive.payload.brightness;

  var requestedName = event.directive.header.name;
  switch (requestedName) {
    case 'AdjustBrightness':
      target = current + event.directive.payload.brightnessDelta;
      break;
    case 'SetBrightness':
      target = event.directive.payload.brightness;
      break;
    default:
      return createError(ERROR3_INVALID_DIRECTIVE, undefined, event);
      break;
  }

  if( target !== undefined ) {
    if( mapping.minValue !== undefined && target < mapping.minValue )
      target = mapping.minValue
    else if( mapping.maxValue !== undefined && target > mapping.maxValue )
      target = mapping.maxValue
    else if( target < 0 )
      target = 0;
    else if( target > 100 )
      target = 100;

    device.command( mapping, target );
  }

  var header = createHeader("Alexa", "Response", event);
  var context = {
    "properties": [ {
      "namespace": NAMESPACE_BrightnessController,
      "name": "brightness",
      "value": target,
      "timeOfSample": new Date(Date.now()).toISOString(),
      "uncertaintyInMilliseconds": 500
    } ]
  };
  var endpoint = { "scope": event.directive.endpoint.scope, "endpointId": event.directive.endpoint.endpointId};

  return { "context": context, "event": { "header": header, "endpoint": endpoint , "payload": {} } };

}// handleBrightnessController

var handleColorController = function(event) {
  var device = this.devices[event.directive.endpoint.cookie.device.toLowerCase()];
  if( !device )
    return createError(ERROR3_NO_SUCH_ENDPOINT, undefined, event);

  var target_hue;
  var target_saturation;
  var target_brightness;

  var requestedName = event.directive.header.name;
  switch (requestedName) {
    case 'SetColor':
      target_hue = event.directive.payload.color.hue;
      target_saturation = parseInt( event.directive.payload.color.saturation * 100 );
      target_brightness = parseInt( event.directive.payload.color.brightness * 100 );
      break;
    default:
      return createError(ERROR3_INVALID_DIRECTIVE, undefined, event);
      break;
  }

  if( device.mappings.HSV ) {
    device.command( device.mappings.HSV, target_hue +' '+ target_saturation +' '+ target_brightness );

  } else if( device.mappings.RGB ) {
    device.command(device.mappings.RGB, FHEM.FHEM_hsv2rgb(target_hue/360.0, target_saturation/100.0, target_brightness/100.0));

  } else {
    if( device.mappings.Hue )
      device.command( device.mappings.Hue, target_hue );
    if( device.mappings.Saturation )
      device.command( device.mappings.Saturation, target_saturation );
    if( device.mappings.Brightness )
      device.command( device.mappings.Brightness, target_brightness );
  }

  var header = createHeader("Alexa", "Response", event);
  var context = {
    "properties": [ {
      "namespace": NAMESPACE_ColorController,
      "name": "color",
      "value": { "hue": target_hue,
                 "saturation": target_saturation / 100,
                 "brightness": target_brightness / 100 },
      "timeOfSample": new Date(Date.now()).toISOString(),
      "uncertaintyInMilliseconds": 500
    } ]
  };
  var endpoint = { "scope": event.directive.endpoint.scope, "endpointId": event.directive.endpoint.endpointId};

  return { "context": context, "event": { "header": header, "endpoint": endpoint , "payload": {} } };

}// handleColorController

var handleColorTemperatureController = function(event) {
  var device = this.devices[event.directive.endpoint.cookie.device.toLowerCase()];
  if( !device )
    return createError(ERROR3_NO_SUCH_ENDPOINT, undefined, event);

  var mapping;
  if( device.mappings.ColorTemperature )
    mapping = device.mappings.ColorTemperature;
  else if( device.mappings[FHEM.CustomUUIDs.ColorTemperature] )
    mapping = device.mappings[FHEM.CustomUUIDs.ColorTemperature];
  else if( device.mappings[FHEM.CustomUUIDs.CT] )
    mapping = device.mappings[FHEM.CustomUUIDs.CT];

  var current = parseInt(device.fhem.cached(mapping.informId));
  if( current < 1000 )
    current = 1000000 / current;

  var target;
  var requestedName = event.directive.header.name;
  switch (requestedName) {
    case 'DecreaseColorTemperature':
      target = current - 500;
      break;
    case 'IncreaseColorTemperature':
      target = current + 500;
      break;
    case 'SetColorTemperature':
      target = event.directive.payload.colorTemperatureInKelvin;
      break;
    default:
      return createError(ERROR3_INVALID_DIRECTIVE, undefined, event);
      break;
  }


  if( mapping.maxValue < 1000 )
    target = 1000000 / target;

  var min = mapping.minValue;
  var max = mapping.maxValue;

  if( min !== undefined && target < min )
    target = min;
  else if( max !== undefined && target > max )
    target = max;
  else if( 0 )
    return createError(ERROR3_VALUE_OUT_OF_RANGE, undefined, event);

  device.command( mapping, parseInt(target) );


  if( target < 1000 )
    target = 1000000 / target;

  var header = createHeader("Alexa", "Response", event);
  var context = {
    "properties": [ {
      "namespace": NAMESPACE_ColorTemperatureController,
      "name": "colorTemperatureInKelvin",
      "value": parseInt(target),
      "timeOfSample": new Date(Date.now()).toISOString(),
      "uncertaintyInMilliseconds": 500
    } ]
  };

  var endpoint = { "scope": event.directive.endpoint.scope, "endpointId": event.directive.endpoint.endpointId};

  return { "context": context, "event": { "header": header, "endpoint": endpoint , "payload": {} } };

}// handleColorTemperatureController

var handlePercentageController = function(event) {
  var device = this.devices[event.directive.endpoint.cookie.device.toLowerCase()];
  if( !device )
    return createError(ERROR3_NO_SUCH_ENDPOINT, undefined, event);

  var mapping;
  if( device.mappings.Brightness )
    mapping = device.mappings.Brightness;
  else if( device.mappings.TargetPosition )
    mapping = device.mappings.TargetPosition;
  else if( device.mappings[FHEM.CustomUUIDs.Volume] )
    mapping = device.mappings[FHEM.CustomUUIDs.Volume];
  else
    return createError(ERROR3_INVALID_DIRECTIVE, undefined, event);
  var current = parseInt( device.fhem.cached(mapping.informId) );

  var target;

  var requestedName = event.directive.header.name;
  switch (requestedName) {
    case 'AdjustPercentage':
      target = current + event.directive.payload.percentageDelta;
      break;
    case 'SetPercentage':
      target = event.directive.payload.percentage;
      break;
    default:
      return createError(ERROR3_INVALID_DIRECTIVE, undefined, event);
      break;
  }

  if( target !== undefined ) {
    if( target < 0 )
      target = 0;
    if( target > 100 )
      target = 100;
    if( mapping.minValue !== undefined && target < mapping.minValue )
      target = mapping.minValue
    else if( mapping.maxValue !== undefined && target > mapping.maxValue )
      target = mapping.maxValue

    device.command( mapping, target );
  }

  var header = createHeader("Alexa", "Response", event);
  var context = {
    "properties": [ {
      "namespace": NAMESPACE_PercentageController,
      "name": "percentage",
      "value": target,
      "timeOfSample": new Date(Date.now()).toISOString(),
      "uncertaintyInMilliseconds": 500
    } ]
  };
  var endpoint = { "scope": event.directive.endpoint.scope, "endpointId": event.directive.endpoint.endpointId};

  return { "context": context, "event": { "header": header, "endpoint": endpoint , "payload": {} } };

}// handlePercentageController

var handleRangeController = function(event) {
  var device = this.devices[event.directive.endpoint.cookie.device.toLowerCase()];
  if( !device )
    return createError(ERROR3_NO_SUCH_ENDPOINT, undefined, event);

  var mapping;
  if( device.mappings.TargetPosition )
    mapping = device.mappings.TargetPosition;
  else
    return createError(ERROR3_INVALID_DIRECTIVE, undefined, event);
  var current = parseInt( device.fhem.cached(mapping.informId) );

  var target;

  var requestedName = event.directive.header.name;
  switch (requestedName) {
    case 'AdjustRangeValue':
      target = current + event.directive.payload.rangeValueDelta;
      if( mapping.invert )
        target = 100 - target;
      break;
    case 'SetRangeValue':
      target = event.directive.payload.rangeValue;
      if( mapping.invert )
        target = 100 - target;
      break;
    default:
      return createError(ERROR3_INVALID_DIRECTIVE, undefined, event);
      break;
  }

  if( target !== undefined ) {
    if( target < 0 )
      target = 0;
    if( target > 100 )
      target = 100;
    if( mapping.minValue !== undefined && target < mapping.minValue )
      target = mapping.minValue
    else if( mapping.maxValue !== undefined && target > mapping.maxValue )
      target = mapping.maxValue

    device.command( mapping, target );
  }

  var header = createHeader("Alexa", "Response", event);
  var context = {
    "properties": [ {
      "namespace": NAMESPACE_RangeController,
      "instance": event.directive.header.instance,
      "name": "rangeValue",
      "value": target,
      "timeOfSample": new Date(Date.now()).toISOString(),
      "uncertaintyInMilliseconds": 500
    } ]
  };
  var endpoint = { "scope": event.directive.endpoint.scope, "endpointId": event.directive.endpoint.endpointId};

  return { "context": context, "event": { "header": header, "endpoint": endpoint , "payload": {} } };

}// handleRangeController

var handleModeController = function(event) {
  var device = this.devices[event.directive.endpoint.cookie.device.toLowerCase()];
  if( !device )
    return createError(ERROR3_NO_SUCH_ENDPOINT, undefined, event);

  var mapping;
  if( device.mappings.ModeController )
    mapping = device.mappings.ModeController;
  else
    return createError(ERROR3_INVALID_DIRECTIVE, undefined, event);
  var current = parseInt( device.fhem.cached(mapping.informId) );

  var target;

  var requestedName = event.directive.header.name;
  switch (requestedName) {
    case 'AdjustMode':
      if( !mapping.ordered )
        return createError(ERROR3_INVALID_DIRECTIVE, undefined, event);

      target = mapping.value2homekit.indexOf(current) + event.directive.payload.modeDelta;
      if( target >= mapping.value2homekit.length )
        target = 0;
      target = mapping.value2homekit[target].to;
      break;
    case 'SetMode':
      target = event.directive.payload.mode;
      break;
    default:
      return createError(ERROR3_INVALID_DIRECTIVE, undefined, event);
      break;
  }

  if( target !== undefined ) {
    target = target.replace( valueForMode(device, mapping, ''), '' );
    device.command( mapping, target );
  }

  var header = createHeader("Alexa", "Response", event);
  var context = {
    "properties": [ {
      "namespace": NAMESPACE_ModeController,
      "instance": event.directive.header.instance,
      "name": "mode",
      "value": target,
      "timeOfSample": new Date(Date.now()).toISOString(),
      "uncertaintyInMilliseconds": 500
    } ]
  };
  var endpoint = { "scope": event.directive.endpoint.scope, "endpointId": event.directive.endpoint.endpointId};

  return { "context": context, "event": { "header": header, "endpoint": endpoint , "payload": {} } };

}// handleModeController

var handleThermostatController = function(event) {
  var device = this.devices[event.directive.endpoint.cookie.device.toLowerCase()];
  if( !device )
    return createError(ERROR3_NO_SUCH_ENDPOINT, undefined, event);

  var mapping = device.mappings.TargetTemperature;
  var current = parseFloat( device.fhem.cached(mapping.informId) );

  var target;

  var isTemperature = true;
  var requestedName = event.directive.header.name;
  switch (requestedName) {
    case 'AdjustTargetTemperature':
      target = current + event.directive.payload.targetSetpointDelta.value;
      break;
    case 'SetTargetTemperature':
      target = event.directive.payload.targetSetpoint.value;
      break;
    case 'SetThermostatMode':
      target = event.directive.payload.thermostatMode.value;
      isTemperature = false;
      mapping = device.mappings.TargetHeatingCoolingState;
      if (mapping)
        break;

    default:
      return createError(ERROR3_INVALID_DIRECTIVE, undefined, event);
      break;
  }

  if( target !== undefined ) {
    if( isTemperature ) {
      if ( mapping.minValue !== undefined && target < mapping.minValue )
        target = mapping.minValue
      else if( mapping.maxValue !== undefined && target > mapping.maxValue )
        target = mapping.maxValue;
    }
    device.command( mapping, target );
  }

  var header = createHeader("Alexa", "Response", event);
  var context = {
    "properties": [ {
      "namespace": NAMESPACE_ThermostatController,
      "name": (isTemperature ? "targetSetpoint" : "thermostatMode"),
      "value": (isTemperature ? { "value": parseFloat(target), "scale": "CELSIUS" } : { "value": target } ),
      "timeOfSample": new Date(Date.now()).toISOString(),
      "uncertaintyInMilliseconds": 500
    } ]
  };
  var endpoint = { "scope": event.directive.endpoint.scope, "endpointId": event.directive.endpoint.endpointId};

  return { "context": context, "event": { "header": header, "endpoint": endpoint , "payload": {} } };

}// handleThermostatController

var handleLockController = function(event) {
  var device = this.devices[event.directive.endpoint.cookie.device.toLowerCase()];
  if( !device )
    return createError(ERROR3_NO_SUCH_ENDPOINT, undefined, event);

  if( !device.mappings.LockTargetState )
    return createError(ERROR3_INVALID_DIRECTIVE, undefined, event);

  var requestedName = event.directive.header.name;
  switch (requestedName) {
    case 'Lock':
      device.command( device.mappings.LockTargetState, 'SECURED' );
      break;
    case 'Unlock':
      device.command( device.mappings.LockTargetState, 'UNSECURED' );
      break;
    default:
      return createError(ERROR3_INVALID_DIRECTIVE, undefined, event);
      break;
  }

  var header = createHeader("Alexa", "Response", event);
  var context = {
    "properties": [ {
      "namespace": NAMESPACE_LockController,
      "name": "lockState",
      "value": (requestedName === 'Lock'?'LOCKED':'UNLOCKED'),
      "timeOfSample": new Date(Date.now()).toISOString(),
      "uncertaintyInMilliseconds": 500
    } ]
  };
  var endpoint = { "scope": event.directive.endpoint.scope, "endpointId": event.directive.endpoint.endpointId};

  return { "context": context, "event": { "header": header, "endpoint": endpoint , "payload": {} } };

}// handleLockController

var handleSpeaker = function(event) {
  var device = this.devices[event.directive.endpoint.cookie.device.toLowerCase()];
  if( !device )
    return createError(ERROR3_NO_SUCH_ENDPOINT, undefined, event);

  var mapping = device.mappings[FHEM.CustomUUIDs.Volume];

  var target;

  var requestedName = event.directive.header.name;
  switch (requestedName) {
    case 'AdjustVolume':
      var current = parseInt(device.fhem.reading2homekit(mapping, device.fhem.cached(mapping.informId)));
      target = current + event.directive.payload.volume;
      break;
    case 'SetVolume':
      target = event.directive.payload.volume;
      break;
    case 'SetMute':
      mapping = device.mappings.Mute;
      target = event.directive.payload.mute;
      break;
    default:
      return createError(ERROR3_INVALID_DIRECTIVE, undefined, event);
      break;
  }

  var name;
  switch (requestedName) {
    case 'AdjustVolume':
    case 'SetVolume':
      name = 'volume';
      if( target !== undefined ) {
        if( target < 0 )
          target = 0;
        if( target > 100 )
          target = 100;
        if( mapping.minValue !== undefined && target < mapping.minValue )
          target = mapping.minValue
        else if( mapping.maxValue !== undefined && target > mapping.maxValue )
          target = mapping.maxValue

        device.command( mapping, target );
      }
      break;
    case 'SetMute':
      name = 'muted';
      device.command( mapping, target?1:0 );
      break;
  }

  var header = createHeader("Alexa", "Response", event);
  var context = {
    "properties": [ {
      "namespace": NAMESPACE_Speaker,
      "name": name,
      "value": target,
      "timeOfSample": new Date(Date.now()).toISOString(),
      "uncertaintyInMilliseconds": 500
    } ]
  };
  var endpoint = { "scope": event.directive.endpoint.scope, "endpointId": event.directive.endpoint.endpointId};

  return { "context": context, "event": { "header": header, "endpoint": endpoint , "payload": {} } };

}// handleSpeaker

var handleScene = function(event) {
  var device = this.devices[event.directive.endpoint.cookie.device.toLowerCase()];
  if( event.directive.endpoint.cookie.scene ) {
    var parts = event.directive.endpoint.cookie.device.split(':');

    device = this.devices[parts[0].toLowerCase()];

    if( device )
      device.mappings.On.cmdOn = 'scene+'+ parts[1];
  }

  if( !device )
    return createError(ERROR3_NO_SUCH_ENDPOINT, undefined, event);

  var mapping = device.mappings.On;

  var header;
  var requestedName = event.directive.header.name;
  switch (requestedName) {
    case 'Activate':
      device.command( device.mappings.On, 1 );
      header = createHeader(NAMESPACE_SceneController, "ActivationStarted", event);
      break;
    case 'Deactivate':
      device.command( device.mappings.On, 0 );
      header = createHeader(NAMESPACE_SceneController, "DeactivationStarted", event);
      break;
    default:
      return createError(ERROR3_INVALID_DIRECTIVE, undefined, event);
      break;
  }

  var payload = { "cause" : { "type" : "VOICE_INTERACTION" },
                   "timestamp" : new Date(Date.now()).toISOString()
                };

  var endpoint = { "scope": event.directive.endpoint.scope, "endpointId": event.directive.endpoint.endpointId};

  return { "context": {}, "event": { "header": header, "endpoint": endpoint , "payload": payload } };
}// handleScene

var handleChannel = function(event) {
  var device = this.devices[event.directive.endpoint.cookie.device.toLowerCase()];
  if( !device )
    return createError(ERROR3_NO_SUCH_ENDPOINT, undefined, event);

  var mapping = device.mappings.ChannelController;
  var current = parseInt(device.fhem.reading2homekit(mapping, device.fhem.cached(mapping.informId)));
  if( isNaN(current) )
    current = 0;

  var target;
  var requestedName = event.directive.header.name;
  switch (requestedName) {
    case 'ChangeChannel':
      target = event.directive.payload.channel.number;
      if( event.directive.payload.channelMetadata && event.directive.payload.channelMetadata.name !== undefined )
        target = event.directive.payload.channelMetadata.name;
      device.command( mapping, target );
      break;
    case 'SkipChannels':
      target = current + event.directive.payload.channelCount;
      device.command( mapping, target );
      break;
    default:
      return createError(ERROR3_INVALID_DIRECTIVE, undefined, event);
      break;
  }

  var header = createHeader("Alexa", "Response", event);
  var context = {
    "properties": [ {
      "namespace": NAMESPACE_ChannelController,
      "name": "channel",
      "value": { number: target},
      "timeOfSample": new Date(Date.now()).toISOString(),
      "uncertaintyInMilliseconds": 500
    } ]
  };
  var endpoint = { "scope": event.directive.endpoint.scope, "endpointId": event.directive.endpoint.endpointId};

  return { "context": context, "event": { "header": header, "endpoint": endpoint , "payload": {} } };
}// handleChannel

var handleInput = function(event) {
  var device = this.devices[event.directive.endpoint.cookie.device.toLowerCase()];
  if( !device )
    return createError(ERROR3_NO_SUCH_ENDPOINT, undefined, event);

  var mapping = device.mappings.InputController;

  var target;
  var requestedName = event.directive.header.name;
  switch (requestedName) {
    case 'SelectInput':
      target = event.directive.payload.input;
      if( typeof mapping.value2homekit === 'object' && mapping.value2homekit[target] !== undefined)
        target = mapping.value2homekit[target];
      device.command( mapping, target );
      break;
    default:
      return createError(ERROR3_INVALID_DIRECTIVE, undefined, event);
      break;
  }

  var header = createHeader("Alexa", "Response", event);
  var context = {
    "properties": [ {
      "namespace": NAMESPACE_InputController,
      "name": "input",
      "value": target,
      "timeOfSample": new Date(Date.now()).toISOString(),
      "uncertaintyInMilliseconds": 500
    } ]
  };
  var endpoint = { "scope": event.directive.endpoint.scope, "endpointId": event.directive.endpoint.endpointId};

  return { "context": context, "event": { "header": header, "endpoint": endpoint , "payload": {} } };
}// handleIinput

var handlePlayback = function(event) {
  var device = this.devices[event.directive.endpoint.cookie.device.toLowerCase()];
  if( !device )
    return createError(ERROR3_NO_SUCH_ENDPOINT, undefined, event);

  var mapping = device.mappings.PlaybackController;
  device.command( mapping, event.directive.header.name );

  var header = createHeader("Alexa", "Response", event);
  var context = {
    "properties": []
  };
  var endpoint = { "scope": event.directive.endpoint.scope, "endpointId": event.directive.endpoint.endpointId};

  return { "context": context, "event": { "header": header, "endpoint": endpoint , "payload": {} } };
}// handlePlayback

var handleControlTurnOn = function(event) {

  var device = this.devices[event.payload.appliance.additionalApplianceDetails.device.toLowerCase()];
  if( !device )
    return createError(ERROR_UNSUPPORTED_TARGET);

  device.command( device.mappings.On, 1 );


  var header = createHeader(NAMESPACE_SmartHome_CONTROL,RESPONSE_TURN_ON);

  return createDirective(header, {});

}// handleControlTurnOn


var handleControlTurnOff = function(event) {

  var device = this.devices[event.payload.appliance.additionalApplianceDetails.device.toLowerCase()];
  if( !device )
    return handleUnsupportedOperation();

  device.command( device.mappings.On, 0 );


  var header = createHeader(NAMESPACE_SmartHome_CONTROL,RESPONSE_TURN_OFF);

  return createDirective(header, {});

}// handleControlTurnOff


var handleControlSetPercentage = function(event) {

  var device = this.devices[event.payload.appliance.additionalApplianceDetails.device.toLowerCase()];
  if( !device )
    return createError(ERROR_UNSUPPORTED_OPERATION);

  var mapping;
  if( device.mappings.Brightness )
    mapping = device.mappings.Brightness;
  else if( device.mappings.TargetPosition )
    mapping = device.mappings.TargetPosition;
  else if( device.mappings[FHEM.CustomUUIDs.Volume] )
    mapping = device.mappings[FHEM.CustomUUIDs.Volume];
  else
    return createError(ERROR_UNSUPPORTED_OPERATION);
  var current = parseFloat( device.fhem.cached(mapping.informId) );

  var target = event.payload.percentageState.value;
  if( mapping.minValue && target < mapping.minValue )
    target = mapping.minValue
  else if( mapping.maxValue && target > mapping.maxValue )
    target = mapping.maxValue

  device.command( mapping, target );


  var header = createHeader(NAMESPACE_SmartHome_CONTROL,RESPONSE_SET_PERCENTAGE);

  return createDirective(header, {});

}// handleControlSetPercentage


var handleControlIncrementPercentage = function(event) {

  var device = this.devices[event.payload.appliance.additionalApplianceDetails.device.toLowerCase()];
  if( !device )
    return createError(ERROR_UNSUPPORTED_OPERATION);

  var mapping;
  if( device.mappings.Brightness )
    mapping = device.mappings.Brightness;
  else if( device.mappings.TargetPosition )
    mapping = device.mappings.TargetPosition;
  else if( device.mappings[FHEM.CustomUUIDs.Volume] )
    mapping = device.mappings[FHEM.CustomUUIDs.Volume];
  else
    return createError(ERROR_UNSUPPORTED_OPERATION);
  var current = parseFloat( device.fhem.cached(mapping.informId) );

  var target = current + event.payload.deltaPercentage.value;
  if( target < 0 || target > 100 ) {
    if( device.mappings.TargetPosition ) {
      if( target < 0 )
        target = 0;
      else
        target = 100;
    } else
      return createError(ERROR_VALUE_OUT_OF_RANGE, {minimumValue: 0, maximumValue: 100});
  } else if( mapping.minValue && target < mapping.minValue )
    target = mapping.minValue
  else if( mapping.maxValue && target > mapping.maxValue )
    target = mapping.maxValue

  device.command( mapping, target );


  var header = createHeader(NAMESPACE_SmartHome_CONTROL,RESPONSE_INCREMENT_PERCENTAGE);

  return createDirective(header, {});

}// handleControlIncrementPercentage


var handleControlDecrementPercentage = function(event) {

  var device = this.devices[event.payload.appliance.additionalApplianceDetails.device.toLowerCase()];
  if( !device )
    return createError(ERROR_UNSUPPORTED_OPERATION);

  var mapping;
  if( device.mappings.Brightness )
    mapping = device.mappings.Brightness;
  else if( device.mappings.TargetPosition )
    mapping = device.mappings.TargetPosition;
  else if( device.mappings[FHEM.CustomUUIDs.Volume] )
    mapping = device.mappings[FHEM.CustomUUIDs.Volume];
  else
    return createError(ERROR_UNSUPPORTED_OPERATION);
  var current = parseFloat( device.fhem.cached(mapping.informId) );

  var target = current - event.payload.deltaPercentage.value;
  if( target < 0 || target > 100 ) {
    if( device.mappings.TargetPosition ) {
      if( target < 0 )
        target = 0;
      else
        target = 100;
    } else
      return createError(ERROR_VALUE_OUT_OF_RANGE, {minimumValue: 0, maximumValue: 100});
  } else if( mapping.minValue && target < mapping.minValue )
    target = mapping.minValue
  else if( mapping.maxValue && target > mapping.maxValue )
    target = mapping.maxValue

  device.command( mapping, target );


  var header = createHeader(NAMESPACE_SmartHome_CONTROL,RESPONSE_DECREMENT_PERCENTAGE);

  return createDirective(header, {});

}// handleControlDecrementPercentage


var handleControlSetTargetTemperature = function(event) {

  var device = this.devices[event.payload.appliance.additionalApplianceDetails.device.toLowerCase()];
  if( !device )
    return handleUnsupportedOperation();

  var current = parseFloat(device.fhem.cached(device.mappings.TargetTemperature.informId));
  var target = event.payload.targetTemperature.value;

  var min = device.mappings.TargetTemperature.minValue;
  if( min === undefined ) min = 15.0;
  var max = device.mappings.TargetTemperature.maxValue;
  if( max === undefined ) max = 30.0;

  if( target < min || target > max )
    return createError(ERROR_VALUE_OUT_OF_RANGE, {minimumValue: min, maximumValue: max});

  device.command( device.mappings.TargetTemperature, target );


  var header = createHeader(NAMESPACE_SmartHome_CONTROL,RESPONSE_SET_TARGET_TEMPERATURE);

  var payload = { targetTemperature: { value: target },
                  //temperatureMode: { value: 'AUTO' },
                  previousState: { targetTemperature: { value: current },
                                   //mode: { value: 'AUTO' },
                                 }
                };

  return createDirective(header, payload);

}// handleControlSetTargetTemperature


var handleControlIncrementTargetTemperature = function(event) {

  var device = this.devices[event.payload.appliance.additionalApplianceDetails.device.toLowerCase()];
  if( !device )
    return handleUnsupportedOperation();

  var current = parseFloat(device.fhem.cached(device.mappings.TargetTemperature.informId));
  var target = current + event.payload.deltaTemperature.value;

  var min = device.mappings.TargetTemperature.minValue;
  if( min === undefined ) min = 15.0;
  var max = device.mappings.TargetTemperature.maxValue;
  if( max === undefined ) max = 30.0;

  if( target < min || target > max )
    return createError(ERROR_VALUE_OUT_OF_RANGE, {minimumValue: min, maximumValue: max});

  device.command( device.mappings.TargetTemperature, target );


  var header = createHeader(NAMESPACE_SmartHome_CONTROL,RESPONSE_INCREMENT_TARGET_TEMPERATURE);

  var payload = { targetTemperature: { value: target },
                  //temperatureMode: { value: 'AUTO' },
                  previousState: { targetTemperature: { value: current },
                                   //mode: { value: 'AUTO' },
                                 }
                };

  return createDirective(header, payload);

}// handleControlIncrementTargetTemperature


var handleControlDecrementTargetTemperature = function(event) {

  var device = this.devices[event.payload.appliance.additionalApplianceDetails.device.toLowerCase()];
  if( !device )
    return handleUnsupportedOperation();

  var current = parseFloat(device.fhem.cached(device.mappings.TargetTemperature.informId));
  var target = current - event.payload.deltaTemperature.value;

  var min = device.mappings.TargetTemperature.minValue;
  if( min === undefined ) min = 15.0;
  var max = device.mappings.TargetTemperature.maxValue;
  if( max === undefined ) max = 30.0;

  if( target < min || target > max )
    return createError(ERROR_VALUE_OUT_OF_RANGE, {minimumValue: min, maximumValue: max});

  device.command( device.mappings.TargetTemperature, target );


  var header = createHeader(NAMESPACE_SmartHome_CONTROL,RESPONSE_DECREMENT_TARGET_TEMPERATURE);

  var payload = { targetTemperature: { value: target },
                  //temperatureMode: { value: 'AUTO' },
                  previousState: { targetTemperature: { value: current },
                                   //mode: { value: 'AUTO' },
                                 }
                };

  return createDirective(header, payload);

}// handleControlDecrementTargetTemperature


var handleControlSetColor = function(event) {

  var device = this.devices[event.payload.appliance.additionalApplianceDetails.device.toLowerCase()];
  if( !device )
    return handleUnsupportedOperation();

  var target_hue = event.payload.color.hue;
  var target_saturation = event.payload.color.saturation * 100;
  var target_brightness = event.payload.color.brightness * 100;

  if( device.mappings.Hue )
    device.command( device.mappings.Hue, target_hue );
  if( device.mappings.Saturation )
    device.command( device.mappings.Saturation, target_saturation );
  if( device.mappings.Brightness )
    device.command( device.mappings.Brightness, target_brightness );


  var header = createHeader(NAMESPACE_SmartHome_CONTROL,RESPONSE_SET_COLOR);

  var payload = { achievedState: { color: { hue: target_hue, saturation: target_saturation/100, brightness: target_brightness/100} } };

  return createDirective(header, payload);

}// handleControlSetColor

var handleControlSetColorTemperature = function(event) {
  var device = this.devices[event.payload.appliance.additionalApplianceDetails.device.toLowerCase()];
  if( !device )
    return handleUnsupportedOperation();

  var mapping;
  if( device.mappings.ColorTemperature )
    mapping = device.mappings.ColorTemperature;
  else if( device.mappings[FHEM.CustomUUIDs.ColorTemperature] )
    mapping = device.mappings[FHEM.CustomUUIDs.ColorTemperature];
  else if( device.mappings[FHEM.CustomUUIDs.CT] )
    mapping = device.mappings[FHEM.CustomUUIDs.CT];

  var target = event.payload.colorTemperature.value;

  if( mapping.maxValue < 1000 )
    target = 1000000 / target;

  var min = mapping.minValue;
  var max = mapping.maxValue;

  if( min !== undefined && target < min )
    target = min;
  else if( max !== undefined && target > max )
    target = max;
  else if( 0 )
    return createError(ERROR3_VALUE_OUT_OF_RANGE, undefined, event);

  device.command( mapping, parseInt(target) );


  if( target < 1000 )
    target = 1000000 / target;

  var header = createHeader(NAMESPACE_SmartHome_CONTROL,RESPONSE_SET_COLOR_TEMPERATURE);

  var payload = { achievedState: { colorTemperature: { value: parseInt(target) } } };

  return createDirective(header, payload);

}// handleControlSetColorTemperature


var handleControlIncrementColorTemperature = function(event) {
  var device = this.devices[event.payload.appliance.additionalApplianceDetails.device.toLowerCase()];
  if( !device )
    return handleUnsupportedOperation();

  var mapping;
  if( device.mappings.ColorTemperature )
    mapping = device.mappings.ColorTemperature;
  else if( device.mappings[FHEM.CustomUUIDs.ColorTemperature] )
    mapping = device.mappings[FHEM.CustomUUIDs.ColorTemperature];
  else if( device.mappings[FHEM.CustomUUIDs.CT] )
    mapping = device.mappings[FHEM.CustomUUIDs.CT];

  var current = parseInt(device.fhem.cached(mapping.informId));
  var target = current + 500;


  if( mapping.maxValue < 1000 )
    target = 1000000 / target;

  var min = mapping.minValue;
  var max = mapping.maxValue;

  if( min !== undefined && target < min )
    target = min;
  else if( max !== undefined && target > max )
    target = max;
  else if( 0 )
    return createError(ERROR3_VALUE_OUT_OF_RANGE, undefined, event);

  device.command( mapping, parseInt(target) );


  if( target < 1000 )
    target = 1000000 / target;

  var header = createHeader(NAMESPACE_SmartHome_CONTROL,RESPONSE_INCREMENT_COLOR_TEMPERATURE);

  var payload = { achievedState: { colorTemperature: { value: parseInt(target) } } };

  return createDirective(header, payload);

}// handleControlIncrementColorTemperature


var handleControlDecrementColorTemperature = function(event) {
  var device = this.devices[event.payload.appliance.additionalApplianceDetails.device.toLowerCase()];
  if( !device )
    return handleUnsupportedOperation();

  var mapping;
  if( device.mappings.ColorTemperature )
    mapping = device.mappings.ColorTemperature;
  else if( device.mappings[FHEM.CustomUUIDs.ColorTemperature] )
    mapping = device.mappings[FHEM.CustomUUIDs.ColorTemperature];
  else if( device.mappings[FHEM.CustomUUIDs.CT] )
    mapping = device.mappings[FHEM.CustomUUIDs.CT];

  var current = parseInt(device.fhem.cached(mapping.informId));
  var target = current - 500;


  if( mapping.maxValue < 1000 )
    target = 1000000 / target;

  var min = mapping.minValue;
  var max = mapping.maxValue;

  if( min !== undefined && target < min )
    target = min;
  else if( max !== undefined && target > max )
    target = max;
  else if( 0 )
    return createError(ERROR3_VALUE_OUT_OF_RANGE, undefined, event);

  device.command( mapping, parseInt(target) );


  if( target < 1000 )
    target = 1000000 / target;

  var header = createHeader(NAMESPACE_SmartHome_CONTROL,RESPONSE_DECREMENT_COLOR_TEMPERATURE);

  var payload = { achievedState: { colorTemperature: { value: parseInt(target) } } };

  return createDirective(header, payload);

}// handleControlDecrementColorTemperature


var handleControlSetLockState = function(event) {

  var device = this.devices[event.payload.appliance.additionalApplianceDetails.device.toLowerCase()];
  if( !device )
    return handleUnsupportedOperation();

  //var current = device.fhem.cached(device.mappings.LockCurrentState.informId);
  var target = event.payload.lockState.value;

  device.command( device.mappings.LockTargetState, 'SECURED' );


  var header = createHeader(NAMESPACE_SmartHome_CONTROL,CONFIRMATION_SET_LOCK_STATE);

  var payload = { lockState: { value: "LOCKED" } };

  return createDirective(header, payload);

}// handleControlSetLockState

var handleControlGetLockState = function(event) {

  var device = this.devices[event.payload.appliance.additionalApplianceDetails.device.toLowerCase()];
  if( !device )
    return handleUnsupportedOperation();

  var current = device.fhem.cached(device.mappings.LockCurrentState.informId);
  if( current === 'SECURED' || current === 'locked' )
    current = 'LOCKED';
  else
    current = 'UNLOCKED';

  var header = createHeader(NAMESPACE_SmartHome_QUERY,RESPONSE_GET_LOCK_STATE);

  var payload = { lockState: { value: current }, };

  return createDirective(header, payload);

}// handleControlGetLockState



var handleQueryGetTemperatureReading = function(event) {

  var device = this.devices[event.payload.appliance.additionalApplianceDetails.device.toLowerCase()];
  if( !device )
    return handleUnsupportedOperation();

  var current = parseFloat(device.fhem.cached(device.mappings.CurrentTemperature.informId));

  var header = createHeader(NAMESPACE_SmartHome_QUERY,RESPONSE_GET_TEMPERATURE_READING);

  var payload = { temperatureReading: { value: current }, };

  return createDirective(header, payload);

}// handleQueryGetTemperatureReading

var handleQueryGetTargetTemperature = function(event) {

  var device = this.devices[event.payload.appliance.additionalApplianceDetails.device.toLowerCase()];
  if( !device )
    return handleUnsupportedOperation();

  var target = parseFloat(device.fhem.cached(device.mappings.TargetTemperature.informId));

  var header = createHeader(NAMESPACE_SmartHome_QUERY,RESPONSE_GET_TARGET_TEMPERATURE);

  var payload = { targetTemperature: { value: target }, };

  return createDirective(header, payload);

}// handleQueryGetTargetTemperature

var handleUnsupportedOperation = function() {

  var header = createHeader(NAMESPACE_SmartHome_CONTROL,ERROR_UNSUPPORTED_OPERATION);

  return createDirective(header, {});

}// handleUnsupportedOperation


var handleUnexpectedInfo = function(fault) {

  var header = createHeader(NAMESPACE_SmartHome_CONTROL,ERROR3_UNEXPECTED_INFO);

  var payload = {
    faultingParameter: fault
  };

  return createDirective(header, payload);

}// handleUnexpectedInfo


// support functions

var createMessageId = function() {
  var d = new Date().getTime();
  var uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = (d + Math.random()*16)%16 | 0;
    d = Math.floor(d/16);
    return (c=='x' ? r : (r&0x3|0x8)).toString(16);
  });

  return uuid;

}// createMessageId


var createHeader = function(namespace, name, event) {
  var header = {
    namespace: namespace,
    name: name,
    payloadVersion: '2',
    messageId: createMessageId(),
  };

  if( event && event.directive && event.directive.header ) {
    header.payloadVersion = event.directive.header.payloadVersion;
    header.correlationToken = event.directive.header.correlationToken;
  }

  return header;
}// createHeader


var createDirective = function(header, payload, event_or_endpoint) {
  var directive =  {
    header: header,
    payload: payload
  };

  if( event_or_endpoint ) {
    if( event_or_endpoint.directive )
      directive.endpoint = event_or_endpoint.directive.endpoint;
    else
      directive.endpoint = event_or_endpoint;
  }

  return directive;
}// createDirective

var createError = function(error, payload, event) {
  var header;

  if( event && event.directive && event.directive.header && event.directive.header.payloadVersion == "3" ) {
    header = createHeader("Alexa", "ErrorResponse", event);
    if( typeof payload === 'string' ) {
      payload = { 'type': error, 'message': payload };
    } else if( payload === undefined || payload.type === undefined )
      payload = { 'type': error, 'message': 'unknown' };

  } else {
    header = createHeader(NAMESPACE_SmartHome_CONTROL, error);
    if( payload === undefined )
      payload = {};
  }

  return( createDirective( header, payload, event ) );
}// createError
