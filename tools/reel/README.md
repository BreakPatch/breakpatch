# Breakpatch reel

> **Before posting (2026-10-02):** two things changed after these cuts were made.
> - The "Describe the next step" box is off (until the AI test agent, public #10). Seconds 8–14 of
>   `breakpatch-reel-45s.mp4` show it: re-take the recorder screens (clicking on the page, the
>   proposal, Confirm) with `refresh-screens.sh` and re-cut that scene. `POSTS.md` no longer mentions it.
> - v0.1.0 is Community only; Team and Business are "TBD". The 22–26 s Team scene and
>   `tease-fixes-itself.mp4` should wait for Team, or say "coming later".
> - The rendered videos aren't in git (`out/` is ignored): render them with the recipes, and keep
>   the files outside the repo or attach them to a release.


The product reel and the teasers for Breakpatch, made from the real app. Every frame is drawn by
`index.html` (one canvas, one function of time) and captured with Playwright; the soundtrack is
synthesised by `audio_cut.py`; ffmpeg joins them. No editing software, so any cut can be remade from
a small JSON file.

| File in `out/` | Length | Use |
|---|---|---|
| `breakpatch-reel-45s.mp4` | 44.5 s | The main cut: website, README, demo calls. |
| `tease-flutter-web.mp4` | 18 s | **For the Flutter community.** The hook, the logo, "Flutter web draws to a canvas. Breakpatch looks at the screen", open source, the install line. |
| `tease-find-what-breaks.mp4` | 17.5 s | General tease: break, logo, the AI finds the button, the report, the fix, the install line. |
| `tease-fixes-itself.mp4` | 16.5 s | General tease for the Team features: what broke, and the fix. |

1920 × 1080, 30 fps, H.264 and AAC. The picture stays in Breakpatch's own look (the tokens in
`site/assets/site.css`, Bricolage Grotesque and JetBrains Mono, the ear mark from `favicon.svg`).

## Make them

```sh
cd tools/reel
npm ci && npx playwright-core install chromium     # once; or set CHROMIUM=/path/to/chrome
pip install -r requirements.txt                    # numpy and scipy, for the soundtrack
./make.sh                                          # all four, into out/ (about half an hour on 4 cores)
./make.sh tease-flutter                            # just one recipe from recipes/
```

`ffmpeg` and `node` 22 are needed. Set `WORKERS=2` on a small machine.

`./contact-sheet.sh DIR sheet.jpg 3` tiles a folder of stills
(`node render.js stills recipes/main.json DIR 3.5 12.0 …`), so a cut can be checked without rendering it.

## How a cut is made

`recipes/*.json` lists which parts of the master timeline (0 to 42 s) play, in order, and where to
hold the picture:

```jsonc
{ "name": "tease-flutter-web",
  "segments": [[1.5, 4.0], [5.0, 7.5], [36, 42], [30, 33], [26, 30]],   // master seconds, played in this order
  "holds": [[11.5, 1.0]],                                               // [at, seconds added]: the main cut holds on the AI's question
  "drone": true }                                                       // a short pad before the first beat
```

| Master time | Scene |
|---|---|
| 0–8 | The app under test works, shatters, and the pieces become the ear mark and the wordmark. |
| 8–14 | The recorder (real screens): describe a step, the AI finds it, Confirm, the step is named. |
| 14–18 | On-device AI (the real AI assistant settings). |
| 18–22 | A live run, then the real failed report. |
| 22–26 | Team: the real "Fixed automatically" report and the suites. |
| 26–30 | The install line. |
| 30–36 | Open source: Free, Open source, Apache 2.0, the repository layout, Break it. Patch it. |
| 36–42 | Flutter web: a canvas has nothing for a selector to find; Breakpatch looks at the screen; and the other frameworks. |

Seams between parts that don't follow each other get a flash and a hit. Holds keep the music's beat
grid (120 BPM) intact. `audio_cut.py` reads the same recipe, so every sound lands on its moment.

## The pictures of the app

`assets/` holds real screenshots of the app, taken from its demo preview (`npm run dev`, then
`?demo`) with the Team module linked, in dark mode at 1280 × 800 and 2x, plus the typing strips for
the describe box. Re-take them after a UI change:

```sh
scripts/link-team.sh && (cd app && npm ci && npm run dev)   # port 1420
tools/reel/refresh-screens.sh
```

The demo has a fixed clock, a simulated engine and sample data ("Riverside block B"). What the reel
adds on top of the screens (the cursor, the outlines, the scan, the highlight boxes) is drawn by
`index.html`, at positions measured from the screens.

## What is invented, and what each claim rests on

Invented, for the story: the web app being tested (**Paperplane**, a made-up app), the Slack message
and the `breakpatch-ci` terminal in the Team scene (shaped like the site's own example), and the two
small boxes that show a selector failing and Breakpatch finding the button.

| On screen | Comes from |
|---|---|
| Tests run on your Mac, no cloud, no API keys, no per-run fees, works offline | `README.md`, `site/index.html` |
| Qwen3-VL 4B through MLX | `README.md` |
| The describe box, Confirm / Try again, steps named by the AI, the report, Re-record this step, Copy as Markdown | the real screens in `assets/` |
| "Fixed automatically", Accept new position, suites, schedules, Slack, CI | the real screens in `assets/`; these are Breakpatch Team |
| **Flutter web draws to a canvas**, and Breakpatch works with it | `docs/manual.md` ("draws everything itself, like Flutter apps and canvas pages. Either way it clicks a spot on the screen and checks the step on the screen"; "Flutter web apps. Replay works…"), and `engine/src/breakpatch_engine/dom/router.py` (a Flutter host is recognised and the page is treated as Visual; its note says every DOM-based locator found 0% of targets on Flutter and canvas pages) |
| "And with every other web framework" | Breakpatch drives a browser through screenshots, mouse and keyboard and never uses CSS or XPath selectors (`README.md`, `CONTRIBUTING.md`); it tests anything your Mac can open |
| No selectors. Pixels decide. | `CONTRIBUTING.md` |
| Free, open source, Apache 2.0, the repository layout, issues and pull requests welcome | `README.md`, `LICENSE`, `CONTRIBUTING.md` |
| Public release coming soon | `site/index.html` (the pre-launch notice). Change it in `index.html` on launch day. |

Things the reel deliberately does **not** claim:

- Self-healing on Flutter. `docs/manual.md` says there is no automatic fixing for Flutter buttons that
  moved ("nothing can read inside a canvas"). The Flutter tease shows finding and checking, not fixing.
- A way to install it today. While the repository is private the install command can't see the
  releases. The end card says "Public release coming soon"; `index.html` has the line to change.
- Prices.

## Files

- `index.html`: all scenes, easing, and the cut and hold machinery. Edit copy here (search for `maskLine(`).
- `render.js`: `frames` (a whole cut), `stills` (a few moments), `dur` (a cut's length).
- `audio_cut.py`: the synthesised track (kick, bass, pads, arps, hits and UI sounds), mapped into each cut.
- `capture-screens.js`, `refresh-screens.sh`: the real screens.
- `fonts/`: Bricolage Grotesque and JetBrains Mono (SIL Open Font License 1.1), as the website uses them.
- `POSTS.md`: copy for announcing the teasers.
