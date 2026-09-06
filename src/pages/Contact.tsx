import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Eyebrow, Heading, Reveal } from "../components/ui";
import { CONTACT, TEAM } from "../data";
import { Seo } from "../components/Seo";

export default function Contact() {
  return (
    <>
    <Seo route="/contact" />
      <section className="relative pt-32 pb-24 lg:pt-40">
        <div className="pointer-events-none absolute inset-0 bg-grid opacity-50" />
        <div className="pointer-events-none absolute inset-0 bg-radial-navy" />
  
        <div className="relative mx-auto max-w-[1320px] px-5 lg:px-8">
          <nav className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide-2 text-mute">
            <Link to="/" className="hover:text-gold-2">Home</Link>
            <Icon name="chevron-right" size={12} className="text-gold-2/60" />
            <span className="text-gold-2">Contact</span>
          </nav>
  
          <div className="mt-6 max-w-3xl">
            <Heading as="h1" eyebrow="Open a confidential file" title={<>Speak with <span className="italic text-gold-gradient">CAC.</span></>} />
            <Reveal delay={120}>
              <p className="mt-6 text-stone">
                We welcome confidential enquiries regarding property ownership, inheritance disputes, historical land investigations and asset tracing. Whether your matter involves a single family home or a complex multi-property estate, we are committed to delivering thorough, impartial and evidence-based investigations.
              </p>
            </Reveal>
          </div>
  
          {/* Consultant roster */}
          <div className="mt-14 grid gap-5 lg:grid-cols-3">
            {TEAM.map((m, i) => {
              const phoneDisplay = m.phoneDisplay ?? CONTACT.phoneDisplay;
              const phoneRaw = m.phoneRaw ?? CONTACT.phoneRaw;
              const email = m.email ?? CONTACT.email;
              const waTo = `https://wa.me/${phoneRaw}?text=${encodeURIComponent(
                `Hello CAC, I would like to speak with ${m.name} (${m.role}).`
              )}`;
              return (
                <Reveal key={m.name} delay={i * 110}>
                  <div className="corner-ticks relative flex h-full flex-col overflow-hidden rounded-xl border border-gold-2/25 bg-gradient-to-br from-navy-3 to-ink p-7 sm:p-8">
                    <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full blur-3xl glow-gold" />
                    <div className="relative flex flex-1 flex-col">
                      <div className="relative w-fit">
                        <img src={m.img} alt={m.name} className="h-24 w-24 shrink-0 rounded-full border border-gold-2/50 object-cover object-top" />
                        <span className="absolute -bottom-1 -right-1 grid h-8 w-8 place-items-center rounded-full border border-gold-2 bg-navy text-gold-2">
                          <Icon name="seal" size={16} />
                        </span>
                      </div>
                      <div className="mt-6">
                        <Eyebrow>{m.role}</Eyebrow>
                        <h2 className="mt-2 font-display text-3xl text-ivory">{m.name}</h2>
                        <p className="mt-3 text-sm leading-relaxed text-stone">{m.blurb}</p>
                      </div>
                      <div className="mt-auto flex flex-col gap-3 pt-7">
                        <a href={waTo} target="_blank" rel="noreferrer" className="gold-btn sheen-host flex items-center justify-center gap-2 rounded-sm px-5 py-3 text-[12px] uppercase">
                          <Icon name="whatsapp" size={16} /> {phoneDisplay}
                        </a>
                        <a href={`mailto:${email}`} className="ghost-btn flex items-center justify-center gap-2 rounded-sm px-5 py-3 text-[12px] uppercase">
                          <Icon name="mail" size={16} /> Email CAC
                        </a>
                      </div>
                    </div>
                  </div>
                </Reveal>
              );
            })}
          </div>
  
          {/* Main grid */}
          <div className="mt-12">
            {/* left: details */}
            <div className="space-y-8">
              <Reveal>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {[
                    { g: "phone", k: "Phone / WhatsApp", v: CONTACT.phoneDisplay, href: `tel:+${CONTACT.phoneRaw}` },
                    { g: "mail", k: "Email", v: CONTACT.email, href: `mailto:${CONTACT.email}` },
                    { g: "pin", k: "Headquarters", v: CONTACT.address },
                    { g: "clock", k: "Office Hours", v: "Mon–Fri 09:00–18:00" },
                  ].map((r) => (
                    <div key={r.k} className="plate rounded-md p-5">
                      <span className="grid h-10 w-10 place-items-center rounded-full border border-gold-2/30 text-gold-2"><Icon name={r.g} size={18} /></span>
                      <p className="mt-3 font-mono text-[10px] uppercase tracking-wide-2 text-gold-2/70">{r.k}</p>
                      {r.href ? <a href={r.href} target="_blank" rel="noreferrer" className="mt-1 block break-words text-sm text-sand hover:text-gold-2">{r.v}</a> : <p className="mt-1 text-sm text-sand">{r.v}</p>}
                    </div>
                  ))}
                </div>
              </Reveal>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
