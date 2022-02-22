'use strict';
/**
 *
 * uWebSocket.js Server Adapter for ioBroker. 
 * Copyright 2022, proarsing  <vladislav.arsic@hotmail.com>
 *
 */

// REV 0.0.1
// Update to the last version

const adapterName = require('./package.json').name.split('.').pop();
const utils = require('@iobroker/adapter-core');
const IOWebSocketSrv = require('./lib/uws');


/*
 * variables initiation
 */
let adapter;
let webServer;

let AUTH = false;
let SECURE = false;
let IP_ADDR = "0.0.0.0";
let LOG_ALL = false; // FLAG to activate full logging
let LOGIN = 'secret_login';
let TOKEN = 'secret_token';

let trackedClientsIP; // tracking of connected websocket clients IP addresse

let appIntervals = [];
const HEARTBEAT_INTERVAL = 1000; // in milliseconds
const DEL_DEPRECTED_SUBS_INTERVAL_SEC = 60; // in seconds

/**
 * Class for tracking of IP addresses of connected websocket clients.
 *
 */
 class TrackedClientsIP {
  constructor() {
    this.connectedClientsIP = [];
  }
  addClient(ip) {
    ip && this.connectedClientsIP.push(ip);
  }
  getClientsCount() {
    return this.connectedClientsIP.length;
  }
  removeClient(ipAddr) {
    const idx = this.connectedClientsIP.indexOf(ipAddr);
    if (idx >= 0) { 
      this.connectedClientsIP.splice(idx, 1);
    }
  }
  clear() {
    this.connectedClientsIP.length = 0;
  }
  showIpAddresses() {
    if (this.connectedClientsIP.length > 0 ) {
      return ('IP: ' + this.connectedClientsIP.join(', '));
    } else {
      return ('IP: no IPs')
    }
  }
}

/*
 * ADAPTER
 *
 */
function startAdapter(options) {
  const optionSave = options || {};

  Object.assign(optionSave, { name: adapterName });
  adapter = new utils.Adapter(optionSave);
  
  //**************************************** ADAPTER READY  *******************************************
  // is called when databases are connected and adapter received configuration.
  // start here!
  adapter.on('ready', async() => {

      // Move the ioBroker Adapter configuration to the container values 
      IP_ADDR = adapter.config.bind || "0.0.0.0";
      LOG_ALL = adapter.config.extlogging;
      LOGIN = adapter.config.loginId || 'secret_login';
      TOKEN = adapter.config.token || 'secret_token';

      trackedClientsIP = new TrackedClientsIP();

      try {
        //Enable receiving of change events for all objects
        adapter.subscribeStates('*');

        // Create & reset connection stat at adapter start
        adapter.getState('info.connection', (err, state) => {
          (!state || state.val) && adapter.setState('info.connection', { val: false, ack: true });
        });

        const existingStates = await getAllExistingStates();
        for (let j=0; j < existingStates.length ; j++) {
          try {
            await adapter.deleteObjectAsync(existingStates[j], function (err) {
              if (err) adapter.log.error('Cannot delete object: ' + err);
            });
          } catch (e) {
            // ignore
          }
        }

        await adapter.setObjectNotExistsAsync(adapter.namespace + '.variables', {
          type: 'channel',
          common: {
            name: 'ServerAuxVars',
          },
          native: {},
        });

        await adapter.setObjectNotExistsAsync(adapter.namespace + ".variables" + ".clients_IP_addr", {
          type: "state",
          common: {
            name: "Connected Clients IP",
            role: "json",
            type: "string",
            read: true,
            write: false,
            desc: "Connected Clients IP addresses",
            def: ""
          },
          native: {},
        });
        await adapter.setStateAsync(adapter.namespace + '.variables.clients_IP_addr', { val: trackedClientsIP.showIpAddresses(), ack: true });

        await adapter.setObjectNotExistsAsync(adapter.namespace + ".variables" + ".heartBeat", {
          type: "state",
          common: {
            name: "heartBeat",
            role: "control.states",
            type: "boolean",
            read: true,
            write: true,
            desc: "heart beat signal",
            def: false
          },
          native: {},
        });

        let heartBeatSignal = false;
        const hbInterval = setInterval(()=> {
          heartBeatSignal = !heartBeatSignal;
          adapter.setState(adapter.namespace + '.variables.heartBeat', { val: heartBeatSignal, ack: true });
        }, HEARTBEAT_INTERVAL);

        appIntervals.push(hbInterval);

        await adapter.setObjectNotExistsAsync(adapter.namespace + ".info" + ".wsClientsNum", {
          type: "state",
          common: {
            name: "wsClientsNum",
            role: "websocket.updates",
            type: "number",
            read: true,
            write: true,
            desc: "List of websocket clients",
            def: 0
          },
          native: {},
        });
        await adapter.setStateAsync('info.wsClientsNum', { val: 0, ack: true });

      } catch(err) {
        adapter.log.error('Error catched !!!');
        adapter.log.error(err);
        process.exit(1);
      } // end of try - catch block

      // call main() function
      main();

  }); // end of adapter.on('ready')

  //************************************* ADAPTER CLOSED BY ioBroker *****************************************
  // is called when adapter shuts down - callback has to be called under any circumstances!
  adapter.on ('unload', (callback) => {
    try {
      adapter.log.info(`terminating uWebSockets server on port ${webServer._port}`);
      webServer.unsubscribeAll();
      webServer.close();

      for (let i = 0; i < appIntervals.length; i++) {
        if ( appIntervals[i] !== null ) {
          clearInterval(appIntervals[i]);
        }
      }
      appIntervals = [];

      trackedClientsIP.clear();

      adapter.setState('info.connection', { val: false, ack: true });
      adapter.log.info('cleaned everything up...');
      callback();
    } catch (e) {
      callback();
    }
  });

  //************************************* Adapter STATE has CHANGED ******************************************	
  // is called if a subscribed state changes
  adapter.on ('stateChange', (id, state) => {
    if (!state) {
      return ;
    }
    if (webServer) {
      webServer.publishAll('stateChange', id, state);
    }
  });

  //*********************************** Message was sent to Adapter ******************************************	
  // Some message was sent to adapter instance over message box. Used by email, pushover, text2speech, ...
  adapter.on('message', obj => {
    if (typeof obj === 'object' && obj.message) {
        if (obj.command === 'send') {
            // e.g. send email or pushover or whatever
            if (LOG_ALL) adapter.log.info('send command');

            // Send response in callback if required
            if (obj.callback) adapter.sendTo(obj.from, obj.command, 'Message received', obj.callback);
        }
    }
  });

  return adapter;
}

