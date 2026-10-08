# Breakpatch documentation

Everything about Breakpatch on one page. Use the contents or your browser's find.

Breakpatch is **Community** for now: free and open source, for one person on one Mac, with tests saved as files. The first two parts of this documentation are all Community. **Team** adds a shared workspace, version history, automatic fixing, schedules and a local runner for a whole team; **Business** is Team for bigger companies. Team and Business aren't on sale yet, and their prices aren't set. The last part describes Team as it's built today, so you can see what's coming. **Solo**, Team's automation for one person, is planned too: see [Solo](#solo).

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
10. [Get a deleted app or test back](#get-a-deleted-app-or-test-back)
11. [Saved secrets](#saved-secrets)
12. [The AI assistant](#the-ai-assistant)
13. [Updates](#updates)
14. [Privacy](#privacy)
15. [Using Breakpatch on a company network](#using-breakpatch-on-a-company-network)
16. [Troubleshooting](#troubleshooting)

**Team**

17. [What Team adds](#what-team-adds)
18. [Solo](#solo)
19. [Upgrading to Team](#upgrading-to-team)
20. [Hosted by Breakpatch](#hosted-by-breakpatch)
21. [Host it yourself](#host-it-yourself)
22. [Members and roles](#members-and-roles)
23. [Version history](#version-history)
24. [Fixed automatically](#fixed-automatically)
25. [Why did this fail?](#why-did-this-fail)
26. [Write a test from a story](#write-a-test-from-a-story)
27. [Schedules](#schedules)
28. [The local runner](#the-local-runner)
29. [Run requests](#run-requests)
30. [From CI with breakpatch-ci](#from-ci-with-breakpatch-ci)
31. [Result messages](#result-messages)
32. [Create an issue](#create-an-issue)
33. [Security rules](#security-rules)
34. [Licences and seats](#licences-and-seats)
35. [The back office](#the-back-office)
36. [Encryption and the recovery code](#encryption-and-the-recovery-code)

---

# Getting started

## Install

You need a Mac with Apple Silicon, 16 GB of memory and macOS 14 or later. Linux comes next, then Windows: see the [roadmap](https://github.com/BreakPatch/breakpatch/issues/48).

Open Terminal and paste this:

```sh
curl -fsSL https://breakpatch.dev/install | sh
```

It checks your Mac, downloads the latest Breakpatch from [GitHub Releases](https://github.com/BreakPatch/breakpatch/releases) (over https only, and only from Breakpatch's own releases), checks the download against the release's checksums, checks the app is signed with Breakpatch's certificate, puts Breakpatch in Applications and opens it. If you have `minisign`, it also checks the download's signature with Breakpatch's update key. If your account can't write to Applications, it uses `~/Applications` instead. It never asks for your password, changes nothing else on your Mac and sends nothing about you or your Mac to Breakpatch. Don't run it with `sudo`: it refuses to run as root. You can [read the script](https://breakpatch.dev/install) first.

Breakpatch Community is a beta: it works, but expect some rough edges. Tell us about problems in [GitHub issues](https://github.com/BreakPatch/breakpatch/issues) or at [support@breakpatch.dev](mailto:support@breakpatch.dev), and new versions arrive by themselves (see [Updates](#updates)).

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
3. Click through the page the way a person would. Breakpatch highlights what you clicked and asks, for example, "Click Log in button?". Press **Confirm** (or Enter) and it becomes a step on the right.
4. Press **Save**, then **Run**.

Your first test takes about 5 minutes, so about 10 minutes from install to your first run. The rest of this documentation covers each part in more detail.

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
  deleted/                        Recently deleted, for 30 days (see Get a deleted app or test back)
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
- **Leave out Recently deleted too.** Add `breakpatch-tests/deleted/` to `.gitignore`, so deleting a test shows in Git as a deleted file and nothing else. Git keeps it in the history anyway.
- **Secrets never land in the folder.** Tests only store a secret's name. The value stays in this Mac's Keychain. See [Saved secrets](#saved-secrets).
- **Pulled a change?** Switch back to Breakpatch and it reads the folder again.
- **Merge conflict in a test file?** Fix it as you would any JSON file. Until it's valid again, Breakpatch skips that file and tells you which one.
- **Saved by a newer Breakpatch?** If `breakpatch.json` has a higher `schemaVersion` than your app knows, update Breakpatch to open the folder. If it changes while the folder is open, saving stops until you update. Your first phone or tablet test raises it, so update Breakpatch on every Mac that uses the folder.

Settings → Tests folder shows the folder, how many apps and tests it has, **Show in Finder** and **Change folder**. Changing folders leaves the old one as it is, with all its tests.

## Record a test

1. Open an app → **New test**. Give it a name, a start address and a **Screen size**: a computer screen, or a phone or tablet (see [Phones and tablets](#phones-and-tablets)). The screen size is fixed once you start.
2. Optional: under **Before and after the test**, add a **set-up call** (for example, to add sample data) and a **clean-up call**. Each is a method (GET, POST, PUT, PATCH or DELETE), a web address and, if you like, headers; the run waits for the reply. **Try it** makes the call once.
   - Calls use `https://` and go to the app's own address or another host under the same domain, for example `api.example.com` for an app at `app.example.com`. Plain `http://` is only for an app on this Mac (`localhost`).
   - Private and local network addresses are refused, unless the app itself is on one. **Allow other hosts** lets this test call any host and private addresses. Cloud metadata addresses are never called.
   - Redirects aren't followed: use the address the call ends up at.
   - A header's value can be a saved secret, for example an `Authorization` token. The secret must be allowed on the call's site, like typing it (see [Saved secrets](#saved-secrets)).
   - Logs show the address without its query string, and never a header's value.
3. Add steps on the page:
   - **Click** anything on the page. Nothing happens to the page yet: Breakpatch highlights what you clicked and asks, for example, "Click Next button?". Press **Confirm** (or Enter, or click it again) to do the step; **Try again** to pick something else; Esc to cancel. Dragging and scrolling on the page work the same way.
   - Describing a step in words, instead of clicking it, is coming back in a later update.
   - For **Wait until** and **Checkpoint**, draw a box around the area on the page, or click it.
   - **Write text** has a box for what to type, and **Go to address** a box for the address.
4. Use the action button in the bar below the page for everything else: double, long and right click, hover, swipe, scroll, drag and drop, **Write text**, **Wait until**, **Go to address**, reload, back and forward, tabs and popups, upload a sample file, check a download, **Checkpoint**, **Repeat** and **Shared steps**.
5. Press **Save**.

Screen checks are worked out automatically after every step. There's nothing to draw or approve.

**Test details** (in the test's **⋯** menu on the Tests tab, or from the recorder's title bar) changes a test's name, description and start address after it's made. After a new start address, check the first steps still make sense from there. In Team a new start address on a test with steps saves a new version, so older versions, and a version marked as released, keep starting where they did.

Select a step to open it. **What to look for** is the plain description of what the step acts on, for example "Done button, bottom right of the Create project dialog". Edit it if it's wrong. **What should happen** says how a run judges the step: a new page opens, something closes or disappears, something appears, text or a value changes, or nothing visible changes. Breakpatch picks one when you record; change it with one click. **+ note** adds a few words, like "closes the What's new dialog": the AI assistant reads them only when the step's check fails, to judge whether the failure is real and to say why.

Under that: **Play to here** starts a new browser and plays the test from the start up to and including this step. **Play this step** does only this step, on the page as it is now, and never plays the steps before it: if the page isn't where the step expects, the step fails with its usual reason. The **⋯** menu has **Edit** (the step's text, secret, address, seconds, sample file, repeat count or name), **Re-record** (do the step again on the page; not for a wait of some seconds), **Duplicate**, **Add a step after** and **Delete**. Hover between two steps, or tab to it, for **+** to add a step there: the next step you record goes there. If the page isn't at that step, a line over the page says so, with **Play to here** to get it there (or use **Use the page**); nothing plays by itself. **Run** plays the whole test in the recorder's browser and leaves the page where it stopped.

**Use the page** (✋ above the page, or ⌘E) lets you work the page yourself, for example to close a banner or sign in by hand before you record the next step. Your clicks, scrolling and typing go straight to the page and nothing is recorded; a coloured ring and a line over the page remind you. Press **Done** or ⌘E to go back to recording (Esc goes to the page). A typical use: a step fails, you put the page right by hand, then press **Play this step**; its result says it played on a page set up by hand. **Run** and **Play to here** always start in a new browser, so nothing you did by hand is carried into them. What you type in this mode is never saved or logged.

**Uploading a file.** When a click opens the page's file picker, Breakpatch asks which file to use: one of the sample files, one of **Your files**, or **Choose from this Mac…**. A file from your Mac is copied into the tests folder's `files` folder, so the test uploads the same file on every run and on every Mac that has the folder. If the file is missing when the test runs, the step fails with "files/photo.jpg isn't in the tests folder." **Cancel, just click** records a plain click.

**Passwords.** When you write into a field that hides what's typed, the step shows as `Write "••••••••"` (the eye shows it) and Breakpatch asks once: "This looks like a password. Save it as a saved secret?" **Save as secret** keeps the value in this Mac's Keychain and the step uses the secret; **Keep as typed text** is fine for a sandbox account; **Don't ask again for this app** stops asking. The screen checks leave the inside of the field out, so another password of another length still passes.

**Checkpoint** checks that something is on screen, like "Project created": click it, or draw a box around it. **Write text** types what you put in its box (**Typed text**), a **Saved secret**, or a **Generated** value made at run time: a unique name, the time now, today's date or the repeat number. **Insert** adds one of those to typed text, like `Test project {time}`.

### Phones and tablets

To test your site on a phone or tablet, pick one under **Screen size** in **New test**. The phones are iPhone 15, iPhone SE, Pixel 8 and Galaxy S24. The tablets are iPad, iPad Pro 11 and Galaxy Tab S9. An app's **Default screen size** can be one too.

- The page gets the device's screen size and a touch screen, and it's told which device it's on. A site with a phone layout shows that layout.
- It's still Breakpatch's own browser, Chromium. An iPhone test shows your site at an iPhone's size, not as Safari draws it.
- The page view shows the device's frame. The bar above it names the device.
- You still use your mouse. A click on the page adds a **Tap**. The action button has **Tap**, **Double tap**, **Long press**, **Swipe**, **Scroll** and **Drag and drop**, and each is done with a finger on the page. **Right click** and **Hover** need a mouse, so phone and tablet tests don't have them.
- With **Use the page** on, your clicks and drags are taps and finger moves too.
- Screen checks work as in any test, at the device's screen size. The page is drawn at normal sharpness, not the phone's, so screenshots are the size of the page.
- The run view and the report name the device.

A test's device is fixed once you start, like any screen size. Tests made before phones and tablets stay computer tests. Older versions of Breakpatch can't run phone and tablet tests. Your first one marks the tests folder as newer, so an older version won't open it. In Team, it marks the workspace, and an older version stops saving there. Either way, no older version runs the test as a computer test.

## Run a test and read the report

Press **Run**. The live view shows each step as it runs. Each step is checked before and after it acts, and the first failure stops the run with a plain reason, for example "Couldn't find the Done button".

**Run all** on an app's page runs each of its tests in turn, like a suite, and saves each test's run. Tests with no steps yet are left out, so they don't fail it.

The report shows what was expected next to what was on screen, why it stopped and what to try. Press **Re-record this step** to fix it straight away.

Common reasons:

- **Couldn't find the Done button.** It wasn't where it was when the step was recorded. If the app changed on purpose, re-record the step. In Team, the AI assistant can find it for you: see [Fixed automatically](#fixed-automatically).
- **The screen didn't look as expected after this step.** The page looked different once the step was done.
- **Nothing happened after this step.** The step was done, but nothing changed on the page the way it did when it was recorded.
- **Waited too long for the page.** If the app was slow this time, run again.
- **Saved secret is missing on this Mac.** Add it in Settings → Saved secrets, then run again.
- **STAGING_PASSWORD isn't allowed on login.example.com.** The page wasn't one of the secret's sites, so nothing was typed. If that site is right, add it to the secret in Settings → Saved secrets.

Every error has **Copy**, with two choices: **Plain text**, to paste into a message or send to a developer, and **Markdown, for an issue**: a ready-made bug report with a title, the steps up to the failure, what was expected and what was seen, the reason, and where and when it ran. Paste it into GitHub, Jira, Linear or any tracker that takes Markdown. In Team, **Create issue** makes the issue for you: see [Create an issue](#create-an-issue).

In Team, a failed step also has **Why did this fail?**: the AI assistant says in plain words what changed on the screen. See [Why did this fail?](#why-did-this-fail).

### Export a report

**Export** on a run's report saves it for people who don't have Breakpatch. A finished suite run, and **Run all**, have **Export** too: one report with every test in it.

- **Web page (HTML).** One file that opens in any browser, offline, without Breakpatch or a sign-in. Attach it to a ticket or an email, or drop it in a chat. It has the summary (with the device, for a phone or tablet test), every step with its result, the reason and where the time went, and the AI assistant's explanation when there is one. Steps open and close with a click, the one that failed is open, and it follows the reader's light or dark setting (**Theme** switches it). It never loads anything from the internet.
- **PDF.** Opens the print dialog with the same report, every step open. Choose **PDF → Save as PDF**. A saved web page prints the same way from any browser.
- **JUnit XML.** For CI dashboards: GitHub, GitLab and Jenkins read it. One test case per test, with the failed step and why. It has no screenshots.

A suite's report starts with the tests that didn't pass, each a link to it; tests that passed start closed (**Open all steps** opens everything).

**Screenshots.** The web page and the PDF include the screenshots the run took: full size for the step that failed, small for the others (steps that were fixed automatically). A 30-step run stays under about 5 MB. Screenshots can show personal data, like names, email addresses or account details on the page, so the dialog says so while they're included: turn off **Include screenshots** when the report goes to people who shouldn't see that. A run from another Mac has no screenshots on this one, so its report goes without them.

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

## Get a deleted app or test back

Deleting an app, a test, shared steps or a suite moves it to **Recently deleted** for 30 days. It takes everything in it along: an app its tests, shared steps and runs; a test its version history and last run. Nothing changes for 30 days; then it's deleted for good.

It goes at once, without asking. A message at the bottom says where it went, with **Undo** to put it straight back and **Open Recently deleted**.

To put it back: Settings → **Recently deleted**. Each item says what it is, which app it's in, when it was deleted and how many days it has left. **Restore** puts it back where it was. On an app's page, a line under the tests says how many of its tests and shared steps are in Recently deleted and opens the list.

- **A deleted app keeps its own.** Its tests and shared steps aren't listed one by one: restore the app and they come back with it, together with anything deleted in it before.
- **Something took its place?** If you made a new test with the same name since, the restored one comes back next to it, as *log-in-2*.
- **Suites keep deleted tests.** A suite that has a test in Recently deleted keeps it and names it in the suite, with **Restore** (when you may restore it) and **Open Recently deleted**; runs skip it (*Couldn't run: it was deleted*) until it's restored. A test that's gone for good leaves the suite the next time you save it.
- **Shared steps in use can't be deleted.** Their **Delete** is greyed out and says how many tests use them: take them out of those tests first.
- **Delete now** (the bin icon next to Restore) deletes one for good at once, after asking. That can't be undone.

In a tests folder, Recently deleted is the `deleted/` folder: one folder per deleted item, with its files as they were and a `deleted.json` that says what it is. Breakpatch deletes what's older than 30 days when it opens the folder.

**In a team workspace** Recently deleted is the same for everyone. Restoring and deleting for good are for whoever may delete it: admins for apps, shared steps and suites, and a member for their own tests that aren't in the team suite. Anything else says *Only admins can restore this*. Other Macs see a deleted or restored item at once.

- **Hosted by Breakpatch** deletes what's older than 30 days once a day, with everything in it. Things in Recently deleted don't count toward your plan's number of apps, tests, shared steps and suites, but they still use storage until they're gone: use **Delete now** to free it. When the plan is full, restoring waits until there's room, like adding one.
- **Hosted yourself**, there's no server of ours to do it: an admin's Breakpatch deletes what's older than 30 days, once a day, while it's open. If no admin opens the workspace, it stays in Recently deleted (and in your database) until one does.
- Update Breakpatch on every Mac, the local runner too, and `breakpatch-ci` on your CI machines, before you delete anything. The first time something goes to Recently deleted, the workspace moves to a newer format: Breakpatch from before Recently deleted can still open it, but can't save anything there any more, runs included (*Update Breakpatch to save changes*), because it would show deleted items as if they weren't. Hosted yourself, publish the security rules again first (Settings → Workspace → **Copy security rules**): older rules refuse the delete.
- Runs of a deleted test stay in the app's **Runs** tab until the run history deletes them; a deleted suite's runs stay in its history the same way.

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

A small AI model that runs only on your Mac. Your screens never leave it. It names what you click, and is unloaded when it's idle.

On sites with good page structure (buttons, links and fields that say what they are), Breakpatch names what you click at once, from the names the page gives them, without the AI assistant. It uses the AI assistant when the page doesn't say, or draws everything itself, like Flutter apps and canvas pages. Either way it clicks a spot on the screen and checks the step on the screen.

Breakpatch comes with one AI model, the **Standard** assistant (Qwen3-VL 4B, about 3 GB), which setup downloads. It works well for almost every team. It's the only model for now: bringing your own local one, through Ollama or LM Studio, isn't available yet. Cloud AI models aren't planned: your screens stay on your Mac. (A Team [runner Mac](#the-local-runner) with 32 GB of memory or more can also download a larger one, about 5 GB, but it's rarely needed.)

Settings → AI assistant shows which one you have, the space it takes and your Mac's memory, and lets you remove it. Recording needs it to name what you click, so setup downloads it before your first test. Finding buttons that moved during a run ([Fixed automatically](#fixed-automatically)), explaining a failure ([Why did this fail?](#why-did-this-fail)) and suggesting a test's steps from a story ([Write a test from a story](#write-a-test-from-a-story)) come with Team.

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

## Using Breakpatch on a company network

Company networks often check the traffic that leaves them: a proxy every connection goes through, *TLS inspection* (a firewall such as Fortinet, Zscaler, Palo Alto or Netskope opens HTTPS connections, checks them and signs them again with the company's own certificate), and a web filter that blocks sites by category. Breakpatch works on these networks once they let it through. This is what it needs, and what to ask IT for.

**What Breakpatch connects to.** Setup downloads the browser from `cdn.playwright.dev` and `playwright.download.prss.microsoft.com`, and the AI assistant from `huggingface.co` (its files come from `cdn-lfs.huggingface.co`, `cdn-lfs.hf.co` and `cas-bridge.xethub.hf.co`). Updates come from `github.com` (the files from `objects.githubusercontent.com` and `release-assets.githubusercontent.com`). Licences, the hosted workspace and the anonymous usage counts use `breakpatch.dev` and `account.breakpatch.dev`. A Team workspace also uses Google Firebase: `firestore.googleapis.com`, `identitytoolkit.googleapis.com`, `securetoken.googleapis.com` and `firebasestorage.googleapis.com`, and for one hosted by Breakpatch `europe-west1-breakpatch-cloud.cloudfunctions.net`. And during a test, the browser opens your own app, and set-up and clean-up calls go to its hosts.

**Certificates.** Breakpatch trusts the certificates your Mac trusts: the app, its engine, the setup downloads and the browser all trust the certificates in the macOS Keychain, including one IT installs there, and none of them ever skips the check. On a network with TLS inspection, IT installs the network's root certificate on company Macs (usually through device management), and then Breakpatch just works. If it isn't installed, you see:

> Your network replaced the website's certificate (common on company networks). Breakpatch trusts the certificates your Mac trusts; ask IT to install the network's certificate on this Mac.

Ask IT to install the network's TLS-inspection certificate in the **System** keychain and mark it trusted (Keychain Access → System → the certificate → Trust → **Always Trust**), or to exempt the addresses above from inspection. A certificate added only to Firefox, or only for one command-line tool, isn't enough. When a test's own app or a set-up call has a certificate of its own making (a staging server), Breakpatch says it doesn't trust that host's certificate: add that certificate to the Keychain the same way.

**Proxies.** Breakpatch uses the proxy set in **System Settings → Network → your network → Details → Proxies**: **Web proxy (HTTP)** and **Secure web proxy (HTTPS)**, with **Bypass proxy settings for these hosts and domains**. The app, the setup downloads and the browser all follow it. The browser that runs your tests is Chromium, which follows every macOS proxy setting, including **Automatic proxy configuration** (a PAC file) and **Auto proxy discovery**.

- **Automatic proxy configuration.** The app and the setup downloads don't read a PAC file or auto discovery: only the browser does. If setup can't download on such a network, ask IT for the proxy's address and either add it as the Secure web proxy, or set it for apps you open from then on with `launchctl setenv HTTPS_PROXY http://proxy.example.com:8080` in Terminal and open Breakpatch again (until you log out). `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` set this way take the place of the System Settings proxy.
- **A proxy that asks for a password.** Breakpatch can't use a password saved in System Settings, so a proxy that asks for one stops the app's connections and the setup downloads (setup and set-up calls say the proxy asks for a password). Ask IT to let this Mac through without a password (by its address, or for the addresses above). If they can't, put the user name and password in the address you set with `launchctl setenv HTTPS_PROXY http://name:password@proxy.example.com:8080` (an `@` or `:` in them written as `%40` and `%3A`); other apps you open can read it too, so it's the last choice. The browser running your tests can't type a proxy password either; a proxy that signs you in with your Mac's company login (Kerberos) usually works without one.
- **Set-up and clean-up calls** go through the proxy to the address Breakpatch checked ([Record a test](#record-a-test)), not to the name, so the address rules still hold. Your Mac must still be able to look the name up itself, and some proxies refuse a connection to an address without a name: then ask IT to allow your app's hosts, or to add them to the bypass list.

**Web filters.** Company web filters (FortiGuard, Cisco Talos, Palo Alto Networks, Zscaler, Symantec WebPulse and others) sort sites into categories and may block a site they haven't seen before as *new*, *newly registered* or *unrated*. `breakpatch.dev` is a new domain, so a filter may block it until it has been rated. A blocked address shows as the setup download stopping, "Couldn't reach the licence service", or a page saying your network blocked it. Ask IT to:

1. allow the addresses above (or `*.breakpatch.dev`, `*.huggingface.co`, `*.hf.co`, `cdn.playwright.dev`, `playwright.download.prss.microsoft.com`, `github.com` and `*.githubusercontent.com`);
2. ask their filter's vendor to rate `breakpatch.dev` (each vendor has a page for asking to re-rate a site: FortiGuard, Cisco Talos, Palo Alto URL Filtering, Zscaler and Symantec Site Review). It's software for testing websites, usually *Information Technology* or *Software*; and
3. if they inspect TLS, install the network's certificate on the Mac (above), or exempt these addresses from inspection.

You can also send IT this section: [breakpatch.dev/docs/#using-breakpatch-on-a-company-network](https://breakpatch.dev/docs/#using-breakpatch-on-a-company-network).

## Troubleshooting

**"Couldn't open this folder."** The folder was moved or deleted, or Breakpatch can't save files there. Choose a folder you can write to.

**"This folder was saved by a newer Breakpatch. Update to open it."** Someone saved these tests with a newer version. Update Breakpatch from Settings → About.

**A test file was skipped.** It isn't valid JSON, often after a merge conflict. Fix the file and switch back to Breakpatch.

**"Setup paused."** The download stopped, usually because the connection dropped. Nothing's lost. It continues when you're back online.

**"Your network replaced the website's certificate", a proxy or a blocked site.** See [Using Breakpatch on a company network](#using-breakpatch-on-a-company-network).

**"The AI assistant isn't downloaded yet."** Finish setup, or download it in Settings → AI assistant. You need it to record.

**macOS asks to let Breakpatch use your Keychain.** macOS only lets the app that saved a Keychain item read it without asking, and it tells apps apart by their code signature. Copies from the install command, the releases and the in-app updates are all signed with Breakpatch's certificate, so they never ask. When you're asked, the copy asking isn't signed that way: usually one you built yourself, or one from somewhere else.

- If you built it yourself, press **Allow**. It lets that copy read that one item this time, and you're asked again next time. Don't press **Always Allow**: it would let any program signed like that copy read your saved secrets and licence from then on, without asking you.
- If you didn't build it yourself, press **Deny**, delete that copy and install Breakpatch again with the [install command](#install).
- The prompt names the item: one of your saved secrets (`dev.breakpatch.secrets`) or the Team licence (`dev.breakpatch.licence`).

**Copy details.** Every error has a *Copy details* button. Paste that into an [issue](https://github.com/BreakPatch/breakpatch/issues).

---

# Team

<!-- soon --> Coming later. Team and Business aren't on sale yet, and their pricing is to be decided. To hear when they are, email [support@breakpatch.dev](mailto:support@breakpatch.dev?subject=Breakpatch%20Team).

Everything in this part comes with **Breakpatch Team** (and Business, which is Team for bigger companies). It describes Team as it's built today. The Breakpatch you install already has it inside: a Team licence turns it on, so there's nothing to reinstall when it goes on sale. [Solo](#solo) says which parts Solo, planned for one person, includes.

## What Team adds

- **A shared workspace**, [hosted by Breakpatch](#hosted-by-breakpatch) with nothing to set up, or in your company's own Google Firebase project ([Host it yourself](#host-it-yourself)): your team's apps, tests, suites and runs in one place. A test is *Only you* until you add it to the team suite. Then it's *In team suite*.
- **Members and roles**: member, admin, a runner account and a CI account.
- **Version history.** Every save is kept. Runs show which version they tested, and you can restore any version.
- **Fixed automatically.** When a button has moved, the AI assistant finds it during the run and carries on. You accept the new position in the report.
- **Why did this fail?** In the report, the AI assistant says in plain words what changed, for example "The Save button now reads “Save changes”", with the likely cause and what to do.
- **Write a test from a story** (coming with Team). Paste a short user story. The AI assistant suggests the steps, and you check each one on the page before it's added.
- **Schedules** for suites, on any days and time.
- **The local runner**: one Mac that runs suites for the whole team.
- **Run requests** from CI or any other tool, and **result messages** after every suite run, to Slack, Microsoft Teams or any web address.
- **Create issue** in GitHub, Linear or Jira from a failed step, with the steps, the screenshot and a link to the report.
- **`breakpatch-ci`**: run the workspace's suites on your CI machines, with the results in the run history.

Prices, seats and support for Team and Business are set when they go on sale, on the [pricing page](https://breakpatch.dev/pricing/).

Workspaces hosted by Breakpatch aren't open yet either. Until they are, a workspace lives in your company's own Firebase project, set up as in [Create a workspace](#create-a-workspace).

## Solo

<!-- solo-soon --> Coming later. Solo isn't on sale yet. To hear when it is, email [support@breakpatch.dev](mailto:support@breakpatch.dev?subject=Breakpatch%20Solo).

Solo is planned for one person who wants Team's automation for themselves, on their own tests folder. This is how it works in the app today. Its price isn't set.

<!-- stack 3 -->
| | Community | Solo | Team and Business |
|---|---|---|---|
| People | 1 | 1 | Your team |
| Where tests are kept | A folder | A folder or Git, or your own workspace if you want one | Hosted by Breakpatch (coming later), or your company's own Firebase project |
| Fixed automatically | No | Yes | Yes |
| Why did this fail? | No | Yes | Yes |
| Copy a failure as Markdown | Yes | Yes | Yes |
| Create issue in GitHub, Linear or Jira | No | No | Yes |
| Schedules, notifications and result messages | No | Yes, on your Mac | Yes |
| The CI command line | No | Yes | Yes |
| Run requests, the local runner and version history | No | With your own workspace | Yes |
| Members, roles and sharing | No | No | Yes |
| Support | GitHub issues | Set when it goes on sale | Set when they go on sale |

- **Your tests stay where they are.** Solo works on your [tests folder](#the-tests-folder), or a folder you keep in [Git](#git-tips). There's nothing to set up in the cloud.
- **A workspace is optional.** For [run requests](#run-requests), the [local runner](#the-local-runner) and [version history](#version-history), connect a workspace of your own ([Create a workspace](#create-a-workspace)). It stays yours alone: Solo has no members or invites.
- **The licence.** With your tests folder open, go to **Settings → Licence** → **Enter Solo licence key**, and give the email you bought Solo with and the key (it looks like `BP-XXXX-XXXX-XXXX-XXXX`). The key stays in this Mac's Keychain. It works on one Mac at a time. To use it on another Mac, press **Release this Mac**, or free it on your licence page at [account.breakpatch.dev](#the-back-office), then enter the key on the new Mac. A Team or Business key there says "This is a Team licence key. Team licences are used in a workspace: connect or create one, then enter the key there."
- **Schedules on your Mac.** Set a suite's [schedule](#schedules) and where its [result message](#result-messages) goes, as in Team. The suite runs on this Mac while Breakpatch is open, one test at a time: if you're running a test yourself, it waits for it. If a time came while Breakpatch was closed or the Mac was asleep, the suite runs once when you open the folder again (or the Mac wakes), not once for every time it missed, and only if that time was in the last 24 hours. Its run history says so, for example "This 8:00 run was missed, so it ran when Breakpatch opened at 9:14." When it finishes, you get a notification if Breakpatch is in the background (**Settings → Notifications** says which). The result message's address stays in this Mac's Keychain, never in the folder, so it doesn't end up in Git. The failed step's screenshot needs a workspace, so it isn't sent from a folder. A saved secret a scheduled test types needs **Runner can use** turned on in **Settings → Saved secrets**.
- **One machine licence**, for [breakpatch-ci](#from-ci-with-breakpatch-ci) or a runner. Your Mac and the machine licence each run one test at a time. Solo has no extra machine licences. In CI, set `BREAKPATCH_LICENCE_KEY` to your Solo key and leave `BREAKPATCH_WORKSPACE` out to run test files from your folder (`--test FILE.json`); a second job on the same machine waits for the first.
- **Your own workspace, if you want one.** After you connect it, **Settings → Licence** offers **Use Solo here**: it's the same seat, for the same email, so there's no key to type. The workspace has no **Members** page and no invite link.
- **One Solo per company, for companies without Team.** If someone at your company already has Solo, the pricing page offers Team instead. If your company already uses Team or Business (an admin or anyone with a seat has an address at your company), ask its admin for a seat there: Solo isn't sold for it. Your company is your email's domain, with its subdomains: `eng.acme.co.uk` and `acme.co.uk` are one company. A personal address (such as Gmail or iCloud) counts on its own.
- **Moving to Team** keeps your tests. Email [support@breakpatch.dev](mailto:support@breakpatch.dev) to switch your plan, then follow [Upgrading to Team](#upgrading-to-team): connect or create the workspace, press **Use Solo here** (or enter the Team key if you have it already), and move your tests. Suites keep their schedules; set where their results go again in each suite. Then, in **Settings → Licence**, press **Replace key** and enter the Team key. The Solo seat on this Mac is given back.

## Upgrading to Team

There's nothing to install: the Breakpatch you got with the [install command](#install) already has Team inside, and a licence turns it on. (A copy you build yourself from the open-source repository is Community only.) The AI assistant, the test browser, your settings and your saved secrets stay as they are, and Breakpatch opens your tests folder like before. Once Team is on sale, go to **Settings → Upgrade to Team** (or **Upgrade to Team** on Home); until then, a tests folder doesn't offer it:

1. **Connect a workspace**: sign in to one [hosted by Breakpatch](#hosted-by-breakpatch), [create one of your own](#create-a-workspace), or open an invite link from your team. Then sign in.
2. **The licence.** A hosted workspace needs no key: Breakpatch sets up everyone's seat. If you created a workspace of your own, enter the licence key once in **Settings → Licence** (it looks like `BP-XXXX-XXXX-XXXX-XXXX`). If you joined with an invite link, the link sets up your licence and there's no key to enter. See [Licences and seats](#licences-and-seats).
3. **Move your tests**. Choose the tests folder. Breakpatch shows what it will copy first, for example "1 app, 12 tests, 3 shared steps and 2 suites will be copied.", and you can rename apps, or merge them with apps the workspace already has. It then copies the apps, tests, shared steps, suites and the last run of each test, unless that run is over 90 days old, into the workspace.
4. **Check, then move to the Trash.** Breakpatch reads everything back from the workspace and compares it with the folder. Only when it all matches, and you confirm, does it move the folder's `breakpatch.json`, `apps` and `suites` to the Trash, so there's one place to edit your tests. To undo it, drag them from the Trash back into the folder.

Good to know:

- **Changed your mind?** The connect screen always has a way back at the top: to where you came from, or **Back to your tests folder**, also after **Switch workspace**.
- **Only Breakpatch's files move.** Everything else in the folder stays as it is. If the folder is in a Git repository, the removed tests show as deleted files to commit, and earlier versions stay in the repository's history.
- **If the move stops half way** (the Mac restarts, say), Breakpatch picks it up where it left off the next time you open **Upgrade to Team**.
- **A report of the move** is kept in Breakpatch's data folder on this Mac: what was copied, what went to the Trash, and anything left out.
- **Each test starts at version 1** in the workspace, because the folder keeps only the latest version.
- **Runs over 90 days old aren't copied**, because the workspace keeps runs for 90 days (see [Run history is kept 90 days](#run-history-is-kept-90-days)). Breakpatch says so before it copies, and the report lists them. They go to the Trash with the folder.
- **Saved secrets** travel as names in the steps. Their values stay in this Mac's Keychain; teammates add their own in **Settings → Saved secrets**.
- **Files that can't be read** stop the move until you fix them in the folder, so nothing unread goes to the Trash.
- **Already in the workspace?** Anything that's already there is left out. If a test there differs from the folder's (a teammate copied an older version, say), Breakpatch names it, and you can keep the workspace's version.
- A folder saved by a newer Breakpatch can't be moved until you update.

## Hosted by Breakpatch

<!-- soon --> Coming later. Until then, keep your team's tests in your own Firebase project: see [Host it yourself](#host-it-yourself).

The easy way to a Team or Business workspace: Breakpatch keeps it for you, in Europe, with nothing to set up. Everyone signs in with their work email and a code; there are no passwords. It's the same Breakpatch as a workspace of your own, with the same tests, suites, runs and roles.

### Sign in

**Connect a team workspace** → **Hosted by Breakpatch**. Type your work email and choose **Email me a code**. Enter the 6 digits from the email (it comes from signin@breakpatch.dev and works for 10 minutes). Breakpatch then lists your workspaces and your invitations: click a workspace to open it, or **Join** one you're invited to.

This Mac stays signed in to your Breakpatch account, so next time the list opens straight away. **Use another address** signs it out. If a workspace asks you to sign in again, it shows **Open** *the workspace* with the address you're signed in as: choose **Continue**, or get a new code.

### Create the hosted workspace

A licence's admin does this once, after getting Team or Business. Sign in as above with the address the licence has for its admin, then choose **Create a hosted workspace**, give it a name, choose the country your company is in and press **Create workspace**. You're its first admin, and the licence's other admins are invited. Your data is stored in Europe. Hosting for companies in the EU and the EEA isn't open yet: those countries say *(coming later)* in the list, and choosing one offers **Host it yourself** instead.

Creating it turns on [encryption](#encryption-and-the-recovery-code): the workspace's key is made on your Mac, and Breakpatch never has it. Straight away, Breakpatch shows the workspace's **recovery code**: save it (**Save recovery kit (PDF)** or **Copy code**) and type back the 4 characters it asks for. The window stays open until you do, or until you choose **Skip, I'll make a new one later** and confirm. Without the code, losing every Mac that has the key means losing the tests.

There's no licence key to enter: Breakpatch gives everyone in the workspace their seat, the runner Mac too. Runs are kept for 90 days, or 365 with a licence that includes the longer history, then deleted; the Create screen says which.

### Invite people

Settings → **Members** → **Invite people**: type their email addresses, choose **Member** or **Admin**, and press **Send invitations**. Each gets an email. They open Breakpatch, choose **Hosted by Breakpatch**, sign in with that address and choose **Join**.

- Invitations last 14 days. **Waiting to join** lists them; × takes one back.
- **Anyone at @yourcompany.com can join** lets people with an address at your own company's domain join without an invitation. It's never offered for public addresses such as Gmail or Outlook.
- A workspace holds its seats plus 5 people.
- **Remove from workspace** stops someone opening it at once. To let them back, invite them again.

### A runner Mac and CI

A runner Mac and CI sign in with a token instead of an email. An admin makes one in Settings → **Local runner**:

- **Set up a runner Mac**: name it, press **Make the token** and copy it. Runner tokens start with `BPM1-`. It's shown only this once. On the runner Mac choose **Connect a team workspace** → **Hosted by Breakpatch** → **This is a runner Mac**, and paste it. That Mac becomes the workspace's [local runner](#the-local-runner), and its runs show under its name. The runner's checklist in Settings → Local runner has the same **Set up a runner Mac** button.
- **Add a CI token**: for [breakpatch-ci](#from-ci-with-breakpatch-ci). CI tokens start with `BPC1-`; one made earlier starts with `BPM1-` and keeps working. The window lists what CI needs, each with its own **Copy**. In CI, set `BREAKPATCH_WORKSPACE=hosted:<workspace>`, and the secrets `BREAKPATCH_WORKSPACE_TOKEN` (the token), `BREAKPATCH_MACHINE_KEY` (the workspace's [machine key](#encryption-and-the-recovery-code)) and `BREAKPATCH_LICENCE_KEY` (your licence key, for [the machine licence](#from-ci-with-breakpatch-ci)). There's no `.bpworkspace` file or CI account: `breakpatch-ci run --suite smoke-7f3a` signs in with the token.
- **The wrong one in the wrong place** is refused before anything is sent, and the message says which it got and which goes there. A CI token pasted on the runner Mac says "That's a CI token, for breakpatch-ci. This Mac needs a runner token, which starts with BPM1-". A runner token or the runner's machine pass in `BREAKPATCH_WORKSPACE_TOKEN` says that breakpatch-ci needs a CI token, which starts with `BPC1-`. A token typed as a licence key says it isn't one. The runner's **machine pass** (also `BPM1-…`, but longer) is never typed: Breakpatch gives it to the runner.
- The trash button next to a token stops it working at once. A workspace holds its machine licences plus 2 tokens.

### Plan, region and usage

Settings → **Workspace** shows the plan and seats, where the workspace is kept, how long runs are kept, and how many tests and how much storage it uses against its allowance (counted once a day). From 80 % the storage bar says **Nearly full**; when it's full, runs keep working and are saved, but new tests, new versions and screenshots wait until there's room. To add storage, write to [support@breakpatch.dev](mailto:support@breakpatch.dev), or delete tests and apps you no longer need. The emails and the account page say the same.

**Download export** (admins) makes a zip of the workspace's tests, versions, runs and suites and opens the download in your browser; the link works for 7 days. The account page has the same **Download export**. When the licence ends, the workspace becomes read-only for 30 days, so you can still open and export your tests, and then it's deleted: Settings → Workspace shows the date first. Renewing makes it active again. **Remove from this Mac** signs you out here; the workspace and its tests stay.

## Host it yourself

Keep the workspace in your company's own Google Firebase project instead: for teams with an IT person or developer, or who want the data in their own cloud account. You set it up once; then teammates join with a link. In Breakpatch: **Connect a team workspace** → **Host it yourself**.

### Create a workspace

Do this once for your organisation. You need owner access to a Firebase project. Use the project your product already signs in with, so everyone keeps their usual login. A new project works too: step 5 turns on sign-in and adds your account.

In Breakpatch: **Connect a team workspace** → **Host it yourself** → *Setting up for your team?* → **Create a workspace**. It has six steps, numbered as in the app. Each has **Open Firebase console** (step 4, **Open Google Cloud console**), which opens the right page.

1. **Create the web app and paste its config.** Project settings → General → Your apps → **Add app** → Web. Name it `Breakpatch`, leave Firebase Hosting off and click Register app. Ignore the code Firebase shows and click Continue to console. Then, under Web apps, pick Breakpatch. In SDK setup and configuration, choose Config, copy it and press **Paste** in Breakpatch (it pastes straight away). Then fill in **Who can sign in**: just the part after @, for example `example.com`.
2. **Choose the database.** Breakpatch asks which one to use:
   - **This project's `(default)` database**: best if the Firebase project is only for Breakpatch, and it's the one Firebase's free tier covers. Open Firestore Database. If the page shows **Create database**, click it, keep Standard edition and the ID `(default)`, pick a location near your team (you can't change it later), keep Production mode and click Create. If the project has a `(default)` database already, there's nothing to do.
   - **A separate database**, if the project also runs your app, so test data stays apart. Open Firestore Database, open the database menu at the top of the page (the one that shows `(default)`) and choose **Add database** (a project with no database yet shows **Create database** instead). Keep Standard edition, enter the database ID `breakpatch` (copy it from the app), pick the same location as your main database, keep Production mode and click Create.
3. **Paste the rules.** In Breakpatch press **Copy rules**. In Firestore pick the database you chose in step 2 (`(default)` or `breakpatch`), open the Rules tab, replace everything with the rules you copied and click Publish.
4. **Delete runs after 90 days automatically** (recommended, saves money). You can skip this step and do it later. Breakpatch opens the Time-to-live (TTL) page of your database in the Google Cloud console: sign in with the same Google account as for Firebase. Click **Create policy** three times, each with the timestamp field `expiresAt`: for the collection groups `runs`, `suiteRuns` and `runNotes` (what's added to a run later: the issue made from it and the AI assistant's explanations). Firestore takes a few minutes to turn them on, then deletes them 90 days after they were saved (see [Run history is kept 90 days](#run-history-is-kept-90-days)). Or with the Google Cloud CLI, as the step shows them: `gcloud firestore fields ttls update expiresAt --collection-group=runs --enable-ttl --database=breakpatch --project=<your project>` (with your database's ID: `--database='(default)'` for the default one; the step shows the commands filled in), and the same with `--collection-group=suiteRuns` and `--collection-group=runNotes`. Press **I've added the policies**, or **Skip this step**: the steps at the top then show it as skipped, not done. If you skip it, an admin's Breakpatch deletes old runs instead, once a day, which costs a few reads more.
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

### Run history is kept 90 days

In a team workspace, runs and suite runs are kept for 90 days, then deleted: by Firestore's TTL policy when it's set up (step 4 of [Create a workspace](#create-a-workspace), recommended), and otherwise by an admin's Breakpatch, once a day. Breakpatch from before this can't add runs to the workspace: update it on every Mac, the local runner and your CI machines. Tests, shared steps and their versions are only deleted when you delete them, 30 days after (see [Get a deleted app or test back](#get-a-deleted-app-or-test-back)).

Lists that only grow show the newest first: the **Runs** tab and **Run history** show the latest 20 runs, with **Show older runs** for 20 more, and **Version history** the latest 20 versions, with **Show older versions**.

Breakpatch keeps a copy of the workspace on each Mac, so opening it again only fetches what changed since, which keeps your Firebase bill small. After an update that changes the security rules, publish them again (Settings → Workspace → **Copy security rules**): until then Breakpatch reads everything each time, as before.

### Invite your team

Settings → Workspace → **Invite teammates** → **Copy link**. Send it any way you like. It works for everyone and doesn't expire.

Teammates don't need the licence key. Once your admin has entered it in **Settings → Licence**, everyone who opens the link and signs in gets a seat by themselves. The link holds only the workspace details, never the licence.

```
https://breakpatch.dev/connect#c=eyJuYW1lIjoiU3ltVGVycmEi…
```

Clicking it opens a page with **Open in Breakpatch** and **Install Breakpatch**. The link also sets up each person's licence, so they don't enter a key: they take a seat when they sign in. The workspace details are in the part after `#`, which browsers never send to a server.

**Save as file** gives the same thing as a `.bpworkspace` file, handy for a shared drive, CI or the local runner. Double-click it to connect.

Teammates can also paste the link on the connect screen: **Host it yourself** → *Got a link or a .bpworkspace file?* → **Or paste the link here**.

In an encrypted workspace, **Copy link with the key** gives the same link with the key that opens the tests in its `#` part, so a teammate's Mac reads them at once; it's the one to send, and **Copy link without the key** gives the plain one. Send it only to teammates. The teammate's Mac takes the key only once they choose to join the workspace. Without the key, an admin lets each new Mac in: see [Encryption and the recovery code](#encryption-and-the-recovery-code).

## Members and roles

Everyone from your email domain joins as a **member** the first time they sign in (in a [hosted workspace](#invite-people), everyone you invite). Admins change roles in Settings → **Members**.

| Role | What they can do |
|---|---|
| **Member** | Record, run and edit tests. Add tests to the team suite. Make suites. Delete and restore their own tests that aren't in the team suite yet. |
| **Admin** | Everything a member can, plus workspace settings, roles, deleting apps, shared steps and suites, and getting them back. |
| **Local runner** | For the runner Mac. Reads tests, runs suites, writes results. |
| **CI** | For CI pipelines. Asks for suite runs, reads tests, shared steps and suites to run them with `breakpatch-ci`, and adds its runs to the history. Sees nothing else. |

Only admins can change roles, and nobody can change their own. **Remove from workspace** stops someone opening it; their tests and runs stay. In an encrypted workspace, removing an admin or making them a member also withdraws their Mac's signature (see [Encryption and the recovery code](#encryption-and-the-recovery-code)). If they sign in again with an account from your domain, they join as a member again, so to keep someone out, disable their account in Firebase Authentication.

Runner and CI accounts sign in once and join as a member. Then an admin changes their role. In a hosted workspace, a runner Mac and CI use [tokens](#a-runner-mac-and-ci) instead, and people are members or admins.

## Version history

Every save is a new version, with an optional note: *What changed?* → **Save as version 4**. Versions are never deleted on their own: only with their test or shared steps, 30 days after those are deleted.

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

## Why did this fail?

"Couldn't find the Save button" says what failed. **Why did this fail?** says what changed, so you can tell a real bug from a change someone made on purpose.

Open the run report, pick the failed step and press **Why did this fail?** under the reason. After a few seconds the AI assistant answers, marked **From the AI assistant**:

- **What changed**, in a sentence or two. For example: "The Save button now reads “Save changes”", "The Save button isn't where it was. It's now at the top right of the screen", "The Save button is hidden behind the “Cookies” dialog" or "The page shows an error: “Page not found”".
- **Likely cause**: it moved, its text changed, the page changed, the page was slow to load, the page shows an error, or it looks like a real bug.
- **Suggested**: re-record this step, accept the change by re-recording it, give the page longer with a wait before the step, or report it as a bug.

It looks at the screenshot of the failure and what the page said was on screen then, and compares them with how the step was recorded. It only says what it found: if the button is still where it was, it never says it moved. When it can't tell, it says so; compare the two screens instead.

- It's worked out when you ask, never during the run, so it never slows a run down. Once it has answered, the answer is kept with the run, on every Mac in the workspace, and **Copy** includes it.
- It needs the AI assistant on this Mac, a licence that includes it, and the failure's screenshot, which stays on the Mac that ran the test. For a run on another Mac (the local runner, or a teammate's), ask on that Mac.
- It explains steps that couldn't find what they act on, didn't change the page, or left the screen looking different. A missing saved secret, a failed set-up call or a run you stopped already say it all.
- Everything stays on the Mac: the screenshot and what the page said are kept next to each other in the screenshots folder, like any failure screenshot.

## Write a test from a story

<!-- soon --> Coming later. It comes with Team, and no licence includes it yet.

Writing the first version of a test is the slow part. With **Write a test from a story**, you say what the test should do in a few sentences. The AI assistant on your Mac suggests the steps. You check each one on the page, and the result is an ordinary test.

1. Open the test in the recorder, on the page where the story starts.
2. Press **From a story** in the title bar.
3. Write the story, or paste acceptance criteria. Use short sentences, one action each. For example: *Sign up as "Ada Lovelace" with a new email and my password. Then I see "Account created".*
4. Under **Saved secrets it may type**, tick the ones the story needs, such as a password. Only their names go to the AI assistant, never their values.
5. Press **Make steps**. When the steps are ready, a card over the page shows the first one, for example *Type "Ada Lovelace" into the Name field*.

For each step, Breakpatch finds what it acts on and highlights it, the same way it does when you [click on the page](#record-a-test):

- **Confirm** (or Enter) does the step and records it, like a step you clicked. Then the next step is shown.
- **Try again** looks for it again.
- **Skip** leaves the step out.
- **Edit** changes what to look for, and, for typing, what to type: typed text, a saved secret or a generated value. For going to an address it changes the address, and for a wait the seconds.
- If it can't find what the step acts on, click it on the page and confirm. For a check, draw a box around it.

**All steps** shows the whole list. **Stop** ends it; the steps already added stay. At the end, the card says how many steps were added and skipped. Check them, play the test, then press **Save**. Nothing is saved before you do.

It types only what you allow:

- Text you wrote in the story, or a generated value such as a unique name. A value filled in at run time, like `{timestamp}`, can only end text from your story (`Ada Lovelace {i}`) or a short made-up name (`Test project {time}`), or be part of a made-up email address at a test domain such as `example.com` (`ada+{timestamp}@example.com`). Only `{timestamp}` is new on every run: `{time}` and `{date}` are the same all minute or all day.
- A saved secret only if you ticked it. Into a password field, only a saved secret: it never makes one up. When a step has nothing it may type, the card asks you what to type.

A step that goes to another address only goes to the site that's open, or to an address your story names. On a phone or tablet test there are no hover or right click steps.

A step that looks like it deletes, pays for or sends something says so: "This step may delete, pay for or send something. Check it before you confirm."

- The steps are ordinary steps. A run doesn't use the AI assistant for them.
- It needs the AI assistant on this Mac and a licence that includes it. Your story and the page stay on your Mac.
- It suggests at most 30 steps; the card says when it left some out. A story that's long or vague gives worse steps: split it into a few tests.

## Schedules

Open a suite and set its **Schedule**: the days and a 24-hour time, like *Mon–Fri, 06:00*. The time is the local runner's clock. With no schedule, the suite is *By request only*: the Run button, CI or another tool.

The suite shows its next run. If the runner was off or asleep when a run was due, the missed run happens once when it's back, not once for every time it missed, and only if it was due in the last 24 hours: an older one is skipped, and the suite runs at its next time as usual. A run that starts 5 minutes late or more says so in its result message and HTML report, for example "This 8:00 run was missed, so it ran when Breakpatch opened at 9:14."

With [Solo](#solo) on a tests folder there's no runner: the time is this Mac's clock, and the suite runs while Breakpatch is open. A time missed while Breakpatch was closed, or the Mac was asleep, runs once when it opens the folder again (or the Mac wakes), with the same 24-hour limit, and each test's run history and report show the same note.

## The local runner

One Mac per workspace that stays on and runs scheduled suites and run requests for everyone.

1. Install Breakpatch on that Mac and connect it to the workspace.
2. Sign in with a **separate account** (for example `runner@yourcompany.com`) so runs don't show under a person's name. Give it the *Local runner* role.
3. Settings → **Local runner** → **Use this Mac as the local runner**.

It then stays awake while it's plugged in, opens at login and starts in runner mode after a restart or update. The checklist in Settings → Local runner says *Stays awake*; if macOS won't let it, it says *Can't stay awake* and why: then turn off sleep for that Mac in System Settings. Runner mode shows what it's doing: waiting, running (with a live view), the queue and the last runs. **Pause after this test** stops it cleanly. Press Resume to carry on.

It uses the Standard AI assistant, like every Mac. With 32 GB of memory or more you can download the Larger one in the same place, but it's rarely needed.

**Record and run on the same kind of machine.** Tests pass most reliably on the runner when they're recorded on a Mac like it, with the same version of Breakpatch. A test recorded with another version of the test browser runs with **Allow for small differences between systems** (Settings → Screen checks, on unless you turn it off) on the runner Mac, and its report says so when a check fails. See [Recorded on another system](#recorded-on-another-system).

**HTML reports.** Settings → Local runner → **Save an HTML report of every suite run** saves each suite run as the same web page as [Export](#export-a-report), in a folder you choose on the runner Mac (named after the suite, the day and the time). Turn off **Include screenshots** there if others can open the folder who shouldn't see them. If the folder is also on a web server, or a shared drive with web links, enter its **web address** (`https://` is added if you leave it out; it's saved when you leave the field): the Slack and Teams [result messages](#result-messages) then have an **Open the HTML report** button, and the JSON has `htmlReportUrl`. Without one, the report is only saved: a file on the runner Mac isn't something others can open from a message. If a report can't be saved, the runner's status says so.

Anyone can press **Run on runner** on a suite. If the runner is offline, the request waits until it's back. The runner tells the workspace it's there every 90 seconds, and whenever what it's doing changes; after 5 minutes without that, the other Macs show it as offline.

**Queue rules**

- First in, first out.
- The newest request for a suite wins: a waiting request for the same suite is removed, and a running one stops after its current step. Both are recorded as *Replaced by a newer request*.
- If the runner is offline, requests wait. Missed schedules run once when it's back, if they were due in the last 24 hours.

## Run requests

The runner starts a suite whenever a document is added here:

```
projects/<your-project>/databases/breakpatch/documents/runRequests
```

Settings → Local runner → **How run requests work** shows the exact path for your workspace. If the workspace uses the project's `(default)` database, the path has `(default)` where this one has `breakpatch` (and so do the examples below). Each document is one request. Let Firestore make its ID.

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
- A Mac with Apple Silicon and macOS 14 or later, for example GitHub's `macos-15` runners or a Codemagic Mac. Linux (x86_64 and arm64, a Raspberry Pi too) and Windows x64 work as a preview: they run tests, but record them on a Mac. See [breakpatch-ci on Linux](#breakpatch-ci-on-linux), [breakpatch-ci on Windows](#breakpatch-ci-on-windows) and [Raspberry Pi runner](#raspberry-pi-runner).
- Python 3.11 on that machine. When there's none, the install command downloads it.
- One run at a time per machine licence. To run tests in parallel, give each parallel job its own machine licence and its own `BREAKPATCH_MACHINE_ID`.
- The workspace's `.bpworkspace` file (Settings → Workspace → Invite teammates → **Save as file**), committed to your repo. It holds only the workspace's public details, never a password or key.
- A **CI account**: a user such as `ci@yourcompany.com` with the *CI* role (see [Members and roles](#members-and-roles)). Have it sign in to Breakpatch once, then change its role in Settings → Members. Its email and password go in your CI's secrets.
- [Hosted by Breakpatch](#a-runner-mac-and-ci) needs neither: a **CI token** and `BREAKPATCH_WORKSPACE=hosted:<workspace>` instead, with the machine key, since hosted workspaces are encrypted.
- The workspace's latest [security rules](#security-rules): they let the CI account read tests and add its runs. After updating Breakpatch, an admin publishes them again (Settings → Workspace → **Copy security rules**).

**Install**

```sh
curl -fsSL https://breakpatch.dev/install-ci | sh
```

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
- `BREAKPATCH_MACHINE_KEY`: in an encrypted workspace, the machine key (`bpmk1_…`, Settings → Workspace → Encryption → **Machine key**). It opens the tests, and the runs `breakpatch-ci` writes back are encrypted with the workspace's key too.

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

**Reports for your CI.** Add `--junit results.xml` to write the result as JUnit XML, which GitHub, GitLab and Jenkins show as test results, and `--html report.html` for the same report as the app's [Export](#export-a-report), screenshots included, to keep as a build artifact. `--html-no-screenshots` leaves the screenshots out (they can show personal data). Both work for a suite, a workspace test and a test file. The folder must exist; a file that can't be written is said in the log and doesn't change the exit code.

```sh
breakpatch-ci run --workspace team.bpworkspace --suite smoke-7f3a --junit results.xml --html report.html
```

**The machine licence.** Set these in the CI job's environment:

- `BREAKPATCH_LICENCE_KEY`: your licence key, stored as a CI secret. It's used to take a machine licence and is never saved or typed into a page. A CI token, the machine key or the recovery code put there by mistake is refused and never sent: `breakpatch-ci` says which it is and where it goes.
- `BREAKPATCH_WORKSPACE`: your workspace's Firebase project ID, for example `acme-breakpatch`. Or pass `--workspace team.bpworkspace` (then you don't need it). For a workspace [hosted by Breakpatch](#a-runner-mac-and-ci), `hosted:<workspace>`, as Settings → Local runner → **Add a CI token** shows it.
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
- `--auto-fix` lets the AI assistant find a button that moved, as [Fixed automatically](#fixed-automatically) does in the app. It only works on a self-hosted Mac where Breakpatch is installed and its AI assistant is downloaded (Settings → AI assistant), with a licence that includes Fixed automatically. Anywhere else the run carries on without fixing and says so. A [simple runner](#runner-tiers) never fixes.
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
- **Exit code 2 with "This workspace's tests are encrypted"** or "isn't this workspace's machine key": set `BREAKPATCH_MACHINE_KEY` to the workspace's current machine key. After an admin makes a new one, update the secret.
- **Exit code 2 with "would use the secret … which --secret … doesn't list"**: a test's start page, app address or set-up call is on a site you didn't give that secret. If the site is right, add it: `--secret NAME=https://site1,https://site2`. If not, someone changed the test: check its Version history.
- **"Left out: no version is marked as released"**: open the test's Version history and **Mark as released** the version CI should run, or use `--version latest`.
- **Checks fail in CI but pass in the app**: look for the line "this test was recorded on…" at the start of the log. Re-record the test on a machine like the CI machine, or run it on a Mac.

### breakpatch-ci on Linux

`breakpatch-ci` runs on 64-bit Linux, on x86_64 and on arm64 (a Raspberry Pi 4 or 5, or an arm server), as a preview: it runs tests there, and you record them on a Mac. It needs a system from the last few years (glibc 2.28 or later): Ubuntu 22.04 or later, Debian 12 or later, Raspberry Pi OS Bookworm (64-bit) or later, Fedora. A 32-bit system isn't supported, even on a 64-bit Raspberry Pi.

The install command is the same. When the machine has no Python 3.11 (Ubuntu 24.04 and Raspberry Pi OS come with a newer one), it downloads Python 3.11 into `~/.breakpatch-ci` and checks it against the checksum written in the install command. To use your own, set `BREAKPATCH_PYTHON`.

Chromium needs some system libraries. Install them once per machine, as an administrator:

```sh
sudo ~/.breakpatch-ci/current/bin/python -m playwright install-deps chromium
```

`breakpatch-ci setup` installs the test browser again if it's missing (it needs no licence) and prints that line too.

On Linux, Chromium's own sandbox is off by default, because containers and most CI machines can't start it. On a machine that can (your own Linux server, a Raspberry Pi), turn it on with `BP_SANDBOX=1`.

**GitHub Actions on Linux.** The same job as above, with `runs-on: ubuntu-24.04` (or `ubuntu-24.04-arm` for arm64). You don't need `actions/setup-python`. Add the libraries before the run:

```yaml
      - run: curl -fsSL https://breakpatch.dev/install-ci | sh
      - run: sudo ~/.breakpatch-ci/current/bin/python -m playwright install-deps chromium
```

**GitLab CI**

```yaml
ui-tests:
  image: ubuntu:24.04
  resource_group: breakpatch-ci        # one run at a time per machine licence
  variables:
    BREAKPATCH_MACHINE_ID: gitlab-acme-web
    BREAKPATCH_LICENCE_FILE: $CI_PROJECT_DIR/.breakpatch/licence.json
  cache:
    key: breakpatch-licence
    paths: [.breakpatch]
  script:
    - apt-get update && apt-get install -y --no-install-recommends curl ca-certificates
    - curl -fsSL https://breakpatch.dev/install-ci | sh
    - ~/.breakpatch-ci/current/bin/python -m playwright install-deps chromium
    - >-
      ~/.local/bin/breakpatch-ci run --workspace team.bpworkspace --suite smoke-7f3a --version released
      --label "GitLab · pipeline $CI_PIPELINE_ID" --secret STAGING_PASSWORD=https://staging.acme.com --screenshots shots
  artifacts:
    when: on_failure
    paths: [shots]
```

Set `BREAKPATCH_LICENCE_KEY`, `BREAKPATCH_CI_EMAIL`, `BREAKPATCH_CI_PASSWORD` and `BP_SECRET_STAGING_PASSWORD` as masked CI/CD variables. The job runs as root in the container, which the install command allows.

### breakpatch-ci on Windows

`breakpatch-ci` runs on 64-bit Windows 10 and 11 on x64, as a preview: it runs tests there, and you record them on a Mac. Windows on arm isn't supported yet. Install it from PowerShell (no administrator rights needed):

```powershell
irm https://breakpatch.dev/install-ci.ps1 | iex
```

It works like the install command for Mac and Linux. It installs `breakpatch-ci` and the test browser into `%LOCALAPPDATA%\breakpatch-ci`, uses Python 3.11 if it's installed (or downloads it, checked, into that folder), and adds `%LOCALAPPDATA%\breakpatch-ci\bin` to your PATH. Open a new terminal afterwards. For a given version, set `$env:BREAKPATCH_VERSION = "1.2.3"` first. To remove it, set `$env:BREAKPATCH_UNINSTALL = "1"` and run the same command.

**GitHub Actions on Windows**

```yaml
jobs:
  ui-tests:
    runs-on: windows-latest
    concurrency: breakpatch-ci
    env:
      BREAKPATCH_LICENCE_KEY: ${{ secrets.BREAKPATCH_LICENCE_KEY }}
      BREAKPATCH_MACHINE_ID: github-acme-web-windows
      BREAKPATCH_LICENCE_FILE: ${{ github.workspace }}\.breakpatch\licence.json
      BREAKPATCH_CI_EMAIL: ${{ secrets.BREAKPATCH_CI_EMAIL }}
      BREAKPATCH_CI_PASSWORD: ${{ secrets.BREAKPATCH_CI_PASSWORD }}
      BP_SECRET_STAGING_PASSWORD: ${{ secrets.STAGING_PASSWORD }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/cache@v4
        with:
          path: .breakpatch
          key: breakpatch-licence-${{ github.run_id }}
          restore-keys: breakpatch-licence-
      - run: irm https://breakpatch.dev/install-ci.ps1 | iex
        shell: pwsh
      - run: >-
          breakpatch-ci run --workspace team.bpworkspace --suite smoke-7f3a --version released
          --label "GitHub · build ${{ github.run_number }}" --secret STAGING_PASSWORD=https://staging.acme.com --screenshots shots
```

The install command adds its folder to `GITHUB_PATH`, so the next steps can run `breakpatch-ci`.

**A Windows PC as a runner.** To run a suite on a schedule without the app, use Task Scheduler. `breakpatch-ci service` writes the task for you; run `schtasks` from a terminal opened as administrator:

```powershell
breakpatch-ci service --windows --suite smoke-7f3a --workspace C:\breakpatch\team.bpworkspace --schedule "Mon..Fri 06:00" --version released --xml smoke.xml
schtasks /Create /TN "Breakpatch\smoke-7f3a" /XML smoke.xml /RU breakpatch /RP *
```

The task runs `breakpatch-ci run --workspace … --suite …` at those times, as the account you give (`breakpatch` here, a local account made for it), whether or not it's logged on. `schtasks` asks for that account's password. `--schedule` takes days and a time, such as `Mon..Fri 06:00` or `Sat,Sun 08:15`, or `hourly`. Give the account the same variables as a CI job: sign in as it, then System → Advanced system settings → Environment Variables. The task itself holds no secrets. Chromium runs without a desktop. To remove the task: `schtasks /Delete /TN "Breakpatch\smoke-7f3a" /F`.

### Raspberry Pi runner

A Raspberry Pi makes a cheap, always-on machine that replays your workspace's suites on a schedule and reports into the workspace, like a CI job that never stops. It's `breakpatch-ci` on Linux, so it's a preview too, and it isn't a runner of its own yet: a systemd timer starts each run (below). It replays tests. It doesn't record them (record on a Mac).

**Which Pi.** These are our recommendations; we haven't measured every model yet.

- **Raspberry Pi 4 with 4 GB:** a [simple runner](#runner-tiers). It replays tests, checks the screen and runs suites on a schedule. It doesn't fix moved buttons.
- **Raspberry Pi 4 with 8 GB:** should be fine for nightly and hourly replays of normal web pages. It's a full runner, with longer waits because its processor is slow. It doesn't fix moved buttons either: the AI assistant only runs on a Mac today.
- **Raspberry Pi 5 with 8 GB:** faster, and the better buy if you're buying one now.
- **A small x64 mini PC** (for example one with an Intel N100): faster again, and the best choice for Flutter apps (below). It uses the same Linux install as any CI machine.
- Use an **SSD** over USB 3 (or NVMe on a Pi 5) rather than an SD card, which wears out with screenshots and logs. Give it cooling (a Pi 4 slows down at 80 °C) and the official power supply (27 W on a Pi 5).
- Install a **64-bit** system: Raspberry Pi OS Bookworm (64-bit) or later, or Ubuntu 24.04 for arm64.
- On a Pi 5, the standard kernel uses 16 KB memory pages. If Chromium misbehaves, add `kernel=kernel8.img` to `/boot/firmware/config.txt` and restart: that kernel uses 4 KB pages.

#### Runner tiers

Each time `breakpatch-ci` starts a run, it checks how much memory the machine has and how fast its processor is. That takes less than a second. The memory picks the tier: under 6 GB, it's a simple runner. The processor's speed only sets how long it waits. The first lines of the log say which tier and why, for example:

```output
breakpatch-ci: simple runner (4 GB of memory, under the 6 GB the full tier needs). Replay, screen checks and schedules only: no AI assistant and no fixing. Waits are 2× as long (BP_TIMINGS_SCALE changes that).
```

<!-- stack -->
| | Simple runner | Full runner |
|---|---|---|
| **When** | Under 6 GB of memory | 6 GB or more |
| **Replay and screen checks** | Yes | Yes |
| **Suites on a schedule** | Yes | Yes |
| **AI assistant and fixing** (`--auto-fix`) | No. `--auto-fix` is ignored, and the log says why in one line | Where the AI assistant is installed (today, a Mac) |
| **Waits** (when `BP_TIMINGS_SCALE` isn't set) | Longer: 2× on a Pi 4, 3× on a much slower processor (a Pi 3, or a Pi 4 slowing down when hot), 1.5× on a fast machine with little memory | 2× on a Pi 4, 3× on a much slower processor (a Pi 3, or a Pi 4 slowing down when hot), else as set |

A Raspberry Pi 4 with 4 GB is a simple runner. A Pi 4 with 8 GB is a full runner with longer waits: the processor's speed only sets the waits.

The tier is also in the JSON result, as `runner` (`tier`, `reason`, `memoryGb`, `cpuSpeed` and `timingsScale`), and in the `--html` report, on the *Runner* line under *Machine*.

To try the other tier, set `BREAKPATCH_TIER=simple` or `BREAKPATCH_TIER=full`, or add `--tier simple` to `breakpatch-ci run`. That's for testing: choosing full doesn't give a machine more memory.

**Flutter web apps.** Replay works, because it compares the screen and needs no AI assistant, but Flutter is the hardest case for a Pi:

- Flutter draws everything with WebGL, and a Pi's headless Chromium draws it in software. The first load and each step's settling are slow: use the slow-machine setting (`BP_TIMINGS_SCALE`, below).
- Software drawing on an arm Linux machine looks slightly different from a Mac. Re-record Flutter tests on the same kind of machine as the runner (or allow for small differences between systems, which `breakpatch-ci` does by default), and check the first runs.
- There's no automatic fixing for Flutter buttons that moved: nothing can read inside a canvas, and the AI assistant is too slow on a Pi.

A Pi 4 with 8 GB suits nightly Flutter runs, a Pi 5 is better, and an x64 mini PC is best.

**Slow machines.** On a slow processor `breakpatch-ci` waits longer for a page to settle, for a step's first check to match, for pages to load and for the start page: 2× on a Pi 4, on either tier. It doesn't stretch the watch for moving parts before each step, so a page that's ready on time costs nothing extra. To choose yourself, set `BP_TIMINGS_SCALE` to a number from 1 to 10: it wins over the tier's. Use 2 for a Pi 5 and 3 for a Pi 4 with Flutter. If steps fail with "didn't settle" or "not there yet", raise it. For a runner set up as below, put the line `BP_TIMINGS_SCALE=3` in `/etc/breakpatch/breakpatch.env`.

**Set it up**

1. Make a user for the runner, and install `breakpatch-ci` as that user:

   ```sh
   sudo useradd --create-home --shell /usr/sbin/nologin breakpatch
   sudo -H -u breakpatch sh -c 'curl -fsSL https://breakpatch.dev/install-ci | sh'
   sudo /home/breakpatch/.breakpatch-ci/current/bin/python -m playwright install-deps chromium
   ```

2. Have ready a **machine licence**, the workspace file and a **CI account**, as for any CI machine (see [From CI with breakpatch-ci](#from-ci-with-breakpatch-ci)). Then let `breakpatch-ci service` write the service and its timer:

   ```sh
   sudo /home/breakpatch/.local/bin/breakpatch-ci service --suite smoke-7f3a --workspace team.bpworkspace \
     --email ci@yourcompany.com --machine-id pi-runner-1 --schedule "Mon..Fri 06:00" \
     --version released --secret STAGING_PASSWORD=https://staging.acme.com
   ```

   It asks for the licence key, the CI account's password, the machine key (only for an encrypted workspace) and each saved secret you name with `--secret`. What you type isn't shown, and it never goes on the command line. It keeps each one in a file of its own in `/etc/breakpatch` that only root can read. Then it starts the timer.

   `--suite` takes the suite's ID (on the suite, under *Start it from anywhere*). `--schedule` takes systemd's `OnCalendar=` form: `Mon..Fri 06:00` (the default), `*-*-* 02:30` for every night, or `hourly`. For more suites, run it again with another `--suite`. The workspace, the licence key and the password are kept from the first time.

3. Start a first run now, and read its log:

   ```sh
   sudo systemctl start breakpatch-suite@smoke-7f3a        # waits until the suite has run
   journalctl -u breakpatch-suite@smoke-7f3a               # its log and result
   systemctl list-timers 'breakpatch-*'                    # the next runs
   ```

The service passes the licence key, the CI account's password and saved secrets as systemd credentials: only the run can read them, and they never appear in `systemctl show` or the log. It turns on Chromium's sandbox (`BP_SANDBOX=1`). Failure screenshots go to `/home/breakpatch/breakpatch-shots`. The files it writes are the ones in the Breakpatch repository's `docs/systemd/`, if you'd like to read them first. `--root DIR` writes them under a folder of your choice instead and starts nothing.

**Without root.** `breakpatch-ci service --user …` writes the service in your own account instead (`~/.config/systemd/user`), with the secrets in `~/.config/breakpatch/secrets.env`, which only you can read. Use `systemctl --user` and `journalctl --user` in place of `sudo systemctl` and `journalctl`. So that it runs while you're logged out, run `sudo loginctl enable-linger $USER` once.

**Remove it.** `sudo /home/breakpatch/.local/bin/breakpatch-ci service --suite smoke-7f3a --remove` stops the suite's timer and removes its files. After the last suite, it also removes the service, the settings and the secrets.

**What's different from the app's local runner**

- The schedule is the timer's. The days and times set on a suite in the app aren't used.
- Runs show in the run history marked *CI*, not as the local runner's.
- There's no **Run now** from the app, and the app shows the runner as offline.

**Copying the SD card or SSD.** Each Pi needs its own machine ID. If you copy a system that has already started once, run `sudo rm /etc/machine-id && sudo systemd-machine-id-setup` on the copy, and give it its own `BREAKPATCH_MACHINE_ID` (`--machine-id`). Otherwise both Pis use one machine licence and push each other out.

## Result messages

After each run, the local runner can send the suite's result where your team talks: **Slack**, **Microsoft Teams**, or any **web address** that takes a message. Set it in the suite (*After each run, send the result to*). Only admins can set or see it.

**When.** *After every run*, *Only when it fails*, or *When it starts failing, and when it passes again*: the first failed run after a pass, then the first pass after that. A run that was replaced by a newer request is only sent with *After every run*.

**Slack.** Make an [incoming webhook](https://api.slack.com/messaging/webhooks) for the channel (a Slack app with *Incoming Webhooks* turned on) and paste its address, `https://hooks.slack.com/services/…`. The message has the result and the counts with an **Open the report** button beside them, then one line per failed test with the step and why (the AI assistant's sentence, when there is one, is marked as the AI assistant's), and the screenshot, if you include it, right after the failure it shows. The notification says how many tests failed and which.

**Microsoft Teams.** In the channel, add the Workflows template **Send webhook alerts to a channel** (or a workflow that starts with *When a Teams webhook request is received*), and paste its address. It ends in `environment.api.powerplatform.com`. The message is an Adaptive Card with the same things, and the same line as its notification preview. Microsoft turned off the old Office 365 connector addresses (`….webhook.office.com`) in Teams, so Breakpatch doesn't take them. If Teams says it wants a sign-in, set *Who can trigger the flow* to *Anyone* in the workflow's first step. Older Workflows addresses on `logic.azure.com` are being replaced by Microsoft: if the test message fails, copy the workflow's address again.

**Include the failed step's screenshot** (Slack and Teams, off by default). Slack and Teams can only show a picture from a web address, so the runner puts the screenshot of the step that failed in your workspace's own Firebase Storage, at a random address. Anyone who has the message can open the picture. It needs Storage turned on in your Firebase project (new projects need the pay-as-you-go plan for it) and its rules published: Settings → Workspace → **Copy storage rules**, then Firebase console → Storage → Rules → Publish. The first time, the console asks whether Storage may read Firestore: allow it, because the rules check that whoever adds a picture is one of the workspace's people, its runner or its CI account. Update the runner Mac before you publish these rules: older apps put pictures where the new rules don't allow. Without the rules, the message goes without the picture. Pictures aren't deleted for you: to keep Storage small, add a lifecycle rule in the Google Cloud console (Cloud Storage → your bucket → Lifecycle → delete objects older than 90 days).

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
  "text": "Smoke failed: 1 of 6 tests failed, 1 not run · Create a project · 4 min 52 s · started by CI · build 412"
}
```

`result` is one of `passed`, `passed_with_fixes`, `failed` or `replaced`. `reportLink` opens the report in Breakpatch on a Mac, and `reportUrl` does the same from anywhere (both are empty when there's no run to open). A failure can also have `explanation`, the AI assistant's sentence on why, and the message `imageUrl`, the screenshot, when the suite includes one, and `htmlReportUrl`, the runner's saved [HTML report](#the-local-runner), when its folder has a web address. Use `text` as it is, or build your own message. Any relay works: n8n, Zapier, an email service. Discord and Google Chat take it through such a relay.

[breakpatch-ci](#from-ci-with-breakpatch-ci) sends the same messages with `--notify-url`.

**Updating.** Result addresses saved by an earlier Breakpatch were kept with the suite, where the CI account could read them. When an admin opens the updated app, it moves them to where only admins and the runner can read them. Update the runner Mac first, then publish the new [security rules](#security-rules). Older apps can't save in a workspace once the updated app has saved there (they say to update).

## Create an issue

On a failed step in a report, **Create issue** writes it up in **GitHub**, **Linear** or **Jira Cloud** in one click: the title ("Create a project: step 5 Click Done failed: couldn't find the Done button"), the steps up to the failure, what was expected and what was seen, the reason, the app, the start address, the test version, who or what ran it (a person, the local runner or CI), the Mac, the time and a link to the report. If the AI assistant explained the failure, its explanation goes in too. Afterwards the report shows **Open issue** instead, for everyone in the team.

**The screenshot.** Jira gets the failed step's screenshot as an attachment, and Linear as a picture in the issue. GitHub has no way to attach one, so it's put in your workspace's Firebase Storage and linked, as for [result messages](#result-messages) (it needs Storage and its rules); without Storage the issue goes without it. The screenshot is on the Mac that ran the test, so an issue made on another Mac, or from a runner or CI run, has no picture.

**Set it up** in Settings → **Issue trackers**:

1. **Where issues go** (admins, for the whole team): the GitHub repository (`acme/web`) and labels, the Linear team's key (`ENG`), or the Jira site (`acme.atlassian.net`), project key (`WEB`), issue type (Bug unless you say otherwise) and labels.
2. **Your token, on this Mac** (each person): issues are made in your name, with your own token.
   - **GitHub:** a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) with access to the repository and *Issues: Read and write*.
   - **Linear:** a personal API key (Linear → Settings → Security & access).
   - **Jira:** an [API token](https://id.atlassian.com/manage-profile/security/api-tokens) with the email you sign in to Jira with.

   **Check and save** asks the tracker whether the token works, then keeps it in this Mac's Keychain. It's only used to make issues, and never goes to the workspace, your teammates or Breakpatch. **Remove** takes it off this Mac.

If a tracker refuses, Breakpatch says why in plain words, for example "GitHub said the token can't create issues in acme/web".

Create issue comes with a Breakpatch Team licence that includes it; licences get it at their next check. In Community, **Copy** → **Markdown, for an issue** gives the same text to paste yourself.

## Security rules

**Copy rules** in workspace setup gives rules with your email domain filled in. They say:

- Only signed-in accounts from your email domain, with a confirmed email address, can read or write. Runner and CI accounts are let in by their role.
- There are four roles: **member**, **admin**, **runner** and **ci**, as in [Members and roles](#members-and-roles). Whoever connects the workspace is the first admin.
- Versions can only be added. History can't be edited.
- Deleting an app, a test, shared steps or a suite marks it as deleted (Recently deleted), and only whoever may delete it can mark it or take the mark off. Only then can it, its versions and, for an app, everything in it be deleted for good. Breakpatch from before this can't delete.
- `runRequests` accepts a small document of a fixed shape from members and from accounts with the `ci` role. Only the runner can read or delete them.
- Accounts with the `ci` role read apps, tests, shared steps, their versions and suites, and add runs marked `ci` as themselves. They can't change anything, or read members, runs or the licence.
- A test's released version must be one that's saved.
- Every change to apps, tests, shared steps or suites also updates `workspace/changes`, a small document that tells the other Macs what changed, so they don't read everything again. Apps from before this can't save until they're updated.
- Runs and suite runs must carry `expiresAt`, 90 days after they're saved, which the TTL policy deletes them by. It can't be changed. Runs from Breakpatch or `breakpatch-ci` from before this are refused, so update them first.
- Only admins set where a suite's result goes. Its address is kept apart from the suite, and only admins and the runner can read it.
- Anyone in the team can note the issue made from a run, and change nothing else about it. Only admins set where issues go. Tokens for GitHub, Linear and Jira are never in the workspace.
- In an encrypted workspace, names, steps, addresses and results are stored encrypted, and the rules check only their size. Only admins can encrypt what's there again (turning encryption on, a new key), and nothing else about it. The copies of the key for the recovery code and the machine key are for admins (the machine key's for the runner and CI too), and each Mac's request to be let in is its owner's.

**After an update.** The rules carry a date (search what you copy for *These rules are dated*), and each Breakpatch version needs its own date's rules or newer: this version's are dated 2026-10-06. In a workspace in your own Firebase, an admin copies them again after updating (Settings → Workspace → **Copy security rules**) and publishes them in the Firebase console → Firestore → your database → Rules. Until then, **Check the connection** says the rules for this version aren't published, and each Mac reads the whole workspace every time it opens it. The 2026-10-06 rules also make sure a removed admin can't change which Mac's signature was withdrawn (see [Encryption and the recovery code](#encryption-and-the-recovery-code)). Hosted by Breakpatch, the rules are always up to date.

To give an account the `ci` role, have it sign in to Breakpatch once, then change its role in Settings → Members. Or, in the Firebase console, set `role` to `"ci"` in its document `members/<user id>` in the workspace's database. Disable the user in Firebase Authentication to cut it off.

A service account using the Firebase Admin SDK skips the rules altogether. Use a normal user with the `ci` role instead: `breakpatch-ci` only signs in with one.

## Licences and seats

A Team licence has **seats** for people and **machine licences** for the local runner and CI machines. The licence belongs to the workspace.

- **Hosted by Breakpatch** needs no key in the app: Breakpatch gives each person their seat when they sign in. The rest of this section is the same.
- **The admin sets up the licence once** (in a workspace of your own): **Settings → Licence** → **Enter licence key** (it looks like `BP-XXXX-XXXX-XXXX-XXXX`). The key is on your licence page after you buy: see [The back office](#the-back-office).
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

With Solo, the messages are for one person: "This Solo licence is in use on another Mac. Free it at account.breakpatch.dev, then try again.", "Your Solo licence has expired. Renew it at account.breakpatch.dev." or "This Solo licence is already used by someone else. Solo is for one person: for more people, choose Team." The banner then has a button for what to do there, such as **Free the other Mac** or **Renew**, and Home doesn't offer Upgrade to Team while it shows.

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

Once Team is on sale: if you bought it on the [pricing page](https://breakpatch.dev/pricing/), sign in with the email you bought with: the first time, you see **Your new licence key (shown once)**. Press **Show my licence key** and keep it somewhere safe, because it isn't shown again. The same page has **Manage billing** (invoices, payment method, cancelling, through Paddle, our reseller) and **Change seats** (seats and extra machine licences, charged or credited straight away, pro rata for the rest of the billing period; credits go against your next payments; Solo has no seats to change). A cancelled licence keeps working until the end of the period you paid for.

For a licence you didn't buy on the site, contact Breakpatch to add seats or renew. If you see "No licences for this email", ask whoever bought Breakpatch Team to add you as an admin.

## Encryption and the recovery code

Breakpatch can encrypt a workspace's tests on your Macs, so the workspace's database keeps only unreadable text. Workspaces hosted by Breakpatch are always encrypted. For a workspace in your own Firebase, an admin turns it on in **Settings → Workspace → Encryption** (publish this version's security rules first: **Copy security rules**). It can't be turned off again.

**What's encrypted.** Test, app, suite and shared-step names and descriptions; steps, with what they click and type, their addresses and labels; start addresses; run results, their steps and "Why did this fail?" explanations; where results and issues go. **What isn't:** ids, times, version numbers, pass or fail and counts, when a run expires, and who is in the team with which role. The workspace needs those to check who may do what and to delete old runs, and they say nothing about what your tests do.

**The key.** Each workspace has one key, made on the first admin's Mac and kept in its Keychain. It never leaves your Macs unencrypted, and Breakpatch never has it. A teammate's Mac gets it one of two ways:

- **An invite link with the key**: Settings → Workspace → **Copy link with the key**. The key is in the part after `#`, which browsers never send to a server. Send it only to teammates.
- **An admin lets the Mac in**: a Mac without the key shows *This Mac can't read the workspace's tests yet* with four words, for example *otter maple tulip quartz*. The admin sees it under **Macs waiting to be let in**, checks the words with its owner, and presses **Let in**. If this Mac doesn't know that admin yet, it then shows *An admin let this Mac in. Check it was them.* with the admin's Mac's words: compare them with the ones in their Settings → Workspace → Encryption and confirm. A Mac takes a key only from an admin it trusts (from the invite link, or one you confirmed, or one a trusted admin vouched for); anything else is refused and said, for example *The words didn't match, so this Mac didn't take the key.*

Until then, that Mac shows names as *Locked* and can't save. After a new key, a Mac that hasn't got it yet says *This Mac doesn't have the workspace's newest key yet*: it can read, but not save, until an admin's Mac passes the key on the next time it opens the workspace. Once encryption is on, content that isn't encrypted (saved by an older Breakpatch, for example) shows as *Locked* too and isn't saved that way again; the workspace's rules and breakpatch-ci refuse it as well.

**The recovery code.** When encryption is turned on, the admin sees a recovery code once, like `BPR1-50M6-HA79-55MT-KTHA-DANE-PAVB-NFH`. Save it with **Save recovery kit (PDF)** or **Copy code**, keep it in your password manager or with your company's papers, then type back the 4 characters Breakpatch asks for. Until you do, admins see *Save the workspace's recovery code* under the title bar. The window doesn't close with Esc or a click outside it; **Skip, I'll make a new one later** asks first, because the code isn't shown again. Breakpatch never sees the code and can't make it again. A recovery code (`BPR1-…`) pasted where a licence key goes is refused, and never sent.

- **I lost access to the key**: on a new Mac, sign in as an admin and open **Settings → Workspace → Encryption → I lost access to the key**, then type the recovery code. Any Mac that still has the key can also let the new one in.
- **Make a new recovery code** stops the old one working. Save the new one straight away.
- **If every Mac with the key is lost and nobody has the recovery code, the tests saved so far can't be read again**, by you or by Breakpatch. An admin can **Start again with a new key** (under the help text in **I lost access to the key**, and it asks first): new tests and runs are encrypted with it, and older ones stay locked.

**The local runner and CI** use the **machine key** (`bpmk1_…`): **Make one** under **Machine key**, then enter it on the runner Mac (Settings → Workspace → Encryption) and save it as `BREAKPATCH_MACHINE_KEY` in CI ([From CI with breakpatch-ci](#from-ci-with-breakpatch-ci)). A new machine key stops the old one working.

**A new key.** After someone leaves the team, Breakpatch offers **Make a new key** (it's also in Settings → Workspace → Encryption). Every Mac still in the team gets it, the recovery code and machine key keep working, and what's in the workspace is encrypted again with it in the background. Once that's done, each Mac deletes the older keys from its Keychain, so a copy of an old key opens nothing new. Anyone who had access may have kept copies of what they could read.

**When an admin leaves.** When an admin is removed, or made a member, another admin's Breakpatch withdraws their Mac's signature: from then on, the team's Macs don't take a key from it or trust a Mac it let in later, even if that Mac is kept or stolen. Keys taken from them before stay, and Breakpatch signs again what only they had signed. Admins then see *Ana left the team with the workspace's key*, with **Make a new key**. In your own Firebase, do it, since they could keep a copy of the key; hosted by Breakpatch, their access has already ended, so it's extra care. **Not now** hides the note on that Mac until someone else leaves; Settings → Workspace → Encryption still says a new key is due. In a workspace in your own Firebase, **Make a new key** also asks you to check they can't still open your Firebase project (Google Cloud console → IAM) and to remove them there if they can: Breakpatch can't see who has access to your project. If Breakpatch couldn't withdraw the signature, admins see *The team's Macs still trust an admin who left.* Hosted by Breakpatch, it tries again when the workspace changes; in your own Firebase, press **Copy security rules** on the note, publish them in the Firebase console and open the workspace again. A recovery code or machine key they made stops working, because they saw it. Admins see *Make a new recovery code* or *Make a new machine key*; a new key made after they left comes with a new recovery code to save. After a new machine key, enter it on the runner Mac and update `BREAKPATCH_MACHINE_KEY` in CI. If an admin's Mac was the only one a teammate's Mac trusted, that Mac asks its person to check another admin's words the next time it's let in. Someone made admin again gets new keys on their Mac, and another admin's Mac vouches for them.

**Turning it on**, or a new key, encrypts what's already there in the background. The admin's Mac doing it shows how far it got in a thin line under the title bar, for example *Encrypting your tests… 34 of 120*, or *Encrypting your tests with the new key…* (tests count with their versions; runs, shared steps and suites count too). Keep working, and *Your tests are encrypted.* says when it's done. If you close the app, it carries on the next time an admin opens the workspace, from where it was. If it stops, a note says why, for example *Encrypting your tests stopped at 40 of 120. Breakpatch couldn't reach the workspace.*, and **Try again** carries on; what's encrypted so far stays encrypted. Breakpatch versions from before encryption can't save to an encrypted workspace, so update everyone first.
