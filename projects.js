const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const os = require('os');

let CONFIG_PATH = path.join(os.homedir(), '.pocketshell.projects.json');
const GIT_TIMEOUT = 10000; // 10s

// Allow tests to override the config path
function setConfigPath(p) {
  CONFIG_PATH = p;
}

function getConfigPath() {
  return CONFIG_PATH;
}

// --- Project ID encoding ---

function pathToProjectId(absPath) {
  return Buffer.from(absPath).toString('base64url');
}

function projectIdToPath(id) {
  if (id === 'home') return os.homedir();
  return Buffer.from(id, 'base64url').toString();
}

// --- Config persistence ---

function loadConfig() {
  try {
    const data = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    console.warn('[projects] failed to load config:', e.message);
    return null;
  }
}

function saveConfig(config) {
  const data = JSON.stringify(config, null, 2) + '\n';
  fs.writeFileSync(CONFIG_PATH, data, { mode: 0o600 });
}

function ensureConfig() {
  const config = loadConfig();
  if (config) return config;
  return { lastProject: 'home', repos: [], recents: [] };
}

// --- Last project ---

function getLastProject() {
  const config = loadConfig();
  const id = config?.lastProject;
  if (!id || id === 'home') return 'home';

  // Validate the saved project still exists on disk
  try {
    const decoded = projectIdToPath(id);
    if (fs.existsSync(decoded)) return id;
  } catch (e) { /* corrupted id */ }

  // Stale — reset to home so we don't keep trying a dead path
  console.warn('[projects] last project path no longer exists, falling back to home');
  if (config) {
    config.lastProject = 'home';
    try { saveConfig(config); } catch (e) { /* best effort */ }
  }
  return 'home';
}

function setLastProject(projectId) {
  const config = ensureConfig();
  config.lastProject = projectId;
  saveConfig(config);
}

// --- Recents ---

function getRecents() {
  const config = loadConfig();
  if (!config?.recents) return [];
  return config.recents
    .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0))
    .slice(0, 5);
}

function touchRecent(projectId, repoPath, branch, worktreePath) {
  const config = ensureConfig();
  if (!config.recents) config.recents = [];

  const idx = config.recents.findIndex(r => r.projectId === projectId);
  const label = buildLabel(repoPath, branch);
  const entry = {
    projectId,
    repoPath,
    branch,
    worktreePath,
    label,
    lastUsed: Date.now(),
  };

  if (idx >= 0) {
    config.recents[idx] = entry;
  } else {
    config.recents.push(entry);
  }

  // Keep only most recent 10
  config.recents.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  config.recents = config.recents.slice(0, 10);

  saveConfig(config);
}

function buildLabel(repoPath, branch) {
  const repoName = path.basename(repoPath);
  return branch ? `${repoName} (${branch})` : repoName;
}

// --- Repo management ---

function registerRepo(repoPath) {
  const resolved = path.resolve(repoPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }
  // Check for .git (file or dir — worktrees use a .git file)
  const gitPath = path.join(resolved, '.git');
  if (!fs.existsSync(gitPath)) {
    throw new Error(`Not a git repository: ${resolved}`);
  }

  const config = ensureConfig();
  if (!config.repos) config.repos = [];
  if (!config.repos.includes(resolved)) {
    config.repos.push(resolved);
    saveConfig(config);
  }
  return resolved;
}

function removeRepo(repoPath) {
  const resolved = path.resolve(repoPath);
  const config = ensureConfig();
  if (!config.repos) return;
  config.repos = config.repos.filter(r => r !== resolved);
  // Also remove recents associated with this repo
  if (config.recents) {
    config.recents = config.recents.filter(r => r.repoPath !== resolved);
  }
  saveConfig(config);
}

function getRepos() {
  const config = loadConfig();
  return config?.repos || [];
}

// --- Git operations ---

function gitExec(repoPath, gitArgs) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repoPath, ...gitArgs], { timeout: GIT_TIMEOUT }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function listBranches(repoPath) {
  const resolved = path.resolve(repoPath);
  const stdout = await gitExec(resolved, [
    'branch', '--format=%(refname:short)', '--sort=-committerdate',
  ]);
  return stdout.trim().split('\n').filter(Boolean);
}

async function listWorktrees(repoPath) {
  const resolved = path.resolve(repoPath);
  const stdout = await gitExec(resolved, ['worktree', 'list', '--porcelain']);
  return parseWorktreeList(stdout);
}

function parseWorktreeList(porcelainOutput) {
  const worktrees = [];
  let current = null;

  for (const line of porcelainOutput.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('HEAD ') && current) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ') && current) {
      // refs/heads/main → main
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'bare' && current) {
      current.bare = true;
    } else if (line === 'detached' && current) {
      current.detached = true;
    } else if (line === '' && current) {
      worktrees.push(current);
      current = null;
    }
  }
  // Push last entry if no trailing newline
  if (current) worktrees.push(current);

  return worktrees;
}

const SAFE_BRANCH_RE = /^[a-zA-Z0-9._\/-]+$/;

