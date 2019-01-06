
'use strict';

const PORT=3000;

var natpmp = require('nat-pmp');
var natupnp = require('nat-upnp');

var path = require('path');
var fs = require('fs');

var version = require('./version');

var User = require('./user').User;

var log = require("./logger")._system;
var Logger = require('./logger').Logger;

var FHEM = require('./fhem').FHEM;

const util = require('util');

// For public skill: Readings for public skill token and SSH status:
const BEARERTOKEN_NAME = "alexaFHEM.bearerToken";
const SSHSTATUS_NAME = "alexaFHEM.ProxyConnection";

module.exports = {
  Server: Server
}

function Server() {
  this._config = this._loadConfig();

  if( Server.as_proxy )
    this._config.alexa = this._config['alexa-proxy'];

  if( this._config.alexa.port === undefined )
    this._config.alexa.port = PORT;
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
  log.info("using " + configPath );

  var config;
  // Complain and exit if it doesn't exist yet
  if (!fs.existsSync(configPath)) {
    config.alexa = {
      name: 'Alexa',
    };

    //return config;
      log.error("Couldn't find a config.json file at '"+configPath+"'. Look at config-sample.json for an example.");
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

  if( config.alexa.applicationId !== undefined && typeof config.alexa.applicationId !== 'object' )
    config.alexa.applicationId = [config.alexa.applicationId];

  if( config.alexa.applicationId !== undefined && typeof config.alexa.oauthClientID !== 'object' )
    config.alexa.oauthClientID = [config.alexa.oauthClientID];

  var username = config.alexa.username;

  log.info("_loadConfig: Config parsed completely.");

  return config;
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
        var event = JSON.parse(body);
        //console.log(event);
        verifyToken.bind(this)(event, function(ret, error) {
          if( error )
            log.error( 'ERROR: ' + error + ' from ' + request.connection.remoteAddress );

          console.log('response :'+ JSON.stringify(ret));
          response.end(JSON.stringify(ret)); });
      }

      if( 1 ) {
        try {
          processBody.bind(this)(response, body);

        } catch( e ) {
          log.error( 'ERROR: ' + util.inspect(e) + ' from ' + request.connection.remoteAddress );

          response.end(JSON.stringify(createError(ERROR_UNSUPPORTED_OPERATION)));

        }// try-catch

      } else {
        processBody.bind(this)(response, body);

      }
    }.bind(this));
  }


  if( this._config.alexa.ssl === false ) {
    this.server = require('http').createServer(processRequest.bind(this));
  } else {
    let options = {
      key: fs.readFileSync(this._config.alexa.keyFile || './key.pem'),
      cert: fs.readFileSync( this._config.alexa.certFile || './cert.pem'),
    };
    this.server = require('https').createServer(options,processRequest.bind(this));
  }

  this.server.on('error', (res) => {
    log.error ("Server emitted error: " + JSON.stringify(res));
    if (res.syscall === "listen") {
      log.info ("Terminating - starting the listener not possible (another instance running?)");
      process.exit(1);
    }
  });

  this.server.listen(this._config.alexa.port, this._config.alexa['bind-ip'], function(){
    log.info("Server listening on: http%s://%s:%s", this._config.alexa.ssl === false?'':'s',
                                                    this.server.address().address, this.server.address().port);

    if( Server.as_proxy ) {
      var io = require('socket.io');
      io = io.listen(this.server);
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

    //this.updateMessagingToken();
  }.bind(this) );
}

