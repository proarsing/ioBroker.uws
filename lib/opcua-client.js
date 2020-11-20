const opcua = require("node-opcua");
const EventEmitter = require('events'); // first letter is Uppercase: this is a convention, that sad that this is a Class

const emitter = new EventEmitter(); // here we created emitter object

const subscriptionConfig = {
    requestedPublishingInterval: 1000,
    requestedLifetimeCount: 100, // 1000ms *100 every 2 minutes or so
    requestedMaxKeepAliveCount: 10,// every 10 seconds
    maxNotificationsPerPublish: 10,
    publishingEnabled: true,
    priority: 10
};
const monitoredItemConfig = {
    samplingInterval: 1000,  // you can put here even 1 ms if you want (50 is o.k.)
    discardOldest: true,
    queueSize: 10
};

var the_session = null; 
var the_subscription = null;
var the_client = null;

let adapter; // ioBroker adapter
let LOG_ALL = false; // iobroker logging enable/disable

//xxvar currNodeId = null;

var currSubscriptions = [];


// helper function to return type of Node
function typeOfNode (dtype) {
  let variant;
  if (dtype === 1) {
    variant = 'Boolean';
  } else if (dtype === 6) {
    variant = 'Int32';
  } else if (dtype === 7) {
    variant = 'UInt32';
  } else if (dtype === 11) {
      variant = 'Double';
  } else if (dtype === 12) {
    variant = 'String';
  } else {
    variant = dtype;
  }

/*
  elif datatype == 'Sbyte':
      variant = ua.VariantType.SByte
  elif datatype == 'Byte':
      variant = ua.VariantType.Byte
  elif datatype == 'UInt16':
      variant = ua.VariantType.UInt16
  elif datatype == 'UInt64':
      variant = ua.VariantType.UInt64
  elif datatype == 'Int16':
      variant = ua.VariantType.Int32
  elif datatype == 'Int64':
      variant = ua.VariantType.Int64
  elif datatype == 'Float':
      variant = ua.VariantType.Float
  elif datatype == 'Double':
      variant = ua.VariantType.Double
  else:
      raise ValueError('"%s" datatype not implemented' % datatype)
*/
  return variant;
}

async function init(endpointUrl, myClientName, _adapter, _log) {
    LOG_ALL = _log;
    adapter = _adapter;

    let clientName;
    if (!myClientName) {
        clientName = "ioBroker-opcua-client-hmi";
    } else {
        clientName = myClientName;
    }
    //if (LOG_ALL) adapter.log.info('client name : ' + clientName);

    try {
      // Define OPC UA Server to connect to
      const client = opcua.OPCUAClient.create({
          clientName,
          keepSessionAlive: true,
          endpoint_must_exist: false,
          connectionStrategy: {
            maxRetry: 20,
            initialDelay: 2000,
            maxDelay: 10 * 1000
          }
      });
      the_client = client;

      // "adding some helpers to diagnose connection issues"
      client.on("backoff", (retry, delay) => {
          if (LOG_ALL) adapter.log.info("Retrying to connect to " + endpointUrl + ": retry = " + retry + " next attempt in " + (delay/1000) + " seconds");
          if (retry > 10) {
              adapter.log.error("OPC connection was closed!");
              emitter.emit('connection_break');
          }
      });

      // step 1 : connect to OPC UA server
      adapter.log.info(" opc client connecting to " + endpointUrl);
      await client.connect(endpointUrl);
      adapter.log.info(" opc client connected to " + endpointUrl);
      emitter.emit('connected');

      // handle connection failure.
      let socket = client._secureChannel._transport._socket;
      socket.on('close', () => {
          adapter.setState('info.connection', { val: false, ack: true });
          adapter.log.error("Socket was closed!");
          emitter.emit('connection_break');
      });
      client.on('connection_lost', () => {
          adapter.log.error("Connection to OPC server was lost!");
          //adapter.setState('info.connection', { val: false, ack: true });
          emitter.emit('connection_break');
      })

      // step 2 : createSession
      the_session = await client.createSession();
      //xx_adapter.log.info(" opc ua session created" + { ID: the_session.sessionId.value });
      adapter.log.info(" opc ua session created! Finished session creation.");

    } catch (e) {
        adapter.log.error('OPCUA_CLIENT_______Problem during trying to connect to OPC UA server! '+ e.message);
        process.exit(1);
    }
};

// step 3: install a subscription and install a monitored item
async function monitorNodes(OpcServerName, nodes, monitorNodesCallback) {
    try {
        the_subscription = await the_session.createSubscription2(subscriptionConfig);

        the_subscription.on("started", function () {
            if (LOG_ALL) adapter.log.info("OPC UA subscription started for subscriptionId=" + the_subscription.subscriptionId);
            currSubscriptions.push(the_subscription);
            /* // uncomment this for debugging purpose
            adapter.log.info('current opc ua subscriptions are:');
            currSubscriptions.forEach( subscription => adapter.log.info(' ' + subscription.subscriptionId) );
            */
        }).on("keepalive", function () {
            // adapter.log.debug("keepalive signal sent..."); // uncomment this for debugging purpose
        }).on("error", function() {
            adapter.log.error("Subscription had an error.");
        }).on("terminated", function () {
            adapter.log.info("Subscription was terminated" + the_subscription.subscriptionId);
        });

        // install monitored item
        nodes.forEach( async(itemNode) => {
            const monitoredItem = await the_subscription.monitor(
                {
                    nodeId: opcua.resolveNodeId(itemNode.nodeId),
                    attributeId: opcua.AttributeIds.Value
                },
                monitoredItemConfig,
                opcua.TimestampsToReturn.Both
            );

            //adapter.log.info("current element in nodes array nodeId is : " + monitoredItem.itemToMonitor.nodeId.value);

            monitoredItem.on("changed", (dataValue) => {
                let Node = {
                  data: {
                    OpcServer: OpcServerName,
                    subFolder: itemNode.subFolder,
                    nodeid: itemNode.nodeId,
                    type: typeOfNode(dataValue.value.dataType),
                    value: dataValue.value.value
                  },
                  timestamp: dataValue.serverTimestamp.toISOString(),
                  tag: 'datachange'
                };

                // now Raise an event
                /*emitter.emit('monitorNodeValue', monitorNodesCallback(Node)); // make a noise - we are signalling that an Event is raised*/

                monitorNodesCallback && monitorNodesCallback(Node); // call the callback function if exists
            });
        });

        return the_subscription;

    } catch (err) {
      adapter.log.error("OPCUA_CLIENT______Error !!!" + err);
      //process.exit();
    }
}

