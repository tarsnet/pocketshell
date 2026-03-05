const http = require('http');
const crypto = require('crypto');
const express = require('express');

// --- Resize bounds clamping (unit tests for the logic) ---

describe('resize bounds clamping', () => {
  function clampResize(cols, rows) {
    return {
      cols: Math.min(500, Math.max(1, Math.floor(cols))),
      rows: Math.min(200, Math.max(1, Math.floor(rows))),
    };
  }

  test('normal values pass through', () => {
    expect(clampResize(80, 24)).toEqual({ cols: 80, rows: 24 });
  });

  test('clamps cols to 500 max', () => {
    expect(clampResize(1000, 24)).toEqual({ cols: 500, rows: 24 });
  });

  test('clamps rows to 200 max', () => {
    expect(clampResize(80, 999)).toEqual({ cols: 80, rows: 200 });
  });

  test('clamps cols to 1 min', () => {
    expect(clampResize(0, 24)).toEqual({ cols: 1, rows: 24 });
    expect(clampResize(-5, 24)).toEqual({ cols: 1, rows: 24 });
  });

  test('clamps rows to 1 min', () => {
    expect(clampResize(80, 0)).toEqual({ cols: 80, rows: 1 });
  });

  test('floors fractional values', () => {
    expect(clampResize(80.7, 24.9)).toEqual({ cols: 80, rows: 24 });
  });
});

// --- CSP headers (minimal Express app test) ---

describe('CSP headers', () => {
  let app, server;

  beforeAll((done) => {
    app = express();

    // Apply the same security headers middleware as server.js
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

    app.get('/test', (req, res) => res.json({ ok: true }));

    server = app.listen(0, done);
  });

  afterAll((done) => {
    server.close(done);
  });

  function fetch(path) {
    return new Promise((resolve, reject) => {
      const { port } = server.address();
      http.get(`http://localhost:${port}${path}`, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve({ headers: res.headers, status: res.statusCode, body: data }));
      }).on('error', reject);
    });
  }

  test('sets Content-Security-Policy header', async () => {
    const res = await fetch('/test');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline'");
    expect(res.headers['content-security-policy']).toContain("connect-src 'self' ws: wss:");
  });

  test('sets X-Content-Type-Options header', async () => {
    const res = await fetch('/test');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  test('sets X-Frame-Options header', async () => {
    const res = await fetch('/test');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
});

// --- Mode validation ---

describe('mode validation', () => {
  const VALID_MODES = new Set(['claude', 'copilot', 'terminal']);

  test('accepts valid modes', () => {
    expect(VALID_MODES.has('claude')).toBe(true);
    expect(VALID_MODES.has('copilot')).toBe(true);
    expect(VALID_MODES.has('terminal')).toBe(true);
  });

  test('rejects invalid modes', () => {
    expect(VALID_MODES.has('bash')).toBe(false);
    expect(VALID_MODES.has('')).toBe(false);
    expect(VALID_MODES.has('admin')).toBe(false);
  });
});

// --- Port validation ---

describe('port validation', () => {
  function isValidPort(port) {
    return Number.isInteger(port) && port >= 1 && port <= 65535;
  }

  test('accepts valid ports', () => {
    expect(isValidPort(3000)).toBe(true);
    expect(isValidPort(1)).toBe(true);
    expect(isValidPort(65535)).toBe(true);
    expect(isValidPort(8080)).toBe(true);
  });

  test('rejects invalid ports', () => {
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(-1)).toBe(false);
    expect(isValidPort(65536)).toBe(false);
    expect(isValidPort(NaN)).toBe(false);
    expect(isValidPort(3.14)).toBe(false);
  });
});

// --- Bind address logic ---

describe('bind address logic', () => {
  function computeBindHost(noAuth, remote) {
    return (noAuth && !remote) ? '127.0.0.1' : '0.0.0.0';
  }

  test('no-auth without remote binds to 127.0.0.1', () => {
    expect(computeBindHost(true, false)).toBe('127.0.0.1');
  });

  test('no-auth with remote binds to 0.0.0.0', () => {
    expect(computeBindHost(true, true)).toBe('0.0.0.0');
  });

  test('auth mode binds to 0.0.0.0 regardless of remote', () => {
    expect(computeBindHost(false, false)).toBe('0.0.0.0');
    expect(computeBindHost(false, true)).toBe('0.0.0.0');
  });
});

// --- Setup token ---

describe('setup token', () => {
  test('generated token is a 32-char hex string', () => {
    const token = crypto.randomBytes(16).toString('hex');
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  test('each generation produces a unique token', () => {
    const t1 = crypto.randomBytes(16).toString('hex');
    const t2 = crypto.randomBytes(16).toString('hex');
    expect(t1).not.toBe(t2);
  });
});

// --- Composite session key ---

describe('composite session key', () => {
  function makeSessionKey(projectId, mode) {
    return `${projectId}:${mode}`;
  }

  test('generates correct key for home project', () => {
    expect(makeSessionKey('home', 'claude')).toBe('home:claude');
    expect(makeSessionKey('home', 'terminal')).toBe('home:terminal');
  });

  test('generates correct key for encoded project', () => {
    const projectId = Buffer.from('/home/user/dev/repo').toString('base64url');
    expect(makeSessionKey(projectId, 'claude')).toBe(`${projectId}:claude`);
  });

  test('different projects produce different keys for same mode', () => {
    const k1 = makeSessionKey('home', 'claude');
    const k2 = makeSessionKey('abc123', 'claude');
    expect(k1).not.toBe(k2);
  });

  test('same project different modes produce different keys', () => {
    const k1 = makeSessionKey('home', 'claude');
    const k2 = makeSessionKey('home', 'terminal');
    expect(k1).not.toBe(k2);
  });
});

// --- Backward compat: no project param defaults to home ---

describe('project param backward compatibility', () => {
  function extractProjectFromUrl(url) {
    try {
      const parsed = new URL(url, 'http://localhost');
      return parsed.searchParams.get('project') || 'home';
    } catch {
      return 'home';
    }
  }

  test('no project param defaults to home', () => {
    expect(extractProjectFromUrl('/ws/claude')).toBe('home');
  });

  test('explicit project param is used', () => {
    expect(extractProjectFromUrl('/ws/claude?project=abc123')).toBe('abc123');
  });

  test('empty project param defaults to home', () => {
    expect(extractProjectFromUrl('/ws/claude?project=')).toBe('home');
  });
});
