import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Heading, Reveal, Tag } from "../components/ui";
import { SERVICES } from "../data";
import { Seo } from "../components/Seo";

export default function Services() {
  const [q, setQ] = useState("");
  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return SERVICES;
    return SERVICES.filter((s) =>
      [s.title, s.short, s.scope, s.accent, ...s.deliverables].join(" ").toLowerCase().includes(t)
    );
  }, [q]);

  return (
    <>
    <Seo route="/services" />
      <section className="relative pt-32 pb-24 lg:pt-40">
        <div className="pointer-events-none absolute inset-0 bg-grid opacity-50" />
        <div className="pointer-events-none absolute inset-0 bg-radial-gold opacity-40" />
  
        <div className="relative mx-auto max-w-[1320px] px-5 lg:px-8">
          <nav className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide-2 text-mute">
            <Link to="/" className="hover:text-gold-2">Home</Link>
            <Icon name="chevron-right" size={12} className="text-gold-2/60" />
            <span className="text-gold-2">Services</span>
          </nav>
  
          <div className="mt-5 flex flex-col items-start justify-between gap-8 lg:flex-row lg:items-end">
            <Heading
              as="h1"
              eyebrow={`Capabilities directory · ${SERVICES.length} disciplines`}
              title={<>Our <span className="italic text-gold-gradient">Services</span></>}
            />
            <Reveal delay={120} className="w-full lg:max-w-md">
              <div className="flex items-center overflow-hidden rounded-sm border border-gold-2/30 bg-navy-2/60 focus-within:border-gold-2">
                <span className="grid place-items-center px-3 text-gold-2"><Icon name="magnifier-fingerprint" size={18} /></span>
                {/* A placeholder is not a label: it disappears the moment somebody types, and a
                    screen reader announces an unnamed text box. The label is visually hidden rather
                    than absent. */}
                <label htmlFor="service-search" className="sr-only">
                  Search the disciplines
                </label>
                <input
                  id="service-search"
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search disciplines, deliverables, keywords…"
                  className="w-full bg-transparent py-3.5 pr-3 text-sm text-ivory outline-none placeholder:text-mute/60"
                />
                {q && (
                  <button
                    type="button"
                    onClick={() => setQ("")}
                    aria-label="Clear the search"
                    className="px-3 text-mute hover:text-gold-2"
                  >
                    <Icon name="close" size={16} />
                  </button>
                )}
              </div>
              <p className="mt-2 font-mono text-[10px] uppercase tracking-wide-2 text-mute">
                Showing {results.length} / {SERVICES.length} disciplines
              </p>
            </Reveal>
          </div>
  
          {results.length === 0 ? (
            <div className="mt-16 grid place-items-center rounded-lg border border-dashed border-gold-2/20 py-20 text-center">
              <Icon name="magnifier-house" size={42} className="text-gold-2/40" />
              <p className="mt-4 font-display text-2xl text-ivory">No disciplines match "{q}"</p>
              <p className="mt-2 text-sm text-stone">Try "forensic", "title", "fraud", "ownership" or "estate".</p>
            </div>
          ) : (
            <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {results.map((s, i) => (
                <Reveal key={s.id} delay={(i % 3) * 90}>
                  <Link to={`/services/${s.id}`} className="plate plate-hover group relative flex h-full flex-col overflow-hidden rounded-lg">
                    {/* AI Illustration Banner */}
                    <div className="media-clip media-fade relative h-44 w-full overflow-hidden">
                      <img
                        src={s.img}
                        alt={s.title}
                        className="h-full w-full object-cover transition duration-700 group-hover:scale-105"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-navy-2 via-navy-2/40 to-transparent" />
                      <div className="absolute top-3 left-3">
                        <Tag>{s.accent}</Tag>
                      </div>
                      <span className="absolute top-3 right-3 font-mono text-[10px] font-semibold text-gold-2/90 bg-navy/80 px-2.5 py-1 rounded border border-gold-2/30 backdrop-blur">
                        {s.no} / {SERVICES.length}
                      </span>
                    </div>
  
                    <div className="flex flex-1 flex-col p-6">
                      <h2 className="font-display text-2xl leading-snug text-ivory">{s.title}</h2>
                      <p className="mt-3 flex-1 text-sm leading-relaxed text-stone">{s.short}</p>
                      <ul className="mt-5 space-y-1.5 border-t border-gold-2/10 pt-4">
                        {s.deliverables.slice(0, 2).map((d, j) => (
                          <li key={j} className="flex items-start gap-2 text-xs text-stone">
                            <Icon name="check" size={12} className="mt-0.5 shrink-0 text-gold-2" /> <span className="line-clamp-1">{d}</span>
                          </li>
                        ))}
                        <li className="pl-5 font-mono text-[10px] uppercase tracking-wide-2 text-gold-2/70">+{s.deliverables.length - 2} more deliverables</li>
                      </ul>
                      <span className="mt-5 inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide-2 text-gold-2">
                        Open dossier <Icon name="arrow" size={14} className="transition group-hover:translate-x-1" />
                      </span>
                    </div>
                  </Link>
                </Reveal>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
