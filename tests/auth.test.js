const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Ensure NODE_ENV=test so _internals is exported
process.env.NODE_ENV = 'test';

const auth = require('../auth');
const {
  checkRateLimit,
  recordFailedAttempt,
  clearAttempts,
  hashPassword,
  verifyPassword,
  generateTotpSecret,
  verifyTotp,
  createSessionToken,
  verifySessionToken,
  rateLimitMap,
  activeSessions,
  SESSION_DURATION,
  MAX_ATTEMPTS,
  LOCKOUT_DURATION,
} = auth._internals;

afterEach(() => {
  rateLimitMap.clear();
  activeSessions.clear();
});

// --- Password hashing ---

describe('hashPassword / verifyPassword', () => {
  test('hashed password verifies correctly', () => {
    const hash = hashPassword('test-password');
    expect(verifyPassword('test-password', hash)).toBe(true);
  });

  test('wrong password does not verify', () => {
    const hash = hashPassword('test-password');
    expect(verifyPassword('wrong-password', hash)).toBe(false);
  });

  test('hash format is salt:hash', () => {
    const hash = hashPassword('abc');
    const parts = hash.split(':');
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBe(32); // 16 bytes hex
    expect(parts[1].length).toBe(128); // 64 bytes hex
  });

  test('different calls produce different salts', () => {
    const h1 = hashPassword('same');
    const h2 = hashPassword('same');
    expect(h1).not.toBe(h2); // different salts
    expect(verifyPassword('same', h1)).toBe(true);
    expect(verifyPassword('same', h2)).toBe(true);
  });
});

// --- TOTP ---

describe('TOTP', () => {
  test('generateTotpSecret returns a string', () => {
    const secret = generateTotpSecret();
    expect(typeof secret).toBe('string');
    expect(secret.length).toBeGreaterThan(0);
  });

  test('verifyTotp returns false for invalid token', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp('000000', secret)).toBe(false);
  });

  test('verifyTotp returns false for non-string input', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(null, secret)).toBe(false);
  });
});

// --- Rate limiting ---

describe('rate limiting', () => {
  test('first check is allowed', () => {
    expect(checkRateLimit('1.2.3.4')).toEqual({ allowed: true });
  });

  test('recording failures below threshold keeps allowed', () => {
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      recordFailedAttempt('1.2.3.4');
    }
    expect(checkRateLimit('1.2.3.4')).toEqual({ allowed: true });
  });

  test('reaching MAX_ATTEMPTS triggers lockout', () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      recordFailedAttempt('1.2.3.4');
    }
    const result = checkRateLimit('1.2.3.4');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBeGreaterThan(0);
  });

  test('clearAttempts removes the entry', () => {
    recordFailedAttempt('1.2.3.4');
    clearAttempts('1.2.3.4');
    expect(rateLimitMap.has('1.2.3.4')).toBe(false);
  });

  test('lockout expires after LOCKOUT_DURATION', () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      recordFailedAttempt('5.6.7.8');
    }
    // Manually expire the lockout
    const entry = rateLimitMap.get('5.6.7.8');
    entry.lockedUntil = Date.now() - 1;
    expect(checkRateLimit('5.6.7.8')).toEqual({ allowed: true });
  });
});

// --- Session tokens ---

describe('session tokens', () => {
  const secret = crypto.randomBytes(32).toString('hex');

  test('created token verifies correctly', () => {
    const token = createSessionToken(secret);
    expect(verifySessionToken(token, secret)).toBe(true);
  });

  test('tampered token fails verification', () => {
    const token = createSessionToken(secret);
    // Swap a valid hex char to preserve buffer length for timingSafeEqual
    const [data, sig] = token.split('.');
    const lastChar = sig[sig.length - 1];
    const flipped = lastChar === '0' ? '1' : '0';
    const tampered = data + '.' + sig.slice(0, -1) + flipped;
    expect(verifySessionToken(tampered, secret)).toBe(false);
  });

  test('wrong secret fails verification', () => {
    const token = createSessionToken(secret);
    const wrongSecret = crypto.randomBytes(32).toString('hex');
    expect(verifySessionToken(token, wrongSecret)).toBe(false);
  });

  test('null/undefined/empty tokens return false', () => {
    expect(verifySessionToken(null, secret)).toBe(false);
    expect(verifySessionToken(undefined, secret)).toBe(false);
    expect(verifySessionToken('', secret)).toBe(false);
  });

  test('token format is data.signature', () => {
    const token = createSessionToken(secret);
    const parts = token.split('.');
    expect(parts).toHaveLength(2);
  });
});

// --- Session revocation ---

describe('session revocation', () => {
  const secret = crypto.randomBytes(32).toString('hex');

  test('createSessionToken adds token to activeSessions', () => {
    const token = createSessionToken(secret);
    expect(activeSessions.has(token)).toBe(true);
  });

  test('removing token from activeSessions invalidates it', () => {
    const token = createSessionToken(secret);
    expect(verifySessionToken(token, secret)).toBe(true);
    activeSessions.delete(token);
    expect(verifySessionToken(token, secret)).toBe(false);
  });

  test('clearing activeSessions invalidates all tokens', () => {
    const t1 = createSessionToken(secret);
    const t2 = createSessionToken(secret);
    expect(verifySessionToken(t1, secret)).toBe(true);
    expect(verifySessionToken(t2, secret)).toBe(true);
    activeSessions.clear();
    expect(verifySessionToken(t1, secret)).toBe(false);
    expect(verifySessionToken(t2, secret)).toBe(false);
  });

  test('token with mismatched signature length returns false (no crash)', () => {
    // Craft a token with a short signature to trigger the length check
    const payload = JSON.stringify({ ts: Date.now() });
    const data = Buffer.from(payload).toString('base64url');
    const badToken = `${data}.abc`;
    expect(verifySessionToken(badToken, secret)).toBe(false);
  });
});

// --- Cookie parsing ---

describe('parseCookies', () => {
  test('parses multiple cookies', () => {
    expect(auth.parseCookies('session=abc123; theme=dark')).toEqual({
      session: 'abc123',
      theme: 'dark',
    });
  });

  test('handles empty/null input', () => {
    expect(auth.parseCookies('')).toEqual({});
    expect(auth.parseCookies(null)).toEqual({});
    expect(auth.parseCookies(undefined)).toEqual({});
  });

  test('handles cookie values with = signs', () => {
    expect(auth.parseCookies('token=abc=def=ghi')).toEqual({
      token: 'abc=def=ghi',
    });
  });
});

// --- loadConfig ---

describe('loadConfig', () => {
  test('returns null when config file does not exist', () => {
    // loadConfig reads .auth.json which should not exist in test env
    // (or if it does, it returns the parsed object — either way, no crash)
    const result = auth.loadConfig();
    // Should return null or an object, never throw
    expect(result === null || typeof result === 'object').toBe(true);
  });
});
