'use strict';
//OPC UA client Adapter for ioBroker
//REV 0.0.2
//Update to the last version

//REV 0.0.2 First stable release
const utils = require('@iobroker/adapter-core');

//OPC UA CONNECTION values
var UASERVER_ENDPOINT_URL = ""     // OPC UA Server OPC UA Server endpoint url
var OPCUA_TAGS_TO_MONITOR = [];
var deviceWithOPCUAServerId = "";

let shutdownSignalCount;


// OPC UA configuration
const uaclient = require('./lib/opcua-client')
const nodeidConfig = require('./config/opcconfig');

let adapter;
let path;

let LOG_ALL = false;						// FLAG to activate full logging
let OPCUASessionInitiated = false;		// FLAG that shows that a connection to OPC UA Server was initiated at all. EndpointURL must be valid
let IS_ONLINE  = false; // FLAG, true when connection established and free of error

function startAdapter(options) {
  const optionSave = options || {};

  Object.assign(optionSave, { name: "opcua-client" });
  adapter = new utils.Adapter(optionSave);
  
  // When Adapter is ready then connecting to OPC UA Server and Subscribe necessary Handles
  adapter.on ('ready', async() => {

      /* Configuration of OPC UA tags should be done in external config file with PATH: ./config/opcconfig.js */

      // event handlers
      shutdownSignalCount = 0;
      uaclient.emitter.on('connection_break', async () => await gracefullShutdown('connection_break'));
      //uaclient.emitter.on('connection_lost', handleConnectionLostEvent );
      uaclient.emitter.on('connected', handleOpcClientConnectionEvent );

      // Move the ioBroker Adapter configuration to the container values 
      UASERVER_ENDPOINT_URL = adapter.config.endpointUrl;
      deviceWithOPCUAServerId = adapter.config.myDeviceId;
      LOG_ALL = adapter.config.extlogging;
      OPCUA_TAGS_TO_MONITOR = nodeidConfig.nodeidList;

      try {
          // Create & reset connection stat at adapter start
          // await this.create_state('info.connection', 'Connected', true);
          adapter.getState('info.connection', (err, state) => {
            (!state || state.val) && adapter.setState('info.connection', { val: false, ack: true });
          });

          // first let's remove all existing states in .variables channel, if any
          if (LOG_ALL) adapter.log.info('Getting all Existing states now...');
          const existingStates = await getAllExistingStates();

          if (LOG_ALL) adapter.log.info('Starting deleting of existing objects/states, if any');

          for (let j=0; j < existingStates.length ; j++) {
            if (LOG_ALL) adapter.log.info('Existing state ' + existingStates[j] + " will be deleted");
            await adapter.delObject(existingStates[j], function (err) {
              if (err) adapter.log.error('Cannot delete object: ' + err);
            });
          }

          if (LOG_ALL) adapter.log.info('The Removal of existing states is finished!');

          await new Promise((resolve) => setTimeout(resolve, 3000));

          if (!UASERVER_ENDPOINT_URL || UASERVER_ENDPOINT_URL === 'opc.tcp://') {

            adapter.log.error('No OPC-UA Server endpoint ! Please define URL endpoint in Adapter Instance settings.');
            OPCUASessionInitiated = false;
            // stop here!
          } else {

            OPCUASessionInitiated = true;

            adapter.setObjectNotExists(adapter.namespace + '.variables', {
              type: 'channel',
              common: {
                name: 'OPC-UA variables',
              },
              native: {},
            });
            
            //Initialize ioBrokers state objects if they dont exist
            path = adapter.namespace + ".variables." + deviceWithOPCUAServerId;
            for ( let i=0 ; i < OPCUA_TAGS_TO_MONITOR.length; i++ ) {
              if (LOG_ALL) adapter.log.info('Creating new state with NodeId: ' + OPCUA_TAGS_TO_MONITOR[i].nodeId);
              adapter.setObjectNotExists (path + handleFolderName(OPCUA_TAGS_TO_MONITOR[i].subFolder) + "." + handleOpcuaNodeName(OPCUA_TAGS_TO_MONITOR[i].nodeId), {
                type:'state',
                common:{
                  name: OPCUA_TAGS_TO_MONITOR[i].variableName,
                  type: handleOpcuaNodeType(OPCUA_TAGS_TO_MONITOR[i].dataType),
                  role:'value',
                  read: true,
                  write: true
                },
                native: {
                  nodeId: OPCUA_TAGS_TO_MONITOR[i].nodeId,
                  dataTypeStr: OPCUA_TAGS_TO_MONITOR[i].dataType,
                  //timestampStr: OPCUA_TAGS_TO_MONITOR[i].timestamp
                }
              });
            }

            //Enable receiving of change events for all objects
            adapter.subscribeStates('*');
        

            // Create and start the OPCUA connection.
            await uaclient.init(UASERVER_ENDPOINT_URL, deviceWithOPCUAServerId, adapter, LOG_ALL);
        
            // Create new OPC UA subscription and start monitoring of OPC UA nodes
            let mainSubscription;
            mainSubscription = await uaclient.monitorNodes(deviceWithOPCUAServerId, OPCUA_TAGS_TO_MONITOR, (points) => {  
              //adapter.log.info('points = ' + points);
              if (typeof(points) === 'object') {
                //if (LOG_ALL) adapter.log.info(points.data.value); // 0.999999999345
                //if (LOG_ALL) adapter.log.info(points.data.nodeid); // "ns=1;s=sin"
        
                if ( findNodeInTagList(points.data.nodeid, OPCUA_TAGS_TO_MONITOR) ) {
                  //if (LOG_ALL) adapter.log.info(path);
                  adapter.setState(path + handleFolderName(points.data.subFolder) + "." + handleOpcuaNodeName(points.data.nodeid), { val: points.data.value, ack: true });
                } else {
                  adapter.log.error("NodeId doesn't exist in OpcUaTagList");
                }
              }
        
            });
            if (LOG_ALL) adapter.log.info('mainSubsciption is: '+ mainSubscription.subscriptionId);
        
        /*
            let readOpcTagsintervalId;
            // read single OPC UA tag value
            readOpcTagsintervalId = setInterval(() => {
              uaclient.readSingleOpcNodeValue(deviceWithOPCUAServerId, 'ns=1;s=saw', (data) => {
                  adapter.log.info(data);
                });
            }, 500);
        */
        /*
            const POLL_INTERVAL = 250;
            let opcReadUpdatingInterval;
        
            // Execute regular polling of opcua values (metrics) every POLL_INTERVAL (ms)
            opcReadUpdatingInterval = setInterval( async() => {
              await uaclient.readMultiOpcNodesValue(deviceWithOPCUAServerId, NODESID_TO_MONITOR, (points) => {
                adapter.log.info(points.data.value);
              });
            }, POLL_INTERVAL);
        */
        
        } // end of if-else

      } catch(err) {
        adapter.log.error('Error catched !!!');
        adapter.log.error(err);
        process.exit(1);
      } // end of try - catch block

  }); // end of adapter.on('ready')

  //************************************* ADAPTER CLOSED BY ioBroker *****************************************
  adapter.on ('unload', (callback) => {

    uaclient.emitter.removeAllListeners();

    IS_ONLINE = false;
    //clearInterval (OBJID_REQUEST);
    adapter.log.info ('OPC Client: Close connection, cancel service.');


    if (OPCUASessionInitiated) {
      uaclient.terminateAllSubscriptions();
      
      adapter.log.info(" closing session");
      uaclient.close();
  
      uaclient.disconnectClient();
    }

    adapter.setState('info.connection', { val: false, ack: true });

    if ( typeof(callback) === 'function' ) {
      callback();
    }
  });


  //************************************* Adapter STATE has CHANGED ******************************************	
  adapter.on ('stateChange', (id, state) => {
    if (!state) {
      return ;
    }

    // do not process self generated state changes (by OPC UA Server instance)
    if (state.ack === true && id) {
      //if (LOG_ALL) adapter.log.info('The state ' + id + ' has been changed');
      return;

    } else if ( state.ack === false && id) {
      if (!IS_ONLINE) {
        adapter.log.warn('No connection');
      } else {
        //const shortId = id.substring(id.indexOf('.', 9) + 1, id.length);
        const shortId = constructId(id);
        if (LOG_ALL) adapter.log.info(shortId);

        adapter.getObject(shortId, (err, data) => {
          if (!err) {
            if (LOG_ALL) adapter.log.info(JSON.stringify(data));
              uaclient.write(data.native.nodeId, data.native.dataTypeStr, state.val);
          }
        });
      }
    }
  });

  return adapter;
}


