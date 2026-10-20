#!/usr/bin/env node
/*!
 * English-only audit. Run: node tools/audit-english.js
 *
 * The app must be English. This project keeps its existing English documentation convention: code, comments, user-visible strings, README files,
 * research notes, plans, test descriptions and the release manifest. Translated text can quietly come
 * back (a copy-paste, a new line, a stale reference), so this tool is the check that runs over the
 * whole tree instead of trusting a one-time review.
 *
 * Three passes, in rising strictness:
 *   1. German letters (a-umlaut, o-umlaut, u-umlaut, sharp s) anywhere - these never belong in this
 *      project's text, so one hit fails the audit.
 *   2. a curated list of German words, matched case-insensitively with word boundaries. The list avoids
 *      English homographs on purpose (the article "die", "man", "war", "also", "in", "an", "so", "am")
 *      and keeps every entry a word no English sentence would contain - a false alarm would train
 *      everyone to ignore the tool. Case-insensitive on purpose: a stale German heading is capitalized,
 *      and a case-sensitive pass walked past exactly such a heading once.
 *   3. the SHIPPED files (extension/) additionally have to be pure printable ASCII, because the XPI is
 *      what a reviewer and a user see; the development tree may use typographic characters in prose.
 *
 * Reference material is not prose: protocol field names, client values and recorded measurements keep
 * their original spelling. Those live in code, not in sentences, and they are ASCII, so the passes above
 * do not flag them.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = ['.git', 'dist', 'node_modules'];
const TEXT_EXTENSIONS = ['.js', '.json', '.md', '.html', '.sh', '.txt', '.css'];

const GERMAN_LETTERS = /[\u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00df]/;
// audit-words:start
// The scanner's own list: these lines are exempt from the word pass (they ARE the words), and the
// German-letter pass still applies to them, so the list itself stays free of umlauts.
const GERMAN_WORDS = [
  'und', 'nicht', 'wird', 'werden', 'eine', 'einen', 'einer', 'eines', 'ist', 'sind', 'kann',
  'm\u00fcssen', 'muss', 'wenn', 'dass', 'diese', 'dieser', 'dieses', 'sich', 'auch', 'noch', 'nur',
  'schon', 'wieder', 'beim', 'vom', 'zum', 'zur', 'w\u00e4hrend', 'ohne', 'gegen', 'zwischen', 'sowie',
  'damit', 'jedoch', 'deshalb', 'wiedergabe', 'pr\u00fcfung', 'ergebnis', 'datei', 'ordner',
  'einstellung', 'anzeige', 'hinweis', 'meldung', 'zustand', 'umschalten', 'messung',
  '\u00e4nderung', 'beschreibung', 'anleitung', 'benutzer', 'nutzer', 'taste', 'schalter', 'quelle',
  'bericht', 'vergleich', 'ablauf', 'fenster', 'seite', 'sprache', 'zeitpunkt', 'ausgabe', 'zugriff',
  'anfrage', 'antwort',
  // Plurals and noun forms a German heading uses. These were added after a stale "Zusammenfassung"
  // heading survived the first translation pass: the list had the singular verb/noun stems only.
  'zusammenfassung', 'tabellen', 'beispiele', 'schritte', 'abschnitte', 'ergebnisse', 'hinweise',
  'dateien', 'einstellungen', 'meldungen', 'uebersicht', 'vorgehen',
];
// audit-words:end
const GERMAN_PATTERNS = GERMAN_WORDS.map((word) => new RegExp('(?:^|[^\\w])' + word + '(?![\\w])', 'i'));

// Non-ASCII characters that are allowed in a specific SHIPPED file, with the reason. Everything else
// outside printable ASCII fails the audit for a shipped file. The middle dot is the panel's own
// separator: it is user-visible text of the proven runtime, not an accident.
const NON_ASCII_ALLOWED = {
  'manifest.json': {},
  'content.js': { '\u00b7': 'the panel separator' },
  'background.js': { '\u00b7': 'the panel separator' },
};

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.indexOf(entry.name) < 0) walk(full, out);
      return;
    }
    if (TEXT_EXTENSIONS.indexOf(path.extname(entry.name)) >= 0) out.push(full);
  });
  return out;
}

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

// Lines inside an audit-words:start/audit-words:end block are the scanner's own vocabulary and are
// exempt from the word pass - otherwise the tool would report itself instead of the project.
function wordListLines(lines) {
  const skip = new Set();
  let inside = false;
  lines.forEach((line, index) => {
    if (line.indexOf('audit-words:start') >= 0) { inside = true; skip.add(index); return; }
    if (line.indexOf('audit-words:end') >= 0) { inside = false; skip.add(index); return; }
    if (inside) skip.add(index);
  });
  return skip;
}

// One pass over one file. `shipped` is the allowed non-ASCII map of a shipped file; null means the
// development tree, where typographic punctuation inside English prose is normal.
function auditFile(file, shipped) {
  const text = fs.readFileSync(file, 'utf8');
  const findings = [];
  const inventory = {};
  const lines = text.split('\n');
  const exempt = wordListLines(lines);
  lines.forEach((line, index) => {
    const where = relative(file) + ':' + (index + 1);
    if (GERMAN_LETTERS.test(line)) {
      findings.push({ where, why: 'German letter', line });
    }
    if (!exempt.has(index)) {
      GERMAN_WORDS.forEach((word, wordIndex) => {
        // Case-insensitive on purpose: a German sentence capitalizes the same words a heading does, and
        // the list is curated so that no English word collides with a lower-case entry (see the header).
        if (GERMAN_PATTERNS[wordIndex].test(line)) {
          findings.push({ where, why: 'German word "' + word + '"', line });
        }
      });
    }
    if (shipped) {
      Array.from(new Set(line.split(''))).forEach((character) => {
        if (character === '\t' || (character >= ' ' && character <= '~')) return;
        inventory[character] = (inventory[character] || 0) + 1;
        if (!shipped[character]) {
          findings.push({
            where, line,
            why: 'character U+' + character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') +
              ' is not allowed in a shipped file',
          });
        }
      });
    }
  });
  return { findings, inventory };
}

function pad(text, width) {
  return text + ' '.repeat(Math.max(0, width - text.length));
}

function main() {
  const files = walk(ROOT, []).sort();
  const findings = [];
  const inventory = new Map();
  let shippedCount = 0;

  files.forEach((file) => {
    const rel = relative(file);
    let shipped = null;
    if (rel.indexOf('extension/') === 0) {
      shipped = NON_ASCII_ALLOWED[path.basename(file)] || null;
      if (!shipped) {
        findings.push({ where: rel, line: '', why: 'a shipped file without an ASCII rule for it' });
      }
      if (shipped) shippedCount += 1;
    }
    const result = auditFile(file, shipped);
    result.findings.forEach((finding) => findings.push(finding));
    if (Object.keys(result.inventory).length) inventory.set(rel, result.inventory);
  });

  console.log('English-only audit');
  console.log('  files scanned: ' + files.length + ' (' + shippedCount + ' of them shipped from extension/)');
  console.log('  passes: German letters, ' + GERMAN_WORDS.length + ' German words, non-ASCII rule for shipped files');

  console.log('\n  typographic characters found (informational):');
  if (!inventory.size) console.log('    none');
  inventory.forEach((characters, file) => {
    const parts = Object.keys(characters).map((character) =>
      'U+' + character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') +
      ' "' + character + '" on ' + characters[character] + ' line(s)');
    console.log('    ' + pad(file, 34) + parts.join(', '));
  });

  if (findings.length) {
    console.log('\n  ' + findings.length + ' finding(s):');
    findings.forEach((finding) => {
      console.log('  - ' + finding.where + '  [' + finding.why + ']');
      if (finding.line) console.log('      ' + finding.line.trim().slice(0, 140));
    });
    console.log('\naudit FAILED');
    process.exitCode = 1;
    return;
  }
  console.log('\naudit passed');
}

main();
