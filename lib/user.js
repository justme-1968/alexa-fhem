var path = require('path');
var fs = require('fs');

'use strict';

module.exports = {
  User: User
}

/**
 * Manages user settings and storage locations.
 */

// global cached config
var config;

// optional custom storage path
var customStoragePath;
var customConfigFile;

var log = require("./logger")._system;

function User() {
}
  
User.config = function() {
  return config || (config = Config.load(User.configPath()));
}
  
User.storagePath = function() {
  if (customStoragePath) return customStoragePath;
  var home = process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE || process.env.PWD;
  return path.join(home, ".alexa");
}

User.sshKeyPath = function() {
  var home = process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE || process.env.PWD;
  return path.join(home, ".ssh");
};

User.configPath = function() {
  if( customConfigFile !== undefined ) {
    if( path.basename( customConfigFile ) != customConfigFile ) // path is included
      return customConfigFile;
    else // filename only
      return path.join(User.storagePath(), customConfigFile);
  }

  return path.join(User.storagePath(), "config.json");
}

User.persistPath = function() {
  return path.join(User.storagePath(), "persist");
}

User.setStoragePath = function(path) {
  customStoragePath = path;
}

User.setConfigFile = function(file) {
  customConfigFile = file;
}

/*
    The following block is copied from the FHEMlazy trial of gvzdus
 */
User.autoConfig = function (interactive, config) {
  return new Promise(function (resolve, reject) {
    (async () => {
      const finalError = await runAutoconfig(interactive, config);
      if (finalError) {
        log.error(finalError);
        reject(finalError);
      } else {
        resolve("Config okay");
      }
    })();
  })
};

const crypto = require('crypto');

var csrfToken;
var alexaDeviceName;

const BEARERTOKEN_NAME = "alexaFHEM.bearerToken";
const SKILLREGKEY_NAME = "alexaFHEM.skillRegKey";


