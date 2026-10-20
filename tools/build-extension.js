#!/usr/bin/env node
/*!
 * Builds the release runtime files in extension/ from the proven prototype in
 * spike/mv3-audio-only/.
 *
 * Run: node tools/build-extension.js
 *
 * What it does:
 *   - copies content.js and background.js, applying ONE ordered table of substitutions each. Those
 *     substitutions are the complete list of differences: the build proves that by reversing them and
 *     comparing the result with the prototype byte for byte. Anything else that changes (a stray edit,
 *     a percent-encoded character, a line ending) fails the build instead of shipping silently.
 *   - strips the AUDIO_ONLY test surface and replaces it with a private, non-enumerable in-sandbox
 *     marker, so the double-injection guard keeps working without a console API.
 *   - checks the hand-maintained release manifest.json against the built files: version, ID,
 *     minimum version, data-collection declaration, permissions, and the file list in both
 *     directions (every referenced file exists, no unreferenced file is shipped).
 *   - refuses to ship development references (test files, dev documents, signed URL shapes).
 *
 * It never writes outside extension/ and never touches the prototype files.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'spike', 'mv3-audio-only');
const OUT_DIR = path.join(ROOT, 'extension');
const MANIFEST_FILE = path.join(OUT_DIR, 'manifest.json');

const SOURCE_FILES = ['content.js', 'background.js'];

// --------------------------------------------------------------- the test surface
const TEST_SURFACE_START = '  // ------------------------------------------------------------ test surface';
const LIFECYCLE_MARK = '  // -------------------------------------------------------------- lifecycle';
const MARKER_BLOCK = [
  '  // ----------------------------------------------------- double-injection marker',
  '  // The release build has no console test surface. This non-enumerable marker is what the guard at',
  '  // the top of this file reads: a second injection of the same script into the same document (after',
  '  // an add-on reload or an update) must not start a second instance. It lives on the content',
  '  // script\'s own sandbox window, which page scripts cannot see.',
  '  try {',
  '    Object.defineProperty(window, \'__audioOnlyLoaded\', {',
  '      value: true, configurable: true, enumerable: false,',
  '    });',
  '  } catch (e) {',
  '    try { window.__audioOnlyLoaded = true; } catch (e2) { /* ignore */ }',
  '  }',
  '',
  '',
].join('\n');

