/**
 * reader-parser.js — Standalone conversation parser for Claude CLI output.
 *
 * Takes an array of plain-text lines (scraped from xterm.js buffer) and
 * returns an array of structured segments:
 *   { type: 'user'|'assistant'|'tool-call'|'tool-result'|'system', lines: string[] }
 */

// eslint-disable-next-line no-unused-vars
var ReaderParser = (function () {
  'use strict';

  // Known tool names in Claude CLI
  const TOOL_NAMES = [
    'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
    'Task', 'TodoRead', 'TodoWrite', 'NotebookEdit', 'AskUserQuestion',
    'Skill', 'EnterPlanMode', 'ExitPlanMode', 'TaskCreate', 'TaskUpdate',
    'TaskGet', 'TaskList', 'EnterWorktree', 'TaskOutput', 'TaskStop',
  ];

  const TOOL_RE = new RegExp('\\b(' + TOOL_NAMES.join('|') + ')\\b');

  // Markers
  const PROMPT_CHAR = '\u276F';   // ❯
  const BULLET      = '\u25CF';   // ●
  const DIAMOND     = '\u25C6';   // ◆
  const HOOK_BOTTOM = '\u23BF';   // ⎿
  const ASTERISK    = '\u273B';   // ✻

  // Box-drawing characters used in system UI
  const BOX_CHARS = /[\u2500-\u257F\u256D\u256E\u256F\u2570]/;

  /**
   * Test if a line is purely decorative (box-drawing, whitespace, horizontal rules).
   */
  function isDecorativeLine(line) {
    const stripped = line.replace(/[\s\u2500-\u257F\u256D\u256E\u256F\u2570\u2502\u2503│─╭╮╰╯┌┐└┘├┤┬┴┼]/g, '');
    return stripped.length === 0;
  }

  /**
   * Determine the segment type for a given line.
   * Returns { type, toolName? } or null if line is a continuation.
   */
  function classifyLine(line, currentType) {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    // User prompt: ❯ at low indent
    if (trimmed.startsWith(PROMPT_CHAR) && indent <= 3) {
      // Check if it's actually a tool call (has a known tool name after ❯)
      const afterPrompt = trimmed.slice(1).trim();
      if (TOOL_RE.test(afterPrompt) && indent > 0) {
        const match = afterPrompt.match(TOOL_RE);
        return { type: 'tool-call', toolName: match ? match[1] : undefined };
      }
      return { type: 'user' };
    }

    // Tool call: ❯ at higher indent + known tool name
    if (trimmed.startsWith(PROMPT_CHAR) && indent > 3) {
      const afterPrompt = trimmed.slice(1).trim();
      const match = afterPrompt.match(TOOL_RE);
      if (match) {
        return { type: 'tool-call', toolName: match[1] };
      }
    }

    // Tool result: ⎿ marker
    if (trimmed.startsWith(HOOK_BOTTOM)) {
      return { type: 'tool-result' };
    }

    // Assistant response: ● or ◆
    if (trimmed.startsWith(BULLET) || trimmed.startsWith(DIAMOND)) {
      return { type: 'assistant' };
    }

    // Asterisk (✻) starts a system segment only if we're not already in one
    if (trimmed.startsWith(ASTERISK) && currentType !== 'system') {
      return { type: 'system' };
    }

    // Box-drawing lines: only start a new system segment if we're not
    // already in a system segment. Otherwise they're continuations.
    if (BOX_CHARS.test(trimmed) && currentType !== 'system') {
      return { type: 'system' };
    }

    return null; // continuation of current segment
  }

  /**
   * Extract meaningful text from system segment lines.
   * Strips box-drawing borders and decorative characters.
   */
  function extractSystemText(lines) {
    const meaningful = [];
    for (const line of lines) {
      // Strip box-drawing borders from the line
      let cleaned = line
        .replace(/[\u2500-\u257F\u256D\u256E\u256F\u2570\u2502\u2503│─╭╮╰╯┌┐└┘├┤┬┴┼]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleaned.length > 0) {
        meaningful.push(cleaned);
      }
    }
    return meaningful;
  }

  /**
   * Parse an array of text lines into conversation segments.
   * @param {string[]} lines - Plain text lines from terminal buffer.
   * @returns {{ type: string, lines: string[], toolName?: string }[]}
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
        // New segment detected — push the previous one
        if (current) {
          segments.push(current);
        }
        current = {
          type: cls.type,
          lines: [line],
        };
        if (cls.toolName) current.toolName = cls.toolName;
      } else {
        // Continuation of the current segment
        if (current) {
          current.lines.push(line);
        } else {
          // Lines before any recognized marker → system
          current = { type: 'system', lines: [line] };
        }
      }
    }

    // Push last segment
    if (current) {
      segments.push(current);
    }

    // Filter out empty user prompts (bare ❯ with no text = user still typing)
    return segments.filter(seg => {
      if (seg.type !== 'user') return true;
      const text = seg.lines
        .map(l => l.replace(/^\s*\u276F\s*/, ''))
        .join('')
        .trim();
      return text.length > 0;
    });
  }

  return { parse, classifyLine, extractSystemText };
})();
