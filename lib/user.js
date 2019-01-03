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

function User() {
}
  
User.config = function() {
  return config || (config = Config.load(User.configPath()));
}
  
User.storagePath = function() {
  if (customStoragePath) return customStoragePath;
  var home = process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE;
  return path.join(home, ".alexa");
}

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
