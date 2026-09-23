import { useEffect, useRef, useState, type ReactNode } from "react";

/* ---------------- Reveal on scroll ---------------- */
export function Reveal({
  children,
  className = "",
  delay = 0,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  as?: any;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            setShown(true);
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -8% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <Tag
      ref={ref as any}
      className={`reveal ${shown ? "in" : ""} ${className}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </Tag>
  );
}

/* ---------------- Animated counter ---------------- */
export function Counter({
  to,
  suffix = "",
  duration = 1600,
  className = "",
}: {
  to: number;
  suffix?: string;
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [val, setVal] = useState(0);
  const started = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting && !started.current) {
          started.current = true;
          const start = performance.now();
          const tick = (now: number) => {
            const p = Math.min(1, (now - start) / duration);
            const eased = 1 - Math.pow(1 - p, 3);
            setVal(Math.round(eased * to));
            if (p < 1) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }
      });
    }, { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, [to, duration]);
  return (
    <span ref={ref} className={className}>
      {val.toLocaleString()}
      {suffix}
    </span>
  );
}

/* ---------------- Brand logo mark ---------------- */
export function LogoMark({ size = 44, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`relative inline-flex items-center justify-center ${className}`}>
      <img
        src="/assets/logo.webp"
        alt="CAC Logo"
        style={{ width: size, height: size, objectFit: "contain" }}
        className="shrink-0 brightness-110 drop-shadow-[0_2px_10px_rgba(233,199,102,0.3)]"
      />
    </span>
  );
}

/* ---------------- Eyebrow / label ---------------- */
export function Eyebrow({ children, className = "", light = false }: { children: ReactNode; className?: string; light?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-3 font-mono text-[11px] uppercase tracking-wide-2 ${light ? "text-gold-3" : "text-gold-2"} ${className}`}>
      <span className={`h-px w-8 ${light ? "bg-gold-3/60" : "bg-gold-2/60"}`} />
      {children}
    </span>
  );
}

/* ---------------- Section heading ---------------- */
export function Heading({
  eyebrow,
  title,
  italic,
  className = "",
  light = false,
  as: Tag = "h2",
}: {
  eyebrow?: string;
  title: ReactNode;
  italic?: string;
  className?: string;
  light?: boolean;
  /** the lead heading on a page should be "h1"; section headings stay "h2" */
  as?: "h1" | "h2";
}) {
  return (
    <div className={className}>
      {eyebrow && <Eyebrow light={light}>{eyebrow}</Eyebrow>}
      <Tag className={`mt-5 font-display text-4xl sm:text-5xl lg:text-[3.4rem] leading-[1.04] ${light ? "text-navy-3" : "text-ivory"}`}>
        {title}
        {italic && <span className={`block italic mt-1 ${light ? "text-gold-gradient-dark" : "text-gold-gradient"}`}>{italic}</span>}
      </Tag>
      <div className={`mt-6 h-px w-full max-w-[140px] ${light ? "hairline-dark" : "hairline"}`} />
    </div>
  );
}

/* ---------------- Marquee strip ---------------- */
export function Marquee({ items }: { items: string[] }) {
  // The track translates by -50%, so one half must be at least as wide as the
  // viewport or a gap opens mid-loop. Four copies keeps that true on ultrawide.
  const row = [...items, ...items, ...items, ...items];
  return (
    <div className="marquee-strip relative overflow-hidden bg-gradient-to-b from-ink via-navy-2 to-ink py-5">
      {/* Gradient hairlines instead of flat 1px borders — they read as an
          engraved channel rather than a boxed-in strip. */}
      <span className="pointer-events-none absolute inset-x-0 top-0 h-px hairline" />
      <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px hairline" />
      <div className="marquee-track flex w-max items-center gap-14 whitespace-nowrap">
        {row.map((t, i) => (
          <span key={i} className="flex items-center gap-14 font-mono text-[12px] font-bold uppercase tracking-wide-2 text-gold-2">
            {t}
            {/* Same rotated diamond used between the hero creed phrases, so the
                two strips read as one design language. */}
            <span className="h-1.5 w-1.5 shrink-0 rotate-45 bg-gold-2/55" />
          </span>
        ))}
      </div>
    </div>
  );
}

/* ---------------- Gold chip / tag ---------------- */
export function Tag({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border border-gold-2/30 bg-gold-2/5 px-3 py-1 font-mono text-[10px] uppercase tracking-wide-2 text-gold-2 ${className}`}>
      {children}
    </span>
  );
}
