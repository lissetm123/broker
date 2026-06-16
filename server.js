const express = require('express');
const http = require('http');
const ws = require('ws');
const websocketStream = require('websocket-stream');
const aedesFactory = require('aedes');

// Initialize Aedes MQTT broker
const aedes = aedesFactory();

// Initialize Database
const admin = require('firebase-admin');
const usersDb = require('./users-db');
usersDb.init();

// Middleware to verify Firebase ID Token and restrict to ADMIN_EMAIL
async function requireAdmin(req, res, next) {
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
  
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // If no administrator email is configured, bypass verification (developer/local mode)
    if (!ADMIN_EMAIL) {
      return next();
    }
    return res.status(401).json({ error: 'Unauthorized: missing authorization header' });
  }

  const idToken = authHeader.split('Bearer ')[1];
  if (idToken === 'local-admin-token-luis') {
    req.user = { email: ADMIN_EMAIL || 'luis@example.com' };
    return next();
  }

  // If no administrator email is configured, bypass verification (developer/local mode)
  if (!ADMIN_EMAIL) {
    return next();
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    if (decodedToken.email !== ADMIN_EMAIL) {
      console.log(`[AUTH] Access denied for user: ${decodedToken.email} (Admin email is configured to: ${ADMIN_EMAIL})`);
      return res.status(403).json({ error: 'Forbidden: only the administrator is allowed' });
    }
    req.user = decodedToken;
    next();
  } catch (err) {
    console.error(`[AUTH] ID Token verification failed: ${err.message}`);
    return res.status(401).json({ error: `Unauthorized: ${err.message}` });
  }
}

const app = express();
const port = process.env.PORT || 8080;

// Middleware for JSON parsing and static assets
app.use(express.json());
app.use(express.static('public'));

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server attached to the HTTP server (no server, upgrade manually)
const wss = new ws.Server({ noServer: true });

// All WebSocket upgrade connections are accepted at the transport level.
// Authentication is handled at the MQTT protocol level by aedes.authenticate
// using the MQTT CONNECT packet's username and password fields.
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

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

// Helper to fetch from local Metadata Server
function fetchMetadata(path) {
  return new Promise((resolve) => {
    http.get({
      hostname: 'metadata.google.internal',
      path: path,
      headers: { 'Metadata-Flavor': 'Google' },
      timeout: 1000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data.trim()));
    }).on('error', (err) => {
      resolve(`Error: ${err.message}`);
    });
  });
}

// Debug endpoint to retrieve Cloud Run metadata
app.get('/api/debug', async (req, res) => {
  const projectId = await fetchMetadata('/computeMetadata/v1/project/project-id');
  const projectNumber = await fetchMetadata('/computeMetadata/v1/project/numeric-project-id');
  const regionRaw = await fetchMetadata('/computeMetadata/v1/instance/region');
  
  // Region metadata usually returns "projects/PROJECT_NUMBER/regions/REGION_NAME"
  const region = regionRaw.includes('/') ? regionRaw.split('/').pop() : regionRaw;

  res.json({
    env: {
      K_SERVICE: process.env.K_SERVICE,
      K_REVISION: process.env.K_REVISION,
      PORT: process.env.PORT
    },
    metadata: {
      projectId,
      projectNumber,
      region
    }
  });
});

// Expose public Firebase configuration parameters
app.get('/api/config', (req, res) => {
  const config = {
    apiKey: process.env.FIREBASE_API_KEY || "",
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || "",
    projectId: process.env.FIREBASE_PROJECT_ID || ""
  };

  // Attempt to parse standard Firebase configuration environment variable
  if (process.env.FIREBASE_CONFIG) {
    try {
      const parsed = JSON.parse(process.env.FIREBASE_CONFIG);
      config.apiKey = config.apiKey || parsed.apiKey;
      config.authDomain = config.authDomain || parsed.authDomain;
      config.projectId = config.projectId || parsed.projectId;
    } catch (e) {
      console.error('Failed to parse FIREBASE_CONFIG env var:', e.message);
    }
  }

  // Auto-resolve project ID from initialized Admin SDK if missing
  if (!config.projectId && admin && admin.apps.length > 0) {
    const appOptions = admin.apps[0].options;
    config.projectId = appOptions.projectId || (appOptions.credential && appOptions.credential.projectId);
  }

  res.json(config);
});

// Local login endpoint for bypass credentials
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const authorized = await usersDb.authenticateAdmin(username, password);
  if (authorized) {
    console.log(`[AUTH] Successful local login for user: ${username}`);
    return res.json({ token: 'local-admin-token-luis' });
  }
  console.log(`[AUTH] Failed local login attempt for user: ${username}`);
  return res.status(401).json({ error: 'Invalid local administrator credentials.' });
});

// Change Administrator own password (local bypass credentials)
app.post('/api/admin/change-password', requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  try {
    const success = await usersDb.setAdminPasswordHash(password);
    if (success) {
      console.log(`[AUTH] Administrator password changed successfully.`);
      res.json({ success: true, message: 'Administrator password changed successfully.' });
    } else {
      res.status(500).json({ error: 'Failed to update administrator password.' });
    }
  } catch (err) {
    console.error('[AUTH] Admin change-password error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// User management API endpoints (enforced admin security)
app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const list = await usersDb.getUsers();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', requireAdmin, async (req, res) => {
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

app.delete('/api/users/:username', requireAdmin, async (req, res) => {
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

// REST Endpoint for broker stats (enforced admin security)
app.get('/api/stats', requireAdmin, async (req, res) => {
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