// ------------------------------------------------------- the complete change list
// Every entry is {id, find, replace}. `find` must occur exactly once. The reverse run (replace -> find)
// has to reproduce the prototype exactly, so no entry may be ambiguous or overlapping.
const CONTENT_TRANSFORMS = [
  {
    id: 'version',
    find: String.raw`  const VERSION = '0.1.0-prototype';`,
    replace: String.raw`  const VERSION = '0.1.0';`,
  },
  {
    id: 'header-title',
    find: String.raw` * Audio-only for YouTube - MV3 PROTOTYPE content script.`,
    replace: String.raw` * Audio-only for YouTube - content script.`,
  },
  {
    id: 'header-prototype-status',
    find: [
      String.raw` * PROTOTYPE. Throwaway code, not for release, not a product decision. Proven by the live test in`,
      String.raw` * spike/results.md: 35 s of stable audio-only playback through the page element (videoWidth 0,`,
      String.raw` * totalVideoFrames 0, drift 0, no source re-take). NOT proven and never claimed here: a byte-level`,
      String.raw` * "no video bytes" accounting and any resource saving - neither was measured.`,
    ].join('\n'),
    replace: [
      String.raw` * Proven by the recorded live run: 35 s of stable audio-only playback through the page element`,
      String.raw` * (videoWidth 0, totalVideoFrames 0, drift 0, no source re-take). NOT proven and never claimed`,
      String.raw` * here: a byte-level "no video bytes" accounting and any resource saving - neither was`,
      String.raw` * measured.`,
    ].join('\n'),
  },
  {
    id: 'header-provenance-note',
    find: [
      String.raw` * Provenance note on that live run (corrects an earlier claim in this file): the run went through`,
      String.raw` * the console snippet, whose resolver repeats the request once with the visitorData that the`,
      String.raw` * server's own answer carried (visitorDataSent: true). The run therefore did NOT prove a path`,
      String.raw` * without visitorData, and results.md run 1 does not record that field at all. This file used to`,
      String.raw` * say the opposite; it does the same bounded repetition as the snippet now.`,
    ].join('\n'),
    replace: [
      String.raw` * Provenance note on that live run: the run went through a console snippet whose resolver repeats`,
      String.raw` * the request once with the visitorData that the server's own answer carried (visitorDataSent:`,
      String.raw` * true). The run therefore did NOT prove a path without visitorData. This file does the same`,
      String.raw` * bounded repetition as the snippet.`,
    ].join('\n'),
  },
  {
    id: 'visitordata-bullet',
    find: String.raw` *     Same shape as spike/console-probe.js - see README.md, "Comparison with the console snippet".`,
    replace: String.raw` *     Same shape as the console snippet the recorded live run used.`,
  },
  {
    id: 'header-provenance',
    find: [
      String.raw` * Provenance: request shape and client values are taken from spike/console-probe.js (protocol facts`,
      String.raw` * only, no copied third-party code). Full run sheet: README.md in this folder.`,
    ].join('\n'),
    replace: [
      String.raw` * Provenance: the request shape and the client values are protocol facts taken from the console`,
      String.raw` * probe used during development (protocol facts only, no copied third-party code).`,
    ].join('\n'),
  },
  {
    id: 'client-order-note',
    find: String.raw`  // VISIONOS first: it is the client whose audio URL the live test played (spike/results.md, run 1;`,
    replace: String.raw`  // VISIONOS first: it is the client whose audio URL the recorded live run played (that run;`,
  },
  {
    id: 'timings-comment',
    find: [
      String.raw`  // Production timings. The offline smoke harness may override them (AUDIO_ONLY._timings) so a`,
      String.raw`  // whole state machine run does not have to take half a minute.`,
    ].join('\n'),
    replace: [
      String.raw`  // Production timings. The offline suite of the development tree overrides them through its own`,
      String.raw`  // hook, so that a whole state machine run does not have to take half a minute.`,
    ].join('\n'),
  },
  {
    id: 'repeat-comment',
    find: String.raw`  // Bounded repetition, like console-probe.js: ONE repeat per resolve - never a loop, never a timer.`,
    replace: String.raw`  // Bounded repetition, like the console snippet: ONE repeat per resolve - never a loop, never a timer.`,
  },
  {
    id: 'resolve-comment',
    find: String.raw`  // Bounded repetition, exactly like console-probe.js: when an answer carries no audio URL but brings`,
    replace: String.raw`  // Bounded repetition, exactly like the console snippet: when an answer carries no audio URL but brings`,
  },
  {
    id: 'restore-note',
    find: String.raw`    // verified in page context (spike/console-probe.js). No blob URL of ours or of the page is written`,
    replace: String.raw`    // verified in page context. No blob URL of ours or of the page is written`,
  },
  {
    id: 'content-type-note',
    find: String.raw`        'itag/mimeType (see results.md, "itag and mimeType" point)',`,
    replace: String.raw`        'itag/mimeType (the development notes record why this client has to decide by itag/mimeType)',`,
  },
  {
    id: 'claims-proven',
    find: String.raw`          'no source re-take over 35 s) - spike/results.md',`,
    replace: String.raw`          'no source re-take over 35 s) - the recorded live run',`,
  },
  {
    id: 'claims-provenance',
    find: [
      String.raw`        liveRunProvenance: 'the live run in results.md (run 1) went through the console snippet, whose ' +`,
      String.raw`          'resolver repeats the request once with the visitorData of the server\'s own answer ' +`,
      String.raw`          '(visitorDataSent: true). That run is NO proof of a path without visitorData, and run 1 does ' +`,
      String.raw`          'not record the field at all.',`,
    ].join('\n'),
    replace: [
      String.raw`        liveRunProvenance: 'the recorded live run went through a console snippet whose resolver repeats ' +`,
      String.raw`          'the request once with the visitorData of the server\'s own answer (visitorDataSent: true). ' +`,
      String.raw`          'That run is NO proof of a path without visitorData.',`,
    ].join('\n'),
  },
  {
    id: 'panel-comment-and-id',
    find: [
      String.raw`  // Throwaway UI for the prototype: small, dark, bottom right, only text and buttons. It is the`,
      String.raw`  // "understandable status" requirement - the panel is created on the first user action.`,
      String.raw`  const PANEL_ID = 'audio-only-prototype-panel';`,
    ].join('\n'),
    replace: [
      String.raw`  // Minimal status UI: small, dark, bottom right, only text and buttons. It is the "understandable`,
      String.raw`  // status" requirement - the panel is created on the first user action.`,
      String.raw`  const PANEL_ID = 'audio-only-panel';`,
    ].join('\n'),
  },
  {
    id: 'double-injection-guard',
    find: String.raw`  if (typeof window !== 'undefined' && window.AUDIO_ONLY && window.AUDIO_ONLY.VERSION) {`,
    replace: String.raw`  if (typeof window !== 'undefined' && window.__audioOnlyLoaded === true) {`,
  },
];

