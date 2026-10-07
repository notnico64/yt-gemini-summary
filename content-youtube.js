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

  // Where the button group goes: its own full-width line directly under the
  // channel/actions row. It deliberately does NOT go inside
  // #top-level-buttons-computed — that strip is `flex-wrap: nowrap` and already
  // holds Like/Dislike/Share, so four more chips there squeeze YouTube's own
  // Save and "..." buttons down to bare icons.
  //
  // `#top-row` is the channel + action row, but its parent is itself a flex
  // row during parts of YouTube's render, so inserting next to it lands us back
  // inline. We therefore climb to the first block-level ancestor and insert
  // there, which is what actually gives the group its own line.
  const ANCHOR_ROW = '#top-row';
  const FALLBACK_HOSTS = ['ytd-watch-metadata', '#meta'];

  // On a cold load the action row can take many seconds to render. Placing the
  // group in a fallback first and moving it later would make it visibly jump,
  // so wait this long for the anchor before settling for a fallback.
  const ANCHOR_WAIT_MS = 8000;

  // YouTube is a single page app: it swaps content in place and re-renders
  // chunks on its own, so we re-sync on its navigation events and on changes
  // inside the watch column. Both are cheap, and both no-op off watch pages.
  const RETRY_DELAYS_MS = [0, 120, 400, 1200, 3000, 6000];

  let lastReportedUrl = null;
  let bar = null;
  let syncTimer = 0;
  let observedRoot = null;
  let watchPageSince = 0;

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
        /* YouTube's own action chips sit at the right edge of the row; match
           them instead of starting from the left margin. */
        justify-content: flex-end;
        gap: 8px;
        /* Own line, tucked under the action row. */
        flex-basis: 100%;
        margin: 8px 0 12px;
      }
      /* Matches YouTube's own tonal chip buttons: 40px tall, 20px radius, no
         border, same background/hover, Roboto 14px/500. */
      .${NS}-btn {
        appearance: none;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        height: 40px;
        padding: 0 16px;
        border: 0;
        border-radius: 20px;
        font-family: "Roboto", "Arial", sans-serif;
        font-size: 14px;
        font-weight: 500;
        line-height: 1;
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
      .${NS}-btn svg { flex: none; opacity: 0.9; }
      /* YouTube flips a "dark" attribute on <html>; follow that, not the OS. */
      html[dark] .${NS}-btn {
        background: rgba(255, 255, 255, 0.1);
        color: #f1f1f1;
      }
      html[dark] .${NS}-btn:hover { background: rgba(255, 255, 255, 0.2); }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // A four-point sparkle, so the row reads as an AI action and not as stray
  // YouTube buttons. The path only spans x 6-18, y 2-14 of the usual 24x24
  // grid, so the viewBox is cropped to that box: rendering it in a 24 grid
  // would waste half the box on padding and draw a visibly tiny glyph.
  const SPARKLE_PATH =
    'M12 2c.6 3.4 2.6 5.4 6 6-3.4.6-5.4 2.6-6 6-.6-3.4-2.6-5.4-6-6 3.4-.6 5.4-2.6 6-6z';
  const SPARKLE_BOX = '6 2 12 12';

  function sparkle() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', SPARKLE_BOX);
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', SPARKLE_PATH);
    svg.appendChild(path);
    return svg;
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
      btn.append(sparkle(), document.createTextNode(label));
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

  // Where the group should sit: `{ parent, before }`, where `before === null`
  // means "append". Returns null when nothing suitable is on the page yet.
  function findSlot() {
    // Only the real metadata row counts. While the page is still loading,
    // YouTube ships a #watch-page-skeleton (and later a #meta-skeleton) that
    // also contains an element with id "top-row". Those are placeholders: the
    // skeleton is thrown away wholesale once the real data arrives, taking
    // anything we inserted with it, and the stale #meta-skeleton keeps a 0x0
    // #top-row around afterwards for querySelector to pick up. So require the
    // row to live inside ytd-watch-metadata.
    const anchor = [...document.querySelectorAll(ANCHOR_ROW)]
      .find((el) => el.closest('ytd-watch-metadata'));
    if (anchor) {
      // Climb out of any flex row: a flex parent would lay the group out
      // beside the native buttons instead of under them.
      let node = anchor;
      while (
        node.parentElement &&
        getComputedStyle(node.parentElement).display.includes('flex')
      ) {
        node = node.parentElement;
      }
      if (node.parentElement) {
        return { parent: node.parentElement, before: node.nextElementSibling };
      }
    }
    // Only accept a fallback once the anchor has had its chance.
    if (Date.now() - watchPageSince < ANCHOR_WAIT_MS) return null;
    // Same skeleton caveat: the placeholder #meta and the real one share an
    // id, so take the last (real) one and skip anything zero-sized.
    for (const selector of FALLBACK_HOSTS) {
      const candidates = [...document.querySelectorAll(selector)];
      const el = candidates.reverse().find(
        (c) => c.getBoundingClientRect().width > 0,
      );
      if (el) return { parent: el, before: null };
    }
    return null;
  }

  // True when the group already occupies exactly that slot. Re-inserting a node
  // that is already in place still fires a childList mutation, which would feed
  // the observer below and spin forever, so this check matters.
  function isPlaced(group, slot) {
    if (group.parentElement !== slot.parent) return false;
    return slot.before ? slot.before === group : group.nextElementSibling === null;
  }

  // Make the page match the current URL: the group exists exactly once on a
  // watch page, and nowhere else.
  function sync() {
    report();
    if (!isWatchPage() || PROMPT_MODES.length === 0) {
      bar?.remove();
      watchPageSince = 0;
      return;
    }
    // Start the patience clock on the first sync of this watch page, so an
    // in-app navigation gets the same grace period as a cold load.
    if (!watchPageSince) watchPageSince = Date.now();
    ensureStyle();
    const slot = findSlot();
    if (!slot) {
      bar?.remove();
      return;
    }
    const group = buildBar();
    if (!isPlaced(group, slot)) slot.parent.insertBefore(group, slot.before);
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
