/*!
 * Audio-only for YouTube - background event page.
 *
 * Job: nothing but the switch. The toolbar button and the keyboard shortcut toggle the mode in the
 * active YouTube tab, and the badge mirrors the content script's status. This file performs NO
 * network request, reads no cookie and stores nothing.
 *
 * This is the release build of a proven prototype: the same runtime code, without the console
 * test surface the development tree uses.
 */
'use strict';

const BADGE = {
  off: '',
  resolving: '...',
  restoring: '...',
  active: 'ON',
  unverified: '?',
  error: '!',
  'restore-failed': '!',
};

const BADGE_COLOR = {
  resolving: '#b26a00',
  restoring: '#b26a00',
  active: '#2e7d32',
  unverified: '#b26a00',
  error: '#c0392b',
  'restore-failed': '#c0392b',
  off: '#5f6368',
};

function badgeKind(status) {
  if (!status || typeof status !== 'object') return 'off';
  if (status.mode === 'error') return 'error';
  // A hand-back that did not work is not "off": the page is NOT back to normal, so the badge must
  // show the same warning sign as any other failure instead of an empty badge.
  if (status.mode === 'restore-failed') return 'restore-failed';
  if (status.mode === 'restoring') return 'restoring';
  if (status.mode === 'resolving') return 'resolving';
  if (status.mode === 'active') return status.verified ? 'active' : 'unverified';
  return 'off';
}

// What the toolbar tooltip says. The title is user-facing text, so it is English.
const BADGE_TITLE = {
  off: 'off',
  resolving: 'resolving',
  restoring: 'returning to video',
  active: 'audio-only is playing',
  unverified: 'audio-only, playback not verified',
  error: 'error',
  'restore-failed': 'back to normal playback failed - reload the page (F5)',
};

async function paint(tabId, kind) {
  const text = Object.prototype.hasOwnProperty.call(BADGE, kind) ? BADGE[kind] : '';
  try {
    await browser.action.setBadgeText({ tabId, text });
    await browser.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR[kind] || '#5f6368' });
    await browser.action.setTitle({
      tabId,
      title: 'Audio-only for YouTube: ' +
        (Object.prototype.hasOwnProperty.call(BADGE_TITLE, kind) ? BADGE_TITLE[kind] : kind),
    });
  } catch (e) {
    // A tab can disappear between the query and the paint - not worth a message.
  }
}

async function toggleActiveTab() {
  let tab = null;
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0];
    if (!tab || tab.id === undefined) return;
    if (!String(tab.url || '').startsWith('https://www.youtube.com/')) {
      console.debug('[audio-only] not a youtube.com tab - nothing to toggle');
      await paint(tab.id, 'off');
      return;
    }
    // The reply wraps the redacted status as { ok, result, status }. The message name is the one the
    // content script really implements (see content.js, chrome.runtime.onMessage) - dot, not colon.
    const reply = await browser.tabs.sendMessage(tab.id, { type: 'audio-only.toggle' });
    await paint(tab.id, badgeKind(reply && reply.status));
  } catch (e) {
    // No content script in that tab (page loaded before the add-on, or the page is not covered).
    console.debug('[audio-only] no content script answered: ' + ((e && e.name) || 'Error'));
    if (tab && tab.id !== undefined) await paint(tab.id, 'off');
  }
}

browser.action.onClicked.addListener(() => toggleActiveTab());

browser.commands.onCommand.addListener((name) => {
  if (name === 'toggle-audio-only') return toggleActiveTab();
});

browser.runtime.onMessage.addListener((msg, sender) => {
  // The content script sends { type: 'audio-only.state', state: brief() } - the field is `state`.
  if (!msg || msg.type !== 'audio-only.state' || !sender || !sender.tab) return undefined;
  paint(sender.tab.id, badgeKind(msg.state));
  return undefined;                                  // fire and forget
});
