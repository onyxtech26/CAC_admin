import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Heading, Reveal, Tag } from "../components/ui";
import { FAQ, MISSION_POINTS, WHY_PRINCIPLES } from "../data";
import { Seo } from "../components/Seo";

const PRINCIPLE_IMAGES = [
  { img: "/assets/illustration-forensic.webp", alt: "Documentary Forensic Investigation Evidence" },
  { img: "/assets/case-gavel-bRvLoHQ5.webp", alt: "Independent Court Grade Legal Standards" },
  { img: "/assets/illustration-estate.webp", alt: "Confidential Estate & Asset Handling" },
  { img: "/assets/cac-building.webp", alt: "End-to-End Registry & Title Support" },
];

// The six "Why Choose" points from the client brief. These replaced an earlier
// list that overlapped heavily with WHY_PRINCIPLES above — note the brief says
// "professional standards", not the "global standards" the old copy claimed,
// consistent with the client striking "worldwide" from the vision statement.
const STANDARDS = [
  { k: "Independent & Objective", img: "/assets/case-gavel-bRvLoHQ5.webp", d: "We act for the truth of the record — no stake in the outcome, and no party to favour." },
  { k: "Confidential Handling", img: "/assets/icon-legal.webp", d: "Estate matters are intimate. Sensitive material is handled to counsel grade on every file." },
  { k: "Detailed Historical Research", img: "/assets/service-forensic-title.webp", d: "Colonial grants, superseded title series, survey plans and probate archives — back as far as the record goes." },
  { k: "Structured Evidence Reporting", img: "/assets/illustration-forensic.webp", d: "Findings arrive as an organised portfolio with source documents attached, not a narrative summary." },
  { k: "Support Through Resolution", img: "/assets/service-ill-forensic.webp", d: "We work alongside the lawyers, executors, trustees and beneficiaries who must act on the findings." },
  { k: "Professional Standards & Ethics", img: "/assets/cac-building.webp", d: "Disciplined method, stated limitations, and no claim the documents cannot carry." },
];

export default function WhyCAC() {
  return (
    <>
    <Seo route="/why-cac" />
      <section className="relative pt-32 pb-24 lg:pt-40">
        <div className="pointer-events-none absolute inset-0 bg-grid opacity-50" />
        <div className="pointer-events-none absolute inset-0 bg-radial-gold opacity-40" />
  
        <div className="relative mx-auto max-w-[1320px] px-5 lg:px-8">
          <nav className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide-2 text-mute">
            <Link to="/" className="hover:text-gold-2">Home</Link>
            <Icon name="chevron-right" size={12} className="text-gold-2/60" />
            <span className="text-gold-2">Why CAC</span>
          </nav>
  
          <div className="mt-6 max-w-3xl">
            <Heading as="h1" eyebrow="Why CAC" title={<>Why clients trust<br /><span className="italic text-gold-gradient">CAC</span> with the record.</>} />
            <Reveal delay={120}>
              <p className="mt-6 text-stone">
                When ownership must be proven — not merely asserted — courts, counsel and families call CAC. Four principles govern every engagement we accept.
              </p>
            </Reveal>
          </div>
  
          {/* 4 Core principles */}
          <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {WHY_PRINCIPLES.map((p, i) => (
              <Reveal key={p.k} delay={i * 90}>
                <div className="plate plate-hover corner-ticks group relative flex h-full flex-col overflow-hidden rounded-lg">
                  <div className="media-clip media-fade relative h-44 w-full overflow-hidden">
                    <img
                      src={PRINCIPLE_IMAGES[i].img}
                      alt={PRINCIPLE_IMAGES[i].alt}
                      className="h-full w-full object-cover transition duration-700 group-hover:scale-105"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-navy-2 via-navy-2/40 to-transparent" />
                    <span className="absolute top-3 right-3 font-mono text-[11px] font-bold text-gold-2 bg-navy/80 px-2.5 py-1 rounded border border-gold-2/30 backdrop-blur">
                      0{i + 1}
                    </span>
                  </div>
                  <div className="flex flex-1 flex-col p-6">
                    <h2 className="font-display text-2xl leading-snug text-ivory">{p.k}</h2>
                    <div className="mt-3 h-px w-10 hairline" />
                    <p className="mt-4 text-sm leading-relaxed text-stone">{p.d}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
  
          {/* Mission commitments (6) */}
          <div className="mt-16">
            <Reveal>
              <p className="font-mono text-[11px] uppercase tracking-wide-2 text-gold-2/70">// What the mission commits us to</p>
            </Reveal>
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {MISSION_POINTS.map((m, i) => (
                <Reveal key={m.k} delay={i * 70}>
                  <div className="plate plate-hover flex h-full flex-col rounded-lg p-5">
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border border-gold-2/40 font-mono text-[10px] text-gold-2">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <p className="font-display text-lg leading-snug text-ivory">{m.k}</p>
                    </div>
                    <p className="mt-3 text-sm leading-relaxed text-stone">{m.d}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
  
          {/* Operating standards (6) */}
          <div className="mt-20">
            <Heading eyebrow="Operating standards" title={<>How the consultancy holds itself.</>} />
            <Reveal delay={120}>
              <div className="mt-6">
                <Tag>Uncover The Truth · Protect Your Legacy</Tag>
              </div>
              <p className="mt-4 max-w-2xl text-stone">
                Begin with a confidential briefing. We will scope the investigation, outline the registry trail, and tell you — plainly — what the record can prove.
              </p>
            </Reveal>
            <div className="mt-8 grid gap-px overflow-hidden rounded-lg border border-gold-2/15 bg-gold-2/10 sm:grid-cols-2 lg:grid-cols-3">
              {STANDARDS.map((s, i) => (
                <Reveal key={s.k} delay={(i % 3) * 80}>
                  <div className="group flex h-full items-start gap-4 bg-navy-2/70 p-6 transition hover:bg-navy-3/60">
                    <img
                      src={s.img}
                      alt={s.k}
                      className="h-14 w-14 shrink-0 rounded-md object-cover border border-gold-2/30 shadow-md transition group-hover:border-gold-2 group-hover:scale-105"
                    />
                    <div>
                      <p className="font-mono text-[10px] uppercase tracking-wide-2 text-gold-2/70">0{i + 1}</p>
                      <h3 className="font-display text-lg text-ivory">{s.k}</h3>
                      <p className="mt-1 text-sm text-stone">{s.d}</p>
                    </div>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
  
          {/* Frequently asked questions */}
          <div className="mt-20">
            <Heading eyebrow="Frequently asked" title={<>Questions we are<br />asked before a file opens.</>} />
            <div className="mt-10 grid gap-4 lg:grid-cols-2">
              {FAQ.map((f, i) => (
                <Reveal key={f.q} delay={i * 80}>
                  <div className="plate plate-hover flex h-full flex-col rounded-lg p-6">
                    <div className="flex items-start gap-3">
                      <Icon name="chevron-right" size={16} className="mt-1 shrink-0 text-gold-2" />
                      <h3 className="font-display text-xl leading-snug text-ivory">{f.q}</h3>
                    </div>
                    <p className="mt-4 border-t border-gold-2/10 pt-4 text-sm leading-relaxed text-stone">{f.a}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
