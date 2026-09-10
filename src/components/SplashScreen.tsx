import { useEffect, useState } from "react";
import { LogoMark } from "./ui";

/**
 * Two-beat splash: a fingerprint draws itself ridge by ridge, then the CAC logo
 * fades in over it.
 *
 * Built the way a loop print actually is, not as concentric arcs. Three things
 * do the work:
 *   - the ridges DRIFT rather than nest — each one sits on a slightly different
 *     centre, so they are not one shape scaled up. Perfectly concentric arcs
 *     read as a target or a letter C.
 *   - the mouths are ragged. A gap that widens linearly makes both ridge ends
 *     line up into two clean diagonals; a little jitter breaks that.
 *   - the detail sells it: a core rod at the centre, a delta on the lower left,
 *     and free-floating ridge endings sitting in the valleys.
 */

/** Taller than wide, like a finger pad. */
const VIEW_W = 100;
const VIEW_H = 108;

const RIDGE_COUNT = 10;
/** Ridge i's ellipse. Centre drifts down-right as the radii grow. */
const geom = (i: number) => ({
  rx: 5.5 + i * 4.5,
  ry: 6.5 + i * 5.0,
  cx: 47.5 + i * 0.35,
  cy: 50 + i * 0.55,
});

/** Deterministic wobble — same print on every load, no Math.random. */
const jitterR = (i: number) => 4.5 * Math.sin(i * 2.4);
const jitterL = (i: number) => 4.5 * Math.sin(i * 1.7 + 1.2);

type Arc = {
  rx: number;
  ry: number;
  cx: number;
  cy: number;
  /** degrees, SVG convention: 0 right, 90 bottom, -90 top */
  from: number;
  to: number;
  /** ridges are never truly elliptical — this waves them slightly */
  amp?: number;
  freq?: number;
  phase?: number;
  ms: number;
  delay: number;
};

function toPath(a: Arc) {
  const { rx, ry, cx, cy, from, to, amp = 0, freq = 3, phase = 0 } = a;
  const dir = to >= from ? 1 : -1;
  const step = 3 * dir;
  const at = (deg: number) => {
    const rad = (deg * Math.PI) / 180;
    const k = 1 + amp * Math.sin(freq * rad + phase);
    return `${(cx + rx * k * Math.cos(rad)).toFixed(2)} ${(cy + ry * k * Math.sin(rad)).toFixed(2)}`;
  };
  const pts: string[] = [];
  for (let d = from; dir > 0 ? d < to : d > to; d += step) pts.push(at(d));
  pts.push(at(to)); // land exactly on the end angle
  return `M ${pts.join(" L ")}`;
}

const RIDGE_MS = 1300;
const RIDGE_STAGGER = 95;

const LOOPS: Arc[] = Array.from({ length: RIDGE_COUNT }, (_, i) => {
  const g = geom(i);
  return {
    ...g,
    from: 90 - (32 + i * 1.6 + jitterR(i)),
    to: 90 + (28 + i * 1.4 + jitterL(i)) - 360,
    amp: 0.016 + (i % 3) * 0.006,
    freq: 3 + (i % 2),
    phase: i * 1.1,
    ms: RIDGE_MS,
    delay: i * RIDGE_STAGGER,
  };
});

/** The valley between ridge i and i+1 — where loose detail can sit safely. */
const valley = (i: number) => {
  const a = geom(i);
  const b = geom(i + 1);
  return {
    rx: (a.rx + b.rx) / 2,
    ry: (a.ry + b.ry) / 2,
    cx: (a.cx + b.cx) / 2,
    cy: (a.cy + b.cy) / 2,
  };
};

const DETAIL_MS = 640;

const DETAIL: Arc[] = [
  // core rod, inside the innermost recurve
  { rx: 1.4, ry: 2.8, cx: 47.5, cy: 48.5, from: -40, to: -320, ms: DETAIL_MS, delay: 300 },
  // ridge endings floating in the valleys
  { ...valley(2), from: -30, to: -74, amp: 0.02, phase: 0.6, ms: DETAIL_MS, delay: 900 },
  { ...valley(3), from: -126, to: -172, amp: 0.02, phase: 1.4, ms: DETAIL_MS, delay: 1050 },
  { ...valley(5), from: -12, to: 28, amp: 0.02, phase: 2.2, ms: DETAIL_MS, delay: 1200 },
  { ...valley(6), from: -150, to: -196, amp: 0.02, phase: 0.9, ms: DETAIL_MS, delay: 1350 },
  // delta — two short ridges diverging on the lower left
  { ...valley(7), from: 150, to: 190, amp: 0.015, phase: 0.3, ms: DETAIL_MS, delay: 1500 },
  { ...valley(8), from: 158, to: 196, amp: 0.015, phase: 0.9, ms: DETAIL_MS, delay: 1650 },
];

const ARCS: Arc[] = [...LOOPS, ...DETAIL];
const PRINT_DONE_MS = Math.max(...ARCS.map((a) => a.delay + a.ms));

const BEAT_PAUSE_MS = 300;
const LOGO_HOLD_MS = 1900;
const FADE_MS = 700;

