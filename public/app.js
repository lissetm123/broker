// Aether MQTT Console Client Scripts

let mqttClient = null;
const clientSubscriptions = new Set();
let statsInterval = null;
let idToken = null;
let authBypassed = false;

// DOM Selectors
const wsUrlInput = document.getElementById('wsUrl');
const clientIdInput = document.getElementById('clientId');
const cleanSessionSelect = document.getElementById('cleanSession');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const credentialsArea = document.getElementById('credentialsArea');
const btnConnect = document.getElementById('btnConnect');
const clientConnectionBadge = document.getElementById('clientConnectionBadge');

const tabPub = document.getElementById('tabPub');
const tabSub = document.getElementById('tabSub');
const pubContent = document.getElementById('pubContent');
const subContent = document.getElementById('subContent');

const pubTopicInput = document.getElementById('pubTopic');
const pubQosSelect = document.getElementById('pubQos');
const pubRetainSelect = document.getElementById('pubRetain');
const pubPayloadTextarea = document.getElementById('pubPayload');
const btnPublish = document.getElementById('btnPublish');

const subTopicInput = document.getElementById('subTopic');
const btnSubscribe = document.getElementById('btnSubscribe');
const clientSubscriptionsList = document.getElementById('clientSubscriptionsList');

const terminalLog = document.getElementById('terminalLog');
const btnClearTerminal = document.getElementById('btnClearTerminal');
const chkAutoscroll = document.getElementById('chkAutoscroll');

// Server Metrics Selectors
const serverPulse = document.getElementById('serverPulse');
const serverStatusText = document.getElementById('serverStatusText');
const serverUptime = document.getElementById('serverUptime');
const valConnections = document.getElementById('valConnections');
const clientListText = document.getElementById('clientListText');
const valMessages = document.getElementById('valMessages');
const valSubscriptions = document.getElementById('valSubscriptions');
const valMemory = document.getElementById('valMemory');
const valUptimeDetailed = document.getElementById('valUptimeDetailed');

// User Management DOM Selectors
const formAddUser = document.getElementById('formAddUser');
const newUsernameInput = document.getElementById('newUsername');
const newPasswordInput = document.getElementById('newPassword');
const usersList = document.getElementById('usersList');
const userCountBadge = document.getElementById('userCountBadge');

// Default Initialization
window.addEventListener('DOMContentLoaded', () => {
  // 1. Auto-generate Client ID
  const randomId = Math.random().toString(16).substring(2, 8).toUpperCase();
  clientIdInput.value = `Aether-Console-${randomId}`;

  // 2. Set default WS URL based on current host
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const defaultWsUrl = `${protocol}//${window.location.host}`;
  wsUrlInput.value = defaultWsUrl;

  // 3. Set a default JSON payload for Publish tab
  setPreset('climate');

  // 4. Initialize Firebase Authentication & Stats Polling
  initFirebaseAuth();
  statsInterval = setInterval(() => {
    if (idToken || authBypassed) {
      fetchServerStats();
    }
  }, 2500);

  // 5. Connect UI event handlers
  setupUIEventHandlers();

  // 6. Fetch user credentials list
  fetchUsersList();

  // 7. Bind user creation form submit
  if (formAddUser) {
    formAddUser.addEventListener('submit', addUser);
  }
});

// Setup UI Tab toggling & inputs
function setupUIEventHandlers() {
  // Tab Switcher
  tabPub.addEventListener('click', () => {
    tabPub.classList.add('active');
    tabSub.classList.remove('active');
    pubContent.classList.remove('hidden');
    subContent.classList.add('hidden');
  });

  tabSub.addEventListener('click', () => {
    tabSub.classList.add('active');
    tabPub.classList.remove('active');
    subContent.classList.remove('hidden');
    pubContent.classList.add('hidden');
  });

  // Connect Button
  btnConnect.addEventListener('click', () => {
    if (mqttClient && mqttClient.connected) {
      disconnectClient();
    } else {
      connectClient();
    }
  });

  // Publish Button
  btnPublish.addEventListener('click', publishMessage);

  // Subscribe Button
  btnSubscribe.addEventListener('click', subscribeTopic);

  // Clear Terminal Button
  btnClearTerminal.addEventListener('click', () => {
    terminalLog.innerHTML = '<div class="terminal-line system-line">[System] Terminal log cleared.</div>';
  });
}

