
const PORT= process.env.port || 3000;
const HOST= process.env.host || 'mein.host.name';


// entry
exports.handler = function(event, context, callback) {

  //console.log(event);
  //console.log(context);

  var post_data = JSON.stringify(event);

  var options = {
    hostname: HOST,
    port: PORT,
    //family: 6,
    //path: '/',
    method: 'POST',
    rejectUnauthorized: false, // accept self-signed
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(post_data)
    }
  };

  var request = require('https').request(options, (result) => {
    console.log(`STATUS: ${result.statusCode}`);
    console.log(`HEADERS: ${JSON.stringify(result.headers)}`);
    result.setEncoding('utf8');
    var body = '';
    result.on('data', (chunk) => body += chunk);
    result.on('end', () => {
      console.log(`BODY: ${JSON.stringify(body)}`);
      callback(null, JSON.parse(body) );
      return;
    });
  });

  request.on('error', (e) => {
    console.log(`problem with request: ${e.message}`);

    var error;
    if( event.directive )
      error = { "event": {
                  "header": createHeader("Alexa", "ErrorResponse", event),
                  "endpoint": event.directive.endpoint,
                  "payload": {
                    "type": "BRIDGE_UNREACHABLE",
                    "message": "Bridge appears to be offline: "+ e.message }
                },
              };
      else
        error = { "header": createHeader("Alexa.ConnectedHome.Control", "BridgeOfflineError"),
                  "payload": {} };

    callback(undefined, error);
    return;
  });

  request.write(post_data);
  request.end();

  return;

}// exports.handler

var createMessageId = function() {
  var d = new Date().getTime();
  var uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = (d + Math.random()*16)%16 | 0;
    d = Math.floor(d/16);
    return (c=='x' ? r : (r&0x3|0x8)).toString(16);
  });

  return uuid;
}; // createMessageId

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
}; // createHeader
