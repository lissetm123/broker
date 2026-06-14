const express = require('express');
const http = require('http');
const ws = require('ws');
const websocketStream = require('websocket-stream');
const aedesFactory = require('aedes');

// Initialize Aedes MQTT broker
const aedes = aedesFactory();

// Initialize Database
const usersDb = require('./users-db');
usersDb.init();

const app = express();
const port = process.env.PORT || 8080;

// Middleware for JSON parsing and static assets
app.use(express.json());
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

// Database-backed MQTT authentication
aedes.authenticate = async function (client, username, password, callback) {
  try {
    const users = await usersDb.getUsers();
    
    // If no users exist, allow all connections (developer public mode)
    if (users.length === 0) {
      callback(null, true);
      return;
    }
    
    if (!username || !password) {
      console.log(`[AUTH] Connection rejected: credentials required but missing for client: ${client ? client.id : 'unknown'}`);
      const error = new Error('Auth error: credentials required');
      error.returnCode = 4; // Username/password bad
      callback(error, null);
      return;
    }

    const authorized = await usersDb.authenticate(username, password.toString());
    if (authorized) {
      console.log(`[AUTH] Client ${client ? client.id : 'unknown'} authenticated successfully as user "${username}".`);
      callback(null, true);
    } else {
      console.log(`[AUTH] Authentication failed for client ${client ? client.id : 'unknown'} with username "${username}".`);
      const error = new Error('Auth error: invalid credentials');
      error.returnCode = 4;
      callback(error, null);
    }
  } catch (err) {
    console.error('[AUTH] Authentication handler error:', err.message);
    callback(err, null);
  }
};

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

// User management API endpoints
app.get('/api/users', async (req, res) => {
  try {
    const list = await usersDb.getUsers();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  try {
    const success = await usersDb.createUser(username, password);
    if (success) {
      res.status(201).json({ success: true, message: `User ${username} created successfully.` });
    } else {
      res.status(500).json({ error: 'Failed to create user.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:username', async (req, res) => {
  const { username } = req.params;
  try {
    const success = await usersDb.deleteUser(username);
    if (success) {
      res.json({ success: true, message: `User ${username} deleted.` });
    } else {
      res.status(404).json({ error: 'User not found or delete failed.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// REST Endpoint for broker stats
app.get('/api/stats', async (req, res) => {
  try {
    const users = await usersDb.getUsers();
    res.json({
      activeClients,
      clientList: Array.from(clientList),
      publishedMessages,
      subscriptionsCount,
      topicStats,
      uptime: Math.floor(process.uptime()),
      memory: process.memoryUsage().rss,
      authEnabled: users.length > 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start HTTP Server
server.listen(port, () => {
  console.log(`=========================================`);
  console.log(`🚀 MQTT Broker running on WebSockets`);
  console.log(`🔗 Local Address: http://localhost:${port}`);
  console.log(`📡 WebSocket URL: ws://localhost:${port}`);
  console.log(`=========================================`);
});