// Format uptime helper
function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

// Fetch Server Metrics from express REST API
async function fetchServerStats() {
  try {
    const headers = {};
    if (idToken) headers['Authorization'] = `Bearer ${idToken}`;
    const response = await fetch('/api/stats', { headers });
    if (!response.ok) throw new Error('API request failed');
    const data = await response.json();

    // Update Server Status Panel
    serverPulse.className = 'status-pulse online';
    serverStatusText.textContent = data.authEnabled ? 'Broker Online (Secured)' : 'Broker Online (Public)';
    serverUptime.textContent = formatUptime(data.uptime);

    // Update Metrics
    valConnections.textContent = data.activeClients;
    valMessages.textContent = data.publishedMessages;
    valSubscriptions.textContent = data.subscriptionsCount;
    
    // Memory usage in MB
    const memoryMB = Math.round(data.memory / 1024 / 1024);
    valMemory.textContent = `${memoryMB} MB`;
    
    valUptimeDetailed.textContent = `Uptime: ${formatUptime(data.uptime)}`;

    // Update client list subtext
    if (data.clientList.length > 0) {
      const displayClients = data.clientList.slice(0, 3).join(', ');
      const overflow = data.clientList.length > 3 ? ` (+${data.clientList.length - 3} more)` : '';
      clientListText.textContent = `Clients: ${displayClients}${overflow}`;
    } else {
      clientListText.textContent = 'No active devices connected';
    }

    // Dynamic visibility of credentials inputs if Auth is enabled on server
    if (data.authEnabled) {
      credentialsArea.style.display = 'grid';
    } else {
      credentialsArea.style.display = 'none';
    }

  } catch (error) {
    serverPulse.className = 'status-pulse';
    serverStatusText.textContent = 'Broker API Unreachable';
    serverUptime.textContent = '--';
    
    valConnections.textContent = '-';
    clientListText.textContent = 'Broker unreachable';
    valMessages.textContent = '-';
    valSubscriptions.textContent = '-';
    valMemory.textContent = '- MB';
  }
}

// Connect the built-in Console MQTT client
function connectClient() {
  let url = wsUrlInput.value.trim();
  if (idToken && !url.includes('token=')) {
    const separator = url.includes('?') ? '&' : '?';
    url = `${url}${separator}token=${encodeURIComponent(idToken)}`;
  }
  const clientId = clientIdInput.value.trim() || 'Aether-Console-Default';
  const clean = cleanSessionSelect.value === 'true';
  const username = usernameInput.value.trim();
  const password = passwordInput.value;

  if (!url) {
    appendTerminalLine('SystemError', 'WebSocket URL is required.');
    return;
  }

  appendTerminalLine('System', `Connecting to broker at ${url}...`);
  btnConnect.disabled = true;
  btnConnect.innerHTML = '<i data-lucide="loader"></i> Connecting...';
  lucide.createIcons();

  const options = {
    clientId,
    clean,
    connectTimeout: 5000,
    reconnectPeriod: 0 // Do not auto-reconnect on console manual disconnects
  };

  if (username) {
    options.username = username;
    options.password = password;
  }

  try {
    mqttClient = mqtt.connect(url, options);

    mqttClient.on('connect', () => {
      appendTerminalLine('Connection', `Connected successfully with Client ID: ${clientId}`);
      
      // Update UI
      clientConnectionBadge.className = 'badge online';
      clientConnectionBadge.textContent = 'Connected';
      btnConnect.disabled = false;
      btnConnect.innerHTML = '<i data-lucide="unplug"></i> Disconnect Client';
      btnConnect.classList.replace('primary-btn', 'btn-secondary');
      
      // Enable Actions
      btnPublish.disabled = false;
      btnSubscribe.disabled = false;
      
      lucide.createIcons();
    });

    mqttClient.on('message', (topic, message, packet) => {
      let payloadStr = '';
      try {
        payloadStr = message.toString();
      } catch (err) {
        payloadStr = '[Binary data]';
      }
      
      const qos = packet.qos;
      const retain = packet.retain ? ' (Retained)' : '';
      appendTerminalLine('Publish', `[Topic: ${topic}] QoS ${qos}${retain} -> ${payloadStr}`);
    });

    mqttClient.on('close', () => {
      appendTerminalLine('Disconnection', 'Client connection closed.');
      resetClientUI();
    });

    mqttClient.on('error', (err) => {
      appendTerminalLine('SystemError', `Client error: ${err.message || err}`);
      resetClientUI();
    });

  } catch (err) {
    appendTerminalLine('SystemError', `Failed to initialize client: ${err.message}`);
    resetClientUI();
  }
}