// ---------------------------------------------------------- background.js changes
const BACKGROUND_TRANSFORMS = [
  {
    id: 'background-title',
    find: String.raw` * Audio-only for YouTube - MV3 PROTOTYPE, background event page.`,
    replace: String.raw` * Audio-only for YouTube - background event page.`,
  },
  {
    id: 'background-prototype-status',
    find: [
      String.raw` *`,
      String.raw` * Prototype status: throwaway code, not for release. See README.md in this folder.`,
    ].join('\n'),
    replace: [
      String.raw` *`,
      String.raw` * This is the release build of a proven prototype: the same runtime code, without the console`,
      String.raw` * test surface the development tree uses.`,
    ].join('\n'),
  },
];

// --------------------------------------------------------------- what may not ship
// Shapes that must not appear in a shipped file: a console API, a path into the development tree, a
// development document, a signed media URL, or prototype wording. Function.prototype is NOT affected
// by the last entry (it is case-sensitive and spells the word in upper case).
const FORBIDDEN = [
  { id: 'test-surface', pattern: /AUDIO_ONLY/, why: 'the console test surface' },
  { id: 'internals', pattern: /_internals/, why: 'the internals export of the test surface' },
  { id: 'dev-tree', pattern: /spike\//, why: 'a path into the development tree' },
  { id: 'dev-docs', pattern: /results\.md|README|console-probe|smoke\//, why: 'a development document or test file' },
  { id: 'media-url', pattern: /videoplayback|[?&]sig=|signatureCipher|googlevideo/, why: 'a media URL or its signature' },
  { id: 'prototype-wording', pattern: /audio-only-prototype|MV3 PROTOTYPE|not for release|throwaway/i, why: 'prototype wording' },
];
// The stable Gecko ID keeps the word "prototype" (see the release report): that entry is checked on
// the code files only, because the ID is a deliberate identity decision and not shipped wording.
const MANIFEST_FORBIDDEN = FORBIDDEN.filter((entry) => entry.id !== 'prototype-wording');

// The data types Firefox 140+ accepts in data_collection_permissions (values only; the descriptions
// and the two lists that hold them come from the local Firefox schema, see build/schema note in
// docs/release/data-collection-decision.md).
const DATA_TYPES_REQUIRED = ['authenticationInfo', 'bookmarksInfo', 'browsingActivity',
  'financialAndPaymentInfo', 'healthInfo', 'locationInfo', 'personalCommunications',
  'personallyIdentifyingInfo', 'searchTerms', 'websiteActivity', 'websiteContent'];
const DATA_TYPE_NONE = 'none';

const EXPECTED = {
  id: 'audio-only-prototype@local.invalid',
  minVersion: 140,
  dataRequired: ['websiteContent'],
  hostPermissions: ['https://www.youtube.com/*'],
  files: ['background.js', 'content.js', 'manifest.json'],
  maxDescriptionLength: 132,
};

// ------------------------------------------------------------------------ helpers
function fail(message) {
  const error = new Error(message);
  error.build = true;
  throw error;
}

function sha256(text) {
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

// Applies every entry of a list in order. Each `find` has to match exactly once - a second match means
// the entry is ambiguous and the list can no longer prove anything.
function applyList(text, list, direction, file) {
  list.forEach((entry) => {
    const find = direction === 'forward' ? entry.find : entry.replace;
    const replacement = direction === 'forward' ? entry.replace : entry.find;
    if (!find) {
      fail(file + ': "' + entry.id + '" (' + direction + ') would have to locate an empty string');
    }
    const at = text.indexOf(find);
    if (at < 0) fail(file + ': "' + entry.id + '" (' + direction + ') has no match');
    if (text.indexOf(find, at + find.length) >= 0) {
      fail(file + ': "' + entry.id + '" matches more than once');
    }
    text = text.slice(0, at) + replacement + text.slice(at + find.length);
  });
  return text;
}

// The release version comes from the manifest, so the two can never drift apart.
function withVersion(version) {
  const list = CONTENT_TRANSFORMS.map((entry) => (entry.id === 'version'
    ? { id: entry.id, find: entry.find, replace: "  const VERSION = '" + version + "';" }
    : entry));
  const versionEntry = list.filter((entry) => entry.id === 'version')[0];
  if (versionEntry.find.indexOf('-prototype') < 0) {
    fail('build: the version transform no longer renames the prototype version string');
  }
  return list;
}

// ------------------------------------------------------------- the content script
function splitTestSurface(text) {
  const start = text.indexOf(TEST_SURFACE_START);
  const end = text.indexOf(LIFECYCLE_MARK);
  if (start < 0) fail('content.js: the test-surface start marker is gone');
  if (end < 0 || end < start) fail('content.js: the lifecycle marker is not after the test surface');
  const block = text.slice(start, end);
  if (block.indexOf('window.AUDIO_ONLY') < 0 || block.indexOf('_internals') < 0) {
    fail('content.js: the block between those markers is not the test surface');
  }
  if (block.indexOf('_timings') < 0 || block.indexOf('__audioOnlyLoaded') >= 0) {
    fail('content.js: the block between those markers does not look like the test surface');
  }
  return { head: text.slice(0, start), block, tail: text.slice(end) };
}

function buildContent(prototype, version) {
  const transforms = withVersion(version);
  const mapped = applyList(prototype, transforms, 'forward', 'content.js');
  const parts = splitTestSurface(mapped);
  const release = parts.head + MARKER_BLOCK + parts.tail;
  if (release.split(MARKER_BLOCK).length !== 2) fail('content.js: the marker block is not unique');
  if (release.indexOf('AUDIO_ONLY') >= 0 || release.indexOf('_internals') >= 0) {
    fail('content.js: the console test surface is still in the release text');
  }
  // The proof: undo every substitution and put the removed block back. The result must be the
  // prototype byte for byte, so the change list above is complete and nothing else moved.
  const reversed = applyList(release, transforms, 'reverse', 'content.js');
  const markerAt = reversed.indexOf(MARKER_BLOCK);
  if (markerAt < 0) fail('content.js: the marker block did not survive the reverse pass');
  const roundTrip = reversed.slice(0, markerAt) + parts.block +
    reversed.slice(markerAt + MARKER_BLOCK.length);
  if (roundTrip !== prototype) {
    fail('content.js: the reverse pass is not byte-identical to the prototype - the change list is incomplete');
  }
  return { text: release, ids: transforms.map((entry) => entry.id), removedBytes: parts.block.length };
}

// ------------------------------------------------------------- the background page
function buildBackground(prototype) {
  const release = applyList(prototype, BACKGROUND_TRANSFORMS, 'forward', 'background.js');
  const back = applyList(release, BACKGROUND_TRANSFORMS, 'reverse', 'background.js');
  if (back !== prototype) {
    fail('background.js: the reverse pass is not byte-identical to the prototype');
  }
  return { text: release, ids: BACKGROUND_TRANSFORMS.map((entry) => entry.id) };
}

// ------------------------------------------------------------------ the manifest
function readManifest() {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  } catch (e) {
    fail('manifest.json is not readable JSON: ' + ((e && e.message) || String(e)));
  }
  return manifest;
}

function checkManifest(manifest, contentText) {
  const checks = [];
  const say = (name, ok, detail) => {
    checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
    if (!ok) fail('manifest.json: ' + name + (detail ? ' -> ' + detail : ''));
  };

  say('manifest_version is 3', manifest.manifest_version === 3, manifest.manifest_version);
  say('name is set and ASCII', typeof manifest.name === 'string' && manifest.name.length > 0 &&
    /^[\x20-\x7e]+$/.test(manifest.name), manifest.name);
  say('description is set, ASCII and within the AMO summary limit',
    typeof manifest.description === 'string' && /^[\x20-\x7e]+$/.test(manifest.description) &&
    manifest.description.length <= EXPECTED.maxDescriptionLength,
    (manifest.description || '').length + ' characters');

  const settings = manifest.browser_specific_settings || {};
  const gecko = settings.gecko;
  say('browser_specific_settings.gecko exists', !!gecko);
  say('the stable Gecko ID is unchanged', gecko.id === EXPECTED.id, gecko.id);
  const minVersion = parseFloat(gecko.strict_min_version);
  say('strict_min_version is ' + EXPECTED.minVersion + ' or higher',
    Number.isFinite(minVersion) && minVersion >= EXPECTED.minVersion, gecko.strict_min_version);
  say('desktop only: no gecko_android key', settings.gecko_android === undefined);

  const data = gecko.data_collection_permissions;
  say('data_collection_permissions is declared (mandatory for new AMO submissions)', !!data);
  say('required is an array', !!data && Array.isArray(data.required), JSON.stringify(data && data.required));
  say('required does not use the none placeholder', data.required.indexOf(DATA_TYPE_NONE) < 0,
    JSON.stringify(data.required));
  say('every declared data type is a taxonomy value',
    data.required.every((type) => DATA_TYPES_REQUIRED.indexOf(type) >= 0), JSON.stringify(data.required));
  say('required matches the reviewed declaration (' + EXPECTED.dataRequired.join(',') + ')',
    JSON.stringify(data.required) === JSON.stringify(EXPECTED.dataRequired), JSON.stringify(data.required));
  say('no optional data types are declared', data.optional === undefined, JSON.stringify(data.optional));

  say('no API permissions are requested', Array.isArray(manifest.permissions) &&
    manifest.permissions.length === 0, JSON.stringify(manifest.permissions));
  say('host_permissions stay on youtube.com only',
    JSON.stringify(manifest.host_permissions) === JSON.stringify(EXPECTED.hostPermissions),
    JSON.stringify(manifest.host_permissions));

  const scripts = manifest.background && manifest.background.scripts;
  say('the background is the event page script', JSON.stringify(scripts) === JSON.stringify(['background.js']),
    JSON.stringify(scripts));
  const content = manifest.content_scripts || [];
  say('one content script, on youtube.com, running the built file',
    content.length === 1 && JSON.stringify(content[0].js) === JSON.stringify(['content.js']) &&
    JSON.stringify(content[0].matches) === JSON.stringify(EXPECTED.hostPermissions),
    JSON.stringify(content.map((entry) => entry.js)));

  const versionLine = "  const VERSION = '" + manifest.version + "';";
  say('the built content.js carries the manifest version', contentText.indexOf(versionLine) >= 0,
    manifest.version);

  return checks;
}

// The file list in both directions: every file the manifest names has to exist, and no file the
// manifest does not name may sit in extension/ - that is how a test file would sneak into a package.
function checkFiles(manifest) {
  const referenced = ['manifest.json'];
  (manifest.background.scripts || []).forEach((file) => referenced.push(file));
  (manifest.content_scripts || []).forEach((entry) => (entry.js || []).forEach((file) => referenced.push(file)));
  const unique = Array.from(new Set(referenced)).sort();
  const present = fs.readdirSync(OUT_DIR).sort();
  const missing = unique.filter((file) => present.indexOf(file) < 0);
  const extra = present.filter((file) => unique.indexOf(file) < 0);
  if (missing.length) fail('extension/: referenced but missing: ' + missing.join(', '));
  if (extra.length) fail('extension/: present but not referenced by the manifest: ' + extra.join(', '));
  if (JSON.stringify(unique) !== JSON.stringify(EXPECTED.files.slice().sort())) {
    fail('extension/: the shipped file list changed: ' + unique.join(', '));
  }
  return unique;
}

function checkForbidden(file, text, list) {
  const hits = list.filter((entry) => entry.pattern.test(text));
  if (hits.length) fail(file + ': must not ship ' + hits.map((entry) => entry.why).join('; '));
}

// ------------------------------------------------------------------------------ build
function build() {
  if (!fs.existsSync(SRC_DIR)) fail('the prototype folder is missing: ' + SRC_DIR);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const manifest = readManifest();
  const prototypes = {};
  SOURCE_FILES.forEach((name) => {
    prototypes[name] = fs.readFileSync(path.join(SRC_DIR, name), 'utf8');
  });

  const built = {
    'content.js': buildContent(prototypes['content.js'], manifest.version),
    'background.js': buildBackground(prototypes['background.js']),
  };

  const manifestChecks = checkManifest(manifest, built['content.js'].text);

  // Write, then read back and scan what is really on disk: a half-written file must not pass.
  const files = [];
  SOURCE_FILES.forEach((name) => {
    const outPath = path.join(OUT_DIR, name);
    const text = built[name].text;
    fs.writeFileSync(outPath, text, 'utf8');
    const onDisk = fs.readFileSync(outPath, 'utf8');
    if (onDisk !== text) fail('extension/' + name + ': the file on disk is not what the build produced');
    checkForbidden('extension/' + name, onDisk, FORBIDDEN);
    files.push({
      name, source: name, bytes: Buffer.byteLength(onDisk, 'utf8'),
      sourceHash: sha256(prototypes[name]), releaseHash: sha256(onDisk), changes: built[name].ids,
    });
  });

  const manifestText = fs.readFileSync(MANIFEST_FILE, 'utf8');
  checkForbidden('extension/manifest.json', manifestText, MANIFEST_FORBIDDEN);

  // Both directions of the file list, now that everything the build writes is on disk.
  const fileList = checkFiles(manifest);

  return { manifest, manifestHash: sha256(manifestText), files, fileList, manifestChecks };
}

function printReport(result) {
  const manifest = result.manifest;
  console.log('release build: ' + manifest.name + ' ' + manifest.version);
  console.log('');
  console.log('  extension/manifest.json   sha256 ' + result.manifestHash);
  console.log('    hand-maintained, checked against the built files (' + result.manifestChecks.length +
    ' checks)');
  result.files.forEach((file) => {
    console.log('  extension/' + file.name + '   sha256 ' + file.releaseHash);
    console.log('    built from spike/mv3-audio-only/' + file.source + '   sha256 ' + file.sourceHash);
    console.log('    ' + file.bytes + ' bytes, ' + file.changes.length + ' changes: ' + file.changes.join(', '));
  });
  console.log('');
  console.log('  manifest checks passed: ' + result.manifestChecks.length + '/' +
    result.manifestChecks.length);
  console.log('  shipped files: ' + result.fileList.join(', '));
  console.log('  unsigned and not uploaded - see docs/release/release-report.md');
}

function main() {
  let result;
  try {
    result = build();
  } catch (e) {
    console.error('release build FAILED: ' + ((e && e.message) || String(e)));
    if (!e || !e.build) console.error((e && e.stack) || String(e));
    process.exitCode = 1;
    return;
  }
  printReport(result);
}

module.exports = {
  build, readManifest, sha256, OUT_DIR, SRC_DIR, SOURCE_FILES, EXPECTED,
};

if (require.main === module) main();
