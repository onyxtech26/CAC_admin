import { useEffect, useRef, useState } from "react";

/**
 * Redaction reveal — the text sits under a gold bar that retracts to the right
 * when it enters view, "declassifying" it.
 *
 * Used once, on the process page heading. Applied to every stage it stops
 * reading as a device and becomes a tic, and it slows the reader down on
 * content they actually need.
 */
export function Redact({ children, delay = 0 }: { children: string; delay?: number }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          const t = window.setTimeout(() => setRevealed(true), delay);
          io.disconnect();
          return () => window.clearTimeout(t);
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);

    // never leave the text sitting under the bar if the observer never fires
    const fallback = window.setTimeout(() => setRevealed(true), 2000 + delay);

    return () => {
      io.disconnect();
      window.clearTimeout(fallback);
    };
  }, [delay]);

  return (
    <span ref={ref} className="redact" data-revealed={revealed}>
      {children}
    </span>
  );
}
