# Website (Firebase Hosting)

Plain HTML, no build step to serve it. This folder is the whole site at `https://breakpatch.dev`.

```
site/
  index.html            landing page
  404.html              page not found (Firebase serves it for any missing path)
  install               the install command's script (served as text/plain, see firebase.json)
  manual/index.html     the full manual (built from docs/manual.md)
  connect/index.html    Team invite link page
  pricing/index.html    pricing and the Team checkout (Paddle.js overlay)
  thanks/index.html     after checkout: where the licence key is
  terms/ privacy/ refunds/   legal pages (drafts; Paddle's website review needs them)
  assets/paddle-config.js    Paddle client-side token and price ids (sandbox and live)
  assets/pricing.js, pricing.css   the plan picker and checkout, and these pages' styles
  robots.txt, sitemap.xml, favicon.ico, apple-touch-icon.png
  assets/site.css       styles (dark, follows light mode automatically)
  assets/site.js        GitHub links, copy buttons, contents highlighting
  assets/shots/         app screenshots, WebP, 1x and 2x, dark and light
  assets/og.png         social preview image (1200 × 630)
  assets/favicon.svg
  build-manual.mjs      builds manual/index.html from docs/manual.md
```

The pricing, thanks and legal pages (`pricing/`, `thanks/`, `terms/`, `privacy/`, `refunds/`, `assets/pricing.*`, `assets/paddle-config.js`) sit on top of `site.css`: keep `.edition`, `.price`, `.home` and the one-line `.site-foot` working when you change it.

## Launch day

- **GitHub links.** Every GitHub link is `<a data-gh="/path">`, and `assets/site.js` points them all at `GITHUB` (one line at its top). The HTML also has the full address in `href` for browsers without JavaScript. The repository is private, so these 404 for visitors until it's public.
- **Pre-launch notice.** "Public release coming soon — join the list" shows next to the install commands while `<html>` in `index.html` has `data-prelaunch`. Delete that attribute to hide both.

## Private beta

`install` also works against the private repository, for the owner's beta test:

```
curl -fsSL https://breakpatch.dev/install | BREAKPATCH_GITHUB_TOKEN=<token> BREAKPATCH_CHANNEL=beta sh
```

The token is a fine-grained personal access token for `BreakPatch/breakpatch` only, Contents read-only, expiring in 7 days. The script sends it to `https://api.github.com` only, never prints it or puts it on a command line, and downloads through the API's asset addresses. `BREAKPATCH_CHANNEL=beta` picks the newest release, prereleases included (GitHub's `releases/latest` skips them). The main README's "Private beta" section has the details. Once the repository is public the token isn't needed: the plain command works, and the token mode can go.

## Screenshots

The pictures in `assets/shots/` are the real app's browser preview (`cd app && npm run dev`, then `?demo&ready&theme=dark` or `theme=light`), taken with Playwright at 1280 × 800 and 2x, cropped, and saved as WebP at 1x and 2x. Each `<picture>` swaps to the light version when the Mac is in light mode. Keep `width` and `height` on every `<img>` matching the file.

## Hosting

The site is served by **Firebase Hosting**: the site `breakpatch-web` in the Firebase project `breakpatch-backoffice`, with the custom domain `breakpatch.dev`. The back office is the project's other Hosting site, at `https://account.breakpatch.dev`.

The deploy workflow (`.github/workflows/website.yml`) publishes this folder on every push that changes `site/` or `docs/manual.md`, in the GitHub environment `website`. It uses the `firebase-tools` pinned exactly in `site/package.json` and `site/package-lock.json` (`npm ci --ignore-scripts`, then `npx firebase`); `firebase.json` keeps those files and `node_modules/` off the site. Moving the website to its own Firebase project, so its deploy account can't reach the back office's Hosting site, is an owner step (the main README, "Releases, CI and the website: owner settings"). A Hosting config along these lines does it:

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

## Invite link format

```
https://breakpatch.dev/connect#c=<base64url(JSON)>
```

JSON: `{ "name", "logo"?, "config": { …Firebase web config… }, "database": "breakpatch", "domain": "example.com" }`.
The page decodes it in the browser only, shows the workspace, then opens `breakpatch://connect#c=…`. If the app doesn't open within 2.5 s it shows "Didn't open?". Non-Mac devices get "Open this link on your Mac". Invite links come from a Breakpatch Team workspace.

## Checkout (Paddle)

`/pricing` sells Team through [Paddle Billing](https://developer.paddle.com) (Paddle is the merchant of record). Paddle.js v2 is loaded from `cdn.paddle.com` only when someone presses **Buy Team**, or opens a Paddle payment link (`/pricing/?_ptxn=txn_…`, which Paddle uses for invoices and payment method updates). The checkout takes the people (at least 3) and extra machine licences, prefills the email, and passes `{ company, email }` as custom data; afterwards Paddle sends the buyer to `/thanks/`.

Paste the ids into `assets/paddle-config.js`: the client-side token (Paddle → Developer tools → Authentication) and the four Team price ids, for sandbox and live, and set `env`. None of them is a secret. Until the token and ids are there, the Buy button is off and the page says to email support@breakpatch.dev. Business is sold by email (Contact us).

The licence itself is made by the back office from Paddle's webhook: the private repo's `backoffice/README.md`, "Payments (Paddle)", has the owner's steps (products, prices, the notification destination, secrets). The legal pages are drafts marked "Draft", with `[Legal name]` to fill in; keep the privacy page in step with the manual's Privacy section.
