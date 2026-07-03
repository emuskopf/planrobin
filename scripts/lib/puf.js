'use strict';
// Shared streaming utilities for CMS Prescription Drug Plan PUF files.
//
// These files are pipe-delimited, with a header row as the first line (verified
// against the 2026-Q1 refresh — see README "File layout verification"). Some of
// them are large (the basic formulary is ~58 MB uncompressed), so EVERYTHING here
// streams line-by-line via readline. Nothing loads a whole file into memory.

const fs = require('fs');
const readline = require('readline');

// Yields one object per data row, keyed by the file's own header names.
// The header is taken from the literal first line of the file, never assumed.
async function* streamRows(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header = null;
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (line === '') continue;
    const cols = line.split('|');
    if (header === null) {
      header = cols;
      continue;
    }
    const row = {};
    for (let i = 0; i < header.length; i++) {
      row[header[i]] = cols[i] !== undefined ? cols[i] : '';
    }
    // __line is the 1-based line number in the source file for traceability.
    row.__line = lineNo;
    yield row;
  }
}

// Reads just the header line of a file (for verification / documentation).
async function readHeader(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    rl.close();
    stream.destroy();
    return line.split('|');
  }
  return [];
}

module.exports = { streamRows, readHeader };
