
var path = require('path');
var os = require('os');
var fs = require('fs');
var FHEM = require('./fhem').FHEM;
var Logger = require('./logger').Logger;
var version = require('./version');

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
var homedir = undefined;

var log = require("./logger")._system;

function User() {
}

User.config = function() {
  return config || (config = Config.load(User.configPath()));
}

User.getHomedir = function () {
  if (homedir) return homedir;
  const srcNames = [ "os.homedir()", "process.env.HOME", "process.env.HOMEPATH", "process.env.USERPROFILE", "process.env.PWD" ];
  for (let src of srcNames) {
    const val = eval(src);
    log.info(src + "=" + val);
    if (val) {
      try {
        fs.accessSync(val, fs.constants.W_OK);
        homedir = val;
        return homedir;
      } catch (e) {
        log.warn(src + " set to " + val + ", but this is not writable");
      }
    }
  }
  log.error("No suitable, writable users home directory found")
};

User.storagePath = function() {
  if (customStoragePath) return customStoragePath;
  return path.join(this.getHomedir(), ".alexa");
};

User.sshKeyPath = function() {
  return path.join(this.getHomedir(), ".ssh");
};

User.configPath = function() {
  if( customConfigFile !== undefined ) {
    if( path.basename( customConfigFile ) !== customConfigFile ) // path is included
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
User.autoConfig = function (interactive, config, fhemconn, alexaDevName) {
  return new Promise(function (resolve, reject) {
    (async () => {
      let finalRes;
      let finalErr;
      finalRes = await runAutoconfig(interactive, config, fhemconn, alexaDevName).catch((r)=>{
        finalErr=r.toString();
      });
      if (finalErr) finalRes = finalErr;
      if (finalRes && typeof finalRes === "string") {
        log.error("sshautoconf: aborted with " + finalRes);
        reject(finalRes);
      } else {
        log.info("sshautoconf: completed successfully");
        resolve(finalRes);
      }
    })();
  })
};

const crypto = require('crypto');

var csrfToken;
var alexaDeviceName;

const BEARERTOKEN_NAME = "alexaFHEM.bearerToken";
const SKILLREGKEY_NAME = "alexaFHEM.skillRegKey";


async function runAutoconfig(interactive, config, fhemconn, alexaDevName) {
  const spath = User.storagePath();

  // FIRST STEP: Check for config.json and build up one, if missing
  const readline = interactive ? require('readline-sync') : {
    question: function () {
      return ""
    }
  };
  const writeout = interactive ? (a) => {
    console.log(a)
  } : (a) => { log.info ("sshautoconf: " + a)
  };
  let dirty = false; // Did we modify an existing config.json ?
  writeout ("home=" + User.getHomedir() + ", spath=" + spath + ", cpath=" + User.configPath() + ", sshpath="+User.sshKeyPath());
  if (!fs.existsSync(spath)) {
    writeout("env=" + JSON.stringify(process.env));
    writeout("Creating directory " + spath);
    try {
      fs.mkdirSync(spath, 0o700);
    } catch (e) {
      return 'Cannot create ' + spath + ": " + e;
    }
  }
  let conn = undefined;
  let goon;

  try {
    if (!config) {
      const configPath = User.configPath();
      config = {};
      if (!fs.existsSync(configPath)) {
        if (fs.existsSync("./config-sample.json")) {
          writeout(configPath + " not existing, creating from ../config-sample.json");
          try {
            config = JSON.parse(fs.readFileSync("./config-sample.json"));
          } catch (e) {
            writeout("... which is broken JSON, so from the scratch anyways...");
          }
        } else {
          writeout("config.json not existing, creating from the scratch");
        }
        dirty = true;
      } else {
        try {
          config = JSON.parse(fs.readFileSync(configPath));
          dirty = false;
        } catch (e) {
          writeout("... which is broken JSON, so from the scratch anyways...");
        }
      }
      if (!config.hasOwnProperty('sshproxy')) {
        config.sshproxy = {}
      }
      if (!config.hasOwnProperty('connections')) {
        config.connections = []
      } else {
        let hadUid = false;
        let wasEqual = false;
        for (const c of config.connections) {
          if (c.uid) {
            hadUid = true;
            wasEqual |= (c.uid === process.getuid());
          }
        }
        if (hadUid && !wasEqual) {
          writeout("WARNING! Your userid is " + process.getuid() + ", but FHEM seems to be running with id " +
            config.connections[0].uid);
          writeout("This is nearly guaranteed to cause problems. Please run bin/alexa -A from a shell with");
          writeout("user-permissions, e.g. by using:");
          writeout("  sudo -u #" + config.connections[0].uid + " /bin/bash");
          goon = readline.question("If you really want to continue, type 'cont', otherwise let us stop here [cont/N] ");
          if (goon !== 'cont')
            return 'Stopping on invalid uid';
        }
      }

      // Default settings for alexa-fhem
      if (!config.sshproxy.hasOwnProperty('name')) {
        config.sshproxy.name = 'sshproxy';
        dirty = true
      }
      if (!config.sshproxy.hasOwnProperty('bind-ip')) {
        config.sshproxy['bind-ip'] = '127.0.0.1';
        dirty = true
      }
      if (!config.sshproxy.hasOwnProperty('ssl')) {
        config.sshproxy.ssl = false;
        dirty = true
      }
      if (!config.sshproxy.hasOwnProperty('ssh')) {
        ['/bin', '/usr/bin', '/usr/local/bin'].forEach(d => {
          if (fs.existsSync(d + '/ssh')) {
            config.sshproxy.ssh = d + '/ssh';
            dirty = true;
          }
        });
      } else {
        if (config.sshproxy.ssh !== config.sshproxy.ssh.trim()) {
          config.sshproxy.ssh = config.sshproxy.ssh.trim();
          dirty = true;
        }
      }

      // Search for FHEM, if no connections..
      let longpollBackup = 'longpoll';
      if (config.connections.length === 0) {
        dirty = true;
        const conn = {
          server: '127.0.0.1',
          port: 8083,
          name: 'FHEM',
          filter: 'alexaName=...*',
          longpoll: 'none'
        };
        config.connections.push(conn);
      } else {
        longpollBackup = config.connections[0].longpoll;
        config.connections[0].longpoll = 'none';
      }
      conn = config.connections[0];

      var retry = true; // Well, at least a first try...
      let failmsg;

      while (retry) {
        writeout("Trying fhem");
        failmsg = undefined;
        var fhem;
        let testReq = {};
        try {
          let failrsp = undefined;
          fhem = new FHEM(Logger.withPrefix("test"), conn, undefined, "nopoll");
          testReq.success = true;
          testReq.message = await FHEM_execute(fhem, "help").catch((e) => {
            if (e && e.statusCode) {
              writeout("attempt #1: " + JSON.stringify(e));
              testReq.httpcode = e.statusCode;
              if (e.statusCode === 400) {
                // Bad request because of csrf - token is okay
                failrsp = 'Empty because of missing csrf?';
              } else {
                testReq.success = false;
              }
            } else {
              writeout("attempt #2: " + JSON.stringify(e));
              testReq.success = false;
              failrsp = e;
            }
          });
          if (failrsp)
            testReq.message = failrsp;
        } catch (e) {
          writeout(e);
        }
        /*
          await buildRequest(conn).catch(any => {
          writeout(any)
        });
        */

        if (!testReq.success) {
          let url = (conn.ssl ? "https" : "http") + "://" + conn.server + ":" + conn.port + "/" + (conn.webname ? conn.webname : "fhem/");
          if (testReq.hasOwnProperty("httpcode")) {
            switch (testReq.httpcode) {
              case 401:
                if (!conn.auth || !conn.auth.user) {
                  writeout('FHEM seems to be username/password protected. Please provide the authentication settings.');
                  writeout('(Username & password will be stored unencrypted in the ~/.alexa/config.json file - sorry)');
                } else {
                  writeout("Username ('" + conn.auth.user + "') or password seems to be incorrect. Pls. retry:");
                }
                if (interactive) {
                  const user = readline.question("Username in the Webfrontend: ");
                  const pass = readline.question("Password in the Webfrontend: ");
                  conn.auth = {user: user, pass: pass};
                  dirty = true;
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
            writeout("Problem message: " + failmsg);
            writeout("Please copy&paste a working URL for FHEM from your browser to the prompt, or just type");
            writeout("[Enter] to manually fix the config file!");
            const workingUrl = readline.question("FHEM-URL: ");
            if (workingUrl.length < 3) {
              retry = false;
            } else {
              const url = require('url');
              const wurl = url.parse(workingUrl);
              conn.ssl = (wurl.protocol === 'https:');
              conn.server = wurl.hostname;
              if (!wurl.port || wurl.port.length === 0)
                conn.port = conn.ssl ? 443 : 80;
              else
                conn.port = parseInt(wurl.port);
              if (wurl.username || wurl.password) {
                conn.auth = {user: wurl.username, pass: wurl.password};
              }
              if (wurl.pathname !== '/fhem' || conn.webname)
                conn.webname = wurl.pathname.substring(1);
              retry = true;
              dirty = true;
            }
          } else
            retry = false;
          config.connections[0] = conn;

        } else {
          // Connectivity to FHEM given...
          fhemconn = fhem;
          writeout("FHEM-Connectivity fine");
          retry = false;
        }
      }
      if (failmsg)
        return failmsg;

      if (dirty) {
        config.connections[0].longpoll = longpollBackup;
        writeout("config.json to write:\n" + JSON.stringify(config, null, 2));
        goon = readline.question("Okay to write about file to " + configPath + "? [Hit Enter for okay, 'n' else] ");
        if (goon !== 'n') {
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        }
      } else {
        writeout("existing config.json seems fine");
      }
    } else {
      // config passed as argument - non-interactive mode, default config by 39_alexa.pm
      log.info("Passed config: " + JSON.stringify(config));
      if (config.sshproxy.ssh)
        config.sshproxy.ssh = config.sshproxy.ssh.trim();
    }

    // NEXT STEP: Generate SSH key if not yet done
    let stat = fs.statSync(User.getHomedir());
    if (stat && (stat.mode & (fs.constants.S_IWGRP | fs.constants.S_IWOTH ))>0) {
      writeout('*** Error: Your Homedirectory is writable by group/other. This will not work with SSH');
      return "user homedir writable by group/other ('chmod 755 " + User.getHomedir() + "' required)";
    }
    /*
    stat = fs.statSync(User.sshKeyPath());
    if (stat && (stat.mode & (fs.constants.S_IRWXG | fs.constants.S_IRWXO ))>0) {
      writeout('*** Error: Your home .ssh directory is visible for group/other. This will not work with SSH');
      return "users sshdir not protected by group/other";
    } */
    let pubkey_path = path.join(User.sshKeyPath(), 'id_rsa');
    //let pubkey_path = path.join(User.sshKeyPath(), 'id_ed25519');
    if (!fs.existsSync(pubkey_path)) {
      if (fs.existsSync(config.sshproxy.ssh + '-keygen')) {
        writeout('No SSH public key found, we have to generate one.');
        goon = readline.question("Okay to generate SSH-Key in " + User.sshKeyPath() + "? [Hit Enter for okay, 'n' else] ");
        if (goon !== 'n') {
          const execSync = require('child_process').spawnSync;
          const prc = execSync(config.sshproxy.ssh + '-keygen', ['-t', 'rsa', '-b', 4096, '-N', '', '-f', pubkey_path], {stdio: 'pipe'});
          //const prc = execSync(config.sshproxy.ssh + '-keygen',  ['-t', 'ed25519', '-N', '', '-f', pubkey_path], { stdio: 'pipe'});
          if (prc.error) {
            return "Error on executing ssh-keygen: " + prcStatus.error.message;
          }
          if (prc.status !== 0)
            return "ssh-keygen returned error - " + (prc.output[2].toString());
          writeout(prc.output[1].toString());
        } else {
          return 'Without a private SSH key, connection setup will not work. Please create an SSH key manually.';
        }
      } else {
        return 'ssh-keygen command not found, please check if your installation of SSH is complete.';
      }
    } else {
      writeout("SSH key seems to exist");
      stat = fs.statSync(pubkey_path);
      if (stat && (stat.mode & (fs.constants.S_IRWXG | fs.constants.S_IRWXO ))>0) {
        writeout('*** Error: Your SSH key is visible for group/other. This will not work with SSH');
        return "users ssh key not protected by group/other ('chmod 600 " + pubkey_path + "' required)";
      }
    }
    //config.sshproxy.options = [ '-i', pubkey_path, '-p', 55824, 'fhem-va.fhem.de' ];

    // NEXT STEP: Register SSH key at server

    if (fs.existsSync(pubkey_path)) {
      const execSync = require('child_process').spawnSync;

      // Most likely initial SSH call: Avoid prompt for adding HostKey
      const prcStatus = execSync(config.sshproxy.ssh,
        [ '-o', 'StrictHostKeyChecking=no'].concat(config.sshproxy.options).concat(
          [ 'status', 'version='+version ]
        ),  {stdio: 'pipe'});
      if (prcStatus.error) {
        return "Error on executing ssh: " + prcStatus.error.message;
      }
      let registrationStatus = prcStatus.output[1].toString();
      const sshKeyIsRegistered = (registrationStatus.indexOf('Registered') === 0);
      if (sshKeyIsRegistered)
        writeout('Our SSH key is known at the reverse proxy, good!');
      else {
        if (registrationStatus.indexOf('Unregistered') !== 0) {
          return "Reverse Proxy replied with neither registered nor unregistered status: " +
            "out: " + prcStatus.output[1] + " err:" + prcStatus.output[2];
        }
      }

      // Search for Device MyAlexa (TYPE=alexa) and create if not existing
      let s_str = await FHEM_execute(fhemconn, alexaDevName ? "jsonlist2 " + alexaDevName : "jsonlist2 TYPE=alexa").catch(
        a => writeout("ERROR" + a));

      let s_json;
      try {
        s_json = JSON.parse(s_str);
        if (s_json.totalResultsReturned < 1) {
          await FHEM_execute(fhemconn, "define alexa alexa");
          s_str = await FHEM_execute(fhemconn, "jsonlist2 TYPE=alexa").catch(
            a => writeout("ERROR" + a));
          s_json = JSON.parse(s_str);
        }
      } catch (e) {
        return "Trying to fetch alexadevice failed with " + e;
      }
      let alexaDevice = s_json.Results[0];
      const alexaDevHasStart = !!(alexaDevice.PossibleSets &&
        alexaDevice.PossibleSets.indexOf("start:") >= 0 &&
        alexaDevice.PossibleAttrs &&
        alexaDevice.PossibleAttrs.indexOf('alexaFHEM-cmd'));
      log.info('39_alexa.pm is new version: ' + alexaDevHasStart);

      let userIdProxy = undefined;

      if (!alexaDevice.Readings.hasOwnProperty(BEARERTOKEN_NAME) || !sshKeyIsRegistered) {

        var registrationKey = undefined;
        var bearerToken = undefined;

        if (interactive) {
          if (!sshKeyIsRegistered) {
            writeout("Your SSH key needs to get registered. Please read the privacy instructions here:");
            writeout("  https://va.fhem.de/privacy/");
            writeout("... and the press Enter to register your key.");
            goon = readline.question("Okay to register your public SSH-Key at fhem-va.fhem.de? [Hit Enter for okay, 'n' else] ");
          } else {
            writeout("Although your SSH key is known at the reverse proxy, I was unable to find the bearerToken.");
            writeout("(Did you probably forget to save the FHEM configuration in the web frontend?)");
            writeout("You have 2 options to recover the service:");
            writeout("  1) Create a new registration key, unlink the skill in Alexa and reinstall it");
            writeout("  2) Enter your old licence key, if you saved it.");
            writeout("or enter 'a' to abort....");
            while (true) {
              goon = readline.question("Your choice? ");
              if (goon === 'a') return "Aborting without a recreated key";
              if (goon === '1') break;
              if (goon === '2') {
                registrationKey = readline.question("Your registration key?: ").trim();
                const regexp = /^([0-9A-F]+)-([0-9A-F]{14,16})-([0-9A-F]{14,16})$/m;
                const match = regexp.exec(registrationKey);
                if (match) {
                  bearerToken = match[3];
                  break;
                } else {
                  writeout("This does not look like a registration key.");
                }
              }
            }
          }
        }
        if (goon !== 'n') {

          if (!registrationKey || !sshKeyIsRegistered) {
            const hash = crypto.createHash('sha256');
            // This is only for our side:
            const registrationRandomBytes = crypto.randomBytes(8);
            const registrationRandomHash = hash.update(registrationRandomBytes).digest('hex');
            let bearerTokenRandomBytes = crypto.randomBytes(8);
            bearerToken = bearerTokenRandomBytes.toString('hex').toUpperCase();

            const prc = execSync(config.sshproxy.ssh,
              ['-oStrictHostKeyChecking=no'].concat(config.sshproxy.options).concat(
              ['register', 'keyhash=' + registrationRandomHash]), {stdio: 'pipe'});
            let registrationResult = prc.output[1].toString();
            //writeout(registrationStatus);
            const regexp = /\s+([0-9A-F]+)-\.\./m;
            const match = regexp.exec(registrationResult);
            // Build new registration key, if a bearer token is existing, use this one (otherwise the
            // skill has to be reregistered at Amazon).
            registrationKey = match[1] + '-' +
              registrationRandomBytes.toString('hex').toUpperCase() + '-' +
              bearerToken;
          }

          var rollback = false;
          try {
            await FHEM_execute(fhemconn, "set " + alexaDevice.Name + " proxyToken " + bearerToken).catch((e) => {
              rollback = true;
              return 'Unable to write proxyToken: ' + e.toString();
            });
            await FHEM_execute(fhemconn, "set " + alexaDevice.Name + " proxyKey " + registrationKey).catch((e) => {
              rollback = true;
              return 'Unable to write proxyKey: ' + e.toString();
            });
          } finally {
            if (rollback && registrationKey) {
              // Writing the key went wrong, unregister...
              const prc = execSync(config.sshproxy.ssh, ['-p', 58824, '-i', '~/.ssh/id_rsa', 'fhem-va.fhem.de', 'unregister'], {stdio: 'pipe'});
            }
          }
          if (interactive)
            await FHEM_execute(fhemconn, "{ FW_directNotify(\"#FHEMWEB:WEB\", \"location.reload('true')\", \"\") }");
          else {
            setTimeout(() => {
              FHEM_execute(fhemconn, "{ FW_directNotify(\"#FHEMWEB:WEB\", \"location.reload('true')\", \"\") }").catch(
                (e) => {
                  log.info("Sending reload-event failed: " + e);
                }
              )
            }, 1500);
          }

        } else {
          return "Unable to continue without a registered SSH key.\r\n";
        }
      }

      // create Alexa start/stop stuff if not yet existing
      if (registrationKey && interactive) {
        writeout("\r\nThis is your registration key:\r\n\r\n");
        writeout(">>>>>>>>>        " + registrationKey + "        <<<<<<<<\r\n\r\n");
        writeout("You will need it when activating the skill in the Alexa-App.\r\n" +
          "Please copy & paste it NOW to a safe place, then press Enter continue!\r\n");
        readline.question("Copied the key? [Hit Enter to continue, you are done]");
      }
      // TODO: might be legacy in future
      if (bearerToken) {
        return {"bearerToken": bearerToken};
      }
    }
    if (interactive) {
      while (true) {
        const a = readline.question("We are done - start the server from commandline?\n" +
          "(Better way would be to continue via FHEM-WEB, unless you are debugging) [y/N] ");
        if (a === 'y')
          return undefined;
        if (a === 'n' || a === '')
          return "User request";
      }
    }
  } catch (e) {
    writeout(e);
    return e;
  }
}

// Invokes FHEM connection with a cmd and returns JSON
function FHEM_execute(fhemconn, cmd) {
  return new Promise((resolve, reject) => {
    fhemconn.execute(cmd, resolve.bind(this), reject.bind(this));
  });
}
