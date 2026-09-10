import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Counter, Heading, Marquee, Reveal, Tag } from "../components/ui";
import { HERO_STATS, INDUSTRIES, PRINCIPLES_HOME, STRAPLINE, TAGLINES, waLink } from "../data";
import { Seo } from "../components/Seo";

const VALUES = [
  { k: "Integrity", g: "shield-alert" },
  { k: "Confidentiality", g: "lock" },
  { k: "Accuracy", g: "seal" },
  { k: "Professionalism", g: "scales" },
];

const TIMELINE = [
  { y: "2009", t: "Consultancy established", d: "Founding investigations into Johor family estates and pioneer-title disputes." },
  { y: "2014", t: "Registry network expanded", d: "Formal working channels with state land offices, survey departments and High Court probate registries." },
  { y: "2018", t: "Forensic methodology codified", d: "The investigation lifecycle standardised across every engagement." },
  { y: "2020", t: "Consolidated as CAC", d: "Conglomerate Appraisal Consultancy — all forensic casework brought under a single consultancy name." },
  { y: "2024", t: "Intelligence Hub launched", d: "GIS, satellite and chronology dashboards integrated into client reporting." },
  { y: "2026", t: "227+ cases closed", d: "Nationwide footprint across 14 Malaysian states with a 30+ active caseload." },
];