//************************************* OPC CONNECT /ERROR / CLOSED ****************************************
// try a gracefull shutdown in case of error
async function gracefullShutdown (e) {
  try {
    adapter.log.error('Error ' + (e));
    shutdownSignalCount++;
  
    if (shutdownSignalCount > 1) return;
  
    uaclient.emitter.removeAllListeners(['connection_break']);
  
    //adapter.setState('info.connection', { val: false, ack: true });
    IS_ONLINE && adapter && adapter.setState && adapter.setState('info.connection', { val: false, ack: true });
  
    IS_ONLINE = false;
    //clearInterval (OBJID_REQUEST);
    uaclient.terminateAllSubscriptions();
  
    adapter.log.info(" closing session");
    uaclient.close();
  
    adapter.log.warn('Gracefull Shutdown. Terminating adapter.');

    await new Promise((resolve) => setTimeout(resolve, 1500));

    //typeof adapter.terminate === 'function' ? adapter.terminate(11) : process.exit(11); // this is without automatic reset
    typeof adapter.terminate === 'function' ? adapter.terminate(0) : process.exit(0); // with adapter automatic reset
    //process.exit(0);

  } catch(err) {
    adapter.log.error('Error during gracefullShutdown of Adapter ' + err);
  }
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
// helper function for dataType conversion
function handleOpcuaNodeType(dataType) {
  let jsTypeToReturn;
  if (dataType === 'Double') {
    jsTypeToReturn = 'number';
  } else if (dataType === 'Sbyte') {
    jsTypeToReturn = 'number';
  } else if (dataType === 'Byte') {
    jsTypeToReturn = 'number';
  } else if (dataType === 'Int16') {
    jsTypeToReturn = 'number';
  } else if (dataType === 'Int32') {
    jsTypeToReturn = 'number';
  } else if (dataType === 'UInt16') {
    jsTypeToReturn = 'number';
  } else if (dataType === 'UInt32') {
    jsTypeToReturn = 'number';
  } else if (dataType === 'UInt64') {
    jsTypeToReturn = 'number';
  } else if (dataType === 'Float') {
    jsTypeToReturn = 'number';
  } else if (dataType === 'Boolean') {
      jsTypeToReturn = 'boolean';
  } else if (dataType === 'String') {
    jsTypeToReturn = 'string';
  } else {
    adapter.log.error('datatype not found - number will be implemented!');
    jsTypeToReturn = 'number';
  }

  return jsTypeToReturn;
}

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

// helper functions to handle opcua Node name
function handleOpcuaNodeName (rawData) {
  let name = rawData.replace(/\//g, "_").replace(/\./g, "_").replace(/\;/g, "_").replace(/\:/g, "_");

  return name;
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


// If started as allInOne/compact mode => return function to create instance
if (module && module.parent) {
  module.exports = startAdapter;
} else {
  // or start the instance directly
  startAdapter();
}