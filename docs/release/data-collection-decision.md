# Data collection declaration

Date: 2026-10-16. Decision under review: `browser_specific_settings.gecko.data_collection_permissions` in
`extension/manifest.json`.

```json
"data_collection_permissions": { "required": ["websiteContent"] }
```

## Why this is declared at all

Since **3 November 2025** a new extension submitted to addons.mozilla.org must carry this key (MDN,
quoted below). The old answer "we collect nothing, so we declare nothing" is no longer possible.

`none` would be the cheapest declaration and would skip the consent text, which is exactly why it must not
be used here: `required: ["none"]` means the extension collects and transmits nothing outside itself. This
add-on sends the **video id of the page the user is watching** (plus a fixed client description) to
YouTube and receives a stream URL for it. That is a transmission of website content, the panel says so to
the user, and the primary source rules out declaring `none` for it.

Extension Workshop, *Firefox built-in consent for data collection and transmission*, "Updates":
> "When an extension is updated, Firefox only shows the added required data permissions, unless it’s the
> special none data type, because when the extension doesn’t collect any data, that doesn’t need to be
> notified to the user."

## The taxonomy, and why `websiteContent` is the entry

MDN, `browser_specific_settings` (retrieved 2026-10-16), verbatim:
> "`required` - : The data that the extension requires to be collected and transmitted for its operation.
> Must contain the value `none`, or one or more of `authenticationInfo`, `bookmarksInfo`,
> `browsingActivity`, `financialAndPaymentInfo`, `healthInfo`, `locationInfo`, `personalCommunications`,
> `personallyIdentifyingInfo`, `searchTerms`, `websiteActivity`, or `websiteContent`."
> "`optional` - : The data that the user can opt to provide. Can contain one or more of ...,
> `technicalAndInteraction`, `websiteActivity`, or `websiteContent`."

Each identifier was checked against what the shipped code actually does:

| Identifier | Declared | Reason from the code |
|---|---|---|
| `websiteContent` | **yes** | The POST body carries `videoId`, the identity of the page content the user is viewing, to the site that is already serving that page. Nothing is taken from any other page. |
| `browsingActivity` | no | That would be history or URLs beyond the open page. The URL is never read except for the current video id, and no cross-site activity exists. |
| `authenticationInfo` | no | No cookie, token or account information is read, sent or stored. The request uses `credentials: 'omit'`; the manifest has no `cookies` permission. |
| `personallyIdentifyingInfo` | no | No name, address, e-mail or account. The client description is a hard-coded device family, not the user. The one value that can be carried (`visitorData`) is issued by YouTube itself for the client session and goes only back to YouTube. |
| `searchTerms` | no | Search terms are never read (not from the search box, not from the URL). |
| `bookmarksInfo`, `locationInfo`, `healthInfo`, `financialAndPaymentInfo`, `personalCommunications` | no | None of these data is touched anywhere in the shipped files. |
| `technicalAndInteraction` | no | Only valid under `optional`, and this add-on has no optional collection: there is no consent flow to opt into anything, so the manifest has no `optional` key at all. |

## Taxonomy rechecked for submission preparation

The live [Mozilla taxonomy](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/#taxonomy)
was retrieved on 2026-10-16. Its websiteContent category covers visible or embedded site content,
including audio and request/response information. That supports the existing declaration for the
resolver's current video ID and player response. No declaration was changed.

Browsing activity separately covers visited websites, URLs/domains and page categories. This add-on
does not collect or transmit a browsing history, navigation list or activity report; it sends the
current video content identifier to the same service to play that content. The categorization remains
the project's documented interpretation and is subject to Mozilla review. No AMO approval is claimed.

The earlier missing-table retrieval caveat is closed by this live read. The resolver, media-element
credentials and in-memory visitorData treatment remain as described in privacy.md.

## Version support (and the one lint warning)

Extension Workshop, same page, "Data collection experience on older Firefox versions":
> "If your extension collects data and a user installs it on Firefox for desktop 139 or earlier, or
> Firefox for Android 141 or earlier, it must display a custom data collection experience. To allow for
> this, you have three options: Set strict_min_version to 140 and 142 for gecko and gecko_android
> respectively in the extension's manifest.json file's browser_specific_settings key."

The manifest follows option 1 for desktop: `gecko.strict_min_version: "140.0"`, no `gecko_android` key and
no `strict_max_version`. That is the "prefer desktop Firefox 140+" choice from the implementation brief.

`addons-linter` (10.8.0) reports one warning for this - the only finding of the whole lint run:

| | |
|---|---|
| Code | `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` |
| Message | "Manifest key not supported by the specified minimum Firefox for Android version" |
| Description | "`strict_min_version` requires Firefox for Android 140, which was released before version 142 introduced support for `browser_specific_settings.gecko.data_collection_permissions`." |
| File | `manifest.json` |
| Severity | warning (`errors 0`, `notices 0`) |

Why it is accepted rather than "fixed": MDN documents what a missing `gecko_android` key means -
> "To support Firefox for Android without specifying a version range, the `gecko_android` sub-key must be
> an empty object, i.e. `"gecko_android": {}`. Otherwise, the extension is only made available on desktop
> Firefox."

So this add-on is offered on **desktop Firefox only**; it makes no Android claim at all, which matches how
it was built and tested (a desktop YouTube page, a desktop profile). The warning exists because the
Android fallback would inherit the desktop minimum of 140.

**Open decision for the owner** (not taken here, because it changes what the add-on claims): either
(a) stay desktop-only as today and keep the single lint warning, or (b) declare Android support explicitly
by adding `"gecko_android": { "strict_min_version": "142.0" }` - the documented option 1 for Android, which
removes the warning - and then test on Firefox for Android before submitting, because declaring it is a
claim about a platform that has never been tried.

## What the user is shown

Firefox 140+ shows its own consent dialog for the declared `required` entry on install (and on an update
that only adds required entries). The add-on adds no dialog of its own; the panel's `Privacy` row repeats
the facts. Nothing here is optional, so there is no runtime consent request
(`browser.permissions.request({ data_collection: [...] })`) anywhere in the code.
The shipped files call no `browser.permissions` API and no storage API at all; the only hits for those
words are the comment and the panel string that *describe* the absence
(`grep -n 'permissions\.\|storage\.\|document\.cookie\|localStorage' extension/*.js` prints exactly two
lines of prose, both about cookies).

## Status

- Declaration: **in the manifest**, checked by the build's manifest pass (18 checks, including the two
  lists of accepted values taken from the local Firefox schema) and parsed without error by
  `addons-linter`.
- Reviewed by Mozilla: **no.** Nothing has been submitted, no account exists, no API key was requested.
- The declaration is the author's statement about this code; the AMO review decides whether it holds.
