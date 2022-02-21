'use strict';

const uWS = require('uWebSockets.js');
const EventEmitter = require('events');
const { v4: uuid_v4 } = require('uuid');
const _os = require("os");

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
class IOWebSocketSrv extends EventEmitter {
  /**
   * Constructor for IOWebSocketSrv server class.
   * @param {*} adapter iobroker adapter
   * @param {*} port websockets server port
   * @param {*} log logging turn on/off
   * @param {*} authSettings object with login and token properties
   */
  constructor(adapter = null, port, log, authSettings = {}) {
    super();

    if ( !(this instanceof IOWebSocketSrv) ) {
      return new IOWebSocketSrv(adapter, port, log, authSettings);
    }

    if (!adapter) {
      throw new Error("No adapter instance passed to IOWebSocketSrv constructor!")
    }
    this._adapter = adapter;
    this._port = port || 9099;
    this._LOG_ALL = log || false;
    this._authSettings = authSettings || {};
    this._LOGIN = authSettings.login || 'secret_login';
    this._TOKEN = authSettings.token || 'secret_token';

    this.server = null;
    this.listenSocket = null; // we will store the listen socket from uWS server here, so that we can shut it down later
    this.SOCKETS = new TrackedSockets();
    this.subscriptionsHolder = new Map(); // global list with subscriptions
  }

