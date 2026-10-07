import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeYouTubeUrl,
  stripTitle,
  buildPrompt,
  PROMPT_MODES,
  DEFAULT_PROMPTS,
  PROMPTS_STORAGE_KEY,
  LEGACY_PROMPT_STORAGE_KEY,
  isPromptMode,
  getDefaultPrompt,
  getPromptForMode,
  resolvePrompts,
} from '../lib.js';

const ID = 'dQw4w9WgXcQ';
const CANON = `https://www.youtube.com/watch?v=${ID}`;

test('watch url strips extra params', () => {
  assert.equal(canonicalizeYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&t=42s&list=abc`), CANON);
});

test('watch url without www', () => {
  assert.equal(canonicalizeYouTubeUrl(`https://youtube.com/watch?v=${ID}`), CANON);
});

test('youtu.be short link', () => {
  assert.equal(canonicalizeYouTubeUrl(`https://youtu.be/${ID}?si=xyz`), CANON);
});

test('shorts', () => {
  assert.equal(canonicalizeYouTubeUrl(`https://www.youtube.com/shorts/${ID}`), CANON);
});

test('live', () => {
  assert.equal(canonicalizeYouTubeUrl(`https://www.youtube.com/live/${ID}`), CANON);
});

test('embed', () => {
  assert.equal(canonicalizeYouTubeUrl(`https://www.youtube.com/embed/${ID}`), CANON);
});

test('m.youtube watch', () => {
  assert.equal(canonicalizeYouTubeUrl(`https://m.youtube.com/watch?v=${ID}`), CANON);
});

test('music.youtube watch', () => {
  assert.equal(canonicalizeYouTubeUrl(`https://music.youtube.com/watch?v=${ID}`), CANON);
});

test('non-video youtube page returns null', () => {
  assert.equal(canonicalizeYouTubeUrl('https://www.youtube.com/feed/subscriptions'), null);
});

test('watch without v returns null', () => {
  assert.equal(canonicalizeYouTubeUrl('https://www.youtube.com/watch?list=abc'), null);
});

test('malformed id returns null', () => {
  assert.equal(canonicalizeYouTubeUrl('https://www.youtube.com/watch?v=tooShort'), null);
});

test('non-youtube host returns null', () => {
  assert.equal(canonicalizeYouTubeUrl(`https://example.com/watch?v=${ID}`), null);
});

test('garbage input returns null', () => {
  assert.equal(canonicalizeYouTubeUrl('not a url'), null);
});

test('stripTitle removes trailing - YouTube', () => {
  assert.equal(stripTitle('Great Talk - YouTube'), 'Great Talk');
});

test('stripTitle removes leading unread count', () => {
  assert.equal(stripTitle('(3) Great Talk - YouTube'), 'Great Talk');
});

test('stripTitle leaves a clean title alone', () => {
  assert.equal(stripTitle('Just A Title'), 'Just A Title');
});

test('buildPrompt appends title and url', () => {
  const out = buildPrompt('Summarize the video:', 'My Video', CANON);
  assert.match(out, /^Summarize the video:/);
  assert.match(out, /My Video/);
  assert.ok(out.includes(CANON));
});

test('buildPrompt puts the title line directly above the url', () => {
  const out = buildPrompt('Summarize the video:', 'My Video', CANON);
  assert.ok(out.endsWith(`My Video\n${CANON}`));
});

test('buildPrompt falls back to default when instructions empty', () => {
  const out = buildPrompt('', 'My Video', CANON);
  assert.ok(out.startsWith(DEFAULT_PROMPTS.summary.trim()));
});

test('buildPrompt without a title still includes the url', () => {
  const out = buildPrompt('Summarize the video:', '', CANON);
  assert.ok(out.endsWith(`\n\n${CANON}`));
});

test('there are exactly the four expected modes, in order', () => {
  assert.deepEqual(
    PROMPT_MODES.map((m) => [m.id, m.label]),
    [
      ['summary', '总结'],
      ['deep', '深入分析'],
      ['factcheck', '事实核查'],
      ['technical', '技术解析'],
    ]
  );
});

test('mode ids are unique and every default prompt is non-empty', () => {
  const ids = PROMPT_MODES.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const { id, defaultPrompt } of PROMPT_MODES) {
    assert.ok(defaultPrompt.trim(), `${id} has a default prompt`);
    assert.equal(DEFAULT_PROMPTS[id], defaultPrompt);
  }
});

test('DEFAULT_PROMPTS is a frozen snapshot, not the mode list', () => {
  assert.throws(() => {
    'use strict';
    DEFAULT_PROMPTS.summary = 'tampered';
  }, TypeError);
});

test('isPromptMode accepts the four ids and rejects everything else', () => {
  for (const { id } of PROMPT_MODES) assert.equal(isPromptMode(id), true);
  for (const bad of ['', 'nope', 'SUMMARY', '__proto__', 'constructor', null, undefined, 42, {}]) {
    assert.equal(isPromptMode(bad), false, `rejects ${JSON.stringify(bad)}`);
  }
});

