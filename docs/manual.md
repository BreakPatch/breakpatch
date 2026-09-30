# Breakpatch manual

Everything about Breakpatch on one page. Use the contents or your browser's find.

Breakpatch comes in these editions. **Community** is free and open source: one person, one Mac, tests saved as files. **Solo** is paid, for one person: it adds fixed automatically, schedules on your Mac, notifications, result messages and the CI command line, and keeps your tests in your folder. **Team** is paid and adds a shared workspace, version history, schedules and a local runner for the whole team. **Business** is Team for 20 people or more. The last part of this manual is for the paid editions: see [Solo](#solo) for what Solo includes.

**Getting started**

1. [Install](#install)
2. [Start on this Mac](#start-on-this-mac)
3. [Setup](#setup)
4. [Your first test](#your-first-test)

**Community**

5. [The tests folder](#the-tests-folder)
6. [Record a test](#record-a-test)
7. [Run a test and read the report](#run-a-test-and-read-the-report)
8. [Shared steps](#shared-steps)
9. [Suites](#suites)
10. [Saved secrets](#saved-secrets)
11. [The AI assistant](#the-ai-assistant)
12. [Updates](#updates)
13. [Privacy](#privacy)
14. [Troubleshooting](#troubleshooting)

**Team**

15. [What Team adds](#what-team-adds)
16. [Solo](#solo)
17. [Upgrading to Team](#upgrading-to-team)
18. [Create a workspace](#create-a-workspace)
19. [Invite your team](#invite-your-team)
20. [Members and roles](#members-and-roles)
21. [Version history](#version-history)
22. [Fixed automatically](#fixed-automatically)
23. [Schedules](#schedules)
24. [The local runner](#the-local-runner)
25. [Run requests](#run-requests)
26. [From CI with breakpatch-ci](#from-ci-with-breakpatch-ci)
27. [Result messages](#result-messages)
28. [Security rules](#security-rules)
29. [Licences and seats](#licences-and-seats)
30. [The back office](#the-back-office)

---

# Getting started

## Install

You need a Mac with Apple Silicon, 16 GB of memory and macOS 14 or later.

Open Terminal and paste this:

```sh
curl -fsSL https://breakpatch.dev/install | sh
```

<!-- prelaunch --> Public release coming soon. Until then, this command doesn't work. Join the list: [support@breakpatch.dev](mailto:support@breakpatch.dev?subject=Breakpatch%20release%20list)

It checks your Mac, downloads the latest Breakpatch from [GitHub Releases](https://github.com/BreakPatch/breakpatch/releases) (over https only, and only from Breakpatch's own releases), checks the download against the release's checksums, checks the app is signed with Breakpatch's certificate, puts Breakpatch in Applications and opens it. If you have `minisign`, it also checks the download's signature with Breakpatch's update key. If your account can't write to Applications, it uses `~/Applications` instead. It never asks for your password, changes nothing else on your Mac and sends nothing about you or your Mac to Breakpatch. Don't run it with `sudo`: it refuses to run as root. You can [read the script](https://breakpatch.dev/install) first.

For a given version, put it in front of `sh`: `curl -fsSL https://breakpatch.dev/install | BREAKPATCH_VERSION=1.2.3 sh`.

**Updating.** Breakpatch updates itself (see [Updates](#updates)). Running the command again updates it too: it quits Breakpatch first, then replaces the app. Your tests, saved secrets and the AI assistant stay as they are.

**Uninstalling.**

```sh
curl -fsSL https://breakpatch.dev/install | sh -s -- --uninstall
```

This removes the app only. Your tests stay in the folder you picked, saved secrets stay in your Keychain, and the AI assistant and Breakpatch's data stay in `~/Library/Application Support/Breakpatch`. Delete that folder to free the space.

**Breakpatch's certificate.** Breakpatch is signed with its own certificate, "Breakpatch Code Signing", not with Apple's Developer ID. Every release is signed with the same one, so macOS knows each update is the same app and your saved secrets stay available without Keychain prompts. macOS doesn't mark files downloaded with `curl` as quarantined, so Breakpatch opens straight away.


## Start on this Mac

The first time you open Breakpatch, it asks where to keep your tests.

1. Press **Choose a folder** and pick one. A folder inside your project's Git repo is a good choice, for example `web-app/breakpatch-tests`.
2. If the folder is empty, Breakpatch sets it up straight away. If it already has other files, it asks first: "Breakpatch adds a breakpatch.json file and an apps folder."
3. If the folder already has a `breakpatch.json` (a clone of your repo, say), Breakpatch opens it as it is.

Next time, **Open a recent folder** takes you back to one you used before. To switch later, go to Settings → Tests folder → **Change folder**.

## Setup

Straight after, Breakpatch gets this Mac ready. It runs by itself, and you only see it once.

- **Installing the test browser.** The browser your tests run in. It's separate from the one you use every day.
- **Checking this Mac.** Its chip, memory and macOS.
- **Downloading the AI assistant.** The Standard assistant, about 3 GB. See [The AI assistant](#the-ai-assistant).

It takes about 5 minutes on office Wi-Fi. It's safe to close Breakpatch: setup picks up where it left off, and a stopped download continues from where it was. If something doesn't work, press **Copy details** and send that to whoever helps you.

## Your first test

1. On Home, press **Add app**. Give it a name and its address, for example `https://staging.example.com`.
2. Press **New test**, name it (for example *Log in*) and press **Start recording**.
3. Click through the page the way a person would. Each click becomes a step on the right.
4. Press **Save**, then **Run**.

Your first test takes about 5 minutes, so about 10 minutes from install to your first run. The rest of this manual covers each part in more detail.

---

# Community

Everything in this part is free, and works the same in Team. In Team, tests are saved in the shared workspace instead of a folder.

## The tests folder

Your tests are plain JSON files in the folder you picked. Breakpatch picks up changes made outside the app, like a `git pull` or an edit in your code editor, when you come back to its window.

```
breakpatch-tests/
  breakpatch.json                 the folder's name and format version
  apps/
    web-app/
      app.json                    name, address, screen size
      tests/log-in.json           a test and its steps
      shared/sign-in.json         shared steps
      runs/log-in.json            the last run of that test
  files/
    photo.jpg                     a file a test uploads (see Record a test)
  suites/
    smoke.json                    a suite: its name and tests, in order
```

File and folder names come from the names you give things: *Log in* becomes `log-in.json`. Only the latest version of each test is kept, so saving overwrites the file. Each test keeps its last run only.

A test file looks like this (shortened):

```json
{
  "name": "Log in",
  "startUrl": "https://staging.example.com/login",
  "status": "draft",
  "version": 3,
  "viewport": {
    "width": 1440,
    "height": 900,
    "dpr": 1
  },
  "recordedOn": {
    "os": "macOS",
    "osVersion": "15.3",
    "arch": "arm64",
    "chromium": "140.0.7339.16"
  },
  "updatedAt": "2026-09-25T14:32:05.000Z",
  "steps": [
    {
      "id": "s1",
      "action": "click",
      "label": "Click Log in",
      "target": "Log in button, below the password field",
      "at": [712, 488]
    }
  ]
}
```

`recordedOn` says where the steps were recorded: the system and the version of the test browser. Breakpatch writes it when you record or re-record steps, and keeps it when you only edit them. Tests saved before it existed don't have it, and work as before.

The same test always gives the same file: two-space indents, keys in a fixed order, short lists of numbers on one line, times as dates and a newline at the end. So a change in the app shows up as a small, readable diff.

### Git tips

- **Keep the folder in your repo. Git is your history.** Commit tests with the code they test, and go back to an older version with Git.
- **Leave out the last runs if you like.** Add `breakpatch-tests/apps/*/runs/` to `.gitignore`. They only hold the last run on your Mac.
- **Secrets never land in the folder.** Tests only store a secret's name. The value stays in this Mac's Keychain. See [Saved secrets](#saved-secrets).
- **Pulled a change?** Switch back to Breakpatch and it reads the folder again.
- **Merge conflict in a test file?** Fix it as you would any JSON file. Until it's valid again, Breakpatch skips that file and tells you which one.
- **Saved by a newer Breakpatch?** If `breakpatch.json` has a higher `schemaVersion` than your app knows, update Breakpatch to open the folder. If it changes while the folder is open, saving stops until you update.

Settings → Tests folder shows the folder, how many apps and tests it has, **Show in Finder** and **Change folder**. Changing folders leaves the old one as it is, with all its tests.

## Record a test

1. Open an app → **New test**. Give it a name and a start address. The screen size is fixed once you start.
2. Optional: under **Before and after the test**, add a **set-up call** (for example, to add sample data) and a **clean-up call**. Each is a method (GET, POST, PUT, PATCH or DELETE), a web address and, if you like, headers; the run waits for the reply. **Try it** makes the call once.
   - Calls use `https://` and go to the app's own address or another host under the same domain, for example `api.example.com` for an app at `app.example.com`. Plain `http://` is only for an app on this Mac (`localhost`).
   - Private and local network addresses are refused, unless the app itself is on one. **Allow other hosts** lets this test call any host and private addresses. Cloud metadata addresses are never called.
   - Redirects aren't followed: use the address the call ends up at.
   - A header's value can be a saved secret, for example an `Authorization` token. The secret must be allowed on the call's site, like typing it (see [Saved secrets](#saved-secrets)).
   - Logs show the address without its query string, and never a header's value.
3. Add steps, in either of these ways:
   - **Click** anything on the page. Nothing happens to the page yet: Breakpatch highlights what you clicked and asks, for example, "Click Next button?". Press **Confirm** (or Enter, or click it again) to do the step; **Try again** to pick something else; Esc to cancel. Dragging and scrolling on the page work the same way.
   - **Describe** it in the box below, for example "click the Done button". Breakpatch highlights what it found. Press **Confirm** or **Try again**.
4. Use the action button next to the box for everything else: double, long and right click, hover, swipe, scroll, drag and drop, **Write text**, **Wait until**, **Go to address**, reload, back and forward, tabs and popups, upload a sample file, check a download, **Checkpoint**, **Repeat** and **Shared steps**.
5. Press **Save**.

Screen checks are worked out automatically after every step. There's nothing to draw or approve.

Select a step to open it. **What to look for** is the plain description of what the step acts on, for example "Done button, bottom right of the Create project dialog". Edit it if it's wrong. **What should happen** says how a run judges the step: a new page opens, something closes or disappears, something appears, text or a value changes, or nothing visible changes. Breakpatch picks one when you record; change it with one click. **+ note** adds a few words, like "closes the What's new dialog": the AI assistant reads them only when the step's check fails, to judge whether the failure is real and to say why.

Under that: **Play to here** starts a new browser and plays the test from the start up to and including this step. **Play this step** does only this step, on the page as it is now, and never plays the steps before it: if the page isn't where the step expects, the step fails with its usual reason. The **⋯** menu has **Edit** (the step's text, secret, address, seconds, sample file, repeat count or name), **Re-record** (do the step again on the page; not for a wait of some seconds), **Duplicate**, **Add a step after** and **Delete**. Hover between two steps, or tab to it, for **+** to add a step there: the next step you record goes there. If the page isn't at that step, a line over the page says so, with **Play to here** to get it there (or use **Use the page**); nothing plays by itself. **Run** plays the whole test in the recorder's browser and leaves the page where it stopped.

**Use the page** (✋ above the page, or ⌘E) lets you work the page yourself, for example to close a banner or sign in by hand before you record the next step. Your clicks, scrolling and typing go straight to the page and nothing is recorded; a coloured ring and a line over the page remind you. Press **Done** or ⌘E to go back to recording (Esc goes to the page). A typical use: a step fails, you put the page right by hand, then press **Play this step**; its result says it played on a page set up by hand. **Run** and **Play to here** always start in a new browser, so nothing you did by hand is carried into them. What you type in this mode is never saved or logged.

**Uploading a file.** When a click opens the page's file picker, Breakpatch asks which file to use: one of the sample files, one of **Your files**, or **Choose from this Mac…**. A file from your Mac is copied into the tests folder's `files` folder, so the test uploads the same file on every run and on every Mac that has the folder. If the file is missing when the test runs, the step fails with "files/photo.jpg isn't in the tests folder." **Cancel, just click** records a plain click.

**Passwords.** When you write into a field that hides what's typed, the step shows as `Write "••••••••"` (the eye shows it) and Breakpatch asks once: "This looks like a password. Save it as a saved secret?" **Save as secret** keeps the value in this Mac's Keychain and the step uses the secret; **Keep as typed text** is fine for a sandbox account; **Don't ask again for this app** stops asking. The screen checks leave the inside of the field out, so another password of another length still passes.

**Checkpoint** checks that something is on screen, like "Project created": click it, draw a box around it, or name it. **Write text** types a fixed text, a saved secret, or a value made at run time, like `Test project {time}`.

## Run a test and read the report

Press **Run**. The live view shows each step as it runs. Each step is checked before and after it acts, and the first failure stops the run with a plain reason, for example "Couldn't find the Done button".

The report shows what was expected next to what was on screen, why it stopped and what to try. Press **Re-record this step** to fix it straight away.

Common reasons:

- **Couldn't find the Done button.** It wasn't where it was when the step was recorded. If the app changed on purpose, re-record the step. In Team, the AI assistant can find it for you: see [Fixed automatically](#fixed-automatically).
- **The screen didn't look as expected after this step.** The page looked different once the step was done.
- **Nothing happened after this step.** The step was done, but nothing changed on the page the way it did when it was recorded.
- **Waited too long for the page.** If the app was slow this time, run again.
- **Saved secret is missing on this Mac.** Add it in Settings → Saved secrets, then run again.
- **STAGING_PASSWORD isn't allowed on login.example.com.** The page wasn't one of the secret's sites, so nothing was typed. If that site is right, add it to the secret in Settings → Saved secrets.

Every error has **Copy details**, to paste into an issue or send to a developer.

### Recorded on another system

Screen checks compare the page with how it looked when the step was recorded. Another system, or another version of the test browser, can draw the same text a pixel off or a little smoother, so record and run a test on the same kind of machine when you can.

When a test was recorded on another system (another operating system, or another main version of the test browser, which comes with Breakpatch), **Settings → Screen checks → Allow for small differences between systems** makes its screen checks allow for that. It's on unless you turn it off. The checks still fail when something really changed, like a missing button or other words. If a check fails anyway, the report says why, for example: "This test was recorded on macOS 15 and ran on Linux. Text can look slightly different on another system, which can fail screen checks. Re-record it on this system, or run it on a Mac."

## Shared steps

Steps that several tests repeat, like *Log in*. Make them in the app's **Shared steps** tab → **New shared steps**, then add them to a test with the action button → **Shared steps**.

Edit them once and every test that uses them picks up the change. Before you save, Breakpatch tells you how many tests it affects.

## Suites

A named set of tests, which can mix apps: *Smoke*, *Before release*. Pick the tests and the order they run in, then save.

Press **Run** on a suite to run it on this Mac, one test after another, in the order you picked. You can watch each test as it runs, stop the suite, and open each test's report when it's done.

In Community you run suites by hand. A suite's result is kept until you close Breakpatch, and each test keeps its last run. Schedules, a runner Mac and starting suites from CI come with [Team](#what-team-adds).

## Saved secrets

Passwords and emails that tests type in. Add them in Settings → **Saved secrets** → **Add a secret**, then pick one when a test writes into a field.

- Values stay in this Mac's Keychain and are never uploaded. Tests only store the name, so they're safe to commit.
- Names use capital letters, numbers and `_` only, starting with a letter, for example `STAGING_PASSWORD`.
- Saved secrets stay on each Mac. If a test needs one this Mac doesn't have, the run stops at that step and tells you which one to add.
- **Each secret is only typed on the sites you allow**, for example `https://app.example.com`. Add sites when you add the secret, or change them later with the edit button. Leave them empty and Breakpatch asks, the first time a test uses the secret, whether to allow the site of the test's app.
- The site is checked just before typing and again before every key: after a redirect, in a popup or in a frame from another site, the test stops before typing and says which site it was, for example "STAGING_PASSWORD isn't allowed on evil.example."
- Secrets saved before sites existed have none yet. Breakpatch asks once to allow the test app's site. If you press **Not now**, tests stop before typing them until you add a site.
- **Runner can use** (Breakpatch Team) lets the [local runner](#the-local-runner) type the secret in the runs it does on its own. It's off unless you turn it on, on the runner Mac.

## The AI assistant

A small AI model that runs only on your Mac. Your screens never leave it. It finds things on the page when you describe a step, and is unloaded when it's idle.

On sites with good page structure (buttons, links and fields that say what they are), Breakpatch finds what you describe at once, from the names the page gives them, without the AI assistant. It uses the AI assistant when the page doesn't say, or draws everything itself, like Flutter apps and canvas pages. Either way it clicks a spot on the screen and checks the step on the screen.

- **Standard** is downloaded during setup (about 3 GB). It works well for almost every team.
- **Larger** is optional on Macs with 32 GB of memory or more (about 5 GB). It's slower to load and rarely finds more.

Settings → AI assistant shows which one you have, the space it takes and your Mac's memory, and lets you remove it. Recording needs it, both when you click and when you describe a step, so setup downloads it before your first test. Finding buttons that moved during a run ([Fixed automatically](#fixed-automatically)) is Team only.

It's kept in `~/Library/Application Support/Breakpatch/models/`.

## Updates

Breakpatch checks for updates when it opens, and from Settings → About → **Check for updates**. Updates download in the background. Press **Restart to update**, or they install the next time you restart. Updates never change your tests.

Settings → About also shows your version and edition.

## Privacy

Breakpatch counts **tests created and runs**, as anonymous totals for all users, so we can see that it's used and what to work on. The first time you open Breakpatch, a notice in the corner says so:

> Breakpatch counts tests created and runs, as anonymous totals for all users. No names, addresses, screenshots or IDs are sent.

Press **OK** to put it away, or **Turn off**. You can turn it off or on again at any time in **Settings → Privacy**, which also shows exactly what's waiting to be sent. To turn it off for good on a Mac, set the environment variable `BREAKPATCH_NO_USAGE=1` (for example with `launchctl setenv BREAKPATCH_NO_USAGE 1`).

**What's sent.** Nothing before you've seen that message. Then, on each day you use Breakpatch, one message to `https://account.breakpatch.dev/api/usage`, even when there's nothing to count, holding exactly:

- how many tests were created, and how many tests were run, passed and failed, since the last message (at most 500 tests and 5,000 runs at a time; the rest waits for the next day);
- whether this is the first message from this Mac today, this week and this month, and whether it's the very first ever. That's how the number of Macs using Breakpatch each day, week and month is counted without any ID: Breakpatch works these out from the date it last sent one, which is the only thing it keeps about it;
- the app version and that it's Community.

**What's never sent.** Test names, web addresses, steps, screenshots, saved secrets, your name or email, your tests folder, or any ID for you or your Mac. The counts are added into totals for everyone, per day, week and month, and the message itself isn't kept. Your IP address is only used to limit how often one address can send: it picks a counter by a one-way hash mixed with a random value that changes every day and is deleted after two days, so the address can't be worked out from it. The address itself is never stored.

**When it's off**, nothing is counted or sent, and anything waiting is dropped. A copy of Breakpatch you built yourself works the same way.

The counts wait in `~/Library/Application Support/Breakpatch/usage.json`, with your choice and the last date one was sent. The code that sends them is in this repository: `app/src-tauri/src/usage.rs`.

**Downloads** are counted by GitHub, which shows how often each release file was downloaded; we read those totals once a day. The install command sends nothing.

**Breakpatch Team** works differently: see [Licences and seats](#licences-and-seats).

## Troubleshooting

**"Couldn't open this folder."** The folder was moved or deleted, or Breakpatch can't save files there. Choose a folder you can write to.

**"This folder was saved by a newer Breakpatch. Update to open it."** Someone saved these tests with a newer version. Update Breakpatch from Settings → About.

**A test file was skipped.** It isn't valid JSON, often after a merge conflict. Fix the file and switch back to Breakpatch.

**"Setup paused."** The download stopped, usually because the connection dropped. Nothing's lost. It continues when you're back online.

**"The AI assistant isn't downloaded."** Download it in Settings → AI assistant. You need it to record.

**macOS asks to let Breakpatch use your Keychain.** macOS only lets the app that saved a Keychain item read it without asking, and it tells apps apart by their code signature. Copies from the install command, the releases and the in-app updates are all signed with Breakpatch's certificate, so they never ask. When you're asked, the copy asking isn't signed that way: usually one you built yourself, or one from somewhere else.

- If you built it yourself, press **Allow**. It lets that copy read that one item this time, and you're asked again next time. Don't press **Always Allow**: it would let any program signed like that copy read your saved secrets and licence from then on, without asking you.
- If you didn't build it yourself, press **Deny**, delete that copy and install Breakpatch again with the [install command](#install).
- The prompt names the item: one of your saved secrets (`dev.breakpatch.secrets`) or the Team licence (`dev.breakpatch.licence`).

**Copy details.** Every error has a *Copy details* button. Paste that into an [issue](https://github.com/BreakPatch/breakpatch/issues).

---

# Team

Everything in this part needs a paid edition: **Breakpatch Team**, or **Solo** for one person. [Solo](#solo) says which parts Solo includes.

## What Team adds

- **A shared workspace** in your company's own Google Firebase project (see [Create a workspace](#create-a-workspace)): your team's apps, tests, suites and runs in one place, joined with an invite link. A test is *Only you* until you add it to the team suite. Then it's *In team suite*.
- **Members and roles**: member, admin, a runner account and a CI account.
- **Version history.** Every save is kept. Runs show which version they tested, and you can restore any version.
- **Fixed automatically.** When a button has moved, the AI assistant finds it during the run and carries on. You accept the new position in the report.
- **Schedules** for suites, on any days and time.
- **The local runner**: one Mac that runs suites for the whole team.
- **Run requests** from CI or any other tool, and **result messages** after every suite run.
- **`breakpatch-ci`**: run the workspace's suites on your CI machines, with the results in the run history.

Choosing another AI model for the assistant is in Business.

## Solo

<!-- solo-soon --> Coming soon. Solo isn't on sale yet. To hear when it is, email [support@breakpatch.dev](mailto:support@breakpatch.dev?subject=Breakpatch%20Solo).

Solo is for one person who wants the automation for themselves: $19 a month, or $16 a month billed yearly.

| | Community | Solo | Team | Business |
|---|---|---|---|---|
| Price | Free | $19 a month, or $16 a month billed yearly | $20 per person a month, or $16 billed yearly | $30 per person a month, billed yearly |
| People | 1 | 1 | 3 or more | 20 or more |
| Machine licences | None | 1 | 1 included, you can buy more | 5 included, you can buy more |
| Where tests are kept | A folder | A folder or Git, or your own workspace if you want one | Your company's Firebase project | Your company's Firebase project |
| Fixed automatically | No | Yes | Yes | Yes |
| Schedules, notifications and result messages | No | Yes, on your Mac | Yes | Yes |
| The CI command line | No | Yes | Yes | Yes |
| Run requests, the local runner and version history | No | With your own workspace | Yes | Yes |
| Members, roles and sharing | No | No | Yes | Yes |
| Another AI model | No | No | No | Yes |

- **Your tests stay where they are.** Solo works on your [tests folder](#the-tests-folder), or a folder you keep in [Git](#git-tips). There's nothing to set up in the cloud.
- **A workspace is optional.** For [run requests](#run-requests), the [local runner](#the-local-runner) and [version history](#version-history), connect a workspace of your own ([Create a workspace](#create-a-workspace)). It stays yours alone: Solo has no members or invites.
- **The licence.** Enter the key in **Settings → Licence**. It works on one Mac at a time. To use it on another Mac, free it on your licence page at [account.breakpatch.dev](#the-back-office), then enter the key on the new Mac.
- **One machine licence**, for [breakpatch-ci](#from-ci-with-breakpatch-ci) or a runner. Your Mac and the machine licence each run one test at a time. Solo has no extra machine licences.
- **One Solo per company.** If someone at your company email domain already has Solo, the pricing page offers Team instead. A personal address (such as Gmail or iCloud) counts on its own.
- **Moving to Team** keeps your tests. Email [support@breakpatch.dev](mailto:support@breakpatch.dev) to switch your plan, then follow [Upgrading to Team](#upgrading-to-team).

## Upgrading to Team

Install Breakpatch Team over Community. The AI assistant, the test browser, your settings and your saved secrets stay as they are, and Breakpatch opens your tests folder like before. Then go to **Settings → Upgrade to Team** (or **Upgrade to Team** on Home):

1. **Connect a workspace**: [create one](#create-a-workspace), or open an invite link from your team. Then sign in.
2. **The licence.** If you created the workspace, enter the licence key once in **Settings → Licence** (it looks like `BP-XXXX-XXXX-XXXX-XXXX`). If you joined with an invite link, the link sets up your licence and there's no key to enter. See [Licences and seats](#licences-and-seats).
3. **Move your tests**. Choose the tests folder. Breakpatch shows what it will copy first, for example "1 app, 12 tests, 3 shared steps and 2 suites will be copied.", and you can rename apps, or merge them with apps the workspace already has. It then copies the apps, tests, shared steps, suites and the last run of each test into the workspace.
4. **Check, then move to the Trash.** Breakpatch reads everything back from the workspace and compares it with the folder. Only when it all matches, and you confirm, does it move the folder's `breakpatch.json`, `apps` and `suites` to the Trash, so there's one place to edit your tests. To undo it, drag them from the Trash back into the folder.

Good to know:

- **Only Breakpatch's files move.** Everything else in the folder stays as it is. If the folder is in a Git repository, the removed tests show as deleted files to commit, and earlier versions stay in the repository's history.
- **If the move stops half way** (the Mac restarts, say), Breakpatch picks it up where it left off the next time you open **Upgrade to Team**.
- **A report of the move** is kept in Breakpatch's data folder on this Mac: what was copied, what went to the Trash, and anything left out.
- **Each test starts at version 1** in the workspace, because the folder keeps only the latest version.
- **Saved secrets** travel as names in the steps. Their values stay in this Mac's Keychain; teammates add their own in **Settings → Saved secrets**.
- **Files that can't be read** stop the move until you fix them in the folder, so nothing unread goes to the Trash.
- **Already in the workspace?** Anything that's already there is left out. If a test there differs from the folder's (a teammate copied an older version, say), Breakpatch names it, and you can keep the workspace's version.
- A folder saved by a newer Breakpatch can't be moved until you update.

## Create a workspace

Do this once for your organisation. You need owner access to a Firebase project. Use the project your product already signs in with, so everyone keeps their usual login. A new project works too: step 5 turns on sign-in and adds your account.

In Breakpatch: **Connect a team workspace** → *Setting up for your team?* → **Create a workspace**. Each step has **Open Firebase console**, which opens the right page.

1. **Create the web app.** Project settings → General → Your apps → **Add app** → Web. Name it `Breakpatch`, leave Firebase Hosting off and click Register app. Ignore the code Firebase shows and click Continue to console.
2. **Paste the config.** Under Web apps, pick Breakpatch. In SDK setup and configuration, choose Config, copy it and paste it into Breakpatch. Then fill in **Who can sign in**: just the part after @, for example `example.com`.
3. **Choose the database.** Breakpatch asks which one to use:
   - **This project's `(default)` database**: best if the Firebase project is only for Breakpatch, and it's the one Firebase's free tier covers. Open Firestore Database. If the page shows **Create database**, click it, keep Standard edition and the ID `(default)`, pick a location near your team (you can't change it later), keep Production mode and click Create. If the project has a `(default)` database already, there's nothing to do.
   - **A separate database**, if the project also runs your app, so test data stays apart. Open Firestore Database, open the database menu at the top of the page (the one that shows `(default)`) and choose **Add database** (a project with no database yet shows **Create database** instead). Keep Standard edition, enter the database ID `breakpatch` (copy it from the app), pick the same location as your main database, keep Production mode and click Create.
4. **Paste the rules.** In Breakpatch press **Copy rules**. In Firestore pick the `breakpatch` database, open the Rules tab, replace everything with the rules you copied and click Publish.
5. **Turn on sign-in and add yourself.** Open Authentication (click **Get started** if it's new). In Sign-in method choose **Email/Password**, turn on Enable and click Save. Then in Users click **Add user** and add yourself, with an address in the *Who can sign in* domain. Add your teammates the same way, now or later. If your team already signs in to this project with email and password, just check it's on. Breakpatch never creates accounts.
6. **Connect.** Check the summary. Breakpatch checks the connection by itself (see below); fix anything it names first. Name the workspace, add a logo if you like and press **Create workspace**. Then sign in with the account you added. If you haven't added it yet, the sign-in screen says where, with a link to Authentication → Users in the Firebase console.

People sign in with their work email and a password. The first time, Breakpatch sends them a link to confirm their email address.

Whoever connects the workspace becomes its first admin.

### Check the connection

**Check the connection** (the last step of Create a workspace, and Settings → Workspace) looks at each part of the set-up in turn and says what to do about anything that isn't right, with **Open Firebase console** on the right page:

- **Firebase project**: the config is a project's, and it answers.
- **Email and password sign-in**: it's turned on in Authentication.
- **Database**: the database named in the workspace is there.
- **Security rules**: the Breakpatch rules for this version are published to it.

It only reads: a sign-in with a made-up address (which never signs anyone in) and one read of the database. The sign-in counts towards Firebase's limit on failed sign-ins from your address, so after many checks in a row it may say it couldn't tell for a few minutes.

### Edit connection

If the details on this Mac are wrong (the config, the database ID, *Who can sign in* or the name), choose **Edit connection** on the sign-in screen or in Settings → Workspace. It changes only this Mac's saved details, never the workspace, then checks the connection with them. Changing the Firebase project or the database makes it another workspace to this Mac: its licence seat under the old details is given back, and it takes one again when you sign in.

## Invite your team

Settings → Workspace → **Invite teammates** → **Copy link**. Send it any way you like. It works for everyone and doesn't expire.

Teammates don't need the licence key. Once your admin has entered it in **Settings → Licence**, everyone who opens the link and signs in gets a seat by themselves. The link holds only the workspace details, never the licence.

```
https://breakpatch.dev/connect#c=eyJuYW1lIjoiU3ltVGVycmEi…
```

Clicking it opens a page with **Open in Breakpatch** and **Install Breakpatch**. The link also sets up each person's licence, so they don't enter a key: they take a seat when they sign in. The workspace details are in the part after `#`, which browsers never send to a server.

**Save as file** gives the same thing as a `.bpworkspace` file, handy for a shared drive, CI or the local runner. Double-click it to connect.

Teammates can also paste the link on the connect screen: *Got a link or a .bpworkspace file?* → **Or paste the link here**.

## Members and roles

Everyone from your email domain joins as a **member** the first time they sign in. Admins change roles in Settings → **Members**.

| Role | What they can do |
|---|---|
| **Member** | Record, run and edit tests. Add tests to the team suite. Make suites. |
| **Admin** | Everything a member can, plus workspace settings, roles and deleting apps. |
| **Local runner** | For the runner Mac. Reads tests, runs suites, writes results. |
| **CI** | For CI pipelines. Asks for suite runs, reads tests, shared steps and suites to run them with `breakpatch-ci`, and adds its runs to the history. Sees nothing else. |

Only admins can change roles, and nobody can change their own. **Remove from workspace** stops someone opening it; their tests and runs stay. If they sign in again with an account from your domain, they join as a member again, so to keep someone out, disable their account in Firebase Authentication.

Runner and CI accounts sign in once and join as a member. Then an admin changes their role.

## Version history

Every save is a new version, with an optional note: *What changed?* → **Save as version 4**. Nothing is ever deleted.

On a test or shared steps, open **Version history** to see each version, who saved it, what changed since the one before and the runs on that version. **Restore version 2** saves it again as the newest version. The current one stays in the history.

Every run shows the version it tested. Shared steps show which tests use the latest version and which are kept on a fixed one.

**Mark as released** (on a test's version) picks the version your pipelines run with `breakpatch-ci --version released`, so edits still in progress don't break the build. The version list shows it as *Released*. **Clear release mark** takes it off.

## Fixed automatically

When a button has moved, the AI assistant looks for it using its *What to look for* description, checks it's the same thing, and the run carries on. The step is marked **Fixed automatically**, and the suite result is *Passed with fixes*.

Nothing changes until someone decides. In the report:

- **Accept new position**: the next run looks in the new spot.
- **Dismiss**: the next run looks in the old spot again.

Settings → **Automatic fixing**:

- **Fix moved buttons automatically.**
- **Fail the test if anything needed fixing.** The run still finds the button, but the test counts as failed. Useful before a release.

These apply to runs on the Mac where you set them.

The first few runs of a new test also learn which parts of the page change by themselves, like clocks and carousels, so they don't fail the test.

## Schedules

Open a suite and set its **Schedule**: the days and a 24-hour time, like *Mon to Fri, 06:00*. The time is the local runner's clock. With no schedule, the suite is *By request only*: the Run button, CI or another tool.

The suite shows its next run. If the runner was off when a run was due, the missed run happens once when it's back, not once for every time it missed.

## The local runner

One Mac per workspace that stays on and runs scheduled suites and run requests for everyone.

1. Install Breakpatch on that Mac and connect it to the workspace.
2. Sign in with a **separate account** (for example `runner@yourcompany.com`) so runs don't show under a person's name. Give it the *Local runner* role.
3. Settings → **Local runner** → **Use this Mac as the local runner**.

It then stays awake while it's plugged in, opens at login and starts in runner mode after a restart or update. Runner mode shows what it's doing: waiting, running (with a live view), the queue and the last runs. **Pause after this test** stops it cleanly. Press Resume to carry on.

It uses the Standard AI assistant, like every Mac. With 32 GB of memory or more you can download the Larger one in the same place, but it's rarely needed.

**Record and run on the same kind of machine.** Tests pass most reliably on the runner when they're recorded on a Mac like it, with the same version of Breakpatch. A test recorded with another version of the test browser runs with **Allow for small differences between systems** (Settings → Screen checks, on unless you turn it off) on the runner Mac, and its report says so when a check fails. See [Recorded on another system](#recorded-on-another-system).

Anyone can press **Run on runner** on a suite. If the runner is offline, the request waits until it's back.

**Queue rules**

- First in, first out.
- The newest request for a suite wins: a waiting request for the same suite is removed, and a running one stops after its current step. Both are recorded as *Replaced by a newer request*.
- If the runner is offline, requests wait. Missed schedules run once when it's back.

## Run requests

The runner starts a suite whenever a document is added here:

```
projects/<your-project>/databases/breakpatch/documents/runRequests
```

Settings → Local runner → **How run requests work** shows the exact path for your workspace. Each document is one request. Let Firestore make its ID.

| Field | Needed | What it's for |
|---|---|---|
| `suiteId` | Yes | Which suite to run. Copy it from the suite, for example `smoke-7f3a`. |
| `createdAt` | Yes | When it was asked for. Set it to the server's time, not your own clock: the security rules check it. |
| `requestedBy` | No | Shown in the queue, the run history and the result message, for example `Codemagic · build 412`. |
| `note` | No | Any text you want in the result message. |

The runner picks it up within a few seconds, queues it and deletes the document. The Run button and schedules add these for you.

**How other tools add requests is up to you.** A few examples:

### From CI with a CI account

Create a user such as `ci@yourcompany.com` and give it the `ci` role (see [Security rules](#security-rules)). Store its email and password, your Firebase web API key and your project ID as CI secrets.

```sh
TOKEN=$(curl -s "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=$FIREBASE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$BP_CI_EMAIL\",\"password\":\"$BP_CI_PASSWORD\",\"returnSecureToken\":true}" | jq -r .idToken)

DB="projects/$FIREBASE_PROJECT/databases/breakpatch/documents"

curl -s -X POST "https://firestore.googleapis.com/v1/$DB:commit" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"writes\":[{
    \"update\":{\"name\":\"$DB/runRequests/$(openssl rand -hex 10)\",\"fields\":{
      \"suiteId\":{\"stringValue\":\"smoke-7f3a\"},
      \"requestedBy\":{\"stringValue\":\"CI · build $BUILD_NUMBER\"}}},
    \"updateTransforms\":[{\"fieldPath\":\"createdAt\",\"setToServerValue\":\"REQUEST_TIME\"}],
    \"currentDocument\":{\"exists\":false}}]}"
```

Works the same in Codemagic, GitHub Actions, Bitrise or Jenkins.

### From a script (Node)

```js
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, collection, addDoc, serverTimestamp } from 'firebase/firestore';

const app = initializeApp(firebaseConfig);
await signInWithEmailAndPassword(getAuth(app), process.env.BP_CI_EMAIL, process.env.BP_CI_PASSWORD);
await addDoc(collection(getFirestore(app, 'breakpatch'), 'runRequests'), {
  suiteId: 'smoke-7f3a',
  requestedBy: 'Release script',
  createdAt: serverTimestamp(),
});
```

### From an automation tool

n8n, Zapier or Make can add a Firestore document on any event: a deploy, a merged pull request, a button in a chat. Use the same path and fields, with `createdAt` set to the server's time.

## From CI with breakpatch-ci

`breakpatch-ci` runs tests on the CI machine itself and tells your pipeline whether they passed, so a failing test stops the build. It's the same engine as the app, with no window. It reads the tests **straight from your workspace**, a whole suite or one test, and each run shows up in the app's run history like any other, marked *CI*. So the workspace stays the one place where tests are edited. It can also run a test file from a [tests folder](#the-tests-folder) in your repo.

To run a suite on the local runner Mac instead, add a [run request](#run-requests).

**What you need**

- A Breakpatch Team licence with a free **machine licence** for the CI machine. Machine licences count separately from people's seats.
- A Mac with Apple Silicon and macOS 14 or later, for example GitHub's `macos-15` runners or a Codemagic Mac. Linux x86_64 works as a preview: it runs tests, but record them on a Mac.
- Python 3.11 on that machine.
- One run at a time per machine licence. To run tests in parallel, give each parallel job its own machine licence and its own `BREAKPATCH_MACHINE_ID`.
- The workspace's `.bpworkspace` file (Settings → Workspace → Invite teammates → **Save as file**), committed to your repo. It holds only the workspace's public details, never a password or key.
- A **CI account**: a user such as `ci@yourcompany.com` with the *CI* role (see [Members and roles](#members-and-roles)). Have it sign in to Breakpatch once, then change its role in Settings → Members. Its email and password go in your CI's secrets.
- The workspace's latest [security rules](#security-rules): they let the CI account read tests and add its runs. After updating Breakpatch, an admin publishes them again (Settings → Workspace → **Copy security rules**).

**Install**

```sh
curl -fsSL https://breakpatch.dev/install-ci | sh
```

<!-- prelaunch --> Public release coming soon. Until then, this command and the CI examples below that use it don't work. Join the list: [support@breakpatch.dev](mailto:support@breakpatch.dev?subject=Breakpatch%20release%20list)

It installs `breakpatch-ci` and the test browser in `~/.breakpatch-ci` and links the command into `~/.local/bin`. It checks every download against the release's checksums, and needs no administrator password. In GitHub Actions the next steps can run `breakpatch-ci` straight away; elsewhere, add `~/.local/bin` to `PATH` or use the full path. Running it again updates to the latest version, `BREAKPATCH_VERSION=1.2.3` installs a given one, and `sh -s -- --uninstall` removes it. You can [read the script](https://breakpatch.dev/install-ci) first.

**Run a suite from the workspace**

```sh
breakpatch-ci run --workspace team.bpworkspace --suite smoke-7f3a
```

`--suite` takes the suite's ID (on the suite, under *Start it from anywhere*) or its name. The tests run one after another, as in the app: shared steps filled in, repeats, set-up and clean-up calls. Each test's run goes into its run history, and the suite's result shows as its last run in **Suites**. The log says which test is running and, when one fails, the step and why.

**Run one test from the workspace**

```sh
breakpatch-ci run --workspace team.bpworkspace --test web-app/Qx81cT2mNz
```

`--test` takes `<app ID>/<test ID>`, or the test ID alone: open the test's **Version history** and copy it under *Run it from CI*. A value ending in `.json` is read as a test file instead.

**Which version runs**

- `--version latest` (the default): the latest saved version, as the Run button runs it.
- `--version released`: the version marked in the test's [Version history](#version-history) with **Mark as released**, so edits still in progress don't break the build. In a suite, tests with no released version are left out and listed in the result; if none has one, nothing runs and it ends with exit code `2`.
- `--version 3` (with `--test` only): that saved version.

Shared steps run the version each test's step pins, or their latest, as in the app.

**Signing in.** Set these from your CI's secrets. They're read once and never passed on to the browser, typed into a page or written to the log:

- `BREAKPATCH_CI_EMAIL`: the CI account's email address.
- `BREAKPATCH_CI_PASSWORD`: its password.

Only an account with the *CI* role is accepted. To cut a pipeline off, disable the account in Firebase Authentication, or change its password.

`--label TEXT` says who asked, for example `--label "GitHub · build 412"`. It's shown with the suite run in the app (the default is `CI`).

**Run a test file**

```sh
breakpatch-ci run --test breakpatch-tests/apps/web-app/tests/log-in.json
```

Shared steps are read from `apps/<app>/shared/` next to `tests/`. The run isn't saved anywhere.

**The result.** It prints the result as JSON: for one test, each step's result; for a suite, the counts and each test's result, with the failed step and why. It ends with one of four exit codes:

| Exit code | What it means |
|---|---|
| `0` | The test or suite passed (a suite *passed with fixes* too). |
| `1` | A test failed: a check didn't match, or something wasn't there. The JSON says which step and why. |
| `2` | Nothing ran, or not all of it could: the test file or its shared steps, the workspace file, the suite or test couldn't be read, the CI account couldn't sign in, a secret isn't allowed on a test's sites, or something went wrong inside `breakpatch-ci` (`code: "internal"`). The JSON has a `code` and a message. |
| `3` | There's no usable licence, or it's for another workspace. The JSON and the log say why. |

If a run can't be saved in the workspace (for example the security rules are out of date), the log says so and the JSON has `"saved": false`. The exit code is still the test's result.

**The machine licence.** Set these in the CI job's environment:

- `BREAKPATCH_LICENCE_KEY`: your licence key, stored as a CI secret. It's used to take a machine licence and is never saved or typed into a page.
- `BREAKPATCH_WORKSPACE`: your workspace's Firebase project ID, for example `acme-breakpatch`. Or pass `--workspace team.bpworkspace` (then you don't need it).
- `BREAKPATCH_MACHINE_ID`: a fixed name for this pipeline, for example `github-acme-web`. CI machines are often new for every job; with a fixed name every job reuses the same machine licence instead of taking a new one.
- `BREAKPATCH_LICENCE_FILE`: where the licence is kept between runs. Keep this file between jobs, with your CI's cache: then most runs don't need to check online, and the usage counts it collects get sent with the next check (see [Licences and seats](#licences-and-seats)).

`breakpatch-ci licence status` shows the licence (and takes a machine licence if needed). `breakpatch-ci licence release` gives the machine licence back, for example before you stop using a pipeline. An admin can also free it in the [back office](#the-back-office).

**Saved secrets.** A test that writes a saved secret, for example `STAGING_PASSWORD`, takes it from the environment variable `BP_SECRET_STAGING_PASSWORD` (a `-` or `.` in the name is written `_`), and from no other variable. Store the value as a CI secret. `--secret STAGING_PASSWORD` (you can give it more than once) limits which secrets a run may use. They're never the licence key or the CI account's password.

**Where secrets may be used.** The pipeline decides, not the test:

- **Tests from the workspace.** Anyone in your workspace can change a test's start page or an app's address. So a pipeline's secrets must not go wherever a test points. Name each secret's sites with `--secret NAME=https://site`, separating several sites with commas, for example `--secret STAGING_PASSWORD=https://staging.acme.com`. The secret is then typed only on those sites, and sent only to set-up and clean-up calls on them. Before anything runs, `breakpatch-ci` checks every test in the run. If a test uses a secret that isn't listed, or whose sites don't include the test's start page, its app's address or a call that sends it, nothing runs. It ends with exit code `2` and says which test and site.
- **A test file** is in your repo, so changes to it go through your usual review. `--secret NAME` without sites types it only on the test's start site, as before. You can also give its sites.

Keep the sites to your own test environments. A workspace member who can edit tests still can't make a pipeline type its secrets anywhere else.

**Options**

- `--screenshots DIR` keeps a screenshot of the step that failed, to upload as a build artifact.
- `--auto-fix` lets the AI assistant find a button that moved, as [Fixed automatically](#fixed-automatically) does in the app. It only works on a self-hosted Mac where Breakpatch is installed and its AI assistant is downloaded (Settings → AI assistant), with a licence that includes Fixed automatically. Anywhere else the run carries on without fixing and says so.
- `--fail-on-fix` fails the run when a step needed fixing.
- `--strict-systems` turns off **Allow for small differences between systems** for this run (see below).
- `--notify-url URL` sends the result to Slack, Microsoft Teams or any web address when the run ends, as the local runner does (see [Result messages](#result-messages)). Anyone with the address can post to your channel, so keep it in a CI secret and set it as `BREAKPATCH_NOTIFY_URL` instead: then it never shows in the log. `--notify-kind slack|teams|webhook` says which format to send (Breakpatch picks it from the address), and `--notify-when failures` sends only failed runs (the default is `every`). The JSON gets `"notified"`, with what Slack or Teams said if it didn't work; the exit code is still the test's result. *When it starts failing, and when it passes again* isn't available in CI, since the CI account can't read the suite's last result.

**Record and run on the same kind of machine.** Screen checks compare the page with how it looked when the step was recorded, and another system can draw text a little differently. Tests recorded on a Mac pass most reliably on a Mac with the same Breakpatch version. When a test was recorded on another system, `breakpatch-ci` says so in one line when the run starts, allows for small differences as the app's **Allow for small differences between systems** does (`--strict-systems` turns that off), and adds `systemMismatch` to the JSON, with the explanation when a check fails. See [Recorded on another system](#recorded-on-another-system).

**GitHub Actions**

```yaml
jobs:
  ui-tests:
    runs-on: macos-15
    concurrency: breakpatch-ci          # one run at a time per machine licence
    env:
      BREAKPATCH_LICENCE_KEY: ${{ secrets.BREAKPATCH_LICENCE_KEY }}
      BREAKPATCH_MACHINE_ID: github-acme-web
      BREAKPATCH_LICENCE_FILE: ${{ github.workspace }}/.breakpatch/licence.json
      BREAKPATCH_CI_EMAIL: ${{ secrets.BREAKPATCH_CI_EMAIL }}
      BREAKPATCH_CI_PASSWORD: ${{ secrets.BREAKPATCH_CI_PASSWORD }}
      BP_SECRET_STAGING_PASSWORD: ${{ secrets.STAGING_PASSWORD }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - uses: actions/cache@v4
        with:
          path: .breakpatch
          key: breakpatch-licence-${{ github.run_id }}
          restore-keys: breakpatch-licence-
      - run: curl -fsSL https://breakpatch.dev/install-ci | sh
      - run: >-
          breakpatch-ci run --workspace team.bpworkspace --suite smoke-7f3a --version released
          --label "GitHub · build ${{ github.run_number }}" --secret STAGING_PASSWORD=https://staging.acme.com --screenshots shots
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: breakpatch-screenshots
          path: shots
```

**Codemagic** (`codemagic.yaml`)

```yaml
workflows:
  ui-tests:
    name: UI tests
    instance_type: mac_mini_m2
    environment:
      groups:
        - breakpatch                    # BREAKPATCH_LICENCE_KEY, BREAKPATCH_CI_EMAIL, BREAKPATCH_CI_PASSWORD, BP_SECRET_STAGING_PASSWORD
      vars:
        BREAKPATCH_MACHINE_ID: codemagic-acme-web
        BREAKPATCH_LICENCE_FILE: $HOME/.breakpatch/licence.json
    cache:
      cache_paths:
        - $HOME/.breakpatch
    scripts:
      - name: Install breakpatch-ci
        script: |
          command -v python3.11 || brew install python@3.11
          curl -fsSL https://breakpatch.dev/install-ci | sh
      - name: Run the UI tests
        script: |
          $HOME/.local/bin/breakpatch-ci run --workspace team.bpworkspace --suite smoke-7f3a --version released \
            --label "Codemagic · build $BUILD_NUMBER" --secret STAGING_PASSWORD=https://staging.acme.com --screenshots shots
    artifacts:
      - shots/**
```

To run a test file from the repo instead, use `--test breakpatch-tests/apps/web-app/tests/log-in.json`, leave out the sign-in variables, and `--secret STAGING_PASSWORD` may leave out its sites.

**Troubleshooting**

- **"breakpatch-ci needs Python 3.11"**: install it (on a Mac, `brew install python@3.11`; in GitHub Actions, `actions/setup-python`), or point `BREAKPATCH_PYTHON` at it, and install again.
- **"command not found: breakpatch-ci"**: add `~/.local/bin` to `PATH`, or run `~/.local/bin/breakpatch-ci`.
- **Exit code 3 with "no machine licences left"**: each pipeline that runs at the same time needs its own machine licence. Set a fixed `BREAKPATCH_MACHINE_ID` so jobs reuse one, free old ones in the back office, or ask your admin to add one.
- **Exit code 3 after the clock changed or a long time offline**: the machine checks its licence online at least once a week. Make sure it can reach `https://account.breakpatch.dev`.
- **"The saved secret STAGING_PASSWORD isn't on this Mac"**: set `BP_SECRET_STAGING_PASSWORD` in the job, and add the name to `--secret` if you use it.
- **"The browser isn't installed yet"**: run the install command again. If `BP_BROWSERS_PATH` or `PLAYWRIGHT_BROWSERS_PATH` is set in the job, `breakpatch-ci` looks there instead: unset it.
- **Linux: the browser doesn't start**: install the libraries it needs with `sudo ~/.breakpatch-ci/current/bin/python -m playwright install-deps chromium`.
- **Exit code 2 with "wrong email or password"**: check `BREAKPATCH_CI_EMAIL` and `BREAKPATCH_CI_PASSWORD` in the job's secrets.
- **Exit code 2 with "not CI"** or "isn't a member of this workspace": the account needs the *CI* role. Sign in to Breakpatch with it once, then an admin changes its role in Settings → Members.
- **Exit code 2 with "The workspace refused the CI account"**: publish the latest security rules (Settings → Workspace → **Copy security rules**).
- **Exit code 2 with "would use the secret … which --secret … doesn't list"**: a test's start page, app address or set-up call is on a site you didn't give that secret. If the site is right, add it: `--secret NAME=https://site1,https://site2`. If not, someone changed the test: check its Version history.
- **"Left out: no version is marked as released"**: open the test's Version history and **Mark as released** the version CI should run, or use `--version latest`.
- **Checks fail in CI but pass in the app**: look for the line "this test was recorded on…" at the start of the log. Re-record the test on a machine like the CI machine, or run it on a Mac.

## Result messages

After each run, the local runner can send the suite's result where your team talks: **Slack**, **Microsoft Teams**, or any **web address** that takes a message. Set it in the suite (*After each run, send the result to*). Only admins can set or see it.

**When.** *After every run*, *Only when it fails*, or *When it starts failing, and when it passes again*: the first failed run after a pass, then the first pass after that. A run that was replaced by a newer request is only sent with *After every run*.

**Slack.** Make an [incoming webhook](https://api.slack.com/messaging/webhooks) for the channel (a Slack app with *Incoming Webhooks* turned on) and paste its address, `https://hooks.slack.com/services/…`. The message has the result, the counts, one line per failed test with the step and why, the screenshot if you include it, and an **Open the report** button.

**Microsoft Teams.** In the channel, add the Workflows template **Send webhook alerts to a channel** (or a workflow that starts with *When a Teams webhook request is received*), and paste its address. It ends in `environment.api.powerplatform.com`. The message is an Adaptive Card with the same things. Microsoft turned off the old Office 365 connector addresses (`….webhook.office.com`) in Teams, so Breakpatch doesn't take them. If Teams says it wants a sign-in, set *Who can trigger the flow* to *Anyone* in the workflow's first step. Older Workflows addresses on `logic.azure.com` are being replaced by Microsoft: if the test message fails, copy the workflow's address again.

**Include the failed step's screenshot** (Slack and Teams, off by default). Slack and Teams can only show a picture from a web address, so the runner puts the screenshot of the step that failed in your workspace's own Firebase Storage, at a random address. Anyone who has the message can open the picture. It needs Storage turned on in your Firebase project (new projects need the pay-as-you-go plan for it) and its rules published: Settings → Workspace → **Copy storage rules**, then Firebase console → Storage → Rules → Publish. Without it, the message goes without the picture.

**The address is a secret.** Anyone who has it can post to your channel. So it isn't stored with the suite: only admins and the runner can read it, not members or the CI account. Once saved it shows masked, like `hooks.slack.com/services/•••••`; press **Change** to paste a new one. It never goes in a message, a warning or the log.

**Send a test message** posts a sample result to the address before you rely on it, and shows what Slack or Teams answered, for example "Slack doesn't know this webhook any more".

If the address doesn't answer, the runner tries 3 times over 5 minutes. If Slack or Teams refuses the message (a removed webhook, say), it stops at once. Either way the runner's status says so.

**The report link.** **Open the report** goes to `https://breakpatch.dev/report#r=…`, which opens the run's report in Breakpatch on a Mac, and on a phone says to open it on a Mac. The part after `#` never reaches a server.

**A web address** gets the result as JSON, in a `POST`:

```json
{
  "suite": "Smoke",
  "suiteId": "smoke-7f3a",
  "result": "failed",
  "counts": { "total": 6, "passed": 4, "fixed": 0, "failed": 1, "notRun": 1 },
  "failures": [
    { "test": "Create a project", "step": "Step 5: Click Done", "reason": "couldn't find the Done button" }
  ],
  "requestedBy": "CI · build 412",
  "note": "",
  "startedAt": "2026-09-24T14:52:03.000Z",
  "durationSeconds": 292,
  "reportLink": "breakpatch://report/web-app/run_8f21c",
  "reportUrl": "https://breakpatch.dev/report#r=web-app/run_8f21c",
  "text": "Smoke failed: 4 of 6 tests passed, 1 failed, 1 not run · 4:52 · asked by CI · build 412"
}
```

`result` is one of `passed`, `passed_with_fixes`, `failed` or `replaced`. `reportLink` opens the report in Breakpatch on a Mac, and `reportUrl` does the same from anywhere (both are empty when there's no run to open). A failure can also have `explanation`, the AI assistant's sentence on why, and the message `imageUrl`, the screenshot, when the suite includes one. Use `text` as it is, or build your own message. Any relay works: n8n, Zapier, an email service. Discord and Google Chat take it through such a relay.

[breakpatch-ci](#from-ci-with-breakpatch-ci) sends the same messages with `--notify-url`.

**Updating.** Result addresses saved by an earlier Breakpatch were kept with the suite, where the CI account could read them. When an admin opens the updated app, it moves them to where only admins and the runner can read them. Update the runner Mac first, then publish the new [security rules](#security-rules). Older apps can't save in a workspace once the updated app has saved there (they say to update).

## Security rules

**Copy rules** in workspace setup gives rules with your email domain filled in. They say:

- Only signed-in accounts from your email domain, with a confirmed email address, can read or write. Runner and CI accounts are let in by their role.
- There are four roles: **member**, **admin**, **runner** and **ci**, as in [Members and roles](#members-and-roles). Whoever connects the workspace is the first admin.
- Versions can only be added. History can't be edited.
- `runRequests` accepts a small document of a fixed shape from members and from accounts with the `ci` role. Only the runner can read or delete them.
- Accounts with the `ci` role read apps, tests, shared steps, their versions and suites, and add runs marked `ci` as themselves. They can't change anything, or read members, runs or the licence.
- A test's released version must be one that's saved.
- Only admins set where a suite's result goes. Its address is kept apart from the suite, and only admins and the runner can read it.

To give an account the `ci` role, have it sign in to Breakpatch once, then change its role in Settings → Members. Or, in the Firebase console, set `role` to `"ci"` in its document `members/<user id>` in the `breakpatch` database. Disable the user in Firebase Authentication to cut it off.

A service account using the Firebase Admin SDK skips the rules altogether. Use a normal user with the `ci` role instead: `breakpatch-ci` only signs in with one.

## Licences and seats

A Team licence has **seats** for people and **machine licences** for the local runner and CI machines. The licence belongs to the workspace.

- **The admin sets up the licence once**: **Settings → Licence** → **Enter licence key** (it looks like `BP-XXXX-XXXX-XXXX-XXXX`). The key is on your licence page after you buy: see [The back office](#the-back-office).
- **Members don't enter a key.** Everyone else gets a seat by themselves when they join through the [invite link](#invite-your-team) or sign in. Only admins can see the key. Until the admin has entered it, members see "Your admin hasn't set up the licence for this workspace yet."
- **Out of seats:** the member sees "Your team is out of seats. Your admin can see you're waiting and can add a seat or free one." Admins see who is waiting in **Settings → Licence**.
- **A new key:** if the admin replaces the key, members' seats follow once an admin opens Breakpatch.
- **The local runner and CI machines use a machine licence.** Machines count separately from people. CI machines take theirs with the key: see [From CI with breakpatch-ci](#from-ci-with-breakpatch-ci).
- Each person takes a seat when they sign in. A seat someone already holds keeps refreshing. Signing out gives the seat back; so does **Release this Mac** (admins).
- A seat is tied to the Macs it's used on: one person can use it on a few of their own Macs, and a copy of the Keychain on another Mac doesn't work. On too many Macs you see "Your seat is already used on too many Macs. Ask your admin to free one, then sign in again."
- A seat nobody has used for 30 days is freed automatically. An admin can also free one in the [back office](#the-back-office).
- Breakpatch checks the licence when it opens and every day, and keeps working for up to 30 days without a connection. If this Mac's clock is set back by more than a day, the licence stops working until Breakpatch can check it online again: "This Mac's clock is behind. Set the right date and time, then reconnect to check your licence."
- **Saved secrets in CI.** `breakpatch-ci` takes a saved secret's value only from an environment variable named `BP_SECRET_<NAME>`, for example `BP_SECRET_STAGING_PASSWORD` for `STAGING_PASSWORD` (a `-` or `.` in the name is written `_`), never from other variables. `--secret NAME` (you can give it more than once) limits which secrets a run may use. It types them only on the test's start site, or, for tests from the workspace, only on the sites the pipeline gives each one (`--secret NAME=https://site`, see [From CI with breakpatch-ci](#from-ci-with-breakpatch-ci)).
- **Usage counts go with the licence check.** Each check sends how many tests were created and how many runs there were (by hand, from schedules, on the local runner and in CI), passed and failed, and on how many days Breakpatch was used, since the last check. Only numbers: never test names, addresses, steps or screenshots. The licence check already knows the licence and seat, so your admin sees the numbers per person and machine in the [back office](#the-back-office). They're part of how the licence works, so there's no switch for them in Team. `breakpatch-ci` counts its runs the same way in its licence file and sends them with its next check; on CI machines that don't keep that file between jobs they aren't sent.

Without a licence, Breakpatch keeps working as Community (tests, recording and running on this Mac) and Team features are off. A quiet banner under the title bar says why: "Breakpatch Team needs a licence. Your admin enters the key once in Settings → Licence, then everyone gets a seat when they sign in.", "Your team is out of seats. Ask your admin to add one.", "Reconnect to check your licence." (after 30 days offline) or "Your licence has expired." A runner with no machine licence left gets "Your team has no machine licences left. Ask your admin to add one."

Other messages you may see:

- "This licence key isn't recognised. Check it and try again."
- "This licence has expired. Ask your admin to renew it."
- "This licence is no longer active. Ask your admin for help."
- "This seat was freed. Sign in again to take a seat."
- "Your team is using more seats than it pays for, so this Mac's seat was freed. Ask your admin to add seats, then sign in again."
- "This licence was activated on another Mac. Sign in again on this one."

## The back office

Your licence page is at [account.breakpatch.dev](https://account.breakpatch.dev). Enter your email and open the sign-in link we send you. There's no password.

If you're one of your licence's admins, you see:

- Your plan, when it renews and how many seats are used, for example *8 of 10 seats used*.
- Who holds each seat and when it was last seen, and the machines.
- **Free a seat**, for someone who has left or a Mac you no longer use. Freeing a seat lets someone else take it.
- **Usage**: tests created and runs each week for the last 12 weeks (by hand, schedules, local runner and CI), the pass rate, and the same per person and machine.

If you bought Breakpatch Team on the [pricing page](https://breakpatch.dev/pricing/), sign in with the email you bought with: the first time, you see **Your new licence key (shown once)**. Press **Show my licence key** and keep it somewhere safe, because it isn't shown again. The same page has **Manage billing** (invoices, payment method, cancelling, through Paddle, our reseller) and **Change seats** (seats and extra machine licences, charged or credited straight away, pro rata for the rest of the billing period; credits go against your next payments; Solo has no seats to change). A cancelled licence keeps working until the end of the period you paid for.

For a licence you didn't buy on the site, contact Breakpatch to add seats or renew. If you see "No licences for this email", ask whoever bought Breakpatch Team to add you as an admin.
