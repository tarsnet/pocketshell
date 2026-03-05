(function () {
  const container = document.getElementById('terminal-container');
  const indicator = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');
  const statusProject = document.getElementById('status-project');

  // Show project label in status bar
  const project = window.POCKETSHELL_PROJECT || 'home';
  if (project && project !== 'home') {
    try {
      const decoded = atob(project.replace(/-/g, '+').replace(/_/g, '/'));
      const parts = decoded.split('/');
      statusProject.textContent = parts[parts.length - 1] || decoded;
    } catch (e) {
      statusProject.textContent = project;
    }
    statusProject.style.cursor = 'pointer';
    statusProject.style.marginLeft = '0.5em';
    statusProject.style.color = '#7aa2f7';
    statusProject.title = 'Click to change project';
    statusProject.addEventListener('click', function () {
      window.location.href = '/';
    });
  }

  const term = createTerminal(container, { fontSize: 14 });

  // --- FitAddon ---
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  // --- WebGL Addon (with canvas fallback) ---
  try {
    const webglAddon = new WebglAddon.WebglAddon();
    webglAddon.onContextLoss(() => {
      webglAddon.dispose();
    });
    term.loadAddon(webglAddon);
  } catch (e) {
    console.warn('[desktop] WebGL addon failed, using canvas renderer', e);
  }

  function fit() {
    try {
      fitAddon.fit();
      if (conn) {
        conn.sendResize(term.cols, term.rows);
      }
    } catch (e) { /* ignore fit errors during init */ }
  }

  // --- WebSocket ---
  const conn = connectWebSocket(term, {
    onOpen() {
      indicator.classList.add('connected');
      statusText.textContent = 'Connected';
      fit();
    },
    onClose() {
      indicator.classList.remove('connected');
      statusText.textContent = 'Disconnected — reconnecting...';
    },
    onExit(exitCode) {
      statusText.textContent = `Process exited (code ${exitCode})`;
    },
  });

  // --- Forward keystrokes to PTY ---
  term.onData((data) => {
    conn.sendInput(data);
  });

  // --- Ctrl+Shift+R to restart ---
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'R') {
      e.preventDefault();
      term.clear();
      conn.sendRestart(term.cols, term.rows);
      statusText.textContent = 'Restarting...';
    }
  });

  // --- Resize handling ---
  window.addEventListener('resize', () => fit());

  // Initial fit after a brief delay for layout
  setTimeout(fit, 100);

  // Auto-focus
  term.focus();
})();
