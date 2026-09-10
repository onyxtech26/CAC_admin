import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Eyebrow, Tag } from "./ui";
import { PROCESS } from "../data";
import EvidenceChain from "./EvidenceChain";

/**
 * The investigation lifecycle as a horizontal track: the stages pan sideways as
 * the reader scrolls down, one stage per screen.
 *
 * Same mechanic as Motion's `scroll()` — a tall spacer, a sticky viewport, and a
 * flex track translated by scroll progress — written against the raw scroll
 * position rather than pulling in the library, which this project does not
 * carry. All of it is one rAF-throttled listener writing transforms directly to
 * the DOM: driving it through React state would re-render eight panels a frame.
 *
 * Falls back to the vertical <EvidenceChain> below lg and whenever reduced
 * motion is requested. Taking the page scroll hostage is a poor trade on a
 * phone, and it is the wrong answer entirely for someone who asked for less
 * movement.
 */

/** Vertical scroll spent moving from one stage to the next. */
const SCROLL_PER_PANEL_VH = 80;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function useHorizontal() {
  const [ok, setOk] = useState(() => {
    if (typeof matchMedia !== "function") return false;
    return matchMedia("(min-width: 1024px)").matches && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const wide = matchMedia("(min-width: 1024px)");
    const still = matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setOk(wide.matches && !still.matches);
    wide.addEventListener("change", sync);
    still.addEventListener("change", sync);
    // Belt and braces: some environments (and CDP viewport emulation) resize the
    // viewport without dispatching the MediaQueryList change event, which would
    // strand a phone-width window on the desktop track.
    window.addEventListener("resize", sync);
    return () => {
      wide.removeEventListener("change", sync);
      still.removeEventListener("change", sync);
      window.removeEventListener("resize", sync);
    };
  }, []);

  return ok;
}

export default function ProcessFlow() {
  const horizontal = useHorizontal();
  return horizontal ? <ProcessTrack /> : <EvidenceChain />;
}

