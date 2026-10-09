"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  IconAccounting,
  IconAdmin,
  IconDashboard,
  IconHRMS,
  IconLegalAI,
} from "./icons";

export function SuiteSwitcher() {
  const pathname = usePathname();

  const activeSuite: "all" | "accounting" | "hrms" | "legal" | "admin" =
    pathname.startsWith("/accounting")
      ? "accounting"
      : pathname.startsWith("/hr")
        ? "hrms"
        : pathname.startsWith("/cases") || pathname.startsWith("/documents")
          ? "legal"
          : pathname.startsWith("/admin")
            ? "admin"
            : "all";

  return (
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
            <IconDashboard
              size={14}
              className={
                activeSuite === "all"
                  ? "text-amber-400"
                  : "text-slate-400 group-hover:text-slate-600"
              }
            />
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
            <IconAccounting
              size={14}
              className={
                activeSuite === "accounting"
                  ? "text-amber-400"
                  : "text-slate-400 group-hover:text-slate-600"
              }
            />
            <span className={activeSuite === "accounting" ? "text-white" : ""}>
              AutoCount Accounting
            </span>
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
            <IconHRMS
              size={14}
              className={
                activeSuite === "hrms"
                  ? "text-amber-400"
                  : "text-slate-400 group-hover:text-slate-600"
              }
            />
            <span className={activeSuite === "hrms" ? "text-white" : ""}>
              AutoCount HRMS
            </span>
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
            <IconLegalAI
              size={14}
              className={
                activeSuite === "legal"
                  ? "text-amber-400"
                  : "text-slate-400 group-hover:text-slate-600"
              }
            />
            <span className={activeSuite === "legal" ? "text-white" : ""}>
              Legal AI Forensics
            </span>
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
            <IconAdmin
              size={14}
              className={
                activeSuite === "admin"
                  ? "text-amber-400"
                  : "text-slate-400 group-hover:text-slate-600"
              }
            />
            <span className={activeSuite === "admin" ? "text-white" : ""}>
              Administration
            </span>
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
  );
}
