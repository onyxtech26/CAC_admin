"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import Link from "next/link";
import type { Principal } from "@cac/core";
import { visibleNavigation, type AppSuite } from "@/lib/nav";
import { QuickActionMenu } from "./QuickActionMenu";
import {
  IconAccounting,
  IconAdmin,
  IconAward,
  IconBank,
  IconBill,
  IconCase,
  IconCheckCircle,
  IconClock,
  IconDashboard,
  IconEnquiry,
  IconFileCheck,
  IconFolder,
  IconHRMS,
  IconInvoice,
  IconJournal,
  IconLegalAI,
  IconLetters,
  IconPayroll,
  IconPayslip,
  IconQuote,
  IconReceipt,
  IconTax,
  IconUsers,
  IconVoucher,
} from "./icons";

function getNavIcon(name?: string) {
  switch (name) {
    case "dashboard":
      return <IconDashboard size={16} />;
    case "enquiry":
      return <IconEnquiry size={16} />;
    case "accounting":
      return <IconAccounting size={16} />;
    case "hrms":
      return <IconHRMS size={16} />;
    case "legal":
      return <IconLegalAI size={16} />;
    case "admin":
      return <IconAdmin size={16} />;
    case "invoice":
      return <IconInvoice size={16} />;
    case "receipt":
      return <IconReceipt size={16} />;
    case "quote":
      return <IconQuote size={16} />;
    case "bill":
      return <IconBill size={16} />;
    case "voucher":
      return <IconVoucher size={16} />;
    case "journal":
      return <IconJournal size={16} />;
    case "bank":
      return <IconBank size={16} />;
    case "tax":
      return <IconTax size={16} />;
    case "users":
      return <IconUsers size={16} />;
    case "clock":
      return <IconClock size={16} />;
    case "payroll":
      return <IconPayroll size={16} />;
    case "payslip":
      return <IconPayslip size={16} />;
    case "award":
      return <IconAward size={16} />;
    case "letters":
      return <IconLetters size={16} />;
    case "case":
      return <IconCase size={16} />;
    case "folder":
      return <IconFolder size={16} />;
    case "check":
      return <IconCheckCircle size={16} />;
    default:
      return <IconFileCheck size={16} />;
  }
}

function inferActiveSuite(
  breadcrumbs?: Array<{ label: string; href?: string }>,
  title?: string,
): AppSuite {
  const combined = `${title ?? ""} ${(breadcrumbs ?? []).map((b) => b.label).join(" ")}`.toLowerCase();
  if (
    combined.includes("accounting") ||
    combined.includes("invoice") ||
    combined.includes("quote") ||
    combined.includes("receipt") ||
    combined.includes("bill") ||
    combined.includes("voucher") ||
    combined.includes("ledger") ||
    combined.includes("journal") ||
    combined.includes("aging") ||
    combined.includes("bank") ||
    combined.includes("tax") ||
    combined.includes("customer") ||
    combined.includes("supplier")
  ) {
    return "accounting";
  }
  if (
    combined.includes("hr") ||
    combined.includes("employee") ||
    combined.includes("leave") ||
    combined.includes("attendance") ||
    combined.includes("payroll") ||
    combined.includes("payslip") ||
    combined.includes("statutory") ||
    combined.includes("appraisal") ||
    combined.includes("letter")
  ) {
    return "hrms";
  }
  if (
    combined.includes("case") ||
    combined.includes("matter") ||
    combined.includes("probate") ||
    combined.includes("rule") ||
    combined.includes("legal") ||
    combined.includes("document")
  ) {
    return "legal";
  }
  if (
    combined.includes("admin") ||
    combined.includes("user") ||
    combined.includes("role") ||
    combined.includes("setting") ||
    combined.includes("integration") ||
    combined.includes("audit")
  ) {
    return "admin";
  }
  return "all";
}

/**
 * Re-architected Ergonomic 3-Tier Enterprise Shell:
 *
 * Tier 1: Top Suite Switcher with isolated focus (Command Hub / Accounting / HRMS / Legal AI / Admin)
 * Tier 2: Contextual Left Navigation (shows only the relevant tools for the active suite, eliminating sidebar clutter)
 * Tier 3: High-Legibility Canvas with generous padding, crisp borders, and executive contrast
 */