function ProcessTrack() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const fillRef = useRef<HTMLDivElement | null>(null);
  const contentRefs = useRef<(HTMLDivElement | null)[]>([]);
  const mediaRefs = useRef<(HTMLDivElement | null)[]>([]);
  const dotRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // stages plus the closing panel
  const count = PROCESS.length + 1;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let raf = 0;

    const update = () => {
      raf = 0;
      const dist = root.offsetHeight - window.innerHeight;
      const p = dist > 0 ? clamp(-root.getBoundingClientRect().top / dist, 0, 1) : 0;

      if (trackRef.current) {
        trackRef.current.style.transform = `translate3d(${-p * (count - 1) * 100}vw, 0, 0)`;
      }
      if (fillRef.current) {
        fillRef.current.style.transform = `scaleX(${p})`;
      }

      // Position of the track in panel units — 2.4 means "just past stage 3".
      const at = p * (count - 1);
      const active = Math.round(at);

      for (let i = 0; i < count; i++) {
        // How far this panel is from centre screen, in panels.
        const d = Math.abs(at - i);
        const near = clamp(1 - d * 1.25, 0, 1);
        const content = contentRefs.current[i];
        const media = mediaRefs.current[i];
        if (content) {
          content.style.opacity = `${near}`;
          content.style.transform = `translate3d(0, ${(1 - near) * 34}px, 0)`;
        }
        if (media) {
          // Media trails the copy slightly, which reads as depth rather than
          // as one flat card sliding past.
          const m = clamp(1 - d * 1.05, 0, 1);
          media.style.opacity = `${m}`;
          media.style.transform = `translate3d(0, ${(1 - m) * -28}px, 0) scale(${0.94 + m * 0.06})`;
        }
        const dot = dotRefs.current[i];
        if (dot) dot.dataset.on = String(i === active);
      }
    };

    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [count]);

  /** Jump the page to a stage — the rail doubles as navigation. */
  const goTo = (i: number) => {
    const root = rootRef.current;
    if (!root) return;
    const dist = root.offsetHeight - window.innerHeight;
    // offsetTop would be measured against the positioned <section>, not the
    // page, so take the document position from the rect instead.
    const start = window.scrollY + root.getBoundingClientRect().top;
    window.scrollTo({ top: start + (dist * i) / (count - 1), behavior: "smooth" });
  };

  return (
    <div
      ref={rootRef}
      className="relative mt-14"
      style={{ height: `${100 + (count - 1) * SCROLL_PER_PANEL_VH}vh` }}
    >
      <div className="sticky top-0 h-screen overflow-hidden">
        <div ref={trackRef} className="flex h-full w-max will-change-transform">
          {PROCESS.map((s, i) => (
            <section
              key={s.no}
              className="flex h-screen w-screen flex-none items-center justify-center px-5 lg:px-8"
              aria-label={`Stage ${s.no}: ${s.title}`}
            >
              <div className="grid w-full max-w-[1320px] items-center gap-10 lg:grid-cols-12">
                <div
                  ref={(el) => { contentRefs.current[i] = el; }}
                  className="track-fade lg:col-span-6"
                >
                  <div className="flex items-center gap-4">
                    <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full border border-gold-2/40 bg-navy-2/60 font-mono text-[13px] font-bold text-gold-2">
                      {s.no}
                    </span>
                    <Eyebrow>{s.sub}</Eyebrow>
                  </div>

                  <h2 className="mt-6 font-display text-4xl leading-tight text-ivory xl:text-5xl">{s.title}</h2>
                  <div className="mt-5 h-px w-24 hairline" />
                  <p className="mt-6 max-w-xl text-base leading-relaxed text-stone">{s.details}</p>

                  <ul className="mt-7 grid max-w-xl gap-3 sm:grid-cols-2">
                    {s.outputs.map((o, j) => (
                      <li key={j} className="chain-output flex items-start gap-3 rounded-lg p-4">
                        <Icon name="check" size={15} className="mt-0.5 shrink-0 text-gold-2" />
                        <span className="text-[14px] leading-relaxed text-sand">{o}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div
                  ref={(el) => { mediaRefs.current[i] = el; }}
                  className="track-fade lg:col-span-6"
                >
                  <div className="plate corner-ticks relative rounded-xl p-2">
                    <div className="media-clip relative h-[420px] overflow-hidden rounded-lg xl:h-[480px]">
                      <img src={s.img} alt="" className="h-full w-full object-cover" />
                      <div className="absolute inset-0 bg-gradient-to-t from-navy-2 via-navy-2/30 to-transparent" />
                      <span className="absolute left-4 top-4">
                        <Tag>
                          Stage {s.no} / {PROCESS.length}
                        </Tag>
                      </span>
                      <span className="absolute bottom-4 right-4 font-mono text-[10px] uppercase tracking-wide-2 text-gold-2/80">
                        {s.sub}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          ))}

          {/* Closing panel — the same terminus the vertical chain ends on. */}
          <section
            className="flex h-screen w-screen flex-none items-center justify-center px-5"
            aria-label="Case file closed"
          >
            <div
              ref={(el) => { contentRefs.current[PROCESS.length] = el; }}
              className="track-fade text-center"
            >
              <span className="mx-auto grid h-20 w-20 place-items-center rounded-full border border-gold-2/50 bg-navy-2/60 text-gold-2">
                <Icon name="doc-seal" size={34} />
              </span>
              <h2 className="mt-8 font-display text-4xl leading-tight text-ivory xl:text-5xl">
                Case file closed.
                <span className="block italic text-gold-gradient">Findings delivered.</span>
              </h2>
              <div className="mx-auto mt-6 h-px w-32 hairline" />
              <p className="mx-auto mt-6 max-w-xl text-stone">
                Every stage is documented, sourced and bound into one evidence portfolio — ready for counsel to work from directly.
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <Tag>Confidential</Tag>
                <Tag>Evidence-led</Tag>
                <Tag>Court-ready</Tag>
              </div>
            </div>
          </section>
        </div>

        {/* Progress rail — replaces the vertical spine while the track is on screen. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
          <div className="mx-auto max-w-[1320px] px-5 pb-10 lg:px-8">
            <div className="pointer-events-auto flex items-center gap-5">
              <span className="font-mono text-[10px] uppercase tracking-wide-2 text-gold-2/70">
                {PROCESS.length} stages
              </span>

              <div className="relative h-px flex-1 overflow-hidden">
                <div className="chain-track absolute inset-0" />
                <div ref={fillRef} className="track-fill absolute inset-0 origin-left" />
              </div>

              <div className="flex items-center gap-2">
                {Array.from({ length: count }, (_, i) => (
                  <button
                    key={i}
                    ref={(el) => { dotRefs.current[i] = el; }}
                    type="button"
                    onClick={() => goTo(i)}
                    data-on="false"
                    className="track-dot"
                    aria-label={i < PROCESS.length ? `Go to stage ${PROCESS[i].no}` : "Go to the closing summary"}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
