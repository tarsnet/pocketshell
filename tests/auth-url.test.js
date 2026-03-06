const { findAuthUrl, isAuthUrl, guessProvider, resetDedup } = require('../auth-url-scanner');

beforeEach(() => {
  resetDedup();
});

describe('isAuthUrl', () => {
  test('detects GitHub device login URL', () => {
    expect(isAuthUrl('https://github.com/login/device')).toBe(true);
  });

  test('detects Anthropic auth URL', () => {
    expect(isAuthUrl('https://console.anthropic.com/login/device?code=ABCD-1234')).toBe(true);
  });

  test('detects Microsoft login URL', () => {
    expect(isAuthUrl('https://login.microsoftonline.com/common/oauth2/authorize')).toBe(true);
  });

  test('detects Google accounts URL', () => {
    expect(isAuthUrl('https://accounts.google.com/o/oauth2/auth')).toBe(true);
  });

  test('detects generic auth keyword URL', () => {
    expect(isAuthUrl('https://example.com/oauth/authorize?client_id=abc')).toBe(true);
  });

  test('detects signin keyword URL', () => {
    expect(isAuthUrl('https://example.com/signin?redirect=home')).toBe(true);
  });

  test('ignores non-auth URLs (docs)', () => {
    expect(isAuthUrl('https://docs.example.com/guide/setup')).toBe(false);
  });

  test('ignores CDN URLs', () => {
    expect(isAuthUrl('https://cdn.jsdelivr.net/npm/xterm@5.5.0/lib/xterm.min.js')).toBe(false);
  });

  test('ignores regular GitHub repo URLs', () => {
    expect(isAuthUrl('https://github.com/anthropics/claude-code')).toBe(false);
  });
});

describe('guessProvider', () => {
  test('GitHub', () => {
    expect(guessProvider('https://github.com/login/device')).toBe('GitHub');
  });

  test('Microsoft', () => {
    expect(guessProvider('https://login.microsoftonline.com/common')).toBe('Microsoft');
  });

  test('Anthropic', () => {
    expect(guessProvider('https://console.anthropic.com/login')).toBe('Anthropic');
  });

  test('Google', () => {
    expect(guessProvider('https://accounts.google.com/o/oauth2/auth')).toBe('Google');
  });

  test('unknown defaults to Auth', () => {
    expect(guessProvider('https://example.com/oauth/authorize')).toBe('Auth');
  });
});

describe('findAuthUrl', () => {
  test('extracts auth URL from plain text', () => {
    const result = findAuthUrl('Open this URL: https://github.com/login/device?code=ABCD-1234');
    expect(result).toEqual({ url: 'https://github.com/login/device?code=ABCD-1234', provider: 'GitHub' });
  });

  test('extracts auth URL from ANSI-coded text', () => {
    const result = findAuthUrl('\x1b[1mOpen: \x1b[4mhttps://console.anthropic.com/login/device?code=XYZ\x1b[0m');
    expect(result).toEqual({ url: 'https://console.anthropic.com/login/device?code=XYZ', provider: 'Anthropic' });
  });

  test('returns null for non-auth URLs', () => {
    const result = findAuthUrl('Visit https://docs.example.com/guide for more info');
    expect(result).toBeNull();
  });

  test('returns null for empty input', () => {
    expect(findAuthUrl('')).toBeNull();
  });

  test('returns null for text with no URLs', () => {
    expect(findAuthUrl('Hello world, no URLs here.')).toBeNull();
  });

  test('dedup: same URL within cooldown returns null on second call', () => {
    const first = findAuthUrl('https://github.com/login/device?code=ABC');
    expect(first).not.toBeNull();

    const second = findAuthUrl('https://github.com/login/device?code=ABC');
    expect(second).toBeNull();
  });

  test('different auth URLs return independently', () => {
    const first = findAuthUrl('https://github.com/login/device?code=AAA');
    expect(first).not.toBeNull();

    const second = findAuthUrl('https://console.anthropic.com/login/device?code=BBB');
    expect(second).not.toBeNull();
    expect(second.provider).toBe('Anthropic');
  });

  test('strips trailing punctuation from URLs', () => {
    const result = findAuthUrl('Visit https://github.com/login/device?code=XYZ.');
    expect(result.url).toBe('https://github.com/login/device?code=XYZ');
  });
});
