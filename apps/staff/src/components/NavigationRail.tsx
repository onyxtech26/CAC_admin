"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import type { NavSection } from "@/lib/nav";
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

export function NavigationRail({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname();
  const allHrefs = sections.flatMap((section) => section.items.map((item) => item.href));
  const navContainerRef = useRef<HTMLDivElement>(null);

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

  // Scroll active item smoothly into view if off-screen
  useEffect(() => {
    if (!navContainerRef.current) return;
    const activeEl = navContainerRef.current.querySelector<HTMLElement>('[data-active="true"]');
    if (activeEl) {
      activeEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [pathname]);

  const renderNav = () => (
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
                      data-active={active ? "true" : undefined}
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

  return (
    <div ref={navContainerRef}>
      {/* Mobile menu toggle */}
      <details className="lg:hidden" open={false}>
        <summary className="cursor-pointer list-none px-4 py-2.5 text-[11px] text-amber-400 uppercase font-mono">
          Toggle Menu
        </summary>
        {renderNav()}
      </details>

      {/* Desktop Nav List */}
      <div className="hidden lg:block">{renderNav()}</div>
    </div>
  );
}
