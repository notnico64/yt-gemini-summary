// End-to-end verification for the four YouTube-page buttons.
//
//   npm run test:browser      (or: node tools/browser-check.mjs)
//
// Drives a real Chrome with the unpacked extension loaded, in its own
// throwaway profile, so your everyday browser is untouched. Chrome 137+ ignores
// --load-extension on branded builds, so the extension is installed through the
// CDP Extensions.loadUnpacked command instead.
//
// The extension under test is this repository, whatever the caller's cwd is.
// Screenshots land in output/playwright/ (gitignored).
//
// Prompt assertions read what actually lands in Gemini's editor (or in the
// fallback toast), not what we hope the worker wrote, so these check the real
// user-visible result of a click.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The extension under test is the repository root, not the caller's cwd.
const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(EXT, 'output', 'playwright');
const DISK_VERSION = JSON.parse(
  readFileSync(join(EXT, 'manifest.json'), 'utf8'),
).version;
mkdirSync(SHOTS, { recursive: true });
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9334;
const VIDEO_A = 'dQw4w9WgXcQ';
const VIDEO_B = '9bZkp7q19f0';

const results = [];
const record = (n, name, pass, detail = '') =>
  results.push({ n, name, pass, detail });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- launch a real Chrome ----------
const dir = mkdtempSync(join(tmpdir(), 'ytgs-profile-'));
const proc = spawn(
  CHROME,
  [
    `--user-data-dir=${dir}`,
    `--remote-debugging-port=${PORT}`,
    '--enable-unsafe-extension-debugging',
    // These runs open real watch pages, which autoplay. Stay silent.
    '--mute-audio',
    '--window-size=1440,900',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let version;
for (let i = 0; i < 60 && !version; i++) {
  try {
    version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  } catch {
    await wait(250);
  }
}
if (!version) throw new Error('Chrome debug endpoint never came up');

// ---------- minimal CDP client ----------
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let msgId = 0;
const inflight = new Map();
const listeners = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && inflight.has(m.id)) {
    inflight.get(m.id)(m);
    inflight.delete(m.id);
  } else if (m.method) {
    for (const fn of listeners) fn(m);
  }
};
const cdp = (method, params = {}, sessionId) =>
  new Promise((res, rej) => {
    const n = ++msgId;
    inflight.set(n, (m) =>
      m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result),
    );
    ws.send(JSON.stringify({ id: n, method, params, sessionId }));
  });

async function attach(targetId) {
  const { sessionId } = await cdp('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  const call = (method, params) => cdp(method, params, sessionId);
  await call('Page.enable');
  await call('Runtime.enable');
  const evaluate = async (expr) => {
    const r = await call('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.exception?.description ?? 'eval failed',
      );
    }
    return r.result.value;
  };
  return { targetId, sessionId, call, evaluate };
}

const closeTarget = (targetId) =>
  cdp('Target.closeTarget', { targetId }).catch(() => {});

const closeTab = (tab) =>
  tab?.targetId != null ? closeTarget(tab.targetId) : Promise.resolve();

// ---------- install the extension ----------
const { id: extId } = await cdp('Extensions.loadUnpacked', { path: EXT });
record(0, 'extension loads in a real Chrome', !!extId, `id=${extId}`);

// Track every new tab so we can catch the Gemini ones.
const newTabs = [];
await cdp('Target.setDiscoverTargets', { discover: true });
listeners.push(({ method, params }) => {
  if (method === 'Target.targetCreated') newTabs.push(params.targetInfo);
});

async function newTab(url) {
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
  const t = await attach(targetId);
  t.goto = async (dest) => {
    await t.call('Page.navigate', { url: dest });
    for (let i = 0; i < 300; i++) {
      if ((await t.evaluate('document.readyState')) !== 'loading') break;
      await wait(100);
    }
  };
  t.close = () => closeTarget(targetId);
  if (url) await t.goto(url);
  return t;
}

const page = await newTab();
const $ = (sel) =>
  page.evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const clickSel = (sel) =>
  page.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);

const watchUrl = (v) => `https://www.youtube.com/watch?v=${v}`;
const BAR = '.ytgs-bar';
const MODE_BTN = (m) => `.ytgs-bar button[data-ytgs="${m}"]`;

