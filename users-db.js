const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let admin = null;
let firestoreDb = null;
let dbType = 'file'; // 'file' or 'firestore'

const LOCAL_DB_DIR = path.join(__dirname, 'data');
const LOCAL_DB_FILE = path.join(LOCAL_DB_DIR, 'users.json');
const LOCAL_ADMIN_FILE = path.join(LOCAL_DB_DIR, 'admin.json');

function ensureLocalAdminFile() {
  if (!fs.existsSync(LOCAL_DB_DIR)) {
    fs.mkdirSync(LOCAL_DB_DIR, { recursive: true });
  }
  if (!fs.existsSync(LOCAL_ADMIN_FILE)) {
    // Default admin credentials: username=admin, password=Simplimatic123
    const defaultHash = hashPassword('Simplimatic123');
    fs.writeFileSync(LOCAL_ADMIN_FILE, JSON.stringify({ passwordHash: defaultHash }, null, 2));
  }
}

// Helper to hash password using built-in crypto (SHA-256)
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Ensure local JSON DB file exists
function ensureLocalDbFile() {
  if (!fs.existsSync(LOCAL_DB_DIR)) {
    fs.mkdirSync(LOCAL_DB_DIR, { recursive: true });
  }
  if (!fs.existsSync(LOCAL_DB_FILE)) {
    fs.writeFileSync(LOCAL_DB_FILE, JSON.stringify({}, null, 2));
  }
}

// Initialize User DB
function init() {
  try {
    // Attempt to load firebase-admin
    admin = require('firebase-admin');

    const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
    const hasServiceAccount = fs.existsSync(serviceAccountPath);
    const hasGoogleCreds = !!process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const hasFirebaseConfig = !!process.env.FIREBASE_CONFIG;

    if (hasServiceAccount || hasGoogleCreds || hasFirebaseConfig) {
      if (hasServiceAccount) {
        const serviceAccount = require(serviceAccountPath);
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount)
        });
      } else {
        admin.initializeApp({
          credential: admin.credential.applicationDefault()
        });
      }
      firestoreDb = admin.firestore();
      dbType = 'firestore';
      console.log('[DB] Firebase Admin initialized. Using Firestore for MQTT credentials.');
    } else {
      console.log('[DB] No Firebase configuration found. Falling back to local file database.');
      setupFileDatabase();
    }
  } catch (err) {
    console.log(`[DB] Firebase initialization skipped/failed: ${err.message}. Using local file database.`);
    setupFileDatabase();
  }
}

function setupFileDatabase() {
  dbType = 'file';
  ensureLocalDbFile();
  ensureLocalAdminFile();
  console.log(`[DB] Local JSON database loaded at: ${LOCAL_DB_FILE}`);
}

// Get lists of all usernames
async function getUsers() {
  if (dbType === 'firestore') {
    try {
      const snapshot = await firestoreDb.collection('mqtt_users').get();
      const users = [];
      snapshot.forEach(doc => {
        users.push(doc.id);
      });
      return users;
    } catch (err) {
      console.error('[DB] Failed to get users from Firestore:', err.message);
      return [];
    }
  } else {
    ensureLocalDbFile();
    try {
      const raw = fs.readFileSync(LOCAL_DB_FILE, 'utf8');
      const data = JSON.parse(raw || '{}');
      return Object.keys(data);
    } catch (err) {
      console.error('[DB] Failed to read local user file:', err.message);
      return [];
    }
  }
}

