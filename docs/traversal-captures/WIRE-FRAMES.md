# Wire frames, verbatim

Every MQTT packet the station sent or received, in order, as captured by
`scripts/traversal-capture.ts` (mqtt.js `packetsend` / `packetreceive`).
`sessionKey` values are redacted; nothing else is edited.
`correlationData` is shown decoded from its byte buffer to the ASCII string it carries.


## Capture file: `stn_128b63f1.ndjson`

> `meta` **bay-ids** @ 2026-09-07T13:16:56.505Z
```json
{
  "source": "certs/uat/stn_128b63f1-bays.json",
  "derivedLocally": [
    "bay_128b63f101",
    "bay_128b63f102"
  ],
  "used": [
    "bay_dad554b98823f7f82ece181e0105a6ba",
    "bay_70ecda0b84fb2b558526a68afc5b066d"
  ],
  "match": false
}
```

> `meta` **start** @ 2026-09-07T13:16:56.506Z
```json
{
  "stationId": "stn_128b63f1",
  "target": "uat",
  "mqttUrl": "mqtts://mqtt-uat.onestoppay.ro:8883",
  "persistedBrokerUri": "mqtts://mqtt-uat.onestoppay.ro:8883",
  "wireProtocolVersion": "0.3.0",
  "tlsFiles": {
    "key": "certs/uat/stn_128b63f1-key.pem",
    "cert": "certs/uat/stn_128b63f1.pem",
    "chain": "certs/uat/stn_128b63f1-chain.pem"
  }
}
```

> `meta` **tap-attached** @ 2026-09-07T13:16:56.535Z
```json
{}
```

**#4** `CONNACK` server -> station @ `2026-09-07T13:16:56.845Z`

`qos=0  retain=false  reasonCode=0  sessionPresent=false`

MQTT properties:
```json
{
  "sharedSubscriptionAvailable": true,
  "subscriptionIdentifiersAvailable": true,
  "wildcardSubscriptionAvailable": true,
  "maximumPacketSize": 65536,
  "retainAvailable": true,
  "topicAliasMaximum": 65535,
  "receiveMaximum": 10
}
```

**#5** `SUBSCRIBE` station -> server @ `2026-09-07T13:16:56.848Z`

`messageId=64165`

**#6** `SUBACK` server -> station @ `2026-09-07T13:16:56.930Z`

`qos=0  retain=false  messageId=64165  granted=[1]`

> `meta` **connected** @ 2026-09-07T13:16:56.931Z
```json
{
  "lifecycle": "ONLINE"
}
```

### ===== STAGE: BOOT =====

**#9** `PUBLISH` station -> server @ `2026-09-07T13:17:21.772Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64166`

```json
{
  "messageId": "5c5ae3a2-a060-4980-a837-142c1f3ffb07",
  "messageType": "Request",
  "action": "BootNotification",
  "timestamp": "2026-09-07T13:17:21.771Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {
    "stationId": "stn_128b63f1",
    "firmwareVersion": "1.0.0",
    "stationModel": "WashPro X200",
    "stationVendor": "SimCorp",
    "serialNumber": "SIM-1788787016506",
    "bays": [
      {
        "bayNumber": 1,
        "programNumbers": [
          1
        ]
      },
      {
        "bayNumber": 2,
        "programNumbers": [
          1
        ]
      }
    ],
    "uptimeSeconds": 25,
    "pendingOfflineTransactions": 0,
    "timezone": "Europe/Bucharest",
    "bootReason": "PowerOn",
    "messageSigningMode": "All",
    "capabilities": {
      "bleSupported": false,
      "offlineModeSupported": false,
      "meterValuesSupported": true,
      "deviceManagementSupported": true
    },
    "networkInfo": {
      "connectionType": "Ethernet"
    }
  }
}
```

**#10** `PUBACK` server -> station @ `2026-09-07T13:17:21.828Z`

`qos=0  retain=false  messageId=64166  reasonCode=0`

**#11** `PUBLISH` server -> station @ `2026-09-07T13:17:22.010Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=1`

MQTT properties:
```json
{
  "messageExpiryInterval": 60
}
```

```json
{
  "messageId": "cmd_d878f310-9f00-479d-987b-5245e7fb9664",
  "messageType": "Request",
  "action": "ChangeConfiguration",
  "timestamp": "2026-09-07T13:17:21.945Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "keys": [
      {
        "key": "RevocationEpoch",
        "value": "0"
      }
    ]
  },
  "mac": "/oUoxjnMHuFzWoZY9Brz8mVRg65aRnFo/+Nd2/R8cP0="
}
```

**#12** `PUBACK` station -> server @ `2026-09-07T13:17:22.011Z`

`messageId=1  reasonCode=0`

**#13** `PUBLISH` server -> station @ `2026-09-07T13:17:22.142Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=2`

```json
{
  "messageId": "5c5ae3a2-a060-4980-a837-142c1f3ffb07",
  "messageType": "Response",
  "action": "BootNotification",
  "timestamp": "2026-09-07T13:17:21.926Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "status": "Accepted",
    "serverTime": "2026-09-07T13:17:21.926Z",
    "heartbeatIntervalSec": 30,
    "configuration": {
      "HeartbeatIntervalSeconds": "30",
      "MaxSessionDurationSeconds": "600",
      "ConnectionLostGracePeriod": "300"
    },
    "sessionKey": "<redacted-session-key>"
  }
}
```

**#15** `PUBACK` station -> server @ `2026-09-07T13:17:22.217Z`

`messageId=2  reasonCode=0`

**#14** `PUBLISH` station -> server @ `2026-09-07T13:17:22.217Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64167`

```json
{
  "messageId": "80727813-de9b-4f00-9852-63c616ad3654",
  "messageType": "Event",
  "action": "StatusNotification",
  "timestamp": "2026-09-07T13:17:22.215Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {
    "bayId": "bay_dad554b98823f7f82ece181e0105a6ba",
    "bayNumber": 1,
    "status": "Available",
    "programs": [
      {
        "programNumber": 1,
        "available": true
      }
    ]
  },
  "mac": "QSGkot9qFihFiqqKB9130WQ45cN62s8sk4BlLKngrNs="
}
```

**#16** `PUBACK` server -> station @ `2026-09-07T13:17:22.232Z`

`qos=0  retain=false  messageId=64167  reasonCode=0`

**#17** `PUBLISH` station -> server @ `2026-09-07T13:17:22.233Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64168`

```json
{
  "messageId": "54fd8579-c2eb-42d8-9932-13386cc18eb8",
  "messageType": "Event",
  "action": "StatusNotification",
  "timestamp": "2026-09-07T13:17:22.233Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {
    "bayId": "bay_70ecda0b84fb2b558526a68afc5b066d",
    "bayNumber": 2,
    "status": "Available",
    "programs": [
      {
        "programNumber": 1,
        "available": true
      }
    ]
  },
  "mac": "g67tRvj861kgmIu12boL96J5bDdKxjQE6Ks69vLvQZo="
}
```