async function main() {

  adapter.config.port = parseInt(adapter.config.port, 10) || 0;
  adapter.config.port = await checkPortNumber();

  if (adapter.config.port) {

      webServer = new IOWebSocketSrv(adapter, adapter.config.port, LOG_ALL, { 
        login: LOGIN,
        token: TOKEN
      });

      // event listeners goes here
      webServer.on('connected', (response) => {
        adapter.getState('info.connection', (err, state) => {
          adapter.setState('info.connection', { val: response, ack: true });
        });
      });

      webServer.on('new_socket', (socket) => {
        const numOfSockets = webServer.SOCKETS.getSocketCount();
        webServer.checkSocketsStatus();
        adapter.getState('info.wsClientsNum', (err, state) => {
          (!err) && (state !== undefined) && adapter.setState('info.wsClientsNum', { val: numOfSockets, ack: true });
        });
        trackedClientsIP.addClient(socket.getClientIP());
        adapter.setState(adapter.namespace + '.variables.clients_IP_addr', { val: trackedClientsIP.showIpAddresses(), ack: true });
      });

      webServer.on('socket_closed', (socket) => {
        if (LOG_ALL) adapter.log.info(`[main] Socket ${socket._ws.username} is closed`);
        const numOfSockets = webServer.SOCKETS.getSocketCount();
        const IP = socket.getClientIP();
        trackedClientsIP.removeClient(IP);

        adapter.getState('info.wsClientsNum', (err, state) => {
          (!err) && (state !== undefined) && adapter.setState('info.wsClientsNum', { val: numOfSockets, ack: true });
        });
        adapter.setState(adapter.namespace + '.variables.clients_IP_addr', { val: trackedClientsIP.showIpAddresses(), ack: true });

        if (LOG_ALL) webServer.checkSocketsStatus();
      });

      webServer.on('message', (data) => {
        // adapter.log.info(`[main] recieved new message via websocket protocol from ${data.username} : ${JSON.stringify(data.msg)}`);
        // do something
      });

      webServer.on('foreignSubscribe', (id) => {
        // call showStateSubscribers() method of webServer object
        // webServer.showStateSubscribers();
      });

      webServer.on('foreignUnsubscribe', (id) => {
        // call showStateSubscribers() method of webServer object
        // webServer.showStateSubscribers();
      });

      // uWebSocket server initialization
      webServer.initIOServer();

      // check for deprected adapter subscribtions
      const checkDeprectedSubsInterval = setInterval(()=> {
        if ( webServer.SOCKETS.getSocketCount() === 0 ) { // there is no any websocket connected to the server
          setTimeout(() => {
            adapter.unsubscribeForeignStates('*');
          }, 100);
        }
      }, DEL_DEPRECTED_SUBS_INTERVAL_SEC * 1000);

      appIntervals.push(checkDeprectedSubsInterval);

  } else {
    adapter.log.error('port missing');
    adapter.terminate ? adapter.terminate(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
  }
}


//************************************* Other support/helper functions *************************************************
// helper function to check port number
// returns a promise
function checkPortNumber () {
  return new Promise(function (resolve) {
    adapter.getPort(adapter.config.port, (port)=> {
      if (parseInt(port, 10) !== adapter.config.port && !adapter.config.findNextPort) {
          adapter.log.error(`port ${adapter.config.port} already in use`);
          return adapter.terminate ? adapter.terminate(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
      }

      resolve(port);
    });
  });
};

// helper function to get all exisiting states in .variables channel, if any
// returns a promise
function getAllExistingStates () {
  return new Promise( (resolve, reject) => {
    let arr = [];
    // adapter.getStates(adapter.namespace + '.*', function (err, states) {
    adapter.getStates(adapter.namespace + '.variables.*', function (err, states) {
      
      if (err) {
        adapter.log.err(' Did not find existing states, error =' + err);
        return reject(err);
      }

      // Object.entries(states).forEach(state => { 
      //   adapter.log.info(`   ${state}`) 
      // });

      for (let id in states) {
        let _id = constructId(id);
        if (_id !== undefined) {
          arr.push(_id);
        }
      }
      resolve(arr);
    });
  });
}

// helper function to make Id without adapter.namespace prefix
function constructId(str) {
  let shortId;
  let auxArray = [];
  let splicedArr = [];

  auxArray = str.split(".");
  splicedArr = auxArray.splice(2);
  shortId = splicedArr.join('.');

  return shortId;
}

/*
 * COMPACT MODE
 * If started as allInOne/compact mode => return function to create instance
 *
 */
if (module && module.parent) {
  module.exports = startAdapter;
} else {
  // or start the instance directly
  startAdapter();
}