// Create a new user
async function createUser(username, password) {
  if (!username || !password) return false;
  const passwordHash = hashPassword(password);

  if (dbType === 'firestore') {
    try {
      await firestoreDb.collection('mqtt_users').doc(username).set({
        passwordHash,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`[DB] Created user "${username}" in Firestore.`);
      return true;
    } catch (err) {
      console.error(`[DB] Failed to create user "${username}" in Firestore:`, err.message);
      return false;
    }
  } else {
    ensureLocalDbFile();
    try {
      const raw = fs.readFileSync(LOCAL_DB_FILE, 'utf8');
      const data = JSON.parse(raw || '{}');
      data[username] = { passwordHash };
      fs.writeFileSync(LOCAL_DB_FILE, JSON.stringify(data, null, 2));
      console.log(`[DB] Created user "${username}" in local file database.`);
      return true;
    } catch (err) {
      console.error(`[DB] Failed to write local user "${username}":`, err.message);
      return false;
    }
  }
}

// Delete user
async function deleteUser(username) {
  if (!username) return false;

  if (dbType === 'firestore') {
    try {
      await firestoreDb.collection('mqtt_users').doc(username).delete();
      console.log(`[DB] Deleted user "${username}" from Firestore.`);
      return true;
    } catch (err) {
      console.error(`[DB] Failed to delete user "${username}" from Firestore:`, err.message);
      return false;
    }
  } else {
    ensureLocalDbFile();
    try {
      const raw = fs.readFileSync(LOCAL_DB_FILE, 'utf8');
      const data = JSON.parse(raw || '{}');
      if (data[username]) {
        delete data[username];
        fs.writeFileSync(LOCAL_DB_FILE, JSON.stringify(data, null, 2));
        console.log(`[DB] Deleted user "${username}" from local file database.`);
        return true;
      }
      return false;
    } catch (err) {
      console.error(`[DB] Failed to delete local user "${username}":`, err.message);
      return false;
    }
  }
}

// Authenticate username and password
async function authenticate(username, password) {
  if (!username || !password) return false;
  const inputHash = hashPassword(password);

  if (dbType === 'firestore') {
    try {
      const doc = await firestoreDb.collection('mqtt_users').doc(username).get();
      if (!doc.exists) return false;
      const storedHash = doc.data().passwordHash;
      return inputHash === storedHash;
    } catch (err) {
      console.error(`[DB] Firestore auth error for "${username}":`, err.message);
      return false;
    }
  } else {
    ensureLocalDbFile();
    try {
      const raw = fs.readFileSync(LOCAL_DB_FILE, 'utf8');
      const data = JSON.parse(raw || '{}');
      if (!data[username]) return false;
      const storedHash = data[username].passwordHash;
      return inputHash === storedHash;
    } catch (err) {
      console.error(`[DB] Local file auth error for "${username}":`, err.message);
      return false;
    }
  }
}

// Get local admin password hash
async function getAdminPasswordHash() {
  if (dbType === 'firestore') {
    try {
      const doc = await firestoreDb.collection('admin_config').doc('local_admin').get();
      if (doc.exists) {
        return doc.data().passwordHash;
      }
      // Default if not set in Firestore
      return hashPassword('Simplimatic123');
    } catch (err) {
      console.error('[DB] Failed to get admin password from Firestore:', err.message);
      return hashPassword('Simplimatic123');
    }
  } else {
    ensureLocalAdminFile();
    try {
      const raw = fs.readFileSync(LOCAL_ADMIN_FILE, 'utf8');
      const data = JSON.parse(raw || '{}');
      return data.passwordHash || hashPassword('Simplimatic123');
    } catch (err) {
      console.error('[DB] Failed to read local admin file:', err.message);
      return hashPassword('Simplimatic123');
    }
  }
}

// Update local admin password hash
async function setAdminPasswordHash(newPassword) {
  const passwordHash = hashPassword(newPassword);
  if (dbType === 'firestore') {
    try {
      await firestoreDb.collection('admin_config').doc('local_admin').set({
        passwordHash,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log('[DB] Updated local admin password in Firestore.');
      return true;
    } catch (err) {
      console.error('[DB] Failed to update admin password in Firestore:', err.message);
      return false;
    }
  } else {
    ensureLocalAdminFile();
    try {
      fs.writeFileSync(LOCAL_ADMIN_FILE, JSON.stringify({ passwordHash }, null, 2));
      console.log('[DB] Updated local admin password in local file database.');
      return true;
    } catch (err) {
      console.error('[DB] Failed to write local admin password:', err.message);
      return false;
    }
  }
}

// Authenticate local admin username and password
async function authenticateAdmin(username, password) {
  if (!username || !password) return false;
  // Accept 'admin' as the local administrator username
  if (username !== 'admin' && username !== 'admin@example.com') return false;
  const adminHash = await getAdminPasswordHash();
  const inputHash = hashPassword(password);
  return inputHash === adminHash;
}

module.exports = {
  init,
  getUsers,
  createUser,
  deleteUser,
  authenticate,
  getAdminPasswordHash,
  setAdminPasswordHash,
  authenticateAdmin
};
