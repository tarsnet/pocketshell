#!/usr/bin/env bash
# PocketShell — Single CLI Entrypoint
# Usage: ./pocketshell.sh [setup|start|stop|help]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="$SCRIPT_DIR/.pocketshell.pid"
TUNNEL_NAME="claude-terminal"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

usage() {
  echo ""
  echo -e "${BOLD}PocketShell${NC} — Claude Code in your browser"
  echo ""
  echo -e "Usage: ${CYAN}./pocketshell.sh${NC} <command> [options]"
  echo ""
  echo "Commands:"
  echo "  setup                Check prerequisites and install dependencies"
  echo "  start                Start the server (default: local with auth)"
  echo "  stop                 Stop running server and tunnel"
  echo "  test [suites]        Run tests (all, or comma-separated: auth,parsers,server,projects)"
  echo "  help                 Show this help message"
  echo ""
  echo "Start options:"
  echo "  --local              Start server locally with auth (default)"
  echo "  --remote             Start server + devtunnel for remote access"
  echo "  --local-noauth       Start server without auth (trusted network only)"
  echo "  --force              Stop any running instance first, then start"
  echo ""
  echo "Examples:"
  echo -e "  ${CYAN}./pocketshell.sh setup${NC}                 # First-time setup"
  echo -e "  ${CYAN}./pocketshell.sh start${NC}                 # Start locally"
  echo -e "  ${CYAN}./pocketshell.sh start --remote${NC}         # Start with tunnel"
  echo -e "  ${CYAN}./pocketshell.sh start --local-noauth${NC}   # Start without auth"
  echo -e "  ${CYAN}./pocketshell.sh start --force${NC}          # Force restart"
  echo -e "  ${CYAN}./pocketshell.sh stop${NC}                  # Stop everything"
  echo -e "  ${CYAN}./pocketshell.sh test${NC}                  # Run all tests"
  echo -e "  ${CYAN}./pocketshell.sh test auth,parsers${NC}      # Run specific suites"
  echo -e "  ${CYAN}./pocketshell.sh test -- --coverage${NC}     # Pass extra args to jest"
  echo ""
}

cmd_setup() {
  bash "$SCRIPT_DIR/prerequisites.sh"
}

save_pid() {
  echo "$1" >> "$PIDFILE"
}

# Check if a PocketShell server is already running.
# Returns 0 if running, 1 if not.
is_running() {
  # Check pidfile first
  if [ -f "$PIDFILE" ]; then
    while IFS= read -r pid; do
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        return 0
      fi
    done < "$PIDFILE"
  fi

  # Check for stray server processes
  if pgrep -f 'node server.js' >/dev/null 2>&1; then
    return 0
  fi

  return 1
}

# Require that no instance is running, or --force was given.
# Usage: require_not_running "$force"
require_not_running() {
  local force="$1"

  if is_running; then
    if [ "$force" = "true" ]; then
      echo -e "${YELLOW}Stopping existing PocketShell instance...${NC}"
      cmd_stop
      # Brief wait for port to free up
      sleep 1
    else
      echo -e "${RED}PocketShell is already running.${NC}"
      echo -e "  Use ${CYAN}./pocketshell.sh stop${NC} first, or add ${CYAN}--force${NC} to auto-restart."
      echo -e "  Example: ${CYAN}./pocketshell.sh start --local-noauth --force${NC}"
      exit 1
    fi
  fi
}

cmd_stop() {
  local killed=0

  # Kill PIDs from pidfile
  if [ -f "$PIDFILE" ]; then
    while IFS= read -r pid; do
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null && echo -e "  Stopped process ${CYAN}${pid}${NC}"
        killed=$((killed + 1))
      fi
    done < "$PIDFILE"
    rm -f "$PIDFILE"
  fi

  # Also find any stray server processes
  local server_pids
  server_pids="$(pgrep -f 'node server.js' 2>/dev/null || true)"
  for pid in $server_pids; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null && echo -e "  Stopped server ${CYAN}${pid}${NC}"
      killed=$((killed + 1))
    fi
  done

  # Kill devtunnel processes
  local tunnel_pids
  tunnel_pids="$(pgrep -f 'devtunnel host' 2>/dev/null || true)"
  for pid in $tunnel_pids; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null && echo -e "  Stopped tunnel ${CYAN}${pid}${NC}"
      killed=$((killed + 1))
    fi
  done

  # Always clean up stale pidfile
  rm -f "$PIDFILE"

  if [ "$killed" -eq 0 ]; then
    echo -e "${YELLOW}No running PocketShell processes found.${NC}"
  else
    # Wait briefly for processes to fully exit
    sleep 0.5
    echo -e "${GREEN}Stopped.${NC}"
  fi
}

cmd_start_local() {
  local force="$1"; shift
  require_not_running "$force"
  echo -e "${BOLD}Starting PocketShell (local, with auth)...${NC}"
  echo ""
  cd "$SCRIPT_DIR"
  exec node server.js "$@"
}