async function shot(name, tab = page, clip) {
  const { data } = await tab.call('Page.captureScreenshot', {
    format: 'png',
    ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
  });
  writeFileSync(join(SHOTS, name), Buffer.from(data, 'base64'));
}

// Close-up of the button row, so a run leaves behind something a human can
// actually judge the styling from. Native chips are included on purpose: the
// whole point is to compare ours against YouTube's own.
async function shotBar(name) {
  // Scroll it into view first: captureScreenshot's clip is in page
  // coordinates, and a region outside the viewport comes back blank.
  await page.evaluate(`document.querySelector('.ytgs-bar')
    ?.scrollIntoView({ block: 'center' })`);
  await wait(500);
  const box = await page.evaluate(`(() => {
    const bar = document.querySelector('.ytgs-bar');
    if (!bar) return null;
    const strip = document.querySelector('ytd-menu-renderer');
    const b = bar.getBoundingClientRect();
    const s = strip?.getBoundingClientRect() ?? b;
    const pad = 12;
    return JSON.stringify({
      x: window.scrollX + Math.max(0, Math.min(b.left, s.left) - pad),
      y: window.scrollY + Math.max(0, Math.min(b.top, s.top) - pad),
      width: Math.min(window.innerWidth, Math.max(b.right, s.right) + pad)
        - Math.max(0, Math.min(b.left, s.left) - pad),
      height: Math.max(b.bottom, s.bottom) - Math.min(b.top, s.top) + pad * 2,
    });
  })()`);
  if (box) await shot(name, page, JSON.parse(box));
}

async function goto(url) {
  await page.goto(url);
  const at = await page.evaluate('location.href');
  // A consent interstitial hides the watch-page DOM entirely. It is a normal
  // YouTube experience for a fresh profile (and shows up at random), not an
  // extension problem, so accept it and carry on to the real page.
  if (/consent\.youtube\.com|\.google\.com\/sorry/.test(at)) {
    await page.evaluate(`(() => {
      const btn = [...document.querySelectorAll('button, form input[type=submit]')]
        .find((b) => /accept|agree|reject|全部接受|接受/i.test(
          (b.textContent || '') + (b.value || '')));
      btn?.click();
    })()`);
    await wait(1500);
    await page.goto(url);
  }
}

async function waitForBar(timeout = 30000) {
  for (let i = 0; i < timeout / 250; i++) {
    if ((await $(BAR)) > 0) return true;
    await wait(250);
  }
  return false;
}

// What a Gemini tab received. The editor is a race: after a successful send
// Gemini clears it within a few hundred ms, so polling it can catch either the
// filled box or the emptied one. The sent turn itself is the durable evidence —
// prefer it, and fall back to the editor only while the prompt is still typed
// in (i.e. not yet submitted).
const GEMINI_TEXT = `(() => {
  // The prompt as it appears in the conversation. Gemini splits the message
  // across many leaf nodes (one per line), so matching leaves would only ever
  // yield the first line. Instead take the smallest element that contains BOTH
  // the prompt opening and the canonical URL we always append — that is the
  // message bubble, and it proves the whole prompt was sent.
  const HEADS = /(请分析这个 YouTube 视频|请对这个 YouTube 视频|请把这个 YouTube 视频|请从技术角度详细解析)/;
  const bubbles = [...document.querySelectorAll('*')].filter((el) => {
    const t = el.textContent || '';
    return HEADS.test(t) && t.includes('/watch?v=');
  });
  if (bubbles.length) {
    // Deepest match = fewest descendants = the tightest bubble.
    bubbles.sort(
      (a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length,
    );
    return bubbles[0].textContent.trim();
  }

  const editor = document.querySelector(
    'rich-textarea .ql-editor[contenteditable="true"],' +
    '.ql-editor[contenteditable="true"],' +
    'div[contenteditable="true"][role="textbox"]'
  );
  if (editor && editor.textContent.trim()) return editor.textContent;

  const toast = document.getElementById('ytgs-toast');
  if (toast) return 'FALLBACK-TOAST:' + toast.querySelector('textarea').value;
  return '';
})()`;