async function runAutoconfig(interactive, config) {
  const spath = User.storagePath();

  // FIRST STEP: Check for config.json and build up one, if missing
  const readline = interactive ? require('readline-sync') : { question: function () { return "" } };
  let dirty = false; // Did we modify an existing config.json ?
  if (!fs.existsSync(spath)) {
    console.log("Creating directory " + spath);
    fs.mkdirSync(spath, 0o700);
  }
  let conn = undefined;

  if (! config) {
    const configPath = User.configPath();
    let config = {};
    if (!fs.existsSync(configPath)) {
      if (fs.existsSync("./config-sample.json")) {
        console.log("config.json not existing, creating from ../config-sample.json");
        try {
          config = JSON.parse(fs.readFileSync("./config-sample.json"));
        } catch (e) {
          console.log("... which is broken JSON, so from the scratch anyways...");
        }
      } else {
        console.log("config.json not existing, creating from the scratch");
      }
      dirty = true;
    } else {
      try {
        config = JSON.parse(fs.readFileSync(configPath));
        dirty = false;
      } catch (e) {
        console.log("... which is broken JSON, so from the scratch anyways...");
      }
    }
    if (!config.hasOwnProperty('alexa')) {
      config.alexa = {}
    }
    if (!config.hasOwnProperty('connections')) {
      config.connections = []
    }

    // Default settings for alexa-fhem
    if (!config.alexa.hasOwnProperty('port')) {
      config.alexa.port = 3000;
      dirty = true
    }
    if (!config.alexa.hasOwnProperty('name')) {
      config.alexa.name = 'Alexa';
      dirty = true
    }
    if (!config.alexa.hasOwnProperty('bind-ip')) {
      config.alexa['bind-ip'] = '127.0.0.1';
      dirty = true
    }
    if (!config.alexa.hasOwnProperty('ssl')) {
      config.alexa.ssl = false;
    }
    if (!config.alexa.hasOwnProperty('publicSkill')) {
      config.alexa.publicSkill = true;
      dirty = true
    }
    if (!config.alexa.hasOwnProperty('ssh')) {
      ['/bin', '/usr/bin', '/usr/local/bin'].forEach(d => {
        if (fs.existsSync(d + '/ssh')) {
          config.alexa.ssh = d + '/ssh';
          dirty = true;
        }
      });
    }
    if (!config.alexa.hasOwnProperty('disableCustomSkill')) {
      config.alexa.disableCustomSkill = true;
      dirty = true
    }

    // Search for FHEM, if no connections..
    if (config.connections.length === 0) {
      dirty = true;
      const conn = {
        server: '127.0.0.1',
        port: 8083,
        name: 'FHEM',
        filter: 'alexaName=...*',
        ssl: false
      };
      config.connections.push(conn);
    }
    conn = config.connections[0];

    var retry = true; // Well, at least a first try...
    let failmsg = undefined;

    while (retry) {
      let testReq = await buildRequest(conn).catch(any => {
        console.log(any)
      });

      if (!testReq.success) {
        let url = (conn.ssl ? "https" : "http") + "://" + conn.server + ":" + conn.port + "/" + (conn.webname ? conn.webname : "fhem/");
        if (testReq.hasOwnProperty("httpcode")) {
          switch (testReq.httpcode) {
            case 401:
              if (!conn.auth || !conn.auth.user) {
                console.log('FHEM seems to be username/password protected. Please provide the authentication settings.');
                console.log('(Username & password will be stored unencrypted in the ~/.alexa/config.json file - sorry)');
              } else {
                console.log("Username ('" + conn.auth.user + "') or password seems to be incorrect. Pls. retry:");
              }
              if (interactive) {
                const user = readline.question("Username in the Webfrontend: ");
                const pass = readline.question("Password in the Webfrontend: ");
                conn.auth = {user: user, pass: pass};
              } else
                break;
              continue;
            case 404:
              failmsg = url + " returned a 404 Not found. Probably you have to fix webname?";
              conn.webname = "FIXME";
              break;
            default:
              failmsg = "Strange HTTP code " + testReq.httpcode + " when accessing " + url + ". Please verify manually.";
              break;
          }
        } else {
          if (testReq.message.errno === 'ECONNRESET') {
            if (dirty) {
              if (!conn.ssl) {
                conn.ssl = true;
                retry = true;
                continue;
              }
            }
          }
          conn.server = "FIXME";
          conn.port = "FIXME";
          if (testReq.message.hasOwnProperty('errno')) {
            if (testReq.message.errno === 'ECONNREFUSED') {
              failmsg = "FHEM not found at " + url +
                " (no listener). It seems to be running on a different IP / port.";
            } else if (testReq.message.errno === 'ECONNRESET') {
              failmsg = "FHEM not found at " + conn.server + ":" + conn.port +
                ". It seems to be running on a different IP / port.";
            } else {
              failmsg = "Unknown error code " + testReq.message.errno + " on connecting to " + url;
            }
          } else {
            failmsg = "Unknown error " + testReq.message;
          }
        }
        if (interactive) {
          console.log("Problem message: " + failmsg);
          console.log("Please copy&paste a working URL for FHEM from your browser to the prompt, or just type");
          console.log("[Enter] to manually fix the config file!");
          const workingUrl = readline.question("FHEM-URL: ");
          if (workingUrl.length < 3) {
            retry = false;
          } else {
            const url = require('url');
            const wurl = url.parse(workingUrl);
            conn.ssl = (wurl.protocol === 'https:');
            conn.server = wurl.hostname;
            if (wurl.port.length === 0)
              conn.port = conn.ssl ? 443 : 80;
            else
              conn.port = parseInt(wurl.port);
            if (wurl.username || wurl.password) {
              conn.auth = {user: wurl.username, pass: wurl.password};
            }
            if (wurl.pathname !== '/fhem')
              conn.webname = wurl.pathname.substring(1);
            retry = true;
          }
        } else
          retry = false;
        config.connections[0] = conn;

      } else {
        // Connectivity to FHEM given...
        csrfToken = testReq.message;
        console.log("FHEM-Connectivity fine, CSRF-Token: " + csrfToken);
        retry = false;
      }
    }
    if (failmsg)
      return failmsg;

    if (dirty) {
      console.log("config.json to write:\n" + JSON.stringify(config, null, 2));
      let goon = readline.question("Okay to write about file to " + configPath + "? [Hit Enter for okay, 'n' else] ");
      if (goon !== 'n') {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      }
    } else {
      console.log("existing config.json seems fine");
    }
  } else {
    // config passed as argument - non-interactive mode, default config by 39_alexa.pm
    log.info("Passed config: " + JSON.stringify(config));
    if (config.alexa.ssh)
      config.alexa.ssh = config.alexa.ssh.trim();
    conn = config.connections[0];
    var testReq = await buildRequest(conn);
    if (testReq.success)
      csrfToken = testReq.message;
    else
      reject('FHEM Web not reachable');
  }

  // NEXT STEP: Generate SSH key if not yet done
  let pubkey_path = path.join(User.sshKeyPath(), 'id_rsa');
  if (! fs.existsSync(pubkey_path)) {
    if (fs.existsSync(config.alexa.ssh + '-keygen')) {
      console.log ('No SSH public key found, we have to generate one.');
      let goon = readline.question("Okay to generate SSH-Key in " + User.sshKeyPath() + "? [Hit Enter for okay, 'n' else] ");
      if (goon !== 'n') {
        const execSync = require('child_process').spawnSync;
        const prc = execSync(config.alexa.ssh + '-keygen',  ['-t', 'rsa', '-N', '', '-f', pubkey_path], { stdio: 'pipe'});
        console.log (prc.output[1].toString());
      } else {
        return 'Without a private SSH key, connection setup will not work. Please create an SSH key manually.';
      }
    } else {
      return 'ssh-keygen command not found, please check if your installation of SSH is complete.';
    }
  } else
    console.log("SSH key seems to exist");

  // NEXT STEP: Register SSH key at server

  let goon;
  if (fs.existsSync(pubkey_path)) {
    const execSync = require('child_process').spawnSync;

    // Most likely initial SSH call: Avoid prompt for adding HostKey
    const prcStatus = execSync(config.alexa.ssh, [
      '-o', 'StrictHostKeyChecking=no',
      '-p', 58824, 'fhem-va.fhem.de', 'status'], {stdio: 'pipe'});
    let registrationStatus = prcStatus.output[1].toString();
    const sshKeyIsRegistered = (registrationStatus.indexOf('Registered') === 0);
    if (sshKeyIsRegistered)
      console.log('Our SSH key is known at the reverse proxy, good!');
    else {
      if (registrationStatus.indexOf('Unregistered') !== 0) {
        return "Reverse Proxy replied with neither registered nor unregistered status: " +
          "out: " + prcStatus.output[1] + " err:" + prcStatus.output[2];
      }
    }

    // Search for Device MyAlexa (TYPE=alexa) and create if not existing
    let s_str = await FHEM_execute(log, conn, "jsonlist2 TYPE=alexa").catch(
      a => console.log("ERROR" + a));
    let s_json = JSON.parse(s_str);
    if (s_json.totalResultsReturned < 1) {
      await FHEM_execute(log, conn, "define MyAlexa alexa");
      s_str = await FHEM_execute(log, conn, "jsonlist2 TYPE=alexa").catch(
        a => console.log("ERROR" + a));
      s_json = JSON.parse(s_str);
    }
    let alexaDevice = s_json.Results[0];
    const alexaDevHasStart = alexaDevice.PossibleSets &&
      alexaDevice.PossibleSets.indexOf("start:") >= 0 &&
      alexaDevice.PossibleAttrs &&
      alexaDevice.PossibleAttrs.indexOf('alexaFHEM-cmd');
    log.info('39_alexa.pm is new version: ' + alexaDevHasStart);

    let userIdProxy = undefined;
    const FHEMAlexa = "FHEM.Alexa";

    if (!alexaDevice.Readings.hasOwnProperty(BEARERTOKEN_NAME)) {
      // Check if we can migrate a bearer token from FHEM.Alexa to MyAlexa
      s_str = await FHEM_execute(log, conn, "jsonlist2 FHEM.Alexa").catch(a => console.log("ERROR" + a));
      s_json = JSON.parse(s_str);
      if (s_json.totalResultsReturned > 0) {
        let dirty = false;
        if (s_json.Results[0].Readings.hasOwnProperty('bearerToken')) {
          await FHEM_execute(log, conn,
            "setreading " + alexaDevice.Name + " " + BEARERTOKEN_NAME + " " + s_json.Results[0].Readings.bearerToken.Value);
          dirty = true;
        }
        if (s_json.Results[0].Readings.hasOwnProperty('skillRegistrationKey')) {
          await FHEM_execute(log, conn,
            "setreading " + alexaDevice.Name + " " + SKILLREGKEY_NAME + " " + s_json.Results[0].Readings.skillRegistrationKey.Value);
          dirty = true;
        }
        if (dirty) {
          s_str = await FHEM_execute(log, conn, "jsonlist2 " + alexaDevice.Name).catch(
            a => console.log("ERROR" + a));
          s_json = JSON.parse(s_str);
          alexaDevice = s_json.Results[0];
          if (alexaDevice.Readings.hasOwnProperty(BEARERTOKEN_NAME) &&
            alexaDevice.Readings.hasOwnProperty(SKILLREGKEY_NAME)) {
            await FHEM_execute(log, conn,
              "set " + FHEMAlexa + " bearerToken migrated2" + alexaDevice.Name);
            await FHEM_execute(log, conn,
              "set " + FHEMAlexa + " skillRegistrationKey migrated2" + alexaDevice.Name);
          }
        }
      }
    }

    if (! alexaDevice.Readings.hasOwnProperty(BEARERTOKEN_NAME) || !sshKeyIsRegistered) {

      var registrationKey = undefined;
      var bearerToken = undefined;

      if (interactive) {
        if (!sshKeyIsRegistered) {
          console.log("Your SSH key needs to get registered. Please read the privacy instructions here:");
          console.log("  https://va.fhem.de/privacy/");
          console.log("... and the press Enter to register your key.");
          goon = readline.question("Okay to register your public SSH-Key at fhem-va.fhem.de? [Hit Enter for okay, 'n' else] ");
        } else {
          console.log("Although your SSH key is known at the reverse proxy, I was unable to find the bearerToken.");
          console.log("(Did you probably forget to save the FHEM configuration in the web frontend?)");
          console.log("You have 2 options to recover the service:");
          console.log("  1) Create a new registration key, unlink the skill in Alexa and reinstall it");
          console.log("  2) Enter your old licence key, if you saved it.");
          console.log("or enter 'a' to abort....");
          while (true) {
            goon = readline.question("Your choice? ");
            if (goon==='a') return "Aborting without a recreated key";
            if (goon==='1') break;
            if (goon==='2') {
              registrationKey = readline.question("Your registration key?: ").trim();
              const regexp = /^([0-9A-F]+)-([0-9A-F]{14,16})-([0-9A-F]{14,16})$/m;
              const match = regexp.exec(registrationKey);
              if (match) {
                bearerToken = match[3];
                break;
              } else {
                console.log("This does not look like a registration key.");
              }
            }
          }
        }
      }
      if (goon !== 'n') {

        if (! registrationKey || !sshKeyIsRegistered) {
          const hash = crypto.createHash('sha256');
          // This is only for our side:
          const registrationRandomBytes = crypto.randomBytes(8);
          const registrationRandomHash = hash.update(registrationRandomBytes).digest('hex');
          let bearerTokenRandomBytes = crypto.randomBytes(8);
          bearerToken = bearerTokenRandomBytes.toString('hex').toUpperCase();

          const prc = execSync(config.alexa.ssh, [
            '-o', 'StrictHostKeyChecking=no',
            '-p', 58824, 'fhem-va.fhem.de', 'register',
            'keyhash=' + registrationRandomHash], {stdio: 'pipe'});
          let registrationResult = prc.output[1].toString();
          //console.log(registrationStatus);
          const regexp = /\s+([0-9A-F]+)-\.\./m;
          const match = regexp.exec(registrationResult);
          // Build new registration key, if a bearer token is existing, use this one (otherwise the
          // skill has to be reregistered at Amazon).
          registrationKey = match[1] + '-' +
            registrationRandomBytes.toString('hex').toUpperCase() + '-' +
            bearerToken;
        }

        await FHEM_execute(log, conn, "setreading " + alexaDevice.Name + " " + BEARERTOKEN_NAME + " " + bearerToken);
        await FHEM_execute(log, conn, "setreading " + alexaDevice.Name + " " + SKILLREGKEY_NAME + " " + registrationKey);

      } else {
        return "Unable to continue without a registered SSH key.\r\n";
      }
    }

    // create Alexa start/stop stuff if not yet existing
    if (alexaDevHasStart) {
      // 39_alexa.pm with start capability...
      if (alexaDevice.Attributes['alexaFHEM-cmd'] !== process.argv[1]) {
        await FHEM_execute(log, conn,
          "attr " + alexaDevice.Name + " alexaFHEM-cmd " + process.argv[1]);
      }
    }
    if (registrationKey && interactive) {
      console.log("\r\nThis is your registration key:\r\n\r\n");
      console.log(">>>>>>>>>        " + registrationKey + "        <<<<<<<<\r\n\r\n");
      console.log("You will need it when activating the skill in the Alexa-App.\r\n" +
        "Please copy & paste it NOW to a safe place, then press Enter continue!\r\n");
      readline.question("Copied the key? [Hit Enter to continue, you are done]");
    }
  }
}


