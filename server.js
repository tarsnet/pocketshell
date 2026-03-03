const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const path = require('path');
const auth = require('./auth');

// --- CLI flags ---
const args = process.argv.slice(2);
const NO_AUTH = args.includes('--no-auth');
const portFlagIndex = args.indexOf('--port');
const PORT = (portFlagIndex !== -1 && args[portFlagIndex + 1])
  ? parseInt(args[portFlagIndex + 1], 10)
  : (process.env.PORT || 3000);
const REPLAY_BUFFER_SIZE = 100 * 1024; // 100KB

const app = express();
const server = http.createServer(app);

// Trust proxy so req.protocol detects HTTPS behind tunnels
app.set('trust proxy', 1);

// --- Body parsing ---
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

if (NO_AUTH) {
  // --- No auth mode: serve everything without authentication ---
  app.use(express.static(path.join(__dirname, 'public')));
} else {
  // --- Auth API routes (public, no auth required) ---
  auth.setupRoutes(app);

  // --- Serve login page without auth ---
  app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  });

  // --- Auth middleware (everything below requires login) ---
  app.use(auth.authMiddleware);

  // --- Static files (protected) ---
  app.use(express.static(path.join(__dirname, 'public')));
}

// --- UA-based redirect ---
app.get('/', (req, res) => {
  const ua = req.headers['user-agent'] || '';
  const isMobile = /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|Opera Mini|IEMobile/i.test(ua);
  res.redirect(isMobile ? '/mobile.html' : '/desktop.html');
});

// --- WebSocket Server (with auth) ---
const wss = new WebSocketServer({
  server,
  verifyClient: (info) => {
    if (NO_AUTH) return true;
    return auth.authenticateWs(info.req);
  },
});

// --- PTY Manager ---
let ptyProcess = null;
let replayBuffer = '';
const clients = new Set();

function spawnPty(cols = 120, rows = 30) {
  if (ptyProcess) {
    try { ptyProcess.kill(); } catch (e) { /* ignore */ }
  }
  replayBuffer = '';

  const shell = process.env.SHELL || '/bin/bash';
  const env = { ...process.env, TERM: 'xterm-256color' };
  // Remove nested-session guard so claude can launch from within this server
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE;

  ptyProcess = pty.spawn(shell, ['-l', '-c', 'claude'], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.env.HOME || process.cwd(),
    env,
  });

  console.log(`[pty] spawned claude (pid ${ptyProcess.pid}), cols=${cols} rows=${rows}`);

  ptyProcess.onData((data) => {
    // Append to replay buffer, trim if too large
    replayBuffer += data;
    if (replayBuffer.length > REPLAY_BUFFER_SIZE) {
      replayBuffer = replayBuffer.slice(-REPLAY_BUFFER_SIZE);
    }

    // Broadcast to all connected clients
    const msg = JSON.stringify({ type: 'output', data });
    for (const ws of clients) {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(msg);
      }
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    console.log(`[pty] exited (code=${exitCode}, signal=${signal})`);
    const msg = JSON.stringify({ type: 'exit', exitCode, signal });
    for (const ws of clients) {
      if (ws.readyState === 1) {
        ws.send(msg);
      }
    }
    ptyProcess = null;
  });
}

// Spawn initial PTY
spawnPty();

// --- WebSocket connections ---
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[ws] client connected (total: ${clients.size})`);

  // Send replay buffer so new client sees current terminal state
  if (replayBuffer.length > 0) {
    ws.send(JSON.stringify({ type: 'output', data: replayBuffer }));
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    switch (msg.type) {
      case 'input':
        if (ptyProcess && typeof msg.data === 'string') {
          console.log(`[ws] input: ${JSON.stringify(msg.data)}`);
          ptyProcess.write(msg.data);
        }
        break;

      case 'resize':
        if (ptyProcess && msg.cols && msg.rows) {
          try {
            ptyProcess.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
          } catch (e) { /* ignore resize errors */ }
        }
        break;

      case 'restart':
        console.log('[ws] restart requested');
        spawnPty(msg.cols || 120, msg.rows || 30);
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[ws] client disconnected (total: ${clients.size})`);
  });
});

// --- Graceful shutdown ---
function shutdown() {
  console.log('\n[server] shutting down...');
  if (ptyProcess) {
    try { ptyProcess.kill(); } catch (e) { /* ignore */ }
  }
  wss.close();
  server.close(() => process.exit(0));
  // Force exit after 3 seconds
  setTimeout(() => process.exit(1), 3000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Start ---
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ┌─────────────────────────────────────────────┐');
  console.log('  │            PocketShell is running            │');
  console.log('  ├─────────────────────────────────────────────┤');
  console.log(`  │  Local:   http://localhost:${PORT}              │`);
  console.log(`  │  Desktop: http://localhost:${PORT}/desktop.html │`);
  console.log(`  │  Mobile:  http://localhost:${PORT}/mobile.html  │`);
  if (NO_AUTH) {
    console.log('  │  Auth:    DISABLED (--no-auth)               │');
  } else if (!auth.isSetupComplete()) {
    console.log(`  │  Setup:   http://localhost:${PORT}/login.html  │`);
  }
  console.log('  └─────────────────────────────────────────────┘');
  console.log('');
});
