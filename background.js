// Service worker (module). On toolbar click: if the active tab is a YouTube
// video, build the prompt, stash it, and open Gemini. The content script picks
// it up there.
import {
  canonicalizeYouTubeUrl,
  stripTitle,
  buildPrompt,
  resolvePrompts,
  getPromptForMode,
  isPromptMode,
} from './lib.js';

const PENDING_KEY = 'pendingGeminiPrompt';
const GEMINI_URL = 'https://gemini.google.com/app';

// session storage is TRUSTED_CONTEXTS-only by default; the content script runs
// in an untrusted context, so widen access or it can't read the prompt.
async function ensureSessionAccess() {
  try {
    await chrome.storage.session.setAccessLevel({
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
    });
  } catch {
    // Older Chrome without setAccessLevel: the content script still reads in many
    // builds; the clipboard fallback covers the rest.
  }
}
ensureSessionAccess();
chrome.runtime.onInstalled.addListener(ensureSessionAccess);
chrome.runtime.onStartup?.addListener(ensureSessionAccess);

async function flashBadge(tabId, text) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#E62117' });
    await chrome.action.setBadgeText({ tabId, text });
    setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 2500);
  } catch {
    // tab may be gone; ignore.
  }
}

// Toolbar icon variants: plain, and one with a small green "ready" dot baked in.
// We swap the whole icon per-tab (Chrome's native badge can't be made a subtle
// circle), so the dot only shows on tabs that are on a YouTube video.
const ICON_OFF = { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
const ICON_ON = { 16: 'icons/icon16-on.png', 48: 'icons/icon48-on.png', 128: 'icons/icon128-on.png' };

async function setReadyIcon(tabId, ready) {
  try {
    await chrome.action.setIcon({ tabId, path: ready ? ICON_ON : ICON_OFF });
  } catch {
    // tab gone / icon missing; ignore.
  }
}

// The YouTube content script reports the current URL; show the green dot when
// it's a video we can summarize.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'YT_URL' && sender.tab?.id != null) {
    setReadyIcon(sender.tab.id, !!canonicalizeYouTubeUrl(msg.url));
  }
});

// First install: Chrome has no API to pin an extension, so open a short page
// that tells the user how to pin it and confirms it's ready.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') }).catch(() => {});
  }
});

// The one place that turns a YouTube video into an open Gemini conversation.
// Both entry points (toolbar click, page button message) funnel through here so
// there's a single place that canonicalizes the URL, picks the prompt, and does
// the storage hand-off. Returns false when the URL isn't a single video.
async function openGeminiForVideo(url, title, mode) {
  const canonical = canonicalizeYouTubeUrl(url || '');
  if (!canonical) {
    return false;
  }

  const stored = await chrome.storage.sync.get(null);
  const { prompts } = resolvePrompts(stored);
  const instructions = getPromptForMode(prompts, mode);
  if (instructions == null) return false;
  const prompt = buildPrompt(instructions, stripTitle(title), canonical);

  await ensureSessionAccess();
  await chrome.storage.session.set({ [PENDING_KEY]: { prompt, ts: Date.now() } });
  await chrome.tabs.create({ url: GEMINI_URL });
  return true;
}

chrome.action.onClicked.addListener(async (tab) => {
  const opened = await openGeminiForVideo(tab?.url, tab?.title, 'summary');
  if (!opened) await flashBadge(tab?.id, 'YT?');
});

// The four on-page buttons send { type: 'OPEN_GEMINI', mode }. The page is
// untrusted input: check who sent it, that they're on a YouTube video, and that
// the mode is one of our four ids. Never trust a prompt or storage key from a
// page — the mode only selects which stored prompt we load ourselves.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'OPEN_GEMINI') return;

  const tab = sender.tab;
  if (!tab || tab.id == null) return;
  if (!canonicalizeYouTubeUrl(tab.url || '')) return;
  if (!isPromptMode(msg.mode)) return;

  openGeminiForVideo(tab.url, tab.title, msg.mode).catch(() => {
    flashBadge(tab.id, 'YT?');
  });
});
