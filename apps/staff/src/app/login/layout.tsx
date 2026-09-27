/**
 * The way the platform greets you.
 *
 * This is the first screen after a double-click on the public site's mark, so it is the one place
 * the platform is allowed to look like the site rather than like a tool: the gold bloom behind the
 * plate, the mark with its halo, the name set in Playfair. Past the sign-in the flourish stops and
 * the density starts.
 *
 * The bloom is a static gradient, not an animation. A login screen that pulses while you are
 * typing a password is a login screen that is harder to type a password into.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden px-4 py-10">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 70% 55% at 50% 22%, rgba(255,244,207,0.10) 0%, rgba(233,199,102,0.062) 20%, rgba(201,138,4,0.032) 42%, rgba(201,138,4,0) 100%)",
        }}
      />

      <div className="relative w-full max-w-sm">
        <div className="mb-7 flex items-center gap-3">
          <span
            className="grid h-11 w-11 shrink-0 place-items-center rounded border border-[var(--color-line-strong)] bg-[var(--color-navy)] text-[13px] font-bold text-[var(--color-gold-2)]"
            style={{ boxShadow: "0 0 26px -6px rgba(201, 138, 4, 0.6)" }}
          >
            CAC
          </span>
          <div className="leading-tight">
            <p className="font-display text-[17px] font-semibold text-[var(--color-body)]">
              Internal Platform
            </p>
            <p className="eyebrow mt-0.5 text-[8.5px] text-[var(--color-gold-soft)]">
              Conglomerate Appraisal Consultancy
            </p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
