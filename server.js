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
    req.user = { email: ADMIN_EMAIL || 'admin@example.com' };
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

// Normalize accidental double-slash URLs (e.g. //api/stats -> /api/stats)
app.use((req, res, next) => {
  if (req.path.includes('//')) {
    const cleanPath = req.path.replace(/\/\/+/g, '/');
    return res.redirect(301, cleanPath + (req.url.includes('?') ? '?' + req.url.split('?')[1] : ''));
  }
  next();
});

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server attached to the HTTP server (no server, upgrade manually)
const wss = new ws.Server({ noServer: true });

// All WebSocket upgrade connections are accepted at the transport level.
// Authentication is handled at the MQTT protocol level by aedes.authenticate
// using the MQTT CONNECT packet's username and password fields.
server.on('upgrade', (request, socket, head) => {
  const ip = request.headers['x-forwarded-for'] || request.socket.remoteAddress;
  console.log(`[WS] Upgrade requested from IP: \x1b[36m${ip}\x1b[0m for URL: ${request.url}`);
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', function (conn, req) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[WS] Connection established from IP: \x1b[36m${ip}\x1b[0m`);
  
  conn.on('close', () => {
    console.log(`[WS] Connection closed from IP: \x1b[36m${ip}\x1b[0m`);
  });

  conn.on('error', (err) => {
    console.error(`\x1b[31m[WS] Connection error from IP: ${ip}: ${err.message}\x1b[0m`);
  });

  const stream = websocketStream(conn);
  aedes.handle(stream);
});

// Statistics trackers
let activeClients = 0;
let publishedMessages = 0;
let subscriptionsCount = 0;
const clientList = new Set();
const topicStats = {};
const clientSubscriptions = new Map(); // clientId -> Set<topic>

// Helper to extract client IP address (handles WebSockets and standard TCP)
function getClientIp(client) {
  if (!client) return 'unknown';
  if (client.req) {
    const forwardedFor = client.req.headers && client.req.headers['x-forwarded-for'];
    if (forwardedFor) {
      return forwardedFor.split(',')[0].trim();
    }
    if (client.req.socket && client.req.socket.remoteAddress) {
      return client.req.socket.remoteAddress;
    }
  }
  if (client.conn) {
    if (client.conn.remoteAddress) {
      return client.conn.remoteAddress;
    }
    if (client.conn.socket && client.conn.socket.remoteAddress) {
      return client.conn.socket.remoteAddress;
    }
  }
  return 'unknown';
}

// Reconnect loop detector storage
const connectionAttempts = new Map();

// Periodically clean up stale connection attempts (older than 10 seconds)
setInterval(() => {
  const now = Date.now();
  for (const [clientId, attempts] of connectionAttempts.entries()) {
    const recent = attempts.filter(ts => now - ts < 10000);
    if (recent.length === 0) {
      connectionAttempts.delete(clientId);
    } else {
      connectionAttempts.set(clientId, recent);
    }
  }
}, 60000).unref();

// Database-backed MQTT authentication
aedes.authenticate = async function (client, username, password, callback) {
  const ip = getClientIp(client);
  const clientId = client ? client.id : 'unknown';
  try {
    const users = await usersDb.getUsers();
    
    // If no users exist, allow all connections (developer public mode)
    if (users.length === 0) {
      console.log(`[AUTH] Client ${clientId} connected from IP ${ip} with no credentials (public mode).`);
      callback(null, true);
      return;
    }
    
    if (!username || !password) {
      console.log(`[AUTH] Connection rejected: credentials required but missing for client: ${clientId} from IP ${ip}`);
      const error = new Error('Auth error: credentials required');
      error.returnCode = 4; // Username/password bad
      callback(error, null);
      return;
    }

    const authorized = await usersDb.authenticate(username, password.toString());
    if (authorized) {
      console.log(`[AUTH] Client ${clientId} authenticated successfully from IP ${ip} as user "${username}".`);
      callback(null, true);
    } else {
      console.log(`[AUTH] Authentication failed for client ${clientId} from IP ${ip} with username "${username}".`);
      const error = new Error('Auth error: invalid credentials');
      error.returnCode = 4;
      callback(error, null);
    }
  } catch (err) {
    console.error(`[AUTH] Authentication handler error for client ${clientId} from IP ${ip}:`, err.message);
    callback(err, null);
  }
};

// Aedes event logging & stats collection
aedes.on('client', function (client) {
  if (client) {
    const ip = getClientIp(client);
    console.log(`[CONN] Client registering: \x1b[32m${client.id}\x1b[0m (IP: ${ip})`);
    clientList.add(client.id);
    activeClients = clientList.size;

    // Reconnect loop detection (concerning client connection)
    const now = Date.now();
    const attempts = connectionAttempts.get(client.id) || [];
    const recentAttempts = attempts.filter(ts => now - ts < 10000);
    recentAttempts.push(now);
    connectionAttempts.set(client.id, recentAttempts);

    if (recentAttempts.length > 5) {
      console.warn(`\x1b[33m[CONN][WARN] Client ${client.id} (IP: ${ip}) is in a rapid reconnect loop! (${recentAttempts.length} connections in 10s)\x1b[0m`);
    }
  }
});

aedes.on('clientReady', function (client) {
  if (client) {
    const ip = getClientIp(client);
    console.log(`[CONN] Client ready and established: \x1b[32m${client.id}\x1b[0m (IP: ${ip})`);
  }
});

aedes.on('clientDisconnect', function (client) {
  if (client) {
    const ip = getClientIp(client);
    console.log(`[CONN] Client disconnected: \x1b[31m${client.id}\x1b[0m (IP: ${ip})`);
    clientList.delete(client.id);
    activeClients = clientList.size;
    clientSubscriptions.delete(client.id);
  }
});