test('getDefaultPrompt returns the default or null for an unknown mode', () => {
  assert.equal(getDefaultPrompt('deep'), PROMPT_MODES[1].defaultPrompt);
  assert.equal(getDefaultPrompt('nope'), null);
  assert.equal(getDefaultPrompt(undefined), null);
});

test('getPromptForMode prefers the saved prompt', () => {
  const prompts = { deep: 'My deep prompt' };
  assert.equal(getPromptForMode(prompts, 'deep'), 'My deep prompt');
});

test('getPromptForMode falls back to the default when unsaved or blank', () => {
  assert.equal(getPromptForMode({}, 'technical'), DEFAULT_PROMPTS.technical);
  assert.equal(getPromptForMode({ technical: '   ' }, 'technical'), DEFAULT_PROMPTS.technical);
  assert.equal(getPromptForMode(undefined, 'summary'), DEFAULT_PROMPTS.summary);
});

test('getPromptForMode returns null for an unknown mode', () => {
  assert.equal(getPromptForMode({}, 'bogus'), null);
  assert.equal(getPromptForMode({}, 'toString'), null);
});

test('getPromptForMode ignores prototype-pollution style keys', () => {
  assert.equal(getPromptForMode({}, 'constructor'), null);
  assert.equal(getPromptForMode(JSON.parse('{"__proto__":{"summary":"evil"}}'), 'summary'), DEFAULT_PROMPTS.summary);
});

test('resolvePrompts with empty storage returns all four defaults', () => {
  const { prompts, migrated } = resolvePrompts({});
  assert.deepEqual(prompts, { ...DEFAULT_PROMPTS });
  assert.equal(migrated, false);
});

test('resolvePrompts handles missing/garbage storage input', () => {
  for (const bad of [undefined, null, 'nope', 42]) {
    assert.deepEqual(resolvePrompts(bad).prompts, { ...DEFAULT_PROMPTS });
  }
});

test('resolvePrompts keeps saved prompts for every mode', () => {
  const saved = { summary: 'S', deep: 'D', factcheck: 'F', technical: 'T' };
  const { prompts, migrated } = resolvePrompts({
    [PROMPTS_STORAGE_KEY]: saved,
    [LEGACY_PROMPT_STORAGE_KEY]: 'legacy',
  });
  assert.deepEqual(prompts, saved);
  assert.equal(migrated, false, 'saved prompts win over the legacy value');
});

test('legacy instructions migrate into the summary prompt', () => {
  const { prompts, migrated } = resolvePrompts({
    [LEGACY_PROMPT_STORAGE_KEY]: 'My old custom prompt',
  });
  assert.equal(prompts.summary, 'My old custom prompt');
  assert.equal(migrated, true);
  assert.equal(prompts.deep, DEFAULT_PROMPTS.deep, 'other modes still get defaults');
});

test('legacy migration does not overwrite an already-saved summary prompt', () => {
  const { prompts, migrated } = resolvePrompts({
    [PROMPTS_STORAGE_KEY]: { summary: 'New summary' },
    [LEGACY_PROMPT_STORAGE_KEY]: 'Old prompt',
  });
  assert.equal(prompts.summary, 'New summary');
  assert.equal(migrated, false);
});

test('a partially saved prompt set is completed with defaults', () => {
  const { prompts, migrated } = resolvePrompts({
    [PROMPTS_STORAGE_KEY]: { deep: 'Deep only' },
  });
  assert.equal(prompts.deep, 'Deep only');
  assert.equal(prompts.summary, DEFAULT_PROMPTS.summary);
  assert.equal(prompts.factcheck, DEFAULT_PROMPTS.factcheck);
  assert.equal(prompts.technical, DEFAULT_PROMPTS.technical);
  assert.equal(migrated, false);
});

test('a blank legacy value does not count as a migration', () => {
  const { prompts, migrated } = resolvePrompts({
    [LEGACY_PROMPT_STORAGE_KEY]: '   ',
  });
  assert.equal(prompts.summary, DEFAULT_PROMPTS.summary);
  assert.equal(migrated, false);
});

test('resolvePrompts does not mutate the storage object it was given', () => {
  const stored = { [LEGACY_PROMPT_STORAGE_KEY]: 'Old', [PROMPTS_STORAGE_KEY]: { deep: 'D' } };
  const snapshot = JSON.stringify(stored);
  resolvePrompts(stored);
  assert.equal(JSON.stringify(stored), snapshot);
});

test('getPromptForMode composes with resolvePrompts for every mode', () => {
  const { prompts } = resolvePrompts({ [LEGACY_PROMPT_STORAGE_KEY]: 'Legacy' });
  for (const { id } of PROMPT_MODES) {
    const out = buildPrompt(getPromptForMode(prompts, id), 'My Video', CANON);
    assert.ok(out.includes(CANON));
  }
  assert.ok(buildPrompt(getPromptForMode(prompts, 'summary'), 'My Video', CANON).startsWith('Legacy'));
});
