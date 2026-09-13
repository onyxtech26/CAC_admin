/**
 * Post-build prerender.
 *
 * The site is client-rendered, so the metadata written by <Seo> only exists
 * after JavaScript runs. Social scrapers (WhatsApp, Facebook, LinkedIn) do not
 * execute JavaScript — they read the first HTML response — so shared links
 * would all show the homepage preview regardless of which page was shared.
 *
 * This writes one static HTML file per route with that route's title,
 * description, canonical and Open Graph tags already baked in. React still
 * boots normally on top of it, so behaviour is unchanged for real visitors.
 *
 * Vercel matches the filesystem before applying the SPA rewrite, so
 * /about is served by dist/about/index.html when it exists.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const SITE_URL = "https://www.conglomerate4u.com";

if (!existsSync(join(dist, "index.html"))) {
  console.error("prerender: dist/index.html not found — run the build first");
  process.exit(1);
}

const shell = readFileSync(join(dist, "index.html"), "utf8");

// ---- routes: the same JSON the app uses, plus one page per service ----
const routes = { ...JSON.parse(readFileSync(join(root, "src/seo-routes.json"), "utf8")) };

const data = readFileSync(join(root, "src/data.ts"), "utf8");
const block = data.slice(data.indexOf("export const SERVICES"), data.indexOf("export type ProcessStep"));
for (const m of block.matchAll(/id: "([a-z-]+)",[\s\S]*?title: "([^"]+)"[\s\S]*?short:\s*"([^"]+)"/g)) {
  const [, id, title, short] = m;
  routes[`/services/${id}`] = { title, description: short };
}

// ---- title suffix, mirroring pageTitle() in src/components/Seo.tsx ----
const SHORT = "CAC";
const COMPANY = "Conglomerate Appraisal Consultancy";
const pageTitle = (t) => (t.includes(SHORT) ? `${t} · ${COMPANY}` : `${t} · ${SHORT}`);

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function render(path, { title, description }) {
  const full = pageTitle(title);
  const url = `${SITE_URL}${path}`;
  let html = shell;

  const swap = (pattern, replacement) => {
    if (!pattern.test(html)) {
      console.warn(`  ! ${path}: no match for ${pattern}`);
      return;
    }
    html = html.replace(pattern, replacement);
  };

  swap(/<title>[\s\S]*?<\/title>/, `<title>${esc(full)}</title>`);
  swap(/<meta name="description" content="[\s\S]*?"\s*\/>/, `<meta name="description" content="${esc(description)}" />`);
  swap(/<link rel="canonical" href="[\s\S]*?"\s*\/>/, `<link rel="canonical" href="${url}" />`);
  swap(/<meta property="og:url" content="[\s\S]*?"\s*\/>/, `<meta property="og:url" content="${url}" />`);
  swap(/<meta property="og:title" content="[\s\S]*?"\s*\/>/, `<meta property="og:title" content="${esc(full)}" />`);
  swap(/<meta property="og:description" content="[\s\S]*?"\s*\/>/, `<meta property="og:description" content="${esc(description)}" />`);
  swap(/<meta name="twitter:title" content="[\s\S]*?"\s*\/>/, `<meta name="twitter:title" content="${esc(full)}" />`);
  swap(/<meta name="twitter:description" content="[\s\S]*?"\s*\/>/, `<meta name="twitter:description" content="${esc(description)}" />`);

  return html;
}

let count = 0;
for (const [path, meta] of Object.entries(routes)) {
  const html = render(path, meta);
  if (path === "/") {
    writeFileSync(join(dist, "index.html"), html);
  } else {
    const dir = join(dist, path.replace(/^\//, ""));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), html);
  }
  count++;
  console.log(`  ${path.padEnd(30)} ${pageTitle(meta.title).slice(0, 52)}`);
}

console.log(`\nprerendered ${count} routes`);
