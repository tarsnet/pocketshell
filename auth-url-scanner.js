/**
 * auth-url-scanner.js — Extracts auth-related URLs from raw PTY output.
 *
 * Fallback for CLIs that print auth URLs to the terminal instead of
 * opening a browser via $BROWSER.
 */

'use strict';

// Strip ANSI escape sequences (CSI, OSC, etc.)
const ANSI_RE = /\x1b(?:\[[0-9;]*[A-Za-z]|\].*?(?:\x07|\x1b\\)|\([A-B0-2])/g;

// Match https:// URLs — greedy but bounded to URL-safe characters
const URL_RE = /https:\/\/[^\s"'<>\])}]+/g;

// Auth-related path/host keywords
const AUTH_KEYWORDS = [
  'login', 'auth', 'device', 'oauth', 'authorize', 'signin', 'sign-in',
  'activate', 'consent', 'token', 'callback',
];

// Known auth hosts (even if path doesn't contain auth keywords)
const AUTH_HOSTS = [
  'github.com/login',
  'login.microsoftonline.com',
  'login.live.com',
  'login.microsoft.com',
  'devicelogin.microsoftonline.com',
  'console.anthropic.com',
  'accounts.google.com',
];

const AUTH_KEYWORD_RE = new RegExp('(?:' + AUTH_KEYWORDS.join('|') + ')', 'i');

// Dedup: track recently emitted URLs with timestamps
const recentUrls = new Map();
const COOLDOWN_MS = 30_000;

/**
 * Check if a URL looks auth-related.
 * @param {string} url
 * @returns {boolean}
 */
function isAuthUrl(url) {
  const lower = url.toLowerCase();
  // Check known auth hosts first
  for (const host of AUTH_HOSTS) {
    if (lower.includes(host)) return true;
  }
  // Check for auth keywords in path/query
  return AUTH_KEYWORD_RE.test(lower);
}

/**
 * Try to guess the provider from the URL.
 * @param {string} url
 * @returns {string}
 */
function guessProvider(url) {
  const lower = url.toLowerCase();
  if (lower.includes('github.com')) return 'GitHub';
  if (lower.includes('microsoftonline.com') || lower.includes('microsoft.com') || lower.includes('login.live.com')) return 'Microsoft';
  if (lower.includes('anthropic.com')) return 'Anthropic';
  if (lower.includes('google.com')) return 'Google';
  return 'Auth';
}

/**
 * Scan raw PTY output data for auth URLs.
 * Returns { url, provider } or null if no auth URL found.
 *
 * @param {string} data - Raw PTY output (may contain ANSI escapes)
 * @returns {{ url: string, provider: string } | null}
 */
function findAuthUrl(data) {
  const clean = data.replace(ANSI_RE, '');
  const matches = clean.match(URL_RE);
  if (!matches) return null;

  const now = Date.now();

  // Prune expired entries
  for (const [key, ts] of recentUrls) {
    if (now - ts > COOLDOWN_MS) recentUrls.delete(key);
  }

  for (const rawUrl of matches) {
    // Clean trailing punctuation that isn't part of URL
    const url = rawUrl.replace(/[.,;:!?)]+$/, '');
    if (!isAuthUrl(url)) continue;
    if (recentUrls.has(url)) continue;

    recentUrls.set(url, now);
    return { url, provider: guessProvider(url) };
  }

  return null;
}

/**
 * Reset dedup state (for testing).
 */
function resetDedup() {
  recentUrls.clear();
}

module.exports = { findAuthUrl, isAuthUrl, guessProvider, resetDedup };