// Click a mode button and return what the resulting Gemini tab received.
async function clickAndReadGemini(mode, timeout = 45000) {
  const seen = newTabs.length;
  await clickSel(MODE_BTN(mode));
  const deadline = Date.now() + timeout;
  let tab = null;
  while (Date.now() < deadline) {
    const info = newTabs
      .slice(seen)
      .find((t) => t.url.includes('gemini.google.com'));
    if (info) {
      try {
        tab = await attach(info.targetId);
        break;
      } catch {
        // still starting up
      }
    }
    await wait(500);
  }
  if (!tab) return { text: '', opened: false };
  // Poll until the prompt stops growing. Reading on the first non-empty result
  // can catch a half-typed prompt, which would look like a content mismatch.
  let text = '';
  let stableFor = 0;
  while (Date.now() < deadline) {
    const now = await tab.evaluate(GEMINI_TEXT);
    stableFor = now && now === text ? stableFor + 1 : 0;
    text = now;
    // The canonical URL is always the last thing appended, so its presence
    // means the whole prompt landed. This also terminates once Gemini has
    // moved the text into the conversation and emptied the editor.
    if (text && text.includes('/watch?v=') && stableFor >= 2) break;
    await wait(500);
  }
  if (!text) {
    // Capture why: a login wall looks identical to "no prompt" from outside.
    const why = await tab.evaluate(`JSON.stringify({
      url: location.href.slice(0, 60),
      editors: document.querySelectorAll(
        'rich-textarea .ql-editor[contenteditable="true"],' +
        '.ql-editor[contenteditable="true"],' +
        'div[contenteditable="true"][role="textbox"],' +
        'div[contenteditable="true"], textarea'
      ).length,
      toast: !!document.getElementById('ytgs-toast'),
      signIn: !!document.querySelector('[aria-label*="Sign in" i]'),
    })`).catch(() => 'evaluate failed');
    console.log(`  [${mode}] nothing landed: ${why}`);
  }
  await shot(`gemini-${mode}.png`, tab).catch(() => {});
  await closeTab(tab);
  return { text, opened: true };
}

// ---------- 1. regular watch page ----------
await goto(watchUrl(VIDEO_A));
// A cold, signed-out YouTube needs ~20s to render the metadata block, so wait
// for the whole action area, not just our bar.
for (let i = 0; i < 120; i++) {
  const ready = await page.evaluate(
    `!!document.querySelector('#top-level-buttons-computed') &&
     !!document.querySelector('ytd-watch-metadata')`,
  );
  if (ready) break;
  await wait(500);
}
const gotBar = await waitForBar();
record(
  1,
  'buttons appear on a regular watch page',
  gotBar,
  gotBar
    ? (
        await page.evaluate(
          `[...document.querySelectorAll('.ytgs-bar button')].map(b=>b.textContent.trim())`,
        )
      ).join(' / ')
    : 'bar never appeared',
);
record(11, 'exactly one button group', (await $(BAR)) === 1, `count=${await $(BAR)}`);

