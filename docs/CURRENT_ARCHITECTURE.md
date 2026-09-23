# CAC — Current Architecture (baseline as inspected)

**Inspected:** 2026-09-23 · **Commit:** `e03ec11` · **Working tree:** clean
**Live:** https://conglomerate4u.com · https://www.conglomerate4u.com · https://cac-conglomerate.vercel.app

This records the system *as it actually is today*, before any platform work. It is the
reference point for judging whether later changes broke something.

---

## 1. Stack

| Concern | Actual |
|---|---|
| Language | TypeScript 5.9.3 (`strict: true`, `noUnusedLocals`, `noUnusedParameters`) |
| Frontend | React 19.2.6, `react-dom` 19.2.6 |
| Routing | `react-router-dom` 7.18.1 — **client-side only** |
| Build | Vite 7.3.2 + `@vitejs/plugin-react` |
| Styling | Tailwind CSS v4.1.17 via `@tailwindcss/vite`; design tokens in `@theme` inside `src/index.css` |
| Package manager | npm (`package-lock.json`) |
| **Backend** | **None** |
| **Database** | **None** |
| **Authentication** | **None** |
| **Tests** | **None** — no runner, no `npm test` script, no test files |
| Hosting | Vercel, project `cac` (`prj_2cE3dD…`), team `Onyxx Tech Hub` (`team_uv8byB…`), **Hobby plan** |
| Repo | `github.com/onyxtech26/CAC`, **private** |

Runtime dependency count is 5 (`clsx`, `react`, `react-dom`, `react-router-dom`, `tailwind-merge`).
There is no state manager, data-fetching library, form library or validation library.

## 2. What the application actually is

A **brochure site**. 3,853 lines across 24 source files.

```
src/
  main.tsx            app entry
  App.tsx             BrowserRouter + 7 routes + floating WhatsApp CTA
  data.ts             ALL site copy: CONTACT, TEAM, SERVICES, PROCESS, FAQ, INDUSTRIES…
  index.css           Tailwind @theme tokens + ~40 bespoke utilities/keyframes
  seo-routes.json     per-route <title>/description
  components/         Navbar Footer Icon ui Seo SplashScreen Redact
                      EvidenceChain ProcessFlow AddressModal
  pages/              Home About Services ServiceDetail Process WhyCAC Contact
```

**Routes:** `/`, `/about`, `/services`, `/services/:serviceId`, `/process`, `/why-cac`,
`/contact`, and `*` → Home.

**Critical finding — there is no data flow of any kind.** A repo-wide search for
`<form`, `onSubmit`, `fetch(`, `axios` and `XMLHttpRequest` returns **zero** matches.
The site never sends or receives data. Enquiries leave via `mailto:` and `wa.me` links
only. An earlier FormSubmit contact form was deliberately removed (commit `80deabf`).

**Consequence:** there is no existing backend, auth, session, validation or persistence
layer to extend. The internal platform is a greenfield build that must sit *beside* this,
not inside it.

## 3. Build and deployment

```
npm run build  =  vite build  &&  node scripts/prerender.mjs
```

`scripts/prerender.mjs` reads `src/seo-routes.json`, regex-parses `SERVICES` out of
`src/data.ts`, and writes one static HTML file per route (12 total) with title,
description, canonical and Open Graph baked in — because social scrapers don't run JS.
Vercel serves the filesystem before applying the SPA rewrite, so `/about` hits
`dist/about/index.html`.

`vercel.json` rewrites `/(.*)` → `/index.html`.

**Baseline build output:** `index.html` 3.96 kB · CSS 68.85 kB (12.18 kB gz) ·
JS 338.17 kB (101.55 kB gz) · built in ~3s · 12 routes prerendered · **exit 0**.

## 4. Known defects in the baseline

