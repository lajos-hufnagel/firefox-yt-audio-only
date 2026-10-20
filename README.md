# Audio-only for YouTube

A Firefox desktop extension that resolves an audio-only stream and plays it through YouTube's own media element. Personal project developed with AI assistance; I defined the requirements, guided implementation, reviewed behaviour and tested playback.

## Run locally

In Firefox, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, select `extension/manifest.json`, and reload a YouTube watch page. Toggle audio-only using the toolbar button or Alt+Shift+A. Temporary installations end when Firefox restarts.

## Build and verification

Requires Node.js. Run sequentially from this directory:

```sh
node tools/build-extension.js
node spike/mv3-audio-only/smoke/run-smoke.js
node tools/smoke-release.js
node tools/check-tooling.js
node tools/audit-english.js
node tools/package.js
```

Source lives in `spike/mv3-audio-only/`; `extension/` contains the generated runtime and release manifest. Tests and build scripts are included. Signed installation packages are not included in this repository.

## Limits and privacy

This relies on an unofficial YouTube endpoint and can break when YouTube changes. Lower running CPU usage was observed in exploratory comparisons; reliable memory or total-traffic savings are not established. An intermittent title-start stutter remains unresolved. This is not a guarantee of zero video downloads.

See [privacy](docs/release/privacy.md) and [manual verification](docs/release/test-plan.md). No affiliation with YouTube or Mozilla.

## Rights

Copyright 2026 Lajos Hufnagel. All rights reserved; see [LICENSE](LICENSE). Public source visibility does not grant an open-source license. See [provenance](docs/release/provenance-and-license.md).