aedes.on('clientError', function (client, err) {
  if (client) {
    const ip = getClientIp(client);
    console.error(`\x1b[31m[CONN][ERROR] Client error for ${client.id} (IP: ${ip}): ${err.message}\x1b[0m`);
  } else {
    console.error(`\x1b[31m[CONN][ERROR] Client error: ${err.message}\x1b[0m`);
  }
});

aedes.on('connectionError', function (client, err) {
  const clientId = client ? client.id : 'unknown';
  const ip = getClientIp(client);
  console.error(`\x1b[31m[CONN][ERROR] Connection error for client ${clientId} (IP: ${ip}): ${err.message}\x1b[0m`);
});

aedes.on('keepaliveTimeout', function (client) {
  if (client) {
    const ip = getClientIp(client);
    console.warn(`\x1b[33m[CONN][WARN] Client ${client.id} (IP: ${ip}) timed out (keepalive timeout)\x1b[0m`);
  }
});

aedes.on('subscribe', function (subscriptions, client) {
  if (client) {
    const ip = getClientIp(client);
    const topics = subscriptions.map(s => s.topic);
    console.log(`[SUB] Client \x1b[36m${client.id}\x1b[0m (IP: ${ip}) subscribed to: ${topics.join(', ')}`);
    
    // Warn about wildcard subscriptions which can be resource-intensive or security issues
    subscriptions.forEach(sub => {
      if (sub.topic.includes('#') || sub.topic.includes('+')) {
        console.warn(`\x1b[33m[SUB][WARN] Client ${client.id} (IP: ${ip}) subscribed to wildcard topic: "${sub.topic}"\x1b[0m`);
      }
    });

    subscriptionsCount += subscriptions.length;
    if (!clientSubscriptions.has(client.id)) clientSubscriptions.set(client.id, new Set());
    topics.forEach(t => clientSubscriptions.get(client.id).add(t));
  }
});

aedes.on('unsubscribe', function (subscriptions, client) {
  if (client) {
    const ip = getClientIp(client);
    console.log(`[SUB] Client \x1b[36m${client.id}\x1b[0m (IP: ${ip}) unsubscribed from: ${subscriptions.join(', ')}`);
    subscriptionsCount = Math.max(0, subscriptionsCount - subscriptions.length);
    if (clientSubscriptions.has(client.id)) {
      subscriptions.forEach(t => clientSubscriptions.get(client.id).delete(t));
    }
  }
});

aedes.on('publish', function (packet, client) {
  if (packet && packet.topic && !packet.topic.startsWith('$SYS')) {
    publishedMessages++;
    const topic = packet.topic;
    topicStats[topic] = (topicStats[topic] || 0) + 1;
    
    let payloadStr = '';
    const payloadLength = packet.payload ? packet.payload.length : 0;
    try {
      payloadStr = packet.payload ? packet.payload.toString() : '';
    } catch (e) {
      payloadStr = '[Binary Data]';
    }
    const sender = client ? client.id : 'SERVER/BROKER';
    const ip = getClientIp(client);
    
    // Log warnings for exceptionally large payloads (> 100KB)
    if (payloadLength > 102400) {
      console.warn(`\x1b[33m[PUB][WARN] Client ${sender} (IP: ${ip}) published a large payload of ${payloadLength} bytes to topic "${topic}"\x1b[0m`);
    } else {
      console.log(`[PUB] Client \x1b[33m${sender}\x1b[0m published to \x1b[35m${topic}\x1b[0m: "${payloadStr.substring(0, 100)}"`);
    }
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

// Cache for the resolved Cloud Run WS URL
let cachedWsUrl = null;

// Expose public Firebase configuration parameters
app.get('/api/config', async (req, res) => {
  const config = {
    apiKey: process.env.FIREBASE_API_KEY || "",
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || "",
    projectId: process.env.FIREBASE_PROJECT_ID || "",
    wsUrl: ""
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

  // Resolve Cloud Run WebSocket URL dynamically
  if (cachedWsUrl) {
    config.wsUrl = cachedWsUrl;
  } else {
    try {
      const projectNumber = await fetchMetadata('/computeMetadata/v1/project/numeric-project-id');
      const regionRaw = await fetchMetadata('/computeMetadata/v1/instance/region');
      const region = regionRaw.includes('/') ? regionRaw.split('/').pop() : regionRaw;
      const serviceName = process.env.K_SERVICE || 'broker';

      if (projectNumber && !projectNumber.startsWith('Error') && region && !region.startsWith('Error')) {
        cachedWsUrl = `wss://${serviceName}-${projectNumber}.${region}.run.app`;
        config.wsUrl = cachedWsUrl;
        console.log(`[WS] Dynamically resolved Cloud Run WS URL: ${cachedWsUrl}`);
      }
    } catch (err) {
      console.warn('[WS] Could not dynamically resolve Cloud Run WS URL:', err.message);
    }
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
  return res.status(401).json({ error: 'Invalid administrator credentials. Default: username=admin' });
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

    // Build a flat, deduplicated list of all broker-side subscribed topics
    const brokerTopics = new Set();
    clientSubscriptions.forEach(topics => topics.forEach(t => brokerTopics.add(t)));

    // Build per-client subscription map for the response
    const clientSubsMap = {};
    clientSubscriptions.forEach((topics, clientId) => {
      clientSubsMap[clientId] = Array.from(topics);
    });

    res.json({
      activeClients,
      clientList: Array.from(clientList),
      clientSubsMap,
      publishedMessages,
      subscriptionsCount,
      brokerTopics: Array.from(brokerTopics),
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