function terminateAllSubscriptions() {
    // try terminating all subscriptions
    //adapter.log.info(" terminating following opc ua subscriptions:"); // you can uncomment this for debugging purpose
    try {
        currSubscriptions.forEach( subscription => {
            // adapter.log.info('   ' + subscription.subscriptionId); // you can uncomment this for debugging purpose
            terminateOpcSubscription(subscription) ;
        });
    } catch(e) {
        adapter.log.error(e);
    }
    if (LOG_ALL) adapter.log.info('current opc ua subscriptions are: ' + JSON.stringify(currSubscriptions));
}

async function write(nodeid, type, val) {
    const nodeToWrite = {
      nodeId: nodeid,
      attributeId: opcua.AttributeIds.Value,
      value: /* DataValue */{
          statusCode: opcua.StatusCodes.Good,
          value: /* Variant */{
              dataType: type, /* opcua.DataType.Int32 */
              value: val
          }
      },
    }
    let risultato = await the_session.write(nodeToWrite);
    if (LOG_ALL) adapter.log.info(risultato.toString());
    if (LOG_ALL) adapter.log.info('attempt to write opc ua value done...');

    // newDataValue = await the_session.read({nodeId: nodeid});
    // adapter.log.info(newDataValue.toString());
}

async function readOpcNode(nodeid, cb) {
    let listenersNum = null;
    let opcValue = await the_session.read({nodeId: nodeid});

    let Result = {
        nodeid : nodeid,
        value: opcValue.value.value,
        type: typeOfNode(opcValue.value.dataType),
        timestamp: opcValue.serverTimestamp.toISOString()
    };

    // now Raise an event
    emitter.emit('OpcNodeRead', Result); // make a noise - we are signalling that an Event is raised

    listenersNum = EventEmitter.listenerCount(emitter, 'OpcNodeRead');
    if (LOG_ALL) adapter.log.info('number of listeners for emitter event is = ' + listenersNum);
    if ( listenersNum >= 1) {
        // Unregistering events
        emitter.off('OpcNodeRead', cb);
    }
}

// this function reads one single opcua node value
async function readSingleOpcNodeValue(OpcServerName, nodeid, readSingleOpcNodeValueCallback) {
    const maxAge = 0;
    let opcValue = await the_session.read({nodeId: nodeid}, maxAge);

    let Result = {
        data: {
            opcServer: OpcServerName,
            nodeid : nodeid,
            type: typeOfNode(opcValue.value.dataType),
            value: opcValue.value.value,
        },
        timestamp: opcValue.serverTimestamp.toISOString(),
        tag: 'read_single_node'
    };

    readSingleOpcNodeValueCallback(Result); // call the callback function
}

// this function reads MULTIPLE opcua nodes values
async function readMultiOpcNodesValue(OpcServerName, metrics, readMultiOpcNodesValueCallback) {
    if (!the_session) {
        //throw new Error('There is no active session. Can\'t read');
        adapter.log.error('There is no active session. Can\'t read');
        process.exit(1);
    }
    metrics.forEach( async (nodeid) => {
        let datavalue = await the_session.read({nodeId: nodeid}, 0);

        let Node = {
            data: {
                opcServer: OpcServerName,
                nodeId: nodeid,
                type: typeOfNode(datavalue.value.dataType),
                value: datavalue.value.value,
            },
            timestamp: datavalue.serverTimestamp.toISOString(),
            tag: 'polled_opcuatag_value'
        };

        readMultiOpcNodesValueCallback(Node) // now execute callback function
    });
}

// this function terminates passed opc ua subscription (passed as an argument)
function terminateOpcSubscription(opcSubscription) {
    adapter.log.info(" terminating subscription: " + opcSubscription.subscriptionId);
    try {
        opcSubscription.terminate();
        currSubscriptions.splice( currSubscriptions.indexOf(opcSubscription), 1 ); // you can comment this line!
    } catch(e) {
        adapter.log.error(e);
    }
}

// this function disconnect opc ua client from the server
async function disconnectClient () {
  if(!the_client) {
    await the_client.disconnect();
  }
}

// this function closes active session
// note: session is lazy init
async function close () {
  if(!the_session) {
    await the_session.close();
  }
}

module.exports = {
    init,
    monitorNodes,
    terminateAllSubscriptions,
    EventEmitter,
    emitter,
    write,
    readOpcNode,
    readSingleOpcNodeValue,
    readMultiOpcNodesValue,
    terminateOpcSubscription,

    // note: session is lazy init
    //close: () => the_session.close(),
    close,
    disconnectClient,
}

