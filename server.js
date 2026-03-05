const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const auth = require('./auth');
const projects = require('./projects');

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

if (NO_AUTH && REMOTE) {
  console.error('[server] --no-auth and --remote cannot be used together (would expose unauthenticated terminal to the internet)');
  process.exit(1);
}

const BIND_HOST = (NO_AUTH && !REMOTE) ? '127.0.0.1' : '0.0.0.0';
const SETUP_TOKEN = crypto.randomBytes(16).toString('hex');

const REPLAY_BUFFER_SIZE = 100 * 1024; // 100KB
const MAX_SESSIONS = 50;

// --- Mode definitions ---
const MODES = {
  claude:   { cmd: 'claude',  label: 'Claude Code' },
  copilot:  { cmd: 'copilot', label: 'GitHub Copilot' },
  terminal: { cmd: null,      label: 'Terminal' },  // null = plain bash -l
};

const VALID_MODES = new Set(Object.keys(MODES));

// --- Detect which CLIs are installed (cached at startup) ---
const modeAvailability = {};
for (const [mode, config] of Object.entries(MODES)) {
  if (!config.cmd) {
    // terminal mode — always available
    modeAvailability[mode] = true;
  } else {
    try {
      execFileSync('which', [config.cmd], { timeout: 3000, stdio: 'ignore' });
      modeAvailability[mode] = true;
    } catch {
      modeAvailability[mode] = false;
      console.log(`[server] ${config.label} (${config.cmd}) not found — mode disabled`);
    }
  }
}

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
  constructor(mode, sessionKey, cwd) {
    this.mode = mode;
    this.sessionKey = sessionKey;
    this.cwd = cwd || process.env.HOME || process.cwd();
    this.ptyProcess = null;
    this.replayBuffer = '';
    this.clients = new Set();
  }

  spawn(cols = 120, rows = 30) {
    if (this.ptyProcess) {
      try { this.ptyProcess.kill(); } catch (e) { console.warn(`[pty:${this.sessionKey}] kill error on respawn:`, e.message); }
    }
    this.replayBuffer = '';

    // Validate cwd exists — fall back to HOME if it doesn't
    const home = process.env.HOME || process.cwd();
    if (!fs.existsSync(this.cwd)) {
      console.warn(`[pty:${this.sessionKey}] cwd does not exist (${this.cwd}), falling back to ${home}`);
      this.cwd = home;
    }

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
      cwd: this.cwd,
      env,
    });

    console.log(`[pty:${this.sessionKey}] spawned (pid ${this.ptyProcess.pid}), cols=${cols} rows=${rows}, cwd=${this.cwd}`);

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
      console.log(`[pty:${this.sessionKey}] exited (code=${exitCode}, signal=${signal})`);
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
      try { this.ptyProcess.kill(); } catch (e) { console.warn(`[pty:${this.sessionKey}] kill error:`, e.message); }
      this.ptyProcess = null;
    }
  }
}

// --- Sessions Map ---
// Key format: "projectId:mode" (e.g. "home:claude", "L2hvbWUv...:terminal")
const sessions = new Map();

function resolveProjectCwd(projectId, cwd) {
  const home = process.env.HOME || process.cwd();
  if (cwd) return cwd;
  if (projectId === 'home') return home;
  try {
    const decoded = projects.projectIdToPath(projectId);
    return fs.existsSync(decoded) ? decoded : home;
  } catch (e) {
    return home;
  }
}

function getOrCreateSession(mode, projectId = 'home', cwd = null) {
  const sessionKey = `${projectId}:${mode}`;
  let session = sessions.get(sessionKey);
  if (!session) {
    if (sessions.size >= MAX_SESSIONS) {
      console.warn(`[server] session limit reached (${MAX_SESSIONS}), reusing home:${mode}`);
      return getOrCreateSession(mode, 'home');
    }
    const sessionCwd = resolveProjectCwd(projectId, cwd);
    session = new PtySession(mode, sessionKey, sessionCwd);
    sessions.set(sessionKey, session);
    session.spawn();
  } else if (!session.ptyProcess) {
    // PTY exited; respawn
    session.spawn();
  }
  return session;
}