**#18** `PUBACK` server -> station @ `2026-09-07T13:17:22.250Z`

`qos=0  retain=false  messageId=64168  reasonCode=0`

**#19** `PUBLISH` station -> server @ `2026-09-07T13:17:52.216Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64169`

```json
{
  "messageId": "388f74b6-b3c5-4f6f-8336-756f72896448",
  "messageType": "Request",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:17:52.216Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {},
  "mac": "9NqyjyPTCfCMWaaj+SPQCcGRaa5SGKCc2DMqHRBCQ8Y="
}
```

**#20** `PUBACK` server -> station @ `2026-09-07T13:17:52.226Z`

`qos=0  retain=false  messageId=64169  reasonCode=0`

**#21** `PUBLISH` server -> station @ `2026-09-07T13:17:52.270Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=3`

```json
{
  "messageId": "388f74b6-b3c5-4f6f-8336-756f72896448",
  "messageType": "Response",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:17:52.249Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "serverTime": "2026-09-07T13:17:52.249Z"
  },
  "mac": "iCInfc9DUGi9Gb+NshUhlWfWbJVjT7jhtdbND4iqTyI="
}
```

**#22** `PUBACK` station -> server @ `2026-09-07T13:17:52.272Z`

`messageId=3  reasonCode=0`

**#23** `PUBLISH` station -> server @ `2026-09-07T13:18:22.216Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64170`

```json
{
  "messageId": "045f711c-6a25-4d15-9cc0-35a21ad750cc",
  "messageType": "Request",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:18:22.216Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {},
  "mac": "xQJWvjZzyNV8iPtS9AseHKHyNBMMyxLUK9F5l3dSROY="
}
```

**#24** `PINGREQ` station -> server @ `2026-09-07T13:18:22.227Z`


**#25** `PUBACK` server -> station @ `2026-09-07T13:18:22.244Z`

`qos=0  retain=false  messageId=64170  reasonCode=0`

**#26** `PINGRESP` server -> station @ `2026-09-07T13:18:22.251Z`

`qos=0  retain=false`

**#27** `PUBLISH` server -> station @ `2026-09-07T13:18:22.376Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=4`

```json
{
  "messageId": "045f711c-6a25-4d15-9cc0-35a21ad750cc",
  "messageType": "Response",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:18:22.263Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "serverTime": "2026-09-07T13:18:22.263Z"
  },
  "mac": "Uc+aX6WpAxY/rG1B0wUzVOgOicXtIStppqGIpZstrwM="
}
```

**#28** `PUBACK` station -> server @ `2026-09-07T13:18:22.377Z`

`messageId=4  reasonCode=0`

**#29** `PUBLISH` station -> server @ `2026-09-07T13:18:52.217Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64171`

```json
{
  "messageId": "3fe62b8f-2a73-4f53-a1a3-3174c1c54b19",
  "messageType": "Request",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:18:52.217Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {},
  "mac": "So2OQEek46TOexJzo3OqR36NX6iIt9Nxaj05fpxFcUs="
}
```

**#30** `PUBACK` server -> station @ `2026-09-07T13:18:52.227Z`

`qos=0  retain=false  messageId=64171  reasonCode=0`

**#31** `PUBLISH` server -> station @ `2026-09-07T13:18:52.320Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=5`

```json
{
  "messageId": "3fe62b8f-2a73-4f53-a1a3-3174c1c54b19",
  "messageType": "Response",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:18:52.250Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "serverTime": "2026-09-07T13:18:52.250Z"
  },
  "mac": "x6iay8ZCEmtZVAweoHe+r2GBh/WkMPstrPlW+pAMi8c="
}
```

**#32** `PUBACK` station -> server @ `2026-09-07T13:18:52.321Z`

`messageId=5  reasonCode=0`

**#33** `PUBLISH` station -> server @ `2026-09-07T13:19:22.218Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64172`

```json
{
  "messageId": "3638ad38-cdcd-4e70-8637-8f9ed79eb378",
  "messageType": "Request",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:19:22.218Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {},
  "mac": "lPn6I0Jcx51/niLUp6Oxn+QBAoMS7AKPDwcsDgM5e4Q="
}
```

**#34** `PINGREQ` station -> server @ `2026-09-07T13:19:22.228Z`


**#35** `PUBACK` server -> station @ `2026-09-07T13:19:22.229Z`

`qos=0  retain=false  messageId=64172  reasonCode=0`

**#36** `PINGRESP` server -> station @ `2026-09-07T13:19:22.243Z`

`qos=0  retain=false`

**#37** `PUBLISH` server -> station @ `2026-09-07T13:19:22.284Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=6`

```json
{
  "messageId": "3638ad38-cdcd-4e70-8637-8f9ed79eb378",
  "messageType": "Response",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:19:22.255Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "serverTime": "2026-09-07T13:19:22.255Z"
  },
  "mac": "1IhwQiuXBGqICohx05rvSwpMDX1GHji2RnANSQvbJuA="
}
```

**#38** `PUBACK` station -> server @ `2026-09-07T13:19:22.285Z`

`messageId=6  reasonCode=0`

**#39** `PUBLISH` station -> server @ `2026-09-07T13:19:52.218Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64173`

```json
{
  "messageId": "25062598-ea14-417e-8a80-28e76dea4303",
  "messageType": "Request",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:19:52.217Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {},
  "mac": "6xvIdMDuftT4yXymlMWwtEUuLYhmIqLETc7/QudFvW4="
}
```

**#40** `PUBACK` server -> station @ `2026-09-07T13:19:52.236Z`

`qos=0  retain=false  messageId=64173  reasonCode=0`

**#42** `PUBACK` station -> server @ `2026-09-07T13:19:52.293Z`

`messageId=7  reasonCode=0`

**#41** `PUBLISH` server -> station @ `2026-09-07T13:19:52.293Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=7`

```json
{
  "messageId": "25062598-ea14-417e-8a80-28e76dea4303",
  "messageType": "Response",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:19:52.255Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "serverTime": "2026-09-07T13:19:52.255Z"
  },
  "mac": "Qx5FqEBYba5cJqeQp9TzFZcR/avZiieGS+X0UL3wxFQ="
}
```

**#43** `PUBLISH` station -> server @ `2026-09-07T13:20:22.218Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64174`

```json
{
  "messageId": "185f1122-2774-4754-a92d-401cff348c3e",
  "messageType": "Request",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:20:22.218Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {},
  "mac": "A8TCYc1j72S8wYTWdyD7p9TbblFEW8ZCoRf1Oh7EhII="
}
```

**#44** `PUBACK` server -> station @ `2026-09-07T13:20:22.236Z`

`qos=0  retain=false  messageId=64174  reasonCode=0`

**#45** `PUBLISH` server -> station @ `2026-09-07T13:20:22.329Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=8`

```json
{
  "messageId": "185f1122-2774-4754-a92d-401cff348c3e",
  "messageType": "Response",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:20:22.259Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "serverTime": "2026-09-07T13:20:22.259Z"
  },
  "mac": "JToAAHs4KhPDLGGHX79pktqGyLhD3T/q2wB9wLED/Xo="
}
```