/** Sits in the logo's 90px box; the taller aspect makes up the difference. */
const PRINT_SIZE = 86;

function Fingerprint({ size }: { size: number }) {
  const w = (size * VIEW_W) / VIEW_H;
  return (
    <span className="relative block" style={{ width: w, height: size }}>
      {/* Bloom sits under the strokes. A blur filter on the paths themselves
          would smear neighbouring ridges together at this spacing. */}
      <span className="print-glow pointer-events-none absolute -inset-6 rounded-full blur-2xl glow-gold" />

      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        width={w}
        height={size}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="relative drop-shadow-[0_0_6px_rgba(233,199,102,0.4)]"
      >
        <defs>
          <linearGradient id="cac-print-gold" x1="0" y1="0" x2="0.35" y2="1">
            <stop offset="0%" stopColor="#f4e0a4" />
            <stop offset="42%" stopColor="#e9c766" />
            <stop offset="100%" stopColor="#b3810e" />
          </linearGradient>
        </defs>

        {ARCS.map((a, i) => (
          <path
            key={i}
            d={toPath(a)}
            pathLength={1}
            stroke="url(#cac-print-gold)"
            strokeWidth={1.5}
            className="print-ridge"
            style={{ animationDuration: `${a.ms}ms`, animationDelay: `${a.delay}ms` }}
          />
        ))}
      </svg>

      {/* one gold pass down the print as it develops */}
      <span className="pointer-events-none absolute inset-0 overflow-hidden">
        <span className="print-scan absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-gold-2 to-transparent shadow-[0_0_12px_2px_rgba(233,199,102,0.45)]" />
      </span>
    </span>
  );
}

export default function SplashScreen() {
  const [visible, setVisible] = useState(() => {
    return sessionStorage.getItem("cac_splash_shown") !== "true";
  });
  // Readers who ask for reduced motion skip the draw and open on the logo.
  const [reduced] = useState(
    () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  const [showLogo, setShowLogo] = useState(false);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (!visible) return;

    const printMs = reduced ? 0 : PRINT_DONE_MS + BEAT_PAUSE_MS;
    const holdMs = reduced ? 900 : LOGO_HOLD_MS;

    const logoTimer = setTimeout(() => setShowLogo(true), printMs);
    const fadeTimer = setTimeout(() => setFading(true), printMs + holdMs);
    const hideTimer = setTimeout(() => {
      setVisible(false);
      sessionStorage.setItem("cac_splash_shown", "true");
    }, printMs + holdMs + FADE_MS);

    return () => {
      clearTimeout(logoTimer);
      clearTimeout(fadeTimer);
      clearTimeout(hideTimer);
    };
  }, [visible, reduced]);

  if (!visible) return null;

  return (
    <div
      className={`fixed inset-0 z-[100] flex flex-col items-center justify-center bg-ink transition-opacity duration-700 ${
        fading ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
    >
      {/* Ambient glows are held back until the logo beat so the print develops
          against a clean ground. */}
      <div
        className="pointer-events-none absolute h-96 w-96 rounded-full blur-3xl anim-float-slow glow-gold transition-opacity duration-700"
        style={{ opacity: showLogo ? 1 : 0 }}
      />
      <div
        className="pointer-events-none absolute h-[30rem] w-[30rem] rounded-full blur-3xl glow-gold transition-opacity duration-700"
        style={{ opacity: showLogo ? 1 : 0 }}
      />

      <div className="relative z-10 flex flex-col items-center px-5 text-center">
        {/* Both beats share one grid cell, so the swap cross-fades in place. */}
        <div className="grid place-items-center">
          <div className="splash-beat splash-print" data-on={!showLogo}>
            <Fingerprint size={PRINT_SIZE} />
          </div>

          <div className="splash-beat splash-logo relative grid place-items-center" data-on={showLogo}>
            <LogoMark size={90} className="anim-float" />
            {showLogo && (
              <span
                className="absolute inset-0 rounded-full border border-gold-2/40"
                style={{ animation: "pulse-ring 2.5s ease-out infinite" }}
              />
            )}
          </div>
        </div>

        <h1
          className="splash-line mt-6 font-display text-2xl font-bold tracking-wider text-ivory sm:text-3xl"
          data-on={showLogo}
          style={{ transitionDelay: showLogo ? "120ms" : "0ms" }}
        >
          CONGLOMERATE APPRAISAL
        </h1>
        <p
          className="splash-line mt-2 font-mono text-[11px] uppercase tracking-[0.3em] text-gold-2/90"
          data-on={showLogo}
          style={{ transitionDelay: showLogo ? "220ms" : "0ms" }}
        >
          PROPERTY FORENSIC CONSULTATION
        </p>

        <div
          className="splash-line mt-6 h-0.5 w-36 overflow-hidden rounded-full bg-navy-2"
          data-on={showLogo}
          style={{ transitionDelay: showLogo ? "300ms" : "0ms" }}
        >
          <div className="splash-sweep h-full w-full bg-gradient-to-r from-gold-3 via-gold-2 to-gold-3" />
        </div>
      </div>
    </div>
  );
}
