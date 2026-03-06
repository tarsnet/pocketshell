const { loadParser } = require('./helpers/parser-loader');

const ReaderParser = loadParser('reader-parser.js');
const CopilotParser = loadParser('copilot-parser.js');
const TerminalParser = loadParser('terminal-parser.js');

// --- ReaderParser ---

describe('ReaderParser', () => {
  describe('classifyLine', () => {
    test('user prompt ❯ at low indent', () => {
      const result = ReaderParser.classifyLine('\u276F hello', null);
      expect(result).toEqual({ type: 'user' });
    });

    test('tool call ❯ at high indent with known tool', () => {
      const result = ReaderParser.classifyLine('      \u276F Read file.js', null);
      expect(result).toEqual({ type: 'tool-call', toolName: 'Read' });
    });

    test('tool result ⎿ marker', () => {
      const result = ReaderParser.classifyLine('  \u23BF output here', null);
      expect(result).toEqual({ type: 'tool-result' });
    });

    test('assistant ● marker', () => {
      const result = ReaderParser.classifyLine('  \u25CF some response', null);
      expect(result).toEqual({ type: 'assistant' });
    });

    test('assistant ◆ marker', () => {
      const result = ReaderParser.classifyLine('  \u25C6 some response', null);
      expect(result).toEqual({ type: 'assistant' });
    });

    test('system ✻ marker when not in system', () => {
      const result = ReaderParser.classifyLine('  \u273B system info', null);
      expect(result).toEqual({ type: 'system' });
    });

    test('✻ continues system segment', () => {
      const result = ReaderParser.classifyLine('  \u273B more info', 'system');
      expect(result).toBeNull();
    });

    test('box-drawing starts system segment', () => {
      const result = ReaderParser.classifyLine('  \u2500\u2500\u2500', null);
      expect(result).toEqual({ type: 'system' });
    });

    test('box-drawing continues system segment', () => {
      const result = ReaderParser.classifyLine('  \u2500\u2500\u2500', 'system');
      expect(result).toBeNull();
    });

    test('plain text returns null (continuation)', () => {
      const result = ReaderParser.classifyLine('  just some text', 'assistant');
      expect(result).toBeNull();
    });

    test('tool call with ❯ at indent > 0 but <= 3 with tool name', () => {
      const result = ReaderParser.classifyLine(' \u276F Bash echo hello', null);
      expect(result).toEqual({ type: 'tool-call', toolName: 'Bash' });
    });
  });

  describe('extractSystemText', () => {
    test('strips box-drawing characters', () => {
      const lines = ['\u2500\u2500 Hello \u2500\u2500', '\u2502 World \u2502'];
      const result = ReaderParser.extractSystemText(lines);
      expect(result).toEqual(['Hello', 'World']);
    });

    test('skips empty lines after stripping', () => {
      const lines = ['\u2500\u2500\u2500\u2500', 'Content'];
      const result = ReaderParser.extractSystemText(lines);
      expect(result).toEqual(['Content']);
    });
  });

  describe('parse', () => {
    test('empty input returns empty array', () => {
      expect(ReaderParser.parse([])).toEqual([]);
    });

    test('skips leading empty lines', () => {
      const segments = ReaderParser.parse(['', '', '\u276F hello']);
      expect(segments).toHaveLength(1);
      expect(segments[0].type).toBe('user');
    });

    test('parses user then assistant', () => {
      const segments = ReaderParser.parse([
        '\u276F what is 2+2?',
        '  \u25CF 2+2 is 4.',
        '  The answer is four.',
      ]);
      expect(segments).toHaveLength(2);
      expect(segments[0].type).toBe('user');
      expect(segments[1].type).toBe('assistant');
      expect(segments[1].lines).toHaveLength(2);
    });

    test('parses tool call and result', () => {
      const segments = ReaderParser.parse([
        '  \u25CF Let me read that file.',
        '      \u276F Read file.js',
        '      \u23BF contents here',
      ]);
      expect(segments).toHaveLength(3);
      expect(segments[0].type).toBe('assistant');
      expect(segments[1].type).toBe('tool-call');
      expect(segments[1].toolName).toBe('Read');
      expect(segments[2].type).toBe('tool-result');
    });

    test('lines before any marker become system', () => {
      const segments = ReaderParser.parse(['some random text', 'more text']);
      expect(segments).toHaveLength(1);
      expect(segments[0].type).toBe('system');
    });

    test('bare ❯ prompt with no text is filtered out', () => {
      const segments = ReaderParser.parse(['\u276F']);
      expect(segments).toHaveLength(0);
    });

    test('bare ❯ with only whitespace is filtered out', () => {
      const segments = ReaderParser.parse(['\u276F   ']);
      expect(segments).toHaveLength(0);
    });

    test('❯ with text is kept', () => {
      const segments = ReaderParser.parse(['\u276F hello']);
      expect(segments).toHaveLength(1);
      expect(segments[0].type).toBe('user');
    });

    test('bare ❯ among other segments is filtered out', () => {
      const segments = ReaderParser.parse([
        '  \u25CF Some assistant text.',
        '\u276F',
      ]);
      expect(segments).toHaveLength(1);
      expect(segments[0].type).toBe('assistant');
    });
  });
});

