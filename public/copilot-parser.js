/**
 * copilot-parser.js — Conversation parser for GitHub Copilot CLI output.
 *
 * Same interface as ReaderParser: { parse, classifyLine, extractSystemText }
 */

// eslint-disable-next-line no-unused-vars
var CopilotParser = (function () {
  'use strict';

  /**
   * Determine the segment type for a given line.
   */
  function classifyLine(line, currentType) {
    const trimmed = line.trimStart();

    // User prompt: lines starting with > or ?
    if (/^[>?]\s/.test(trimmed)) {
      return { type: 'user' };
    }

    // Code block fence (``` starts/ends a tool-call block)
    if (trimmed.startsWith('```')) {
      if (currentType === 'tool-call') {
        // Closing fence — switch to tool-result for content after
        return { type: 'tool-result' };
      }
      return { type: 'tool-call', toolName: 'Code' };
    }

    return null; // continuation
  }

  /**
   * Extract meaningful text from system segment lines.
   */
  function extractSystemText(lines) {
    const meaningful = [];
    for (const line of lines) {
      const cleaned = line.replace(/\s+/g, ' ').trim();
      if (cleaned.length > 0) {
        meaningful.push(cleaned);
      }
    }
    return meaningful;
  }

  /**
   * Parse an array of text lines into conversation segments.
   */
  function parse(lines) {
    const segments = [];
    let current = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Skip fully empty lines at the very start
      if (!current && line.trim() === '') continue;

      const currentType = current ? current.type : null;
      const cls = classifyLine(line, currentType);

      if (cls) {
        if (current) {
          segments.push(current);
        }
        current = {
          type: cls.type,
          lines: [line],
        };
        if (cls.toolName) current.toolName = cls.toolName;
      } else {
        if (current) {
          current.lines.push(line);
        } else {
          // Lines before any recognized marker -> assistant
          current = { type: 'assistant', lines: [line] };
        }
      }
    }

    if (current) {
      segments.push(current);
    }

    return segments;
  }

  return { parse, classifyLine, extractSystemText };
})();
