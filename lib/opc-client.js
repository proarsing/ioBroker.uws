const opcua = require("node-opcua");
const EventEmitter = require('events'); // first letter is Uppercase: this is a convention, that sad that this is a Class
// const {
//     AttributeIds,
//     OPCUAClient,
//     TimestampsToReturn,
//   } = require("node-opcua");
const emitter = new EventEmitter(); // here we created emitter object

const samplingIntervalforMonitoringTags = null;

const subscriptionConfig = {
    requestedPublishingInterval: 100,
    requestedLifetimeCount: 10,
    requestedMaxKeepAliveCount: 2,
    maxNotificationsPerPublish: 10,
    publishingEnabled: true,
    priority: 10
};
const monitoredItemConfig = {
    samplingInterval: samplingIntervalforMonitoringTags || 1000,  // you can put here even 1 ms if you want (50)
    discardOldest: true,
    queueSize: 10
};

//const endpointUrl = "opc.tcp://opcuaserver.com:48010";

var the_session = null; 
var the_subscription = null;

//xxvar currNodeId = null;

var currSubscriptions = [];


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

const init = async (endpointUrl, adapter) => {
  samplingIntervalforMonitoringTags = adapter.config.samplinginterval;

   // Define OPC UA Server to connect to
  //xxopcClient.init("opc.tcp://opcuaserver.com:48010");
  //opcClient.init(process.env.OPCUA_SERVER || "opc.tcp://HPOmen:48010/WebIQ/DemoServer");
  const client = opcua.OPCUAClient.create({
    clientName: 'iobroker-opcua-client-hmi',
    keepSessionAlive: true,
    endpoint_must_exist: false
  });

  try {
    // "adding some helpers to diagnose connection issues"
    client.on("backoff", (retry, delay) => {
        adapter.log.info("Retrying to connect to ", endpointUrl, ": retry =", retry, "next attempt in ", delay/1000, "seconds");
        if (retry > 10) {
            adapter.log.debug("OPC connection was closed!");
            emitter.emit('connection_break');
        }
    });

    // step 1 : connect to
    adapter.log.info(" opc client connecting to ", chalk.cyan(endpointUrl));
    await client.connect(endpointUrl);
    adapter.log.info(" opc client connected to ", chalk.cyan(endpointUrl));

    // handle connection failure.
    let socket = client._secureChannel._transport._socket;
    socket.on('close', () => {
        adapter.log.error("Socket was closed!");
        emitter.emit('connection_break');
    });
    client.on('connection_lost', () => {
        adapter.log.error("Connection to OPC server was lost!");
        emitter.emit('connection_break');
    })

    // step 2 : createSession
    the_session = await client.createSession();
    adapter.log.info(chalk.yellow(" opc ua session created"), { ID: the_session.sessionId.value });

  } catch (e) {
    throw new Error(e.message)
  }
};


