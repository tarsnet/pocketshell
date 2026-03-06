/**
 * ReaderRenderer — shared rendering utilities for the PocketShell reader view.
 * Used by mobile.js and reader-test.html.
 */
var ReaderRenderer = (function () {
  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // --- Color-aware buffer scraping ---

  // Build palette map from THEME (defined in shared.js)
  var _palette = null;
  function getPalette() {
    if (_palette) return _palette;
    if (typeof THEME === 'undefined') return null;
    _palette = [
      THEME.black, THEME.red, THEME.green, THEME.yellow,
      THEME.blue, THEME.magenta, THEME.cyan, THEME.white,
      THEME.brightBlack, THEME.brightRed, THEME.brightGreen, THEME.brightYellow,
      THEME.brightBlue, THEME.brightMagenta, THEME.brightCyan, THEME.brightWhite,
    ];
    return _palette;
  }

  /**
   * Scrape a single buffer line into HTML with inline color spans.
   */
  function scrapeLineRich(bufferLine, cols) {
    var palette = getPalette();
    var html = '';
    var prevColor = null;
    var prevBold = false;
    var spanOpen = false;

    for (var col = 0; col < cols; col++) {
      var cell = bufferLine.getCell(col);
      if (!cell) break;

      var chars = cell.getChars();
      if (chars === '' && cell.getWidth() === 0) continue; // wide char continuation
      if (chars === '') chars = ' '; // space cell

      var fgMode = cell.getFgColorMode();
      var fg = cell.getFgColor();
      var bold = !!cell.isBold();

      // Resolve palette index → hex
      var color = null;
      if (palette) {
        if (fgMode === 1 && fg >= 0 && fg < 16) {
          color = palette[fg];
        } else if (fgMode === 2 && fg >= 0 && fg < 16) {
          color = palette[fg];
        }
      }

      if (color !== prevColor || bold !== prevBold) {
        if (spanOpen) { html += '</span>'; spanOpen = false; }
        var styles = [];
        if (color) styles.push('color:' + color);
        if (bold) styles.push('font-weight:700');
        if (styles.length > 0) {
          html += '<span style="' + styles.join(';') + '">';
          spanOpen = true;
        }
        prevColor = color;
        prevBold = bold;
      }

      html += escapeHtml(chars);
    }

    if (spanOpen) html += '</span>';
    // Trim trailing whitespace (plain spaces beyond content)
    html = html.replace(/( +)(<\/span>)?$/, '$2');
    html = html.replace(/ +$/, '');
    return html;
  }

  /**
   * Scrape the entire xterm buffer, returning both plain and rich (colored) lines.
   * @param {Terminal} term - xterm.js Terminal instance
   * @returns {{ lines: string[], richLines: string[] }}
   */
  function scrapeBufferRich(term) {
    var buf = term.buffer.active;
    var lines = [];
    var richLines = [];
    var cols = term.cols;

    for (var i = 0; i < buf.length; i++) {
      var line = buf.getLine(i);
      if (line) {
        lines.push(line.translateToString());
        richLines.push(scrapeLineRich(line, cols));
      }
    }
    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
      richLines.pop();
    }
    return { lines: lines, richLines: richLines };
  }

  /**
   * Attach richLines from the buffer to parsed segments by matching line positions.
   * @param {Object[]} segments - parsed segments with .lines arrays
   * @param {string[]} allPlain - all plain lines from scrapeBufferRich
   * @param {string[]} allRich  - all rich lines from scrapeBufferRich
   */
  function attachRichLines(segments, allPlain, allRich) {
    var cursor = 0;
    for (var s = 0; s < segments.length; s++) {
      var seg = segments[s];
      if (!seg.lines || seg.lines.length === 0) continue;
      // Find where this segment's first line appears, scanning forward
      var found = false;
      for (var j = cursor; j < allPlain.length; j++) {
        if (allPlain[j] === seg.lines[0]) {
          seg.richLines = allRich.slice(j, j + seg.lines.length);
          cursor = j + seg.lines.length;
          found = true;
          break;
        }
      }
      if (!found) seg.richLines = null;
    }
  }

  // --- Markdown formatting (fallback when richLines not available) ---

  /**
   * Format assistant text with full markdown support.
   * Processing order: code blocks first, then line-by-line (headings, lists),
   * then inline formatting (bold, inline code, links).
   */
  function formatAssistantText(lines) {
    var text = lines.join('\n');
    // Strip leading marker characters (● ◆) and whitespace
    text = text.replace(/^[\s]*[\u25CF\u25C6]\s*/, '');

    // --- Phase 1: Extract fenced code blocks ---
    var codeBlocks = [];
    text = text.replace(/```(\w*)\n([\s\S]*?)```/g, function (match, lang, code) {
      var idx = codeBlocks.length;
      codeBlocks.push(
        '<pre class="reader-code-block"><code>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre>'
      );
      return '\x00CODEBLOCK_' + idx + '\x00';
    });

    // --- Phase 2: Line-by-line processing (headings, lists) ---
    var outputLines = [];
    var listBuffer = [];

    function flushList() {
      if (listBuffer.length === 0) return;
      var tag = listBuffer[listBuffer.length - 1].type;
      var html = '<' + tag + ' class="reader-list">';
      for (var i = 0; i < listBuffer.length; i++) {
        html += '<li>' + applyInline(listBuffer[i].text) + '</li>';
      }
      html += '</' + tag + '>';
      outputLines.push(html);
      listBuffer = [];
    }

    var rawLines = text.split('\n');
    for (var i = 0; i < rawLines.length; i++) {
      var line = rawLines[i];

      if (/^\x00CODEBLOCK_\d+\x00$/.test(line)) {
        flushList();
        outputLines.push(line);
        continue;
      }

      var headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
      if (headingMatch) {
        flushList();
        var level = headingMatch[1].length;
        var hClass = 'reader-heading reader-h' + level;
        outputLines.push('<div class="' + hClass + '">' + applyInline(escapeHtml(headingMatch[2])) + '</div>');
        continue;
      }

      var ulMatch = line.match(/^[\s]*[-*]\s+(.+)$/);
      if (ulMatch) {
        if (listBuffer.length > 0 && listBuffer[listBuffer.length - 1].type !== 'ul') flushList();
        listBuffer.push({ type: 'ul', text: escapeHtml(ulMatch[1]) });
        continue;
      }

      var olMatch = line.match(/^[\s]*\d+\.\s+(.+)$/);
      if (olMatch) {
        if (listBuffer.length > 0 && listBuffer[listBuffer.length - 1].type !== 'ol') flushList();
        listBuffer.push({ type: 'ol', text: escapeHtml(olMatch[1]) });
        continue;
      }

      flushList();
      outputLines.push(applyInline(escapeHtml(line)));
    }
    flushList();

    var result = outputLines.join('\n');
    for (var j = 0; j < codeBlocks.length; j++) {
      result = result.replace('\x00CODEBLOCK_' + j + '\x00', codeBlocks[j]);
    }
    return result;
  }

  function applyInline(text) {
    text = text.replace(/`([^`]+)`/g, '<span class="reader-inline-code">$1</span>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<span class="reader-bold">$1</span>');
    text = text.replace(/__([^_]+)__/g, '<span class="reader-bold">$1</span>');
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="reader-link" href="$2" target="_blank" rel="noopener">$1</a>');
    return text;
  }

  // --- Rendering ---

  /**
   * Format assistant rich lines (with terminal colors) into display HTML.
   * Strips the leading marker character (● ◆) and joins lines.
   */
  function formatAssistantRich(richLines) {
    var html = richLines.join('\n');
    // Strip leading marker — may be bare or wrapped in a span
    html = html.replace(/^[\s]*(?:<span[^>]*>[\s]*)?[\u25CF\u25C6](?:[\s]*<\/span>)?[\s]*/, '');
    return html;
  }

  /**
   * Create a DOM element for a parsed segment.
   * @param {Object} segment - { type, lines, toolName, richLines? }
   * @param {Object} parser  - parser module (ReaderParser/TerminalParser) for extractSystemText
   * @param {string} mode    - 'claude'|'copilot'|'terminal'
   */
  function createSegmentElement(segment, parser, mode) {
    var el = document.createElement('div');
    el.className = 'reader-msg';

    switch (segment.type) {
      case 'user': {
        el.classList.add('msg-user');
        var label = document.createElement('span');
        label.className = 'msg-label';
        label.textContent = 'You';
        var content = document.createElement('div');
        content.className = 'msg-content';
        var userText = segment.lines
          .map(function (l) { return l.replace(/^\s*\u276F\s*/, ''); })
          .join('\n')
          .trim();
        content.textContent = userText;
        el.appendChild(label);
        el.appendChild(content);
        break;
      }

      case 'assistant': {
        el.classList.add('msg-assistant');
        var content = document.createElement('div');
        content.className = 'msg-content';
        if (segment.richLines) {
          content.innerHTML = formatAssistantRich(segment.richLines);
        } else {
          content.innerHTML = formatAssistantText(segment.lines);
        }
        el.appendChild(content);
        break;
      }

      case 'tool-call':
      case 'tool-result': {
        el.classList.add('tool-block');
        el.style.padding = '0';
        var header = document.createElement('div');
        header.className = 'tool-header';
        var nameSpan = document.createElement('span');
        nameSpan.className = 'tool-name';
        if (segment.type === 'tool-result') {
          nameSpan.classList.add('tool-result-label');
          nameSpan.textContent = 'Result';
        } else {
          nameSpan.textContent = segment.toolName || 'Tool';
        }
        var copyBtn = document.createElement('button');
        copyBtn.className = 'tool-copy-btn';
        copyBtn.textContent = 'Copy';
        var body = document.createElement('div');
        body.className = 'tool-body';
        copyBtn.addEventListener('click', function () {
          var bodyText = body.textContent;
          navigator.clipboard.writeText(bodyText).then(function () {
            copyBtn.textContent = 'Copied!';
            setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1500);
          }).catch(function () {
            copyBtn.textContent = 'Failed';
            setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1500);
          });
        });
        header.appendChild(nameSpan);
        header.appendChild(copyBtn);
        var toolLines = segment.lines.map(function (l) {
          return l.replace(/^\s*[\u276F\u23BF]\s*/, '');
        });
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
        var meaningful = parser.extractSystemText(segment.lines);
        if (meaningful.length === 0) return null;
        var fullText = meaningful.join(' ');

        var claudeMatch = mode === 'claude' && fullText.match(/Claude Code v([\d.]+)/);
        var copilotMatch = mode === 'copilot' && fullText.match(/GitHub Copilot v([\d.]+)/);
        var welcomeMatch = claudeMatch || copilotMatch;
        if (welcomeMatch) {
          el.classList.add('msg-welcome');
          el.innerHTML = '';
          var h = document.createElement('div');
          h.className = 'welcome-header';
          if (claudeMatch) {
            h.innerHTML = '<span class="welcome-icon">\u273B</span> Claude Code <span class="welcome-version">v' + escapeHtml(claudeMatch[1]) + '</span>';
          } else {
            h.innerHTML = '<span class="welcome-icon">\u2B22</span> GitHub Copilot <span class="welcome-version">v' + escapeHtml(copilotMatch[1]) + '</span>';
          }
          el.appendChild(h);
          var infoItems = [];
          if (claudeMatch) {
            var modelMatch = fullText.match(/(Opus|Sonnet|Haiku)\s+[\d.]+\s*\([^)]*\)/);
            if (modelMatch) infoItems.push(modelMatch[0]);
            var welcomeBack = fullText.match(/Welcome back \w+!/);
            if (welcomeBack) infoItems.push(welcomeBack[0]);
          }
          var pathMatch = fullText.match(/(\/home\/\S+|\/Users\/\S+|~\/\S+)/);
          if (pathMatch) infoItems.push(pathMatch[0]);
          var checkMistakes = fullText.match(/Check for mistakes/);
          if (checkMistakes) infoItems.push('AI \u00B7 Check for mistakes');
          if (infoItems.length > 0) {
            var info = document.createElement('div');
            info.className = 'welcome-info';
            info.textContent = infoItems.join(' \u00B7 ');
            el.appendChild(info);
          }
          break;
        }

        el.classList.add('msg-system');
        el.textContent = meaningful.join(' \u00B7 ');
        break;
      }
    }

    return el;
  }

  return {
    escapeHtml: escapeHtml,
    formatAssistantText: formatAssistantText,
    createSegmentElement: createSegmentElement,
    scrapeBufferRich: scrapeBufferRich,
    attachRichLines: attachRichLines,
  };
})();