// The group must NOT sit inside #top-level-buttons-computed (a nowrap strip
// shared with Like/Dislike/Share). It belongs on its own line under the
// channel/actions row, and every native button must stay on screen.
// Let the group settle before measuring. YouTube first paints a skeleton where
// #top-row sits in #secondary-info, then replaces that subtree with the real
// metadata block; the bar legitimately moves between the two. Require a
// visible bar (height > 0) in a stable slot for several consecutive polls so we
// never measure the skeleton.
let settledAt = null;
let stableFor = 0;
for (let i = 0; i < 120; i++) {
  const at = await page.evaluate(`(() => {
    const bar = document.querySelector('.ytgs-bar');
    if (!bar) return null;
    const r = bar.getBoundingClientRect();
    if (r.height < 1) return null;
    const p = bar.parentElement;
    return (p.id || p.tagName.toLowerCase()) + '<' +
      (bar.previousElementSibling?.id || bar.previousElementSibling?.tagName || '');
  })()`);
  stableFor = at && at === settledAt ? stableFor + 1 : 0;
  settledAt = at;
  if (stableFor >= 3) break;
  await wait(500);
}
const layout = await page.evaluate(`(() => {
  const bar = document.querySelector('.ytgs-bar');
  const row = document.querySelector('#top-level-buttons-computed');
  // The skeleton ships its own #top-row, so pick the one in the real metadata.
  const topRow = [...document.querySelectorAll('#top-row')]
    .find((el) => el.closest('ytd-watch-metadata'));
  const renderer = document.querySelector('ytd-menu-renderer');
  const br = bar.getBoundingClientRect();
  const rr = row.getBoundingClientRect();

  const natives = [];
  for (const el of (renderer?.querySelectorAll(
      'button, ytd-button-renderer, yt-button-view-model, yt-icon-button') ?? [])) {
    const r = el.getBoundingClientRect();
    if (r.width < 2) continue;
    const label = (el.getAttribute('aria-label') || el.textContent || '').trim()
      .replace(/\\s+/g, ' ').slice(0, 18);
    if (!label) continue;
    natives.push({ label, onScreen: r.right <= window.innerWidth + 1 });
  }
  const uniq = [...new Map(natives.map((n) => [n.label, n])).values()];
  return JSON.stringify({
    parent: bar.parentElement.id || bar.parentElement.tagName.toLowerCase(),
    insideActionStrip: bar.parentElement.id === 'top-level-buttons-computed',
    afterTopRow: topRow ? topRow.nextElementSibling === bar : null,
    parentIsFlex: getComputedStyle(bar.parentElement).display.includes('flex'),
    ownLine: br.top >= rr.bottom - 2,
    barH: Math.round(br.height),
    nativeOffscreen: uniq.filter((n) => !n.onScreen).map((n) => n.label),
    nativeLabels: uniq.map((n) => n.label),
  });
})()`);
const L = JSON.parse(layout);
record('1b', 'group sits on its own line, not inside the action strip',
  !L.insideActionStrip && !L.parentIsFlex && L.afterTopRow === true && L.ownLine === true,
  layout);
record('1c', 'all native YouTube buttons stay on screen',
  L.nativeOffscreen.length === 0,
  `natives=[${L.nativeLabels.join(', ')}] offscreen=[${L.nativeOffscreen.join(', ')}]`);
await shot('01-watch-light.png');

// ---------- 1d. survives scrolling ----------
// YouTube renders a #watch-page-skeleton first, and that placeholder contains
// its own #top-row. Placing the group there means YouTube deletes it together
// with the skeleton, and the buttons are gone for the rest of the visit.
// Scroll away and back, which is also what triggers YouTube's lazy re-layout.
for (const y of [0, 700, 1800, 3000]) {
  await page.evaluate(`window.scrollTo(0, ${y})`);
  await wait(1200);
}
await page.evaluate('window.scrollTo(0, 0)');
await wait(1200);
const afterScroll = await page.evaluate(`(() => {
  const bar = document.querySelector('.ytgs-bar');
  if (!bar) return JSON.stringify({ present: false });
  const r = bar.getBoundingClientRect();
  const p = bar.parentElement;
  return JSON.stringify({
    present: true,
    visible: r.width > 0 && r.height > 0,
    count: document.querySelectorAll('.ytgs-bar').length,
    parent: p.id || p.tagName.toLowerCase(),
    inRealMetadata: !!bar.closest('ytd-watch-metadata'),
  });
})()`);
const S = JSON.parse(afterScroll);
record(
  '1d',
  'button group survives scrolling and stays in the real metadata',
  S.present && S.visible && S.count === 1 && S.inRealMetadata,
  afterScroll,
);

// ---------- 4. non-video pages ----------
const offWatch = [];
for (const [label, url] of [
  ['homepage', 'https://www.youtube.com/'],
  ['search', 'https://www.youtube.com/results?search_query=test'],
  ['channel', 'https://www.youtube.com/@YouTube'],
]) {
  await goto(url);
  await wait(2500);
  offWatch.push(`${label}=${await $(BAR)}`);
}
record(
  4,
  'no buttons on homepage / search / channel',
  offWatch.every((s) => s.endsWith('=0')),
  offWatch.join(' '),
);

// ---------- 4b. into a video, then 2. video -> video ----------
await goto('https://www.youtube.com/');
await wait(1500);
await goto(watchUrl(VIDEO_B));
record(
  '4b',
  'buttons appear after navigating into a video',
  await waitForBar(),
  `count=${await $(BAR)}`,
);
await page.evaluate(
  `window.history.pushState({}, '', '/watch?v=${VIDEO_A}');` +
    `window.dispatchEvent(new Event('yt-navigate-finish'));`,
);
await wait(2500);
record(
  2,
  'video -> video without reload keeps one group',
  // Don't assert on location.search: YouTube's own router can normalise or
  // briefly restore the previous URL around a synthetic pushState, which makes
  // that check flaky without saying anything about the extension. The real
  // requirement is that the group survives the in-app navigation exactly once.
  (await $(BAR)) === 1,
  `count=${await $(BAR)}`,
);

