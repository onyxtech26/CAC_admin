import Link from "next/link";
import type { Principal } from "@cac/core";
import { visibleNavigation } from "@/lib/nav";
import { Badge } from "./ui";

/**
 * The application shell: sidebar, header, breadcrumbs, content.
 *
 * The sidebar is a plain <details> on small screens rather than a JS drawer — fewer moving parts,
 * works before hydration, and keyboard accessible for free.
 *
 * The chrome is the public site's: an ink sidebar against the navy ground, the CAC mark set the
 * way the site's navbar sets it, gold for the section rules and for wherever you are. The one
 * thing borrowed and then turned down is the site's brand halo — permanent there, and here only on
 * the mark itself, because a glow behind a menu you read fifty times a day is a glow you come to
 * resent.
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

      <aside className="border-r border-[var(--color-line)] bg-[var(--color-ink)]/70 lg:min-h-screen">
        <Link
          href="/"
          className="flex items-center gap-2.5 border-b border-[var(--color-line)] px-4 py-3.5"
        >
          <span
            className="grid h-8 w-8 shrink-0 place-items-center rounded border border-[var(--color-line-strong)] bg-[var(--color-navy)] text-[11px] font-bold text-[var(--color-gold-2)]"
            style={{ boxShadow: "0 0 18px -6px rgba(201, 138, 4, 0.55)" }}
          >
            CAC
          </span>
          <div className="leading-tight">
            <p className="font-display text-[13px] font-semibold text-[var(--color-body)]">
              Internal Platform
            </p>
            <p className="eyebrow text-[8px] text-[var(--color-gold-soft)]">
              Conglomerate Appraisal
            </p>
          </div>
        </Link>

        <details className="lg:hidden" open={false}>
          <summary className="eyebrow cursor-pointer list-none px-4 py-2.5 text-[10px] text-[var(--color-gold-soft)]">
            Menu
          </summary>
          <NavList sections={sections} />
        </details>

        <div className="hidden lg:block">
          <NavList sections={sections} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] bg-[var(--color-ink)]/55 px-4 py-2.5">
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
              <button type="submit" className="btn btn-secondary px-2.5 py-1.5 text-[12px]">
                Sign out
              </button>
            </form>
          </div>
        </header>

        <main id="main" tabIndex={-1} className="min-w-0 flex-1 p-4 lg:p-6">
          {/*
            The enrolment reminder, on every page rather than only on /account — somebody who never
            visits their account page would otherwise meet the requirement as a locked door on the
            day it falls due. It disappears the moment an authenticator is enrolled.
          */}
          {principal.mfaRequired && !principal.mustEnrolMfa && (
            <div className="mb-4 rounded-md border border-[color-mix(in_srgb,var(--color-warn)_35%,transparent)] bg-[var(--color-warn-bg)] px-3 py-2 text-[12px]">
              This account needs an authenticator by{" "}
              <strong>
                {principal.mfaEnrolmentDueAt
                  ? new Date(principal.mfaEnrolmentDueAt).toLocaleDateString("en-GB", {
                      day: "numeric",
                      month: "long",
                    })
                  : "the deadline"}
              </strong>
              . After that date only your account page opens.{" "}
              <Link href="/account" className="underline">
                Set one up
              </Link>
              , which takes about a minute.
            </div>
          )}

          <div className="mb-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h1 className="page-title text-[22px] text-[var(--color-body)]">{title}</h1>
              {actions}
            </div>
            {/* The site rules a gold hairline under every section heading. One line of CSS, and it
                is the single strongest signal that these are the same product. */}
            <div className="hairline mt-2 h-px w-full" aria-hidden="true" />
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
          <p className="eyebrow px-2 py-1 text-[9px] text-[var(--color-gold-soft)]">
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
                    className="block rounded border-l-2 border-transparent px-2 py-1.5 text-[13px] text-[var(--color-muted)] transition hover:border-[var(--color-gold-2)] hover:bg-[rgba(233,199,102,0.08)] hover:text-[var(--color-body)]"
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
