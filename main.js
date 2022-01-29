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
const ioWebSocket = require('./lib/uws.js');

/*
 * variables initiation
 */
let adapter;
let path;
let webServer;

let PORT = 9091;
let AUTH = false;
let SECURE = false;
let IP_ADDR = "0.0.0.0";
let LOG_ALL = false;						// FLAG to activate full logging
let OPCUASessionIsInitiated = false;		// FLAG that shows that a connection to OPC UA Server was initiated at all. EndpointURL must be valid
let IS_ONLINE  = false; // FLAG, true when connection established and free of error

const LOGIN = 'secret_login';
const TOKEN = 'secret_token';

/*
 * ADAPTER
 *
 */
function startAdapter(options) {
  const optionSave = options || {};

  Object.assign(optionSave, { name: 'uws' });
  adapter = new utils.Adapter(optionSave);
  
  //**************************************** ADAPTER READY  *******************************************
  // is called when databases are connected and adapter received configuration.
  // start here!
  adapter.on ('ready', async() => {
      /*
      // event handlers
      shutdownSignalCount = 0;
      uaclient.emitter.on('connection_break', async () => await gracefullShutdown('connection_break'));
      //uaclient.emitter.on('connection_lost', handleConnectionLostEvent );
      uaclient.emitter.on('connected', handleOpcClientConnectionEvent );
      */

      // Move the ioBroker Adapter configuration to the container values 
      IP_ADDR = adapter.config.bind;
      PORT = adapter.config.port;
      LOG_ALL = adapter.config.extlogging;

      // Create & reset connection stat at adapter start
      // await this.create_state('info.connection', 'Connected', true);
      adapter.getState('info.connection', (err, state) => {
        (!state || state.val) && adapter.setState('info.connection', { val: false, ack: true });
      });

      // first let's remove all existing states in .variables channel, if any
      if (LOG_ALL) adapter.log.info('Getting all Existing states now...');
      const existingStates = await getAllExistingStates();
      /*
      if (LOG_ALL) adapter.log.info('Starting deleting of existing objects/states, if any');

      for (let j=0; j < existingStates.length ; j++) {
        if (LOG_ALL) adapter.log.info('Existing state ' + existingStates[j] + " will be deleted");
        await adapter.delObject(existingStates[j], function (err) {
          if (err) adapter.log.error('Cannot delete object: ' + err);
        });
      }

      if (LOG_ALL) adapter.log.info('The Removal of existing states is finished!');

      await new Promise((resolve) => setTimeout(resolve, 3000));
      */

      main();

  }); // end of adapter.on('ready')

  //************************************* ADAPTER CLOSED BY ioBroker *****************************************
  // is called when adapter shuts down - callback has to be called under any circumstances!
  adapter.on ('unload', (callback) => {
    try {
      //adapter.setState('info.connection', { val: false, ack: true });
      adapter.getState('info.connection', (err, state) => {
        (!state || state.val) && (state.val !== false) && adapter.setState('info.connection', { val: false, ack: true });
      });
      adapter.log.info('cleaned everything up...');
      // if ( typeof(callback) === 'function' ) {
      //   callback();
      // }
      callback();
    } catch (e) {
      // if ( typeof(callback) === 'function' ) {
      //   callback();
      // }
      callback();
    }
  });

  //************************************* Adapter STATE has CHANGED ******************************************	
  // is called if a subscribed state changes
  adapter.on ('stateChange', (id, state) => {
    if (!state) {
      return ;
    }
    if (LOG_ALL) adapter.log.info('The state ' + id + ' has been changed');
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

function main() {

  //Enable receiving of change events for all objects
  adapter.subscribeStates('*');

  webServer = new ioWebSocket(adapter, PORT, LOG_ALL, { login = LOGIN, token = TOKEN});
  
}


// OPC-UA CLIENT SUCCESSFUL CONNECTED
function handleOpcClientConnectionEvent() {
  adapter.log.info ('info from MAIN: OPC-UA Client established connection with OPC-UA Server');
  IS_ONLINE = true;
  adapter.setState('info.connection', { val: true, ack: true });
}

function handleConnectionLostEvent() {
  adapter.log.info('info from MAIN: OPC UA connection closed');
  IS_ONLINE = false;
  adapter.setState('info.connection', { val: false, ack: true });
}


//************************************* Other support/helper functions *************************************************
// helper function to get all exisiting states in .variables channel, if any
// returns a promise
function getAllExistingStates () {
  return new Promise( (resolve, reject) => {
    let arr = [];
    adapter.getStates(adapter.namespace + '.variables.*', function (err, states) {

      if (err) {
        adapter.log.err(' Did not find existing states, error =' + err);
        return reject(err);
      }

      for (let id in states) {
        //const helperArr = id.split(".").slice(0, 2);
        //helperArr.slice(0, 2);
        let _id = constructId(id);
        //adapter.log.info(_id);
        if (_id !== undefined) {
          arr.push(_id);
        }
      }
      resolve(arr);
    });
  });
}

// helper function to make Id without adapter.namespace
function constructId(str) {
  let shortId;
  let auxArray = [];
  let splicedArr = [];

  auxArray = str.split(".");
  splicedArr = auxArray.splice(2);
  shortId = splicedArr.join('.');

  return shortId;
}

// helper functions to handle Sub-folder name
function handleFolderName (rawData) {
  if ( !rawData || rawData === "") {
    const valueToReturn = "";
    return valueToReturn;
  }

  let fixedName = "";

  let name = rawData.replace(/\//g, ".").replace(/\\/g, ".");
  if ( name.charAt(name.length - 1) === ".") {
    // remove last element of the string
    fixedName = name.slice(0, -1);
  } else {
    fixedName = name;
  }

  return fixedName;
}

// helper function to test if endpoint URL is valid or not
function urlIsInvalid(url) {
//  if (/\s/.test(url)) {
//    // It has any kind of whitespace
//  }
  const patt = new RegExp(/\s/);
  const res = patt.test(url);

  return res;
}

// helper functions to handle opcua Node name
function handleOpcuaNodeName (rawData) {
  let name = rawData.replace(/\//g, "_").replace(/\./g, "_").replace(/\;/g, "_").replace(/\:/g, "_");

  return name;
}

// helper function to handle config file directory
function handleConfigFileDir (configFilePath) {
  if (configFilePath.startsWith('/')) {
      return configFilePath;
  } else {
      return '/' + configFilePath;
  }
}

// helper functions to find opcua tag in opcua Tag Liste
function findNodeInTagList(nodeId, _opcUaTagList) {
  return _opcUaTagList.find(tag => tag.nodeId === nodeId);
}

// helper functions to detect index of opcua Node in opcua Tag Liste
function detectIndex(nodeId, _opcUaTagList) {
  return _opcUaTagList.findIndex(item => item.nodeId === nodeId);
}

// helper function that returns last element of the array
function last(array) {
  return array[array.length - 1];
}

// helper function for terminating OPC UA subscription
const clearOpc = (subscription) => {
  if (LOG_ALL) adapter.log.info(" clear OPC");
  if (subscription) {
    uaclient.terminateOpcSubscription(subscription);
  }
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