# YouTube Summary with Gemini

A tiny, open-source Chrome extension (Manifest V3). While you're watching a
YouTube video, click one of four buttons under the player. It opens **Gemini**
with that action's prompt already filled in and sent, including the video's
title and link, so you can keep asking follow-up questions in the conversation.

The toolbar button still works too, and always does a plain **Summary**.

Website: https://yili.dev/projects/youtube_summary_with_gemini/

Website: https://yili.dev/projects/youtube_summary_with_gemini/

## Install

Install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/youtube-summary-with-gemi/alinedeonokgemjfeljbgcmcmhdefggg).

You must be **signed into Gemini** in the same browser for auto-fill to work.

### From source (load unpacked)

To run a local copy for development, install it from source:

1. Download or clone this repository.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the project folder.
5. Pin the extension (puzzle 🧩 icon → pin) so the toolbar button is visible.

> The icons are committed, so there's nothing to build. If you ever need to
> regenerate them, run `python3 tools/make_icons.py` (standard library only).
>
> After changing files, hit the **reload** arrow on the extension's card in
> `chrome://extensions` and refresh any open YouTube tab.

## Use

- On a YouTube video page (desktop `youtube.com`), four compact buttons appear
  under the title, next to the Share / Save row. Pick one:

  | Button | Mode id | What it asks Gemini for |
  | --- | --- | --- |
  | **总结** (Summary) | `summary` | A structured Chinese summary: core points, main arguments by topic, key facts/numbers/people, and where the author is speculating. |
  | **深入分析** (Deep analysis) | `deep` | The argument rebuilt step by step — premises, evidence, reasoning, conclusion — plus missing counter-examples and five good follow-up questions. |
  | **事实核查** (Fact check) | `factcheck` | Verifiable claims sorted into basically reliable / needs more evidence / misleading / clearly wrong / can't tell, with an overall credibility read. |
  | **技术解析** (Technical) | `technical` | Concepts, architecture and data flow, design trade-offs, failure modes, and a practical build-it-yourself route. |

- Clicking any of them opens a Gemini tab with that prompt typed in and sent.
  The conversation stays open for follow-ups, with the video as context.
- On a YouTube video, the toolbar icon shows a small **green dot** in the
  corner, and that means it's ready. Clicking it does the same thing as
  **总结** — the plain Summary action.
- Not on a YouTube video? No green dot, and clicking shows a brief `YT?` badge and
  does nothing.
- **Edit the prompts:** right-click the icon → **Options** (or
  `chrome://extensions` → Details → Extension options). Four tabs — 总结, 深入分析,
  事实核查, 技术解析 — each with its own text area, a per-prompt **Reset this
  prompt**, plus **Save all** and **Reset all to defaults**. The video's title
  and link are appended automatically to whichever prompt you pick, so your text
  never needs to mention them.

### Upgrading from the single-prompt version

Older versions kept one custom prompt under the storage key `instructions` and
the default was the one-liner `Summarize the video:`. Nothing is lost on
upgrade:

- If `instructions` exists and you never saved a **总结** prompt in the new
  format, your old prompt becomes your **总结** prompt (the options page says
  "Migrated your old summary prompt").
- The other three modes start from their new defaults.
- If you already saved prompts in the new format, they win; the legacy value is
  ignored and never overwrites anything.

The migration is resolved on the fly, so merely opening Options doesn't rewrite
your storage — your old prompt is adopted the first time you click **Save all**
(or the first time you click any button, which uses the migrated value
immediately).

## How it works

- `content-youtube.js` runs on YouTube. It reports the page URL to the service
  worker (on load and on YouTube's in-app navigations) so the toolbar icon can
  show the green dot, and on desktop watch pages it injects the four buttons.
  Clicking one only sends `{ type: 'OPEN_GEMINI', mode }` — the page never builds
  prompts or opens Gemini itself.
- `background.js` (service worker) owns one `openGeminiForVideo()` used by both
  entry points (toolbar click and the page buttons). It canonicalizes the URL to
  `https://www.youtube.com/watch?v=ID`, loads the prompt for the requested mode,
  appends title + link, stashes it in `chrome.storage.session`, and opens
  Gemini. Modes are validated against a fixed allowlist, so a page can't ask for
  an arbitrary prompt or storage key.
- `content-gemini.js` runs on Gemini, reads the stashed prompt, types it into the
  input box, and clicks send.

### The one fragile part

Gemini's web app has no official "prefill" URL, so auto-fill works by typing into
Gemini's input element directly, and Google can change that DOM without notice.
The content script uses **ordered fallback selectors**, and if it still can't find
the box it shows a **copy-and-paste toast** with the prompt. It degrades; it never
fails silently. If auto-fill ever stops working, update `EDITOR_SELECTORS` /
`SEND_SELECTORS` in `content-gemini.js`.

## Limitations

- Gemini can only watch **public** videos; private/unlisted ones fall back to the
  title and transcript if available.
- Requires being signed into Gemini with YouTube access enabled on the account.

## Develop

```bash
npm test                      # run the unit tests (node --test over test/)
npm run test:browser          # drive a real Chrome and check the page end to end
python3 tools/make_icons.py   # regenerate the icons
```

`npm run test:browser` launches its own throwaway Chrome profile, loads this
checkout unpacked, and asserts what actually reaches Gemini's editor after each
button click — plus the button placement, the chip styling, and the options
page. It needs Google Chrome installed and network access, takes about two
minutes, and writes screenshots to `output/playwright/` (gitignored). The unit
tests stay fast and offline; use this one when touching page integration.

`lib.js` holds the pure, testable logic: the four `PROMPT_MODES` with their
defaults, mode lookup and validation, the legacy-prompt migration
(`resolvePrompts`), URL canonicalization, title cleanup, and prompt building. It
has no DOM and no `chrome.*` calls, so the service worker, the options page, the
YouTube content script (via a dynamic import), and `node --test` all share the
exact same source of truth.

## Package for distribution

```bash
bash tools/pack.sh
```

Produces, in `dist/` (gitignored):

- `yt-gemini-summary.zip`: upload to the Chrome Web Store (manifest at the zip
  root, runtime files only).
- `yt-gemini-summary.crx`: a signed package for self-distribution.

The first run creates `key.pem` (the signing key) and reuses it afterward, so the
extension ID stays stable across rebuilds. `key.pem`, `dist/`, and `*.crx` are
gitignored, so **never commit the key.** Note: Chrome blocks `.crx` files installed
outside the Web Store for normal users, so for everyday use install it from the
Chrome Web Store.

## Privacy

The extension sends **no data to the developer** and has **no analytics, tracking,
or ads**. The only thing transmitted is the prompt you send to **your own** Gemini
session. The current video's title and link are placed into that prompt for you.
Your saved prompt and a short-lived session handoff live only on your device. Full
details: [PRIVACY.md](PRIVACY.md).

## License

MIT. See [LICENSE](LICENSE).
