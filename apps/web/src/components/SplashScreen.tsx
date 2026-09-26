import { useCallback, useEffect, useState } from "react";
import { LogoMark } from "./ui";

/**
 * Two-beat splash: a fingerprint draws itself ridge by ridge, then the CAC logo
 * fades in over it.
 *
 * The print is a whorl, generated from a phase field rather than drawn as a
 * stack of shapes. Ridges are the level sets of
 *
 *     psi(p) = rho(p) * N + theta(p) / 2pi
 *
 * where rho is an egg-shaped radius about the core and theta is the angle about
 * it. The theta term is what matters: without it the level sets are closed
 * rings and the thing reads as a target or tree rings. Adding one turn of angle
 * per ridge makes every level set join onto the next, so the whole print is a
 * single spiral that unwinds from the core — which is what skin actually does.
 *
 * Because psi is closed-form, each ridge solves directly for r at a given
 * angle, so these are exact curves rather than traced contours.
 *
 * Ridge pitch is tuned for the rendered size: denser reads better on paper but
 * aliases into mush at 86px, so N sits at 11 rather than the ~14 a print this
 * shape would really carry.
 */

/** Unchanged from the previous print, so the on-screen size is identical. */
const VIEW_W = 100;
const VIEW_H = 108;

/* ---------- finger-pad outline ---------- */
const OUT_CX = 50;
const OUT_CY = 54;
const OUT_RX = 37;
const OUT_RY = 50;

/** Egg, not ellipse: pulled in at the bottom, a shade fuller at the top. */
const outlineRadius = (rad: number) =>
  OUT_RX * (1 - 0.15 * Math.max(0, Math.sin(rad))) * (1 + 0.04 * Math.max(0, -Math.sin(rad)));

const OUTLINE = (() => {
  const pts: string[] = [];
  for (let d = 0; d < 360; d += 3) {
    const r = (d * Math.PI) / 180;
    pts.push(
      `${(OUT_CX + outlineRadius(r) * Math.cos(r)).toFixed(2)} ${(OUT_CY + OUT_RY * Math.sin(r)).toFixed(2)}`
    );
  }
  return `M ${pts.join(" L ")} Z`;
})();

/* ---------- the whorl ---------- */
/** Core sits low and a little left, as it does on a real pad. */
const CORE_X = 46;
const CORE_Y = 74;

/** Ridges per unit radius — the pitch of the print. */
const N = 11;
/** Enough turns to carry the outer ridges past the outline and be clipped. */
const TURNS = 20;

/** Semi-axes about the core. y is down, so the upward reach is the -sin side. */
const axisX = (t: number) => 40 + 4 * Math.cos(t);
const axisY = (t: number) => 52 - 20 * Math.sin(t);
/** Slight 2-lobe skew so the print is not mirror-symmetric. */
const skew = (t: number) => 1 + 0.06 * Math.sin(2 * t + 0.8);

/** One turn of the spiral: solve psi = k for r at each angle. */
function ridgePath(k: number) {
  const STEPS = 240;
  const pts: string[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const t = -Math.PI + (2 * Math.PI * i) / STEPS;
    const r = (k - t / (2 * Math.PI)) / (N * skew(t));
    pts.push(
      `${(CORE_X + axisX(t) * r * Math.cos(t)).toFixed(2)} ${(CORE_Y + axisY(t) * r * Math.sin(t)).toFixed(2)}`
    );
  }
  return `M ${pts.join(" L ")}`;
}

/* Timing carried over verbatim, so the beat of the animation is unchanged. */
const RIDGE_MS = 1300;
const RIDGE_STAGGER = Math.round(1000 / (TURNS - 1)); // last ridge still lands at ~2300ms

const PATHS = Array.from({ length: TURNS }, (_, i) => ({
  d: ridgePath(i + 1),
  ms: RIDGE_MS,
  delay: i * RIDGE_STAGGER,
}));

const PRINT_DONE_MS = Math.max(...PATHS.map((p) => p.delay + p.ms));

const BEAT_PAUSE_MS = 300;
const LOGO_HOLD_MS = 1900;
const FADE_MS = 700;

