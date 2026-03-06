#!/bin/sh
# browser-bridge.sh — Intercepts $BROWSER for PocketShell auth URL capture.
#
# Instead of opening a real browser, writes the URL to a per-session file
# so the PocketShell server can pick it up and forward it to the client.
#
# Environment:
#   POCKETSHELL_AUTH_PIPE — path to the file where URLs are appended

if [ -z "$POCKETSHELL_AUTH_PIPE" ]; then
  # Fallback: if no pipe configured, try xdg-open
  exec xdg-open "$1" 2>/dev/null || true
  exit 0
fi

echo "$1" >> "$POCKETSHELL_AUTH_PIPE"
