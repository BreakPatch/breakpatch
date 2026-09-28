# Breakpatch: developer handoff

Where to find everything, and the values to build with. The designs are the source of truth; this file lists what you'd otherwise have to measure.

## Files

| What | Where |
|---|---|
| Product spec | `uploads/UI AI tests/vision-recorder-spec.md` |
| Screen requirements | `uploads/UI AI tests/vision-recorder-ui-requirements.md` |
| Style guide (tokens, type, components, light + dark) | `screens/MoraVision - Style Guide.dc.html` |
| All screens, dark and light | pages `0`–`9` (sources in `screens/`) |
| Clickable prototype | `6 - Prototype.dc.html` |
| Security rules | `firebase/firestore.rules` in the private `BreakPatch/breakpatch-team` repo (Team edition) |
| README, manual, GitHub text | `docs/` |
| Website (GitHub Pages) | `site/` |

The design bundle was made when the product was called MoraVision, so its file names (`screens/MoraVision - …`) still use the old name. Everything built from it says Breakpatch.

## Screen map

| Page | Screens |
|---|---|
| 0 · Style and foundations | Style guide, navigation map, statuses, icons, markers |
| 1 · Getting in | Connect a workspace (no link, create in 4 steps, confirm, error), Sign in, Setup |
| 2 · Home and tests | Home, App (tests, shared steps, runs), Shared steps editor, Version history |
| 3 · Recorder | Recorder, action list, describe states, shared steps picker |
| 4 · Run and report | Run view, Run report, Run history |
| 5 · Settings and system | Settings (9 sections), update, offline, error states |
| 6 · Prototype | Clickable end to end |
| 7 · Local runner | Suites, suite editor, run on runner, runner page (running, offline, none), runner mode, Settings → Local runner and Run requests, result messages |
| 8 · Website and docs | Invite link page (3 states), manual, README |
| 9 · Empty states, loops and members | First use, loading, 4 empty states, loops, Settings → Members |

## Colour tokens

| Token | Dark | Light | Use |
|---|---|---|---|
| `bg.sunk` | `#100D0B` | `#EFE8E1` | Behind windows, code blocks |
| `bg` | `#171412` | `#FBF7F3` | Window background |
| `surface` | `#211C19` | `#FFFFFF` | Title bar, side panels, cards |
| `raised` | `#2C2521` | `#F3ECE5` | Icon discs, hovered rows |
| `selected` | `#332A25` | `#FBEAE2` | Selected nav item |
| `line` | `#3A322C` | `#E6DCD2` | Borders, dividers |
| `line.strong` | `#4A3F37` | `#D9CCBF` | Secondary button borders, inputs |
| `text` | `#F6EFE9` | `#221A15` | Primary text |
| `text.2` | `#E9DFD6` | `#3A2E26` | Body in cards |
| `text.muted` | `#CFC4BA` | `#5A4C42` | Secondary text |
| `text.faint` | `#A3978C` | `#7D6E62` | Meta, timestamps |
| `accent` | `#E0714A` | `#B8502D` | Primary buttons, selection, focus |
| `accent.hover` | `#B8502D` | `#9A3F20` | Hover on primary |
| `on.accent` | `#1A0E08` | `#FFFFFF` | Text on accent |
| `status.passed` | `#8CC56B` | `#3E7A2A` | Passed |
| `status.fixed` | `#E9B949` | `#8A6410` | Fixed automatically, waiting |
| `status.failed` | `#F2667A` | `#B42B45` | Failed, offline |
| `status.running` | `#6CB8D6` | `#1F6D8C` | Running, AI assistant |

Status tints for pills and banners: the status colour at 14–16 % opacity. Status is never shown by colour alone; always icon + word.

## Type

- **Bricolage Grotesque** (open licence) for everything; **JetBrains Mono** for addresses, IDs, config and code.
- Sizes used: 48 / 36 / 32 / 28 / 24 / 22 / 20 / 18 / 16 / 15 / 14 / 13 / 12. Headlines 600, letter-spacing −0.015 to −0.02 em, line-height 1.02–1.15. Body 400, line-height 1.5.
- Wordmark: "**break**patch", 700 + 400, lowercase, letter-spacing −0.02 em, next to the ear mark rotated −14°.

## Layout and shape

- Window 1280 × 800. Title bar 52 px. Browser bar 44 px. Steps panel 380 px. Settings sidebar 220 px.
- 4 px grid. Card padding 16–20 px. Section gaps 16–24 px.
- Radii: cards 14 px, inputs and buttons 10 px, rows and chips 8 px, pills 100 px, dialogs 16 px.
- Shadows: menus and dialogs `0 8px 24px rgba(0,0,0,.35)`; nothing else has a shadow inside the window.

## Components

| Component | Spec |
|---|---|
| Primary button | `accent` fill, `on.accent` text 14–15 / 700, 10 px radius, 7–10 px × 14–16 px padding. Hover `accent.hover`, press scale 0.98. |
| Secondary button | 1.5 px `line.strong` border, `text` 14 / 600. Hover border `accent`. |
| Input | 1.5 px `line.strong`, 12 px radius, 10 × 12 px padding. Focus border `accent`. |
| Status pill | Tint background, status colour icon (17 px) + word 13 / 700. |
| Step row | 18 px number, 30 px icon disc, label 14 / 600, optional note 12. Selected: accent tint + accent border; selected disc accent fill. Expands in place (What to look for, Re-record, Delete). |
| Locked-area marker | Dashed 2 px accent outline with a slow ring pulse and a numbered badge. The only marker shown on the page. |
| Composer | Always-ready text box with the action button and send; "Click anything on the page" hint above. |
| Top nav | Segmented Apps · Suites · Local runner inside a `bg` track; selected uses `selected`. Blue dot when the runner is busy. |
| Banner | Full width under the title bar, status tint + icon + title + one line + actions. Never blocks the screen. |

Icons: Material Symbols Outlined, 16–24 px, colour follows the text.

## Motion

120–180 ms ease-out for state changes. Screens and new items fade up 8 px. Running icons spin (1 s linear). Progress bars grow from the left. No bounce. Everything off with *Reduce motion*.

## Copy

Second person, sentence case, short, no exclamation marks. Plain words only: see the table in the UI requirements (e.g. "Fixed automatically", not "healed"; "Only you / In team suite", not "draft / published"). Mora's line "Here to find what breaks." appears only in About, the README and the website.
