#!/usr/bin/env bash
# PocketShell — Prerequisite Checker
# Checks all dependencies and installs npm packages.

set -euo pipefail

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

PASS="${GREEN}PASS${NC}"
FAIL="${RED}FAIL${NC}"
WARN="${YELLOW}WARN${NC}"

passed=0
failed=0
warned=0

check_pass() {
  echo -e "  [${PASS}] $1"
  passed=$((passed + 1))
}

check_fail() {
  echo -e "  [${FAIL}] $1"
  failed=$((failed + 1))
}

check_warn() {
  echo -e "  [${WARN}] $1"
  warned=$((warned + 1))
}

# --- Detect platform ---
detect_platform() {
  local uname_s
  uname_s="$(uname -s)"
  case "$uname_s" in
    Linux*)
      if grep -qi microsoft /proc/version 2>/dev/null; then
        echo "wsl"
      else
        echo "linux"
      fi
      ;;
    Darwin*)
      echo "macos"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      echo "windows"
      ;;
    *)
      echo "unknown"
      ;;
  esac
}

PLATFORM="$(detect_platform)"

echo ""
echo -e "${BOLD}PocketShell — Prerequisite Check${NC}"
echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# --- Platform ---
case "$PLATFORM" in
  wsl)
    check_pass "Platform: WSL (Windows Subsystem for Linux)"
    ;;
  linux)
    check_pass "Platform: Linux"
    ;;
  macos)
    check_pass "Platform: macOS"
    ;;
  windows)
    check_warn "Platform: Windows (Git Bash / MSYS)"
    echo -e "         ${YELLOW}Note: node-pty requires C++ build tools (windows-build-tools).${NC}"
    echo -e "         ${YELLOW}Consider using WSL for a smoother experience.${NC}"
    ;;
  *)
    check_warn "Platform: Unknown ($( uname -s ))"
    ;;
esac

# --- Node.js ---
if command -v node &>/dev/null; then
  NODE_VERSION="$(node -v | sed 's/^v//')"
  NODE_MAJOR="$(echo "$NODE_VERSION" | cut -d. -f1)"
  if [ "$NODE_MAJOR" -ge 18 ]; then
    check_pass "Node.js v${NODE_VERSION} (>= 18 required)"
  else
    check_fail "Node.js v${NODE_VERSION} found, but >= 18 is required"
    case "$PLATFORM" in
      macos)
        echo -e "         Install: ${CYAN}brew install node${NC} or https://nodejs.org"
        ;;
      wsl|linux)
        echo -e "         Install: ${CYAN}curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs${NC}"
        ;;
      *)
        echo -e "         Install from: https://nodejs.org"
        ;;
    esac
  fi
else
  check_fail "Node.js not found"
  case "$PLATFORM" in
    macos)
      echo -e "         Install: ${CYAN}brew install node${NC} or https://nodejs.org"
      ;;
    wsl|linux)
      echo -e "         Install: ${CYAN}curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs${NC}"
      ;;
    *)
      echo -e "         Install from: https://nodejs.org"
      ;;
  esac
fi

# --- npm ---
if command -v npm &>/dev/null; then
  NPM_VERSION="$(npm -v)"
  check_pass "npm v${NPM_VERSION}"
else
  check_fail "npm not found (usually bundled with Node.js)"
fi

# --- Claude CLI ---
if command -v claude &>/dev/null; then
  check_pass "Claude CLI found"
else
  check_fail "Claude CLI not found"
  echo -e "         Install: ${CYAN}npm install -g @anthropic-ai/claude-code${NC}"
  echo -e "         Docs: https://docs.anthropic.com/en/docs/claude-code"
  if [ "$PLATFORM" = "wsl" ]; then
    echo -e "         ${YELLOW}Note: Claude CLI must be installed inside WSL, not Windows.${NC}"
  fi
fi

# --- devtunnel (optional) ---
if command -v devtunnel &>/dev/null; then
  check_pass "devtunnel CLI found (remote access available)"
else
  check_warn "devtunnel CLI not found (optional — needed for remote access)"
  echo -e "         Install: ${CYAN}curl -sL https://aka.ms/DevTunnelCliInstall | bash${NC}"
fi

# --- npm install ---
echo ""
echo -e "${BOLD}Installing dependencies...${NC}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if (cd "$SCRIPT_DIR" && npm install); then
  check_pass "npm install completed"
else
  check_fail "npm install failed"
fi

# --- Summary ---
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}Summary:${NC} ${GREEN}${passed} passed${NC}, ${RED}${failed} failed${NC}, ${YELLOW}${warned} warnings${NC}"
echo ""

if [ "$failed" -gt 0 ]; then
  echo -e "${RED}Fix the failed checks above before running PocketShell.${NC}"
  exit 1
else
  echo -e "${GREEN}Ready to go!${NC} Run: ${CYAN}./pocketshell.sh start${NC}"
fi
