const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const auth = require('./auth');

// --- CLI flags ---
const args = process.argv.slice(2);
const NO_AUTH = args.includes('--no-auth');
const portFlagIndex = args.indexOf('--port');
const PORT = (portFlagIndex !== -1 && args[portFlagIndex + 1])
  ? parseInt(args[portFlagIndex + 1], 10)
  : (parseInt(process.env.PORT, 10) || 3000);

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`[server] invalid port: ${PORT} (must be 1-65535)`);
  process.exit(1);
}

const REMOTE = args.includes('--remote');
const BIND_HOST = (NO_AUTH && !REMOTE) ? '127.0.0.1' : '0.0.0.0';
const SETUP_TOKEN = crypto.randomBytes(16).toString('hex');

const REPLAY_BUFFER_SIZE = 100 * 1024; // 100KB

// --- Mode definitions ---
const MODES = {
  claude:   { cmd: 'claude',  label: 'Claude Code' },
  copilot:  { cmd: 'copilot', label: 'GitHub Copilot' },
  terminal: { cmd: null,      label: 'Terminal' },  // null = plain bash -l
};

const VALID_MODES = new Set(Object.keys(MODES));

const app = express();
const server = http.createServer(app);

// Trust proxy so req.protocol detects HTTPS behind tunnels
app.set('trust proxy', 1);

// --- Body parsing ---
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// --- Security headers ---
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
    "connect-src 'self' ws: wss:; " +
    "img-src 'self' data:;"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// --- PtySession class ---
class PtySession {
  constructor(mode) {
    this.mode = mode;
    this.ptyProcess = null;
    this.replayBuffer = '';
    this.clients = new Set();
  }

  spawn(cols = 120, rows = 30) {
    if (this.ptyProcess) {
      try { this.ptyProcess.kill(); } catch (e) { console.warn(`[pty:${this.mode}] kill error on respawn:`, e.message); }
    }
    this.replayBuffer = '';

    const shell = process.env.SHELL || '/bin/bash';
    const env = { ...process.env, TERM: 'xterm-256color' };
    // Remove nested-session guard so claude can launch from within this server
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE;

    const modeConfig = MODES[this.mode];

    // For commands (claude, copilot): spawn the binary directly to avoid
    // any bash profile/rc noise. For terminal: use login shell.
    const spawnCmd = modeConfig.cmd || shell;
    const spawnArgs = modeConfig.cmd ? [] : ['-l'];

    this.ptyProcess = pty.spawn(spawnCmd, spawnArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.env.HOME || process.cwd(),
      env,
    });

    console.log(`[pty:${this.mode}] spawned (pid ${this.ptyProcess.pid}), cols=${cols} rows=${rows}`);

    this.ptyProcess.onData((data) => {
      this.replayBuffer += data;
      if (this.replayBuffer.length > REPLAY_BUFFER_SIZE) {
        this.replayBuffer = this.replayBuffer.slice(-REPLAY_BUFFER_SIZE);
      }

      const msg = JSON.stringify({ type: 'output', data });
      for (const ws of this.clients) {
        if (ws.readyState === 1) { // WebSocket.OPEN
          ws.send(msg);
        }
      }
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`[pty:${this.mode}] exited (code=${exitCode}, signal=${signal})`);
      const msg = JSON.stringify({ type: 'exit', exitCode, signal });
      for (const ws of this.clients) {
        if (ws.readyState === 1) {
          ws.send(msg);
        }
      }
      this.ptyProcess = null;
    });
  }

  kill() {
    if (this.ptyProcess) {
      try { this.ptyProcess.kill(); } catch (e) { console.warn(`[pty:${this.mode}] kill error:`, e.message); }
      this.ptyProcess = null;
    }
  }
}

// --- Sessions Map ---
const sessions = new Map();

function getOrCreateSession(mode) {
  let session = sessions.get(mode);
  if (!session) {
    session = new PtySession(mode);
    sessions.set(mode, session);
    session.spawn();
  } else if (!session.ptyProcess) {
    // PTY exited; respawn
    session.spawn();
  }
  return session;
}

// Eagerly spawn all modes at startup so they're fully ready by the time
// a user navigates through auth/landing page.
for (const mode of Object.keys(MODES)) {
  getOrCreateSession(mode);
}

// --- Redirect old direct-access URLs to landing page ---
app.get('/desktop.html', (req, res) => res.redirect('/'));
app.get('/mobile.html', (req, res) => res.redirect('/'));

// --- Auth setup ---
if (NO_AUTH) {
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
  app.use(express.static(path.join(__dirname, 'public')));
} else {
  // Auth API routes (public, no auth required)
  auth.setupRoutes(app, SETUP_TOKEN);

  // Serve login page without auth — must come before authMiddleware
  app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  });

  // Auth middleware (everything below requires login)
  app.use(auth.authMiddleware);

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // Static files (protected)
  app.use(express.static(path.join(__dirname, 'public')));
}