Server.prototype.connectToProxy = function() {
  log.info('trying to connect to proxy ');

  const io = require('socket.io-client');

  const socket = io('https://'+ this._config.alexa.proxy, {rejectUnauthorized: false});

  socket.on('event', function(msg,callback) {
    try {
      var event = JSON.parse(msg);
      //console.log(event);
      verifyToken.bind(this)(event, function(ret, error) {
        if( error )
          log.error( 'ERROR: ' + error + ' from proxy'  );

        console.log('response :'+ JSON.stringify(ret));
        callback(JSON.stringify(ret));
      });
    } catch( e ) {
      if( e )
        log.error( 'ERROR: ' + util.inspect(e) + ' from proxy' );

      callback(JSON.stringify(createError(ERROR_UNSUPPORTED_OPERATION)));

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

var pmp_client;
function open_pmp(ip) {
  if( ip ) {
    log.info('Trying NAT-PMP ...');
    pmp_client = natpmp.connect(ip);
    pmp_client.externalIp(function (err, info) {
      if (err) throw err;
      log.info('Current external IP address: %s', info.ip.join('.'));
    });

    setInterval( open_pmp, 3500*1000 );
  }

  pmp_client.portMapping({ private: PORT, public: PORT, ttl: 3600 }, function (err, info) {
    if (err) throw err;
    log.debug(info);
  });
}

var upnp_client;
function open_upnp() {
  if( !upnp_client ) {
    log.info('Trying NAT-UPNP ...');
    upnp_client = natupnp.createClient();
    upnp_client.externalIp(function(err, ip) {
      if (err) throw err;
      log.info('Current external IP address: %s', ip);
    });

    setInterval( open_upnp, 3500*1000 );
  }

  upnp_client.portMapping({
    public: PORT,
    private: PORT,
    ttl: 3600
  }, function(err) {
    if( err ) {
      log.error('NAT-UPNP failed: '+ err)
    }
  });
}

var ssh_client;
Server.prototype.open_ssh = function() {
  if (!ssh_client) {
    const alexaConfig = this._config.alexa;
    const exec = require('child_process').spawn;
    ssh_client = exec( alexaConfig.ssh,
      ['-R', '1234:' + alexaConfig['bind-ip']+ ':' + alexaConfig.port, '-oServerAliveInterval=90', '-p', '58824', 'fhem-va.fhem.de']);
    //     { stdio: 'pipe' });
    ssh_client.stdout.on('data', (data) => {
      if (data.toString().indexOf('Welcome at the reverse proxy')>=0)
        this.setreading(SSHSTATUS_NAME, "SSH connected");
      else
        this.setreading(SSHSTATUS_NAME, "SSH connection got: " + data.toString());

      log.info('SSH: ' + data);
    });
    ssh_client.stderr.on('data', (data) => {
      log.warn('SSH: ' + data);
      // Ignore Pseudo-terminal will not be allocated because stdin is not a terminal.
      if (data.toString().toLowerCase().indexOf('pseudo-terminal')<0)
      this.setreading(SSHSTATUS_NAME, "SSH connection got: " + data.toString());
    });
    ssh_client.on('close', (code) => {
      // Wait some time (15-135 seconds) not to overload the server...
      const delay = 15000 + Math.random()*120000;
      const date = new Date(new Date().getTime()+delay);
      let d = [ date.getHours(), date.getMinutes(), date.getSeconds()];
      d.map(d => { return d<10 ? "0" + d.toString() : d.toString()});
      log.error('SSH: exited with ' + code + ' - will restart in ' + delay/1000 + ' seconds');
      ssh_client = undefined;
      this.setreading(SSHSTATUS_NAME, "SSH connection terminated, will restart at " + d.join(':'));
      setTimeout(()=>{ open_ssh(alexaConfig) }, delay);
    });
    process.on('exit', (code) => {
      log.info('Killing SSH on event process.exit');
      ssh_client.kill()
    });
  }
}

Server.prototype.addDevice = function(device, fhem) {
  if( !device.isInScope('alexa.*') ) {
    log.info( 'ignoring '+ device.name +' for alexa' );
    return;
  }

  device.alexaName = device.alexaName.toLowerCase().replace( /\+/g, ' ' );
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
  for( let fhem of this.connections ) {
    if( !fhem.alexa_device ) continue;
    log.info ("Found alexa");
    fhem.execute( 'setreading '+ fhem.alexa_device.Name +' '+ reading +' '+ value );
  }
}

Server.prototype.run = function() {
  log.info( 'this is alexa-fhem '+ version +(Server.as_proxy?'; as proxy':'') +(Server.use_proxy?'; use proxy':'') );

  if( !this._config.connections ) {
    log.error( 'no connections in config file' );
    process.exit( -1 );
  }

  if( this._config.alexa['nat-pmp'] )
    open_pmp(this._config.alexa['nat-pmp']);

  if( this._config.alexa['nat-upnp'] )
    open_upnp();

  if( Server.use_proxy )
    this.connectToProxy();

  var startupPromise;
  if ( this._config.alexa['publicSkill'] ) {
    startupPromise = User.autoConfig(false, this._config);
    startupPromise.then ( () => {
      log.info("SSH proxy configuration set up done");
      this.open_ssh(this._config.alexa);
    }).catch((e) => {
      this.setreading(SSHSTATUS_NAME, e);
      log.error('Unable to setup SSH proxy configuration');
    });
  }

  if (!Server.use_proxy || Server.as_proxy)
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

  if( !Server.as_proxy )
  log.info('Fetching FHEM devices...');

  this.devices = {};
  this.roomOfEcho = {};
  this.connections = [];
  this.namesOfRoom = {};
  this.roomsOfName = {};

  const startupCmds = this._config.alexa.publicSkill ?
    [ { cmd: "jsonlist2 TYPE=alexa", callback: setAcceptedToken } ] : undefined;

    if( !Server.as_proxy )
  for( let connection of this._config.connections ) {
    var fhem = new FHEM(Logger.withPrefix(connection.name), connection, startupCmds);
    //fhem.on( 'DEFINED', function() {log.error( 'DEFINED' )}.bind(this) );

    fhem.on( 'customSlotTypes', function(fhem, cl) {
      var ret = '';
      ret += 'Custom Slot Types:';
      ret += '\n  FHEM_Device';

      var seen = {};
      for( let d in this.devices ) {
        let device = this.devices[d];
        for( let name of device.alexaNames.split(',') ) {
          if( seen[name] )
            continue;
          seen[name] = 1;
          ret +=  '\n';
          ret +=  '    ' + name;
        }
      }
      for( let c of this.connections ) {
        if( !c.alexaTypes ) continue;
        for( let type in c.alexaTypes ) {
          for( let name of c.alexaTypes[type] ) {
            if( !seen[name] )
              ret +='\n    '+ name;
              seen[name] = 1;
          }
        }
      }

      if( !seen['lampe'] )
        ret +='\n    lampe';
      if( !seen['licht'] )
        ret +='\n    licht';
      if( !seen['lampen'] )
        ret +='\n    lampen';
      if( !seen['rolläden'] )
        ret +='\n    rolläden';
      if( !seen['jalousien'] )
        ret +='\n    jalousien';
      if( !seen['rollos'] )
        ret +='\n    rollos';

      ret += '\n  FHEM_Room';
      for( let room in this.namesOfRoom ) {
        ret +=  '\n';
        ret += '    ' + room;
      }

      log.error( ret );
      if( cl ) {
        fhem.execute( '{asyncOutput($defs{"'+cl+'"}, "'+ ret +'")}' );
      }
    }.bind(this, fhem) );

    fhem.on( 'RELOAD', function(fhem, n) {
      if( n )
        log.info( 'reloading '+ n +' from '+ fhem.connection.base_url );
      else
        log.info( 'reloading '+ fhem.connection.base_url );

      for( let d in this.devices ) {
        var device = this.devices[d];
        if( !device ) continue;
        if( n && device.name !== n ) continue;
        if( device.fhem.connection.base_url !== fhem.connection.base_url ) continue;

        log.info( 'removing '+ device.name  +' from '+  device.fhem.connection.base_url );

        fhem = device.fhem;

        device.unsubscribe();

        delete this.devices[device.name];
      }

      if( n ) {
        fhem.connect( function(fhem, devices) {
          for( let device of devices ) {
            this.addDevice(device, fhem);
          }
        }.bind(this, fhem), 'NAME='+n );
      } else {
        for( let fhem of this.connections ) {
          fhem.connect( function(fhem,devices) {
            for( let device of devices ) {
              this.addDevice(device, fhem);
            }
          }.bind(this, fhem) );
       }
     }

    }.bind(this, fhem) );

    fhem.on( 'ALEXA DEVICE', function(fhem, n) {
      if( fhem.alexa_device ) {
        function lcfirst(str) {
          str += '';
          return str.charAt(0).toLowerCase() + str.substr(1);
        }
        function append(a,b,v) {
          if( a[b] === undefined )
            a[b] = {};
          a[b][v] = true;
        }

        fhem.perfectOfVerb = { 'stelle': 'gestellt', 'schalte': 'geschaltet', 'färbe': 'gefärbt', 'mach': 'gemacht' };
        fhem.verbsOfIntent = [];
        fhem.intentsOfVerb = {}
        fhem.valuesOfIntent = {}
        fhem.intentsOfCharacteristic = {}
        fhem.characteristicsOfIntent = {}
        fhem.prefixOfIntent = {}
        fhem.suffixOfIntent = {}
        for( let characteristic in fhem.alexaMapping ) {
          var mappings = fhem.alexaMapping[characteristic];
          if( !Array.isArray(mappings) )
             mappings = [mappings];

          var i = 0;
          for( let mapping of mappings ) {
            if( !mapping.verb ) continue;
            var intent = characteristic;
            if( mapping.valueSuffix ) intent = lcfirst( mapping.valueSuffix );
            intent += 'Intent';
            if( !mapping.valueSuffix )
              intent += i?String.fromCharCode(65+i):'';

            if( mapping.articles ) mapping.articles = mapping.articles.split(';');

            if( mapping.perfect )
              fhem.perfectOfVerb[mapping.verb] = mapping.perfect;
            //append(fhem.verbsOfIntent, intent, mapping.verb );
            if( fhem.verbsOfIntent[intent] === undefined ) {
              fhem.verbsOfIntent[intent] = [mapping.verb];
            } else if( fhem.verbsOfIntent[intent].indexOf(mapping.verb) == -1 ) {
              fhem.verbsOfIntent[intent].push( mapping.verb );
            }
            append(fhem.intentsOfVerb, mapping.verb, intent );
            //append(fhem.valuesOfIntent, intent, join( ',', @{$values} ) );
            append(fhem.intentsOfCharacteristic, characteristic, intent );
            //append(fhem.characteristicsOfIntent, intent, characteristic );
            if( fhem.characteristicsOfIntent[intent] === undefined ) {
              fhem.characteristicsOfIntent[intent] = [characteristic];
            } else if( fhem.characteristicsOfIntent[intent].indexOf(characteristic) == -1 ) {
              fhem.characteristicsOfIntent[intent].push( characteristic );
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

      if( fhem.alexaTypes ) {
        var types = {};
        for( let type of fhem.alexaTypes.split(/ |\n/) ) {
          if( !type )
            continue;
          if( type.match(/^#/) )
            continue;

          var match = type.match(/(^.*?)(:|=)(.*)/);
          if( !match || match.length < 4 || !match[3] ) {
            log.error( '  wrong syntax: ' + type );
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

      if( fhem.echoRooms ) {
        var echos = {};
        for( let line of fhem.echoRooms.split(/ |\n/) ) {
          if( !line )
            continue;
          if( line.match(/^#/) )
            continue;

          var match = line.match(/(^.*?)(:|=)(.*)/);
          if( !match || match.length < 4 || !match[3] ) {
            log.error( '  wrong syntax: ' + line );
            continue;
          }
          var echoId = match[1];
          var room = match[3];

          this.roomOfEcho[echoId] = room.toLowerCase();
        }
log.debug('roomOfEcho:');
log.debug(this.roomOfEcho);
      }

      if( fhem.fhemIntents ) {
        var intents = {}
        for( let intent of fhem.fhemIntents.split(/\n/) ) {
          if( !intent )
            continue;
          if( intent.match(/^#/) )
            continue;

          var match = intent.match(/(^.*?)(:|=)(.*)/);
          if( !match || match.length < 4 || !match[3] ) {
            this.log.error( '  wrong syntax: ' + intent );
            continue;
          }

          var name = match[1];
          var params = match[3];

          var intent_name = 'FHEM'+ name +'Intent';
          if( match = name.match( /^(set|get|attr)\s/ ) ) {
            intent_name = 'FHEM'+ match[1] +'Intent';
            var i = 1;
            while( intents[intent_name] !== undefined ) {
              intent_name = 'FHEM'+ match[1] +'Intent'+ String.fromCharCode(65+i);
              ++i;
            }
          } else if( name.match( /^{.*}$/ ) ) {
            intent_name = 'FHEMperlCodeIntent';
            var i = 1;
            while( intents[intent_name] !== undefined ) {
              if( i < 26 )
                intent_name = 'FHEMperlCodeIntent'+ String.fromCharCode(65+i);
              else
                intent_name = 'FHEMperlCodeIntent'+ String.fromCharCode(64+i/26)+String.fromCharCode(65+i%26);
              ++i;
            }
          }
          intent_name = intent_name.replace(/ /g,'');

          intents[intent_name] = name;

        }
        fhem.fhemIntents = intents;
log.debug('fhemIntents:');
log.debug(fhem.fhemIntents);
      }

      if( fhem.alexaConfirmationLevel === undefined )
        fhem.alexaConfirmationLevel = 2;

      if( fhem.alexaStatusLevel === undefined )
        fhem.alexaStatusLevel = 2;

      fhem.execute( 'list ' + fhem.alexa_device.Name + ' .eventToken', function(fhem, result) {
        var match;
        if( match = result.match( /\{.*\}$/ ) ) {
          try {
            fhem.eventToken = JSON.parse(match[0]);
            fhem.log.info( "got .eventToken" );

            //eventToken = fhem.eventToken;
            //this.updateEventToken(fhem);

          } catch (e) {
            fhem.log.error( "failed to parse .eventToken: " + util.inspect(e));
          }
        }
      }.bind(this, fhem) );
    }.bind(this, fhem) );

    fhem.on( 'LONGPOLL STARTED', function(f) {
      for( let fhem of this.connections ) {
        if( f.connection.base_url !== fhem.connection.base_url ) continue;

        fhem.connect( function(fhem, devices) {
          for( let device of devices ) {
            this.addDevice(device, fhem);
          }
        }.bind(this, fhem) )
      }
    }.bind(this, fhem) );

    this.connections.push( fhem );
  }
}

Server.prototype.shutdown = function() {
  if( pmp_client ) {
    log.info('Stopping NAT-PMP ...');
    pmp_client.portUnmapping({ public: PORT, private: PORT }, function (err, info) {
    if (err) throw err;
    log.debug('Port Unmapping:', info);
    pmp_client.close();
    });
  }

  if( upnp_client ) {
    log.info('Stopping NAT-UPNP ...');
    upnp_client.portUnmapping({
      public: PORT
    });
  }

  if ( ssh_client ) {
    log.info('Stopping SSH ...');
    ssh_client.kill();
  }
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

const NAMESPACE_TemperatureSensor = "Alexa.TemperatureSensor";

const NAMESPACE_Authorization = "Alexa.Authorization";

const NAMESPACE_ALEXA = "Alexa";

// discovery
const REQUEST_DISCOVER_APPLIANCES = "DiscoverAppliancesRequest";
const RESPONSE_DISCOVER_APPLIANCES = "DiscoverAppliancesResponse";

const REQUEST_DISCOVER = "Discover";
const RESPONSE_DISCOVER = "Discover.Response";

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


var messaging_token = {'expires': 0};
Server.prototype.updateMessagingToken = function(callback) {
  if( Date.now() < messaging_token.expires_in ) {
    if( callback ) callback();

  } else if( messaging_token.refresh_token ) {

  } else {
    if( !this._config.alexa.permissions ) {
      log.error('no permissions in config.json');
      return;
    }
    var permissions = this._config.alexa.permissions[Object.keys(this._config.alexa.permissions)[0]];

    log.info( 'requesting messaging token' );
    require('request').post('https://api.amazon.com/auth/O2/token',
                            { form :{ 'grant_type': 'client_credentials',
                                      'scope': 'alexa:skill_messaging',
                                      'client_id': permissions.client_id,
                                      'client_secret': permissions.client_secret } },
                            function(err, httpResponse, body) {
                              if( err ) {
                                log.error( 'failed to get messaging token: '+ err);
                                return;
                              }

                              const contentType = httpResponse.headers['content-type'];
                              if( contentType && contentType.match('application/json') ) {
                                var json = JSON.parse(body);
                                if( json.error ) {
                                  log.error( 'failed to get messaging token: '+ json.error +': \''+ json.error_description +'\'');
                                  return;
                                }

                                log.info( 'got messaging token' );
                                messaging_token = json;
                                messaging_token.expires_in += Date.now();

                                if( callback ) callback();

//this.postMessage.bind(this)();
this.postNotification.bind(this)();

                              } else {
                                log.error( 'failed to get messaging token: '+ body);
                                return;
                              }

                            }.bind(this) );
  }
}
Server.prototype.postMessage = function(message) {
    log.info( 'posting skill message' );
    var user_id = 'amzn1.account.AEVM7T2GT3PN5W3DGSV3RTVDLJWQ';
    //var request = require('request');
    //require('request-debug')(request);
    //request.post('https://api.eu.amazonalexa.com/v1/skillmessages/users/'+user_id,
    require('request').post('https://api.eu.amazonalexa.com/v1/skillmessages/users/'+user_id,
                            { headers :{ 'Content-Type': 'application/json',
                                         'Authorization': 'Bearer '+ messaging_token.access_token },
                                 body: '{"data":{ "sampleMessage": "Sample Message"}, "expiresAfterSeconds": 60 }' },
                            function(err, httpResponse, body) {
                              if( err ) {
                                log.error( 'failed to post message: '+ err);
                                return;
                              }

                              log.info( 'posted skill message: ' + body );
                            } );
}

var notification_token = {"access_token":"Atza|IwEBILLAwpprBr0xWyCJAoPCtzj64XuBbtn4Lu-BKP98XoiZn0oCqAweGIG9IDHY9jLKdm4ipF5fp5nksL4TY_ivSqO5dG84ZeUyGKcSNWSVe1sw-5MWNPJpIjOUMttaxzMA48YRzXrYDnqsgHFkOruDC4eUyj_g8G3VFWMM3oW2OAqc3nEPvfBbwcBqWTXPGZvh2z6rWX8nyBxmG8Rgh44BOioUg-2izjV2NjMXm5RFzI9QOR9VjI7VeggayQAWIwSr3tDx0bsyAtX5LviwU7KU-WSbQ50xadUH78eVKdSUItJjlae0JAb1UdiRsTHu43uPtAhB4fVbd4kTgtW89fsqs8NQ","refresh_token":"Atzr|IwEBIM3Lywawgi8WMjyjeak4HQj_uU9SszPFzBS5qXUX_d1PhQqAQfigUNFuqsxwyKjGO03b_I2vi-4i3BCk574X87oiO-Rx-1yJUB10TCGSHnuANw4asQDSDZU-eQykGC-YASnb28TlDOFT2S6zP4ro7neG7gWXRpv-9QviXxZM9iodFi7ljGWVhYwQqGbD_rEvbBRWzxYyMLqsoFJsNFWoyhPMajdiSQq6CioJd0yTB6-C0tGy8iQHRPJOKrGZbi__iGTsN9-l4ClwU27eJYFNNPnJWmxLOoaY_rpLPqtDMDPn_o0_bx_ftoOHm8Pd4QswckppdhVw2IN1GfoFJhkHZAAa","token_type":"bearer","expires_in":900};
var fresh_token = {};
Server.prototype.postNotification = function(message) {
  if( fresh_token.access_token === undefined ) {
    this.refreshToken(notification_token, function(token) { fresh_token = token; this.postNotification() }.bind(this) );
    return;
  }
    log.info( 'posting notification' );
    var id = createMessageId();
log.error(id);
    //var request = require('request');
    //require('request-debug')(request);
    //request.post('https://api.eu.amazonalexa.com/v2/notifications',
    require('request').post('https://api.eu.amazonalexa.com/v2/notifications',
                            { headers :{ 'Content-Type': 'application/json',
                                         'Authorization': 'Bearer '+ fresh_token.access_token },
                                 body: '{ "displayInfo": { "content": [ { "locale": "de-DE", "toast": { "text": "You have reached your daily goal" }, "title": "You have reached your daily goal of 10K steps", "bodyItems": [ { "primaryText": "You finished 12345 steps today" } ] } ] }, "referenceId": "'+ id +'", "expiryTime": "2018-01-23T23:99:99.672Z", "spokenInfo": { "content": [ { "locale": "de-DE", "text": "You met your daily goal. Total steps that you took today are 12345.", "ssml": "<speak>You met your daily goal. Total steps that you took today are 12345.</speak> " } ] } }' },
                            function(err, httpResponse, body) {
                              if( err ) {
                                log.error( 'failed to post notification: '+ err);
                                return;
                              }

                              log.info( 'posted notification: ' + body );
                            } );
}

Server.prototype.refreshToken = function(token, callback) {
  if( !this._config.alexa.permissions ) {
    log.error('no permissions in config.json');
    return;
  }
  var permissions = this._config.alexa.permissions[Object.keys(this._config.alexa.permissions)[0]];

  log.info( 'refreshing token' );
  //var request = require('request');
  //require('request-debug')(request);
  //request.post('https://api.amazon.com/auth/O2/token',
  require('request').post('https://api.amazon.com/auth/O2/token',
                          { form :{ 'grant_type': 'refresh_token',
                                    'refresh_token': token.refresh_token,
                                    'client_id': permissions.client_id,
                                    'client_secret': permissions.client_secret } },
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
                              json.expires_in += Date.now();
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
Server.prototype.updateEventToken = function(grant) {
  if( Date.now() < event_token.expires_in ) {
    if( callback ) callback();

  } else if( event_token.refresh_token ) {
    this.refreshToken(event_token, callback);

  } else {
    if( !grant ) {
      log.error('no grant for event token update');
      return;
    }
    if( !this._config.alexa.permissions ) {
      log.error('no permissions in config.json');
      return;
    }
    var permissions = this._config.alexa.permissions[Object.keys(this._config.alexa.permissions)[0]];

    log.info( 'requesting event token' );
    //log.error( grant );
    //var request = require('request');
    //require('request-debug')(request);
    //request.post('https://api.amazon.com/auth/O2/token',
    require('request').post('https://api.amazon.com/auth/O2/token',
                            { form :{ 'grant_type': 'authorization_code',
                                      'code': grant.grant.code,
                                      'client_id': permissions.client_id,
                                      'client_secret': permissions.client_secret } },
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
                                event_token.expires_in += Date.now();

                                //if( callback ) callback();

                              } else {
                                log.error( 'failed to get event token: '+ body);
                                return;
                              }

                            }.bind(this) );
  }
}

// Token by classic developer skill mode (created by Amazon:)
var accepted_token = {'token': undefined, 'oauthClientID': undefined, 'expires': 0};
// Token in public skill mode, created by ourself and stored in FHEM (bearerToken):
const published_tokens = [];

// Called from cmd=jsonlist2 TYPE=alexa
const setAcceptedToken = function (result) {
  log.debug('Callback from reading: ' + result);
  const fhemalexa = JSON.parse(result);
  if (fhemalexa.totalResultsReturned<1) {
    log.error('No Alexa device defined - this will not work with publicSkill mode');
    return;
  }
  const readings = fhemalexa.Results[0].Readings;
  let token;
  if (! readings.hasOwnProperty(BEARERTOKEN_NAME)) {
    log.warn('No reading "' + BEARERTOKEN_NAME + '" found in "' + fhemalexa.Results[0].Name +
        '" - incoming Cloud requests cannot be validated.');
    return;
  } else {
    token = readings[BEARERTOKEN_NAME].Value;
    log.info("BearerToken '" + readings[BEARERTOKEN_NAME].Value + "' read from " + fhemalexa.Results[0].Name);
  }
  published_tokens.push(token);
};


var verifyToken = function(event, callback) {
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

  // Token w/o routing ID in case of public skill
  let ptoken = undefined;
  if (token && token.lastIndexOf('-')>=0)
    ptoken = token.substring(token.lastIndexOf('-')+1);


  if( event.directive && event.directive.header && event.directive.header.namespace === NAMESPACE_Authorization && event.directive.header.name === "AcceptGrant" ) {
    handler.bind(this)( event, callback );

    // Trust the token either:
    // 1) If we validated it via Amazon OAuth (classic approach)
    // 2) This token is in the array of bearerToken(s) we read from FHEM (instances) - public skill mode.
    // TODO: Shall we also check for remoteAddr=127.0.0.1 in UC 3?
  } else if(
    (token === accepted_token.token && Date.now() < accepted_token.expires) ||
     (ptoken && published_tokens.indexOf(ptoken)>=0 && this._config.alexa.publicSkill)) {
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
    this.setreading( 'consentToken', consentToken );

    var echoId = 'unknown';
    if( event.context && event.context.System && event.context.System.device && event.context.System.device.deviceId )
      echoId = event.context.System.device.deviceId;

    var echoRoom = 'unknown';
    if( this.roomOfEcho[echoId] )
      echoRoom = this.roomOfEcho[echoId];

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
      this.setreading( 'echoId', echoId );
      this.setreading( 'echoRoom', echoRoom );

    } else if( event.request.type === 'SessionEndedRequest' ) {
      in_session = false;
      response.response.outputSpeech.text = 'Bye';

      this.setreading( 'intent', event.request.type );
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

          var applicationId = '';
          if( this._config.alexa.applicationId.length > 1 && event.session.application && event.session.application.applicationId ) {
            applicationId = event.session.application.applicationId;
            //applicationId = this._config.alexa.applicationId.indexOf(event.session.application.applicationId);
            //if( applicationId < 0 ) applicationId = '';
          }

          if( name.match(/^(set|get|attr)\s/) ) {
            if( applicationId !== '' ) applicationId = ' :' +applicationId;
            //fhem.execute( 'setreading '+ fhem.alexa_device.Name +' fhemIntent '+ intent_name + applicationId );
            fhem.execute( 'setreading '+ fhem.alexa_device.Name +' fhemIntent '+ intent_name + applicationId + ';setreading '+ fhem.alexa_device.Name +' echoId '+ echoId + ';setreading '+ fhem.alexa_device.Name +' echoRoom '+ echoRoom +';'+ name, function(result) {
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

            fhem.execute( 'setreading '+ fhem.alexa_device.Name +' fhemIntent '+ intent_name + applicationId + ';setreading '+ fhem.alexa_device.Name +' echoId '+ echoId + ';setreading '+ fhem.alexa_device.Name +' echoRoom '+ echoRoom +';'+ name, function(result) {
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
            fhem.execute( 'setreading '+ fhem.alexa_device.Name +' echoId '+ echoId + ';setreading '+ fhem.alexa_device.Name +' echoRoom '+ echoRoom + ';' + 'setreading '+ fhem.alexa_device.Name +' fhemIntent '+ name + applicationId );
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

      if( event.request.intent.name === 'AMAZON.StopIntent' ) {
        in_session = false;
        response.response.outputSpeech.text = 'Bis bald.';

        this.setreading( 'intent', event.request.intent.name );
        this.setreading( 'echoId', echoId );
        this.setreading( 'echoRoom', echoRoom );

      } else if( event.request.intent.name === 'AMAZON.CancelIntent' ) {
        delete sessions[session].command;
        response.response.outputSpeech.text = 'OK.';

        this.setreading( 'intent', event.request.intent.name );
        this.setreading( 'echoId', echoId );
        this.setreading( 'echoRoom', echoRoom );

      } else if( event.request.intent.name === 'AMAZON.HelpIntent' ) {
        response.response.outputSpeech.text = 'HILFE';

      } else if( intent_name === 'StatusIntent' ) {
        response.response.outputSpeech.text = '';
        function status(device, room) {
          var state = '';
          //for( let characteristic_type in device.mappings ) {
          //  if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
          //  state += 'hat den status '+ device.fhem.cached(device.mappings[characteristic_type].informId);
          //}

          if( device.mappings.On ) {
            //var current = device.fhem.reading2homekit(device.mappings.On, device.query(device.mappings.On));
            var current = device.fhem.reading2homekit(device.mappings.On, device.fhem.cached(device.mappings.On.informId));
            if( current === 'off' )
              current = false;
            else if( !isNaN(current) )
              current = parseInt(current);
            state = 'ist '+ (current?'an':'aus');
          }
          if( device.mappings.CurrentTemperature ) {
            if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
            state += ' misst '+ device.fhem.cached(device.mappings.CurrentTemperature.informId).replace('.',',') +' Grad';
          }
          if( device.mappings.TargetTemperature ) {
            if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
            state += 'steht auf '+ device.fhem.cached(device.mappings.TargetTemperature.informId).replace('.',',') +' Grad';
          }
          if( device.mappings.TargetPosition ) {
            if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
            state += 'steht auf '+ device.fhem.cached(device.mappings.TargetPosition.informId) +' Prozent';
          } else if( device.mappings.CurrentPosition ) {
            if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
            state += 'steht auf '+ device.fhem.cached(device.mappings.CurrentPosition.informId) +' Prozent';
          }
          if( device.mappings.CurrentAmbientLightLevel ) {
            if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
            state += 'misst '+ device.fhem.cached(device.mappings.CurrentAmbientLightLevel.informId) +' Lux';
          }
          if( device.mappings.AirQuality ) {
            if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
            state += device.fhem.cached(device.mappings.AirQuality.informId) +' misst xxx luftqualität';
          }
          if( device.mappings.CarbonDioxideLevel ) {
            if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
            state += 'misst '+ device.fhem.cached(device.mappings.CarbonDioxideLevel.informId) +' ppm co2';
          }
          if( device.mappings.BatteryLevel ) {
            if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
            state += 'der Batteriestand ist '+ device.fhem.cached(device.mappings.BatteryLevel.informId).replace('.',',');
          } else if( device.mappings.StatusLowBattery ) {
            if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
            //state += 'der Batteriestand ist '+ (device.fhem.cached(device.mappings.StatusLowBattery.informId)?'niedrig':'in ordnung');
            state += 'der Batteriestand ist '+ ((device.fhem.cached(device.mappings.StatusLowBattery.informId)==='ok')?'in ordnung':'niedrig');

          }
	  if( device.mappings.CurrentDoorState ) {
	    if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
	    state += 'ist '+ ((device.fhem.cached(device.mappings.CurrentDoorState.informId)==='open')?'geöffnet':'geschlossen');
          } else if( device.mappings.ContactSensorState ) {
	    if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
	    state += 'ist '+ ((device.fhem.cached(device.mappings.ContactSensorState.informId)==='open')?'geöffnet':'geschlossen');
          }
          if( device.mappings[FHEM.CustomUUIDs.Volume] ) {
            if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
            state += 'steht auf '+ device.fhem.cached(device.mappings[FHEM.CustomUUIDs.Volume].informId) +' Prozent';
          }

          if( !state ) {
            for( let characteristic_type in device.mappings ) {
              if( state ) { state.replace( ' und ', ', ' ); state += ' und ' };
              state += 'hat den status '+ device.fhem.cached(device.mappings[characteristic_type].informId);
            }
          }

          if( !state )
            return 'Ich kann das Gerät mit Namen '+ device.alexaName +' nicht abfragen.';

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
          if( !device.mappings.On ) {
            return 'Ich kann das Gerät mit Namen '+ command.device +' nicht schalten.';

          } else if( value === 'aus' ) {
            device.command( device.mappings.On, 0 );
            return ok;

          } else if( value === 'an' || value === 'ein' ) {
            device.command( device.mappings.On, 1 );
            return ok;

          } else if( value === 'um' ) {
            var current = device.fhem.reading2homekit(device.mappings.On, device.fhem.cached(device.mappings.On.informId))
            device.command( device.mappings.On, current?0:1 );
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
          if( device && !device.mappings[characteristic] ) {
log.debug(device.fhem.characteristicsOfIntent[intent_name]);
            if( device.fhem.characteristicsOfIntent[intent_name] !== undefined ) {
              for( c of device.fhem.characteristicsOfIntent[intent_name] ) {
log.debug(c);
                if( device.mappings[c] ) {
                  characteristic =  c;
                  break;
                }
              }
          }
log.info( intent_name +' -> '+ characteristic );
          }

          if( device && !device.mappings[characteristic] )
            return 'Ich kann '+ command.device +' nicht auf '+ value +' schalten.';

          var mapping = device.mappings[characteristic];

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
  log2("Received Directive", event);

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

      default:
        log2("Error", "Unsupported namespace: " + requestedNamespace);

        response = handleUnexpectedInfo(requestedNamespace);

        break;

    }// switch

  } catch (e) {
    log2("Error", util.inspect(e));

  }// try-catch

  callback( response );
  //return response;

}// exports.handler


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
                  friendlyDescription: 'n: '+ device.name + (device.alexaRoom?', r: '+ device.alexaRoom:''),
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

        if( device.mappings.On ) {
          d.actions.push( "turnOn" );
          d.actions.push( "turnOff" );

          d.applianceTypes.push ( 'SWITCH' );
        }

        if( device.mappings.Brightness || device.mappings.TargetPosition || device.mappings[FHEM.CustomUUIDs.Volume] ) {
          d.actions.push( "setPercentage" );
          d.actions.push( "incrementPercentage" );
          d.actions.push( "decrementPercentage" );
        }

        if( device.mappings.TargetTemperature  ) {
          d.actions.push( "setTargetTemperature" );
          d.actions.push( "incrementTargetTemperature" );
          d.actions.push( "decrementTargetTemperature" );
          d.actions.push( "getTargetTemperature" );

          d.applianceTypes.push ( 'THERMOSTAT' );
        }

        if( device.mappings.CurrentTemperature  ) {
          d.actions.push( "getTemperatureReading" );
        }

        if( device.mappings.Hue  ) {
          d.actions.push( "setColor" );
        }

        if( device.mappings[FHEM.CustomUUIDs.ColorTemperature] || device.mappings[FHEM.CustomUUIDs.CT] ) {
          d.actions.push( "setColorTemperature" );
          d.actions.push( "incrementColorTemperature" );
          d.actions.push( "decrementColorTemperature" );
        }

        if( device.mappings.LockTargetState  ) {
          d.actions.push( "setLockState" );
        }

        if( device.mappings.LockCurrentState  ) {
          d.actions.push( "getLockState" );
        }


        if( d.actions.length )
          payload.discoveredAppliances.push( d );
      }

      response = createDirective(header, payload);
      break;

    default:
      log2("Error", "Unsupported operation" + requestedName);
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
      log2("Error", "Unsupported operation" + requestedName);
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
      log2("Error", "Unsupported operation" + requestedName);
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
      log2("Error", "Unsupported operation" + requestedName);
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
      log2("Error", "Unsupported operation" + requestedName);
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
      log2("Error", "Unsupported operation" + requestedName);
      response = handleUnsupportedOperation();

      break;

  }// switch

  return response;

} //handleAuthorization

var handleReportState = function(event) {
  var device = this.devices[event.directive.endpoint.cookie.device.toLowerCase()];
  if( !device )
    return createError(ERROR3_NO_SUCH_ENDPOINT, undefined, event);

  var context = { "properties": [] };

  var mapping;
  if( mapping = device.mappings.On ) {
    var current = device.fhem.reading2homekit(mapping, device.fhem.cached(mapping.informId));
    if( current !== undefined )
      context.properties.push( {
          "namespace": NAMESPACE_PowerController,
          "name": "powerState",
          "value": current?"ON":"OFF",
          "timeOfSample": new Date(Date.now()).toISOString(),
          "uncertaintyInMilliseconds": 500
      } );
  }

  if( mapping = device.mappings.Brightness ) {
    var current = device.fhem.reading2homekit(mapping, device.fhem.cached(mapping.informId));
    if( current !== undefined )
      context.properties.push( {
          "namespace": NAMESPACE_BrightnessController,
          "name": "brightness",
          "value": parseInt(current),
          "timeOfSample": new Date(Date.now()).toISOString(),
          "uncertaintyInMilliseconds": 500
      } );
  }

  if( device.mappings[FHEM.CustomUUIDs.ColorTemperature] || device.mappings[FHEM.CustomUUIDs.CT] ) {
    var current;
    if( device.mappings[FHEM.CustomUUIDs.ColorTemperature] )
      current = parseInt(device.fhem.cached(device.mappings[FHEM.CustomUUIDs.ColorTemperature].informId));
    else if( device.mappings[FHEM.CustomUUIDs.CT] )
      current = parseInt(1000000 / parseFloat(device.fhem.cached(device.mappings[FHEM.CustomUUIDs.CT].informId)) );
    if( current !== undefined )
      context.properties.push( {
      "namespace": NAMESPACE_ColorTemperatureController,
      "name": "colorTemperatureInKelvin",
      "value": current,
      "timeOfSample": new Date(Date.now()).toISOString(),
      "uncertaintyInMilliseconds": 500
      } );
  }

  if( mapping = device.mappings.TargetPosition ) {
    var current = device.fhem.reading2homekit(mapping, device.fhem.cached(mapping.informId));
    if( current !== undefined )
      context.properties.push( {
          "namespace": NAMESPACE_PercentageController,
          "name": "percentage",
          "value": parseInt(current),
          "timeOfSample": new Date(Date.now()).toISOString(),
          "uncertaintyInMilliseconds": 500
      } );
  }

  if( mapping = device.mappings.TargetTemperature ) {
    var current = device.fhem.reading2homekit(mapping, device.fhem.cached(mapping.informId));
    if( current !== undefined )
      context.properties.push( {
          "namespace": NAMESPACE_ThermostatController,
          "name": "targetSetpoint",
          "value": { "value": parseFloat(current), "scale": "CELSIUS" },
          "timeOfSample": new Date(Date.now()).toISOString(),
          "uncertaintyInMilliseconds": 500
      } );
    if( 0 )
      context.properties.push( {
          "namespace": NAMESPACE_ThermostatController,
          "name": "thermostatMode",
          "value": "HEAT",
          "timeOfSample": new Date(Date.now()).toISOString(),
          "uncertaintyInMilliseconds": 500
      } );
  }

  if( mapping = device.mappings.CurrentTemperature ) {
    var current = device.fhem.reading2homekit(mapping, device.fhem.cached(mapping.informId));
    if( current !== undefined )
      context.properties.push( {
          "namespace": NAMESPACE_TemperatureSensor,
          "name": "temperature",
          "value": { "value": parseFloat(current), "scale": "CELSIUS" },
          "timeOfSample": new Date(Date.now()).toISOString(),
          "uncertaintyInMilliseconds": 500
      } );
  }

  if( mapping = device.mappings.LockCurrentState  ) {
    var current = device.fhem.reading2homekit(mapping, device.fhem.cached(mapping.informId));
    //var current = device.fhem.cached(device.mappings.LockCurrentState.informId);
    if( current === 'SECURED' || current === 'locked' )
      current = 'LOCKED';
    else
      current = 'UNLOCKED';
    if( current !== undefined )
      context.properties.push( {
          "namespace": NAMESPACE_LockController,
          "name": "lockState",
          "value": current,
          "timeOfSample": new Date(Date.now()).toISOString(),
          "uncertaintyInMilliseconds": 500
      } );
  }

  var header = createHeader("Alexa", RESPONSE_STATE, event);
  var endpoint = { "scope": event.directive.endpoint.scope, "endpointId": event.directive.endpoint.endpointId};

  return { "context": context, "event": { "header": header, "endpoint": endpoint , "payload": {} } };
} //handleReportState

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

        if( 0 && !device.isOfType('light') && !device.isOfType('thermostat') ) {
          log.info( 'ignoring '+ device.name +' for alxea ha skill' );
          continue;
        }

        if( !device.isInScope('alexa') && !device.isInScope('alexa-ha') ) {
          log.debug( 'ignoring '+ device.name +' for alxea ha skill' );
          continue;
        }

        var room = this.roomOfIntent[accepted_token.oauthClientID];
        //if( room && room !== device.alexaRoom ) {
        if( room && !device.alexaRoom.match( '(^|,)('+room+')(,|\$)' ) ) {
          log.debug( 'ignoring '+ device.name +' in room '+ device.alexaRoom +' for echo in room '+ room );
        }

        //console.log(device);
        var d = { endpointId: device.uuid_base.replace( /[^\w_\-=#;:?@&]/g, '_' ),
                  manufacturerName: 'FHEM'+device.type,
                  modelName: 'FHEM'+ (device.model ? device.model : '<unknown>'),
                  version: '<unknown>',
                  friendlyName: device.alexaName,
                  description: 'n: '+ device.name + (device.alexaRoom?', r: '+ device.alexaRoom:''),
                  //isReachable: true,
                  actions: [],
                  capabilities: [],
                  displayCategories: [],
                  cookie: { device: device.device },
                };

if( 0 )
        d.capabilities.push( {
                               "type": "AlexaInterface",
                               "interface": "Alexa.EndpointHealth",
                               "version": "3",
                               "properties": {
                                  "supported": [
                                     { "name": "connectivity" }
                                  ],
                                  "proactivelyReported": true,
                                  "retrievable": true
                               }
                             }
                           );

        if( device.isOfType('outlet') )
          d.displayCategories.push ( 'SMARTPLUG' );
        else if( device.isOfType('light') )
          d.displayCategories.push ( 'LIGHT' );
        else if( device.isOfType('lock') )
          d.displayCategories.push ( 'SMARTLOCK' );


        if( device.mappings.Brightness ) {
          d.capabilities.push( {
                                 "type": "AlexaInterface",
                                 "interface": NAMESPACE_BrightnessController,
                                 "version": "3",
                                 "properties": {
                                   "supported": [
                                     { "name": "brightness" }
                                   ],
                                   "proactivelyReported": false,
                                   "retrievable": true
                                 }
                               }
                             );
        }

        if( device.mappings.TargetPosition ) {
          d.capabilities.push( {
                                 "type": "AlexaInterface",
                                 "interface": NAMESPACE_PercentageController,
                                 "version": "3",
                                 "properties": {
                                   "supported": [
                                     { "name": "percentage" },
                                   ],
                                   "proactivelyReported": false,
                                   "retrievable": true
                                 }
                               }
                             );
        }

        if( device.mappings[FHEM.CustomUUIDs.Volume] ) {
          d.displayCategories.push ( 'OTHER' );
          d.capabilities.push( {
                                 "type": "AlexaInterface",
                                 "interface": NAMESPACE_Speaker,
                                 "version": "3",
                                 "properties": {
                                   "supported": [
                                     { "name": "volume" }
                                   ],
                                   "proactivelyReported": false,
                                   "retrievable": true
                                 }
                               }
                             );
        }

        if( device.mappings.Hue  ) {
          d.capabilities.push( {
                                 "type": "AlexaInterface",
                                 "interface": NAMESPACE_ColorController,
                                 "version": "3",
                                 "properties": {
                                   "supported": [
                                     { "name": "color" }
                                   ],
                                   "proactivelyReported": false,
                                   "retrievable": false
                                 }
                               }
                             );
        }

        if( device.mappings[FHEM.CustomUUIDs.ColorTemperature] || device.mappings[FHEM.CustomUUIDs.CT] ) {
          d.capabilities.push( {
                                 "type": "AlexaInterface",
                                 "interface": NAMESPACE_ColorTemperatureController,
                                 "version": "3",
                                 "properties": {
                                   "supported": [
                                     { "name": "colorTemperatureInKelvin" }
                                   ],
                                   "proactivelyReported": false,
                                   "retrievable": true
                                 }
                               }
                             );
        }

        if( device.mappings.On ) {
          d.capabilities.push( {
                                 "type": "AlexaInterface",
                                 "interface": NAMESPACE_PowerController,
                                 "version": "3",
                                 "properties": {
                                   "supported": [
                                     { "name": "powerState" }
                                   ],
                                   "proactivelyReported": false,
                                   "retrievable": true
                                 }
                               }
                             );

          if( !d.displayCategories.length )
            d.displayCategories.push ( 'SWITCH' );
        }


        if( device.mappings.TargetTemperature  ) {
          d.capabilities.push( {
                                 "type": "AlexaInterface",
                                 "interface": NAMESPACE_ThermostatController,
                                 "version": "3",
                                 "properties": {
                                   "supported": [
                                     { "name": "targetSetpoint" },
                                     { "name": "thermostatMode" }
                                   ],
                                   "proactivelyReported": false,
                                   "retrievable": true
                                 }
                               }
                             );

          d.displayCategories.push ( 'THERMOSTAT' );
        }

        if( device.mappings.CurrentTemperature  ) {
          d.capabilities.push( {
                                 "type": "AlexaInterface",
                                 "interface": NAMESPACE_TemperatureSensor,
                                 "version": "3",
                                 "properties": {
                                   "supported": [
                                     { "name": "temperature" }
                                   ],
                                   "proactivelyReported": false,
                                   "retrievable": true
                                 }
                               }
                             );

          if( !d.displayCategories.length )
            d.displayCategories.push ( 'TEMPERATURE_SENSOR' );
        }

        if( device.mappings.LockTargetState
            || device.mappings.LockCurrentState  )
          d.capabilities.push( {
                                 "type": "AlexaInterface",
                                 "interface": NAMESPACE_LockController,
                                 "version": "3",
                                 "properties": {
                                   "supported": [
                                     { "name": "lockState" }
                                   ],
                                   "proactivelyReported": false,
                                   "retrievable": true
                                 }
                               }
                             );


        if( d.capabilities.length )
          payload.endpoints.push( d );
      }

      response = createDirective(header, payload);
      response = { "event": response };
      break;

    default:
      log2("Error", "Unsupported operation" + requestedName);
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

  if( device.mappings.Hue )
    device.command( device.mappings.Hue, target_hue );
  if( device.mappings.Saturation )
    device.command( device.mappings.Saturation, target_saturation );
  if( device.mappings.Brightness )
    device.command( device.mappings.Brightness, target_brightness );

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
  var current;
  if( device.mappings[FHEM.CustomUUIDs.ColorTemperature] ) {
    mapping = device.mappings[FHEM.CustomUUIDs.ColorTemperature]
    current = parseInt(device.fhem.cached(mapping.informId));
  } else if( device.mappings[FHEM.CustomUUIDs.CT] ) {
    mapping = device.mappings[FHEM.CustomUUIDs.CT]
    current = parseInt(1000000 / parseFloat(device.fhem.cached(mapping.informId)) );
  }

  var target;

  var requestedName = event.directive.header.name;
  switch (requestedName) {
    case 'DecreaseColorTemperature':
      target = current - 1000;
      break;
    case 'IncreaseColorTemperature':
      target = current + 1000;
      break;
    case 'SetColorTemperature':
      target = event.directive.payload.colorTemperatureInKelvin;
      break;
    default:
      return createError(ERROR3_INVALID_DIRECTIVE, undefined, event);
      break;
  }

  var min = undefined; //device.mappings.ColorTemperature.minValue;
  if( min === undefined ) min = 2000;
  var max = undefined; //device.mappings.ColorTemperature.maxValue;
  if( max === undefined ) max = 6500;

  if( target < min )
    target = min;
  else if( target > max )
    target = max;
  else if( target < min || target > max )
    return createError(ERROR3_VALUE_OUT_OF_RANGE, undefined, event);

  if( device.mappings[FHEM.CustomUUIDs.CT] )
    target = 1000000 / target;

  device.command( mapping, target );


  var header = createHeader("Alexa", "Response", event);
  var context = {
    "properties": [ {
      "namespace": NAMESPACE_ColorTemperatureController,
      "name": "colorTemperatureInKelvin",
      "value": target,
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

var handleThermostatController = function(event) {
  var device = this.devices[event.directive.endpoint.cookie.device.toLowerCase()];
  if( !device )
    return createError(ERROR3_NO_SUCH_ENDPOINT, undefined, event);

  var mapping = device.mappings.TargetTemperature;
  var current = parseFloat( device.fhem.cached(mapping.informId) );

  var target;

  var requestedName = event.directive.header.name;
  switch (requestedName) {
    case 'AdjustTargetTemperature':
      target = current + event.directive.payload.targetSetpointDelta.value;
      break;
    case 'SetTargetTemperature':
      target = event.directive.payload.targetSetpoint.value;
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

    device.command( mapping, target );
  }

  var header = createHeader("Alexa", "Response", event);
  var context = {
    "properties": [ {
      "namespace": NAMESPACE_ThermostatController,
      "name": "targetSetpoint",
      "value": { "value": parseFloat(target), "scale": "CELSIUS" },
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
      "value": name === 'Lock'?'LOCKED':'UNLOCKED',
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
  var current = parseInt(device.fhem.reading2homekit(mapping, device.fhem.cached(mapping.informId)));

  var target;

  var requestedName = event.directive.header.name;
  switch (requestedName) {
    case 'AdjustVolume':
      target = current + event.directive.payload.volume;
      break;
    case 'SetVolume':
      target = event.directive.payload.volume;
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
      "namespace": NAMESPACE_Speaker,
      "name": "Volume",
      "value": target,
      "timeOfSample": new Date(Date.now()).toISOString(),
      "uncertaintyInMilliseconds": 500
    } ]
  };
  var endpoint = { "scope": event.directive.endpoint.scope, "endpointId": event.directive.endpoint.endpointId};

  return { "context": context, "event": { "header": header, "endpoint": endpoint , "payload": {} } };

}// handleSpeaker


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

  var current;
  if( device.mappings[FHEM.CustomUUIDs.ColorTemperature] )
    current = parseInt(device.fhem.cached(device.mappings[FHEM.CustomUUIDs.ColorTemperature].informId));
  else if( device.mappings[FHEM.CustomUUIDs.CT] )
    current = parseInt(1000000 / parseFloat(device.fhem.cached(device.mappings[FHEM.CustomUUIDs.CT].informId)) );
  var target = event.payload.colorTemperature.value;

  var min = undefined; //device.mappings.ColorTemperature.minValue;
  if( min === undefined ) min = 2000;
  var max = undefined; //device.mappings.ColorTemperature.maxValue;
  if( max === undefined ) max = 6500;

  if( target < min )
    target = min;
  else if( target > max )
    target = max;
  else if( target < min || target > max )
    return createError(ERROR_VALUE_OUT_OF_RANGE, {minimumValue: min, maximumValue: max});

  if( device.mappings[FHEM.CustomUUIDs.ColorTemperature] )
    device.command( device.mappings[FHEM.CustomUUIDs.ColorTemperature], target );
  else if( device.mappings[FHEM.CustomUUIDs.CT] )
    device.command( device.mappings[FHEM.CustomUUIDs.CT], 1000000 / target );


  var header = createHeader(NAMESPACE_SmartHome_CONTROL,RESPONSE_SET_COLOR_TEMPERATURE);

  var payload = { achievedState: { colorTemperature: { value: target } } };

  return createDirective(header, payload);

}// handleControlSetColorTemperature


var handleControlIncrementColorTemperature = function(event) {

  var device = this.devices[event.payload.appliance.additionalApplianceDetails.device.toLowerCase()];
  if( !device )
    return handleUnsupportedOperation();

  var current;
  if( device.mappings[FHEM.CustomUUIDs.ColorTemperature] )
    current = parseInt(device.fhem.cached(device.mappings[FHEM.CustomUUIDs.ColorTemperature].informId));
  else if( device.mappings[FHEM.CustomUUIDs.CT] )
    current = parseInt(1000000 / parseFloat(device.fhem.cached(device.mappings[FHEM.CustomUUIDs.CT].informId)) );
  var target = current + 500;

  var min = undefined; //device.mappings.ColorTemperature.minValue;
  if( min === undefined ) min = 2000;
  var max = undefined; //device.mappings.ColorTemperature.maxValue;
  if( max === undefined ) max = 6500;

  if( target < min )
    target = min;
  else if( target > max )
    target = max;
  else if( target < min || target > max )
    return createError(ERROR_VALUE_OUT_OF_RANGE, {minimumValue: min, maximumValue: max});

  if( device.mappings[FHEM.CustomUUIDs.ColorTemperature] )
    device.command( device.mappings[FHEM.CustomUUIDs.ColorTemperature], target );
  else if( device.mappings[FHEM.CustomUUIDs.CT] )
    device.command( device.mappings[FHEM.CustomUUIDs.CT], 1000000 / target );


  var header = createHeader(NAMESPACE_SmartHome_CONTROL,RESPONSE_INCREMENT_COLOR_TEMPERATURE);

  var payload = { achievedState: { colorTemperature: { value: target } } };

  return createDirective(header, payload);

}// handleControlIncrementColorTemperature


var handleControlDecrementColorTemperature = function(event) {

  var device = this.devices[event.payload.appliance.additionalApplianceDetails.device.toLowerCase()];
  if( !device )
    return handleUnsupportedOperation();

  var current = parseFloat(device.fhem.cached(device.mappings[FHEM.CustomUUIDs.ColorTemperature].informId));
  var current;
  if( device.mappings[FHEM.CustomUUIDs.ColorTemperature] )
    current = parseFloat(device.fhem.cached(device.mappings[FHEM.CustomUUIDs.ColorTemperature].informId));
  else if( device.mappings[FHEM.CustomUUIDs.CT] )
    current = parseInt(1000000 / parseFloat(device.fhem.cached(device.mappings[FHEM.CustomUUIDs.CT].informId)) );
  var target = current - 500;

  var min = undefined; //device.mappings.ColorTemperature.minValue;
  if( min === undefined ) min = 2000;
  var max = undefined; //device.mappings.ColorTemperature.maxValue;
  if( max === undefined ) max = 6500;

  if( target < min )
    target = min;
  else if( target > max )
    target = max;
  else if( target < min || target > max )
    return createError(ERROR_VALUE_OUT_OF_RANGE, {minimumValue: min, maximumValue: max});

  if( device.mappings[FHEM.CustomUUIDs.ColorTemperature] )
    device.command( device.mappings[FHEM.CustomUUIDs.ColorTemperature], target );
  else if( device.mappings[FHEM.CustomUUIDs.CT] )
    device.command( device.mappings[FHEM.CustomUUIDs.CT], 1000000 / target );


  var header = createHeader(NAMESPACE_SmartHome_CONTROL,RESPONSE_DECREMENT_COLOR_TEMPERATURE);

  var payload = { achievedState: { colorTemperature: { value: target } } };

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


var log2 = function(title, msg) {

  console.log('**** '+ title +': '+ JSON.stringify(msg));

}// log