// Disconnect the built-in Console MQTT client
function disconnectClient() {
  if (mqttClient) {
    appendTerminalLine('System', 'Disconnecting client...');
    mqttClient.end(true, () => {
      appendTerminalLine('System', 'Disconnected.');
      resetClientUI();
    });
  }
}

// Reset Client UI when disconnected or on error
function resetClientUI() {
  mqttClient = null;
  clientSubscriptions.clear();
  renderSubscriptions();

  clientConnectionBadge.className = 'badge offline';
  clientConnectionBadge.textContent = 'Offline';
  
  btnConnect.disabled = false;
  btnConnect.innerHTML = '<i data-lucide="plug"></i> Connect Client';
  btnConnect.classList.replace('btn-secondary', 'primary-btn');
  
  btnPublish.disabled = true;
  btnSubscribe.disabled = true;
  
  lucide.createIcons();
}

// Publish Message
function publishMessage() {
  if (!mqttClient || !mqttClient.connected) return;

  const topic = pubTopicInput.value.trim();
  const qos = parseInt(pubQosSelect.value) || 0;
  const retain = pubRetainSelect.value === 'true';
  const payload = pubPayloadTextarea.value;

  if (!topic) {
    appendTerminalLine('SystemError', 'Topic name is required to publish.');
    return;
  }

  mqttClient.publish(topic, payload, { qos, retain }, (err) => {
    if (err) {
      appendTerminalLine('SystemError', `Publish failed: ${err}`);
    } else {
      // If we are subscribed to the topic (or a wildcard matching it),
      // MQTT.js will automatically receive the message and fire 'message'.
      // If not, let's log the publish event in the terminal for feedback.
      appendTerminalLine('System', `Published to [${topic}] QoS ${qos} (Retain: ${retain})`);
    }
  });
}

// Subscribe to Topic
function subscribeTopic() {
  if (!mqttClient || !mqttClient.connected) return;

  const topic = subTopicInput.value.trim();
  if (!topic) return;

  if (clientSubscriptions.has(topic)) {
    appendTerminalLine('SystemError', `Already subscribed to ${topic}`);
    return;
  }

  mqttClient.subscribe(topic, { qos: 0 }, (err) => {
    if (err) {
      appendTerminalLine('SystemError', `Failed to subscribe to ${topic}: ${err}`);
    } else {
      appendTerminalLine('Subscription', `Subscribed to topic filter: ${topic}`);
      clientSubscriptions.add(topic);
      renderSubscriptions();
      subTopicInput.value = '';
    }
  });
}

// Unsubscribe from Topic
function unsubscribeTopic(topic) {
  if (!mqttClient || !mqttClient.connected) return;

  mqttClient.unsubscribe(topic, (err) => {
    if (err) {
      appendTerminalLine('SystemError', `Failed to unsubscribe from ${topic}: ${err}`);
    } else {
      appendTerminalLine('Subscription', `Unsubscribed from topic filter: ${topic}`);
      clientSubscriptions.delete(topic);
      renderSubscriptions();
    }
  });
}

// Render subscription list in UI
function renderSubscriptions() {
  clientSubscriptionsList.innerHTML = '';

  if (clientSubscriptions.size === 0) {
    clientSubscriptionsList.innerHTML = '<li class="empty-state">No client-side subscriptions</li>';
    return;
  }

  clientSubscriptions.forEach(topic => {
    const li = document.createElement('li');
    
    const textSpan = document.createElement('span');
    textSpan.className = 'topic-name';
    textSpan.textContent = topic;

    const qosSpan = document.createElement('span');
    qosSpan.className = 'qos-badge';
    qosSpan.textContent = 'QoS 0';
    textSpan.appendChild(qosSpan);

    const btnUnsub = document.createElement('button');
    btnUnsub.className = 'btn-unsubscribe';
    btnUnsub.innerHTML = '<i data-lucide="x"></i>';
    btnUnsub.title = 'Unsubscribe';
    btnUnsub.addEventListener('click', () => unsubscribeTopic(topic));

    li.appendChild(textSpan);
    li.appendChild(btnUnsub);
    clientSubscriptionsList.appendChild(li);
  });

  lucide.createIcons();
}

