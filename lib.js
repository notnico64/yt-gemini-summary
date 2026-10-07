// Pure helpers shared by the service worker, the options page, and the tests.
// No DOM, no chrome.*, so it stays import-safe for `node --test`.

// The four prompt modes, defined once and used everywhere:
//   - content-youtube.js builds one button per mode from its label,
//   - background.js validates an incoming mode against these ids,
//   - options.js renders one editable section per mode,
//   - the tests check the whole table.
// `defaultPrompt` is the text a fresh install starts with; the user's edited
// version lives in chrome.storage.sync under `prompts[id]`.
export const PROMPT_MODES = [
  {
    id: 'summary',
    label: '总结',
    defaultPrompt: `请分析这个 YouTube 视频，并用中文给出结构化总结。

要求：
1. 先用几句话概括视频的核心内容和结论。
2. 按主题列出主要观点。
3. 提取重要事实、数字、人物、产品、技术或事件。
4. 区分视频作者的观点与相对客观的事实陈述。
5. 如果视频内容存在明显不确定之处，请指出。
6. 保留本视频作为当前对话上下文，以便我随后继续提问。

不要只根据标题推测视频内容。如果你无法访问视频本身、字幕或足够的信息，请明确说明。`,
  },
  {
    id: 'deep',
    label: '深入分析',
    defaultPrompt: `请对这个 YouTube 视频进行深入分析，而不仅仅是摘要。

要求：
1. 概括视频的主题、核心主张和最终结论。
2. 重建作者的论证结构：前提、证据、推理过程、结论。
3. 找出最重要的信息、案例、数据和技术细节。
4. 指出哪些观点有充分支持，哪些主要属于推测、个人经验或主观看法。
5. 分析作者可能忽略的反例、替代解释、限制条件和背景因素。
6. 如果涉及多个方案、产品或观点，请进行比较。
7. 给出你认为最值得进一步追问的 5 个问题。
8. 保留视频内容作为后续对话上下文。

不要只根据标题或简介推测。如果无法访问足够的视频内容，请明确说明。`,
  },
  {
    id: 'factcheck',
    label: '事实核查',
    defaultPrompt: `请把这个 YouTube 视频当作需要核查的材料进行分析。

要求：
1. 简要概括视频的主要结论。
2. 提取其中可以被客观验证的重要事实性主张。
3. 将它们分类为：
   - 基本可靠
   - 需要更多证据
   - 可能误导
   - 明显错误
   - 无法判断
4. 对数字、日期、统计数据、医学/科学结论、技术规格、法律规定等尤其严格。
5. 区分事实、推论、预测、广告宣传和个人观点。
6. 对存在问题的主张解释为什么有问题，以及应该如何更准确地表述。
7. 如果需要外部资料才能真正核实，请明确指出应核查什么，不要假装已经验证。
8. 最后给出整体可信度评价。

保留本视频作为后续对话上下文。`,
  },
  {
    id: 'technical',
    label: '技术解析',
    defaultPrompt: `请从技术角度详细解析这个 YouTube 视频。

要求：
1. 先概括视频讨论的技术问题和最终结论。
2. 提取所有重要技术概念、术语、架构、规格、参数、软件、硬件或实现方法。
3. 解释它们之间的关系和工作原理。
4. 如果视频介绍了一个项目、系统或实现方案，请重建其架构和数据流。
5. 指出关键设计决策以及对应的 trade-offs。
6. 分析可能的瓶颈、边界条件、兼容性问题、安全问题和失败模式。
7. 判断作者的技术解释中有没有过度简化、遗漏或可能错误的地方。
8. 如果我要自己实现类似方案，给出一个实际可执行的实现路线。
9. 保留视频作为后续技术问答的上下文。

不要为了填充答案而猜测视频中没有提供的信息。`,
  },
];

// chrome.storage.sync keys. `prompts` holds all four prompts; `instructions`
// is the pre-1.1 single-prompt key we still read once, for migration.
export const PROMPTS_STORAGE_KEY = 'prompts';
export const LEGACY_PROMPT_STORAGE_KEY = 'instructions';

