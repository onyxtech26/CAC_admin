import { useEffect } from "react";
import { Icon } from "./Icon";
import { CONTACT } from "../data";

interface AddressModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AddressModal({ isOpen, onClose }: AddressModalProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) {
      document.body.style.overflow = "hidden";
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const encodedAddress = encodeURIComponent(CONTACT.address);
  const googleMapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodedAddress}`;
  const wazeUrl = `https://waze.com/ul?q=${encodedAddress}&navigate=yes`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-navy/80 backdrop-blur-md transition-opacity duration-300 animate-in fade-in"
        onClick={onClose}
      />

      {/* Modal Card */}
      <div className="relative w-full max-w-md overflow-hidden rounded-xl border border-gold-2/40 bg-gradient-to-b from-navy-2 via-navy to-ink p-6 shadow-[0_25px_60px_-15px_rgba(0,0,0,0.95)] transition-all duration-300 animate-in zoom-in-95 sm:p-8">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-full text-mute transition hover:bg-gold-2/10 hover:text-gold-2"
          aria-label="Close modal"
        >
          <Icon name="close" size={18} />
        </button>

        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-full border border-gold-2/40 bg-gold-2/10 text-gold-2">
            <Icon name="compass-pin" size={22} />
          </span>
          <div>
            <h3 className="font-display text-xl text-ivory">Get Directions</h3>
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
