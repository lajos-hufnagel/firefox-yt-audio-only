# Provenance and license

Date: 2026-10-16. Required by the implementation brief, item 6: check licensing and provenance, invent no
license and no author attribution, and name every unresolved rights decision explicitly.

## What is on disk

| Question | Answer |
|---|---|
| Is this a Git repository? | **Yes.** Repository: `lajos-hufnagel/firefox-yt-audio-only`; default branch `main`. |
| Is there a `LICENSE` file? | Yes. All rights reserved, chosen by the owner on 2026-10-16. No general license grant. |
| Is there an author, publisher or homepage field? | `author: "Lajos Hufnagel"`, explicitly confirmed by the owner on 2026-10-16. No homepage or developer field and no package.json. |
| Is there third-party code inside the extension? | No. `extension/` holds a hand-maintained manifest and two generated runtime files (`manifest.json`, `content.js`, `background.js`); `addons-linter` reports `"jsLibs": {}` (no known JS library detected) and `"unknownMinifiedFiles": []`. |
| Are there external resources? | No. No script tag, no font, no image, no remote import; the panel is built from DOM nodes and inline styles. |

## Where the protocol knowledge comes from

The add-on contains protocol facts, not copied code (recorded in
`docs/research/audio-only-logged-in.md`, section 10, and at the top of `spike/mv3-audio-only/content.js`):

- `yt-dlp/yt-dlp` (**Unlicense**) - protocol facts and quoted comments; the InnerTube request shape and
  the client values were verified against it. No code was taken over.
- `animeshkundu/youtube-audio` (**GPL-3.0**, read 2026-10-15) - read as a design reference only; **no code
  taken over**.
- `schdie/we_firefox_ytop_mv3` (**GPL-3.0**, read 2026-10-15) - read for the VISIONOS request shape and as
  a signed-in counter-example; **no code taken over**. If code were ever taken from it, this project would
  have to become GPL-3.0-compatible - nothing like that happened, so this project is **not** GPL-bound.

The request shape is also independently reproduced by the project's own console probe
(`spike/console-probe.js`) against a live page, which is where the recorded live-run evidence comes from.

## The identity of the add-on

- Gecko id: `audio-only-prototype@local.invalid`. Kept unchanged, as the brief asks ("Keep the stable
  Gecko ID unless there is a concrete reason to change it; document any change").
- It matches the documented id format (MDN: a string formatted like an e-mail address,
  `^[a-zA-Z0-9-._]*@[a-zA-Z0-9-._]+$`), and it is deliberately on the reserved `.invalid` top-level
  domain, so it does not claim a real domain. The string is not guaranteed globally unique; AMO checks add-on identity.
- It contains the word "prototype". That is an identity, not user-visible wording: the ID is never shown
  in the panel, the badge or the tooltip. The build's forbidden-shape scan checks the shipped **code** for
  prototype wording, and it treats the manifest's ID as the one deliberate exception.
- Retained for the first submission preparation on 2026-10-16. Its prototype wording is internal,
  not the app name. No new identity or migration is needed. AMO accepted this ID for the unlisted 0.1.3 submission; signed installation packages are not included in this repository.

## Owner decisions (2026-10-16)

1. **Rights: All Rights Reserved.** The owner explicitly chose this over MIT. The root LICENSE
   records a copyright notice and no general grant; it is not an open-source license.
2. **Copyright holder and manifest author: Lajos Hufnagel.** Explicitly confirmed by the owner.
   App name retained: Audio-only for YouTube. Source code is available in this repository; the rights notice remains unchanged.
3. **Right to distribute:** the code was written for this project; the protocol facts come from public
   documentation and permissively licensed sources (see above). No file in the package carries a third
   party's copyright notice, so no notice is lost by packaging it.
4. **Trademark and independence:** the add-on name "Audio-only for YouTube" contains a third-party trademark. It is
   descriptive and the add-on is not affiliated with YouTube, but AMO's review and Firefox's brand rules
   may want a clarification in the listing text. Not resolved here.

The owner decisions above resolve the previously open license and attribution choices.
Mozilla status is Approved and the signed XPI is installed in Firefox 158. Further review remains possible. This is a provenance record, not a legal determination.
