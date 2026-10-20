# Prepare permanent installation — Cline implementation brief

Date: 2026-10-15. Prepare locally and stop before uploading anything to Mozilla.

## Language requirement

The app UI, extension messages and logs must be English. The owner subsequently clarified that
conversation with Codex should be German. Existing project documentation and code comments stay English
by convention; this is not a requirement to answer the owner in English. Preserve original quotations,
identifiers, protocol fields and historical measurements.

## Current evidence

The MV3 prototype lives in spike/mv3-audio-only/. The user reports that toggling and track
changes work. A manual network comparison showed 39.08 MB with video and 20.58 MB with
audio-only; an additional cleared 60-second window showed no new visible videoplayback
requests. Prefetching and switch-over traffic limit that comparison. The user observed
roughly half the SYSTEM CPU load with audio-only; there is no numeric Firefox-process
measurement. Do not claim guaranteed zero video bytes or a fixed saving percentage.

## Implementation

1. Preserve the working prototype. Prepare release runtime files in extension/. Do not
   redesign the architecture or add unrelated features.
2. Package only the manifest and required runtime resources. Exclude smoke tests,
   browser-proof, test-only exports, raw reports, signed URLs and development documents.
   Verify runtime behavior after removing test exports.
3. Use an English name and description suitable for a private test release. Keep the stable
   Gecko ID unless there is a concrete reason to change it; document any change.
   Do not add unnecessary permissions.
4. Write an English privacy description covering video IDs and client context sent to
   YouTube, server-returned visitorData held only in memory and reused within bounded
   requests, and media downloads from Googlevideo. No cookie-value reading or telemetry.
   Distinguish fetch credentials from media-element credentials.
5. Check current Mozilla data taxonomy and accurately declare data_collection_permissions;
   do not blindly declare none. Prefer desktop Firefox 140+ built-in consent rather than
   supporting older releases without a reason. Cite primary sources for the declaration.
6. Check licensing and provenance. Do not invent a license or author attribution. Identify
   any unresolved copyright-owner or license decision explicitly.
7. Check local web-ext availability; use reproducible build and lint commands, recording
   tool versions. Do not sign, create accounts, or request/store API keys.
8. Build a minimal UNSIGNED XPI/ZIP for later unlisted signing. Inspect archive contents and
   record SHA-256. Clearly label it as not yet permanently installable in standard Firefox.
9. Run relevant regression tests. Provide a temporary-load test for the release directory:
   toggle on/off, position, pause/seek and track changes. Node tests are not YouTube proof.
10. Report the package path, checksum, archive contents, lint result, actual test status,
    data permissions, English-language audit and unresolved decisions. Stop before any upload.

No commits, push, public AMO listing, or changes to Firefox signature enforcement.
Unlisted signing keeps the add-on out of the public catalog but still sends the package to
Mozilla. Signing will be authorized separately after the concrete package is reviewed.

## Primary sources

- https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/
- https://extensionworkshop.com/documentation/publish/self-distribution/
- https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/
- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings
