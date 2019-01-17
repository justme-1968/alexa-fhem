var fs = require('fs');
var path = require('path');

'use strict';

module.exports = getVersion();

var version = undefined;

function getVersion() {
  if (! version) {
    var packageJSONPath = path.join(__dirname, '../package.json');
    var packageJSON = JSON.parse(fs.readFileSync(packageJSONPath));
    version = packageJSON.version;
  }
  return version;
}