  /**
   * @method initIOServer
   * Initializes uWebSocket server.
   */
  initIOServer() {
    this._adapter.log.info('[initIOServer] initializing uWS server');

    const bufferToString = buf => new Uint8Array(buf).slice(12, 16).join('.');
    const getIpAddress = (res, req) => (req && req.getHeader('x-forwarded-for')) || bufferToString(res.getRemoteAddress());

    this.server = uWS./*SSL*/App({
    }).ws('/ws', {
        compression: 0,
        maxPayloadLength: 16 * 1024 * 1024,
        idleTimeout: 60,
  
        open: (ws, req) => {
          if (this._LOG_ALL) this._adapter.log.info('WebSocket connection open!');

          // extract client IP address from ws object
          ws.ip = getIpAddress(ws, req);

          const connectionId = uuid_v4();
          ws.id = connectionId;
          const socket = new IOSocketC(this._adapter, ws, this._LOG_ALL, connectionId);
          socket._ws.username = this._createName(getRandomInt());
          socket.isAuthenticated = false;

          socket._ws.subscribe(MESSAGE_ENUM.SELF_CONNECTED);
          socket._ws.subscribe(MESSAGE_ENUM.CLIENT_AUTHENTICATION);
  
          this.SOCKETS.sockets.push(socket);
          this.emit('new_socket', socket);
  
          // SELF_CONNECTED sent to self only ONCE upon ws open
          socket.send(MESSAGE_ENUM.SELF_CONNECTED, "me", {id: socket._ws.id, name: socket._ws.username});

          // call subscribeForeignState if adapter is not already subscribed to this state
          // this method (callback) is internally called from IOSocketC class object
          // This can be done because classes and methods are mutable objects (changeable object), which can be modified after it is created.
          socket.onForeignStateSubscribe = (s, id) => {
            if ( !this.subscriptionsHolder.has(id) ) {
              this._adapter.subscribeForeignStates(id);
              this.subscriptionsHolder.set(id, [ s.connectionId ]);
              this.emit('foreignSubscribe', id);

            } else if ( this.subscriptionsHolder.has(id) && this.subscriptionsHolder.get(id) !== undefined &&
                        Array.isArray(this.subscriptionsHolder.get(id)) && (this.subscriptionsHolder.get(id).length === 0)
              ) {
              this._adapter.subscribeForeignStates(id);
              const subs = this.subscriptionsHolder.get(id);
              subs.push(s.connectionId);
              this.subscriptionsHolder.set(id, subs);
              this.emit('foreignSubscribe', id);

            } else {
              // key already exists in map, and there is active subscription
              const existingSubscribers = this.subscriptionsHolder.get(id);
              this.subscriptionsHolder.set(id, [...existingSubscribers, s.connectionId]);
            }

            // this.showStateSubscribers();
          }

          // ---------------- Subscribed state changed reporting ----------------
          // each socket exposes the callback that is executd every time subscribed state has changed
          // callback receives state id and state data
          // subscribe to it to report/send state change to websocket client
          // this callback is internally called from IOSocketC class object
          // This can be done because classes and methods are mutable objects (changeable object), which can be modified after it is created.
          socket.onStateChangeReported = (id, state) => {
            // this._adapter.log.info('[initIOServer][open:] subscribed state has been changed');

            // reporting state change to websocket client
            const result = {
              err: null,
              state: {
                id,
                value: state.val,
                ack: state.ack,
                timestamp: new Date(state.ts).toISOString(),
                q: state.q,
                from: state.from,
                user: state.user,
                lastchange: new Date(state.lc).toISOString()
              }
            }
            socket.send(MESSAGE_ENUM.IOB_DATA, "IOB_uWebSocket_Server", result);
          }

          // ---------------- Foreign state unsubscribing  ----------------
          // in this method we should check if any other socket is subscribed for this state
          // if not, adapter should unsubscribe from listening of this state changes
          // callback receives socket object (s) and state id (id)
          socket.onForeignStateUnsubscribeReported = (s, id) => {
            if ( !this.subscriptionsHolder.has(id) ) {
              this._adapter.log.warn(`There is no subscription for state with id: ${id}`);
              return;
            }

            let existingSubscribers;
            let tempArr = [];

            // get existing subscribers for this stateId
            existingSubscribers = this.subscriptionsHolder.get(id); // this should be array

            for (let i = 0 ; i < existingSubscribers.length ; i++) {
              if (existingSubscribers[i] !== s.connectionId) {
                tempArr.push(existingSubscribers[i]);
              }
            }
            existingSubscribers = [...tempArr];

            if ( existingSubscribers.length === 0 ) {
              // there are no any subscriber that is listening for this state changes
              this._adapter.unsubscribeForeignStates(id);
              this.subscriptionsHolder.delete(id);
              this.emit('foreignUnsubscribe', id);
            } else {
              // existingSubscribers array is reduced
              this.subscriptionsHolder.set(id, existingSubscribers);
            }

            // print state subscribers
            //this.showStateSubscribers();
          }
        },
        message: this._processMessage.bind(this),
        close: this._handleClose.bind(this),

      }).get('/*', (res, req) => {
          res.end('Welcome to super fast realtime server !');
      }).listen(this._port, (token) => {
        // Save the listen socket for later shut down
        this.listenSocket = token;
        /* Did we even manage to listen? */
        if (token) {
          this._adapter.log.info('Listening to port ' + this._port);
          // if (this._LOG_ALL) this._adapter.log.info('Emitting connected...');
          this.emit('connected', true);
        } else {
          this._adapter.log.info('Failed to listen to port ' + this._port);
          this.emit('connected', false);
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
    let _that = this;
    const existingSocket = this.SOCKETS.findSocket(ws.id);

    if (!existingSocket) {
      if (this._LOG_ALL) this._adapter.log.error('Existing socket was not found ! New message will be disregarded');
      return;
    }

    try {
      if ( !this._IsValidJsonString(decoder.decode(message)) ) { return; };
      // decode message from client
      let clientMsg = JSON.parse(decoder.decode(message));
      this.emit('message', {username: existingSocket._ws.username, msg: clientMsg});
      let oldUsername = null;

      switch (clientMsg.type) {
        case MESSAGE_ENUM.CLIENT_AUTHENTICATION:
          if (this._LOG_ALL) this._adapter.log.info('Authentication request sent from client: ' + existingSocket._ws.username);

          if ( clientMsg.body.hasOwnProperty("login") && clientMsg.body.hasOwnProperty("token") ) {
            const _login = clientMsg.body.login;
            const _token = clientMsg.body.token;
            if (_login === this._LOGIN && _token === this._TOKEN ) {
              existingSocket.isAuthenticated = true;
              if (this._LOG_ALL) this._adapter.log.info('WebSocket client ' + existingSocket._ws.username +' is authenticated.');

              if ( clientMsg.body && clientMsg.body.username ) {
                oldUsername = existingSocket._ws.username;

                existingSocket._ws.username = clientMsg.body.username;
                if (this._LOG_ALL) this._adapter.log.info(`Username changed from ${oldUsername} to ${existingSocket._ws.username}`);

                oldUsername = "";
              }

              existingSocket.unsubscribeAllStates();

              existingSocket._ws.subscribe(MESSAGE_ENUM.IOB_DATA);
              existingSocket._ws.subscribe(MESSAGE_ENUM.PING);

            } else {
              if (this._LOG_ALL) this._adapter.log.warn("WebSocket client is not authenticated.");
              existingSocket.isAuthenticated = false;
              if (existingSocket._ws.isSubscribed(MESSAGE_ENUM.IOB_DATA)) { 
                existingSocket._ws.unsubscribe(MESSAGE_ENUM.IOB_DATA); 
              };
              if (existingSocket._ws.isSubscribed(MESSAGE_ENUM.PING)) { 
                existingSocket._ws.unsubscribe(MESSAGE_ENUM.PING); 
              };

              existingSocket.unsubscribeAllStates();
            }

            const _msgBody = existingSocket.isAuthenticated ? 'authenticated' : 'not authenticated';
            existingSocket.send(MESSAGE_ENUM.CLIENT_AUTHENTICATION, "IOB_uWebSocket_Server", _msgBody);
          } else {
            existingSocket.disconnect(); // should we do this or NOT !!?
          }
          break;
        case MESSAGE_ENUM.CLIENT_MESSAGE:
          if (!existingSocket.isAuthenticated) { return; };

          try {
            if (clientMsg.body.hasOwnProperty("action")) {

                let _msgBody = clientMsg.body;

                if (_msgBody.action === 'monitorstates') {
                  if (!_msgBody.states) {
                      if (this._LOG_ALL) this._adapter.log.warn('No states array provided in monitorstates request');
                      return;
                  }
                  // first, unsubscribe from existing states
                  existingSocket.unsubscribeAllStates();

                  // subscribe to new states
                  let _mStatesConfig = _msgBody.states.filter( d=> d);
                  // subscribe for heartBeat signal automatically
                  _mStatesConfig.push(this._adapter.namespace + ".variables" + ".heartBeat");

                  existingSocket.multipleStatesSubscribe(_mStatesConfig);

                } else if (_msgBody.action === 'setState') {

                  existingSocket.setStateValue(_msgBody.id, _msgBody.value, (err, res)=> {
                    if (err) {
                      this._adapter.log.error(err);
                    }
                  });
                
                } else if (_msgBody.action === 'unsubscribe') {

                  if (!_msgBody.states) {
                    if (this._LOG_ALL) this._adapter.log.warn('No states array provided in unsubscribe request');
                    return;
                  }
                  let statesToUnsubscribe = _msgBody.states.filter( d=> d);
                  for ( let idx = 0; idx < statesToUnsubscribe.length; idx++) {
                    existingSocket.stateUnsubscribe(statesToUnsubscribe[idx], existingSocket.connectionId);
                  }

                } else if (_msgBody.action === 'readstate') {

                  try {
                    existingSocket.readSingleState(_msgBody.stateid, (point)=> {
                      if (point && !point.err) {
                        existingSocket.send(MESSAGE_ENUM.IOB_DATA, "IOB_uWebSocket_Server", point);
                      } else {
                        point && point.err && this._adapter.log.error(point.err);
                        existingSocket.send(MESSAGE_ENUM.IOB_DATA, "IOB_uWebSocket_Server", {err: point.err.message});
                      }
                    });
                  } catch(e) {
                    this._adapter.log.error(e);
                  }

                } else if (_msgBody.action === 'getSystemInfo') {

                  existingSocket.getSystemInformation();

                } else {
                  if (this._LOG_ALL) this._adapter.log.info('Unknown action received over ws...');
                }
            } else {

              return;

            }
          } catch(e) {
            this._adapter.log.error('[_processMessage] Error CLIENT_MESSAGE composition: ' + e);
          }
          break;
        case MESSAGE_ENUM.PING:
          if (existingSocket.isAuthenticated) {
            existingSocket.send(MESSAGE_ENUM.PING, "IOB_uWebSocket_Server", "PONG");
          }
          break;

        default:
          if (this._LOG_ALL) this._adapter.log.warn('Unknown message type.');
          existingSocket.disconnect();
      }  // end of switch statement
    } catch (err) {
      this._adapter.log.error(`[_processMessage] ${err}`);
    }
  }

  /**
   * Handle websocket connection closing.
   * @param {*} ws websocket
   * @param {*} _code
   * @param {*} _message
   */
   _handleClose(ws, _code, _message) {
    // let _that = this;
    const closingSocket = this.SOCKETS.findSocket(ws.id);
    if (!closingSocket) {
      this._adapter.log.info('This socket is already closed or destroyed');
      ws.isAuthenticated = false;
      if (ws.isSubscribed(MESSAGE_ENUM.IOB_DATA)) { 
        ws.unsubscribe(MESSAGE_ENUM.IOB_DATA); 
      };
      if (ws.isSubscribed(MESSAGE_ENUM.PING)) { 
        ws.unsubscribe(MESSAGE_ENUM.PING); 
      };
      return;
    }

    // if (this._LOG_ALL) this._adapter.log.info('[uws] WebSocket connection from ' + closingSocket._ws.username + ' is closing.');
    closingSocket.unsubscribeAllStates();

    closingSocket.isAuthenticated = false;

    /* The library guarantees proper unsubscription at close */

    this.SOCKETS.removeSocket(closingSocket);

    if (this._LOG_ALL) this.checkSocketsStatus();

    this.emit('socket_closed', closingSocket);
  }

  /**
   * This method is unsubscribing all sockets from all states
   * @returns {void}
   */
  unsubscribeAll() {
    if ( this.server && this.SOCKETS && this.SOCKETS.sockets ) {
      for ( let i = 0; i < this.SOCKETS.sockets.length ; i++ ) {
        this.SOCKETS.sockets[i].unsubscribeAllStates();
      }
    }
  }

  /**
   * This method is gracefully closing uWebSockets server
   * @returns {void}
   */
  close() {
    if (this._LOG_ALL) this._adapter.log.info('[close] Gracefully closing uWebSockets server');

    this.unsubscribeAll();
    if ( this.server && this.SOCKETS && this.SOCKETS.sockets ) {
      this.SOCKETS.sockets.forEach((socket, index) => {
        socket.disconnect();
      });
      this.SOCKETS.sockets = [];

      try {
        if (this.listenSocket) {
          // Okay, shutting down now!
          this._adapter.log.info('[close] Okay, shutting down now!');
          /* This function is provided directly by µSockets */
          uWS.us_listen_socket_close(this.listenSocket);
          this.listenSocket = null;
        }
        this.server = null;
      } catch (e) {
        // ignore
      }
      // TODO: clearInterval if any
    }
  }

  /**
   * This method is logging current sockets
   * @returns {void}
   */
  checkSocketsStatus() {
    let _that = this;

    this._adapter.log.info(`No of existing sockets is: ${this.SOCKETS.getSocketCount()}`);
    this.SOCKETS.sockets.forEach((socket, index) => {
      _that._adapter.log.info(`socket[${index+1}]: ${socket._ws.username} # Authenticated = ${socket.isAuthenticated} # IP = ${socket.ipAddr}`);
    })
  }

  /**
   * This method is logging current state subscribers
   * @returns {void}
   */
  showStateSubscribers() {
    // runs the function for each (key, value) pair
    this.subscriptionsHolder.forEach( (socketSubrscriber, stateId, map) => {
      this._adapter.log.info(`[showStateSubscribers] ${stateId}: ${socketSubrscriber}`);
    });
  }

  /**
   * This method publish to all sockets that there was some stateChange
   * @param {String} type 'stateChange' or 'objectChange'
   * @param {String} id id of changed state
   * @param {*} obj state
   * @returns {void}
   */
  publishAll(type, id, obj) {
    if (id === undefined) {
      this._adapter.log.warn('Problem');
      return;
    }
    if (!this.server || !this.SOCKETS || this.SOCKETS.getSocketCount() === 0) {
      return;
    }

    if (type === 'stateChange') {
      for (let i = 0; i < this.SOCKETS.sockets.length; ++i) {
        if (this.SOCKETS.sockets[i].isAuthenticated) {
          this.SOCKETS.sockets[i].handleStateChange(id, obj);
        }
      }
    }
  }

  /**
   * Creates new ws username
   * @param {*} rndInt random integer number
   */
  _createName(rndInt) {
    return this.SOCKETS.sockets.find( (socket)=> socket.name === `unidentified-${rndInt}`) ? 
    this._createName(getRandomInt()) : 
    `unidentified-${rndInt}`
  }

   /**
   * Helper function to check if string is valid JSON string
   * @param {String} str string
   * @returns {Boolean}
   */
  _IsValidJsonString(str) {
    try {
        JSON.parse(str);
        return true;
    } catch (e) {
        if (this._LOG_ALL) this._adapter.log.warn('This is not valid JSON string!');
        return false;
    }
  }
}


/**
 * Class representing a socket client.
 *
 */
class IOSocketC {
  /**
   * Constructor for IOSocketC class.
   * @param {*} adapter iobroker adapter
   * @param {*} ws web socket instance
   * @param {Boolean} log logging turn on/off
   * @param {*} connectionId
   */
  constructor(adapter, ws, log, connectionId) {
    this._adapter = adapter;
    this._ws = ws;
    this._LOG_ALL = log;
    this._connectionId = connectionId;

    this._subscribeOthers = {};
    this._subscribeStates = {};
    this._subscribeHistory = {};

  } // END OF CONSTRUCTOR

  // METHODS
  /**
   * Default method that is executed when state change is reported.
   */
  onStateChangeReported(id, state) {
    this._adapter.log.info(`[stateChangedReported] The state ${id} has been changed, new state is ${state}`);
  }

  /**
   * @method handleStateChange this method is called when Foreign State is changed
   * @param {*} id stateId
   * @param {*} state state value
   * @returns {void}
   */
  handleStateChange(id, state) {
    if ( this._subscribeStates && this._subscribeStates[this._connectionId] && Array.isArray(this._subscribeStates[this._connectionId]) ) {
      this._subscribeStates[this._connectionId].forEach( subscribedStateId => {
        if (subscribedStateId === id) {
          if ( state && state.ack !== undefined && state.ts !== undefined && state.from !== undefined ) {
            // here we should send (or publish) message to websocket Client
            // but we are using better concept here ---> we use state change reported callback that is mutable
            this.onStateChangeReported(id, state);

          } else {
            this._adapter.log.error(`${id} is not a valid state`);
          };
          return;
        };
      });
    }
  }

  /**
   * Default method that is executed when adapter should subscribeForeignState.
   */
  onForeignStateSubscribe(socket, id) {
    this._adapter.log.info(`[onForeignStateSubscribe] subscribeForeignState should be chacked/called on: ${id}`);
  }

  /**
   * @method stateSubscribe subscribe to Foreign state
   * @param {String} id stateId
   * @param {String} socketConnectionId
   * @returns {void}
   */
  stateSubscribe(id, socketConnectionId) {
    let _that = this;
    this._subscribeStates[socketConnectionId] = this._subscribeStates[socketConnectionId] || [];

    if (this._subscribeStates[socketConnectionId].indexOf(id) === -1) {
        if ( Array.isArray(this._subscribeStates[socketConnectionId]) ) { 
          this._subscribeStates[socketConnectionId].push(id);
          this.onForeignStateSubscribe(this, id);
        }
        //this.onForeignStateSubscribe(this, id);
    }
    // this._printSubscribedStates();
  
    // we need to poll state value once here
    this.readSingleState(id, /*callback*/(point)=> {
        if (point && !point.err) {
            _that.send(MESSAGE_ENUM.IOB_DATA, "IOB_uWebSocket_Server", point);
        } else {
            point && point.err && _that._adapter.log.error(point.err);
            _that.send(MESSAGE_ENUM.IOB_DATA, "IOB_uWebSocket_Server", {err: point.err.message});
        }
    });
  }

  /**
   * @method multipleStatesSubscribe
   * @param {Array} statesIdToSubscribeArr
   * @returns {void}
   */
  multipleStatesSubscribe(statesIdToSubscribeArr) {
    for (let i = 0; i < statesIdToSubscribeArr.length; ++i) {
      statesIdToSubscribeArr[i] && this.stateSubscribe(statesIdToSubscribeArr[i], this._connectionId);
    }
  }

  /**
   * Default method that is executed when adapter should unsubscribeForeignState.
   */
  onForeignStateUnsubscribeReported(socket, id) {
    this._adapter.log.info(`[onForeignStateUnsubscribeReported] unsubscribeForeignState should be chacked/called on stateId: ${id}`);
  }

  /**
   * @method stateUnsubscribe unsubscribe from one state
   * @param {String} stateId
   * @param {String} socketConnectionId socket connection id
   * @returns {void}
   */
  stateUnsubscribe(stateId, socketConnectionId) {
    if ( stateId && this._subscribeStates[socketConnectionId] && Array.isArray(this._subscribeStates[socketConnectionId]) ) {
      const idx = this._subscribeStates[socketConnectionId].indexOf(stateId);
      if (idx === -1) { 
        if (this._LOG_ALL) this._adapter.log.warn(`[stateUnsubscribe] The socket with id ${socketConnectionId} is not subscribed to state: ${stateId}`);
        return;
      }

      // now we can unsubscribe safely
      this._subscribeStates[socketConnectionId].splice(idx, 1); // 2nd parameter (i.e. 1) means remove one item only
      this.onForeignStateUnsubscribeReported(this, stateId);

      // this._printSubscribedStates();
    } else {
      this._adapter.log.error('[stateUnsubscribe] Something went wrong. Not found');
    }
  }

  /**
   * @method unsubscribeAllStates unsubscribe from all states
   * @returns {void}
   */
  unsubscribeAllStates() {
    if (Array.isArray(this._subscribeStates[this._connectionId])) {
      for ( let i = this._subscribeStates[this._connectionId].length - 1 ; i >= 0 ; i--) {
        this.stateUnsubscribe(this._subscribeStates[this._connectionId][i], this._connectionId);
      }

      if (this._subscribeStates[this._connectionId].length === 0) this._subscribeStates = {}; // or delete this._subscribeStates[this._connectionId]
    } else {
      this._subscribeStates = {}; // or delete this._subscribeStates[this._connectionId]
    }

  }

  /**
   * @method send send message to websocket client
   * @param {Enum} msgEnum
   * @param {String} from
   * @param {*} messageBody message to be sent
   * @returns {void}
   */
  send(msgEnum, from = "me", messageBody = {}) {
    if ( this._ws.isSubscribed(msgEnum) ) {
      const message = {
        type: msgEnum,
        sender: from,
        body: messageBody
      };
      // send to connecting socket only
      this._ws.send(JSON.stringify(message));
    }
  }

  /**
   * @method setStateValue this method is used to set foreign state
   * @param {String} id state.id
   * @param {*} state new value to set
   * @param {Function} callback callback function
   * @returns {void}
   */
  setStateValue(id, state, callback = null) {
    if (typeof state !== 'object') {
      state = { val: state }
    }
    this._adapter.setForeignState(id, state, {user: 'system.user.' + /*this._ws.username*/'admin'}, (err, res)=> {
      if (callback && typeof callback === 'function') {
        callback(err, res);
      }
    });
  }

  /**
   * @method readSingleState this method is used to read single ioBroker state
   * @param {String} id state.id
   * @param {Function} readSingleStateCallback callback function
   * @returns {void}
   */
  readSingleState(id, readSingleStateCallback = null) {
    this._adapter.getForeignState(id, /*{
        // user: this._ws.username
        user: "system.user." + this._ws.username
    },*/ (error, res) => {
        if ( error || !res || (res && (res.ack === undefined || res.ts === undefined || res.from === undefined)) ) {
            error = new Error(id + " is not a valid state");
        }
        const Result = {
          err: error,
          state: {
            id,
            value: res.val,
            ack: res.ack,
            timestamp: new Date(res.ts).toISOString(),
            q: res.q,
            from: res.from,
            user: res.user,
            lastchange: new Date(res.lc).toISOString()
          }
        }
        readSingleStateCallback && readSingleStateCallback(Result); // call the callback function if it exists
    });
  }

  /**
   * @method getClientIP this method is used to get IP address of the websocket client
   * 
   * @returns {String} client IP address
   */
  getClientIP() {
    return this._ws.ip;
  }

  /**
   * @method getSystemInformation getting information regarding hostname, architecture and platform
   * @returns {void}
   */
  getSystemInformation() {
    const data = {
      hostname: _os.hostname(),
      architecture: _os.arch(),
      platform: _os.platform(),
      release: _os.release()
    }
    this.send(MESSAGE_ENUM.IOB_DATA, "IOB_uWebSocket_Server", data);
  }

  /**
   * @method disconnect This method is closing websocket client
   * @returns {void}
   */
  disconnect() {
    this._ws.close();
  }

  // Helper method to log subscribed state of this socket
  _printSubscribedStates() {
    for (const property in this._subscribeStates) {
      this._LOG_ALL && this._adapter.log.info(`[_printSubscribedStates] ${property}: ${this._subscribeStates[property]}`);
    }
  }

  // Getters and Setters
  get connectionId() {
    return this._connectionId;
  }

  set connectionId(id) {
    this._connectionId = id + "";
  }

  get isAuthenticated() {
    return this._ws.isAuthenticated;
  }

  set isAuthenticated(auth) {
    if (typeof auth == "boolean") {
      this._ws.isAuthenticated = auth;
    }
  }

  get ipAddr() {
    return this._ws.ip;
  }
}


/**
 * Class for tracking of currently connected socket clients.
 *
 */
class TrackedSockets {
  constructor() {
    this.sockets = [];
  }
  // Find a device based on its Id
  findSocket(connectionId) {
    for (let i = 0; i < this.sockets.length; ++i) {
      if (this.sockets[i].connectionId === connectionId) {
        return this.sockets[i];
      }
    }
    return undefined;
  }  
  getSocketCount() {
    return this.sockets.length;
  }
  removeSocket(s) {
    this.sockets.find((socket, index) => {
      if (socket && socket.connectionId === s.connectionId) {
        this.sockets.splice(index, 1);
      }
    });
  }
}


// helper function for random number generation
function getRandomInt() {
  return Math.floor(Math.random() * Math.floor(9999));
}

module.exports = IOWebSocketSrv;
