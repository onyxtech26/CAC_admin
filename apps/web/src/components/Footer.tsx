import { useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "./Icon";
import { LogoMark } from "./ui";
import { CONTACT, NAV, SERVICES, TAGLINES, waLink } from "../data";
import { AddressModal } from "./AddressModal";
import { staffEntryProps } from "../staff-entry";

export default function Footer() {
  const [showAddressModal, setShowAddressModal] = useState(false);

  return (
    <footer className="relative overflow-hidden border-t border-gold-2/15 bg-ink">
      <div className="pointer-events-none absolute inset-0 bg-grid-fine opacity-40" />
      <div className="pointer-events-none absolute -top-32 left-1/3 h-72 w-[44rem] rounded-full blur-3xl glow-gold" />

      {/* Columns */}
      <div className="relative mx-auto grid max-w-[1320px] grid-cols-1 gap-10 px-5 py-16 sm:grid-cols-2 lg:grid-cols-12 lg:px-8">
        <div className="lg:col-span-4">
          <div className="flex items-center gap-3">
            <LogoMark size={50} />
            <div>
              <p className="font-display text-base font-bold leading-tight text-ivory">CONGLOMERATE APPRAISAL<br />CONSULTANCY</p>
              <p className="font-mono text-[9px] uppercase tracking-wide-2 text-gold-2/70">Property Forensic Consultation</p>
            </div>
          </div>
          <p className="mt-5 max-w-sm text-sm leading-relaxed text-stone">
            An independent Malaysian property forensic consultancy converting registry records, colonial grants and probate archives into documentary evidence.
          </p>
          <p className="mt-5 font-display text-lg italic text-gold-gradient">"{TAGLINES[1]}"</p>
          <div className="mt-6 flex items-center gap-3">
            {[
              { n: "linkedin", href: "#" },
              { n: "tiktok", href: CONTACT.tiktokUrl },
              { n: "whatsapp", href: waLink() },
              { n: "mail", href: `mailto:${CONTACT.email}` },
            ].map((s) => (
              <a
                key={s.n}
                href={s.href}
                target="_blank"
                rel="noreferrer"
                className="grid h-10 w-10 place-items-center rounded-full border border-gold-2/25 text-gold-2/80 transition hover:border-gold-2 hover:bg-gold-2/10 hover:text-gold-2"
              >
                <Icon name={s.n} size={18} />
              </a>
            ))}
          </div>
        </div>

        <div className="lg:col-span-2">
          <p className="font-mono text-[11px] uppercase tracking-wide-2 text-gold-2/70">Navigate</p>
          <ul className="mt-5 space-y-3 text-sm">
            {/* The literal "HOME" CAC asked for: a double-click opens the staff login.
                A convenience, not a control — see src/staff-entry.ts. */}
            <li>
              <Link
                to="/"
                className="text-stone transition hover:text-gold-2"
                {...staffEntryProps()}
              >
                Home
              </Link>
            </li>
            {NAV.map((n) => (
              <li key={n.to}><Link to={n.to} className="text-stone transition hover:text-gold-2">{n.label}</Link></li>
            ))}
          </ul>
        </div>

        <div className="lg:col-span-3">
          <p className="font-mono text-[11px] uppercase tracking-wide-2 text-gold-2/70">Core Disciplines</p>
          <ul className="mt-5 grid grid-cols-1 gap-2.5 text-sm sm:grid-cols-1">
            {SERVICES.map((s) => (
              <li key={s.id}>
                <Link to={`/services/${s.id}`} className="group flex items-center gap-2 text-stone transition hover:text-gold-2">
                  <span className="font-mono text-[10px] text-gold-2/50">{s.no}</span>
                  <span className="truncate">{s.title}</span>
                </Link>
              </li>
            ))}
            <li><Link to="/services" className="text-gold-2/90 hover:text-gold-2">View all services →</Link></li>
          </ul>
        </div>

        <div className="lg:col-span-3">
          <p className="font-mono text-[11px] uppercase tracking-wide-2 text-gold-2/70">Headquarters</p>
          <ul className="mt-5 space-y-4 text-sm text-stone">
            <li className="flex gap-3">
              <Icon name="pin" size={18} className="mt-0.5 shrink-0 text-gold-2" />
              <button
                type="button"
                onClick={() => setShowAddressModal(true)}
                className="text-left cursor-pointer transition hover:text-gold-2"
              >
                {CONTACT.address}
              </button>
            </li>
            <li className="flex gap-3">
              <Icon name="phone" size={18} className="mt-0.5 shrink-0 text-gold-2" />
              <div className="flex flex-col gap-1">
                <a href={waLink()} target="_blank" rel="noreferrer" className="hover:text-gold-2">
                  {CONTACT.phoneDisplay} <span className="font-mono text-[10px] text-gold-2/70">(WhatsApp)</span>
                </a>
                <a href={`tel:+${CONTACT.officePhoneRaw}`} className="hover:text-gold-2">
                  {CONTACT.officePhoneDisplay} <span className="font-mono text-[10px] text-mute">(Office)</span>
                </a>
              </div>
            </li>
            <li className="flex gap-3">
              <Icon name="mail" size={18} className="mt-0.5 shrink-0 text-gold-2" />
              <a href={`mailto:${CONTACT.email}`} className="break-all hover:text-gold-2">{CONTACT.email}</a>
            </li>
            <li className="flex gap-3">
              <Icon name="clock" size={18} className="mt-0.5 shrink-0 text-gold-2" />
              <span>Mon – Fri · 09:00 – 18:00</span>
            </li>
          </ul>
        </div>
      </div>

      {/* Bottom bar */}
      <div className="relative border-t border-gold-2/10">
        <div className="mx-auto flex max-w-[1320px] flex-col items-center justify-between gap-4 px-5 py-6 text-xs text-mute sm:flex-row lg:px-8">
          <p>© {new Date().getFullYear()} Conglomerate Appraisal Consultancy (CAC). Est. 2009. All rights reserved.</p>
          <p className="flex items-center gap-2 font-mono uppercase tracking-wide-2">
            Powered by
            <a href={CONTACT.techPartnerUrl} target="_blank" rel="noreferrer" className="text-gold-2 hover:underline">{CONTACT.techPartner}</a>
            <span className="text-gold-2/40">·</span>
            <span>{CONTACT.site}</span>
          </p>
        </div>
      </div>

      <AddressModal isOpen={showAddressModal} onClose={() => setShowAddressModal(false)} />
    </footer>
  );
}