export default function About() {
  return (
    <>
    <Seo route="/about" />
      <section className="relative overflow-hidden pt-32 pb-20 lg:pt-40">
        <div className="pointer-events-none absolute inset-0 bg-grid opacity-50" />
        <div className="pointer-events-none absolute inset-0 bg-radial-navy" />
        <div className="relative mx-auto grid max-w-[1320px] grid-cols-1 items-center gap-12 px-5 lg:grid-cols-12 lg:px-8">
          <div className="lg:col-span-6">
            <Reveal>
              <nav className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide-2 text-mute">
                <Link to="/" className="hover:text-gold-2">Home</Link>
                <Icon name="chevron-right" size={12} className="text-gold-2/60" />
                <span className="text-gold-2">About Us</span>
              </nav>
            </Reveal>
            <Reveal delay={80}>
              <h1 className="mt-5 font-display text-5xl leading-[0.98] text-ivory sm:text-6xl lg:text-7xl">
                About <span className="italic text-gold-gradient">CAC</span>
              </h1>
              <div className="mt-5 h-px w-24 hairline" />
            </Reveal>
            <Reveal delay={140}>
              <p className="mt-6 max-w-xl text-stone">
                CAC is an independent property investigation consultancy specialising in forensic analysis of real estate ownership, estate assets, historical property records and asset tracing — uncovering the truth behind property ownership and helping clients protect their legacy.
              </p>
              <p className="mt-4 max-w-xl text-stone">
                We combine investigative research, historical analysis, land administration knowledge, legal documentation review and financial tracing to reconstruct the complete history of a property. Every investigation is conducted professionally, confidentially and objectively.
              </p>
            </Reveal>
            <Reveal delay={200}>
              <div className="mt-7 flex flex-wrap gap-3">
                <Link to="/contact" className="gold-btn sheen-host flex items-center gap-2 rounded-sm px-6 py-3 text-[12px] uppercase">
                  Book Consultation <Icon name="arrow" size={16} />
                </Link>
                <Link to="/why-cac" className="ghost-btn flex items-center gap-2 rounded-sm px-6 py-3 text-[12px] uppercase">
                  Why Choose CAC
                </Link>
              </div>
            </Reveal>
            <Reveal delay={260}>
              <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {VALUES.map((v) => (
                  <div key={v.k} className="flex flex-col items-center gap-2 rounded-md border border-gold-2/40 bg-navy-2/70 py-4 text-center shadow-[inset_0_1px_0_rgba(233,199,102,0.14),0_14px_30px_-22px_rgba(0,0,0,0.95)] transition duration-300 hover:border-gold-2/80 hover:bg-navy-2/90">
                    <Icon name={v.g} size={22} className="text-gold-2" />
                    <span className="font-mono text-[10px] uppercase tracking-wide-2 text-stone">{v.k}</span>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>

          <Reveal delay={120} className="lg:col-span-6">
            <div className="relative">
              <div className="pointer-events-none absolute -inset-4 rounded-lg border border-gold-2/40" />
              <img src="/assets/cac-building-logo.webp" alt="CAC headquarters building with illuminated logo" className="relative w-full rounded-lg border border-gold-2/55 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.9),0_0_40px_-12px_rgba(201,138,4,0.55)]" />
            </div>
          </Reveal>
        </div>
      </section>

      <Marquee items={TAGLINES} />

      {/* Stats band */}
      <section className="relative py-12">
        <div className="mx-auto max-w-4xl px-5 lg:px-8">
          <Reveal>
            <div className="corner-ticks relative overflow-hidden rounded-[2.5rem] border border-gold-2/25 bg-gradient-to-br from-navy-3/90 via-navy-2/95 to-ink p-6 shadow-[0_30px_70px_-20px_rgba(0,0,0,0.8)] backdrop-blur-xl sm:p-12">
              <div className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full blur-3xl glow-gold" />
              <div className="pointer-events-none absolute -left-20 -bottom-20 h-64 w-64 rounded-full blur-3xl glow-gold" />

              <div className="grid grid-cols-1 divide-y divide-gold-2/15 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
                {HERO_STATS.map((s, i) => (
                  <div key={i} className="group relative flex flex-col items-center justify-center py-6 px-4 text-center sm:py-8">
                    <div className="grid h-16 w-16 place-items-center rounded-2xl border border-gold-2/30 bg-ink/60 text-gold-2 shadow-lg transition duration-300 group-hover:scale-105 group-hover:border-gold-2">
                      <Icon name={i === 0 ? "clock" : "doc-seal"} size={28} className="text-gold-2" />
                    </div>
                    <p className="mt-6 font-display text-5xl font-bold tracking-tight text-gold-gradient sm:text-6xl">
                      <Counter to={s.value} suffix={s.suffix} />
                    </p>
                    <p className="mt-4 font-mono text-[11px] font-semibold uppercase tracking-[0.28em] text-gold-2/90">
                      {s.label}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* Story + timeline */}
      <section className="relative py-24">
        <div className="mx-auto grid max-w-[1320px] grid-cols-1 gap-14 px-5 lg:grid-cols-12 lg:px-8">
          <div className="lg:col-span-5">
            <Heading eyebrow="Our story" title={<>Seventeen years reading<br />the Malaysian record.</>} />
            <Reveal delay={120}>
              <p className="mt-6 text-stone">
                CAC began in 2009 as a focused forensic consultancy serving families tangled in Johor inheritance disputes and pioneer-title ambiguities. What started as a single consultant tracing registry chains by hand has grown into a multidisciplinary intelligence team — yet the method has never changed: start with the document, follow the chain, verify every transition, and compile evidence that survives scrutiny.
              </p>
              <p className="mt-4 text-stone">
                Today CAC serves beneficiaries, legal counsel, developers and investors nationwide — from Skudai to the High Court — with the same discretion and rigour that defined its first engagement.
              </p>
            </Reveal>
          </div>

          <div className="lg:col-span-7">
            <Reveal><p className="font-mono text-[11px] uppercase tracking-wide-2 text-gold-2/70">// Consultancy chronology</p></Reveal>
            <ol className="mt-6 space-y-6 border-l border-gold-2/20 pl-6">
              {TIMELINE.map((t, i) => (
                <Reveal as="li" key={t.y} delay={i * 80} className="relative">
                  <span className="absolute -left-[31px] top-1 grid h-4 w-4 place-items-center rounded-full border border-gold-2 bg-navy">
                    <span className="h-1.5 w-1.5 rounded-full bg-gold-2" />
                  </span>
                  <div className="flex items-baseline gap-3">
                    <span className="font-display text-2xl text-gold-gradient">{t.y}</span>
                    <span className="font-display text-lg text-ivory">{t.t}</span>
                  </div>
                  <p className="mt-1 text-sm text-stone">{t.d}</p>
                </Reveal>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* 3 Core principles */}
      <section className="relative overflow-hidden border-y border-gold-2/10 bg-ink py-24">
        <div className="pointer-events-none absolute inset-0 bg-grid-fine opacity-40" />
        <div className="relative mx-auto max-w-[1320px] px-5 lg:px-8">
          <Heading eyebrow="Core principles" title={<>Three commitments that<br />never leave the file.</>} />
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {PRINCIPLES_HOME.map((p, i) => (
              <Reveal key={p.k} delay={i * 110}>
                <div className="plate plate-hover corner-ticks relative h-full overflow-hidden rounded-lg p-8">
                  <span className="font-display text-5xl text-gold-gradient">0{i + 1}</span>
                  <h3 className="mt-4 font-display text-2xl text-ivory">{p.k}</h3>
                  <div className="mt-3 h-px w-12 hairline" />
                  <p className="mt-4 text-stone">{p.d}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Industries we serve */}
      <section className="band-deep band-edge relative overflow-hidden py-24">
        <div className="mx-auto max-w-[1320px] px-5 lg:px-8">
          <Heading eyebrow="Industries we serve" title={<>Who we act for,<br />and what they need proven.</>} />
          <Reveal delay={120}>
            <p className="mt-6 max-w-2xl text-stone">{STRAPLINE} — for anyone who has to rely on the answer.</p>
          </Reveal>
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {INDUSTRIES.map((n, i) => (
              <Reveal key={n.k} delay={i * 55}>
                <div className="plate plate-hover flex h-full flex-col rounded-lg p-5">
                  <span className="grid h-10 w-10 place-items-center rounded-full border border-gold-2/30 text-gold-2">
                    <Icon name={n.g} size={18} />
                  </span>
                  <p className="mt-4 font-display text-lg leading-snug text-ivory">{n.k}</p>
                  <p className="mt-2 text-xs leading-relaxed text-stone">{n.d}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