**#46** `PUBACK` station -> server @ `2026-09-07T13:20:22.329Z`

`messageId=8  reasonCode=0`

### ===== STAGE: CATALOG PUBLISH =====

**#48** `PUBLISH` server -> station @ `2026-09-07T13:20:30.464Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=9`

MQTT properties:
```json
{
  "messageExpiryInterval": 30,
  "correlationData": "01a07c07-0674-732b-a118-ba745528361d"
}
```

```json
{
  "messageId": "cmd_e18162b0-0ef1-4597-9633-b4d41c1ab3f5",
  "messageType": "Request",
  "action": "UpdateServiceCatalog",
  "timestamp": "2026-09-07T13:20:30.394Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "catalogVersion": "1",
    "services": [
      {
        "serviceId": "svc_5e021db385f39100",
        "serviceName": "Basic Wash",
        "pricingType": "PerMinute",
        "available": true,
        "bindings": [
          {
            "bayNumber": 1,
            "programNumber": 1
          }
        ],
        "priceCreditsPerMinute": 100
      }
    ]
  },
  "mac": "myDobWJB8oYPn+gCHWH+ZJ2r/FKyTi9KmRp2FjAQMk8="
}
```

**#49** `PUBLISH` station -> server @ `2026-09-07T13:20:30.480Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64175`

```json
{
  "messageId": "cmd_e18162b0-0ef1-4597-9633-b4d41c1ab3f5",
  "messageType": "Response",
  "action": "UpdateServiceCatalog",
  "timestamp": "2026-09-07T13:20:30.480Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {
    "status": "Accepted",
    "previousCatalogVersion": ""
  },
  "mac": "Q9FqQGmuAPg0lkB0C14newBsOPVbn79H2aZWxp1i2CM="
}
```

**#50** `PUBACK` station -> server @ `2026-09-07T13:20:30.481Z`

`messageId=9  reasonCode=0`

**#51** `PUBACK` server -> station @ `2026-09-07T13:20:30.489Z`

`qos=0  retain=false  messageId=64175  reasonCode=0`

**#52** `PUBLISH` station -> server @ `2026-09-07T13:20:52.219Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64176`

```json
{
  "messageId": "665813c8-26b3-4ca5-9741-cac899e4d878",
  "messageType": "Request",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:20:52.218Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {},
  "mac": "UtWtGemX8KYB1fKY+qrurT152j83OUaNwQChBg7UHbA="
}
```

**#53** `PUBACK` server -> station @ `2026-09-07T13:20:52.251Z`

`qos=0  retain=false  messageId=64176  reasonCode=0`

**#54** `PUBLISH` server -> station @ `2026-09-07T13:20:52.342Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=10`

```json
{
  "messageId": "665813c8-26b3-4ca5-9741-cac899e4d878",
  "messageType": "Response",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:20:52.269Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "serverTime": "2026-09-07T13:20:52.269Z"
  },
  "mac": "UY23x+W9FOZ8aGHbNJh6RK9JEG34TMBzocLAJUNtSag="
}
```

**#55** `PUBACK` station -> server @ `2026-09-07T13:20:52.342Z`

`messageId=10  reasonCode=0`

**#56** `PUBLISH` station -> server @ `2026-09-07T13:21:22.219Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64177`

```json
{
  "messageId": "1ee9920b-4da0-4160-9a98-26fbdb31c6ff",
  "messageType": "Request",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:21:22.219Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {},
  "mac": "+RjLZtN+XXnFxWNAHrlcKt3zd2njhxiy1FWjng6UTvo="
}
```

**#57** `PUBACK` server -> station @ `2026-09-07T13:21:22.242Z`

`qos=0  retain=false  messageId=64177  reasonCode=0`

**#58** `PUBLISH` server -> station @ `2026-09-07T13:21:22.337Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=11`

```json
{
  "messageId": "1ee9920b-4da0-4160-9a98-26fbdb31c6ff",
  "messageType": "Response",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:21:22.264Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "serverTime": "2026-09-07T13:21:22.264Z"
  },
  "mac": "PEhmKjT1MxCkLywksrhnKwLeHFMV+GrIaQ2VULP4jG8="
}
```

**#59** `PUBACK` station -> server @ `2026-09-07T13:21:22.338Z`

`messageId=11  reasonCode=0`

**#60** `PUBLISH` station -> server @ `2026-09-07T13:21:52.220Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64178`

```json
{
  "messageId": "71a6d5d9-4ecb-460c-bbad-e990db2fbf5b",
  "messageType": "Request",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:21:52.219Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {},
  "mac": "wB12dOAgx0glyd0D02KgL25QcYTEfKrupruxMPWBkBc="
}
```

**#61** `PINGREQ` station -> server @ `2026-09-07T13:21:52.243Z`


**#62** `PUBACK` server -> station @ `2026-09-07T13:21:52.249Z`

`qos=0  retain=false  messageId=64178  reasonCode=0`

**#63** `PINGRESP` server -> station @ `2026-09-07T13:21:52.256Z`

`qos=0  retain=false`

**#64** `PUBLISH` server -> station @ `2026-09-07T13:21:52.309Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=12`

```json
{
  "messageId": "71a6d5d9-4ecb-460c-bbad-e990db2fbf5b",
  "messageType": "Response",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:21:52.278Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "serverTime": "2026-09-07T13:21:52.278Z"
  },
  "mac": "40gij7ExDu7PLiU36dFk8eHqM13LOT93dtssVYNgvbc="
}
```

**#65** `PUBACK` station -> server @ `2026-09-07T13:21:52.310Z`

`messageId=12  reasonCode=0`

### ===== STAGE: SESSION START =====

**#67** `PUBLISH` station -> server @ `2026-09-07T13:22:22.220Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64179`

```json
{
  "messageId": "bd69e25d-feb6-495e-9de6-b8093857a47b",
  "messageType": "Request",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:22:22.220Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {},
  "mac": "hwTKFLTrEnaeB+ExoMML8AdZ7HNgrzEImwtcJ0xX5XA="
}
```

**#68** `PUBACK` server -> station @ `2026-09-07T13:22:22.229Z`

`qos=0  retain=false  messageId=64179  reasonCode=0`

**#69** `PUBLISH` server -> station @ `2026-09-07T13:22:22.277Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=13`

```json
{
  "messageId": "bd69e25d-feb6-495e-9de6-b8093857a47b",
  "messageType": "Response",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:22:22.252Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "serverTime": "2026-09-07T13:22:22.252Z"
  },
  "mac": "UtKEHpzSrYozpWmj+MyuY/ZNvlKDSgkCSkdHLvGRl1I="
}
```

**#70** `PUBACK` station -> server @ `2026-09-07T13:22:22.277Z`

`messageId=13  reasonCode=0`

**#71** `PUBLISH` server -> station @ `2026-09-07T13:22:41.026Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=14`

MQTT properties:
```json
{
  "messageExpiryInterval": 10,
  "correlationData": "01a07c09-0467-7034-afa5-f1505e57cc9e"
}
```

