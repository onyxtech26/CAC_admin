import { useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Eyebrow, Heading, Reveal } from "../components/ui";
import { CONTACT, TEAM, waLink } from "../data";
import { Seo } from "../components/Seo";
import { AddressModal } from "../components/AddressModal";

export default function Contact() {
  const [showAddressModal, setShowAddressModal] = useState(false);

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
                        {/* Roles run from two words to a full title, so this slot
                            reserves two lines. Without it a wrapped role steps its
                            own name down and the three names lose their shared
                            baseline across the row. */}
                        <div className="flex min-h-[2.1rem] items-start">
                          <Eyebrow>{m.role}</Eyebrow>
                        </div>
                        <h2 className="mt-2 font-display text-3xl text-ivory">{m.name}</h2>
                        {/* Justified for flush left and right edges. In a column
                            this narrow justification alone opens rivers of white
                            space, so hyphenation is on to let long words break and
                            keep the word spacing even. */}
                        <div className="mt-3 space-y-3 hyphens-auto text-justify text-sm leading-relaxed text-stone">
                          {m.blurb.map((para, k) => (
                            <p key={k}>{para}</p>
                          ))}
                        </div>
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
                    {
                      g: "phone",
                      k: "Phone / WhatsApp",
                      customContent: (
                        <div className="mt-1 flex flex-col gap-1 text-sm text-sand">
                          <a href={waLink()} target="_blank" rel="noreferrer" className="block hover:text-gold-2">
                            {CONTACT.phoneDisplay} <span className="font-mono text-[10px] text-gold-2/70">(WhatsApp)</span>
                          </a>
                          <a href={`tel:+${CONTACT.officePhoneRaw}`} className="block hover:text-gold-2">
                            {CONTACT.officePhoneDisplay} <span className="font-mono text-[10px] text-mute">(Office)</span>
                          </a>
                        </div>
                      ),
                    },
                    { g: "mail", k: "Email", v: CONTACT.email, href: `mailto:${CONTACT.email}` },
                    { g: "pin", k: "Headquarters", v: CONTACT.address, onClick: () => setShowAddressModal(true) },
                    { g: "clock", k: "Office Hours", v: "Mon–Fri 09:00–18:00" },
                  ].map((r) => (
                    <div key={r.k} className="plate rounded-md p-5">
                      <span className="grid h-10 w-10 place-items-center rounded-full border border-gold-2/30 text-gold-2"><Icon name={r.g} size={18} /></span>
                      <p className="mt-3 font-mono text-[10px] uppercase tracking-wide-2 text-gold-2/70">{r.k}</p>
                      {r.customContent ? (
                        r.customContent
                      ) : r.href ? (
                        <a href={r.href} target="_blank" rel="noreferrer" className="mt-1 block break-words text-sm text-sand hover:text-gold-2">{r.v}</a>
                      ) : r.onClick ? (
                        <button type="button" onClick={r.onClick} className="mt-1 block text-left break-words text-sm text-sand hover:text-gold-2 cursor-pointer">{r.v}</button>
                      ) : (
                        <p className="mt-1 text-sm text-sand">{r.v}</p>
                      )}
                    </div>
                  ))}
                </div>
              </Reveal>
            </div>
          </div>
        </div>
      </section>

      <AddressModal isOpen={showAddressModal} onClose={() => setShowAddressModal(false)} />
    </>
  );
}