// Write line into terminal
function appendTerminalLine(type, text) {
  const line = document.createElement('div');
  
  // Create timestamp
  const timeSpan = document.createElement('span');
  timeSpan.className = 'timestamp';
  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
  timeSpan.textContent = `[${timeStr}]`;
  line.appendChild(timeSpan);

  // Add line type content
  const contentSpan = document.createElement('span');
  contentSpan.textContent = text;
  line.appendChild(contentSpan);

  // Class mapping
  if (type === 'System') {
    line.className = 'terminal-line system-line';
  } else if (type === 'SystemError') {
    line.className = 'terminal-line disconn-line';
    contentSpan.style.color = 'var(--accent-rose)';
  } else if (type === 'Connection') {
    line.className = 'terminal-line conn-line';
  } else if (type === 'Disconnection') {
    line.className = 'terminal-line disconn-line';
  } else if (type === 'Publish') {
    line.className = 'terminal-line pub-line';
  } else if (type === 'Subscription') {
    line.className = 'terminal-line sub-line';
  } else {
    line.className = 'terminal-line';
  }

  terminalLog.appendChild(line);

  // Autoscroll logic
  if (chkAutoscroll.checked) {
    terminalLog.scrollTop = terminalLog.scrollHeight;
  }
}

// Populate payload presets
window.setPreset = function(type) {
  if (type === 'climate') {
    pubTopicInput.value = 'home/sensors/climate';
    pubPayloadTextarea.value = JSON.stringify({
      sensor_id: "living-room-sensor",
      temperature: 23.4,
      humidity: 45.2,
      timestamp: Math.floor(Date.now() / 1000)
    }, null, 2);
  } else if (type === 'alert') {
    pubTopicInput.value = 'home/security/alerts';
    pubPayloadTextarea.value = JSON.stringify({
      device_id: "front-door-camera",
      event: "motion_detected",
      severity: "high",
      clip_id: "rec_" + Math.random().toString(16).substring(2, 10)
    }, null, 2);
  }
};

// User Management Functions
async function fetchUsersList() {
  try {
    const headers = {};
    if (idToken) headers['Authorization'] = `Bearer ${idToken}`;
    const response = await fetch('/api/users', { headers });
    if (!response.ok) throw new Error('Failed to fetch user accounts');
    const users = await response.json();
    renderUsersList(users);
  } catch (err) {
    console.error('Error fetching user accounts:', err);
  }
}