```json
{
  "messageId": "msg_be822333-3f3c-48e3-ae5b-b3a60b8a1715",
  "messageType": "Request",
  "action": "StartService",
  "timestamp": "2026-09-07T13:22:40.960Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "sessionId": "sess_2a0cfa897ba4fd88fba51756",
    "bayId": "bay_dad554b98823f7f82ece181e0105a6ba",
    "serviceId": "svc_5e021db385f39100",
    "programNumber": 1,
    "durationSeconds": 120,
    "sessionSource": "MobileApp"
  },
  "mac": "J+L6dtDay0Y0JIUWHnjzE7MjnRFKiE3EyYI+mN9FF6A="
}
```

**#72** `PUBLISH` station -> server @ `2026-09-07T13:22:41.035Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64180`

```json
{
  "messageId": "msg_be822333-3f3c-48e3-ae5b-b3a60b8a1715",
  "messageType": "Response",
  "action": "StartService",
  "timestamp": "2026-09-07T13:22:41.034Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {
    "status": "Accepted"
  },
  "mac": "4rlyKIJxwFBD/pMkmWooS/BuVnZB99XEvGungt2xMfs="
}
```

**#73** `PUBACK` station -> server @ `2026-09-07T13:22:41.035Z`

`messageId=14  reasonCode=0`

**#74** `PUBACK` server -> station @ `2026-09-07T13:22:41.043Z`

`qos=0  retain=false  messageId=64180  reasonCode=0`

**#75** `PUBLISH` station -> server @ `2026-09-07T13:22:52.221Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64181`

```json
{
  "messageId": "deb1646d-471a-42be-96d7-70b3058d1070",
  "messageType": "Request",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:22:52.220Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {},
  "mac": "8kb23GGUv4QHMkPsph+izP50iR3q7uLv7JI/XRnw/4k="
}
```

**#76** `PUBACK` server -> station @ `2026-09-07T13:22:52.230Z`

`qos=0  retain=false  messageId=64181  reasonCode=0`

**#77** `PUBLISH` server -> station @ `2026-09-07T13:22:52.349Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=15`

```json
{
  "messageId": "deb1646d-471a-42be-96d7-70b3058d1070",
  "messageType": "Response",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:22:52.253Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "serverTime": "2026-09-07T13:22:52.253Z"
  },
  "mac": "2NjuJcjya2OEGF5btoakwxStwEOLC0gFci6seFlFFH0="
}
```

**#78** `PUBACK` station -> server @ `2026-09-07T13:22:52.350Z`

`messageId=15  reasonCode=0`

### ===== STAGE: METERING =====

**#80** `PUBLISH` station -> server @ `2026-09-07T13:23:21.451Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64182`

```json
{
  "messageId": "145e5cfc-048b-4c3c-b538-39fb853af517",
  "messageType": "Event",
  "action": "MeterValues",
  "timestamp": "2026-09-07T13:23:21.451Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {
    "bayId": "bay_dad554b98823f7f82ece181e0105a6ba",
    "sessionId": "sess_2a0cfa897ba4fd88fba51756",
    "timestamp": "2026-09-07T13:23:21.000Z",
    "values": {
      "liquidMl": 500,
      "energyWh": 100
    }
  },
  "mac": "j7/0xM638/zNRta2K9MefaTTd0ZyUk8fraAoGov8DZk="
}
```

**#81** `PUBACK` server -> station @ `2026-09-07T13:23:21.461Z`

`qos=0  retain=false  messageId=64182  reasonCode=0`

**#82** `PUBLISH` station -> server @ `2026-09-07T13:23:22.221Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64183`

```json
{
  "messageId": "a29b16df-826a-4b23-b400-eb34671809a7",
  "messageType": "Request",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:23:22.221Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {},
  "mac": "kdP4u32cTQi0DnB22zh9o698HlccpvO2We9fXLMpedc="
}
```

**#83** `PUBACK` server -> station @ `2026-09-07T13:23:22.256Z`

`qos=0  retain=false  messageId=64183  reasonCode=0`

**#84** `PUBLISH` server -> station @ `2026-09-07T13:23:22.362Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=16`

```json
{
  "messageId": "a29b16df-826a-4b23-b400-eb34671809a7",
  "messageType": "Response",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:23:22.276Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "serverTime": "2026-09-07T13:23:22.276Z"
  },
  "mac": "4N20bZWjQ95aIITgahZpNiRHIJQp24mf0XhtLy83htc="
}
```

**#85** `PUBACK` station -> server @ `2026-09-07T13:23:22.362Z`

`messageId=16  reasonCode=0`

**#86** `PUBLISH` station -> server @ `2026-09-07T13:23:24.472Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64184`

```json
{
  "messageId": "c2f8e626-07ae-45fd-9ffa-25dc9100794e",
  "messageType": "Event",
  "action": "MeterValues",
  "timestamp": "2026-09-07T13:23:24.472Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {
    "bayId": "bay_dad554b98823f7f82ece181e0105a6ba",
    "sessionId": "sess_2a0cfa897ba4fd88fba51756",
    "timestamp": "2026-09-07T13:23:24.000Z",
    "values": {
      "liquidMl": 1200,
      "energyWh": 250
    }
  },
  "mac": "0xBfIR+eC6VivJXpWHwaN5/D8Fw4WAe2VNGSm6x2BUo="
}
```

**#87** `PUBACK` server -> station @ `2026-09-07T13:23:24.485Z`

`qos=0  retain=false  messageId=64184  reasonCode=0`

**#88** `PUBLISH` station -> server @ `2026-09-07T13:23:52.222Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64185`

```json
{
  "messageId": "8ca7afbc-62ac-4812-b4c3-4814c216c328",
  "messageType": "Request",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:23:52.222Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {},
  "mac": "XR5Efk6d9t9CTwC6yN1GB7DDcMuDpHurvwZAlKGhYaE="
}
```

**#89** `PUBACK` server -> station @ `2026-09-07T13:23:52.253Z`

`qos=0  retain=false  messageId=64185  reasonCode=0`

**#90** `PUBLISH` server -> station @ `2026-09-07T13:23:52.293Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=17`

```json
{
  "messageId": "8ca7afbc-62ac-4812-b4c3-4814c216c328",
  "messageType": "Response",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:23:52.263Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "serverTime": "2026-09-07T13:23:52.263Z"
  },
  "mac": "m+BjK1WO8tJNcg0y23tNQwZh/RBS31+WZkhG/Hx8tUA="
}
```

**#91** `PUBACK` station -> server @ `2026-09-07T13:23:52.294Z`

`messageId=17  reasonCode=0`

### ===== STAGE: SESSION STOP + SETTLEMENT =====

**#93** `PUBLISH` server -> station @ `2026-09-07T13:24:03.143Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=18`

MQTT properties:
```json
{
  "messageExpiryInterval": 10,
  "correlationData": "01a07c0a-453d-7074-8b0f-008b3fd6aa09"
}
```

