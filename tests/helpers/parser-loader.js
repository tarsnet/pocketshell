/**
 * parser-loader.js — Loads browser IIFE parsers into Node for testing.
 *
 * The parsers (ReaderParser, CopilotParser, TerminalParser) are written as
 * browser IIFEs that assign to `var ParserName = (function() { ... })()`.
 * This helper reads the file, extracts the var name, and evaluates it in
 * a Node context so tests can call the parser functions directly.
 */

const fs = require('fs');
const path = require('path');

function loadParser(filename) {
  const filePath = path.join(__dirname, '..', '..', 'public', filename);
  const source = fs.readFileSync(filePath, 'utf8');

  // Extract the var name: `var ReaderParser = (function () {`
  const match = source.match(/^var\s+(\w+)\s*=/m);
  if (!match) {
    throw new Error(`Could not find var declaration in ${filename}`);
  }
  const varName = match[1];

  // Evaluate the IIFE and return the parser object
  const fn = new Function(`${source}; return ${varName};`);
  return fn();
}

module.exports = { loadParser };
