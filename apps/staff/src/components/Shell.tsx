import Link from "next/link";
import type { Principal } from "@cac/core";
import { visibleNavigation } from "@/lib/nav";
import { Badge } from "./ui";

/**
 * The application shell: sidebar, header, breadcrumbs, content.
 *
 * The sidebar is a plain <details> on small screens rather than a JS drawer —
 * fewer moving parts, works before hydration, and keyboard accessible for
 * free.
 */
export function Shell({
  principal,
  breadcrumbs,
  title,
  actions,
  children,
}: {
  principal: Principal;
  breadcrumbs?: Array<{ label: string; href?: string }>;
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const sections = visibleNavigation(principal);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[248px_1fr]">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <aside className="border-r border-[var(--color-line)] bg-[var(--color-surface)] lg:min-h-screen">
        <div className="flex items-center gap-2 border-b border-[var(--color-line)] px-4 py-3">
          <span className="grid h-7 w-7 place-items-center rounded bg-[var(--color-navy)] text-[11px] font-bold text-[var(--color-gold-2)]">
            CAC
          </span>
          <div className="leading-tight">
            <p className="text-[12px] font-semibold">Internal Platform</p>
            <p className="text-[10px] text-[var(--color-faint)]">Conglomerate Appraisal</p>
          </div>
        </div>

        <details className="lg:hidden" open={false}>
          <summary className="cursor-pointer list-none px-4 py-2 text-[12px] font-medium text-[var(--color-muted)]">
            Menu
          </summary>
          <NavList sections={sections} />
        </details>

        <div className="hidden lg:block">
          <NavList sections={sections} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-2.5">
          <nav aria-label="Breadcrumb" className="text-[12px] text-[var(--color-muted)]">
            <ol className="flex items-center gap-1.5">
              <li>
                <Link href="/" className="hover:text-[var(--color-body)]">
                  Home
                </Link>
              </li>
              {(breadcrumbs ?? []).map((crumb) => (
                <li key={crumb.label} className="flex items-center gap-1.5">
                  <span aria-hidden="true">/</span>
                  {crumb.href ? (
                    <Link href={crumb.href} className="hover:text-[var(--color-body)]">
                      {crumb.label}
                    </Link>
                  ) : (
                    <span className="text-[var(--color-body)]">{crumb.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>

          <div className="flex items-center gap-3">
            <span className="hidden text-[12px] text-[var(--color-muted)] sm:inline">
              {principal.fullName}
            </span>
            {principal.roles[0] && <Badge tone="info">{principal.roles[0].replace(/_/g, " ")}</Badge>}
            <form action="/api/logout" method="post">
              <button
                type="submit"
                className="rounded-md border border-[var(--color-line-strong)] px-2.5 py-1.5 text-[12px] hover:bg-[var(--color-canvas)]"
              >
                Sign out
              </button>
            </form>
          </div>
        </header>

        <main id="main" tabIndex={-1} className="min-w-0 flex-1 p-4 lg:p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-lg font-semibold text-[var(--color-body)]">{title}</h1>
            {actions}
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}

function NavList({ sections }: { sections: ReturnType<typeof visibleNavigation> }) {
  return (
    <nav className="px-2 py-2" aria-label="Sections">
      {sections.map((section) => (
        <div key={section.heading} className="mb-3">
          <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-faint)]">
            {section.heading}
          </p>
          <ul>
            {section.items.map((item) => (
              <li key={item.href}>
                {item.phase ? (
                  // Not built yet. Shown, disabled, and labelled with the phase
                  // rather than hidden — a menu that lies about what exists is
                  // worse than one that admits what is coming.
                  <span
                    className="flex cursor-not-allowed items-center justify-between rounded px-2 py-1.5 text-[13px] text-[var(--color-faint)]"
                    title={`Planned for phase ${item.phase}`}
                  >
                    {item.label}
                    <span className="text-[10px]">P{item.phase}</span>
                  </span>
                ) : (
                  <Link
                    href={item.href}
                    className="block rounded px-2 py-1.5 text-[13px] text-[var(--color-body)] hover:bg-[var(--color-canvas)]"
                  >
                    {item.label}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
