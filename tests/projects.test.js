const fs = require('fs');
const path = require('path');
const os = require('os');

const projects = require('../projects');

let tmpDir;
let tmpConfig;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketshell-test-'));
  tmpConfig = path.join(tmpDir, 'test-projects.json');
  projects.setConfigPath(tmpConfig);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- pathToProjectId / projectIdToPath ---

describe('project ID encoding', () => {
  test('roundtrip for absolute path', () => {
    const p = '/home/user/dev/myrepo';
    const id = projects.pathToProjectId(p);
    expect(projects.projectIdToPath(id)).toBe(p);
  });

  test('roundtrip for path with special chars', () => {
    const p = '/home/user/dev/my-repo_v2.0';
    const id = projects.pathToProjectId(p);
    expect(projects.projectIdToPath(id)).toBe(p);
  });

  test('home ID returns home directory', () => {
    expect(projects.projectIdToPath('home')).toBe(os.homedir());
  });

  test('ID is URL-safe (no +, /, =)', () => {
    const id = projects.pathToProjectId('/home/user/dev/repo-with-long-name-to-force-padding');
    expect(id).not.toMatch(/[+/=]/);
  });
});

// --- Config load/save ---

describe('config persistence', () => {
  test('loadConfig returns null for missing file', () => {
    expect(projects.loadConfig()).toBeNull();
  });

  test('saveConfig + loadConfig roundtrip', () => {
    const config = { lastProject: 'home', repos: ['/tmp/test'], recents: [] };
    projects.saveConfig(config);
    const loaded = projects.loadConfig();
    expect(loaded).toEqual(config);
  });

  test('saveConfig creates file with 0o600 permissions', () => {
    projects.saveConfig({ lastProject: 'home', repos: [], recents: [] });
    const stat = fs.statSync(tmpConfig);
    // Check owner read/write only (0o600 = 384 decimal, mode & 0o777)
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test('ensureConfig returns default when no file exists', () => {
    const config = projects.ensureConfig();
    expect(config).toEqual({ lastProject: 'home', repos: [], recents: [] });
  });
});

// --- Last project ---

describe('last project', () => {
  test('getLastProject returns home when no config', () => {
    expect(projects.getLastProject()).toBe('home');
  });

  test('setLastProject + getLastProject roundtrip', () => {
    // Path must exist on disk for getLastProject to return it
    const dir = path.join(tmpDir, 'last-project-repo');
    fs.mkdirSync(dir);
    const id = projects.pathToProjectId(dir);
    projects.setLastProject(id);
    expect(projects.getLastProject()).toBe(id);
  });

  test('getLastProject falls back to home when path is gone', () => {
    const id = projects.pathToProjectId('/tmp/nonexistent-test-repo-xyz');
    projects.setLastProject(id);
    expect(projects.getLastProject()).toBe('home');
  });
});

// --- Recents ---

describe('recents', () => {
  test('getRecents returns empty when no config', () => {
    expect(projects.getRecents()).toEqual([]);
  });

  test('touchRecent adds entry', () => {
    const id = projects.pathToProjectId('/tmp/repo1');
    projects.touchRecent(id, '/tmp/repo1', 'main', '/tmp/repo1');
    const recents = projects.getRecents();
    expect(recents).toHaveLength(1);
    expect(recents[0].projectId).toBe(id);
    expect(recents[0].branch).toBe('main');
  });

  test('touchRecent upserts existing entry', () => {
    const id = projects.pathToProjectId('/tmp/repo1');
    projects.touchRecent(id, '/tmp/repo1', 'main', '/tmp/repo1');
    const t1 = projects.getRecents()[0].lastUsed;

    // Touch again after a tiny delay
    projects.touchRecent(id, '/tmp/repo1', 'develop', '/tmp/repo1');
    const recents = projects.getRecents();
    expect(recents).toHaveLength(1);
    expect(recents[0].branch).toBe('develop');
    expect(recents[0].lastUsed).toBeGreaterThanOrEqual(t1);
  });

  test('recents sorted by lastUsed descending, capped at 5', () => {
    for (let i = 0; i < 7; i++) {
      const id = projects.pathToProjectId(`/tmp/repo${i}`);
      projects.touchRecent(id, `/tmp/repo${i}`, 'main', `/tmp/repo${i}`);
    }
    const recents = projects.getRecents();
    expect(recents).toHaveLength(5);
    // Most recent first
    for (let i = 1; i < recents.length; i++) {
      expect(recents[i - 1].lastUsed).toBeGreaterThanOrEqual(recents[i].lastUsed);
    }
  });
});

// --- Build label ---

describe('buildLabel', () => {
  test('repo with branch', () => {
    expect(projects.buildLabel('/home/user/dev/myrepo', 'main')).toBe('myrepo (main)');
  });

  test('repo without branch', () => {
    expect(projects.buildLabel('/home/user/dev/myrepo', '')).toBe('myrepo');
  });
});

// --- Repo management ---

describe('registerRepo', () => {
  test('registers valid git repo', () => {
    // Create a fake repo dir with .git
    const repoDir = path.join(tmpDir, 'fakerepo');
    fs.mkdirSync(repoDir);
    fs.mkdirSync(path.join(repoDir, '.git'));

    const result = projects.registerRepo(repoDir);
    expect(result).toBe(repoDir);
    expect(projects.getRepos()).toContain(repoDir);
  });

  test('rejects non-existent path', () => {
    expect(() => projects.registerRepo('/nonexistent/path')).toThrow('Path does not exist');
  });

  test('rejects path without .git', () => {
    const noGitDir = path.join(tmpDir, 'nogit');
    fs.mkdirSync(noGitDir);
    expect(() => projects.registerRepo(noGitDir)).toThrow('Not a git repository');
  });

  test('does not duplicate repos', () => {
    const repoDir = path.join(tmpDir, 'duperepo');
    fs.mkdirSync(repoDir);
    fs.mkdirSync(path.join(repoDir, '.git'));

    projects.registerRepo(repoDir);
    projects.registerRepo(repoDir);
    const repos = projects.getRepos();
    expect(repos.filter(r => r === repoDir)).toHaveLength(1);
  });
});

describe('removeRepo', () => {
  test('removes registered repo and its recents', () => {
    const repoDir = path.join(tmpDir, 'removeme');
    fs.mkdirSync(repoDir);
    fs.mkdirSync(path.join(repoDir, '.git'));

    projects.registerRepo(repoDir);
    const id = projects.pathToProjectId(repoDir);
    projects.touchRecent(id, repoDir, 'main', repoDir);

    projects.removeRepo(repoDir);
    expect(projects.getRepos()).not.toContain(repoDir);
    expect(projects.getRecents()).toHaveLength(0);
  });
});

// --- Worktree list parsing ---

describe('parseWorktreeList', () => {
  test('parses porcelain worktree output', () => {
    const output = [
      'worktree /home/user/dev/repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /home/user/dev/repo-feature',
      'HEAD def456',
      'branch refs/heads/feature/xyz',
      '',
    ].join('\n');

    const result = projects.parseWorktreeList(output);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      path: '/home/user/dev/repo',
      head: 'abc123',
      branch: 'main',
    });
    expect(result[1]).toEqual({
      path: '/home/user/dev/repo-feature',
      head: 'def456',
      branch: 'feature/xyz',
    });
  });

  test('handles detached worktrees', () => {
    const output = [
      'worktree /home/user/dev/repo',
      'HEAD abc123',
      'detached',
      '',
    ].join('\n');

    const result = projects.parseWorktreeList(output);
    expect(result).toHaveLength(1);
    expect(result[0].detached).toBe(true);
    expect(result[0].branch).toBeUndefined();
  });

  test('handles bare repos', () => {
    const output = [
      'worktree /home/user/dev/repo.git',
      'bare',
      '',
    ].join('\n');

    const result = projects.parseWorktreeList(output);
    expect(result).toHaveLength(1);
    expect(result[0].bare).toBe(true);
  });

  test('handles empty output', () => {
    expect(projects.parseWorktreeList('')).toEqual([]);
  });
});