cmd_start_noauth() {
  local force="$1"; shift
  require_not_running "$force"
  echo -e "${BOLD}Starting PocketShell (local, no auth)...${NC}"
  echo -e "${YELLOW}Warning: Authentication is disabled. Only use on trusted networks.${NC}"
  echo ""
  cd "$SCRIPT_DIR"
  exec node server.js --no-auth "$@"
}

cmd_start_remote() {
  local force="$1"
  require_not_running "$force"

  # Check devtunnel is available
  if ! command -v devtunnel &>/dev/null; then
    echo -e "${RED}Error: devtunnel CLI not found.${NC}"
    echo -e "Install: ${CYAN}curl -sL https://aka.ms/DevTunnelCliInstall | bash${NC}"
    exit 1
  fi

  # Check devtunnel is logged in
  if ! devtunnel user show &>/dev/null; then
    echo -e "${RED}Error: devtunnel not logged in.${NC}"
    echo -e "Run: ${CYAN}devtunnel user login -g -d${NC}"
    exit 1
  fi

  # Ensure tunnel exists (create if not)
  if ! devtunnel show "$TUNNEL_NAME" &>/dev/null 2>&1; then
    echo -e "${YELLOW}Creating tunnel '${TUNNEL_NAME}'...${NC}"
    devtunnel create "$TUNNEL_NAME" --allow-anonymous
    devtunnel port create "$TUNNEL_NAME" -p 3000 --protocol https
  fi

  echo -e "${BOLD}Starting PocketShell (remote access)...${NC}"
  echo -e "${YELLOW}Note: If setup is not yet complete, the setup token will appear in the server banner above.${NC}"
  echo -e "${YELLOW}You must include ?token=<TOKEN> in the login URL to access setup.${NC}"
  echo ""

  # Clean up old pidfile
  rm -f "$PIDFILE"

  # Start server in background with --remote flag
  cd "$SCRIPT_DIR"
  node server.js --remote &
  local server_pid=$!
  save_pid "$server_pid"
  echo -e "  Server started (PID: ${CYAN}${server_pid}${NC})"

  # Give server a moment to start
  sleep 1

  # Trap to clean up both processes on Ctrl+C
  cleanup() {
    echo ""
    echo -e "${BOLD}Shutting down...${NC}"
    kill "$server_pid" 2>/dev/null || true
    rm -f "$PIDFILE"
    echo -e "${GREEN}Stopped.${NC}"
    exit 0
  }
  trap cleanup SIGINT SIGTERM

  # Start tunnel in foreground
  echo -e "  Starting tunnel..."
  echo ""
  devtunnel host "$TUNNEL_NAME" &
  local tunnel_pid=$!
  save_pid "$tunnel_pid"

  # Wait for either process to exit
  wait -n "$server_pid" "$tunnel_pid" 2>/dev/null || true
  cleanup
}

cmd_test() {
  cd "$SCRIPT_DIR"
  local suites=""
  local extra_args=()

  # Parse arguments: everything before -- is suite names, after -- goes to jest
  local past_separator=false
  for arg in "$@"; do
    if [ "$arg" = "--" ]; then
      past_separator=true
      continue
    fi
    if $past_separator; then
      extra_args+=("$arg")
    else
      suites="$arg"
    fi
  done

  local jest_args=()

  if [ -n "$suites" ]; then
    # Check if it looks like a comma-separated list of known suite names
    local all_known=true
    IFS=',' read -ra suite_list <<< "$suites"
    for s in "${suite_list[@]}"; do
      case "$s" in
        auth|parsers|server|projects) ;;
        *) all_known=false; break ;;
      esac
    done

    if $all_known; then
      # Resolve suite names to test file paths
      for s in "${suite_list[@]}"; do
        jest_args+=("tests/${s}.test.js")
      done
    else
      # Treat as a regex pattern for jest
      jest_args+=("--testPathPattern" "$suites")
    fi
  fi

  NODE_ENV=test exec npx jest "${jest_args[@]}" "${extra_args[@]}"
}

# --- Main ---
COMMAND="${1:-help}"
shift || true

case "$COMMAND" in
  setup)
    cmd_setup
    ;;
  start)
    # Collect mode and --force from args (order-independent)
    START_MODE="--local"
    FORCE="false"
    remaining_args=()

    for arg in "$@"; do
      case "$arg" in
        --local|--remote|--local-noauth)
          START_MODE="$arg"
          ;;
        --force)
          FORCE="true"
          ;;
        *)
          remaining_args+=("$arg")
          ;;
      esac
    done

    case "$START_MODE" in
      --local)
        cmd_start_local "$FORCE" "${remaining_args[@]+"${remaining_args[@]}"}"
        ;;
      --remote)
        cmd_start_remote "$FORCE"
        ;;
      --local-noauth)
        cmd_start_noauth "$FORCE" "${remaining_args[@]+"${remaining_args[@]}"}"
        ;;
    esac
    ;;
  stop)
    cmd_stop
    ;;
  test)
    cmd_test "$@"
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    echo -e "${RED}Unknown command: ${COMMAND}${NC}"
    usage
    exit 1
    ;;
esac
