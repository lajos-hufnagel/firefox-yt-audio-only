#!/usr/bin/env node
/*!
 * Packs the release runtime files into a deterministic, UNSIGNED ZIP - the same container format an
 * XPI uses. Run: node tools/package.js   (rebuilds and validates the runtime before packaging)
 *
 * Why it writes the ZIP itself instead of calling `zip`: this file has to be reproducible. The archive
 * carries a fixed timestamp (1980-01-01 00:00:00, the earliest value DOS time can express), a fixed
 * entry order and no extra fields, so the same extension/ directory always produces the same bytes and
 * the same SHA-256 - on the same Node/zlib toolchain. `zip` would store the working copy's file times.
 *
 * After writing, the tool reads the archive back and checks it entry by entry: the entry list has to be
 * exactly the shipped files (nothing else, and in particular no META-INF, which is what a signature
 * would add), every CRC has to match, and every unpacked entry has to be byte-identical to the file in
 * extension/. A record line with the SHA-256 is written next to the archive for the release report.
 *
 * This tool never signs, never creates an account, never contacts Mozilla and never uploads anything.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const BUILD = require('./build-extension.js');

const DIST_DIR = path.join(__dirname, '..', 'dist');
const FIXED_DOS_TIME = 0;                 // 00:00:00
const FIXED_DOS_DATE = 0x21;              // 1980-01-01

// ------------------------------------------------------------------------ helpers
function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// The classic CRC-32 table, built once. zlib has one too, but only in newer Node versions; this file
// stays independent of that.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ------------------------------------------------------------------------ the ZIP
function fail(message) {
  throw new Error(message);
}

function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;

  entries.forEach((entry) => {
    const name = Buffer.from(entry.name, 'utf8');
    const body = zlib.deflateRawSync(entry.data, { level: 9 });
    entry.crc = crc32(entry.data);
    entry.compressedSize = body.length;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);                 // version needed to extract
    header.writeUInt16LE(0, 6);                  // flags: none
    header.writeUInt16LE(8, 8);                  // deflate
    header.writeUInt16LE(FIXED_DOS_TIME, 10);
    header.writeUInt16LE(FIXED_DOS_DATE, 12);
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);                 // no extra field
    parts.push(header, name, body);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);              // version made by
    directory.writeUInt16LE(20, 6);              // version needed
    directory.writeUInt16LE(0, 8);               // flags
    directory.writeUInt16LE(8, 10);              // deflate
    directory.writeUInt16LE(FIXED_DOS_TIME, 12);
    directory.writeUInt16LE(FIXED_DOS_DATE, 14);
    directory.writeUInt32LE(entry.crc, 16);
    directory.writeUInt32LE(body.length, 20);
    directory.writeUInt32LE(entry.data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt16LE(0, 30);              // extra length
    directory.writeUInt16LE(0, 32);              // comment length
    directory.writeUInt16LE(0, 34);              // disk number
    directory.writeUInt16LE(0, 36);              // internal attributes
    directory.writeUInt32LE(0, 38);              // external attributes: no unix mode, no directory bit
    directory.writeUInt32LE(offset, 42);         // where the local header starts
    central.push(directory, name);

    offset += header.length + name.length + body.length;
  });

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);                       // this disk
  end.writeUInt16LE(0, 6);                       // disk with the central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);                      // no archive comment
  return Buffer.concat(parts.concat([centralBuffer, end]));
}

// Reads an archive back the way an unpacker does: through the central directory, not through the
// writer's own bookkeeping.
function readZip(buffer) {
  if (buffer.length < 22) fail('the archive is too short to hold an end-of-central-directory record');
  const eocd = buffer.length - 22;
  if (buffer.readUInt32LE(eocd) !== 0x06054b50) fail('no end-of-central-directory record found');
  const count = buffer.readUInt16LE(eocd + 10);
  const entries = [];
  let at = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) {
      fail('broken central directory entry at offset ' + at);
    }
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const compressed = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localAt = buffer.readUInt32LE(at + 42);
    const name = buffer.slice(at + 46, at + 46 + nameLength).toString('utf8');
    if (buffer.readUInt32LE(localAt) !== 0x04034b50) fail(name + ': broken local file header');
    const dataAt = localAt + 30 + buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28);
    if (dataAt + compressed > buffer.length) {
      fail(name + ': the entry claims more bytes than the archive holds');
    }
    const raw = buffer.slice(dataAt, dataAt + compressed);
    entries.push({
      name, method, crc, compressed, size,
      data: method === 8 ? zlib.inflateRawSync(raw) : raw,
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// Every check runs on the bytes that were really written, not on the intent behind them.
function verifyArchive(archive, entries, say) {
  const read = readZip(archive);
  say('the archive reads back with the same number of entries', read.length === entries.length,
    read.length + ' vs ' + entries.length);
  say('the entry names and their order are exactly the shipped files',
    JSON.stringify(read.map((entry) => entry.name)) === JSON.stringify(entries.map((entry) => entry.name)),
    JSON.stringify(read.map((entry) => entry.name)));
  say('no entry is a directory and none is a signature (no META-INF)',
    read.every((entry) => entry.name.indexOf('/') < 0 && entry.name.indexOf('META-INF') !== 0),
    JSON.stringify(read.map((entry) => entry.name)));
  read.forEach((entry) => {
    const source = entries.filter((candidate) => candidate.name === entry.name)[0];
    say(entry.name + ': stored with deflate', entry.method === 8, String(entry.method));
    say(entry.name + ': CRC-32 matches the content', entry.crc === crc32(entry.data),
      entry.crc.toString(16));
    say(entry.name + ': uncompressed size matches', entry.size === source.data.length,
      entry.size + ' vs ' + source.data.length);
    say(entry.name + ': byte-identical to extension/' + entry.name,
      Buffer.compare(entry.data, source.data) === 0, entry.data.length + ' bytes');
  });
  const again = buildZip(entries.map((entry) => ({ name: entry.name, data: entry.data })));
  say('the same input produces the same bytes (deterministic)', Buffer.compare(again, archive) === 0,
    sha256(again).slice(0, 16) + ' vs ' + sha256(archive).slice(0, 16));
}

// ------------------------------------------------------------------------------ main
function packageExtension() {
  const manifest = BUILD.build().manifest; // cannot package a stale or unvalidated release tree
  const names = BUILD.EXPECTED.files.slice().sort();
  const entries = names.map((name) => ({
    name, data: fs.readFileSync(path.join(BUILD.OUT_DIR, name)),
  }));
  const archive = buildZip(entries);
  const base = slug(manifest.name) + '-' + manifest.version + '-unsigned';

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const archivePath = path.join(DIST_DIR, base + '.zip');
  const recordPath = path.join(DIST_DIR, base + '.zip.sha256');
  const relative = (file) => path.relative(path.join(__dirname, '..'), file);
  fs.writeFileSync(archivePath, archive);
  const hash = sha256(archive);


  const checks = [];
  const say = (name, ok, detail) => {
    checks.push({ name, ok: !!ok });
    if (!ok) fail(name + (detail ? ' -> ' + detail : ''));
  };
  verifyArchive(fs.readFileSync(archivePath), entries, say);
  fs.writeFileSync(recordPath, hash + '  ' + path.basename(archivePath) + '\n');

  console.log('package (UNSIGNED)');
  console.log('  add-on: ' + manifest.name + ' ' + manifest.version + ', id ' +
    manifest.browser_specific_settings.gecko.id);
  console.log('  ' + relative(archivePath) + '   ' + archive.length + ' bytes');
  console.log('  sha256 ' + hash);
  console.log('  recorded in ' + relative(recordPath));
  console.log('');
  console.log('  entries (' + entries.length + '):');
  entries.forEach((entry) => {
    console.log('    ' + entry.name + '   ' + entry.data.length + ' bytes -> ' +
      entry.compressedSize + ' stored, crc ' + entry.crc.toString(16));
  });
  console.log('');
  console.log('  checks (' + checks.length + '):');
  checks.forEach((entry) => console.log('    ok   ' + entry.name));
  console.log('');
  console.log('  UNSIGNED: the archive has no META-INF/ directory, so this is not a signature. Standard');
  console.log('  Firefox refuses to install an unsigned add-on; this file is for a signed unlisted release');
  console.log('  or for a temporary load in about:debugging. Nothing was signed and nothing was uploaded.');
}

function main() {
  try {
    packageExtension();
  } catch (e) {
    console.error('packaging FAILED: ' + ((e && e.message) || String(e)));
    process.exitCode = 1;
  }
}

module.exports = { buildZip, readZip, crc32, sha256, DIST_DIR };

if (require.main === module) main();