```json
{
  "messageId": "msg_c597ec3d-6cac-442c-9be0-1b91cad1791a",
  "messageType": "Request",
  "action": "StopService",
  "timestamp": "2026-09-07T13:24:03.052Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "sessionId": "sess_2a0cfa897ba4fd88fba51756",
    "bayId": "bay_dad554b98823f7f82ece181e0105a6ba"
  },
  "mac": "Hq9+Vpz5cGZxuXjIb7VeXvViOC/tSBzaANAoUjMlpv8="
}
```

**#94** `PUBLISH` station -> server @ `2026-09-07T13:24:03.146Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64186`

```json
{
  "messageId": "msg_c597ec3d-6cac-442c-9be0-1b91cad1791a",
  "messageType": "Response",
  "action": "StopService",
  "timestamp": "2026-09-07T13:24:03.145Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {
    "status": "Accepted",
    "actualDurationSeconds": 82,
    "creditsCharged": 137,
    "finalSeqNo": 0
  },
  "mac": "k7uXN8sJ2VNDbIk1PF99VdqzBYHnZlgvhxKEhVCVxlM="
}
```

**#95** `PUBACK` station -> server @ `2026-09-07T13:24:03.146Z`

`messageId=18  reasonCode=0`

**#96** `PUBACK` server -> station @ `2026-09-07T13:24:03.155Z`

`qos=0  retain=false  messageId=64186  reasonCode=0`

**#97** `PUBLISH` station -> server @ `2026-09-07T13:24:22.223Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64187`

```json
{
  "messageId": "16ab9b01-492d-46c7-b28b-02c67d451784",
  "messageType": "Request",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:24:22.222Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {},
  "mac": "DdHFgC1B0A+BZ0ga+7qwUGD8+650QkbCu5P0t2E+WpQ="
}
```

**#98** `PUBACK` server -> station @ `2026-09-07T13:24:22.233Z`

`qos=0  retain=false  messageId=64187  reasonCode=0`

**#99** `PUBLISH` server -> station @ `2026-09-07T13:24:22.362Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=19`

```json
{
  "messageId": "16ab9b01-492d-46c7-b28b-02c67d451784",
  "messageType": "Response",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:24:22.254Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "serverTime": "2026-09-07T13:24:22.254Z"
  },
  "mac": "/8oXtmksl3uqyyOuvoS1nZGM++C7KvDe202wJphj6z0="
}
```

**#100** `PUBACK` station -> server @ `2026-09-07T13:24:22.362Z`

`messageId=19  reasonCode=0`

**#101** `PUBLISH` station -> server @ `2026-09-07T13:24:52.223Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64188`

```json
{
  "messageId": "55190706-c6ba-4743-a295-dab81a22ee2b",
  "messageType": "Request",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:24:52.223Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {},
  "mac": "aY8aPfQkn2LvfasJXQvZQrMXoVN+TlK5SeRoAR+8qnY="
}
```

**#102** `PINGREQ` station -> server @ `2026-09-07T13:24:52.233Z`


**#103** `PUBACK` server -> station @ `2026-09-07T13:24:52.274Z`

`qos=0  retain=false  messageId=64188  reasonCode=0`

**#104** `PINGRESP` server -> station @ `2026-09-07T13:24:52.284Z`

`qos=0  retain=false`

**#105** `PUBLISH` server -> station @ `2026-09-07T13:24:52.368Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=20`

```json
{
  "messageId": "55190706-c6ba-4743-a295-dab81a22ee2b",
  "messageType": "Response",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:24:52.293Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "serverTime": "2026-09-07T13:24:52.293Z"
  },
  "mac": "7v9vSIMQtxVWX7RhV185a0Mv9ks2KuQNj6pOqkZmbGI="
}
```

**#106** `PUBACK` station -> server @ `2026-09-07T13:24:52.368Z`

`messageId=20  reasonCode=0`

**#107** `PUBLISH` station -> server @ `2026-09-07T13:25:22.224Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64189`

```json
{
  "messageId": "431ff9a4-c5c9-4e5a-91ff-c87f43af51ef",
  "messageType": "Request",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:25:22.224Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {},
  "mac": "aXPpPaYeTde4pNH2A2x8JLbsnkJGukKs8Fbsdy5IlO8="
}
```

**#108** `PUBACK` server -> station @ `2026-09-07T13:25:22.233Z`

`qos=0  retain=false  messageId=64189  reasonCode=0`

**#109** `PUBLISH` server -> station @ `2026-09-07T13:25:22.278Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=21`

```json
{
  "messageId": "431ff9a4-c5c9-4e5a-91ff-c87f43af51ef",
  "messageType": "Response",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:25:22.252Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "serverTime": "2026-09-07T13:25:22.252Z"
  },
  "mac": "n4NhcwL4nxhDBlUs1LsnJg/oyYvG8KJdvU8f9OkNPeY="
}
```

**#110** `PUBACK` station -> server @ `2026-09-07T13:25:22.279Z`

`messageId=21  reasonCode=0`

### ===== STAGE: FIRMWARE =====

**#112** `PUBLISH` station -> server @ `2026-09-07T13:25:52.225Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64190`

```json
{
  "messageId": "153e99bd-4704-4f3e-ae2a-3ed516752257",
  "messageType": "Request",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:25:52.224Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {},
  "mac": "m+i3WwU0nrke69e88Q0wH4nQBr9A3pwrH1Jusi39w+I="
}
```

**#113** `PINGREQ` station -> server @ `2026-09-07T13:25:52.235Z`


**#114** `PUBACK` server -> station @ `2026-09-07T13:25:52.276Z`

`qos=0  retain=false  messageId=64190  reasonCode=0`

**#115** `PINGRESP` server -> station @ `2026-09-07T13:25:52.283Z`

`qos=0  retain=false`

**#116** `PUBLISH` server -> station @ `2026-09-07T13:25:52.375Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=22`

```json
{
  "messageId": "153e99bd-4704-4f3e-ae2a-3ed516752257",
  "messageType": "Response",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:25:52.301Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "serverTime": "2026-09-07T13:25:52.301Z"
  },
  "mac": "yLqlZnWJGmmD9laFa4ibX37yfPp1zdV0oHtPiVSTC3M="
}
```

**#117** `PUBACK` station -> server @ `2026-09-07T13:25:52.376Z`

`messageId=22  reasonCode=0`

**#118** `PUBLISH` station -> server @ `2026-09-07T13:26:22.225Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64191`

```json
{
  "messageId": "76ea2af2-b631-4598-91a0-7b1ab155fb5a",
  "messageType": "Request",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:26:22.224Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {},
  "mac": "t/lRv79KZTkuhIAMrFJn4o68yzAd69qAJZJY0mlbSLE="
}
```

**#119** `PINGREQ` station -> server @ `2026-09-07T13:26:22.284Z`


**#120** `PUBACK` server -> station @ `2026-09-07T13:26:22.385Z`

`qos=0  retain=false  messageId=64191  reasonCode=0`

**#121** `PINGRESP` server -> station @ `2026-09-07T13:26:22.385Z`

`qos=0  retain=false`

