import { useEffect, useRef } from "react";
import { Icon } from "./Icon";
import { CONTACT } from "../data";

interface AddressModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Directions to the office.
 *
 * It looked like a dialog and was not one. No `role`, no `aria-modal`, no accessible name, and focus
 * was never moved into it or kept there — so Escape closed it, and Tab walked the page underneath an
 * opaque overlay, reading out links nobody could see. A screen reader was never told a dialog had
 * opened at all.
 *
 * What makes it a dialog now: the role and the name, focus moved in on open and returned to whatever
 * opened it on close, and Tab wrapped inside. The trap is written out rather than pulled from a
 * library because it is fifteen lines and the site has no other modal.
 */
export function AddressModal({ isOpen, onClose }: AddressModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  const openedBy = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    openedBy.current = document.activeElement as HTMLElement | null;

    const focusable = () =>
      Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );

    // Into the dialog, not merely near it.
    focusable()[0]?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const items = focusable();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;

      // Wrap at both ends. Without this, Tab leaves the dialog and lands on the page behind it.
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
      // Back where they were. Losing focus to the top of the document is how a keyboard user ends up
      // tabbing through the whole page again to get back to where they were.
      openedBy.current?.focus();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const encodedAddress = encodeURIComponent(CONTACT.address);
  const googleMapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodedAddress}`;
  const wazeUrl = `https://waze.com/ul?q=${encodedAddress}&navigate=yes`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop. Not focusable and not announced: it is a click target, and the dialog's own close
          button is the accessible way out. */}
      <div
        className="fixed inset-0 bg-navy/80 backdrop-blur-md transition-opacity duration-300 animate-in fade-in"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal Card */}
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="address-modal-title"
        className="relative w-full max-w-md overflow-hidden rounded-xl border border-gold-2/40 bg-gradient-to-b from-navy-2 via-navy to-ink p-6 shadow-[0_25px_60px_-15px_rgba(0,0,0,0.95)] transition-all duration-300 animate-in zoom-in-95 sm:p-8"
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-full text-mute transition hover:bg-gold-2/10 hover:text-gold-2"
          aria-label="Close the directions"
        >
          <Icon name="close" size={18} />
        </button>

        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-full border border-gold-2/40 bg-gold-2/10 text-gold-2">
            <Icon name="compass-pin" size={22} />
          </span>
          <div>
            <h3 id="address-modal-title" className="font-display text-xl text-ivory">
              Get Directions
            </h3>
            <p className="font-mono text-[11px] uppercase tracking-wide-2 text-gold-2/70">
              Select Navigation App
            </p>
          </div>
        </div>

        <div className="mt-5 rounded-md border border-gold-2/20 bg-navy/70 p-4 text-xs text-sand">
          <div className="flex items-start gap-2.5">
            <Icon name="pin" size={16} className="mt-0.5 shrink-0 text-gold-2" />
            <p className="leading-relaxed">{CONTACT.address}</p>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          <a
            href={googleMapsUrl}
            target="_blank"
            rel="noreferrer"
            onClick={onClose}
            className="sheen-host flex items-center justify-center gap-3 rounded-md border border-gold-2/30 bg-navy-3/80 px-4 py-3.5 text-sm font-semibold text-ivory transition duration-200 hover:border-gold-2 hover:bg-gold-2/15 hover:text-gold-2 shadow-md group"
          >
            <Icon name="google-maps" size={20} className="text-gold-2 transition-transform duration-200 group-hover:scale-110" />
            <span>Google Maps</span>
          </a>

          <a
            href={wazeUrl}
            target="_blank"
            rel="noreferrer"
            onClick={onClose}
            className="sheen-host flex items-center justify-center gap-3 rounded-md border border-gold-2/30 bg-navy-3/80 px-4 py-3.5 text-sm font-semibold text-ivory transition duration-200 hover:border-gold-2 hover:bg-gold-2/15 hover:text-gold-2 shadow-md group"
          >
            <Icon name="waze" size={20} className="text-gold-2 transition-transform duration-200 group-hover:scale-110" />
            <span>Waze</span>
          </a>
        </div>
      </div>
    </div>
  );
}
