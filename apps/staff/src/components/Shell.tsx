import Link from "next/link";
import type { Principal } from "@cac/core";
import { visibleNavigation, type AppSuite } from "@/lib/nav";
import { NavigationRail } from "./NavigationRail";
import { SuiteSwitcher } from "./SuiteSwitcher";
import { QuickActionMenu } from "./QuickActionMenu";
import { IconDashboard } from "./icons";

/**
 * Re-architected Ergonomic Enterprise Shell (Server Component):
 *
 * Tier 1: Top Suite Switcher with active route focus (Command Hub / Accounting / HRMS / Legal AI / Admin)
 * Tier 2: Persistent Navigation Rail with complete 35+ enterprise modules and active gold indicator
 * Tier 3: High-Legibility Canvas with generous padding, crisp borders, and zero intrusive outlines
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
  currentSuite?: AppSuite;
}) {
  // Always compute the complete enterprise navigation suite on the server with full capabilities
  const sections = visibleNavigation(principal, "all");

  return (
    <div className="min-h-screen bg-[var(--color-canvas)] lg:grid lg:grid-cols-[260px_1fr]">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      {/* Sidebar: Executive Slate/Navy Rail (Viewport Pinned & Sticky) */}
      <aside className="border-r border-slate-800 bg-[#0f172a] text-slate-300 lg:sticky lg:top-0 lg:h-screen lg:max-h-screen flex flex-col justify-between overflow-y-auto shrink-0">
        <div>
          {/* Brand Header */}
          <Link
            href="/"
            className="group flex items-center gap-3 border-b border-slate-800/80 px-4 py-3.5 hover:bg-slate-800/50 transition-colors"
          >
            <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-900 border border-slate-700/80 p-1.5 shadow-xs transition group-hover:border-slate-600">
              <img
                src="/assets/logo.webp"
                alt="CAC Logo"
                className="h-full w-full object-contain brightness-105"
              />
            </div>
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-[13.5px] font-semibold text-white tracking-tight group-hover:text-amber-200 transition-colors">
                Conglomerate Appraisal
              </p>
              <p className="mt-0.5 truncate text-[11px] text-slate-400 font-normal">
                Enterprise Portal
              </p>
            </div>
          </Link>

          {/* Navigation Rail with all sections & active path highlighting */}
          <NavigationRail sections={sections} />
        </div>

        {/* Sidebar Footer */}
        <div className="hidden lg:block shrink-0 border-t border-slate-800/80 px-4 py-3 bg-slate-950/40">
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span className="truncate max-w-[150px]">Conglomerate Appraisal</span>
            <span className="font-mono text-[9px] text-amber-400 font-medium">Enterprise</span>
          </div>
        </div>
      </aside>

      {/* Main Workspace */}
      <div className="flex min-w-0 flex-col bg-[var(--color-canvas)]">
        {/* Top Header: Clean High-Legibility Bar */}
        <header className="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white/95 backdrop-blur-md px-6 py-3 shadow-2xs">
          {/* Breadcrumbs */}
          <nav aria-label="Breadcrumb" className="text-[12.5px] text-slate-500">
            <ol className="flex items-center gap-2">
              <li>
                <Link href="/" className="hover:text-amber-700 flex items-center gap-1.5 transition font-medium">
                  <IconDashboard size={14} className="text-slate-400" />
                  <span>CAC</span>
                </Link>
              </li>
              {(breadcrumbs ?? []).map((crumb) => (
                <li key={crumb.label} className="flex items-center gap-2">
                  <span aria-hidden="true" className="text-slate-300">/</span>
                  {crumb.href ? (
                    <Link href={crumb.href} className="hover:text-amber-700 transition font-medium text-slate-600">
                      {crumb.label}
                    </Link>
                  ) : (
                    <span className="text-slate-900 font-semibold">{crumb.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>

          {/* Right Controls */}
          <div className="flex items-center gap-3">
            <QuickActionMenu />

            <div className="hidden sm:flex items-center gap-2 pl-3 border-l border-slate-200">
              <Link
                href="/account"
                title={`Signed in as ${principal.fullName} (${principal.email}) — View Profile & Security`}
                className="group flex items-center gap-2.5 rounded-lg px-2.5 py-1 text-[12.5px] font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-900 transition-colors"
              >
                <span className="grid h-7 w-7 place-items-center rounded-full bg-slate-900 text-[11px] font-bold text-amber-300 shadow-xs group-hover:scale-105 transition-transform">
                  {(principal.fullName?.charAt(0) || "U").toUpperCase()}
                </span>
                <div className="text-left leading-tight hidden md:block">
                  <p className="max-w-[130px] truncate text-[12px] font-semibold text-slate-800 group-hover:text-amber-800 transition-colors">
                    {principal.fullName}
                  </p>
                  <p className="text-[10px] text-slate-500 font-medium capitalize">
                    {principal.roles[0]?.replace(/_/g, " ").toLowerCase() ?? "Staff"}
                  </p>
                </div>
              </Link>
            </div>

            <form action="/api/logout" method="post">
              <button
                type="submit"
                title="Sign out and return to the main public website"
                className="btn btn-secondary px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:text-slate-900"
              >
                Sign out
              </button>
            </form>
          </div>
        </header>

        {/* Tier 1: Suite Switcher Bar */}
        <SuiteSwitcher />

        {/* Main Content Area */}
        <main id="main" className="min-w-0 flex-1 p-6 lg:p-8 page-transition outline-none">
          {principal.mfaRequired && !principal.mustEnrolMfa && (
            <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900">
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
              <Link href="/account" className="underline font-semibold">
                Set one up
              </Link>
              , which takes about a minute.
            </div>
          )}

          <div className="mb-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <h1 className="page-title text-[24px] font-semibold text-slate-900 tracking-tight">
                {title}
              </h1>
              {actions}
            </div>
            <div className="hairline mt-3 h-px w-full" aria-hidden="true" />
          </div>

          {children}
        </main>
      </div>
    </div>
  );
}