function validateBranchName(name) {
  if (!name || typeof name !== 'string') return false;
  if (!SAFE_BRANCH_RE.test(name)) return false;
  if (name.startsWith('-')) return false;       // prevent git argument injection
  if (name.includes('..')) return false;         // prevent path traversal
  return true;
}

async function createWorktree(repoPath, branch, newBranch) {
  if (!validateBranchName(branch)) {
    throw new Error('Invalid branch name');
  }
  if (newBranch && !validateBranchName(newBranch)) {
    throw new Error('Invalid new branch name');
  }

  const resolved = path.resolve(repoPath);
  const parentDir = path.dirname(resolved);
  const repoName = path.basename(resolved);

  if (newBranch) {
    const worktreeDir = path.join(parentDir, `${repoName}-${newBranch}`);
    // Verify worktree dir stays within parent
    if (!path.resolve(worktreeDir).startsWith(parentDir + path.sep)) {
      throw new Error('Invalid branch name');
    }
    await gitExec(resolved, ['worktree', 'add', '-b', newBranch, worktreeDir, branch]);
    return worktreeDir;
  } else {
    const worktreeDir = path.join(parentDir, `${repoName}-${branch}`);
    if (!path.resolve(worktreeDir).startsWith(parentDir + path.sep)) {
      throw new Error('Invalid branch name');
    }
    await gitExec(resolved, ['worktree', 'add', worktreeDir, branch]);
    return worktreeDir;
  }
}

// --- Repo discovery ---

function discoverRepos() {
  const home = os.homedir();

  return new Promise((resolve) => {
    // Find .git dirs up to 4 levels deep, skip noise directories
    execFile('find', [
      home,
      '-maxdepth', '5',
      '-name', '.git',
      '-type', 'd',
      // Prune heavy/irrelevant directories
      '(', '-path', '*/node_modules/*',
        '-o', '-path', '*/.cache/*',
        '-o', '-path', '*/.local/*',
        '-o', '-path', '*/.npm/*',
        '-o', '-path', '*/.nvm/*',
        '-o', '-path', '*/.cargo/*',
        '-o', '-path', '*/.rustup/*',
        '-o', '-path', '*/.vscode/*',
        '-o', '-path', '*/.config/*',
        '-o', '-path', '*/.claude/*',
        '-o', '-path', '*/vendor/*',
        '-o', '-path', '*/.git/modules/*',
      ')', '-prune', '-o',
      '-name', '.git', '-type', 'd', '-print',
    ], { timeout: 15000 }, (err, stdout) => {
      if (err) {
        // Timeout or permission errors are fine — return what we found
        if (!stdout) { resolve([]); return; }
      }
      const repos = stdout.trim().split('\n')
        .filter(Boolean)
        .map(gitDir => path.dirname(gitDir)) // /home/user/dev/repo/.git → /home/user/dev/repo
        .sort();
      resolve(repos);
    });
  });
}

// --- Validation ---

function isRegisteredRepo(repoPath) {
  const resolved = path.resolve(repoPath);
  const repos = getRepos();
  return repos.includes(resolved);
}

function validateProjectPath(projectId) {
  if (projectId === 'home') return true;

  const decoded = projectIdToPath(projectId);

  // Must be an absolute path
  if (!path.isAbsolute(decoded)) return false;

  // Must exist
  if (!fs.existsSync(decoded)) return false;

  // Resolve symlinks to prevent symlink-based escapes
  let resolved;
  try {
    resolved = fs.realpathSync(decoded);
  } catch (e) {
    return false;
  }

  // Must be within a registered repo (or be a registered repo)
  const config = loadConfig();
  const repos = config?.repos || [];
  return repos.some(repo => {
    let realRepo;
    try { realRepo = fs.realpathSync(repo); } catch { realRepo = repo; }
    return resolved === realRepo || resolved.startsWith(realRepo + path.sep);
  });
}

// --- Bootstrap data for API ---

function getBootstrapData() {
  const config = loadConfig();
  if (!config) {
    return { lastProject: 'home', recents: [], repos: [] };
  }

  // Prune recents whose paths no longer exist
  const recents = getRecents().filter(r => {
    try { return fs.existsSync(r.worktreePath); } catch { return false; }
  });

  // Prune repos that no longer exist
  const repos = (config.repos || []).filter(r => {
    try { return fs.existsSync(r); } catch { return false; }
  });

  return {
    lastProject: getLastProject(), // uses validated version
    recents,
    repos,
  };
}

module.exports = {
  pathToProjectId,
  projectIdToPath,
  loadConfig,
  saveConfig,
  ensureConfig,
  getLastProject,
  setLastProject,
  getRecents,
  touchRecent,
  buildLabel,
  registerRepo,
  removeRepo,
  getRepos,
  listBranches,
  listWorktrees,
  parseWorktreeList,
  createWorktree,
  isRegisteredRepo,
  validateProjectPath,
  validateBranchName,
  getBootstrapData,
  discoverRepos,
  setConfigPath,
  getConfigPath,
};
