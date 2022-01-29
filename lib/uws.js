'use strict';

const uWS = require('uWebSockets.js');
const EventEmitter = require("events");
const { v4: uuid_v4 } = require('uuid');

const decoder = new TextDecoder('utf-8');

const MESSAGE_ENUM = Object.freeze({
  SELF_CONNECTED: "SELF_CONNECTED",
  CLIENT_AUTHENTICATION: "CLIENT_AUTHENTICATION",
  CLIENT_CONNECTED: "CLIENT_CONNECTED",
  CLIENT_DISCONNECTED: "CLIENT_DISCONNECTED",
  CLIENT_MESSAGE: "CLIENT_MESSAGE",
  IOB_DATA: "IOB_DATA",
  PING: "PING"
});

/**
 * Class representing a WebSocket server.
 *
 * @extends EventEmitter
 */
class IOWebSocket extends EvenEmitter {
  /**
   * Constructor for IOWebSocket server class.
   * @param {*} adapter iobroker adapter
   * @param {*} port websockets server port
   * @param {*} log logging turn on/off
   * @param {*} authSettings object with login and token properties
   */
  constructor(adapter = null, port, log, authSettings = {}) {
    super();

    if ( !(this instanceof IOWebSocket) ) {
      return new IOWebSocket(adapter, port, log);
    }

    if (!adapter) {
      throw new Error("No adapter instance passed to ioWebSocket constructor!")
    }
    this._adapter = adapter;
    this._port = port || 9091;
    this._LOG_ALL = log || false;
    this._authSettings = authSettings || {};
    this._LOGIN = authSettings.login || 'secret_login';
    this._TOKEN = authSettings.token || 'secret_token';
    this.server = null;
    this.SOCKETS = [];

    this.initIOServer();
  }

  /**
   * Initializes uWebSocket server.
   */
  initIOServer() {
    this.server = uWS./*SSL*/App({
      key_file_name: "/etc/letsencrypt/live/your-domain/privkey.pem",
      cert_file_name: "/etc/letsencrypt/live/your-domain/cert.pem",
      //key_file_name: "../../misc/privkey.pem",
      //cert_file_name: "../../misc/cert.pem",
      //passphrase: '1234'
    })
      .ws('/ws', {
        compression: 0,
        maxPayloadLength: 16 * 1024 * 1024,
        idleTimeout: 60,
  
        open: (ws, _req) => {
          if (this._LOG_ALL) this._adapter.log.info('WebSocket connection open!');
          ws.id = uuid_v4();
          ws.username = this._createName(getRandomInt());
          ws.isAuthenticated = false;
  
          // subscribe to CLIENT_AUTHENTICATION topic
          ws.subscribe(MESSAGE_ENUM.CLIENT_AUTHENTICATION);
  
          this.SOCKETS.push(ws);
  
          // SELF_CONNECTED sent to self only ONCE upon ws open
          let selfMsg = {
            type: MESSAGE_ENUM.SELF_CONNECTED,
            body: {
              id: ws.id,
              name: ws.username
            }
          }

          // send to connecting socket only
          ws.send(JSON.stringify(selfMsg));  
        },
        message: this._processMessage(ws, message, isBinary),
        close: this._handleClose(ws, code, message),

      }).listen(this.PORT, (listenSocket) => {
        // listenSocket ?
        // this._adapter.log.info('WebSockets Server listening to port ' + this.PORT) :
        // this._adapter.log.error("WebSockets Server failed to listen to port " + this.PORT);
        if ( listenSocket ) {
          this._adapter.log.info('WebSockets Server listening to port ' + this.PORT)
        } else {
          this._adapter.log.error('WebSockets Server failed to listen to port ' + this.PORT);
        }
      });
  }

