(function () {
  const mode = window.POCKETSHELL_MODE || 'terminal';
  // Copilot uses the same UI markers as Claude (❯, ●, box-drawing), so ReaderParser works for both.
  const ActiveParser = { claude: ReaderParser, copilot: ReaderParser, terminal: TerminalParser }[mode] || TerminalParser;

  const container = document.getElementById('terminal-container');
  const indicator = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');
  const statusProject = document.getElementById('status-project');
  const inputField = document.getElementById('input-field');

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
    statusProject.style.marginLeft = '0.4em';
    statusProject.style.color = '#7aa2f7';
    statusProject.style.fontSize = '0.8rem';
    statusProject.title = 'Change project';
    statusProject.addEventListener('click', function () {
      window.location.href = '/';
    });
  }
  const sendBtn = document.getElementById('send-btn');
  const fontDownBtn = document.getElementById('font-down');
  const fontUpBtn = document.getElementById('font-up');
  const restartBtn = document.getElementById('restart-btn');
  const viewToggleBtn = document.getElementById('view-toggle');
  const readerContainer = document.getElementById('reader-container');
  const readerMessages = document.getElementById('reader-messages');
  const streamingIndicator = document.getElementById('streaming-indicator');

  // Auth banner elements
  const authBanner = document.getElementById('auth-banner');
  const authProvider = document.getElementById('auth-provider');
  const authLink = document.getElementById('auth-link');
  const authDismiss = document.getElementById('auth-dismiss');
  let authHideTimer = null;

  let fontSize = 12;
  let readerFontSize = 16;
  let isReaderView = true; // Reader is default

  const term = createTerminal(container, {
    fontSize,
    cursorBlink: false, // less distracting on mobile
  });

  // --- FitAddon ---
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  function fit() {
    try {
      fitAddon.fit();
      if (conn) {
        conn.sendResize(term.cols, term.rows);
      }
    } catch (e) { /* ignore */ }
  }

  // --- Auth Banner ---
  function showAuthBanner(url, provider) {
    authProvider.textContent = provider || 'Auth';
    authLink.href = url;
    authBanner.hidden = false;
    // Auto-hide after 2 minutes
    if (authHideTimer) clearTimeout(authHideTimer);
    authHideTimer = setTimeout(() => { authBanner.hidden = true; }, 120000);
  }

  authDismiss.addEventListener('click', () => {
    authBanner.hidden = true;
    if (authHideTimer) clearTimeout(authHideTimer);
  });

  // --- Buffer Scraper ---
  let lastLineCount = 0;

  function scrapeBuffer() {
    const { lines, richLines } = ReaderRenderer.scrapeBufferRich(term);
    const changed = lines.length !== lastLineCount;
    lastLineCount = lines.length;
    return { lines, richLines, changed };
  }

  // --- Quiet-Period Debouncing ---
  const ACTIVE_SCRAPE_MS = 500;  // periodic scrape during active output
  const QUIET_PERIOD_MS = 300;   // final scrape after output stops
  let activeTimer = null;
  let quietTimer = null;
  let outputActive = false;

  function doScrape() {
    const { lines, richLines } = scrapeBuffer();
    if (lines.length > 0) {
      const segments = ActiveParser.parse(lines);
      ReaderRenderer.attachRichLines(segments, lines, richLines);
      renderSegments(segments);
    }
  }

  function scheduleScrape() {
    if (!isReaderView) return;

    // Mark output as active, show streaming indicator
    if (!outputActive) {
      outputActive = true;
      streamingIndicator.hidden = false;
    }

    // Schedule periodic active scrape if not already scheduled
    if (!activeTimer) {
      activeTimer = setTimeout(() => {
        activeTimer = null;
        doScrape();
        // Reschedule if still active
        if (outputActive) {
          activeTimer = setTimeout(arguments.callee, ACTIVE_SCRAPE_MS);
        }
      }, ACTIVE_SCRAPE_MS);
    }

    // Reset quiet timer on every chunk
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      quietTimer = null;
      outputActive = false;
      streamingIndicator.hidden = true;
      // Cancel any pending active timer
      if (activeTimer) { clearTimeout(activeTimer); activeTimer = null; }
      // Final authoritative scrape
      doScrape();
    }, QUIET_PERIOD_MS);
  }

  // --- Segment Fingerprinting ---
  function segmentFingerprint(seg) {
    // Simple hash: type + line count + first 100 chars of content
    const preview = seg.lines.join('\n').slice(0, 100);
    return seg.type + ':' + seg.lines.length + ':' + preview;
  }

  // --- Renderer ---
  let renderedFingerprints = []; // fingerprints of currently rendered segments

  function createSegmentElement(segment) {
    return ReaderRenderer.createSegmentElement(segment, ActiveParser, mode);
  }

  function renderSegments(segments) {
    if (!segments || segments.length === 0) return;

    // Check if user is near bottom for auto-scroll
    const nearBottom = readerContainer.scrollHeight - readerContainer.scrollTop - readerContainer.clientHeight < 80;

    const newFingerprints = segments.map(segmentFingerprint);

    // Find common prefix — how many leading segments are unchanged
    let commonPrefix = 0;
    const children = readerMessages.children;
    const minLen = Math.min(renderedFingerprints.length, newFingerprints.length);
    for (let i = 0; i < minLen; i++) {
      if (renderedFingerprints[i] === newFingerprints[i]) {
        commonPrefix++;
      } else {
        break;
      }
    }

    // If total segments decreased, remove excess DOM nodes from the end
    while (children.length > newFingerprints.length) {
      readerMessages.removeChild(readerMessages.lastElementChild);
    }

    // Update changed segments in-place (after the common prefix)
    for (let i = commonPrefix; i < Math.min(children.length, segments.length); i++) {
      const updatedEl = createSegmentElement(segments[i]);
      if (updatedEl) {
        readerMessages.replaceChild(updatedEl, children[i]);
      }
    }

    // Append new segments beyond what we had
    for (let i = children.length; i < segments.length; i++) {
      const el = createSegmentElement(segments[i]);
      if (el) {
        el.classList.add('segment-new');
        readerMessages.appendChild(el);
      }
    }

    renderedFingerprints = newFingerprints;

    // Auto-scroll if user was near bottom
    if (nearBottom) {
      readerContainer.scrollTop = readerContainer.scrollHeight;
    }
  }

  // --- View Toggle ---
  function setReaderView(active) {
    isReaderView = active;
    if (active) {
      document.body.classList.add('reader-active');
      document.body.classList.remove('terminal-active');
      viewToggleBtn.textContent = 'Terminal';
      // Immediate scrape+render
      const { lines, richLines } = scrapeBuffer();
      const segments = ActiveParser.parse(lines);
      ReaderRenderer.attachRichLines(segments, lines, richLines);
      renderedFingerprints = [];
      readerMessages.innerHTML = '';
      renderSegments(segments);
      // Scroll to bottom
      readerContainer.scrollTop = readerContainer.scrollHeight;
    } else {
      document.body.classList.add('terminal-active');
      document.body.classList.remove('reader-active');
      viewToggleBtn.textContent = 'Reader';
      fit();
    }
  }

  viewToggleBtn.addEventListener('click', () => {
    setReaderView(!isReaderView);
  });

  // Start in reader view
  setReaderView(true);

  // --- WebSocket ---
  const conn = connectWebSocket(term, {
    onOpen() {
      indicator.classList.add('connected');
      statusText.textContent = 'Connected';
      fit();
    },
    onClose() {
      indicator.classList.remove('connected');
      statusText.textContent = 'Reconnecting...';
    },
    onExit(exitCode) {
      statusText.textContent = `Exited (${exitCode})`;
    },
    onOutput() {
      scheduleScrape();
    },
    onAuthUrl(url, provider) {
      showAuthBanner(url, provider);
    },
  });

  // --- Input bar submit ---
  function submitInput() {
    const text = inputField.value;
    if (text.length === 0) return;
    conn.sendInput(text);
    setTimeout(() => conn.sendInput('\r'), 50);
    inputField.value = '';
    inputField.focus();
  }

  const inputBar = document.getElementById('input-bar');
  inputBar.addEventListener('submit', (e) => {
    e.preventDefault();
    submitInput();
  });

  // --- Quick action buttons ---
  document.querySelectorAll('.action-btn[data-input]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const raw = btn.dataset.input;
      // Interpret escape sequences
      const data = raw
        .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\r/g, '\r')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t');
      conn.sendInput(data);
    });
  });

  // --- Restart button ---
  restartBtn.addEventListener('click', () => {
    term.clear();
    readerMessages.innerHTML = '';
    renderedFingerprints = [];
    lastLineCount = 0;
    outputActive = false;
    streamingIndicator.hidden = true;
    if (activeTimer) { clearTimeout(activeTimer); activeTimer = null; }
    if (quietTimer) { clearTimeout(quietTimer); quietTimer = null; }
    conn.sendRestart(term.cols, term.rows);
    statusText.textContent = 'Restarting...';
  });

  // --- Font size controls ---
  function setTerminalFontSize(size) {
    fontSize = Math.max(8, Math.min(24, size));
    term.options.fontSize = fontSize;
    fit();
  }

  function setReaderFontSize(size) {
    readerFontSize = Math.max(12, Math.min(28, size));
    readerMessages.style.fontSize = readerFontSize + 'px';
    // Update all existing message elements
    document.querySelectorAll('.reader-msg:not(.tool-block):not(.msg-system)').forEach(el => {
      el.style.fontSize = readerFontSize + 'px';
    });
  }

  fontDownBtn.addEventListener('click', () => {
    if (isReaderView) {
      setReaderFontSize(readerFontSize - 1);
    } else {
      setTerminalFontSize(fontSize - 1);
    }
  });

  fontUpBtn.addEventListener('click', () => {
    if (isReaderView) {
      setReaderFontSize(readerFontSize + 1);
    } else {
      setTerminalFontSize(fontSize + 1);
    }
  });

  // --- visualViewport resize (keyboard show/hide) ---
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      // Adjust body height to visible viewport (handles on-screen keyboard)
      document.body.style.height = `${window.visualViewport.height}px`;
      if (!isReaderView) fit();
    });

    window.visualViewport.addEventListener('scroll', () => {
      // Keep content pinned to viewport top
      document.body.style.transform = `translateY(${window.visualViewport.offsetTop}px)`;
    });
  }

  // --- Window resize ---
  window.addEventListener('resize', () => {
    if (!isReaderView) fit();
  });

  // --- Double-tap to scroll to bottom ---
  let lastTap = 0;
  container.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTap < 300) {
      term.scrollToBottom();
    }
    lastTap = now;
  });

  let lastReaderTap = 0;
  readerContainer.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastReaderTap < 300) {
      readerContainer.scrollTop = readerContainer.scrollHeight;
    }
    lastReaderTap = now;
  });

  // Initial fit
  setTimeout(fit, 100);
})();