// Eagerly spawn PTYs for the last-used project (or home) at startup
// Only spawn modes whose CLI is actually installed
const lastProject = projects.getLastProject();
for (const mode of Object.keys(MODES)) {
  if (modeAvailability[mode]) {
    getOrCreateSession(mode, lastProject);
  }
}

// --- Redirect old direct-access URLs to landing page ---
app.get('/desktop.html', (req, res) => res.redirect('/'));
app.get('/mobile.html', (req, res) => res.redirect('/'));

// --- Auth setup ---
if (NO_AUTH) {
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // Project API routes (before static middleware)
  setupProjectRoutes(app);

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

  // Project API routes (after auth middleware)
  setupProjectRoutes(app);

  // Static files (protected)
  app.use(express.static(path.join(__dirname, 'public')));
}

// --- Project API routes ---
function setupProjectRoutes(app) {
  // Which modes are available
  app.get('/api/modes', (req, res) => {
    res.json(modeAvailability);
  });

  // Bootstrap data: last project, recents, repos
  app.get('/api/projects', (req, res) => {
    res.json(projects.getBootstrapData());
  });

  // Discover repos on the filesystem
  app.get('/api/projects/discover', async (req, res) => {
    try {
      const repos = await projects.discoverRepos();
      res.json({ repos });
    } catch (e) {
      console.error('[api] discover error:', e.message);
      res.status(500).json({ error: 'Failed to scan for repos' });
    }
  });

  // Register a repo
  app.post('/api/projects/repos', (req, res) => {
    try {
      const { repoPath } = req.body;
      if (!repoPath || typeof repoPath !== 'string') {
        return res.status(400).json({ error: 'repoPath is required' });
      }
      const resolved = projects.registerRepo(repoPath);
      res.json({ ok: true, repoPath: resolved });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Unregister a repo
  app.delete('/api/projects/repos', (req, res) => {
    const { repoPath } = req.body;
    if (!repoPath || typeof repoPath !== 'string') {
      return res.status(400).json({ error: 'repoPath is required' });
    }
    projects.removeRepo(repoPath);
    res.json({ ok: true });
  });

  // List branches for a repo (must be a registered repo)
  app.get('/api/projects/branches', async (req, res) => {
    try {
      const repo = req.query.repo;
      if (!repo) return res.status(400).json({ error: 'repo query param required' });
      if (!projects.isRegisteredRepo(repo)) {
        return res.status(403).json({ error: 'Repository not registered' });
      }
      const branches = await projects.listBranches(repo);
      res.json({ branches });
    } catch (e) {
      console.error('[api] branches error:', e.message);
      res.status(400).json({ error: 'Failed to list branches' });
    }
  });

  // List worktrees for a repo (must be a registered repo)
  app.get('/api/projects/worktrees', async (req, res) => {
    try {
      const repo = req.query.repo;
      if (!repo) return res.status(400).json({ error: 'repo query param required' });
      if (!projects.isRegisteredRepo(repo)) {
        return res.status(403).json({ error: 'Repository not registered' });
      }
      const worktrees = await projects.listWorktrees(repo);
      res.json({ worktrees });
    } catch (e) {
      console.error('[api] worktrees error:', e.message);
      res.status(400).json({ error: 'Failed to list worktrees' });
    }
  });

  // Create a worktree (must be a registered repo)
  app.post('/api/projects/worktrees', async (req, res) => {
    try {
      const { repoPath, branch, newBranch } = req.body;
      if (!repoPath || !branch) {
        return res.status(400).json({ error: 'repoPath and branch are required' });
      }
      if (!projects.isRegisteredRepo(repoPath)) {
        return res.status(403).json({ error: 'Repository not registered' });
      }
      const worktreeDir = await projects.createWorktree(repoPath, branch, newBranch);
      const projectId = projects.pathToProjectId(worktreeDir);
      res.json({ ok: true, worktreePath: worktreeDir, projectId });
    } catch (e) {
      console.error('[api] create worktree error:', e.message);
      res.status(400).json({ error: 'Failed to create worktree' });
    }
  });

  // Select / activate a project
  app.post('/api/projects/select', (req, res) => {
    const { projectId, repoPath, branch, worktreePath } = req.body;
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    // Validate: 'home' always allowed, otherwise must be a valid project path
    if (projectId !== 'home' && !projects.validateProjectPath(projectId)) {
      return res.status(400).json({ error: 'Invalid project path' });
    }

    projects.setLastProject(projectId);
    if (projectId !== 'home' && repoPath && branch && worktreePath) {
      projects.touchRecent(projectId, repoPath, branch, worktreePath);
    }

    res.json({ ok: true });
  });
}

// --- Cache HTML templates ---
const desktopHtml = fs.readFileSync(path.join(__dirname, 'public', 'desktop.html'), 'utf8');
const mobileHtml = fs.readFileSync(path.join(__dirname, 'public', 'mobile.html'), 'utf8');

// --- View + mode routes: /desktop/:mode and /mobile/:mode ---
// Pre-spawn PTY on page load so bash profile noise clears before WS connects.
// Cache-bust asset URLs so phones don't serve stale broken files.
const startupTs = Date.now();

function serveModeHtml(template, mode, projectId, res) {
  // Pre-spawn the PTY session so it's ready by the time WebSocket connects
  getOrCreateSession(mode, projectId);

  const modeScript = `<script>window.POCKETSHELL_MODE=${JSON.stringify(mode)};window.POCKETSHELL_PROJECT=${JSON.stringify(projectId)};</script>`;
  let html = template.replace('</head>', modeScript + '\n</head>');
  // Cache-bust local assets to avoid stale cached 404s
  html = html.replace(/((?:src|href)="\/[^"]+\.(?:js|css))(")/g, `$1?v=${startupTs}$2`);

  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.type('html').send(html);
}

app.get('/desktop/:mode(claude|copilot|terminal)', (req, res) => {
  const projectId = req.query.project || 'home';
  if (projectId !== 'home' && !projects.validateProjectPath(projectId)) {
    return res.redirect('/');
  }
  serveModeHtml(desktopHtml, req.params.mode, projectId, res);
});

app.get('/mobile/:mode(claude|copilot|terminal)', (req, res) => {
  const projectId = req.query.project || 'home';
  if (projectId !== 'home' && !projects.validateProjectPath(projectId)) {
    return res.redirect('/');
  }
  serveModeHtml(mobileHtml, req.params.mode, projectId, res);
});

// --- WebSocket Server (with auth + path routing) ---
const wss = new WebSocketServer({
  server,
  maxPayload: 64 * 1024, // 64KB
  verifyClient: (info) => {
    // Validate WebSocket path: must be /ws/{mode} with optional ?project= query
    const parsed = new URL(info.req.url, 'http://localhost');
    const match = parsed.pathname.match(/^\/ws\/(claude|copilot|terminal)$/);
    if (!match) return false;

    // Stash mode and project on request for later use
    info.req._pocketshellMode = match[1];
    const projectId = parsed.searchParams.get('project') || 'home';
    info.req._pocketshellProject = projectId;

    // Validate project ID (home is always allowed)
    if (projectId !== 'home' && !projects.validateProjectPath(projectId)) {
      return false;
    }

    if (NO_AUTH) return true;
    return auth.authenticateWs(info.req);
  },
});

// --- WebSocket connections ---
wss.on('connection', (ws, req) => {
  const mode = req._pocketshellMode;
  const projectId = req._pocketshellProject || 'home';

  if (!mode || !VALID_MODES.has(mode)) {
    ws.close();
    return;
  }

  const session = getOrCreateSession(mode, projectId);
  session.clients.add(ws);
  console.log(`[ws:${projectId}:${mode}] client connected (total: ${session.clients.size})`);

  // Send replay buffer so new client sees current terminal state
  if (session.replayBuffer.length > 0) {
    ws.send(JSON.stringify({ type: 'output', data: session.replayBuffer }));
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      console.warn(`[ws:${projectId}:${mode}] invalid JSON from client:`, e.message);
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
            console.warn(`[ws:${projectId}:${mode}] resize error:`, e.message);
          }
        }
        break;

      case 'restart':
        console.log(`[ws:${projectId}:${mode}] restart requested`);
        session.spawn(msg.cols || 120, msg.rows || 30);
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    session.clients.delete(ws);
    console.log(`[ws:${projectId}:${mode}] client disconnected (total: ${session.clients.size})`);
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
