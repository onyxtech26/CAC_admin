export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-[var(--color-canvas)] px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded bg-[var(--color-navy)] text-[12px] font-bold text-[var(--color-gold-2)]">
            CAC
          </span>
          <div className="leading-tight">
            <p className="text-[13px] font-semibold">Internal Platform</p>
            <p className="text-[11px] text-[var(--color-faint)]">Conglomerate Appraisal Consultancy</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
