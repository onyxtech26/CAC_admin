import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { Icon } from "./Icon";
import { LogoMark } from "./ui";
import { CONTACT, NAV, waLink } from "../data";
import { staffEntryProps } from "../staff-entry";

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [dd, setDd] = useState(false);
  const ddRef = useRef<HTMLDivElement | null>(null);
  const loc = useLocation();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    setOpen(false);
    setDd(false);
  }, [loc.pathname]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ddRef.current && !ddRef.current.contains(e.target as Node)) setDd(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-all duration-500 ${
        scrolled
          ? "bg-navy/85 backdrop-blur-xl border-b border-gold-2/15 shadow-[0_18px_50px_-30px_rgba(0,0,0,0.9)]"
          : "bg-gradient-to-b from-navy/80 to-transparent border-b border-transparent"
      }`}
    >
      <div className="mx-auto flex max-w-[1320px] items-center justify-between gap-6 px-5 py-3.5 lg:px-8">
        {/* Brand — and the staff entrance.
            A double-click here opens the staff login. It is a convenience, not a control:
            the login is an ordinary URL and nothing about the platform's security depends
            on it being unadvertised. See src/staff-entry.ts. */}
        <Link to="/" className="group flex items-center gap-3" {...staffEntryProps()}>
          <span className="relative">
            <LogoMark size={46} />
            {/* `group-hover:glow-gold`, with no space. The space made it two classes — a bare
                `group-hover:` that does nothing and an unconditional `glow-gold` — so the halo was
                on at all times rather than on hover. */}
            <span className="absolute -inset-1 rounded-full blur-md opacity-0 transition group-hover:opacity-100 glow-gold" />
          </span>
          <span className="leading-tight">
            <span className="block font-display text-[15px] font-bold tracking-wide text-ivory">
              CONGLOMERATE APPRAISAL
              <span className="block">CONSULTANCY</span>
            </span>
            <span className="mt-1 flex items-center gap-2 font-mono text-[9px] uppercase tracking-wide-2 text-gold-2/80">
              Property Forensic Consultation
              <span className="h-px w-6 bg-gold-2/60" />
            </span>
          </span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-1 lg:flex">
          {NAV.map((n) => {
            const isHome = n.to === "/";
            return (
              <NavLink
                key={n.to}
                to={n.to}
                {...(isHome ? staffEntryProps() : {})}
                className={({ isActive }) =>
                  `group relative flex items-center gap-1.5 px-3.5 py-2 font-mono text-[12px] uppercase tracking-wide-2 transition-colors ${
                    isActive ? "text-gold-2" : "text-stone hover:text-ivory"
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    {isHome && <Icon name="home" size={14} className="text-gold-2/90 group-hover:text-gold-2" />}
                    <span>{n.label}</span>
                    <span
                      className={`absolute inset-x-3 -bottom-0.5 h-px origin-left bg-gold-2 transition-transform duration-300 ${
                        isActive ? "scale-x-100" : "scale-x-0 group-hover:scale-x-100"
                      }`}
                    />
                  </>
                )}
              </NavLink>
            );
          })}
        </nav>

        {/* CTA + mobile toggle */}
        <div className="flex items-center gap-3">
          <div ref={ddRef} className="relative hidden sm:block">
            <button
              onClick={() => setDd((v) => !v)}
              aria-expanded={dd}
              aria-controls="consultation-channels"
              className="gold-btn sheen-host flex items-center gap-2 rounded-sm px-5 py-2.5 text-[12px] uppercase"
            >
              Book Consultation
              <Icon name="chevron-down" size={14} className={`transition-transform ${dd ? "rotate-180" : ""}`} />
            </button>
            {/*
              `inert` as well as the opacity.

              The panel was hidden with `opacity-0` and `pointer-events-none`, neither of which
              removes anything from the tab order — so a keyboard user tabbing past the brand landed
              on two invisible links, on every page, with no way to tell where they were. `inert`
              takes the whole subtree out of focus and out of the accessibility tree at once, and
              `aria-expanded` on the button is what tells a screen reader the menu opened.
            */}
            <div
              id="consultation-channels"
              inert={!dd}
              className={`absolute right-0 top-[calc(100%+10px)] w-64 origin-top-right overflow-hidden rounded-md border border-gold-2/25 bg-navy-2/95 p-2 shadow-2xl backdrop-blur-xl transition-all duration-200 ${
                dd ? "pointer-events-auto translate-y-0 opacity-100" : "pointer-events-none -translate-y-2 opacity-0"
              }`}
            >
              <p className="px-3 py-2 font-mono text-[10px] uppercase tracking-wide-2 text-mute">Direct channels</p>
              <a
                href={waLink()}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-3 rounded px-3 py-2.5 text-sm text-sand transition hover:bg-gold-2/10 hover:text-gold-2"
              >
                <Icon name="whatsapp" size={18} className="text-gold-2" />
                <span>
                  <span className="block font-medium">WhatsApp Us</span>
                  <span className="block font-mono text-[10px] text-mute">{CONTACT.phoneDisplay}</span>
                </span>
              </a>
              <a
                href={`mailto:${CONTACT.email}`}
                className="flex items-center gap-3 rounded px-3 py-2.5 text-sm text-sand transition hover:bg-gold-2/10 hover:text-gold-2"
              >
                <Icon name="mail" size={18} className="text-gold-2" />
                <span>
                  <span className="block font-medium">Send an Email</span>
                  <span className="block font-mono text-[10px] text-mute">{CONTACT.email}</span>
                </span>
              </a>
            </div>
          </div>

          <button
            aria-label={open ? "Close the menu" : "Open the menu"}
            aria-expanded={open}
            aria-controls="mobile-menu"
            onClick={() => setOpen((v) => !v)}
            className="grid h-11 w-11 place-items-center rounded-sm border border-gold-2/30 text-gold-2 lg:hidden"
          >
            <Icon name={open ? "close" : "menu"} size={20} />
          </button>
        </div>
      </div>

      {/*
        Mobile drawer.

        Closed, it was `max-h-0 opacity-0` — invisible and still in the tab order, so every page put
        seven unreachable-looking links in a keyboard user's way. `inert` removes the subtree from
        focus and from the accessibility tree while it is shut.
      */}
      <div
        id="mobile-menu"
        inert={!open}
        className={`overflow-hidden border-t border-gold-2/10 bg-navy/95 backdrop-blur-xl transition-[max-height,opacity] duration-500 lg:hidden ${
          open ? "max-h-[520px] opacity-100" : "max-h-0 opacity-0"
        }`}
      >
        <nav className="mx-auto flex max-w-[1320px] flex-col gap-1 px-5 py-4">
          {NAV.map((n) => {
            const isHome = n.to === "/";
            return (
              <NavLink
                key={n.to}
                to={n.to}
                {...(isHome ? staffEntryProps() : {})}
                className={({ isActive }) =>
                  `flex items-center justify-between border-b border-white/5 py-3 font-display text-lg ${
                    isActive ? "text-gold-2" : "text-sand"
                  }`
                }
              >
                <span className="flex items-center gap-2.5">
                  {isHome && <Icon name="home" size={18} className="text-gold-2" />}
                  <span>{n.label}</span>
                </span>
                <Icon name="arrow" size={16} className="text-gold-2/60" />
              </NavLink>
            );
          })}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <a href={waLink()} target="_blank" rel="noreferrer" className="gold-btn flex items-center justify-center gap-2 rounded-sm px-4 py-3 text-[12px] uppercase">
              <Icon name="whatsapp" size={16} /> WhatsApp
            </a>
            <a href={`mailto:${CONTACT.email}`} className="ghost-btn flex items-center justify-center gap-2 rounded-sm px-4 py-3 text-[12px] uppercase">
              <Icon name="mail" size={16} /> Email
            </a>
          </div>
        </nav>
      </div>
    </header>
  );
}
