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

  // --- Buffer Scraper ---
  let lastLineCount = 0;
  let scrapeTimer = null;

  function scrapeBuffer() {
    const buf = term.buffer.active;
    const lines = [];
    const totalRows = buf.length;
    for (let i = 0; i < totalRows; i++) {
      const line = buf.getLine(i);
      if (line) {
        lines.push(line.translateToString());
      }
    }
    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
    const changed = lines.length !== lastLineCount;
    lastLineCount = lines.length;
    return { lines, changed };
  }

  function scheduleScrape() {
    if (!isReaderView) return;
    if (scrapeTimer) clearTimeout(scrapeTimer);
    scrapeTimer = setTimeout(() => {
      const { lines, changed } = scrapeBuffer();
      if (changed || lines.length > 0) {
        const segments = ActiveParser.parse(lines);
        renderSegments(segments);
      }
    }, 150);
  }

  // --- Renderer ---
  let renderedSegmentCount = 0;
  let lastFirstSegmentLine = '';

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function formatAssistantText(lines) {
    let text = lines.join('\n');
    // Strip leading marker characters (● ◆) and whitespace
    text = text.replace(/^[\s]*[\u25CF\u25C6]\s*/, '');
    text = escapeHtml(text);
    // Inline code: `code`
    text = text.replace(/`([^`]+)`/g, '<span class="reader-inline-code">$1</span>');
    // Bold: **text** or __text__
    text = text.replace(/\*\*([^*]+)\*\*/g, '<span class="reader-bold">$1</span>');
    text = text.replace(/__([^_]+)__/g, '<span class="reader-bold">$1</span>');
    return text;
  }

  function createSegmentElement(segment) {
    const el = document.createElement('div');
    el.className = 'reader-msg';

    switch (segment.type) {
      case 'user': {
        el.classList.add('msg-user');
        const label = document.createElement('span');
        label.className = 'msg-label';
        label.textContent = 'You';
        const content = document.createElement('div');
        content.className = 'msg-content';
        // Strip the ❯ prompt character
        const userText = segment.lines
          .map(l => l.replace(/^\s*\u276F\s*/, ''))
          .join('\n')
          .trim();
        content.textContent = userText;
        el.appendChild(label);
        el.appendChild(content);
        break;
      }

      case 'assistant': {
        el.classList.add('msg-assistant');
        const content = document.createElement('div');
        content.className = 'msg-content';
        content.innerHTML = formatAssistantText(segment.lines);
        el.appendChild(content);
        break;
      }

      case 'tool-call':
      case 'tool-result': {
        el.classList.add('tool-block');
        el.style.padding = '0';
        // Header
        const header = document.createElement('div');
        header.className = 'tool-header';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'tool-name';
        if (segment.type === 'tool-result') {
          nameSpan.classList.add('tool-result-label');
          nameSpan.textContent = 'Result';
        } else {
          nameSpan.textContent = segment.toolName || 'Tool';
        }
        const copyBtn = document.createElement('button');
        copyBtn.className = 'tool-copy-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', () => {
          const bodyText = body.textContent;
          navigator.clipboard.writeText(bodyText).then(() => {
            copyBtn.textContent = 'Copied!';
            setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
          }).catch(() => {
            copyBtn.textContent = 'Failed';
            setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
          });
        });
        header.appendChild(nameSpan);
        header.appendChild(copyBtn);
        // Body
        const body = document.createElement('div');
        body.className = 'tool-body';
        // Strip leading marker characters
        const toolLines = segment.lines.map(l =>
          l.replace(/^\s*[\u276F\u23BF]\s*/, '')
        );
        // Remove first line if it's just the tool name
        if (toolLines.length > 0 && segment.toolName &&
            toolLines[0].trim().startsWith(segment.toolName)) {
          toolLines.shift();
        }
        body.textContent = toolLines.join('\n').trim();
        el.appendChild(header);
        el.appendChild(body);
        break;
      }

      case 'system':
      default: {
        // Extract meaningful text, strip box-drawing decorations
        const meaningful = ActiveParser.extractSystemText(segment.lines);
        if (meaningful.length === 0) {
          return null;
        }
        const fullText = meaningful.join(' ');

        // Detect CLI welcome banners
        const claudeMatch = mode === 'claude' && fullText.match(/Claude Code v([\d.]+)/);
        const copilotMatch = mode === 'copilot' && fullText.match(/GitHub Copilot v([\d.]+)/);
        const welcomeMatch2 = claudeMatch || copilotMatch;
        if (welcomeMatch2) {
          el.classList.add('msg-welcome');
          el.innerHTML = '';
          const header = document.createElement('div');
          header.className = 'welcome-header';
          if (claudeMatch) {
            header.innerHTML = '<span class="welcome-icon">\u273B</span> Claude Code <span class="welcome-version">v' + escapeHtml(claudeMatch[1]) + '</span>';
          } else {
            header.innerHTML = '<span class="welcome-icon">\u2B22</span> GitHub Copilot <span class="welcome-version">v' + escapeHtml(copilotMatch[1]) + '</span>';
          }
          el.appendChild(header);
          // Extract useful info lines
          const infoItems = [];
          if (claudeMatch) {
            const modelMatch = fullText.match(/(Opus|Sonnet|Haiku)\s+[\d.]+\s*\([^)]*\)/);
            if (modelMatch) infoItems.push(modelMatch[0]);
            const welcomeBack = fullText.match(/Welcome back \w+!/);
            if (welcomeBack) infoItems.push(welcomeBack[0]);
          }
          const pathMatch = fullText.match(/(\/home\/\S+|\/Users\/\S+|~\/\S+)/);
          if (pathMatch) infoItems.push(pathMatch[0]);
          const checkMistakes = fullText.match(/Check for mistakes/);
          if (checkMistakes) infoItems.push('AI · Check for mistakes');
          if (infoItems.length > 0) {
            const info = document.createElement('div');
            info.className = 'welcome-info';
            info.textContent = infoItems.join(' · ');
            el.appendChild(info);
          }
          break;
        }

        // Regular system message — compact
        el.classList.add('msg-system');
        el.textContent = meaningful.join(' · ');
        break;
      }
    }

    return el;
  }

  function renderSegments(segments) {
    if (!segments || segments.length === 0) return;

    // Check if user is near bottom for auto-scroll
    const nearBottom = readerContainer.scrollHeight - readerContainer.scrollTop - readerContainer.clientHeight < 80;

    // Detect if content changed fundamentally (e.g. trust prompt → welcome banner)
    // by checking if the first segment's content differs from what we rendered.
    const firstLine = segments[0]?.lines?.[0] || '';
    const contentChanged = firstLine !== lastFirstSegmentLine;
    lastFirstSegmentLine = firstLine;

    if (segments.length < renderedSegmentCount || (contentChanged && renderedSegmentCount > 0)) {
      // Terminal content was rewritten or cleared — full rebuild
      readerMessages.innerHTML = '';
      renderedSegmentCount = 0;
    }

    // Re-render last existing segment (handles streaming updates)
    if (renderedSegmentCount > 0 && readerMessages.lastElementChild) {
      const lastIdx = renderedSegmentCount - 1;
      if (lastIdx < segments.length) {
        const updatedEl = createSegmentElement(segments[lastIdx]);
        if (updatedEl) {
          readerMessages.replaceChild(updatedEl, readerMessages.lastElementChild);
        }
      }
    }

    // Append new segments
    for (let i = renderedSegmentCount; i < segments.length; i++) {
      const el = createSegmentElement(segments[i]);
      if (el) readerMessages.appendChild(el);
    }

    renderedSegmentCount = segments.length;

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
      const { lines } = scrapeBuffer();
      const segments = ActiveParser.parse(lines);
      renderedSegmentCount = 0;
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
    renderedSegmentCount = 0;
    lastLineCount = 0;
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
