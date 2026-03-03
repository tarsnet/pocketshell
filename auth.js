const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');

const CONFIG_PATH = path.join(__dirname, '.auth.json');
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes
const SERVICE_NAME = 'ClaudeTerminal';

// --- Rate limiting (in-memory) ---
const rateLimitMap = new Map();

function checkRateLimit(ip) {
  const entry = rateLimitMap.get(ip);
  if (!entry) return { allowed: true };
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
    const remaining = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
    return { allowed: false, remaining };
  }
  if (entry.lockedUntil && Date.now() >= entry.lockedUntil) {
    rateLimitMap.delete(ip);
    return { allowed: true };
  }
  return { allowed: true };
}

function recordFailedAttempt(ip) {
  const entry = rateLimitMap.get(ip) || { count: 0 };
  entry.count++;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_DURATION;
    entry.count = 0;
  }
  rateLimitMap.set(ip, entry);
}

function clearAttempts(ip) {
  rateLimitMap.delete(ip);
}

// --- Config persistence ---
function loadConfig() {
  try {
    const data = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function isSetupComplete() {
  const config = loadConfig();
  return config && config.setupComplete === true;
}

// --- Password hashing (pbkdf2) ---
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const verify = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(verify, 'hex'));
}

// --- TOTP ---
function generateTotpSecret() {
  return authenticator.generateSecret();
}

function verifyTotp(token, secret) {
  try {
    return authenticator.verify({ token, secret });
  } catch (e) {
    return false;
  }
}

async function generateQrDataUrl(secret, label) {
  const otpauthUrl = authenticator.keyuri(label || 'user', SERVICE_NAME, secret);
  return QRCode.toDataURL(otpauthUrl);
}

// --- Session tokens (HMAC-signed) ---
function createSessionToken(sessionSecret) {
  const payload = JSON.stringify({ ts: Date.now() });
  const data = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret).update(data).digest('hex');
  return `${data}.${sig}`;
}

function verifySessionToken(token, sessionSecret) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [data, sig] = parts;
  const expected = crypto.createHmac('sha256', sessionSecret).update(data).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return false;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    return (Date.now() - payload.ts) < SESSION_DURATION;
  } catch (e) {
    return false;
  }
}

// --- Cookie parsing ---
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const [key, ...vals] = c.trim().split('=');
    if (key) cookies[key.trim()] = vals.join('=');
  });
  return cookies;
}

// --- Express middleware ---
function authMiddleware(req, res, next) {
  const config = loadConfig();
  if (!config || !config.setupComplete) {
    return res.redirect('/login.html');
  }
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.session;
  if (verifySessionToken(token, config.sessionSecret)) {
    return next();
  }
  return res.redirect('/login.html');
}

// --- WebSocket auth check ---
function authenticateWs(req) {
  const config = loadConfig();
  if (!config || !config.setupComplete) return false;
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.session;
  return verifySessionToken(token, config.sessionSecret);
}

// --- Route setup ---
function setupRoutes(app) {
  // GET /auth/status — public, returns setup state
  app.get('/auth/status', (req, res) => {
    const config = loadConfig();
    const setupComplete = config && config.setupComplete === true;
    let isAuthenticated = false;
    if (setupComplete) {
      const cookies = parseCookies(req.headers.cookie);
      isAuthenticated = verifySessionToken(cookies.session, config.sessionSecret);
    }
    res.json({ setupComplete, isAuthenticated });
  });

  // GET /auth/setup-info — returns QR code (only before setup is complete)
  app.get('/auth/setup-info', async (req, res) => {
    if (isSetupComplete()) {
      return res.status(403).json({ error: 'Setup already complete' });
    }
    // Generate a temporary secret (stored in memory until confirmed)
    if (!app.locals._pendingSecret) {
      app.locals._pendingSecret = generateTotpSecret();
    }
    try {
      const qrDataUrl = await generateQrDataUrl(app.locals._pendingSecret);
      res.json({
        qrDataUrl,
        secret: app.locals._pendingSecret, // show for manual entry
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to generate QR code' });
    }
  });

  // POST /auth/setup — complete first-time setup
  app.post('/auth/setup', (req, res) => {
    if (isSetupComplete()) {
      return res.status(403).json({ error: 'Setup already complete' });
    }
    const { password, totpCode } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (!totpCode) {
      return res.status(400).json({ error: 'TOTP code required' });
    }
    const secret = app.locals._pendingSecret;
    if (!secret) {
      return res.status(400).json({ error: 'No pending setup. Refresh the page.' });
    }
    if (!verifyTotp(totpCode, secret)) {
      return res.status(400).json({ error: 'Invalid TOTP code. Check your authenticator app.' });
    }
    // Save config
    const sessionSecret = crypto.randomBytes(32).toString('hex');
    const config = {
      passwordHash: hashPassword(password),
      totpSecret: secret,
      sessionSecret,
      setupComplete: true,
      createdAt: new Date().toISOString(),
    };
    saveConfig(config);
    delete app.locals._pendingSecret;

    // Auto-login after setup
    const token = createSessionToken(sessionSecret);
    const isSecure = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https';
    res.cookie('session', token, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: SESSION_DURATION,
      secure: isSecure,
    });
    res.json({ success: true });
  });

  // POST /auth/login — authenticate
  app.post('/auth/login', (req, res) => {
    const config = loadConfig();
    if (!config || !config.setupComplete) {
      return res.status(400).json({ error: 'Setup not complete' });
    }
    const ip = req.ip || req.connection.remoteAddress;
    const rateCheck = checkRateLimit(ip);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: `Too many attempts. Try again in ${rateCheck.remaining}s`,
      });
    }
    const { password, totpCode } = req.body;
    if (!password || !totpCode) {
      return res.status(400).json({ error: 'Password and TOTP code required' });
    }
    if (!verifyPassword(password, config.passwordHash)) {
      recordFailedAttempt(ip);
      return res.status(401).json({ error: 'Invalid password or TOTP code' });
    }
    if (!verifyTotp(totpCode, config.totpSecret)) {
      recordFailedAttempt(ip);
      return res.status(401).json({ error: 'Invalid password or TOTP code' });
    }
    clearAttempts(ip);
    const token = createSessionToken(config.sessionSecret);
    const isSecure = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https';
    res.cookie('session', token, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: SESSION_DURATION,
      secure: isSecure,
    });
    res.json({ success: true });
  });

  // POST /auth/logout
  app.post('/auth/logout', (req, res) => {
    res.clearCookie('session');
    res.json({ success: true });
  });

  // POST /auth/reset — reset setup (requires current password + TOTP)
  app.post('/auth/reset', (req, res) => {
    const config = loadConfig();
    if (!config || !config.setupComplete) {
      return res.json({ success: true });
    }
    const { password, totpCode } = req.body;
    if (!verifyPassword(password, config.passwordHash) || !verifyTotp(totpCode, config.totpSecret)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    try {
      fs.unlinkSync(CONFIG_PATH);
    } catch (e) { /* ignore */ }
    res.clearCookie('session');
    res.json({ success: true });
  });
}

module.exports = {
  setupRoutes,
  authMiddleware,
  authenticateWs,
  isSetupComplete,
  loadConfig,
  parseCookies,
};