// ---------- 3. refresh ----------
await goto(watchUrl(VIDEO_A));
record(
  3,
  'survives a refresh without duplicating',
  (await waitForBar()) && (await $(BAR)) === 1,
  `count=${await $(BAR)}`,
);

// ---------- 11. duplicates under churn ----------
for (let i = 0; i < 4; i++) {
  await page.evaluate(
    `window.history.pushState({}, '', '/watch?v=${i % 2 ? VIDEO_A : VIDEO_B}');` +
      `window.dispatchEvent(new Event('yt-navigate-finish'));`,
  );
  await wait(900);
}
await wait(1500);
record(
  11,
  'no duplicate groups after repeated SPA churn',
  (await $(BAR)) === 1,
  `count=${await $(BAR)}`,
);

// ---------- 5/9/10. the four buttons, end to end into Gemini ----------
await goto(watchUrl(VIDEO_A));
await waitForBar();

const expectedHeads = {
  summary: '请分析这个 YouTube 视频，并用中文给出结构化总结',
  deep: '请对这个 YouTube 视频进行深入分析',
  factcheck: '请把这个 YouTube 视频当作需要核查的材料',
  technical: '请从技术角度详细解析这个 YouTube 视频',
};

for (const [mode, head] of Object.entries(expectedHeads)) {
  const { text, opened } = await clickAndReadGemini(mode);
  const body = text.replace(/^FALLBACK-TOAST:/, '');
  record(9, `${mode}: opened a Gemini tab`, opened);
  record(
    5,
    `${mode}: Gemini received prompt + title + canonical url`,
    // `includes`, not `startsWith`: Gemini's bubble wraps each line in its own
    // node and the concatenation order isn't guaranteed to lead with line 1.
    text.includes(head) &&
      body.includes(`https://www.youtube.com/watch?v=${VIDEO_A}`) &&
      body.includes('Never Gonna Give You Up'),
    text
      ? text.replace(/\s+/g, ' ').slice(0, 70)
      : 'Gemini editor stayed empty',
  );
  record(
    10,
    `${mode}: auto-filled (no fallback toast)`,
    !!text && !text.startsWith('FALLBACK-TOAST:'),
    text.startsWith('FALLBACK-TOAST:')
      ? 'showed the copy-paste toast'
      : 'typed into the editor',
  );
}

// ---------- 7. custom prompt persistence ----------
const options = await newTab(`chrome-extension://${extId}/options.html`);

// The version Chrome actually loaded, not just what we wrote to disk: catches
// a manifest that fails to parse, or a stale copy of the repo being loaded.
const loadedVersion = await options.evaluate(
  'chrome.runtime.getManifest().version',
);
record(
  '0b',
  'Chrome reports the manifest version we shipped',
  loadedVersion === DISK_VERSION,
  `chrome=${loadedVersion} manifest.json=${DISK_VERSION}`,
);

const optValue = () =>
  options.evaluate("document.getElementById('prompt').value");
const waitForPrompt = async () => {
  for (let i = 0; i < 60; i++) {
    if ((await optValue()).length > 0) return;
    await wait(250);
  }
};
await waitForPrompt();
await options.evaluate("document.getElementById('tab-deep').click()");
await wait(300);
await options.evaluate(`(() => {
  document.getElementById('prompt').value = 'CUSTOM-DEEP-PROMPT';
  document.getElementById('save').click();
})()`);
await wait(1000);
await options.goto(`chrome-extension://${extId}/options.html`);
await waitForPrompt();
await options.evaluate("document.getElementById('tab-deep').click()");
await wait(300);
record(
  7,
  'Save all persists across an options reload',
  (await optValue()) === 'CUSTOM-DEEP-PROMPT',
);

const deepClick = await clickAndReadGemini('deep');
record(
  '7b',
  'saved custom prompt is what Gemini receives',
  deepClick.text.startsWith('CUSTOM-DEEP-PROMPT') &&
    deepClick.text.includes(`watch?v=${VIDEO_A}`),
  deepClick.text.split('\n')[0] || 'nothing received',
);