// --- Path validation ---

describe('validateProjectPath', () => {
  test('home is always valid', () => {
    expect(projects.validateProjectPath('home')).toBe(true);
  });

  test('rejects non-absolute decoded path', () => {
    const id = projects.pathToProjectId('relative/path');
    expect(projects.validateProjectPath(id)).toBe(false);
  });

  test('rejects path not within registered repo', () => {
    const id = projects.pathToProjectId('/tmp/not-registered');
    // Create the path so it exists
    fs.mkdirSync('/tmp/not-registered', { recursive: true });
    expect(projects.validateProjectPath(id)).toBe(false);
    fs.rmdirSync('/tmp/not-registered');
  });

  test('accepts path within registered repo', () => {
    const repoDir = path.join(tmpDir, 'validrepo');
    fs.mkdirSync(repoDir);
    fs.mkdirSync(path.join(repoDir, '.git'));
    projects.registerRepo(repoDir);

    const id = projects.pathToProjectId(repoDir);
    expect(projects.validateProjectPath(id)).toBe(true);
  });

  test('accepts worktree path within registered repo parent', () => {
    const repoDir = path.join(tmpDir, 'wtrepo');
    fs.mkdirSync(repoDir);
    fs.mkdirSync(path.join(repoDir, '.git'));
    projects.registerRepo(repoDir);

    const subDir = path.join(repoDir, 'subdir');
    fs.mkdirSync(subDir);
    const id = projects.pathToProjectId(subDir);
    expect(projects.validateProjectPath(id)).toBe(true);
  });
});

// --- Bootstrap data ---

describe('getBootstrapData', () => {
  test('returns defaults when no config', () => {
    const data = projects.getBootstrapData();
    expect(data).toEqual({ lastProject: 'home', recents: [], repos: [] });
  });

  test('returns config data when present', () => {
    const repoDir = path.join(tmpDir, 'bootstraprepo');
    fs.mkdirSync(repoDir);
    fs.mkdirSync(path.join(repoDir, '.git'));
    projects.registerRepo(repoDir);

    const id = projects.pathToProjectId(repoDir);
    projects.touchRecent(id, repoDir, 'main', repoDir);
    projects.setLastProject(id);

    const data = projects.getBootstrapData();
    expect(data.lastProject).toBe(id);
    expect(data.repos).toContain(repoDir);
    expect(data.recents).toHaveLength(1);
  });
});
