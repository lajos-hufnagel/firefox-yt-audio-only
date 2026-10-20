#!/usr/bin/env node
// Builds throw-away copies of the extension OUTSIDE the project (work folder), each with exactly one
// mutation, plus the stub page allowed and the probe content script appended. Nothing in the project is
// changed: content.js is only read. Variants (see run.sh for what each one is for):
//   fixed                 - the current source
//   old                   - cloneArgsToPage put back to the pre-fix behaviour
//   no-clone              - the current source in a context without a usable cloneInto
//   old-no-clone          - both: the situation the live failure came from
//   old-no-clone-nobound  - the same without the counted log repeat
//   resolver-stub         - postPlayer returns a canned answer whose audio URL is a real local WAV, so the
//                           switching itself can be exercised without YouTube's answer
// Run me with: node build.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..');
const ROOT = process.env.WORK || path.join(os.tmpdir(), 'audio-only-browser-proof');
const PORT = Number(process.env.PORT || 8791);

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
manifest.host_permissions = manifest.host_permissions.concat(['http://127.0.0.1/*']);
manifest.content_scripts = [
  {
    matches: ['http://127.0.0.1/*'],
    js: ['content.js', 'probe.js'],
    run_at: 'document_idle',
  },
].concat(manifest.content_scripts);
manifest.browser_specific_settings.gecko.strict_min_version = '128.0';
manifest.name = 'Audio-only boundary proof (temporary)';

const content = fs.readFileSync(path.join(SRC, 'content.js'), 'utf8');
const background = fs.readFileSync(path.join(SRC, 'background.js'), 'utf8');
const probe = fs.readFileSync(path.join(__dirname, 'probe.js'), 'utf8')
  .replace('var PORT = 8791;', 'var PORT = ' + PORT + ';');

// The pre-fix behaviour: an empty argument list was handed over as a fresh content-script array.
const FIXED_CLONE = `    if (!plain.length) {
      // Nothing to hand over: call it without an argument list, so no array of this realm reaches the
      // page's apply. The report names this path (\`no-args\`) instead of pretending a clone happened.
      return { args: plain, bridge: 'no-args', noArgList: true, cloneError, cloneMessage };
    }
    return { args: plain, bridge: 'direct', cloneError, cloneMessage };`;
const OLD_CLONE = `    if (!plain.length) return { args: [], bridge: 'none' };
    return { args: plain, bridge: 'direct' };`;

// `no-clone` is the fallback situation: the fix as it stands, in a context where cloneInto is not there.
const CLONE_TEST = 'if (typeof cloneInto === \'function\') {';
const NO_CLONE_TEST = 'if (typeof __cloneIntoDisabled === \'function\') {';

// `old-nobound` shows what the log bounding is worth: the pre-fix call path WITHOUT the counted repeat.
const FIXED_REPEAT = `        log('page-call:refused', { name, argsBridge: bridged.bridge, name2: refusal.name,
                                   message: refusal.message, retried: ownRealm },
            { repeatable: true });`;
const PLAIN_REPEAT = `        log('page-call:refused', { name, argsBridge: bridged.bridge, name2: refusal.name,
                                   message: refusal.message, retried: ownRealm });`;

// `resolver-stub` takes the NETWORK out of the picture and nothing else: postPlayer returns a canned
// player answer (the same shape as the offline harness uses) whose audio URLs point at a real WAV on the
// local proof server. So the element takeover, the position step, the verification and the hand-back all
// run as real Firefox code across the real boundary - only YouTube's answer is replaced, because the
// real one comes back 404 for these classic clients in a headless run.
const POSTPLAYER_HEAD = '  async function postPlayer(clientKey, videoId, signal, visitorData) {';
const POSTPLAYER_STUB = POSTPLAYER_HEAD + `
    return {
      clientKey, videoId, http: { status: 200, ok: true }, parseError: null, elapsedMs: 5,
      visitorDataSent: !!visitorData, visitorDataReturned: false,
      json: {
        playabilityStatus: { status: 'OK' },
        streamingData: { expiresInSeconds: 21600, adaptiveFormats: [
          { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"',
            url: 'http://127.0.0.1:${PORT}/audio.wav?sig=VIDEO', bitrate: 4000000 },
          { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            url: 'http://127.0.0.1:${PORT}/audio.wav?itag=140&sig=SIG140',
            bitrate: 129000, contentLength: 480000 },
          { itag: 251, mimeType: 'audio/webm; codecs="opus"',
            url: 'http://127.0.0.1:${PORT}/audio.wav?itag=251&sig=SIG251',
            bitrate: 160000, contentLength: 480000 },
        ] },
        videoDetails: { videoId },
      },
    };
    /* eslint-disable no-unreachable */`;

function mutate(src, flags) {
  let js = src;
  if (flags.old) {
    if (js.indexOf(FIXED_CLONE) < 0) throw new Error('the fixed cloneArgsToPage tail was not found');
    js = js.replace(FIXED_CLONE, OLD_CLONE);
  }
  if (flags.noClone) {
    if (js.indexOf(CLONE_TEST) < 0) throw new Error('the cloneInto test was not found');
    js = js.replace(CLONE_TEST, NO_CLONE_TEST);
  }
  if (flags.noBound) {
    if (js.indexOf(FIXED_REPEAT) < 0) throw new Error('the repeatable refusal log was not found');
    js = js.replace(FIXED_REPEAT, PLAIN_REPEAT);
  }
  if (flags.resolverStub) {
    if (js.indexOf(POSTPLAYER_HEAD) < 0) throw new Error('postPlayer was not found');
    js = js.replace(POSTPLAYER_HEAD, POSTPLAYER_STUB);
  }
  return js;
}

// `old-no-clone` is the situation the live failure came from: no usable cloneInto AND the pre-fix call
// path. `old-no-clone-nobound` is the same without the counted repeat, to show what the log bounding does.
const VARIANTS = [
  { name: 'fixed' },
  { name: 'old', flags: { old: true } },
  { name: 'no-clone', flags: { noClone: true } },
  { name: 'old-no-clone', flags: { old: true, noClone: true } },
  { name: 'old-no-clone-nobound', flags: { old: true, noClone: true, noBound: true } },
  { name: 'resolver-stub', flags: { resolverStub: true } },
];

VARIANTS.forEach((variant) => {
  const dir = path.join(ROOT, 'ext-' + variant.name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const js = mutate(content, variant.flags || {});
  fs.writeFileSync(path.join(dir, 'content.js'), js);
  fs.writeFileSync(path.join(dir, 'background.js'), background);
  fs.writeFileSync(path.join(dir, 'probe.js'), probe);
  const m = JSON.parse(JSON.stringify(manifest));
  m.name = m.name + ' - ' + variant.name;
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
  console.log('built ' + dir + ' (' + variant.name + ')');
});