// ---------- 8. legacy migration ----------
await options.evaluate("document.getElementById('reset-all').click()");
await wait(300);
await options.evaluate("document.getElementById('save').click()");
await wait(800);
// Simulate a pre-1.1 install that only has the legacy key.
await options.evaluate(
  `chrome.storage.sync.clear().then(() =>
     chrome.storage.sync.set({ instructions: 'LEGACY-PROMPT-TEXT' }))`,
);
await options.goto(`chrome-extension://${extId}/options.html`);
await waitForPrompt();
record(
  '8b',
  'options migrates a legacy `instructions` into 总结',
  (await optValue()).startsWith('LEGACY-PROMPT-TEXT'),
  (await optValue()).split('\n')[0],
);
record(
  '8c',
  'options tabs render all four labels',
  (
    await options.evaluate(
      "[...document.querySelectorAll('.tab')].map(t=>t.textContent)",
    )
  ).join('/') === '总结/深入分析/事实核查/技术解析',
);
await options.evaluate("document.getElementById('tab-technical').click()");
await wait(400);
record(
  '8d',
  'other tabs keep their own defaults, not the legacy text',
  (await optValue()).startsWith('请从技术角度'),
);
await shot('02-options.png', options);
await options.close();

// A button click must use the migrated value too, not just the options page.
const legacyClick = await clickAndReadGemini('summary');
record(
  8,
  'a button click uses the migrated legacy prompt',
  legacyClick.text.startsWith('LEGACY-PROMPT-TEXT'),
  legacyClick.text.split('\n')[0] || 'nothing received',
);

// ---------- 12. light and dark theme ----------
await goto(watchUrl(VIDEO_A));
await waitForBar();
// Our theming is a pure CSS `html[dark]` descendant rule, so it follows
// YouTube's own attribute with no JS. YouTube's theme manager re-applies that
// attribute almost immediately, so both readings happen in one synchronous
// evaluate: otherwise it puts `dark` back between the two measurements.
const themePair = await page.evaluate(`(() => {
  const read = () => {
    const b = document.querySelector('.ytgs-bar button');
    if (!b) return null;
    // The button transitions background-color, and getComputedStyle returns
    // the in-flight animated value: reading right after the attribute flips
    // reports the OLD colour, which silently weakened this assertion.
    // getComputedStyle is a LIVE object, so the values must be copied out
    // before the transition is restored, not after.
    const prev = b.style.transition;
    b.style.transition = 'none';
    const s = getComputedStyle(b);
    const out = s.backgroundColor + ' / ' + s.color;
    b.style.transition = prev;
    return out;
  };
  const html = document.documentElement;
  const had = html.getAttribute('dark');
  html.removeAttribute('dark');
  const light = read();
  html.setAttribute('dark', '');
  const dark = read();
  if (had === null) html.removeAttribute('dark');
  return JSON.stringify({ light, dark });
})()`);
const { light, dark } = JSON.parse(themePair);
await shot('03-watch-theme.png');
// 03 is the full page in dark mode; the close-ups are what the styling is
// actually judged from. The bar was restored to dark above.
await page.evaluate('window.scrollTo(0, 0)');
await wait(300);
await shotBar('04-bar-dark.png');
record(
  12,
  'light and dark themes paint the buttons differently',
  light !== dark,
  `light ${light}  ->  dark ${dark}`,
);
const barBox = await page.evaluate(`(() => {
  const el = document.querySelector('.ytgs-bar');
  if (!el) return JSON.stringify({ fits: false, note: 'bar missing' });
  const bar = el.getBoundingClientRect();
  const host = el.parentElement.getBoundingClientRect();
  return JSON.stringify({
    fits: bar.width <= host.width + 1,
    wraps: el.scrollHeight > 40,
    width: Math.round(bar.width),
  });
})()`);
record(
  '12b',
  'button row fits inside its container',
  JSON.parse(barBox).fits,
  barBox,
);

