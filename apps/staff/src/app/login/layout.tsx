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
    <div className="relative grid min-h-screen place-items-center overflow-hidden bg-slate-50 px-4 py-10">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 70% 55% at 50% 22%, rgba(245,158,11,0.08) 0%, rgba(245,158,11,0.03) 30%, rgba(248,250,252,0) 70%)",
        }}
      />

      <div className="relative w-full max-w-sm">
        <div className="mb-7 flex items-center gap-3.5">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white p-2 shadow-xs">
            <img src="/assets/logo.webp" alt="CAC Logo" className="h-full w-full object-contain" />
          </div>
          <div className="leading-tight">
            <p className="text-[17px] font-semibold text-slate-900 tracking-tight">
              Conglomerate Appraisal
            </p>
            <p className="mt-0.5 text-[11.5px] font-medium text-slate-500">
              Staff Enterprise Portal
            </p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
