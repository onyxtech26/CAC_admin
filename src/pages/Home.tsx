import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Counter, Eyebrow, Heading, Marquee, Reveal, Tag } from "../components/ui";
import { HERO_STATS, MISSION, MISSION_POINTS, PRINCIPLES_HOME, PROCESS, SERVICES, VISION } from "../data";
import { Seo } from "../components/Seo";

const TRUST = [
  { k: "Independent Investigations", g: "pin" },
  { k: "Evidence Based Findings", g: "house-roof" },
  { k: "Confidential & Secure", g: "lock" },
  { k: "Professional Support", g: "shield-alert" },
];

const CREED = ["Discovering the Past", "Protecting the Present", "Securing the Future"];

export default function Home() {
  return (
    <>
    <Seo route="/" />
      <Hero />
      <Marquee items={SERVICES.map((s) => s.title)} />
      <FeaturedDisciplines />
      <FirmSummary />
      <VisionMission />
      <ProcessTeaser />
    </>
  );
}

/* ============== HERO ============== */
function Hero() {
  return (
    <section className="relative overflow-hidden pt-32 pb-20 lg:pt-40 lg:pb-28">
      <div className="pointer-events-none absolute inset-0 bg-grid opacity-60" />
      <div className="pointer-events-none absolute inset-0 bg-radial-gold" />
      <div className="pointer-events-none absolute inset-0 bg-radial-navy" />
      <div className="pointer-events-none absolute inset-0 noise opacity-40" />
      <div className="beam" />
      <div className="pointer-events-none absolute inset-0 vignette" />



      <div className="relative mx-auto grid max-w-[1320px] grid-cols-1 items-center gap-12 px-5 lg:grid-cols-12 lg:px-8">
        <div className="lg:col-span-6">
          <Reveal>
            <Eyebrow>Est. 2009 · Conglomerate Appraisal Consultancy</Eyebrow>
          </Reveal>
          <Reveal delay={80}>
            <h1 className="mt-6 font-display leading-[0.95] text-ivory">
              <span className="block text-[1.7rem] sm:text-3xl lg:text-[2.1rem]">Welcome to</span>
              <span className="mt-1 block text-[2.4rem] italic text-gold-gradient sm:text-6xl lg:text-[3.3rem]">Property Forensic</span>
            </h1>
          </Reveal>
          <Reveal delay={140}>
            <p className="mt-5 font-display text-[1.45rem] italic leading-snug text-sand sm:text-[1.75rem]">
              Turning Intelligence Into Evidence
            </p>
          </Reveal>
          <Reveal delay={200}>
            <p className="mt-6 max-w-xl text-base leading-relaxed text-stone sm:text-lg">
              A specialist investigation and consultancy service dedicated to uncovering the true ownership, history and legal status of real estate and estate assets — providing independent, evidence-based investigations for individuals, families, legal professionals, financial institutions, corporations and government agencies.
            </p>
          </Reveal>

          <Reveal delay={220}>
            <div className="mt-8 flex flex-wrap gap-x-6 gap-y-3">
              {TRUST.map((t) => (
                <span key={t.k} className="flex items-center gap-2 text-sm text-stone">
                  <span className="grid h-8 w-8 place-items-center rounded-full border border-gold-2/30 text-gold-2">
                    <Icon name={t.g} size={15} />
                  </span>
                  {t.k}
                </span>
              ))}
            </div>
          </Reveal>

          <Reveal delay={300}>
            <div className="mt-9 flex flex-wrap gap-3">
              <Link to="/contact" className="gold-btn sheen-host flex items-center gap-2 rounded-sm px-7 py-3.5 text-[12px] uppercase">
                Start Investigation <Icon name="arrow" size={16} />
              </Link>
              <Link to="/services" className="ghost-btn flex items-center gap-2 rounded-sm px-7 py-3.5 text-[12px] uppercase">
                View Our Services
              </Link>
            </div>
          </Reveal>
        </div>

        {/* Hero visual */}
        <div className="relative lg:col-span-6">
          <Reveal delay={120} className="relative">
            <div className="pointer-events-none absolute -inset-8 rounded-full blur-3xl glow-gold" />
            <div className="relative anim-float-slow">
              <img
                src="/assets/cac-building-logo.webp"
                alt="CAC office building with logo signage"
                className="w-full rounded-lg border border-gold-2/55 shadow-[0_60px_120px_-40px_rgba(0,0,0,0.9),0_0_44px_-12px_rgba(201,138,4,0.55)]"
              />
              {/* corner ticks overlay */}
              <span className="pointer-events-none absolute left-3 top-3 h-6 w-6 border-l border-t border-gold-2/70" />
              <span className="pointer-events-none absolute right-3 bottom-3 h-6 w-6 border-r border-b border-gold-2/70" />
            </div>
          </Reveal>
        </div>
      </div>

      {/* Creed */}
      <div className="relative mx-auto mt-16 max-w-[1320px] px-5 lg:px-8">
        <Reveal>
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-3">
            {CREED.map((c, i) => (
              <span key={c} className="flex items-center gap-6 font-mono text-[12px] uppercase tracking-wide-2 text-gold-2/90">
                {i > 0 && <span className="h-1.5 w-1.5 rotate-45 bg-gold-2/50" />}
                {c}
              </span>
            ))}
          </div>
        </Reveal>
      </div>

      {/* Stat bar */}
      <div className="relative mx-auto mt-16 max-w-4xl px-5 lg:px-8">
        <Reveal>
          {/* Outer element is a 1px gold gradient frame; the card sits inside it,
              so the rim reads as brushed metal rather than a flat border. */}
          <div className="stat-frame relative rounded-[2rem] p-px">
            <div className="stat-card relative overflow-hidden rounded-[2rem] px-6 py-10 sm:px-10 sm:py-12">
              <div className="pointer-events-none absolute inset-0 bg-grid-fine opacity-[0.35]" />
              <div className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full blur-3xl glow-gold" />
              <div className="pointer-events-none absolute -left-24 -bottom-28 h-72 w-72 rounded-full blur-3xl glow-gold" />

              {/* divider fades out at both ends rather than butting into the edges */}
              <span className="stat-divider pointer-events-none absolute inset-y-10 left-1/2 hidden w-px sm:block" />

              <div className="relative grid grid-cols-1 gap-10 sm:grid-cols-2 sm:gap-0">
                {HERO_STATS.map((s, i) => (
                  <div key={i} className="group relative flex flex-col items-center px-4 text-center">
                    <span className="stat-ring relative grid h-14 w-14 place-items-center rounded-full transition duration-500 group-hover:scale-105">
                      <span className="absolute inset-px rounded-full bg-ink" />
                      <Icon name={i === 0 ? "clock" : "doc-seal"} size={24} className="relative text-gold-2" />
                    </span>

                    <p className="mt-7 font-display text-[3.4rem] font-bold leading-none tracking-tight text-gold-gradient sm:text-[4rem]">
                      <Counter to={s.value} suffix={s.suffix} />
                    </p>

                    {/* short rule anchors the numeral to its label */}
                    <span className="mt-5 h-px w-10 bg-gradient-to-r from-transparent via-gold-2/70 to-transparent" />

                    <p className="mt-4 font-mono text-[11px] font-bold uppercase tracking-[0.3em] text-gold-2">
                      {s.label}
                    </p>
                    <p className="mt-2 font-mono text-[10px] uppercase tracking-wide-2 text-mute">
                      {s.note}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ============== FEATURED DISCIPLINES ============== */
function FeaturedDisciplines() {
  const feat = SERVICES.slice(0, 3);
  return (
    <section className="band-deep band-edge relative overflow-hidden py-24">
      <div className="mx-auto max-w-[1320px] px-5 lg:px-8">
        <div className="flex flex-col items-start justify-between gap-6 lg:flex-row lg:items-end">
          <Heading eyebrow="What we uncover" title={<>Three disciplines.<br />One unbroken chain of evidence.</>} />
          <Reveal delay={120}>
            <p className="max-w-md text-sm text-stone">
              Every engagement draws on all <Link to="/services" className="text-gold-2 underline decoration-gold-2/40 underline-offset-4">{SERVICES.length} forensic disciplines</Link> — these three anchor most estate and ownership recoveries.
            </p>
          </Reveal>
        </div>

        <div className="mt-12 grid gap-5 md:grid-cols-3">
          {feat.map((s, i) => (
            <Reveal key={s.id} delay={i * 110}>
              <Link to={`/services/${s.id}`} className="plate plate-hover group relative block h-full overflow-hidden rounded-lg">
                <div className="media-clip media-fade relative h-48 w-full overflow-hidden">
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
                  <h3 className="font-display text-2xl leading-snug text-ivory">{s.title}</h3>
                  <p className="mt-3 text-sm leading-relaxed text-stone">{s.short}</p>
                  <ul className="mt-5 space-y-2 border-t border-gold-2/10 pt-4">
                    {s.deliverables.slice(0, 3).map((d, j) => (
                      <li key={j} className="flex items-start gap-2 text-xs text-stone">
                        <Icon name="check" size={13} className="mt-0.5 shrink-0 text-gold-2" /> {d}
                      </li>
                    ))}
                  </ul>
                  <span className="mt-6 inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide-2 text-gold-2">
                    Open dossier <Icon name="arrow" size={14} className="transition group-hover:translate-x-1" />
                  </span>
                </div>
              </Link>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ============== CONSULTANCY SUMMARY ============== */
function FirmSummary() {
  return (
    <section className="band-lift relative overflow-hidden py-24">
      <div className="pointer-events-none absolute inset-0 bg-radial-navy opacity-70" />
      <div className="relative mx-auto grid max-w-[1320px] grid-cols-1 items-center gap-12 px-5 lg:grid-cols-2 lg:px-8">
        <Reveal>
          <div className="relative">
            <div className="pointer-events-none absolute -inset-4 rounded-lg border border-gold-2/40" />
            <img src="/assets/cac-building-logo.webp" alt="CAC office building with illuminated logo" className="relative w-full rounded-lg border border-gold-2/55 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.9),0_0_40px_-12px_rgba(201,138,4,0.55)]" />
          </div>
        </Reveal>

        <div>
          <Heading eyebrow="The consultancy" title={<>Forensic rigour,<br />delivered with discretion.</>} italic="Uncover The Truth. Protect Your Legacy." />
          <Reveal delay={120}>
            <p className="mt-6 text-stone">
              Whether the matter involves a disputed inheritance, a missing land title, historical ownership, suspected fraud or hidden estate assets, our experienced investigators conduct thorough research to establish the facts and help resolve complex property disputes. We transform historical land registry records, colonial grant books, cadastral maps and probate archives into documentary evidence that families, beneficiaries and legal counsel can act on.
            </p>
          </Reveal>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            {PRINCIPLES_HOME.map((p, i) => (
              <Reveal key={p.k} delay={i * 100} className="h-full">
                <div className="plate flex h-full flex-col rounded-md p-4">
                  <span className="font-mono text-[10px] uppercase tracking-wide-2 text-gold-2">0{i + 1}</span>
                  <p className="mt-1 font-display text-lg text-ivory">{p.k}</p>
                  <p className="mt-2 text-xs leading-relaxed text-stone">{p.d}</p>
                </div>
              </Reveal>
            ))}
          </div>
          <Reveal delay={220}>
            <Link to="/about" className="mt-8 inline-flex items-center gap-2 font-mono text-[12px] uppercase tracking-wide-2 text-gold-2">
              Read more about CAC <Icon name="arrow" size={16} />
            </Link>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* ============== VISION & MISSION ============== */
function VisionMission() {
  const PANELS = [
    { k: "Our Vision", t: VISION, g: "compass-pin" },
    { k: "Our Mission", t: MISSION, g: "seal" },
  ];
  return (
    <section className="band-deep band-edge relative overflow-hidden py-24">
      <div className="pointer-events-none absolute inset-0 bg-radial-gold opacity-25" />
      <div className="relative mx-auto max-w-[1320px] px-5 lg:px-8">
        <Heading
          eyebrow="What drives the work"
          title={<>Vision and mission,<br />stated plainly.</>}
          italic="Uncovering the Past. Protecting the Future."
        />
        <div className="mt-12 grid gap-5 lg:grid-cols-2">
          {PANELS.map((v, i) => (
            <Reveal key={v.k} delay={i * 120}>
              <div className="plate plate-hover corner-ticks relative flex h-full flex-col rounded-xl p-8 sm:p-10">
                <div className="flex items-center gap-3">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-gold-2/35 text-gold-2">
                    <Icon name={v.g} size={20} />
                  </span>
                  <Eyebrow>{v.k}</Eyebrow>
                </div>
                <p className="mt-6 font-display text-xl leading-relaxed text-ivory sm:text-2xl">{v.t}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ============== PROCESS TEASER (5 steps) ============== */
function ProcessTeaser() {
  return (
    <section className="band-lift relative overflow-hidden py-24">
      <div className="mx-auto max-w-[1320px] px-5 lg:px-8">
        <Heading eyebrow="Methodology · abridged" title={<>A standardized chain of<br />investigation, end to end.</>} />
        <div className="mt-12 grid gap-4 md:grid-cols-5">
          {PROCESS.slice(0, 5).map((p, i) => (
            <Reveal key={p.no} delay={i * 90}>
              <div className="plate plate-hover relative h-full overflow-hidden rounded-md p-5">
                <div className="flex items-center justify-between">
                  <span className="font-display text-3xl text-gold-gradient">{p.no}</span>
                  <Icon name={p.glyph} size={22} className="text-gold-2/70" />
                </div>
                <p className="mt-3 font-display text-lg leading-tight text-ivory">{p.title}</p>
                <p className="font-mono text-[10px] uppercase tracking-wide-2 text-gold-2/70">{p.sub}</p>
                <p className="mt-3 text-xs leading-relaxed text-stone">{p.details}</p>
                {i < 4 && <span className="absolute right-3 top-1/2 hidden text-gold-2/30 md:block"><Icon name="chevron-right" size={18} /></span>}
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal delay={120}>
          <div className="mt-10 flex flex-col items-center justify-between gap-5 rounded-lg border border-gold-2/20 bg-navy-2/50 p-6 sm:flex-row">
            <div className="flex items-center gap-4">
              <Icon name="gavel" size={36} className="text-gold-2" />
              <p className="max-w-xl text-sm text-stone">
                We deliver clear, credible and evidence-based reports that help you make <span className="text-gold-2">informed decisions</span> with confidence — across all {PROCESS.length} stages.
              </p>
            </div>
            <Link to="/process" className="gold-btn sheen-host flex items-center gap-2 rounded-sm px-6 py-3 text-[12px] uppercase">
              How We Work <Icon name="arrow" size={16} />
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