**#122** `PUBLISH` server -> station @ `2026-09-07T13:26:22.481Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=23`

```json
{
  "messageId": "76ea2af2-b631-4598-91a0-7b1ab155fb5a",
  "messageType": "Response",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:26:22.353Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "serverTime": "2026-09-07T13:26:22.353Z"
  },
  "mac": "WwaH7uZBxkXnq7nz+2AYBXd/o56+k0fmIJ3KtERcGjI="
}
```

**#123** `PUBACK` station -> server @ `2026-09-07T13:26:22.481Z`

`messageId=23  reasonCode=0`

### ===== STAGE: CERTIFICATE RENEWAL =====

**#125** `PUBLISH` station -> server @ `2026-09-07T13:26:52.225Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64192`

```json
{
  "messageId": "ef28ee09-8b86-45d8-a0de-d712390582cc",
  "messageType": "Request",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:26:52.224Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {},
  "mac": "yuguoY2227W0vnpub4gC5UhZvH5PyxTQRWH96XXdBu8="
}
```

**#126** `PUBACK` server -> station @ `2026-09-07T13:26:52.285Z`

`qos=0  retain=false  messageId=64192  reasonCode=0`

**#127** `PUBLISH` server -> station @ `2026-09-07T13:26:52.386Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=24`

```json
{
  "messageId": "ef28ee09-8b86-45d8-a0de-d712390582cc",
  "messageType": "Response",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:26:52.309Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "serverTime": "2026-09-07T13:26:52.309Z"
  },
  "mac": "k09A43bJFVmQLgvQbzLdSjedF/4XKvQXo7+Ww44Vh80="
}
```

**#128** `PUBACK` station -> server @ `2026-09-07T13:26:52.387Z`

`messageId=24  reasonCode=0`

**#129** `PUBLISH` server -> station @ `2026-09-07T13:27:00.689Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=25`

MQTT properties:
```json
{
  "messageExpiryInterval": 60,
  "correlationData": "01a07c0c-fa16-71cc-b734-ff305984ed40"
}
```

```json
{
  "messageId": "cmd_b104c75d-8b06-40de-a223-7300aa6e3f84",
  "messageType": "Request",
  "action": "TriggerCertificateRenewal",
  "timestamp": "2026-09-07T13:27:00.436Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "certificateType": "StationCertificate"
  },
  "mac": "3LJNb8pYLTgem1oP+6NHlVNUrhMGRU68pZrxYr9Mmko="
}
```

**#130** `PUBLISH` station -> server @ `2026-09-07T13:27:00.691Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64193`

```json
{
  "messageId": "cmd_b104c75d-8b06-40de-a223-7300aa6e3f84",
  "messageType": "Response",
  "action": "TriggerCertificateRenewal",
  "timestamp": "2026-09-07T13:27:00.690Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {
    "status": "Accepted"
  },
  "mac": "QEctg9m6RF+xsf8WGi9fQbffEqizpc0/H83ukBoTfBo="
}
```

**#131** `PUBACK` station -> server @ `2026-09-07T13:27:00.691Z`

`messageId=25  reasonCode=0`

**#132** `PUBACK` server -> station @ `2026-09-07T13:27:00.731Z`

`qos=0  retain=false  messageId=64193  reasonCode=0`

**#133** `PUBLISH` station -> server @ `2026-09-07T13:27:00.745Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64194`

```json
{
  "messageId": "84ab8f4f-b08d-4cfc-ba6c-f85de761f8b0",
  "messageType": "Request",
  "action": "SignCertificate",
  "timestamp": "2026-09-07T13:27:00.744Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {
    "certificateType": "StationCertificate",
    "csr": "-----BEGIN CERTIFICATE REQUEST-----\nMIHSMHkCAQAwFzEVMBMGA1UEAwwMc3RuXzEyOGI2M2YxMFkwEwYHKoZIzj0CAQYI\nKoZIzj0DAQcDQgAEhs95sdYp66Jh5XLpUxRdbBtohxfy8QIVHp8Db9iX11zWDX/J\neUjJWeIxPjOpoMFElEVjOD8+sjdguMPavETiLqAAMAoGCCqGSM49BAMCA0kAMEYC\nIQCu5bJZUIW2ncLcjEPab8/5sncTbuWTuv0Qjej7e1okdQIhAOaaxBaFpbIseVoY\nxkFxR5f9v77d+QuQPA+Llqb83U0i\n-----END CERTIFICATE REQUEST-----"
  },
  "mac": "2suLwF66rDsV9vnrbCdCD+armNhR3bmhRniuFxrxucc="
}
```

**#134** `PUBACK` server -> station @ `2026-09-07T13:27:00.757Z`

`qos=0  retain=false  messageId=64194  reasonCode=0`

**#135** `PUBLISH` server -> station @ `2026-09-07T13:27:00.878Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=26`

MQTT properties:
```json
{
  "messageExpiryInterval": 60
}
```

