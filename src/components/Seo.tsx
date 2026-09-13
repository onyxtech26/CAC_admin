import { useEffect } from "react";
import { CONTACT } from "../data";
import ROUTES from "../seo-routes.json";

export const SITE_URL = "https://www.conglomerate4u.com";

type Props =
  /** static page — metadata comes from src/seo-routes.json */
  | { route: keyof typeof ROUTES; title?: never; description?: never; path?: never }
  /** dynamic page (e.g. a service) — metadata supplied by the caller */
  | { route?: never; title: string; description: string; path: string };

/** Shared by the app and scripts/prerender.mjs so the two cannot drift. */
export function pageTitle(title: string) {
  // several page titles already contain "CAC"; don't append it twice
  return title.includes(CONTACT.short)
    ? `${title} · ${CONTACT.company}`
    : `${title} · ${CONTACT.short}`;
}

function setMeta(selector: string, attr: "name" | "property", key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

/**
 * Per-page title, description, canonical and Open Graph tags.
 *
 * These run on the client for in-app navigation. For the first response,
 * scripts/prerender.mjs bakes the same values into a static HTML file per
 * route at build time — which is what social scrapers (WhatsApp, Facebook,
 * LinkedIn) read, since they do not execute JavaScript.
 */
export function Seo(props: Props) {
  const meta = props.route ? ROUTES[props.route] : null;
  const title = meta ? meta.title : props.title!;
  const description = meta ? meta.description : props.description!;
  const path = props.route ?? props.path!;

  useEffect(() => {
    const full = pageTitle(title);
    document.title = full;

    setMeta('meta[name="description"]', "name", "description", description);
    setMeta('meta[property="og:title"]', "property", "og:title", full);
    setMeta('meta[property="og:description"]', "property", "og:description", description);
    setMeta('meta[property="og:url"]', "property", "og:url", `${SITE_URL}${path}`);
    setMeta('meta[name="twitter:title"]', "name", "twitter:title", full);
    setMeta('meta[name="twitter:description"]', "name", "twitter:description", description);

    let link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) {
      link = document.createElement("link");
      link.setAttribute("rel", "canonical");
      document.head.appendChild(link);
    }
    link.setAttribute("href", `${SITE_URL}${path}`);
  }, [title, description, path]);

  return null;
}
