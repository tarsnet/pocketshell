/**
 * terminal-parser.js — Conversation parser for plain terminal/bash output.
 *
 * Same interface as ReaderParser: { parse, classifyLine, extractSystemText }
 * Segments by shell prompts: prompt lines are 'user', output is 'assistant'.
 */

// eslint-disable-next-line no-unused-vars
var TerminalParser = (function () {
  'use strict';

  // Common shell prompt patterns
  const PROMPT_RE = /^(\S+@\S+[:\s]|.*[$#%]\s)/;

  /**
   * Determine the segment type for a given line.
   */
  function classifyLine(line, currentType) {
    const trimmed = line.trimStart();
    if (trimmed.length === 0) return null;

    // Shell prompt detected → user segment
    if (PROMPT_RE.test(trimmed)) {
      return { type: 'user' };
    }

    // If we were in a user segment and this line doesn't match a prompt,
    // it's command output → assistant
    if (currentType === 'user') {
      return { type: 'assistant' };
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
      } else {
        if (current) {
          current.lines.push(line);
        } else {
          // Lines before any recognized prompt → assistant (command output)
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
