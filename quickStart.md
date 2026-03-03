# Quick Start

Get PocketShell running in 5 minutes.

## Prerequisites

- **Node.js** 18+ installed
- **Claude CLI** installed and authenticated (if you want to use Claude mode)
- **GitHub Copilot CLI** installed (if you want to use Copilot mode)
- **A TOTP authenticator app** on your phone (Google Authenticator, Authy, etc.)

## 1. Setup

```bash
cd pocketshell
npm run setup
```

This checks your prerequisites and installs dependencies. Fix any issues it reports.

## 2. Start the Server

```bash
npm start
```

You should see:

```
  ┌────────────────────────────────────────────────────────────┐
  │                  PocketShell is running                    │
  ├────────────────────────────────────────────────────────────┤
  │  Landing:   http://localhost:3000                           │
  │  Claude:    http://localhost:3000/desktop/claude             │
  │  Copilot:   http://localhost:3000/desktop/copilot            │
  │  Terminal:  http://localhost:3000/desktop/terminal            │
  └────────────────────────────────────────────────────────────┘
```

## 3. First-Time Auth Setup

Open `http://localhost:3000` in your browser. You'll be redirected to the setup page.

1. **Create a password** (min 6 characters)
2. **Scan the QR code** with your authenticator app (or enter the secret key manually)
3. **Enter the 6-digit code** from your authenticator to confirm
4. Click **Complete Setup** — you're logged in

> Your credentials are saved to `.auth.json`. Don't commit this file.

## 4. Pick a Mode

After login, you'll see the landing page with three options:

- **Claude Code** — AI-powered coding assistant
- **GitHub Copilot** — Copilot CLI assistant
- **Terminal** — Plain bash shell

Click any card to launch that mode. The landing page auto-detects your device and links to desktop or mobile view.

## 5. Access Locally

- **Landing page**: `http://localhost:3000`
- **Mobile on same network**: `http://<your-ip>:3000`
- **No-auth mode**: `npm run start:noauth` (skips login — trusted networks only)

## 6. Access Remotely

### One-time tunnel setup

```bash
# Install Dev Tunnels CLI
curl -sL https://aka.ms/DevTunnelCliInstall | bash

# Login with GitHub
devtunnel user login -g -d
```

### Start with remote access

```bash
npm run start:remote
```

This starts the server and tunnel together. The tunnel URL is printed in the output — bookmark it on your phone.

Press `Ctrl+C` to stop both.

## 7. Daily Usage

1. Start server: `npm start` (local) or `npm run start:remote` (remote)
2. Open the URL on your device
3. Login with password + authenticator code
4. Pick a mode from the landing page

### Mobile Controls

| Control | Action |
|---------|--------|
| **View toggle** (status bar) | Switch between Reader and Terminal view |
| **A+ / A-** | Adjust font size |
| **Quick actions** | Tap 1-4, Yes/No, Esc, Tab, arrows, Ctrl+C, Enter |
| **Input bar** | Type and send text |
| **Copy button** | Copy tool output (reader view) |
| **Restart** | Restart the current mode's process |

### Desktop Controls

| Control | Action |
|---------|--------|
| Type normally | All keystrokes forwarded to the terminal |
| `Ctrl+Shift+R` | Restart the current mode's process |

## Troubleshooting

### "Lost my authenticator / can't login"

```bash
rm .auth.json
npm start
# Setup page will appear again
```

### "Tunnel expired"

Tunnels expire after 30 days. The `start --remote` command auto-creates a new one if needed.

### "WebSocket disconnected"

The client auto-reconnects every 2 seconds. Check that the server is running.

### "Reader view shows garbled output"

Switch to Terminal view (tap the toggle button). The reader parser works best with standard CLI output.

### "Can't access from phone on same WiFi"

Find your machine's IP (`hostname -I`) and open `http://<ip>:3000`. On WSL2, you may need Windows port forwarding:

```powershell
# PowerShell (admin) on Windows
netsh interface portproxy add v4tov4 listenport=3000 listenaddress=0.0.0.0 connectport=3000 connectaddress=$(wsl hostname -I)
```
