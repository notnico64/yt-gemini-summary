import {
  PROMPT_MODES,
  DEFAULT_PROMPTS,
  PROMPTS_STORAGE_KEY,
  resolvePrompts,
} from './lib.js';

const $prompt = document.getElementById('prompt');
const $status = document.getElementById('status');
const $panel = document.getElementById('panel');
const $panelLabel = document.getElementById('panel-label');
const $panelNote = document.getElementById('panel-note');
const tabs = [...document.querySelectorAll('.tab')];

// Per-mode textarea state: what the user has typed, keyed by mode id.
const drafts = { ...DEFAULT_PROMPTS };
let active = PROMPT_MODES[0].id;

function flash(msg) {
  $status.textContent = msg;
  setTimeout(() => {
    if ($status.textContent === msg) $status.textContent = '';
  }, 2500);
}

function isDefault(mode) {
  return drafts[mode].trim() === DEFAULT_PROMPTS[mode].trim();
}

// The toolbar button is the plain Summary action; say so on that tab.
function note(mode) {
  return mode === 'summary' ? 'The toolbar button uses this prompt too.' : '';
}

function selectMode(mode) {
  drafts[active] = $prompt.value;
  active = mode;
  $prompt.value = drafts[mode];
  $panelLabel.textContent = PROMPT_MODES.find((m) => m.id === mode).label;
  $panel.setAttribute('aria-labelledby', `tab-${mode}`);
  $panel.dataset.mode = mode;
  $panel.dataset.isDefault = String(isDefault(mode));
  $panelNote.textContent = note(mode);
  for (const tab of tabs) {
    const selected = tab.dataset.mode === mode;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
}

async function load() {
  const stored = await chrome.storage.sync.get(null);
  const { prompts, migrated } = resolvePrompts(stored);
  Object.assign(drafts, prompts);

  $prompt.addEventListener('input', () => {
    drafts[active] = $prompt.value;
    $panel.dataset.isDefault = String(isDefault(active));
  });
  selectMode(active);

  // The legacy value is deliberately NOT written back here: the service worker
  // resolves it on the fly, so simply opening Options never counts as editing.
  // The first real "Save all" persists the migrated value in the new format.
  if (migrated) flash('Migrated your old summary prompt');
}

document.getElementById('save').addEventListener('click', async () => {
  drafts[active] = $prompt.value;
  await chrome.storage.sync.set({ [PROMPTS_STORAGE_KEY]: { ...drafts } });
  flash('Saved ✓');
});

document.getElementById('reset-one').addEventListener('click', () => {
  drafts[active] = DEFAULT_PROMPTS[active];
  $prompt.value = drafts[active];
  $panel.dataset.isDefault = 'true';
  flash(`Reset ${$panelLabel.textContent} — press Save all to keep`);
});

document.getElementById('reset-all').addEventListener('click', () => {
  for (const { id } of PROMPT_MODES) drafts[id] = DEFAULT_PROMPTS[id];
  selectMode(active);
  flash('All prompts reset — press Save all to keep');
});

for (const tab of tabs) {
  tab.addEventListener('click', () => selectMode(tab.dataset.mode));
  tab.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(tab);
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = tabs[(i + step + tabs.length) % tabs.length];
    next.focus();
    selectMode(next.dataset.mode);
  });
}

load();
