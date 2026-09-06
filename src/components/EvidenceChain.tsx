import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Eyebrow } from "./ui";
import { PROCESS } from "../data";

/**
 * The investigation lifecycle as a drawn chain.
 *
 * A gold spine runs behind the stages and fills to whichever node the reader
 * has reached. Driven by IntersectionObserver rather than a scroll listener —
 * each node reports when it crosses the trigger line and the CSS transition
 * does the drawing, so there is no per-frame work on the main thread. That
 * matters on the mid-range Android this audience is largely on.
 *
 * The fill height is measured from real node positions rather than an even
 * fraction: stages differ in height (they have different numbers of outputs),
 * so a 1/n step would drift away from the nodes it is meant to connect.
 */
export default function EvidenceChain() {
  const [reached, setReached] = useState(0);
  const [offsets, setOffsets] = useState<number[]>([]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef<(HTMLDivElement | null)[]>([]);

  const TOTAL = PROCESS.length + 1; // stages plus the terminus

  /** centre of each node, relative to the spine container */
  const measure = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const top = root.getBoundingClientRect().top;
    const next = nodeRefs.current.map((n) => {
      if (!n) return 0;
      const r = n.getBoundingClientRect();
      return r.top - top + r.height / 2;
    });
    setOffsets(next);
  }, []);

  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (rootRef.current) ro.observe(rootRef.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const i = Number((e.target as HTMLElement).dataset.index);
          // only ever advance — scrolling back up leaves the chain drawn
          setReached((r) => (i + 1 > r ? i + 1 : r));
        }
      },
      // fire when a stage reaches the lower-middle of the viewport
      { rootMargin: "0px 0px -45% 0px", threshold: 0 },
    );
    for (const n of nodeRefs.current) if (n) io.observe(n);

    // Safety net: the page's entire body lives inside these items, so if the
    // observer never fires — a hidden document, an old engine, a JS hiccup —
    // the content must not stay invisible. Reveal everything if nothing has
    // been reached shortly after mount.
    const fallback = window.setTimeout(() => {
      setReached((r) => (r === 0 ? TOTAL : r));
    }, 1800);

    return () => {
      io.disconnect();
      window.clearTimeout(fallback);
    };
  }, [TOTAL]);

  const fillPx = reached > 0 && offsets.length ? offsets[Math.min(reached, TOTAL) - 1] ?? 0 : 0;

  return (
    <div ref={rootRef} className="relative mt-14">
      {/* spine — sits under the nodes, aligned to their centre */}
      <div className="pointer-events-none absolute bottom-0 left-5 top-0 w-px -translate-x-1/2 sm:left-7">
        <div className="chain-track absolute inset-0" />
        <div className="chain-fill absolute left-0 top-0 w-full" style={{ height: `${fillPx}px` }} />
      </div>

      <ol className="relative space-y-12 sm:space-y-16">
        {PROCESS.map((p, i) => {
          const on = i < reached;
          return (
            <li key={p.no} className="relative pl-14 sm:pl-20">
              <div
                ref={(el) => { nodeRefs.current[i] = el; }}
                data-index={i}
                data-reached={on}
                className={`chain-node absolute left-0 top-1 grid h-10 w-10 place-items-center rounded-full border font-mono text-[11px] font-bold sm:h-14 sm:w-14 sm:text-[13px] ${
                  on ? "text-navy" : "border-gold-2/30 bg-navy text-gold-2/70"
                }`}
              >
                {p.no}
              </div>

              <div data-reached={on} className="chain-item">
                <Eyebrow>{p.sub}</Eyebrow>
                <h2 className="mt-3 font-display text-2xl leading-tight text-ivory sm:text-3xl">{p.title}</h2>
                <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-stone sm:text-base">{p.details}</p>

                <ul className="mt-6 grid max-w-2xl gap-3 sm:grid-cols-2">
                  {p.outputs.map((o, j) => (
                    <li
                      key={j}
                      className="chain-output flex items-start gap-3 rounded-lg p-4"
                    >
                      <Icon name="check" size={15} className="mt-0.5 shrink-0 text-gold-2" />
                      <span className="text-[14px] leading-relaxed text-sand">{o}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </li>
          );
        })}
      </ol>

      {/* terminus — the last point the spine draws to */}
      <div className="relative mt-12 pl-14 sm:pl-20">
        <div
          ref={(el) => { nodeRefs.current[PROCESS.length] = el; }}
          data-index={PROCESS.length}
          data-reached={reached > PROCESS.length}
          className={`chain-node absolute left-0 top-0 grid h-10 w-10 place-items-center rounded-full border sm:h-14 sm:w-14 ${
            reached > PROCESS.length ? "text-navy" : "border-gold-2/30 bg-navy text-gold-2/70"
          }`}
        >
          <Icon name="doc-seal" size={18} />
        </div>
        <p className="pt-2 font-mono text-[11px] uppercase tracking-wide-2 text-gold-2 sm:pt-4">
          Case file closed · findings delivered
        </p>
      </div>
    </div>
  );
}
