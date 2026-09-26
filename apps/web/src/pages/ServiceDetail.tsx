import { Link, useParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Eyebrow, Reveal, Tag } from "../components/ui";
import { SERVICES, waLink } from "../data";
import { Seo } from "../components/Seo";

export default function ServiceDetail() {
  const { serviceId } = useParams();
  const idx = SERVICES.findIndex((s) => s.id === serviceId);
  if (idx === -1) {
    return (
      <>
        {/* This panel used to emit no metadata at all, so the tab kept whatever title the previous
            route had left and a crawler was free to index a nonexistent discipline. */}
        <Seo
          title="Discipline not found · CAC"
          description="That discipline is not in the current catalogue."
          path={`/services/${serviceId ?? ""}`}
          noindex
        />
      <section className="grid min-h-[70vh] place-items-center px-5 pt-32 text-center">
        <div>
          <Icon name="magnifier-house" size={56} className="mx-auto text-gold-2/50" />
          <h1 className="mt-6 font-display text-4xl text-ivory">Discipline not found</h1>
          <p className="mt-3 text-stone">The dossier you requested is not in our current catalogue.</p>
          <Link to="/services" className="gold-btn mt-6 inline-flex items-center gap-2 rounded-sm px-6 py-3 text-[12px] uppercase">
            Back to Services <Icon name="arrow" size={16} />
          </Link>
        </div>
      </section>
      </>
    );
  }
  const s = SERVICES[idx];

  return (
    <>
    <Seo title={s.title} description={s.short} path={`/services/${s.id}`} />
    <section className="relative pt-32 pb-24 lg:pt-40">
      <div className="pointer-events-none absolute inset-0 bg-grid opacity-40" />
      <div className="pointer-events-none absolute inset-0 bg-radial-navy" />
      <div className="relative mx-auto max-w-[1200px] px-5 lg:px-8">
        <nav className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-wide-2 text-mute">
          <Link to="/" className="hover:text-gold-2">Home</Link>
          <Icon name="chevron-right" size={12} className="text-gold-2/60" />
          <Link to="/services" className="hover:text-gold-2">Services</Link>
          <Icon name="chevron-right" size={12} className="text-gold-2/60" />
          <span className="text-gold-2">{s.title}</span>
        </nav>

        <div className="mt-8">
          <div>
            <Reveal>
              <div className="relative mb-6 h-56 w-full overflow-hidden rounded-xl border border-gold-2/25 shadow-2xl">
                <img src={s.img} alt={s.title} className="h-full w-full object-cover" />
                <div className="absolute inset-0 bg-gradient-to-t from-navy-2 via-navy-2/50 to-transparent" />
                <div className="absolute bottom-4 left-4 right-4 flex items-center justify-between">
                  <Tag>{s.accent}</Tag>
                  <span className="font-mono text-[11px] uppercase tracking-wide-2 text-gold-2">Discipline {s.no} / {SERVICES.length}</span>
                </div>
              </div>
              <h1 className="font-display text-4xl leading-tight text-ivory sm:text-5xl">{s.title}</h1>
            </Reveal>

            <Reveal delay={100}>
              <p className="mt-7 font-display text-xl italic leading-relaxed text-gold-2/90">"{s.short}"</p>
            </Reveal>

            <Reveal delay={140}>
              <div className="mt-8">
                <Eyebrow>Investigation scope</Eyebrow>
                <p className="mt-4 text-stone">{s.scope}</p>
              </div>
            </Reveal>

            <Reveal delay={180}>
              <div className="mt-10">
                <Eyebrow>Deliverables · {s.deliverables.length}-point checklist</Eyebrow>
                <ol className="mt-5 space-y-3">
                  {s.deliverables.map((d, i) => (
                    <li key={i} className="plate flex items-start gap-4 rounded-md p-4">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-gold-2/40 font-mono text-[11px] text-gold-2">{i + 1}</span>
                      <p className="pt-1 text-sand">{d}</p>
                      <Icon name="check" size={16} className="ml-auto mt-1 text-gold-2/70" />
                    </li>
                  ))}
                </ol>
              </div>
            </Reveal>

            <Reveal delay={220}>
              <div className="mt-10 flex flex-wrap gap-3">
                <Link to="/contact" className="gold-btn sheen-host flex items-center gap-2 rounded-sm px-6 py-3 text-[12px] uppercase">
                  Engage this discipline <Icon name="arrow" size={16} />
                </Link>
                <a href={waLink(`Hello CAC, I'd like to discuss ${s.title} (Discipline ${s.no}).`)} target="_blank" rel="noreferrer" className="ghost-btn flex items-center gap-2 rounded-sm px-6 py-3 text-[12px] uppercase">
                  <Icon name="whatsapp" size={16} /> WhatsApp about this
                </a>
              </div>
            </Reveal>
          </div>

        </div>
      </div>
    </section>
    </>
  );
}