export function Shell({
  principal,
  breadcrumbs,
  title,
  actions,
  children,
  currentSuite,
}: {
  principal: Principal;
  breadcrumbs?: Array<{ label: string; href?: string }>;
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  currentSuite?: AppSuite;
}) {
  const pathname = usePathname();

  // Reset scroll and focus main canvas on route navigation
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    const mainEl = document.getElementById("main");
    if (mainEl) {
      mainEl.focus({ preventScroll: true });
    }
  }, [pathname]);

  const suiteFromPath: AppSuite | null = pathname.startsWith("/accounting")
    ? "accounting"
    : pathname.startsWith("/hr")
      ? "hrms"
      : pathname.startsWith("/cases") || pathname.startsWith("/documents")
        ? "legal"
        : pathname.startsWith("/admin")
          ? "admin"
          : pathname === "/" || pathname.startsWith("/enquiries")
            ? "all"
            : null;

  const activeSuite = suiteFromPath ?? currentSuite ?? inferActiveSuite(breadcrumbs, title);

  // Filter navigation contextually based on the active suite:
  // If in a specific suite (e.g. accounting, hrms, legal, admin), show only its tools.
  // In the overview hub ("all"), show everything cleanly.
  const sections = visibleNavigation(principal, activeSuite === "all" ? "all" : activeSuite);

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

          {/* Active Suite Indicator Pill in Sidebar */}
          {activeSuite !== "all" && (
            <div className="px-3 pt-3 pb-1">
              <div className="flex items-center justify-between rounded-lg bg-slate-850/80 border border-slate-750 px-3 py-1.5 text-[11.5px]">
                <div className="flex items-center gap-1.5 truncate">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0 shadow-[0_0_6px_rgba(251,191,36,0.8)]" />
                  <span className="truncate text-slate-200 font-medium">
                    {activeSuite === "accounting"
                      ? "Accounting Suite"
                      : activeSuite === "hrms"
                        ? "HRMS & Payroll"
                        : activeSuite === "legal"
                          ? "Legal AI Forensics"
                          : "Administration"}
                  </span>
                </div>
                <Link
                  href="/"
                  className="text-[10.5px] text-amber-400 hover:text-amber-300 transition font-medium ml-2 shrink-0 bg-slate-800/80 px-1.5 py-0.5 rounded border border-slate-700/60"
                  title="Return to Command Hub"
                >
                  All Suites
                </Link>
              </div>
            </div>
          )}

          {/* Mobile menu toggle */}
          <details className="lg:hidden" open={false}>
            <summary className="cursor-pointer list-none px-4 py-2.5 text-[11px] text-amber-400 uppercase font-mono">
              Toggle Menu
            </summary>
            <NavList sections={sections} pathname={pathname} />
          </details>

          {/* Desktop Nav List */}
          <div className="hidden lg:block">
            <NavList sections={sections} pathname={pathname} />
          </div>
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

        {/* Tier 1: Suite Switcher Bar (Spacious Ergonomic Navigation) */}
        <div className="border-b border-slate-200/90 bg-white px-6 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
              <Link
                href="/"
                prefetch={true}
                aria-current={activeSuite === "all" ? "page" : undefined}
                className={`group flex items-center gap-2 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-all focus:outline-hidden focus-visible:ring-2 focus-visible:ring-amber-500 ${
                  activeSuite === "all"
                    ? "bg-slate-900 text-amber-300 font-semibold shadow-xs ring-1 ring-slate-800"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                <IconDashboard size={14} className={activeSuite === "all" ? "text-amber-400" : "text-slate-400 group-hover:text-slate-600"} />
                <span className={activeSuite === "all" ? "text-white" : ""}>Command Hub</span>
                {activeSuite === "all" && (
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0 shadow-[0_0_6px_rgba(251,191,36,0.8)]" />
                )}
              </Link>

              <Link
                href="/accounting"
                prefetch={true}
                aria-current={activeSuite === "accounting" ? "page" : undefined}
                className={`group flex items-center gap-2 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-all focus:outline-hidden focus-visible:ring-2 focus-visible:ring-amber-500 ${
                  activeSuite === "accounting"
                    ? "bg-slate-900 text-amber-300 font-semibold shadow-xs ring-1 ring-slate-800"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                <IconAccounting size={14} className={activeSuite === "accounting" ? "text-amber-400" : "text-slate-400 group-hover:text-slate-600"} />
                <span className={activeSuite === "accounting" ? "text-white" : ""}>AutoCount Accounting</span>
                {activeSuite === "accounting" && (
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0 shadow-[0_0_6px_rgba(251,191,36,0.8)]" />
                )}
              </Link>

              <Link
                href="/hr"
                prefetch={true}
                aria-current={activeSuite === "hrms" ? "page" : undefined}
                className={`group flex items-center gap-2 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-all focus:outline-hidden focus-visible:ring-2 focus-visible:ring-amber-500 ${
                  activeSuite === "hrms"
                    ? "bg-slate-900 text-amber-300 font-semibold shadow-xs ring-1 ring-slate-800"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                <IconHRMS size={14} className={activeSuite === "hrms" ? "text-amber-400" : "text-slate-400 group-hover:text-slate-600"} />
                <span className={activeSuite === "hrms" ? "text-white" : ""}>AutoCount HRMS</span>
                {activeSuite === "hrms" && (
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0 shadow-[0_0_6px_rgba(251,191,36,0.8)]" />
                )}
              </Link>

              <Link
                href="/cases"
                prefetch={true}
                aria-current={activeSuite === "legal" ? "page" : undefined}
                className={`group flex items-center gap-2 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-all focus:outline-hidden focus-visible:ring-2 focus-visible:ring-amber-500 ${
                  activeSuite === "legal"
                    ? "bg-slate-900 text-amber-300 font-semibold shadow-xs ring-1 ring-slate-800"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                <IconLegalAI size={14} className={activeSuite === "legal" ? "text-amber-400" : "text-slate-400 group-hover:text-slate-600"} />
                <span className={activeSuite === "legal" ? "text-white" : ""}>Legal AI Forensics</span>
                {activeSuite === "legal" && (
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0 shadow-[0_0_6px_rgba(251,191,36,0.8)]" />
                )}
              </Link>

              <Link
                href="/admin"
                prefetch={true}
                aria-current={activeSuite === "admin" ? "page" : undefined}
                className={`group flex items-center gap-2 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-all focus:outline-hidden focus-visible:ring-2 focus-visible:ring-amber-500 ${
                  activeSuite === "admin"
                    ? "bg-slate-900 text-amber-300 font-semibold shadow-xs ring-1 ring-slate-800"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                <IconAdmin size={14} className={activeSuite === "admin" ? "text-amber-400" : "text-slate-400 group-hover:text-slate-600"} />
                <span className={activeSuite === "admin" ? "text-white" : ""}>Administration</span>
                {activeSuite === "admin" && (
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0 shadow-[0_0_6px_rgba(251,191,36,0.8)]" />
                )}
              </Link>
            </div>

            <span className="hidden xl:inline text-[11px] text-slate-400 font-mono">
              Malaysian SST & Bar Council Compliant
            </span>
          </div>
        </div>

        {/* Main Content Area: Generous Enterprise Canvas */}
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 p-6 lg:p-8 page-transition focus:outline-hidden">
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

function NavList({
  sections,
  pathname,
}: {
  sections: ReturnType<typeof visibleNavigation>;
  pathname: string;
}) {
  const allHrefs = sections.flatMap((section) => section.items.map((item) => item.href));

  const isItemActive = (itemHref: string) => {
    if (pathname === itemHref) return true;
    if (
      itemHref === "/" ||
      itemHref === "/accounting" ||
      itemHref === "/hr" ||
      itemHref === "/cases" ||
      itemHref === "/admin"
    ) {
      return pathname === itemHref;
    }
    if (pathname.startsWith(itemHref + "/")) {
      const hasLongerMatch = allHrefs.some(
        (other) =>
          other !== itemHref &&
          other.length > itemHref.length &&
          (pathname === other || pathname.startsWith(other + "/")),
      );
      return !hasLongerMatch;
    }
    return false;
  };

  return (
    <nav className="px-3 py-3 space-y-4" aria-label="Sections">
      {sections.map((section) => (
        <div key={section.heading} className="space-y-1">
          <p className="px-3 py-1 font-mono text-[9.5px] uppercase tracking-wider text-slate-400 font-semibold">
            {section.heading}
          </p>
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const active = isItemActive(item.href);
              return (
                <li key={item.href}>
                  {item.phase ? (
                    <span
                      className="flex cursor-not-allowed items-center justify-between rounded-lg px-3 py-1.5 text-[13px] text-slate-500"
                      title={`Planned for phase ${item.phase}`}
                    >
                      <span className="flex items-center gap-2.5">
                        <span className="opacity-40">{getNavIcon(item.icon)}</span>
                        <span>{item.label}</span>
                      </span>
                      <span className="text-[10px] font-mono">P{item.phase}</span>
                    </span>
                  ) : (
                    <Link
                      href={item.href}
                      prefetch={true}
                      aria-current={active ? "page" : undefined}
                      className={`group flex items-center justify-between rounded-lg px-3 py-1.5 text-[13px] transition-all duration-150 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 ${
                        active
                          ? "bg-slate-800/90 text-amber-300 font-semibold border-l-[3px] border-amber-400 shadow-xs ring-1 ring-amber-400/20"
                          : "text-slate-300 font-normal hover:bg-slate-800/60 hover:text-white border-l-[3px] border-transparent"
                      }`}
                    >
                      <span className="flex items-center gap-2.5 truncate">
                        <span
                          className={`shrink-0 transition-colors ${
                            active
                              ? "text-amber-400 drop-shadow-[0_0_6px_rgba(251,191,36,0.6)]"
                              : "text-slate-400 group-hover:text-amber-300"
                          }`}
                        >
                          {getNavIcon(item.icon)}
                        </span>
                        <span
                          className={`truncate ${
                            active
                              ? "text-amber-200 font-semibold"
                              : "text-slate-300 group-hover:text-white"
                          }`}
                        >
                          {item.label}
                        </span>
                      </span>
                      {active && (
                        <span className="ml-2 flex h-2 w-2 items-center justify-center shrink-0">
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.9)] animate-pulse" />
                        </span>
                      )}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
