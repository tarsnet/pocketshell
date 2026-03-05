// Tokyo Night color theme
const THEME = {
  background: '#1a1b26',
  foreground: '#c0caf5',
  cursor: '#c0caf5',
  cursorAccent: '#1a1b26',
  selectionBackground: '#33467c',
  selectionForeground: '#c0caf5',
  black: '#15161e',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#414868',
  brightRed: '#f7768e',
  brightGreen: '#9ece6a',
  brightYellow: '#e0af68',
  brightBlue: '#7aa2f7',
  brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff',
  brightWhite: '#c0caf5',
};

const FONT_FAMILY = '"Cascadia Code", "Fira Code", "JetBrains Mono", "Source Code Pro", Menlo, Monaco, "Courier New", monospace';

/**
 * Create an xterm.js Terminal instance.
 * @param {HTMLElement} container - DOM element to attach terminal to
 * @param {object} opts - Override terminal options
 * @returns {Terminal} xterm.js Terminal instance
 */
function createTerminal(container, opts = {}) {
  const term = new Terminal({
    theme: THEME,
    fontFamily: FONT_FAMILY,
    fontSize: opts.fontSize || 14,
    scrollback: 10000,
    cursorBlink: true,
    cursorStyle: 'block',
    allowProposedApi: true,
    ...opts,
  });
  term.open(container);
  return term;
}

/**
 * Connect to the WebSocket server with auto-reconnect.
 * @param {Terminal} term - xterm.js Terminal instance
 * @param {object} callbacks - { onOpen, onClose, onExit }
 * @returns {{ ws: WebSocket, send: function }}
 */
function connectWebSocket(term, callbacks = {}) {
  const state = { ws: null };
  let reconnectTimer = null;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const mode = window.POCKETSHELL_MODE || 'terminal';
    const project = window.POCKETSHELL_PROJECT || 'home';
    const wsUrl = `${proto}//${location.host}/ws/${mode}?project=${encodeURIComponent(project)}`;
    const ws = new WebSocket(wsUrl);
    state.ws = ws;

    ws.onopen = () => {
      console.log('[ws] connected');
      if (callbacks.onOpen) callbacks.onOpen();
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }

      switch (msg.type) {
        case 'output':
          term.write(msg.data);
          callbacks.onOutput?.();
          break;
        case 'exit':
          term.write('\r\n\x1b[33m--- Process exited ---\x1b[0m\r\n');
          if (callbacks.onExit) callbacks.onExit(msg.exitCode, msg.signal);
          break;
      }
    };

    ws.onclose = () => {
      console.log('[ws] disconnected');
      if (callbacks.onClose) callbacks.onClose();
      // Auto-reconnect after 2 seconds
      reconnectTimer = setTimeout(connect, 2000);
    };

    ws.onerror = (err) => {
      console.error('[ws] error', err);
      ws.close();
    };
  }

  connect();

  return {
    get ws() { return state.ws; },

    send(obj) {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify(obj));
      }
    },

    sendInput(data) {
      this.send({ type: 'input', data });
    },

    sendResize(cols, rows) {
      this.send({ type: 'resize', cols, rows });
    },

    sendRestart(cols, rows) {
      this.send({ type: 'restart', cols, rows });
    },

    destroy() {
      clearTimeout(reconnectTimer);
      if (state.ws) state.ws.close();
    },
  };
}
