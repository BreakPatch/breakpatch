# Announcing the teasers

Drafts for the Flutter community and for general channels. Attach the matching file from `out/`.
Read "Before you post" first.

## Flutter community (attach `tease-flutter-web.mp4`)

**Short (X, Mastodon, Bluesky)**

> Testing Flutter web is awkward: it draws everything to a canvas, so there's nothing for a selector to find.
>
> Breakpatch looks at the screen instead. No selectors. It runs on your Mac, it's open source (Apache 2.0), and it works with React, Vue and Angular too.
>
> Public release coming soon.

**Medium (Discord, LinkedIn, a Flutter group)**

> Flutter web has a testing problem. The whole UI is painted onto a canvas, so tools that find buttons by selector have nothing to grab. (On a plain Flutter web build, a Playwright `getByText("New project")` finds nothing.)
>
> We've been building Breakpatch for exactly this kind of app. You click through your web app, and a vision model that runs on your Mac names each step and finds it on the screen again. Every step is checked against the screen as you recorded it. No selectors, no code, no cloud AI, no per-run fees.
>
> It isn't only for Flutter: it works with React, Vue, Angular and anything else a browser can open.
>
> The Community edition is free and open source (Apache 2.0). The public release is coming soon, and we'd like Flutter folks to be the first to break it. Issues and pull requests will be welcome.
>
> (18 second teaser attached.)

**One-liner for a bio or a thread opener**

> "Pixels decide": UI testing that works on Flutter web, because it never needed a selector.

## General (attach `tease-find-what-breaks.mp4`, or `tease-fixes-itself.mp4` for Team)

> Here to find what breaks. Breakpatch: AI-powered UI testing that runs on your Mac. Click through your app, a vision model names each step, replay it any time and see exactly what broke. No code, no cloud AI. Free and open source. Public release coming soon.

## Before you post

- **The release isn't public yet.** `README.md` says the install command can't see releases while the
  repository is private. The videos end on "Public release coming soon", so don't add an install
  command or a "try it today" until it's out. Change that line in `index.html` on launch day and
  re-render.
- **Don't promise self-healing on Flutter.** `docs/manual.md` says there is no automatic fixing for
  Flutter buttons that moved. "Fixes itself" (`tease-fixes-itself.mp4`) is a Team feature on ordinary
  pages; the Flutter tease only shows finding and checking.
- **Say "works well with Flutter web", not "certified".** The claim rests on the manual and the
  engine's Flutter detection. If you want a stronger one ("we tested these N Flutter apps"), record
  one or two real Flutter web apps first and add them to the reel in place of Paperplane.
- **The AI on a slow machine.** The manual notes Flutter is the hardest case for a Raspberry Pi
  runner (software drawing). On a Mac it's the normal path. Don't compare speeds in the post.
- **Tag/credit.** The videos use Bricolage Grotesque and JetBrains Mono (OFL); nothing else needs credit.
