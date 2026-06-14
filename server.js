const express = require('express');
const http = require('http');
const ws = require('ws');
const websocketStream = require('websocket-stream');
const aedesFactory = require('aedes');

// Initialize Aedes MQTT broker
const aedes = aedesFactory();

const app = express();
const port = process.env.PORT || 8080;

// Serve static dashboard files from the "public" directory
app.use(express.static('public'));

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server attached to the HTTP server
const wss = new ws.Server({ server: server });

wss.on('connection', function (conn, req) {
  const stream = websocketStream(conn);
  aedes.handle(stream);
});

// Statistics trackers
let activeClients = 0;
let publishedMessages = 0;
let subscriptionsCount = 0;
const clientList = new Set();
const topicStats = {};

// Optional authentication
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;

if (MQTT_USERNAME && MQTT_PASSWORD) {
  console.log(`[AUTH] MQTT Broker Authentication is ENABLED. Username: ${MQTT_USERNAME}`);
  aedes.authenticate = function (client, username, password, callback) {
    const authorized = (username === MQTT_USERNAME && password && password.toString() === MQTT_PASSWORD);
    if (!authorized) {
      console.log(`[AUTH] Authentication FAILED for client: ${client ? client.id : 'unknown'}`);
      const error = new Error('Unauthorized');
      error.returnCode = 4; // Connection Refused: Bad user name or password
      callback(error, null);
    } else {
      console.log(`[AUTH] Authentication SUCCESS for client: ${client ? client.id : 'unknown'}`);
      callback(null, true);
    }
  };
} else {
  console.log("[AUTH] MQTT Broker is running in PUBLIC mode (no credentials required).");
  console.log("[AUTH] Define MQTT_USERNAME and MQTT_PASSWORD environment variables to secure the broker.");
}

// Aedes event logging & stats collection
aedes.on('client', function (client) {
  if (client) {
    console.log(`[CONN] Client connected: \x1b[32m${client.id}\x1b[0m`);
    clientList.add(client.id);
    activeClients = clientList.size;
  }
});

aedes.on('clientDisconnect', function (client) {
  if (client) {
    console.log(`[CONN] Client disconnected: \x1b[31m${client.id}\x1b[0m`);
    clientList.delete(client.id);
    activeClients = clientList.size;
  }
});

aedes.on('subscribe', function (subscriptions, client) {
  if (client) {
    const topics = subscriptions.map(s => s.topic).join(', ');
    console.log(`[SUB] Client \x1b[36m${client.id}\x1b[0m subscribed to: ${topics}`);
    subscriptionsCount += subscriptions.length;
  }
});

aedes.on('unsubscribe', function (subscriptions, client) {
  if (client) {
    console.log(`[SUB] Client \x1b[36m${client.id}\x1b[0m unsubscribed from: ${subscriptions.join(', ')}`);
    subscriptionsCount = Math.max(0, subscriptionsCount - subscriptions.length);
  }
});

aedes.on('publish', function (packet, client) {
  if (packet && packet.topic && !packet.topic.startsWith('$SYS')) {
    publishedMessages++;
    const topic = packet.topic;
    topicStats[topic] = (topicStats[topic] || 0) + 1;
    
    let payloadStr = '';
    try {
      payloadStr = packet.payload ? packet.payload.toString() : '';
    } catch (e) {
      payloadStr = '[Binary Data]';
    }
    const sender = client ? client.id : 'SERVER/BROKER';
    console.log(`[PUB] Client \x1b[33m${sender}\x1b[0m published to \x1b[35m${topic}\x1b[0m: "${payloadStr.substring(0, 100)}"`);
  }
});

// REST Endpoint for broker stats
app.get('/api/stats', (req, res) => {
  res.json({
    activeClients,
    clientList: Array.from(clientList),
    publishedMessages,
    subscriptionsCount,
    topicStats,
    uptime: Math.floor(process.uptime()),
    memory: process.memoryUsage().rss,
    authEnabled: !!(MQTT_USERNAME && MQTT_PASSWORD)
  });
});

// Start HTTP Server
server.listen(port, () => {
  console.log(`=========================================`);
  console.log(`🚀 MQTT Broker running on WebSockets`);
  console.log(`🔗 Local Address: http://localhost:${port}`);
  console.log(`📡 WebSocket URL: ws://localhost:${port}`);
  console.log(`=========================================`);
});