// step 3: install a subscription and install a monitored item for 10 seconds
function monitorNodes (nodes, fun) {

    the_subscription = opcua.ClientSubscription.create(the_session, subscriptionConfig);

    the_subscription.on("started", function () {
        console.log("subscription started for subscriptionId=", the_subscription.subscriptionId);
        currSubscriptions.push(the_subscription);
        console.log(chalk.yellowBright('current opc ua subscriptions are: '), currSubscriptions.subscriptionId);
    }).on("keepalive", function () {
        console.log("keepalive");
    }).on("error", function() {
        log.error("Subscription had an error.");
    }).on("terminated", function () {
        console.log("Subscription was terminated", { ID: the_subscription.subscriptionId });
    });

    // install monitored item
    nodes.forEach( (n) => {
        const monitoredItem = opcua.ClientMonitoredItem.create(
            the_subscription,
            {
                nodeId: opcua.resolveNodeId(n),
                attributeId: opcua.AttributeIds.Value
            },
            monitoredItemConfig,
            opcua.TimestampsToReturn.Both
        );
        // monitoredItem.itemToMonitor.nodeId =    NodeId { identifierType: 2, value: 'staticInt', namespace: 1 }
        console.log(chalk.cyan("current element in nodes array nodeId is : "), monitoredItem.itemToMonitor.nodeId.value);
        console.log("-------------------------------------");

        console.log(chalk.magentaBright('current NodeId is = '), { nodeId: n });

        monitoredItem.on("changed", function(dataValue) {
            var Node = {
              data: {
                nodeid: n,
                type: typeOfNode(dataValue.value.dataType),
                value: dataValue.value.value
              },
              timestamp: dataValue.serverTimestamp.toISOString(),
              tag: 'datachange'
            };

            // now Raise an event
            //console.log('Node value is : ', JSON.stringify(Node));
            if (fun.name === 'f') {
                emitter.emit('StartingMonitorNodeValue', fun(Node)); // make a noise - we are signalling that an Event is raised
            }
            emitter.emit('monitorNodeValue', fun(Node)); // make a noise - we are signalling that an Event is raised

            // if ( EventEmitter.listenerCount(emitter, 'monitorNodeValue') >= 5 ) {
            //     // Unregistering events
            //     for (let i = 0; i < EventEmitter.listenerCount(emitter, 'monitorNodeValue') ; i++) {
            //         emitter.removeListener('monitorNodeValue', fun);
            //     }
            // };
          });

    });

    console.log(chalk.blueBright('fun name =', fun.name));
    console.log(chalk.blue('number of listeners for emitter event monitorNodeValue is ='), EventEmitter.listenerCount(emitter, 'monitorNodeValue'));
    console.log(chalk.blue('number of listeners for emitter event StartingMonitorNodeValue is ='), EventEmitter.listenerCount(emitter, 'StartingMonitorNodeValue'));

    return the_subscription;
}

function terminateAllSubscriptions() {
    // try terminating all subscriptions
    console.info(chalk.blue(" terminating following subscriptions: "), currSubscriptions);
    try {
        currSubscriptions.forEach( element => terminateOpcSubscription(element) );
    } catch(e) {
        console.log(e);
    }
    //currSubscriptions = [];
    console.log(chalk.yellow('current opc ua subscriptions are: '), currSubscriptions);
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
    console.log(risultato.toString());
    console.log(chalk.yellow('attempt to write opc ua value done...'));

    // newDataValue = await the_session.read({nodeId: nodeid});
    // console.log(newDataValue.toString());
}

async function readOpcNode(nodeid, fun) {
    let listenersNum = null;
    let opcValue = await the_session.read({nodeId: nodeid});

    let Result = {
        nodeid : nodeid,
        value: opcValue.value.value,
        type: typeOfNode(opcValue.value.dataType),
        timestamp: opcValue.serverTimestamp.toISOString()
    };
    //xx_console.log('we will return =', Result);

    // now Raise an event
    emitter.emit('OpcNodeRead', Result); // make a noise - we are signalling that an Event is raised

    listenersNum = EventEmitter.listenerCount(emitter, 'OpcNodeRead');
    console.log(chalk.blue('number of listeners for emitter event is ='), listenersNum );
    if ( listenersNum >= 1) {
        // Unregistering events
        emitter.off('OpcNodeRead', fun);
    }
}

// this function terminates passed opc ua subscription (passed as an argument)
function terminateOpcSubscription(opcSubscription) {
    console.log(chalk.yellow(" terminating subscription: "), opcSubscription.subscriptionId);
    try {
        opcSubscription.terminate();
        currSubscriptions.splice( currSubscriptions.indexOf(opcSubscription), 1 ); // you can comment this line!
    } catch(e) {
        console.log(e);
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
    terminateOpcSubscription,

    // todo: save all subscriptions in an array and iterate over it for termination
    // note: session is lazy init
    close: () => the_session.close(),

    // terminateSubscription: the_subscription => {
    //     console.info("terminating subscription: " + the_subscription.subscriptionId);
    //     the_subscription.terminate();
    // }
}