// --- Cache HTML templates ---
const desktopHtml = fs.readFileSync(path.join(__dirname, 'public', 'desktop.html'), 'utf8');
const mobileHtml = fs.readFileSync(path.join(__dirname, 'public', 'mobile.html'), 'utf8');

// --- View + mode routes: /desktop/:mode and /mobile/:mode ---
// Pre-spawn PTY on page load so bash profile noise clears before WS connects.
// Cache-bust asset URLs so phones don't serve stale broken files.
const startupTs = Date.now();

function serveModeHtml(template, mode, res) {
  // Pre-spawn the PTY session so it's ready by the time WebSocket connects
  getOrCreateSession(mode);

  const modeScript = `<script>window.POCKETSHELL_MODE="${mode}";</script>`;
  let html = template.replace('</head>', modeScript + '\n</head>');
  // Cache-bust local assets to avoid stale cached 404s
  html = html.replace(/((?:src|href)="\/[^"]+\.(?:js|css))(")/g, `$1?v=${startupTs}$2`);

  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.type('html').send(html);
}

app.get('/desktop/:mode(claude|copilot|terminal)', (req, res) => {
  serveModeHtml(desktopHtml, req.params.mode, res);
});

app.get('/mobile/:mode(claude|copilot|terminal)', (req, res) => {
  serveModeHtml(mobileHtml, req.params.mode, res);
});

// --- WebSocket Server (with auth + path routing) ---
const wss = new WebSocketServer({
  server,
  verifyClient: (info) => {
    // Validate WebSocket path: must be /ws/{mode}
    const urlPath = info.req.url || '';
    const match = urlPath.match(/^\/ws\/(claude|copilot|terminal)$/);
    if (!match) return false;

    // Stash mode on request for later use
    info.req._pocketshellMode = match[1];

    if (NO_AUTH) return true;
    return auth.authenticateWs(info.req);
  },
});

// --- WebSocket connections ---
wss.on('connection', (ws, req) => {
  const mode = req._pocketshellMode;
  if (!mode || !VALID_MODES.has(mode)) {
    ws.close();
    return;
  }

  const session = getOrCreateSession(mode);
  session.clients.add(ws);
  console.log(`[ws:${mode}] client connected (total: ${session.clients.size})`);

  // Send replay buffer so new client sees current terminal state
  if (session.replayBuffer.length > 0) {
    ws.send(JSON.stringify({ type: 'output', data: session.replayBuffer }));
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      console.warn(`[ws:${mode}] invalid JSON from client:`, e.message);
      return;
    }

    switch (msg.type) {
      case 'input':
        if (session.ptyProcess && typeof msg.data === 'string') {
          session.ptyProcess.write(msg.data);
        }
        break;

      case 'resize':
        if (session.ptyProcess && msg.cols && msg.rows) {
          const cols = Math.min(500, Math.max(1, Math.floor(msg.cols)));
          const rows = Math.min(200, Math.max(1, Math.floor(msg.rows)));
          try {
            session.ptyProcess.resize(cols, rows);
          } catch (e) {
            console.warn(`[ws:${mode}] resize error:`, e.message);
          }
        }
        break;

      case 'restart':
        console.log(`[ws:${mode}] restart requested`);
        session.spawn(msg.cols || 120, msg.rows || 30);
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    session.clients.delete(ws);
    console.log(`[ws:${mode}] client disconnected (total: ${session.clients.size})`);
  });
});

// --- Graceful shutdown ---
function shutdown() {
  console.log('\n[server] shutting down...');
  for (const session of sessions.values()) {
    session.kill();
  }
  wss.close();
  server.close(() => process.exit(0));
  // Force exit after 3 seconds
  setTimeout(() => process.exit(1), 3000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Start ---
server.listen(PORT, BIND_HOST, () => {
  console.log('');
  console.log('  ┌────────────────────────────────────────────────────────────┐');
  console.log('  │                  PocketShell is running                    │');
  console.log('  ├────────────────────────────────────────────────────────────┤');
  console.log(`  │  Landing:   http://localhost:${PORT}                           │`);
  console.log(`  │  Claude:    http://localhost:${PORT}/desktop/claude             │`);
  console.log(`  │  Copilot:   http://localhost:${PORT}/desktop/copilot            │`);
  console.log(`  │  Terminal:  http://localhost:${PORT}/desktop/terminal            │`);
  console.log(`  │  Bind:      ${BIND_HOST.padEnd(46)}│`);
  if (NO_AUTH) {
    console.log('  │  Auth:      DISABLED (--no-auth)                            │');
  } else if (!auth.isSetupComplete()) {
    console.log(`  │  Setup:     http://localhost:${PORT}/login.html?token=${SETUP_TOKEN}  │`);
    console.log(`  │  Token:     ${SETUP_TOKEN}  │`);
  }
  console.log('  └────────────────────────────────────────────────────────────┘');
  console.log('');
});