// id -> prompt mode, for O(1) lookup and the is-a-known-mode check.
const MODE_BY_ID = new Map(PROMPT_MODES.map((mode) => [mode.id, mode]));

// The default text for every mode, keyed by id.
export const DEFAULT_PROMPTS = Object.freeze(
  Object.fromEntries(PROMPT_MODES.map((mode) => [mode.id, mode.defaultPrompt]))
);

// Only these four ids are ever accepted from a web page.
export function isPromptMode(mode) {
  return typeof mode === 'string' && MODE_BY_ID.has(mode);
}

// The stock prompt for a mode, or null if the mode doesn't exist.
export function getDefaultPrompt(mode) {
  return isPromptMode(mode) ? MODE_BY_ID.get(mode).defaultPrompt : null;
}

// The prompt text to actually send for a mode: the user's saved text when they
// have one, otherwise the default. Returns null for an unknown mode so callers
// can reject it instead of quietly summarizing with the wrong prompt.
export function getPromptForMode(prompts, mode) {
  if (!isPromptMode(mode)) return null;
  const saved = prompts && typeof prompts === 'object' ? prompts[mode] : null;
  if (typeof saved === 'string' && saved.trim()) return saved;
  return MODE_BY_ID.get(mode).defaultPrompt;
}

// Turn whatever is in chrome.storage.sync into a complete four-prompt set.
// Pure: returns a new object and never writes, so both the options page and the
// service worker can call it.
//
// Rules, in order per mode:
//   1. the user's own saved prompt, if any;
//   2. for `summary` only, a legacy `instructions` value (pre-1.1 installs had
//      a single custom prompt) — this is what `migrated` reports;
//   3. the default prompt.
// An upgrade therefore never silently drops an old custom summary prompt, and
// never overwrites a prompt the user has already saved in the new format.
export function resolvePrompts(stored) {
  const data = stored && typeof stored === 'object' ? stored : {};
  const saved =
    data[PROMPTS_STORAGE_KEY] && typeof data[PROMPTS_STORAGE_KEY] === 'object'
      ? data[PROMPTS_STORAGE_KEY]
      : {};
  const legacy =
    typeof data[LEGACY_PROMPT_STORAGE_KEY] === 'string'
      ? data[LEGACY_PROMPT_STORAGE_KEY]
      : '';

  const prompts = {};
  let migrated = false;
  for (const { id } of PROMPT_MODES) {
    const own = saved[id];
    if (typeof own === 'string' && own.trim()) {
      prompts[id] = own;
    } else if (id === 'summary' && legacy.trim()) {
      prompts[id] = legacy;
      migrated = true;
    } else {
      prompts[id] = MODE_BY_ID.get(id).defaultPrompt;
    }
  }
  return { prompts, migrated };
}

// YouTube video ids are exactly 11 url-safe chars.
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

// Return the canonical https://www.youtube.com/watch?v=ID for any YouTube video
// URL (watch, youtu.be, shorts, live, embed, m./music.). Returns null for
// anything that isn't a single YouTube video (channels, feeds, other sites).
export function canonicalizeYouTubeUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, '');
  let id = null;

  if (host === 'youtu.be') {
    id = url.pathname.slice(1).split('/')[0];
  } else if (
    host === 'youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'music.youtube.com'
  ) {
    if (url.pathname === '/watch') {
      id = url.searchParams.get('v');
    } else {
      const m = url.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/);
      if (m) id = m[1];
    }
  } else {
    return null;
  }

  if (id && VIDEO_ID.test(id)) {
    return `https://www.youtube.com/watch?v=${id}`;
  }
  return null;
}

// Clean a browser tab title into a video title: drop the leading "(3) " unread
// count YouTube adds and the trailing " - YouTube".
export function stripTitle(title) {
  return (title || '')
    .replace(/^\(\d+\)\s*/, '')
    .replace(/\s*-\s*YouTube\s*$/, '')
    .trim();
}

// Build the full Gemini prompt. The video title + link are always appended so
// the user's saved instructions never have to remember them.
export function buildPrompt(instructions, title, url) {
  const body = (instructions || DEFAULT_PROMPTS.summary).trim();
  const tail = title ? `${title}\n${url}` : url;
  return `${body}\n\n${tail}`;
}