// --- CopilotParser ---

describe('CopilotParser', () => {
  describe('classifyLine', () => {
    test('user prompt with >', () => {
      expect(CopilotParser.classifyLine('> hello', null)).toEqual({ type: 'user' });
    });

    test('user prompt with ?', () => {
      expect(CopilotParser.classifyLine('? hello', null)).toEqual({ type: 'user' });
    });

    test('code block fence opens tool-call', () => {
      expect(CopilotParser.classifyLine('```js', null)).toEqual({ type: 'tool-call', toolName: 'Code' });
    });

    test('code block fence closes tool-call', () => {
      expect(CopilotParser.classifyLine('```', 'tool-call')).toEqual({ type: 'tool-result' });
    });

    test('plain text returns null', () => {
      expect(CopilotParser.classifyLine('some text', 'assistant')).toBeNull();
    });
  });

  describe('extractSystemText', () => {
    test('collapses whitespace and trims', () => {
      const result = CopilotParser.extractSystemText(['  hello   world  ']);
      expect(result).toEqual(['hello world']);
    });

    test('skips empty lines', () => {
      const result = CopilotParser.extractSystemText(['', '  ', 'content']);
      expect(result).toEqual(['content']);
    });
  });

  describe('parse', () => {
    test('empty input returns empty array', () => {
      expect(CopilotParser.parse([])).toEqual([]);
    });

    test('plain text after user prompt is continuation (no auto-switch)', () => {
      const segments = CopilotParser.parse([
        '> how do I list files?',
        'You can use ls to list files.',
      ]);
      // CopilotParser doesn't auto-switch from user to assistant for plain text
      expect(segments).toHaveLength(1);
      expect(segments[0].type).toBe('user');
      expect(segments[0].lines).toHaveLength(2);
    });

    test('parses code block as tool-call', () => {
      const segments = CopilotParser.parse([
        '> show me code',
        'Here is the code:',
        '```js',
        'console.log("hi")',
        '```',
      ]);
      expect(segments.length).toBeGreaterThanOrEqual(3);
      const toolCall = segments.find(s => s.type === 'tool-call');
      expect(toolCall).toBeDefined();
      expect(toolCall.toolName).toBe('Code');
    });

    test('lines before any marker become assistant', () => {
      const segments = CopilotParser.parse(['some output']);
      expect(segments).toHaveLength(1);
      expect(segments[0].type).toBe('assistant');
    });
  });
});

// --- TerminalParser ---

describe('TerminalParser', () => {
  describe('classifyLine', () => {
    test('shell prompt user@host: detected as user', () => {
      expect(TerminalParser.classifyLine('user@host:~$ ', null)).toEqual({ type: 'user' });
    });

    test('dollar prompt detected as user', () => {
      expect(TerminalParser.classifyLine('$ ls -la', null)).toEqual({ type: 'user' });
    });

    test('hash prompt detected as user', () => {
      expect(TerminalParser.classifyLine('root@server:~# whoami', null)).toEqual({ type: 'user' });
    });

    test('output after user becomes assistant', () => {
      expect(TerminalParser.classifyLine('total 42', 'user')).toEqual({ type: 'assistant' });
    });

    test('empty line returns null', () => {
      expect(TerminalParser.classifyLine('', null)).toBeNull();
    });

    test('continuation in assistant returns null', () => {
      expect(TerminalParser.classifyLine('drwxr-xr-x', 'assistant')).toBeNull();
    });
  });

  describe('extractSystemText', () => {
    test('collapses whitespace and trims', () => {
      const result = TerminalParser.extractSystemText(['  hello   world  ']);
      expect(result).toEqual(['hello world']);
    });
  });

  describe('parse', () => {
    test('empty input returns empty array', () => {
      expect(TerminalParser.parse([])).toEqual([]);
    });

    test('parses prompt and output', () => {
      const segments = TerminalParser.parse([
        'user@host:~$ ls',
        'file1.txt',
        'file2.txt',
      ]);
      expect(segments).toHaveLength(2);
      expect(segments[0].type).toBe('user');
      expect(segments[1].type).toBe('assistant');
      expect(segments[1].lines).toHaveLength(2);
    });

    test('multiple commands create multiple segments', () => {
      const segments = TerminalParser.parse([
        '$ echo hello',
        'hello',
        '$ echo world',
        'world',
      ]);
      expect(segments).toHaveLength(4);
      expect(segments[0].type).toBe('user');
      expect(segments[1].type).toBe('assistant');
      expect(segments[2].type).toBe('user');
      expect(segments[3].type).toBe('assistant');
    });

    test('lines before any prompt become assistant', () => {
      const segments = TerminalParser.parse(['some output line']);
      expect(segments).toHaveLength(1);
      expect(segments[0].type).toBe('assistant');
    });
  });
});
