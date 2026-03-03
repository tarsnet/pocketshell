# PocketShell

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Access [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) from any browser — desktop or mobile. Free and open source.

## Quickstart

```bash
git clone https://github.com/AwareSelf/pocketshell.git
cd pocketshell
npm run setup    # checks prerequisites, installs dependencies
npm start        # starts server at http://localhost:3000
```

Open `http://localhost:3000` in your browser. On first visit you'll set up a password + TOTP for authentication.

## Features

- **Desktop & Mobile UIs** — Full terminal for desktop, chat-style reader view for mobile
- **Real-time streaming** — WebSocket-based PTY with replay buffer for reconnecting clients
- **Mobile Reader View** — Parses Claude CLI output into styled conversation segments
- **Secure remote access** — Password + TOTP (Google Authenticator), rate-limited login, signed cookies
- **One-command tunnel** — Microsoft Dev Tunnels integration for persistent HTTPS URLs
- **No build step** — Pure client-side JavaScript, no bundler required

## Architecture

```
Browser (Desktop/Mobile)
    |
    |-- HTTPS --> Express Server --> node-pty --> Claude CLI
    |                 |
    |                 |-- Auth Middleware (password + TOTP)
    |                 |-- Replay Buffer (100KB)
    |                 +-- WebSocket broadcast to all clients
    |
    +-- Optional: Dev Tunnel (HTTPS) for remote access
```

### Mobile Reader View Pipeline

```
WebSocket --> xterm.js (hidden) --> Buffer Scraper --> Conversation Parser --> Styled Chat View
```

## Usage

### Local (with auth — default)

```bash
./pocketshell.sh start              # or: npm start
```

### Local (no auth — trusted network)

```bash
./pocketshell.sh start --local-noauth   # or: npm run start:noauth
```

### Remote access (server + tunnel)

```bash
./pocketshell.sh start --remote    # or: npm run start:remote
```

Starts the server and a Dev Tunnel in one terminal. Prints the HTTPS URL. Ctrl+C stops both.

Requires [Dev Tunnels CLI](https://aka.ms/DevTunnelCliInstall) — one-time setup:

```bash
curl -sL https://aka.ms/DevTunnelCliInstall | bash
devtunnel user login -g -d
```

### Stop

```bash
./pocketshell.sh stop
```

### Custom port

```bash
node server.js --port 8080
# or: PORT=8080 npm start
```

## CLI Reference

```
./pocketshell.sh setup              # Check prerequisites, install deps
./pocketshell.sh start              # Start locally with auth (default)
./pocketshell.sh start --local      # Same as above
./pocketshell.sh start --remote     # Start server + tunnel
./pocketshell.sh start --local-noauth  # Start without auth
./pocketshell.sh stop               # Stop server and tunnel
./pocketshell.sh help               # Show usage
```

## npm scripts

| Script | Description |
|--------|-------------|
| `npm start` | Start server locally (with auth) |
| `npm run setup` | Check prerequisites and install deps |
| `npm run start:remote` | Start server + tunnel |
| `npm run start:noauth` | Start server without auth |

## Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| macOS | Full support | Works natively |
| Linux | Full support | Works natively |
| WSL | Full support | Claude CLI must be installed inside WSL |
| Windows (native) | Partial | Needs Node.js + build tools for node-pty; use npm scripts instead of bash |

## Security

| Layer | Detail |
|-------|--------|
| HTTPS | Dev Tunnels provides TLS encryption |
| Password | PBKDF2-hashed (100K iterations, SHA-512, random salt) |
| TOTP | Google Authenticator compatible, 30-second rotating codes |
| Rate Limiting | 5 failed attempts per IP, 15-minute lockout |
| Session Cookie | HMAC-SHA256 signed, httpOnly, sameSite strict, secure (auto-detected), 24h expiry |
| WebSocket Auth | Unauthenticated upgrade requests rejected |
| Config File | `.auth.json` written with mode 0600 |

## File Structure

```
pocketshell/
  pocketshell.sh         # CLI entrypoint
  prerequisites.sh       # Dependency checker
  server.js              # Express + WebSocket + PTY server
  auth.js                # Authentication (password, TOTP, sessions)
  package.json
  public/
    login.html           # Setup/login page
    desktop.html/.js/.css # Desktop terminal UI
    mobile.html/.js/.css  # Mobile terminal + reader UI
    shared.js            # Shared terminal config, WebSocket, theme
    reader-parser.js     # Conversation parser for reader view
```

## Resetting Authentication

```bash
rm .auth.json
npm start
# Setup page will appear again
```

## License

Apache License 2.0 — free for personal and commercial use. See [LICENSE](LICENSE).