const PRINT_SIZE = 86;

/**
 * The logo artwork is 992x664 inside a square box, so `contain` fits it by
 * width and it renders at only two thirds of the box height — at the old 90 it
 * came out 60px tall against an 86px print, which is why the second beat looked
 * smaller than the first. 128 puts its rendered height at ~86, matching the
 * print, so the two beats read as the same size.
 */
const LOGO_SIZE = 128;

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
          {/* Clipping to the pad is what breaks the outer ridges against the
              edge instead of letting them close into clean ovals. */}
          <clipPath id="cac-print-pad">
            <path d={OUTLINE} />
          </clipPath>
        </defs>

        <g clipPath="url(#cac-print-pad)">
          {PATHS.map((p, i) => (
            <path
              key={i}
              d={p.d}
              pathLength={1}
              stroke="url(#cac-print-gold)"
              strokeWidth={1.5}
              className="print-ridge"
              style={{ animationDuration: `${p.ms}ms`, animationDelay: `${p.delay}ms` }}
            />
          ))}
        </g>
      </svg>

      {/* one gold pass down the print as it develops */}
      <span className="pointer-events-none absolute inset-0 overflow-hidden">
        <span className="print-scan absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-gold-2 to-transparent shadow-[0_0_12px_2px_rgba(233,199,102,0.45)]" />
      </span>
    </span>
  );
}

export default function SplashScreen() {
  // Plays on every load, by request — no sessionStorage gate.
  const [visible, setVisible] = useState(true);
  // Readers who ask for reduced motion skip the draw and open on the logo.
  const [reduced] = useState(
    () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  const [showLogo, setShowLogo] = useState(false);
  const [fading, setFading] = useState(false);

  /**
   * Anything dismisses it.
   *
   * Five seconds is not long unless you are trying to read something, on a slow connection, for the
   * fourth time today, or with a screen reader that has just met a full-screen overlay it cannot get
   * past. Reduced motion already shortened it, which was the right instinct and only covered the
   * people who had thought to set that preference. A click, a tap or any key now ends it — no button
   * to find, which is the point.
   */
  const dismiss = useCallback(() => {
    setFading(true);
    setTimeout(() => setVisible(false), 400);
  }, []);

  useEffect(() => {
    if (!visible) return;

    const onKey = (event: KeyboardEvent) => {
      // Not a modifier on its own: somebody pressing Shift to type is not asking to skip.
      if (event.key === "Shift" || event.key === "Control" || event.key === "Alt") return;
      dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, dismiss]);

  useEffect(() => {
    if (!visible) return;

    const printMs = reduced ? 0 : PRINT_DONE_MS + BEAT_PAUSE_MS;
    const holdMs = reduced ? 900 : LOGO_HOLD_MS;

    const logoTimer = setTimeout(() => setShowLogo(true), printMs);
    const fadeTimer = setTimeout(() => setFading(true), printMs + holdMs);
    const hideTimer = setTimeout(() => setVisible(false), printMs + holdMs + FADE_MS);

    return () => {
      clearTimeout(logoTimer);
      clearTimeout(fadeTimer);
      clearTimeout(hideTimer);
    };
  }, [visible, reduced]);

  if (!visible) return null;

  return (
    <div
      onClick={dismiss}
      // Presentational: the page behind it carries the content and its own heading, and a screen
      // reader should be reading that rather than an animation. It is also why the wordmark below is
      // no longer an <h1> — it used to be a second one, competing with every page's real heading.
      aria-hidden="true"
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
            <LogoMark size={LOGO_SIZE} className="anim-float" />
            {showLogo && (
              <span
                className="absolute inset-0 rounded-full border border-gold-2/40"
                style={{ animation: "pulse-ring 2.5s ease-out infinite" }}
              />
            )}
          </div>
        </div>

        <p
          className="splash-line mt-6 font-display text-2xl font-bold tracking-wider text-ivory sm:text-3xl"
          data-on={showLogo}
          style={{ transitionDelay: showLogo ? "120ms" : "0ms" }}
        >
          CONGLOMERATE APPRAISAL
        </p>
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