  /**
   * Process new websocket message.
   * @param {*} ws websocket
   * @param {*} message
   * @param {*} _isBinary
   */
  _processMessage(ws, message, _isBinary) {
    try {
      if ( !IsValidJsonString(decoder.decode(message)) ) { return; };
      // decode message from client
      let clientMsg = JSON.parse(decoder.decode(message));
      let serverMsg = {};

      switch (clientMsg.type) {
        case MESSAGE_ENUM.CLIENT_AUTHENTICATION:
          if (this._LOG_ALL) this._adapter.log.info('Authentication request sent from client:' + ws.username);
          // {"type":"CLIENT_AUTHENTICATION","body":{"login":"@wsserversecretlogin", "token":"!7fdca2c7ecdc07c00c6edd4566ffee57=="}}

          if ( clientMsg.body.hasOwnProperty("login") && clientMsg.body.hasOwnProperty("token") ) {
            const _login = clientMsg.body.login;
            const _token = clientMsg.body.token;
            if (_login === this._LOGIN && _token === this._TOKEN ) {
              ws.isAuthenticated = true;
              if (this._LOG_ALL) this._adapter.log.info('WebSocket client ' + ws.username +' is authenticated.');
              // clearOpc(ws.mainSubscription); // clear main subscription if exists

              // subscribe to topics
              // ws.subscribe(MESSAGE_ENUM.CLIENT_CONNECTED);
              // ws.subscribe(MESSAGE_ENUM.CLIENT_DISCONNECTED);
              // ws.subscribe(MESSAGE_ENUM.CLIENT_MESSAGE);

              // just use this line
              ws.subscribe(MESSAGE_ENUM.IOB_DATA);

              // create main OPC UA subscription on ws client connection
              /*
              ws.mainSubscription = uaclient.monitorNodes(nodeidConfig.nodeidList, (data) => {
                if (typeof(data) === 'object') {
                  serverMsg = {
                    type: MESSAGE_ENUM.IOB_DATA,
                    sender: "OPCUA_CLIENT",
                    body: data
                  };

                  ws.send(JSON.stringify(serverMsg));
                }
              }); */

            } else {
              if (this._LOG_ALL) this._adapter.log.warn("WebSocket client is not authenticated.");
              ws.isAuthenticated = false;
              // unsubscribe from topics
              // ws.unsubscribe(MESSAGE_ENUM.CLIENT_CONNECTED);
              // ws.unsubscribe(MESSAGE_ENUM.CLIENT_DISCONNECTED);
              // ws.unsubscribe(MESSAGE_ENUM.CLIENT_MESSAGE);
              if (ws.isSubscribed(MESSAGE_ENUM.IOB_DATA)) { 
                ws.unsubscribe(MESSAGE_ENUM.IOB_DATA); 
              };

              // clearOpc(ws.mainSubscription);
              // clearOpc(ws.subscription);
            }

            const _msgBody = ws.isAuthenticated ? 'authenticated' : 'not authenticated';
            serverMsg = {
              type: MESSAGE_ENUM.CLIENT_AUTHENTICATION,
              sender: "IOB_uWebSocket_Server",
              body: _msgBody
            };

            ws.send(JSON.stringify(serverMsg));
          } else {
            ws.close();
          }
          break;
        case MESSAGE_ENUM.CLIENT_MESSAGE:
          if (!ws.isAuthenticated) { return; };

          try {
            if (clientMsg.body.hasOwnProperty("action")) {

                let _msgBody = clientMsg.body;

                if (_msgBody.action === 'getnode') {
                  this._adapter.log.info('Action -getnode- received.');
                  /* clearOpc(ws.subscription); */

                  // { "type":"CLIENT_MESSAGE", "body":{"action":"getnode","nodes":[ "ns=1;s=staticInt", "ns=1;s=randFloat"]} }
                  /*let _config = _msgBody.nodes.filter(d => d);
                  ws.subscription = uaclient.monitorNodes(_config, (data) => {
                    if (typeof(data) === 'object') {
                      serverMsg = {
                        type: MESSAGE_ENUM.IOB_DATA,
                        sender: "OPCUA_CLIENT",
                        body: data
                      };

                      ws.send(JSON.stringify(serverMsg));
                    }
                  });*/
                } else if (_msgBody.action === 'setnode') {
                  this._adapter.log.info('Action -setnode- received.');
                  // use uaclient.write method to set opc ua node
                  // { "type":"CLIENT_MESSAGE", "body":{"action":"setnode","nodeid":"ns=1;s=staticInt","dtype":"Int32","value": 85} }

                  /* uaclient.write(_msgBody.nodeid, _msgBody.dtype, _msgBody.value); */
                } else if (_msgBody.action === 'readnode') {
                  this._adapter.log.info('Action -readnode- received.');
                  // { "type":"CLIENT_MESSAGE", "body":{"action":"readnode","nodeid":"ns=1;s=staticInt"} }
                  /*
                  uaclient.readOpcNode(_msgBody.nodeid, (point)=> {
                    //xx if (LOG_ALL) console.log('argument point = ', point);
                    if (ws.isSubscribed(MESSAGE_ENUM.IOB_DATA)) {
                      serverMsg = {
                        type: MESSAGE_ENUM.IOB_DATA,
                        sender: "OPCUA_CLIENT",
                        body: point
                      };    
                      ws.send(JSON.stringify(serverMsg));
                    }
                  });*/

                } else {
                  if (this._LOG_ALL) this._adapter.log.info('Unknown action received over ws...');
                }
            } else {
              return;
            }
          } catch(e) {
            this._adapter.log.error('Error CLIENT_MESSAGE composition: ', e);
          }
          /*
          serverMsg = {
            type: MESSAGE_ENUM.CLIENT_MESSAGE,
            sender: ws.username,
            body: clientMsg.body
          };
    
          app.publish(MESSAGE_ENUM.CLIENT_MESSAGE, JSON.stringify(serverMsg));
          */
          break;
        case MESSAGE_ENUM.PING:
          if (this._LOG_ALL) this._adapter.log.info('PING request received.');
          // received msg looks like: {"type":"PING","body":"pinging"}
          // ping requests should be received each 50000 ms
          serverMsg = {
            type: MESSAGE_ENUM.PING,
            sender: "IOB_uWebSocket_Server",
            body : "PONG"
          };
          if (ws.isAuthenticated) {
            ws.send(JSON.stringify(serverMsg));
            if (this._LOG_ALL) this._adapter.log.info('PONG sent.');
          }
          break;
        default:
          if (this._LOG_ALL) this._adapter.log.warn('Unknown message type.');
          // ws.close();
      }  // end of switch statement
    } catch (e) {
      this_adapter.log.error(e);
    }
  }