| # | Issue | Severity | Evidence |
|---|---|---|---|
| 1 | `tsc --noEmit` **fails** with 4 `TS6133` unused-import errors in `About.tsx`, `Home.tsx`, `Process.tsx` | Low | Build is unaffected — `vite build` uses esbuild and does **not** type-check. There is no CI gate, so this has gone unnoticed. |
| 2 | **No tests at all** | High for the platform | Nothing protects the public site from regression once shared code appears. |
| 3 | **No CI** | High | No lint/type/test gate on push. |
| 4 | `scripts/prerender.mjs` regex-parses `data.ts` | Medium | A formatting change to the `SERVICES` literal silently breaks per-service SEO. Should import the data, not scrape it. |
| 5 | Content is hardcoded in `data.ts` | Medium | Every copy change needs a developer, a commit and a deploy. |
| 6 | Splash screen runs on **every** page load (~5.2 s) | Medium (UX) | `sessionStorage` gate was removed by request. Costs every visitor 5.2 s per load. |
| 7 | 4 orphaned assets in repo | Low | `case-mansion-*.webp`, `src/assets/hero-pic.png`, `home pic.png`, `bossku.png` — referenced nowhere. Plus a 1.3 MB `.pptx` and a 2.3 MB preview PNG tracked in git. |
| 8 | Unused `CONTACT.consultantRole` field | Trivial | Rendered nowhere. |

## 5. Security posture (of the public site)

There is almost no attack surface today, because there is no server and no input.

| Control | State |
|---|---|
| TLS | ✅ Vercel-managed, valid certs on both hostnames |
| Secrets in repo | ✅ None. `.env*` is gitignored; `.env.local` (Vercel OIDC token) is local-only and untracked |
| Auth | n/a — nothing to protect |
| Security headers | ❌ **None set.** No CSP, HSTS, `X-Frame-Options`, `Referrer-Policy`, `X-Content-Type-Options` |
| Rate limiting | ❌ None |
| Input validation | n/a — no inputs |
| Audit log | ❌ None |
| Dependency scanning | ❌ None. `npm audit` last reported 6 vulnerabilities (1 low, 1 moderate, 4 high) |

**Public email exposure:** `admin@conglomerate4u.com` and `+60 11-5960 1300` are
rendered in plain text and embedded in JSON-LD. That is intentional for a contact page,
but it means both will be scraped. Accept, or obfuscate later.

## 6. Operational constraints discovered the hard way

These were hit during live work in this repo and directly constrain the platform:

1. **Vercel Hobby plan blocks private-repo deploys** unless the commit author is the
   Hobby team owner. Three deploys were rejected with state `BLOCKED` and no build
   (`dpl_Ht1ky…`, `dpl_oJHb5…`, `dpl_EEEjc…`) after the repo was made private. Resolved
   by committing as `onyxtech26 <onyxtech26@gmail.com>`. **This plan is not viable for a
   multi-user production ERP** — see `OPEN_QUESTIONS.md` Q-INFRA-1.
2. **DNS is at GoDaddy**, A records → `76.76.21.21`. MX/DKIM/`_dmarc` for
   `secureserver.net` live in the same zone, so moving nameservers to Vercel would break
   company email. Apex + `www` are attached to the Vercel project; certs issued.
3. A **GoDaddy Website Builder PWA service worker** was previously installed on
   `conglomerate4u.com` and kept serving a cached GoDaddy page after DNS cut over.
   Relevant because a future service worker on the internal app could do the same.

## 7. Design system worth preserving

`src/index.css` holds a genuinely coherent token set that the internal platform should
reuse for brand continuity — but **not** wholesale, because the public site's aesthetic
(dark navy, heavy gold, splash animation, floating cards) is a marketing look. Enterprise
software needs a lighter, denser, calmer variant.

| Token group | Values |
|---|---|
| Navy ramp | `#050b16` ink · `#0b192e` navy · `#112a48` · `#173763` · `#22497c` |
| Gold ramp | `#8f6519` · `#ca8a04` · `#e9c766` · `#d8b25a` |
| Warm text | `#faf8f5` ivory · `#ece6da` sand · `#d7d0c2` stone · `#b0a795` mute |
| Type | Playfair Display (display) · Poppins (body) · JetBrains Mono (mono) |

Accessibility work already done and worth keeping: `:focus-visible` rings, a skip link,
one `<h1>` per route, and `prefers-reduced-motion` paths throughout.

## 8. Verdict

**Preserve the public site. Do not migrate it to build the platform.**

It is small, working, freshly signed off by the client, SEO-tuned, and carries zero
server-side logic that the platform could reuse. Rewriting it would be pure risk for no
gain. The platform is a separate application that shares brand tokens and one navigation
gesture.

What the platform genuinely cannot reuse: routing (client-only), build target (static
SPA), and anything to do with data — because none of it exists.

→ See `TARGET_ARCHITECTURE.md`.