function buildRequest (config ) {
  return new Promise((resolve, reject) => {
    var base_url = 'http://';
    if (config.ssl) {
      if (typeof config.ssl !== 'boolean') {
        this.log.error('config: value for ssl has to be boolean.');
        process.exit(0);
      }
      base_url = 'https://';
    }
    base_url += config.server + ':' + config.port;

    if (config.webname) {
      base_url += '/' + config.webname;
    } else {
      base_url += '/fhem';
    }
    config.base_url = base_url;
    base_url += "?XHR=1";

    let request = require('request');
    request(base_url, getRequestOptions(config), (error, response, body) => {
      if (error)
        resolve( { success: false, message: error } );

      else if (response.statusCode !== 200) {
        resolve( { success: false, httpcode: response.statusCode, message: "Invalid status code" } );
      }

      else {
        let csrftoken = undefined;
        Object.keys(response.headers).forEach((key) => {
          if (key.toLocaleLowerCase() === 'x-fhem-csrftoken') {
            csrftoken = response.headers[key];
          }
        });
        resolve({success: true, httpcode: 200, message: csrftoken});
      }
    });
  });
}

function
FHEM_execute(log,connection,cmd,callback) {
  return new Promise((resolve, reject) => {
    cmd = encodeURIComponent(cmd);
    if (csrfToken)
      cmd += '&fwcsrf=' + csrfToken;
    cmd += '&XHR=1';
    var url = connection.base_url + '?cmd=' + cmd;
    log.info('  executing: ' + url);

    let request = require('request');

    request
      .get(getRequestOptions(connection, url),
        function (err, response, result) {
          if (!err && response.statusCode === 200) {
            result = result.replace(/[\r\n]/g, '');
            resolve(result);
          } else {
            console.log('There was a problem connecting to FHEM (' + url + '): ' + (err ? JSON.stringify(err) : ""));
            if (response)
              reject('  ' + response.statusCode + ': ' + response.statusMessage);
            else
              reject('Unknown problem');
          }

        })
      .on('error', function (err) {
        reject('There was a problem connecting to FHEM (' + url + '):' + err);
      });
  });
}

function getRequestOptions(config, url) {
  const auth = config['auth'];
  let options = config.ssl ? { rejectUnauthorized: false} : {};
  if (auth) {
    if (auth.sendImmediately === undefined)
      auth.sendImmediately = false;
    options = {auth: auth, rejectUnauthorized: false};
  }
  if (url)
    options.url = url;
  return options;
}