  /**
   * Handle websocket connection closing.
   * @param {*} ws websocket
   * @param {*} _code
   * @param {*} _message
   */
   _handleClose(ws, _code, _message) {
    if (this._LOG_ALL) this._adapter.log.info('WebSocket connection from ' + ws.username + ' is closed.');
    // clearOpc(ws.mainSubscription);
    // clearOpc(ws.subscription);
    
    ws.isAuthenticated = false;
    ws.mainSubscription = null;
    ws.subscription = null;
    /* The library guarantees proper unsubscription at close */
    this.SOCKETS.find((socket, index) => {
      if (socket && socket.id === ws.id) {
        this.SOCKETS.splice(index, 1);
      }
    });

    /*let pubMsg = {
      type: MESSAGE_ENUM.CLIENT_DISCONNECTED,
      body: {
        id: ws.id,
        name: ws.username
      }
    }
  
    app.publish(MESSAGE_ENUM.CLIENT_DISCONNECTED, JSON.stringify(pubMsg)); */
  }

  /**
   * Creates new ws username
   * @param {*} rndInt random integer number
   */
  _createName(rndInt) {
    return this.SOCKETS.find( (socket)=> socket.name === `user-${rndInt}`) ? 
    this._createName(getRandomInt()) : 
    `user-${rndInt}`
  }
}

module.exports = IOWebSocket;


// helper function for random number generation
function getRandomInt() {
  return Math.floor(Math.random() * Math.floor(9999));
}

// helper function to validate JSON string
function IsValidJsonString(str) {
  try {
      JSON.parse(str);
      return true;
  } catch (e) {
      if (this._LOG_ALL) this._adapter.log.warn('This is not valid JSON string!');
      return false;
  }
}