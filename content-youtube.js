// Two jobs on YouTube pages:
//   1. report the current URL so the service worker can light up the green
//      "ready" dot on the toolbar icon when you're on a video;
//   2. on desktop watch pages, add the four prompt buttons next to Share/Save.
// It never builds prompts and never opens Gemini itself: a click just sends
// { type: 'OPEN_GEMINI', mode } and the service worker does the rest.
//
// lib.js is loaded with a dynamic import: content scripts are not ES modules,
// and lib.js is listed in web_accessible_resources so the page world may read
// the same shared helpers the worker and tests use.
(async () => {
  let PROMPT_MODES = [];
  let canonicalizeYouTubeUrl = null;
  try {
    const lib = await import(chrome.runtime.getURL('lib.js'));
    PROMPT_MODES = lib.PROMPT_MODES;
    canonicalizeYouTubeUrl = lib.canonicalizeYouTubeUrl;
  } catch {
    // Shared helpers unavailable: keep the URL reporting below working so the
    // toolbar button still says "ready", just without the on-page group.
  }

  const NS = 'ytgs';
  const STYLE_ID = `${NS}-style`;

  // Where the button group goes, best first. Each is a container that exists on
  // the desktop watch page: the Share/Save pill row, then the like/dislike row,
  // then the channel row, then the metadata block as a last resort. Appending
  // (never wrapping) means we can't break YouTube's own layout.
  const HOST_SELECTORS = [
    '#top-level-buttons-computed',
    '#inline-actions-inner',
    '#owner-buttons',
    '#meta',
  ];

  // YouTube is a single page app: it swaps content in place and re-renders
  // chunks on its own, so we re-sync on its navigation events and on changes
  // inside the watch column. Both are cheap, and both no-op off watch pages.
  const RETRY_DELAYS_MS = [0, 120, 400, 1200];

  let lastReportedUrl = null;
  let bar = null;
  let syncTimer = 0;
  let observedRoot = null;

  function report() {
    if (location.href === lastReportedUrl) return;
    lastReportedUrl = location.href;
    try {
      chrome.runtime.sendMessage({ type: 'YT_URL', url: location.href });
    } catch {
      // service worker asleep or extension reloading, so the next nav retries.
    }
  }

  // Buttons belong on desktop watch pages only. m.youtube.com has a different
  // layout with nowhere sensible to sit, so those tabs keep the toolbar button.
  function isWatchPage() {
    return (
      !!canonicalizeYouTubeUrl &&
      location.hostname === 'www.youtube.com' &&
      location.pathname === '/watch' &&
      !!canonicalizeYouTubeUrl(location.href)
    );
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .${NS}-bar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin: 8px 0 4px;
        font-family: "Roboto", "YouTube Sans", system-ui, sans-serif;
      }
      .${NS}-btn {
        appearance: none;
        cursor: pointer;
        font: inherit;
        font-size: 13px;
        font-weight: 500;
        line-height: 1;
        padding: 8px 14px;
        border-radius: 18px;
        border: 1px solid rgba(0, 0, 0, 0.1);
        background: rgba(0, 0, 0, 0.05);
        color: #0f0f0f;
        white-space: nowrap;
        transition: background-color 120ms ease, opacity 120ms ease;
      }
      .${NS}-btn:hover { background: rgba(0, 0, 0, 0.1); }
      .${NS}-btn:active { opacity: 0.7; }
      .${NS}-btn:focus-visible {
        outline: 2px solid #3ea6ff;
        outline-offset: 2px;
      }
      .${NS}-btn[disabled] { opacity: 0.6; cursor: progress; }
      /* YouTube flips a "dark" attribute on <html>; follow that, not the OS. */
      html[dark] .${NS}-btn {
        background: #272727;
        border-color: rgba(255, 255, 255, 0.2);
        color: #f1f1f1;
      }
      html[dark] .${NS}-btn:hover { background: #3f3f3f; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function buildBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className = `${NS}-bar`;
    bar.dataset.ytgs = 'actions';
    for (const { id, label } of PROMPT_MODES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `${NS}-btn`;
      btn.dataset.ytgs = id;
      btn.textContent = label;
      btn.title = `Ask Gemini: ${label}`;
      btn.addEventListener('click', () => {
        btn.disabled = true;
        try {
          chrome.runtime.sendMessage({ type: 'OPEN_GEMINI', mode: id });
        } catch {
          // worker unavailable; re-enable so the click isn't lost.
        }
        setTimeout(() => {
          btn.disabled = false;
        }, 1200);
      });
      bar.appendChild(btn);
    }
    return bar;
  }

  function findHost() {
    for (const selector of HOST_SELECTORS) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  // Make the page match the current URL: the group exists exactly once on a
  // watch page, and nowhere else.
  function sync() {
    report();
    if (!isWatchPage() || PROMPT_MODES.length === 0) {
      bar?.remove();
      return;
    }
    ensureStyle();
    const host = findHost();
    if (!host) {
      bar?.remove();
      return;
    }
    const group = buildBar();
    // Re-appending an already-placed node is a no-op move only when the host
    // changed, which is exactly when we want to move it.
    if (group.parentNode !== host) host.appendChild(group);
    observe();
  }

  // Coalesce bursts of DOM changes into one sync.
  function scheduleSync() {
    // Off watch pages the group must stay absent, so there's nothing to watch.
    if (!isWatchPage()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, 100);
  }

  // Narrow observer: only the watch column, and only child changes. If the page
  // isn't a watch page, sync() exits immediately. YouTube can replace that
  // column wholesale during an in-app navigation, so re-attach when it changes.
  function observe() {
    const root = document.querySelector('#primary-inner') || document.body;
    if (!root || root === observedRoot) return;
    observedRoot = root;
    new MutationObserver(scheduleSync).observe(root, {
      childList: true,
      subtree: true,
    });
  }

  function start() {
    report();
    for (const delay of RETRY_DELAYS_MS) setTimeout(sync, delay);
    observe();
    // YouTube fires this when it finishes an in-app navigation.
    window.addEventListener('yt-navigate-finish', sync, true);
    window.addEventListener('yt-page-data-updated', scheduleSync, true);
    // Belt-and-suspenders for history.pushState navigations.
    window.addEventListener('popstate', sync);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