```json
{
  "messageId": "cmd_86ec26f9-c606-45bb-a1da-7a766a0a3865",
  "messageType": "Request",
  "action": "CertificateInstall",
  "timestamp": "2026-09-07T13:27:00.823Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "certificateType": "StationCertificate",
    "certificate": "-----BEGIN CERTIFICATE-----\nMIIB6zCCAZGgAwIBAgICA70wCgYIKoZIzj0EAwIwVzEeMBwGA1UEAwwVT25lU3Rv\ncFBheSBTdGF0aW9uIENBMRMwEQYDVQQKDApPbmVTdG9wUGF5MQswCQYDVQQGEwJS\nTzETMBEGA1UECAwKU29tZS1TdGF0ZTAeFw0yNjA5MDcxMzI3MDBaFw0yNzA5MDcx\nMzI3MDBaMBcxFTATBgNVBAMMDHN0bl8xMjhiNjNmMTBZMBMGByqGSM49AgEGCCqG\nSM49AwEHA0IABIbPebHWKeuiYeVy6VMUXWwbaIcX8vECFR6fA2/Yl9dc1g1/yXlI\nyVniMT4zqaDBRJRFYzg/PrI3YLjD2rxE4i6jgYwwgYkwCQYDVR0TBAIwADALBgNV\nHQ8EBAMCBeAwEwYDVR0lBAwwCgYIKwYBBQUHAwIwFwYDVR0RBBAwDoIMc3RuXzEy\nOGI2M2YxMEEGA1UdHwQ6MDgwNqA0oDKGMGh0dHBzOi8vYXBpLXVhdC5vbmVzdG9w\ncGF5LnJvL3BraS9zdGF0aW9uLWNhLmNybDAKBggqhkjOPQQDAgNIADBFAiA932jK\n2wzFpx197tnYKDQofzKrh1MZDI5fpwEM7nS6CQIhAI65SoWOyRMdm2zK10pqyea/\n1qEhIciTO0u+oM/2oGMl\n-----END CERTIFICATE-----\n",
    "caCertificateChain": "-----BEGIN CERTIFICATE-----\nMIICDDCCAZOgAwIBAgIBAjAKBggqhkjOPQQDAjBUMRswGQYDVQQDDBJPbmVTdG9w\nUGF5IFJvb3QgQ0ExEzARBgNVBAoMCk9uZVN0b3BQYXkxCzAJBgNVBAYTAlJPMRMw\nEQYDVQQIDApTb21lLVN0YXRlMB4XDTI2MDQyODEyMDUzOVoXDTMxMDQyNzEyMDUz\nOVowVzEeMBwGA1UEAwwVT25lU3RvcFBheSBTdGF0aW9uIENBMRMwEQYDVQQKDApP\nbmVTdG9wUGF5MQswCQYDVQQGEwJSTzETMBEGA1UECAwKU29tZS1TdGF0ZTBZMBMG\nByqGSM49AgEGCCqGSM49AwEHA0IABKfFWU7qg7c6AvYVJVptiMw1/ckHn4r5yaiz\nPmuDqq+y11wqissMNoEWBjzdk4aCRsBD7wSNE0rjlFfdwehKk6WjUzBRMB0GA1Ud\nDgQWBBT95ffIgdW+D4jpHXPlgsh99y27YTAfBgNVHSMEGDAWgBR8zbs0z1fROzbc\nDS1RI2FOGm8/vzAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA2cAMGQCMGYH\na3G56kFmKo58mQtmIcaNQ30XnpGuWgqgTnbrFMqqi5a5xrBhqdYkc/F8K2kI0AIw\nBTwjzfeIeXSh6ZsR+1w2r3t9JfQHJ7njDIZmw4G28QPmfZ+N+MdZQanNTG/4gUuA\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nMIICJjCCAa2gAwIBAgIBATAKBggqhkjOPQQDAzBUMRswGQYDVQQDDBJPbmVTdG9w\nUGF5IFJvb3QgQ0ExEzARBgNVBAoMCk9uZVN0b3BQYXkxCzAJBgNVBAYTAlJPMRMw\nEQYDVQQIDApTb21lLVN0YXRlMB4XDTI2MDQyODEyMDQyOVoXDTQ2MDQyMzEyMDQy\nOVowVDEbMBkGA1UEAwwST25lU3RvcFBheSBSb290IENBMRMwEQYDVQQKDApPbmVT\ndG9wUGF5MQswCQYDVQQGEwJSTzETMBEGA1UECAwKU29tZS1TdGF0ZTB2MBAGByqG\nSM49AgEGBSuBBAAiA2IABD7jrSazsQtfxAvZus3ehOmSkPSKgxqj9M9muzdNk7W6\nAsJQoqyp/gkmJYb8SZhjy2z4fnRyD3ZJY1f4u/xlQVfZ6bQ1jUXNVeCXZgN9Zhg/\n11KjmDuX6+vCIs21vE9In6NTMFEwHQYDVR0OBBYEFHzNuzTPV9E7NtwNLVEjYU4a\nbz+/MB8GA1UdIwQYMBaAFHzNuzTPV9E7NtwNLVEjYU4abz+/MA8GA1UdEwEB/wQF\nMAMBAf8wCgYIKoZIzj0EAwMDZwAwZAIwZGB+zHKrrMn9EQDo3+EWPaeWFP11uWRT\nY8AleKGCdl/1SLGS/YmTGt7kFkSeYi2nAjAdkPwUnBc6xbmhl7CidtbH3dcv7SVk\nOFBSF+43g7vc2/OMPfaXv/fZUY4Q34pi+bg=\n-----END CERTIFICATE-----\n"
  },
  "mac": "33OT7BruBaAPYmw4itEInJbdVtfbN5Dnavv6d0vnQPc="
}
```

**#136** `PUBACK` station -> server @ `2026-09-07T13:27:00.882Z`

`messageId=26  reasonCode=0`

**#137** `PUBLISH` station -> server @ `2026-09-07T13:27:00.883Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=64195`

```json
{
  "messageId": "cmd_86ec26f9-c606-45bb-a1da-7a766a0a3865",
  "messageType": "Response",
  "action": "CertificateInstall",
  "timestamp": "2026-09-07T13:27:00.882Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {
    "status": "Accepted"
  },
  "mac": "cY9d8AcKdTI0t06a5G8BFmROaa2+OSGvg7SkWzQ9H2E="
}
```

**#138** `PUBLISH` server -> station @ `2026-09-07T13:27:00.894Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=27`

```json
{
  "messageId": "84ab8f4f-b08d-4cfc-ba6c-f85de761f8b0",
  "messageType": "Response",
  "action": "SignCertificate",
  "timestamp": "2026-09-07T13:27:00.865Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "status": "Accepted"
  },
  "mac": "eCBm0OTyOOvzgAN2RqQoVbd4hvj8hrD1TNaJsANTlhw="
}
```

**#139** `PUBACK` station -> server @ `2026-09-07T13:27:00.896Z`

`messageId=27  reasonCode=0`

**#140** `PUBACK` server -> station @ `2026-09-07T13:27:00.983Z`

`qos=0  retain=false  messageId=64195  reasonCode=0`

**#141** `DISCONNECT` station -> server @ `2026-09-07T13:27:00.985Z`


MQTT properties:
```json
{
  "sessionExpiryInterval": 0
}
```

### ===== STAGE: OFFLINE =====

### ===== STAGE: CLEAN DISCONNECT =====

> `meta` **stopped** @ 2026-09-07T13:30:03.232Z
```json
{}
```


## Capture file: `stn_128b63f1-reboot.ndjson`

> `meta` **bay-ids** @ 2026-09-07T13:31:32.544Z
```json
{
  "source": "certs/uat/stn_128b63f1-bays.json",
  "derivedLocally": [
    "bay_128b63f101",
    "bay_128b63f102"
  ],
  "used": [
    "bay_dad554b98823f7f82ece181e0105a6ba",
    "bay_70ecda0b84fb2b558526a68afc5b066d"
  ],
  "match": false
}
```

> `meta` **start** @ 2026-09-07T13:31:32.545Z
```json
{
  "stationId": "stn_128b63f1",
  "target": "uat",
  "mqttUrl": "mqtts://mqtt-uat.onestoppay.ro:8883",
  "persistedBrokerUri": "mqtts://mqtt-uat.onestoppay.ro:8883",
  "wireProtocolVersion": "0.3.0",
  "tlsFiles": {
    "key": "certs/uat/stn_128b63f1-key.pem",
    "cert": "certs/uat/stn_128b63f1.pem",
    "chain": "certs/uat/stn_128b63f1-chain.pem"
  }
}
```

> `meta` **tap-attached** @ 2026-09-07T13:31:32.609Z
```json
{}
```

**#4** `CONNACK` server -> station @ `2026-09-07T13:31:32.818Z`

`qos=0  retain=false  reasonCode=0  sessionPresent=false`

MQTT properties:
```json
{
  "sharedSubscriptionAvailable": true,
  "subscriptionIdentifiersAvailable": true,
  "wildcardSubscriptionAvailable": true,
  "maximumPacketSize": 65536,
  "retainAvailable": true,
  "topicAliasMaximum": 65535,
  "receiveMaximum": 10
}
```

