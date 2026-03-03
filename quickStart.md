# Quick Start

Get Claude Web Terminal running in 5 minutes.

## Prerequisites

- **Node.js** 18+ installed
- **Claude CLI** installed and authenticated (`claude` command works in your terminal)
- **A TOTP authenticator app** on your phone (Google Authenticator, Authy, Microsoft Authenticator, etc.)

## 1. Install Dependencies

```bash
cd ~/dev/amitsin/repos/teamsAddins
npm install
```

## 2. Start the Server

```bash
npm start
```

You should see:

```
[server] Claude Web Terminal running on http://0.0.0.0:3000
[server]   Desktop: http://localhost:3000/desktop.html
[server]   Mobile:  http://localhost:3000/mobile.html
[server]   First-time setup: http://localhost:3000/login.html
```

## 3. First-Time Auth Setup

Open `http://localhost:3000` in your browser. You'll be redirected to the setup page.

1. **Create a password** (min 6 characters)
2. **Scan the QR code** with your authenticator app (or enter the secret key manually)
3. **Enter the 6-digit code** from your authenticator to confirm
4. Click **Complete Setup** — you're logged in

> Your credentials are saved to `.auth.json`. Don't commit this file.

## 4. Access Locally

- **Desktop**: `http://localhost:3000/desktop.html` (or just `http://localhost:3000` on a computer)
- **Mobile**: `http://localhost:3000/mobile.html` (auto-redirects on mobile user agents)
- **Phone on same network**: `http://<your-ip>:3000`

> Note: The `secure` cookie flag is enabled, so login only works over HTTPS. For local HTTP access, temporarily set `secure: false` in `auth.js` (two places), or use the tunnel.

## 5. Access Remotely (Stable URL)

### One-time tunnel setup (already done)

```bash
# Install Dev Tunnels CLI
curl -sL https://aka.ms/DevTunnelCliInstall | bash

# Login with GitHub
devtunnel user login -g -d
# → opens browser for GitHub auth

# Create persistent tunnel
devtunnel create claude-terminal --allow-anonymous
devtunnel port create claude-terminal -p 3000 --protocol https
```

### Every time you want remote access

Open **two terminals**:

**Terminal 1** — Server:
```bash
cd ~/dev/amitsin/repos/teamsAddins
npm start
```

**Terminal 2** — Tunnel:
```bash
devtunnel host claude-terminal
```

The tunnel prints your URL:

```
Connect via browser: https://claude-terminal-3000.use.devtunnels.ms
```

Bookmark this URL on your phone — it stays the same every time.

### One-liner (both in one terminal)

```bash
npm start & devtunnel host claude-terminal
```

Stop with `Ctrl+C` then `kill %1`.

## 6. Daily Usage

1. Start server + tunnel (step 5)
2. Open the URL on your phone
3. Login with password + authenticator code
4. Use Claude via the mobile reader view or raw terminal

### Mobile Controls

| Control | Action |
|---------|--------|
| **View toggle** (status bar) | Switch between Reader and Terminal view |
| **A+ / A-** | Adjust font size (reader or terminal, whichever is active) |
| **Quick actions** | Tap 1-4, Yes/No, Esc, Tab, arrows, Ctrl+C, Enter |
| **Input bar** | Type and send text to Claude |
| **Double-tap** | Scroll to bottom |
| **Copy button** | Copy tool output (reader view) |
| **Restart** | Restart Claude CLI process |

### Desktop Controls

| Control | Action |
|---------|--------|
| Type normally | All keystrokes forwarded to Claude CLI |
| `Ctrl+Shift+R` | Restart Claude CLI process |

## Troubleshooting

### "Login page loops / can't set cookie"

The session cookie has `secure: true`. You must access via HTTPS (the tunnel) or temporarily set `secure: false` in `auth.js`.

### "Lost my authenticator / can't login"

```bash
rm .auth.json
npm start
# Setup page will appear again
```

### "Tunnel expired"

Tunnels expire after 30 days. Recreate:

```bash
devtunnel create claude-terminal --allow-anonymous
devtunnel port create claude-terminal -p 3000 --protocol https
```

### "WebSocket disconnected"

The client auto-reconnects every 2 seconds. If persistent, check that both the server (`npm start`) and tunnel (`devtunnel host`) are running.

### "Reader view shows garbled output"

Switch to Terminal view (tap the toggle button) to see raw output. The reader parser works best with standard Claude CLI output — unusual formatting may not parse perfectly.

### "Can't access from phone on same WiFi"

Find your machine's IP (`hostname -I`) and open `http://<ip>:3000`. On WSL2, you may need Windows port forwarding:

```powershell
# PowerShell (admin) on Windows
netsh interface portproxy add v4tov4 listenport=3000 listenaddress=0.0.0.0 connectport=3000 connectaddress=$(wsl hostname -I)
```
