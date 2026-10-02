# Website (Firebase Hosting)

Plain HTML, no build step to serve it. This folder is the whole site at `https://breakpatch.dev`.

```
site/
  index.html            landing page
  404.html              page not found (Firebase serves it for any missing path)
  install               the install command's script (served as text/plain, see firebase.json)
  install-ci            breakpatch-ci's install command (Team, for CI machines; text/plain too)
  install-ci.ps1        the same for Windows, in PowerShell (irm … | iex; text/plain too)
  manual/index.html     the full manual (built from docs/manual.md)
  connect/index.html    Team invite link page
  report/index.html     run report links from Slack, Teams and issues (opens the report in the app)
  pricing/index.html    pricing and the Team checkout (Paddle.js overlay)
  thanks/index.html     after checkout: where the licence key is
  terms/ privacy/ refunds/   legal pages (drafts; Paddle's website review needs them)
  assets/paddle-config.js    Paddle client-side token and price ids (sandbox and live), and Solo's launch switch
  assets/pricing.js, pricing.css   the plan picker and checkout, and these pages' styles
  assets/get-json.js    the one GET helper for the back office (founding places, Solo domain, test runs)
  assets/runs-count.js  the home page's "12,300 tests run with Breakpatch" line
  assets/report-link.js the report page's link check (report-link.test.mjs)
  robots.txt, sitemap.xml, favicon.ico, apple-touch-icon.png
  assets/site.css       styles (dark, follows light mode automatically)
  assets/site.js        GitHub links, copy buttons, contents highlighting
  assets/shots/         app screenshots, WebP, 1x and 2x, dark and light
  assets/og.png         social preview image (1200 × 630)
  assets/favicon.svg
  build-manual.mjs      builds manual/index.html from docs/manual.md
```

The pricing, thanks and legal pages (`pricing/`, `thanks/`, `terms/`, `privacy/`, `refunds/`, `assets/pricing.*`, `assets/paddle-config.js`) sit on top of `site.css`: keep `.edition`, `.price` and `.home` working when you change it. Every page, the manual included, has the same footer as `index.html` (`.site-foot.rich`): change it everywhere at once.

## Launch day

- **GitHub links.** Every GitHub link is `<a data-gh="/path">`, and `assets/site.js` points them all at `GITHUB` (one line at its top). The HTML also has the full address in `href` for browsers without JavaScript. The repository is private, so these 404 for visitors until it's public.
- **Pre-launch notes.** While a page's `<html>` has `data-prelaunch`, it shows its `.prelaunch` notes ("Public release coming soon. Join the list") and `.prelaunch-text` words (Home's install answer, Pricing's "or email support@breakpatch.dev"). The pages that have it: `index.html`, `pricing/`, `connect/`, and the manual through `build-manual.mjs`. On launch day, delete the attribute from each (`grep -rl data-prelaunch site`), then run `node site/build-manual.mjs`. The manual's notes are the paragraphs starting with `<!-- prelaunch -->` in `docs/manual.md`: delete those too.
- **Solo.** Solo goes on sale on the site when the back office's `SOLO_ON_SALE` is on (its README, "Solo"): `assets/paddle-config.js` asks its `GET /api/solo-domain`, which answers 404 until then, and sets `soloOnSale` from the answer (remembered on each browser, so a later visit is drawn right at once). There's no switch on the site to flip with it; put the Solo prices in `paddle-config.js` first. While Solo isn't on sale, `<html>` has no `data-solo`, and `site.css` hides every `.solo-only` element (the Solo cards on Home and Pricing, the Solo column in Home's table, and the words about Solo in Home's and Pricing's text and questions), shows the `.solo-off` ones in their place, and shows the manual's `.solo-soon` notes ("Coming soon", the paragraphs starting with `<!-- solo-soon -->` in `docs/manual.md`, styled like the pre-launch notes). `pricing.js` then doesn't set up the Solo card at all, so the domain check is never called. `paddle-config.js` sets `data-solo` from `<head>` on Home, Pricing and the manual, so the page never moves. The terms, refunds and privacy pages mention Solo as "when offered" either way. Anything new about Solo on those pages gets `class="solo-only"`.

