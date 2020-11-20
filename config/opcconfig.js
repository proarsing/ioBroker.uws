/* opc ua tag liste */
/* subFolder name should always have prefix '/' */

const nodeidList = [
  { _id: 1, nodeId: "ns=1;s=saw", variableName: "saw", dataType: "Double", subFolder: "" },
  { _id: 2, nodeId: "ns=1;s=randFloat", variableName: "randomFloat", dataType: "Double", subFolder: ""  },
  { _id: 3, nodeId: "ns=1;s=staticInt", variableName: "staticInteger", dataType: "Int32", subFolder: "/static/"  },
  { _id: 4, nodeId: "ns=1;s=staticFloat", variableName: "staticFloat", dataType: "Double", subFolder: "/static"  },
  { _id: 5, nodeId: "ns=1;s=sin", variableName: "sinus", dataType: "Double", subFolder: ""  },
  {
    _id: 6,
    nodeId: "ns=1;s=randInt",
    variableName: "randomInteger",
    dataType: "UInt32",
    subFolder: ""
  },
  { _id: 7, nodeId: "ns=1;s=heartBeat", variableName: "heartbeat", dataType: "Boolean", subFolder: ""  },
  { _id: 8, nodeId: "ns=1;s=djm.activePower", variableName: "djm.ActivePower", dataType: "Double", subFolder: "/mheDjM"  },
  { _id: 9, nodeId: "ns=1;s=staticString", variableName: "staticString", dataType: "String", subFolder: "/static/"  },
  //{ _id: 10, nodeId: "ns=1;s=vla_wemosd1.temperature", variableName: "weather.station-temp", dataType: "Double", subFolder: "/weatherStation/"  },
];

module.exports = { nodeidList };
