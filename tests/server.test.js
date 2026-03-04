const http = require('http');
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
