# Claude Web Terminal

A browser-accessible terminal for [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) with mobile-optimized UI, real-time streaming, and secure remote access via password + TOTP authentication.

## Features

- **Desktop & Mobile UIs** — Raw terminal for desktop, chat-style reader view for mobile
- **Real-time streaming** — WebSocket-based PTY I/O with replay buffer for reconnecting clients
- **Chat Reader View** — Parses Claude CLI output into styled conversation segments (user, assistant, tool calls, results)
- **Secure remote access** — Password + TOTP (Google Authenticator), rate-limited login, signed session cookies
- **Stable tunnel** — Microsoft Dev Tunnels integration for persistent HTTPS URLs
- **Zero build step** — Pure client-side JavaScript, no bundler required

## Architecture

```
Browser (Desktop/Mobile)
    │
    ├── HTTPS ──► Login Page ──► Password + TOTP Auth
    │
    └── WSS ──► Express Server ──► node-pty ──► Claude CLI
                     │
                     ├── Replay Buffer (100KB) — new clients see current state
                     ├── Auth Middleware — protects all routes + WebSocket
                     └── Broadcast — streams output to all connected clients
```

### Mobile Reader View Pipeline

```
WebSocket → xterm.js (hidden) → Buffer Scraper → Conversation Parser → HTML Renderer
                                                                          ↓
                                                              Styled Chat View (visible)
```

## File Structure

```
├── server.js              # Express + WebSocket + PTY server
├── auth.js                # Authentication module (password, TOTP, sessions, rate limiting)
├── package.json           # Dependencies: express, ws, node-pty, otplib, qrcode
├── .auth.json             # Generated — stores password hash, TOTP secret (git-ignored)
└── public/
    ├── login.html         # Combined setup/login page
    ├── desktop.html       # Desktop terminal UI
    ├── desktop.js         # Desktop client (WebGL rendering, keyboard forwarding)
    ├── desktop.css        # Desktop styles
    ├── mobile.html        # Mobile terminal + reader UI
    ├── mobile.js          # Mobile client (buffer scraper, renderer, toggle, font controls)
    ├── mobile.css         # Mobile styles (reader view, messages, animations)
    ├── shared.js          # Shared: terminal creation, WebSocket connection, Tokyo Night theme
    └── reader-parser.js   # Conversation parser (detects user/assistant/tool/system segments)
```

## Security

| Layer | Detail |
|-------|--------|
| **HTTPS** | Dev Tunnels provides TLS encryption |
| **Password** | PBKDF2-hashed (100K iterations, SHA-512, random salt) |
| **TOTP** | Google Authenticator compatible, 30-second rotating codes |
| **Rate Limiting** | 5 failed attempts per IP → 15-minute lockout |
| **Session Cookie** | HMAC-SHA256 signed, `httpOnly`, `sameSite: strict`, `secure`, 24h expiry |
| **WebSocket Auth** | Unauthenticated upgrade requests rejected via `verifyClient` |
| **Config File** | `.auth.json` written with mode 0600 (owner-only read/write) |

## Dependencies

| Package | Purpose |
|---------|---------|
| `express` | HTTP server and routing |
| `ws` | WebSocket server |
| `node-pty` | Pseudo-terminal for running Claude CLI |
| `otplib` | TOTP generation and verification |
| `qrcode` | QR code generation for authenticator app setup |

## Mobile Reader View

The reader view parses raw terminal output into styled conversation segments:

- **User messages** — Blue left border, "You" label
- **Assistant responses** — Clean text with inline code and bold formatting
- **Tool calls** — Dark header with tool name in purple, monospace code body, copy button
- **Tool results** — Similar to tool calls with cyan accent
- **System messages** — Centered, dimmed

Detection uses Claude CLI markers: `❯` (user prompt), `●`/`◆` (assistant), `⎿` (tool result), box-drawing chars (system UI).

Toggle between reader and raw terminal views. Font size controls adapt to whichever view is active.

## Tunnel Management

Using Microsoft Dev Tunnels (stable URLs, free, GitHub auth):

```bash
# First-time setup (already done)
devtunnel user login -g -d
devtunnel create claude-terminal --allow-anonymous
devtunnel port create claude-terminal -p 3000 --protocol https

# Start tunnel (run alongside npm start)
devtunnel host claude-terminal

# Other commands
devtunnel list                          # List tunnels
devtunnel show claude-terminal          # Show tunnel details
devtunnel delete claude-terminal        # Remove tunnel
```

Tunnel expires after 30 days — recreate with the same name to renew.

## Configuration

| Item | Location | Notes |
|------|----------|-------|
| Server port | `PORT` env var | Default: 3000 |
| Auth config | `.auth.json` | Auto-generated on first setup |
| Session duration | `auth.js` `SESSION_DURATION` | Default: 24 hours |
| Rate limit | `auth.js` `MAX_ATTEMPTS` / `LOCKOUT_DURATION` | Default: 5 attempts / 15 min |
| Replay buffer | `server.js` `REPLAY_BUFFER_SIZE` | Default: 100KB |

## Resetting Authentication

If you lose access to your authenticator app:

```bash
# Delete the auth config and restart
rm .auth.json
npm start
# Visit the app — setup page will appear again
```

## License

Private project.