## Private beta

`install` also works against the private repository, for the owner's beta test:

```
curl -fsSL https://breakpatch.dev/install | BREAKPATCH_GITHUB_TOKEN=<token> BREAKPATCH_CHANNEL=beta sh
```

`install-ci` takes the same `BREAKPATCH_GITHUB_TOKEN` and `BREAKPATCH_CHANNEL`. It's tested like `install`, by `scripts/test-install-ci.sh`, which also runs `install-ci.ps1` with PowerShell 7 (`pwsh`) on Linux when it's installed. `install-ci.ps1` takes the same variables (as `$env:NAME` before `irm … | iex`); its token path and the `.cmd` it writes need a check on a real Windows machine.

The token is a fine-grained personal access token for `BreakPatch/breakpatch` only, Contents read-only, expiring in 7 days. The script sends it to `https://api.github.com` only, never prints it or puts it on a command line, and downloads through the API's asset addresses. `BREAKPATCH_CHANNEL=beta` picks the newest release, prereleases included (GitHub's `releases/latest` skips them). The main README's "Private beta" section has the details. Once the repository is public the token isn't needed: the plain command works, and the token mode can go.

## Screenshots

The pictures in `assets/shots/` are the real app's browser preview, regenerated with one command:

```sh
scripts/link-team.sh                                   # the shots show Team features
/path/to/engine/.venv/bin/python scripts/site-shots.py # all of them; or name some: ... site-shots.py names tests
```

It starts `npm run dev` in `app/` if the preview isn't running, opens `?demo&ready&signedin` with the clock fixed, and saves each shot dark and light, at 1x and 2x, as WebP. `recorder-phone` is the home hero on a phone (the steps panel). The crops are listed in `SHOTS` at the top of the script. Each `<picture>` swaps to the light version when the Mac is in light mode. Keep `width` and `height` on every `<img>` matching the file.

## Hosting

The site is served by **Firebase Hosting**: the site `breakpatch-web` in the Firebase project `breakpatch-backoffice`, with the custom domain `breakpatch.dev`. The back office is the project's other Hosting site, at `https://account.breakpatch.dev`.

The deploy workflow (`.github/workflows/website.yml`) publishes this folder only when run by hand (Actions → **Website** → **Run workflow** on `main`), with the weekly deploy, in the GitHub environment `website`. It uses the `firebase-tools` pinned exactly in `site/package.json` and `site/package-lock.json` (`npm ci --ignore-scripts`, then `npx firebase`); `firebase.json` keeps those files and `node_modules/` off the site. Moving the website to its own Firebase project, so its deploy account can't reach the back office's Hosting site, is an owner step (the main README, "Releases, CI and the website: owner settings"). A Hosting config along these lines does it:

```json
{
  "hosting": {
    "site": "breakpatch-web",
    "public": "site",
    "ignore": ["README.md", "build-manual.mjs", "**/.*"]
  }
}
```

```sh
npx firebase deploy --only hosting:breakpatch-web --project breakpatch-backoffice
```

**One-time setup.**

1. Create the site: Firebase console → Hosting → Add another site → `breakpatch-web` (or `npx firebase hosting:sites:create breakpatch-web --project breakpatch-backoffice`).
2. Add the domain: Hosting → `breakpatch-web` → Add custom domain → `breakpatch.dev`, and `www.breakpatch.dev` redirecting to it. Add the DNS records Firebase shows at your domain registrar and wait for the certificate.

Until the domain is connected, `https://breakpatch.dev` (and the invite links built on it) won't load. `https://breakpatch-web.web.app` works straight away.

Leave `trailingSlash` unset or `true`, so `/manual` and `/connect` open their `index.html`. Browsers keep the `#c=…` part of an invite link through that redirect.

The invite link address lives in `app/lib/workspaceLink.ts` in the private Team repo.

## Keep the manual in sync

`docs/manual.md` is the source. After editing it, rebuild the page (Node 18 or later, nothing to install):

