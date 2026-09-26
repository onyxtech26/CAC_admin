import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Heading, Reveal } from "../components/ui";
import { Seo } from "../components/Seo";
import { NAV, SERVICES } from "../data";

/**
 * A page that is not there.
 *
 * `<Route path="*" element={<Home />} />` used to render the homepage for any unknown URL, and
 * `vercel.json` rewrites everything to `index.html` — so a nonexistent address returned **HTTP 200
 * with homepage content** and a canonical pointing at the site root. A search engine indexes that as
 * the homepage, over and over, for every typo and every stale link anybody ever published.
 *
 * A static host cannot return a 404 status for a rewritten path, so two things are done instead and
 * both matter: the page says plainly that the address does not exist, and its metadata carries
 * `noindex` so the crawler is told not to keep it. The canonical is the page's own path rather than
 * the site root, so nothing here claims to be the homepage.
 */
export default function NotFound() {
  const path = typeof window === "undefined" ? "" : window.location.pathname;

  return (
    <>
      <Seo
        title="Page not found · CAC"
        description="That address does not exist on this site."
        path={path || "/404"}
        noindex
      />
      <section className="relative pt-32 pb-24 lg:pt-40">
        <div className="pointer-events-none absolute inset-0 bg-grid opacity-50" />
        <div className="pointer-events-none absolute inset-0 bg-radial-navy" />

        <div className="relative mx-auto max-w-[1320px] px-5 lg:px-8">
          <div className="max-w-3xl">
            <Heading
              as="h1"
              eyebrow="404"
              title={
                <>
                  That page is <span className="italic text-gold-gradient">not here.</span>
                </>
              }
            />
            <Reveal delay={120}>
              <p className="mt-6 text-stone">
                {path ? (
                  <>
                    Nothing exists at <span className="font-mono text-gold-2">{path}</span>. The link
                    may be old, or there may be a typo in it.
                  </>
                ) : (
                  <>The address you followed does not exist on this site.</>
                )}
              </p>
            </Reveal>
          </div>

          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="plate group flex items-center justify-between rounded-md p-5 transition hover:border-gold-2/50"
              >
                <span className="text-sand group-hover:text-gold-2">{item.label}</span>
                <Icon name="chevron-right" size={14} className="text-gold-2/60" />
              </Link>
            ))}
          </div>

          <div className="mt-12">
            <p className="font-mono text-[11px] uppercase tracking-wide-2 text-gold-2/70">
              Or a discipline
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              {SERVICES.map((service) => (
                <Link
                  key={service.id}
                  to={`/services/${service.id}`}
                  className="rounded-lg border border-gold-2/25 px-4 py-2 text-[13px] text-sand transition hover:border-gold-2 hover:text-gold-2"
                >
                  {service.title}
                </Link>
              ))}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