**#5** `SUBSCRIBE` station -> server @ `2026-09-07T13:31:32.823Z`

`messageId=13634`

**#6** `SUBACK` server -> station @ `2026-09-07T13:31:32.838Z`

`qos=0  retain=false  messageId=13634  granted=[1]`

> `meta` **connected** @ 2026-09-07T13:31:32.838Z
```json
{
  "lifecycle": "ONLINE"
}
```

**#8** `PUBLISH` station -> server @ `2026-09-07T13:31:41.878Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=13635`

```json
{
  "messageId": "5f8242b0-94fe-48e7-a948-46b9768d7b4f",
  "messageType": "Request",
  "action": "BootNotification",
  "timestamp": "2026-09-07T13:31:41.877Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {
    "stationId": "stn_128b63f1",
    "firmwareVersion": "1.0.0",
    "stationModel": "WashPro X200",
    "stationVendor": "SimCorp",
    "serialNumber": "SIM-1788787892546",
    "bays": [
      {
        "bayNumber": 1,
        "programNumbers": [
          1
        ]
      },
      {
        "bayNumber": 2,
        "programNumbers": [
          1
        ]
      }
    ],
    "uptimeSeconds": 9,
    "pendingOfflineTransactions": 0,
    "timezone": "Europe/Bucharest",
    "bootReason": "PowerOn",
    "messageSigningMode": "All",
    "capabilities": {
      "bleSupported": false,
      "offlineModeSupported": false,
      "meterValuesSupported": true,
      "deviceManagementSupported": true
    },
    "networkInfo": {
      "connectionType": "Ethernet"
    }
  }
}
```

**#9** `PUBACK` server -> station @ `2026-09-07T13:31:41.888Z`

`qos=0  retain=false  messageId=13635  reasonCode=0`

**#10** `PUBLISH` server -> station @ `2026-09-07T13:31:42.076Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=1`

MQTT properties:
```json
{
  "messageExpiryInterval": 60
}
```

```json
{
  "messageId": "cmd_be1daf2d-c80b-4ef6-b81f-a814a667ea88",
  "messageType": "Request",
  "action": "ChangeConfiguration",
  "timestamp": "2026-09-07T13:31:42.028Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "keys": [
      {
        "key": "RevocationEpoch",
        "value": "0"
      }
    ]
  },
  "mac": "iF9PW7k7Cn/H+xnOGXNkCqQcjwrKpY7H1iOf8YujF6w="
}
```

**#11** `PUBACK` station -> server @ `2026-09-07T13:31:42.077Z`

`messageId=1  reasonCode=0`

**#12** `PUBLISH` server -> station @ `2026-09-07T13:31:42.100Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=2`

```json
{
  "messageId": "5f8242b0-94fe-48e7-a948-46b9768d7b4f",
  "messageType": "Response",
  "action": "BootNotification",
  "timestamp": "2026-09-07T13:31:42.017Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "status": "Accepted",
    "serverTime": "2026-09-07T13:31:42.017Z",
    "heartbeatIntervalSec": 30,
    "configuration": {
      "HeartbeatIntervalSeconds": "30",
      "MaxSessionDurationSeconds": "600",
      "ConnectionLostGracePeriod": "300"
    },
    "sessionKey": "<redacted-session-key>"
  }
}
```

**#14** `PUBACK` station -> server @ `2026-09-07T13:31:42.177Z`

`messageId=2  reasonCode=0`

**#13** `PUBLISH` station -> server @ `2026-09-07T13:31:42.177Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=13636`

```json
{
  "messageId": "429c2e0e-1d6a-419a-96ec-b4ca138099e1",
  "messageType": "Event",
  "action": "StatusNotification",
  "timestamp": "2026-09-07T13:31:42.175Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {
    "bayId": "bay_dad554b98823f7f82ece181e0105a6ba",
    "bayNumber": 1,
    "status": "Available",
    "programs": [
      {
        "programNumber": 1,
        "available": true
      }
    ]
  },
  "mac": "HvjyTCOz17X7xXj3QXreHcUp+MLhXHPfwnSzzJJmXV8="
}
```

**#15** `PUBACK` server -> station @ `2026-09-07T13:31:42.195Z`

`qos=0  retain=false  messageId=13636  reasonCode=0`

**#16** `PUBLISH` station -> server @ `2026-09-07T13:31:42.196Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=13637`

```json
{
  "messageId": "a3096342-f2d1-4600-8832-0f8da6d3013f",
  "messageType": "Event",
  "action": "StatusNotification",
  "timestamp": "2026-09-07T13:31:42.195Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {
    "bayId": "bay_70ecda0b84fb2b558526a68afc5b066d",
    "bayNumber": 2,
    "status": "Available",
    "programs": [
      {
        "programNumber": 1,
        "available": true
      }
    ]
  },
  "mac": "VTpoD/OOS8NG8TaruGMuK+maBd2q2USR0AIVW66KCO8="
}
```

**#17** `PUBACK` server -> station @ `2026-09-07T13:31:42.206Z`

`qos=0  retain=false  messageId=13637  reasonCode=0`

**#18** `PUBLISH` station -> server @ `2026-09-07T13:32:12.175Z`

`topic="ospp/v1/stations/stn_128b63f1/to-server"  qos=1  retain=false  messageId=13638`

```json
{
  "messageId": "62978819-1dd4-4e32-8c75-01fc99c649eb",
  "messageType": "Request",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:32:12.174Z",
  "source": "Station",
  "protocolVersion": "0.3.0",
  "payload": {},
  "mac": "yNRemcMxdwiU6k0pdJ9ldClDF9PVh5PwbAIu7Pbc2/M="
}
```

**#19** `PUBACK` server -> station @ `2026-09-07T13:32:12.190Z`

`qos=0  retain=false  messageId=13638  reasonCode=0`

**#20** `PUBLISH` server -> station @ `2026-09-07T13:32:12.280Z`

`topic="ospp/v1/stations/stn_128b63f1/to-station"  qos=1  retain=false  messageId=3`

```json
{
  "messageId": "62978819-1dd4-4e32-8c75-01fc99c649eb",
  "messageType": "Response",
  "action": "Heartbeat",
  "timestamp": "2026-09-07T13:32:12.203Z",
  "source": "Server",
  "protocolVersion": "0.3.0",
  "payload": {
    "serverTime": "2026-09-07T13:32:12.203Z"
  },
  "mac": "RlEv7f4j/O7/rNgGlIt7nMozTbHm/d4WioSp4aybmHA="
}
```

**#21** `PUBACK` station -> server @ `2026-09-07T13:32:12.284Z`

`messageId=3  reasonCode=0`

**#22** `DISCONNECT` station -> server @ `2026-09-07T13:32:12.286Z`


MQTT properties:
```json
{
  "sessionExpiryInterval": 0
}
```

> `meta` **stopped** @ 2026-09-07T13:32:12.553Z
```json
{}
```