```sh
node site/build-manual.mjs           # writes site/manual/index.html
node site/build-manual.mjs --check   # exits 1 if the page is out of date, for CI
```

The script keeps the classes the CSS and JS rely on: `.docs`, `.toc`, `.content`, `section[id]`, `.code`. Section ids are the same as GitHub's heading anchors, so `manual/#run-requests` works on the site and on GitHub. The app links to `https://breakpatch.dev/manual/#run-requests`, so keep that heading as it is.

In the Markdown, `# ` headings are parts (Getting started, Community, Team), `## ` headings are sections and `### ` are subsections. Sections in the Team part get a *Team* tag. Everything before the first `---` is the intro: its paragraphs become the lead, and the contents list is left out because the page makes its own.

## Tests run with Breakpatch

Home shows "12,300 tests run with Breakpatch" under the install command (`assets/runs-count.js`). It asks the back office's `GET /api/test-runs` (the private repo's `backoffice/README.md`, "Usage"), which answers `{ "runs": 12300 }`: the test runs every edition has reported, rounded down (to the 10 below 1,000, to the 100 below 100,000, then to the 1,000), cached for 5 minutes. The page shows it only from 100 runs, and never when the answer doesn't come within 5 s (`assets/get-json.js`, the same helper as the founding places). The line sits outside the layout and fades in, so nothing moves.

## Invite link format

```
https://breakpatch.dev/connect#c=<base64url(JSON)>
```

JSON: `{ "name", "logo"?, "config": { …Firebase web config… }, "database": "breakpatch", "domain": "example.com" }`.
The page decodes it in the browser only, shows the workspace, then opens `breakpatch://connect#c=…`. If the app doesn't open within 2.5 s it shows "Didn't open?". Non-Mac devices get "Open this link on your Mac". Invite links come from a Breakpatch Team workspace.

## Report link format

```
https://breakpatch.dev/report#r=<appId>/<runId>
```

Result messages to Slack and Teams and issues made with **Create issue** (Team) link here, since a `breakpatch://` link doesn't open from Slack on the web or a phone. On a Mac the page opens `breakpatch://report/<appId>/<runId>` at once (and offers "Didn't open?" after 2.5 s, as the invite page). Other devices get "Open this link on your Mac". Ids are letters, digits, `-` and `_` only (`assets/report-link.js`); anything else shows "This link doesn't work". Test it with `node --test site/report-link.test.mjs`.

## Checkout (Paddle)

`/pricing` sells Team through [Paddle Billing](https://developer.paddle.com) (Paddle is the merchant of record). Paddle.js v2 is loaded from `cdn.paddle.com` only when someone presses **Buy Team**, or opens a Paddle payment link (`/pricing/?_ptxn=txn_…`, which Paddle uses for invoices and payment method updates). The checkout takes the people (at least 3) and extra machine licences, prefills the email, and passes `{ company, email }` as custom data; afterwards Paddle sends the buyer to `/thanks/`.

Paste the ids into `assets/paddle-config.js`: the client-side token (Paddle → Developer tools → Authentication) and the four Team price ids, for sandbox and live, and set `env`. None of them is a secret. Until the token and ids are there, the button reads "Join the free beta" and opens an email to support@breakpatch.dev with the people, machines and billing period picked; Work email, Company and "Tax is added at checkout" are hidden. Business is sold by email (Contact us).

Solo shows only once the back office's Solo switch is on (Launch day, above). It has its own two price ids (`soloMonthly`, `soloYearly`, quantity 1) and the same behaviour: without them the Solo card invites people to the beta. Before its checkout opens, the card sends the email's domain (never the address) to `soloDomainUrl`, the back office's `GET /api/solo-domain`; when another Solo at that company is live, it shows Team instead ("one Solo per company"). If the check can't be reached, checkout goes ahead and the back office flags a second Solo for the owner.

The licence itself is made by the back office from Paddle's webhook: the private repo's `backoffice/README.md`, "Payments (Paddle)", has the owner's steps (products, prices, the notification destination, secrets). The legal pages are drafts marked "Draft", with `[Legal name]` to fill in; keep the privacy page in step with the manual's Privacy section.