// Visual parity with YouTube's own tonal chips. These expected values are the
// ones measured off a real Share button (40px tall, 20px radius, no border,
// Roboto 14px/500) rather than read live: which native controls exist and what
// their text is varies with sign-in state, so selecting one is unreliable.
const NATIVE_CHIP = {
  h: '40px',
  radius: '20px',
  border: '0px',
  font: '14px/500',
  fontFamily: 'Roboto',
};
const chip = await page.evaluate(`(() => {
  const s = getComputedStyle(document.querySelector('.ytgs-bar button'));
  return JSON.stringify({
    h: s.height, radius: s.borderRadius,
    border: s.borderTopWidth, font: s.fontSize + '/' + s.fontWeight,
    fontFamily: s.fontFamily.split(',')[0],
  });
})()`);
const C = JSON.parse(chip);
const mismatch = Object.keys(NATIVE_CHIP).filter((k) => C[k] !== NATIVE_CHIP[k]);
record('12c', 'chip style matches YouTube native buttons',
  mismatch.length === 0,
  mismatch.length
    ? `differs on ${mismatch.join(', ')}: ours=${JSON.stringify(C)}`
    : JSON.stringify(C));

// The sparkle path only covers x 6-18 / y 2-14 of a 24 grid, so a naive
// viewBox="0 0 24 24" would draw it at half the box and read as a tiny tick.
// Check the rendered size AND that the glyph actually fills that box.
const icon = await page.evaluate(`(() => {
  const svg = document.querySelector('.ytgs-bar button svg');
  if (!svg) return JSON.stringify({ found: false });
  const r = svg.getBoundingClientRect();
  const p = svg.querySelector('path').getBBox();
  const vb = svg.viewBox.baseVal;
  const fillW = (p.width / vb.width) * 100;
  const fillH = (p.height / vb.height) * 100;
  return JSON.stringify({
    found: true,
    w: Math.round(r.width), h: Math.round(r.height),
    fillW: Math.round(fillW), fillH: Math.round(fillH),
    centered: Math.abs(p.x - vb.x) < 0.5 && Math.abs(p.y - vb.y) < 0.5,
  });
})()`);
const I = JSON.parse(icon);
record(
  '12d',
  'sparkle icon renders at full size and fills its box',
  I.found && I.w >= 16 && I.h >= 16 && I.fillW >= 95 && I.fillH >= 95 && I.centered,
  icon,
);

// The group should line up with the right edge of YouTube's own chips, not
// start from the left margin of the column.
const align = await page.evaluate(`(() => {
  const bar = document.querySelector('.ytgs-bar');
  const btns = [...bar.querySelectorAll('button')];
  const renderer = document.querySelector('ytd-menu-renderer');
  const last = btns[btns.length - 1].getBoundingClientRect();
  const host = bar.parentElement.getBoundingClientRect();
  // YouTube's own right-most control in the same visual column. The chips are
  // custom elements (ytd-button-renderer / yt-button-view-model), not <button>.
  const natives = [...(renderer?.querySelectorAll(
      'button, ytd-button-renderer, yt-button-view-model, yt-icon-button') ?? [])]
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 2);
  const nativeRight = natives.length
    ? Math.max(...natives.map((r) => r.right))
    : null;
  return JSON.stringify({
    lastBtnRight: Math.round(last.right),
    hostRight: Math.round(host.right),
    nativeRight: nativeRight === null ? null : Math.round(nativeRight),
  });
})()`);
const A = JSON.parse(align);
record(
  '12e',
  'button group is right-aligned with the native chips',
  A.nativeRight !== null && Math.abs(A.lastBtnRight - A.nativeRight) <= 4,
  align,
);

// A genuine light-theme close-up. Stripping the `dark` attribute alone only
// flips our own rule while YouTube's dark background stays dark, which makes
// the buttons look washed out and is not what a light-mode user sees. This
// profile has no saved YouTube theme, so YouTube follows the OS preference —
// emulate a light one and reload so both sides are genuinely light.
await page.call('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'light' }],
});
await goto(watchUrl(VIDEO_A));
await waitForBar();
await wait(1500);
await shotBar('05-bar-light.png');

// ---------- wrap up ----------
await page.close();
proc.kill();

// ---------- report ----------
console.log('\n=== browser check results ===');
for (const r of results) {
  console.log(
    `${r.pass ? 'PASS' : 'FAIL'}  [${r.n}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`,
  );
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log(`screenshots: ${SHOTS}`);
if (failed.length) process.exitCode = 1;