function renderUsersList(users) {
  if (!usersList) return;
  usersList.innerHTML = '';

  // Update badge count
  if (userCountBadge) {
    userCountBadge.textContent = `${users.length} Account${users.length === 1 ? '' : 's'}`;
    if (users.length > 0) {
      userCountBadge.className = 'badge online';
    } else {
      userCountBadge.className = 'badge offline';
    }
  }

  if (users.length === 0) {
    usersList.innerHTML = '<li class="empty-state">No credentials set (Broker is Public)</li>';
    return;
  }

  users.forEach(username => {
    const li = document.createElement('li');

    const tagSpan = document.createElement('span');
    tagSpan.className = 'username-tag';
    tagSpan.innerHTML = `<i data-lucide="user"></i> <span>${username}</span>`;

    const btnDelete = document.createElement('button');
    btnDelete.className = 'btn-delete-user';
    btnDelete.innerHTML = '<i data-lucide="trash-2"></i>';
    btnDelete.title = `Delete ${username}`;
    btnDelete.addEventListener('click', () => deleteUser(username));

    li.appendChild(tagSpan);
    li.appendChild(btnDelete);
    usersList.appendChild(li);
  });

  // Re-render Lucide icons for the newly added dynamic nodes
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

async function addUser(e) {
  if (e) e.preventDefault();
  
  const username = newUsernameInput.value.trim();
  const password = newPasswordInput.value;

  if (!username || password.length < 6) {
    alert('Please enter a username, and a password containing at least 6 characters.');
    return;
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (idToken) headers['Authorization'] = `Bearer ${idToken}`;
    const response = await fetch('/api/users', {
      method: 'POST',
      headers,
      body: JSON.stringify({ username, password })
    });
    
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to create credentials');

    newUsernameInput.value = '';
    newPasswordInput.value = '';

    appendTerminalLine('System', `Account successfully created for: "${username}"`);
    
    // Refresh lists and stats
    await fetchUsersList();
    await fetchServerStats();
  } catch (err) {
    appendTerminalLine('SystemError', `Failed to create credentials: ${err.message}`);
  }
}

async function deleteUser(username) {
  if (!username) return;
  if (!confirm(`Are you sure you want to delete the credentials for "${username}"?`)) return;

  try {
    const headers = {};
    if (idToken) headers['Authorization'] = `Bearer ${idToken}`;
    const response = await fetch(`/api/users/${username}`, {
      method: 'DELETE',
      headers
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to delete credentials');

    appendTerminalLine('System', `Account deleted for: "${username}"`);

    // Refresh lists and stats
    await fetchUsersList();
    await fetchServerStats();
  } catch (err) {
    appendTerminalLine('SystemError', `Failed to delete credentials: ${err.message}`);
  }
}

// Firebase Authentication and Client-side flow setup
async function initFirebaseAuth() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error('Failed to load Firebase config from server');
    const config = await response.json();

    // If no Firebase config keys are available on server, bypass login overlay (developer/local mode)
    if (!config.apiKey || !config.projectId) {
      console.log('[AUTH] Firebase App config missing on server. Bypassing Google Sign-In.');
      authBypassed = true;
      document.getElementById('loginOverlay').classList.add('fade-out');
      document.getElementById('appContainer').style.display = 'flex';
      
      // Load tables/metrics directly
      fetchServerStats();
      fetchUsersList();
      return;
    }

    // Initialize Firebase client
    firebase.initializeApp(config);
    const auth = firebase.auth();
    const provider = new firebase.auth.GoogleAuthProvider();

    // Bind login button Click
    document.getElementById('btnGoogleLogin').addEventListener('click', () => {
      document.getElementById('loginLoading').classList.remove('hidden');
      document.getElementById('loginError').classList.add('hidden');
      
      auth.signInWithPopup(provider).catch(err => {
        document.getElementById('loginLoading').classList.add('hidden');
        document.getElementById('loginError').textContent = `Google sign-in failed: ${err.message}`;
        document.getElementById('loginError').classList.remove('hidden');
      });
    });

    // Listen for Auth changes
    auth.onAuthStateChanged(async (user) => {
      if (user) {
        document.getElementById('loginLoading').classList.remove('hidden');
        try {
          idToken = await user.getIdToken(true);
          
          // Verify ID token against server /api/stats endpoint
          const testResponse = await fetch('/api/stats', {
            headers: { 'Authorization': `Bearer ${idToken}` }
          });

          if (testResponse.status === 403) {
            throw new Error('Access Denied: Only the administrator account is allowed access.');
          }
          if (!testResponse.ok) {
            throw new Error(`Auth verification failed: ${testResponse.statusText}`);
          }

          // Verification Success: Hide login, show dashboard
          document.getElementById('loginOverlay').classList.add('fade-out');
          document.getElementById('appContainer').style.display = 'flex';
          document.getElementById('loginLoading').classList.add('hidden');

          // Append token to default WS client URL field
          updateWsUrlWithToken();

          // Load stats
          fetchServerStats();
          fetchUsersList();
        } catch (err) {
          console.error(err);
          document.getElementById('loginLoading').classList.add('hidden');
          document.getElementById('loginError').textContent = err.message;
          document.getElementById('loginError').classList.remove('hidden');
          auth.signOut();
        }
      } else {
        idToken = null;
        document.getElementById('loginOverlay').classList.remove('fade-out');
        document.getElementById('appContainer').style.display = 'none';
      }
    });
  } catch (err) {
    console.error('[AUTH] Failed to initialize Firebase Auth client:', err);
    document.getElementById('loginError').textContent = `Configuration Error: ${err.message}`;
    document.getElementById('loginError').classList.remove('hidden');
  }
}

function updateWsUrlWithToken() {
  if (!wsUrlInput) return;
  const currentVal = wsUrlInput.value.split('?')[0];
  if (idToken) {
    wsUrlInput.value = `${currentVal}?token=${encodeURIComponent(idToken)}`;
  }
}
