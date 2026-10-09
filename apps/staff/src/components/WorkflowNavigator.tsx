"use client";

import { useState } from "react";
import Link from "next/link";
import {
  IconArrowRight,
  IconAward,
  IconBank,
  IconBill,
  IconBrainAI,
  IconBuilding,
  IconCalendar,
  IconCase,
  IconCheckCircle,
  IconClock,
  IconFileCheck,
  IconHRMS,
  IconInvoice,
  IconJournal,
  IconLegalAI,
  IconPayroll,
  IconPayslip,
  IconPlus,
  IconQuote,
  IconReceipt,
  IconVoucher,
} from "./icons";

export type FlowTab = "sales" | "purchases" | "gl" | "hrms" | "legal";

interface FlowStep {
  step: number;
  title: string;
  subtitle: string;
  href: string;
  newHref?: string;
  icon: React.ReactNode;
  badge?: string;
}

interface WorkflowFlow {
  id: FlowTab;
  label: string;
  suite: "accounting" | "hrms" | "legal";
  title: string;
  description: string;
  steps: FlowStep[];
  sideLinks?: Array<{ label: string; href: string; icon?: React.ReactNode }>;
}

const FLOWS: Record<FlowTab, WorkflowFlow> = {
  sales: {
    id: "sales",
    label: "Sales (A/R) Flow",
    suite: "accounting",
    title: "AutoCount Sales & Receivables Lifecycle",
    description:
      "The complete revenue lifecycle for CAC's property consultancy: from valuation quote to receipt and LHDN e-Invoicing.",
    steps: [
      {
        step: 1,
        title: "Quotations",
        subtitle: "Proposal & appraisal fee terms",
        href: "/accounting/quotations",
        newHref: "/accounting/quotations/new",
        icon: <IconQuote size={18} className="text-amber-600" />,
      },
      {
        step: 2,
        title: "Tax Invoices",
        subtitle: "SST 6%/8% billed client invoices",
        href: "/accounting/invoices",
        newHref: "/accounting/invoices/new",
        icon: <IconInvoice size={18} className="text-amber-600" />,
      },
      {
        step: 3,
        title: "Official Receipts",
        subtitle: "Payment received & allocated",
        href: "/accounting/receipts",
        newHref: "/accounting/receipts/new",
        icon: <IconReceipt size={18} className="text-emerald-600" />,
      },
      {
        step: 4,
        title: "e-Invoicing",
        subtitle: "MyInvois statutory submission",
        href: "/accounting/einvoice",
        icon: <IconCheckCircle size={18} className="text-blue-600" />,
        badge: "LHDN",
      },
    ],
    sideLinks: [
      { label: "Customer Master", href: "/accounting/customers" },
      { label: "Receivables Aging Report", href: "/accounting/reports/aging" },
      { label: "Revenue by Matter", href: "/accounting/reports/by-matter" },
    ],
  },
  purchases: {
    id: "purchases",
    label: "Purchases (A/P) Flow",
    suite: "accounting",
    title: "AutoCount Purchases & Payables Lifecycle",
    description:
      "Full vendor procurement mirror: authorising commitments, registering supplier bills, and issuing payment vouchers.",
    steps: [
      {
        step: 1,
        title: "Purchase Orders",
        subtitle: "Authorised vendor commitments",
        href: "/accounting/purchase-orders",
        newHref: "/accounting/purchase-orders/new",
        icon: <IconBill size={18} className="text-amber-600" />,
      },
      {
        step: 2,
        title: "Supplier Bills",
        subtitle: "Inbound vendor tax invoices",
        href: "/accounting/bills",
        newHref: "/accounting/bills/new",
        icon: <IconInvoice size={18} className="text-amber-600" />,
      },
      {
        step: 3,
        title: "Payment Vouchers",
        subtitle: "Cheque / IBG settlement release",
        href: "/accounting/vouchers",
        newHref: "/accounting/vouchers/new",
        icon: <IconVoucher size={18} className="text-emerald-600" />,
      },
    ],
    sideLinks: [
      { label: "Suppliers List", href: "/accounting/suppliers" },
      { label: "Expense Claims", href: "/accounting/claims" },
      { label: "Petty Cash", href: "/accounting/petty-cash" },
      { label: "Payables Aging", href: "/accounting/reports/payables-aging" },
    ],
  },
  gl: {
    id: "gl",
    label: "General Ledger Flow",
    suite: "accounting",
    title: "AutoCount G/L & Financial Statements",
    description:
      "Ledger postings, bank reconciliations, fiscal calendar controls, and automated statutory financial statements.",
    steps: [
      {
        step: 1,
        title: "Chart of Accounts",
        subtitle: "Hierarchical balance accounts",
        href: "/accounting/accounts",
        icon: <IconBuilding size={18} className="text-amber-600" />,
      },
      {
        step: 2,
        title: "Journal Entries",
        subtitle: "Double-entry maker-checker",
        href: "/accounting/journals",
        newHref: "/accounting/journals/new",
        icon: <IconJournal size={18} className="text-blue-600" />,
      },
      {
        step: 3,
        title: "Bank Reconcile",
        subtitle: "Statement import & sign-off",
        href: "/accounting/bank",
        icon: <IconBank size={18} className="text-emerald-600" />,
      },
      {
        step: 4,
        title: "Trial Balance",
        subtitle: "Balanced zero ledger totals",
        href: "/accounting/reports/trial-balance",
        icon: <IconCheckCircle size={18} className="text-blue-600" />,
      },
      {
        step: 5,
        title: "P&L & Balance Sheet",
        subtitle: "Period financial statements",
        href: "/accounting/reports/profit-and-loss",
        icon: <IconFileCheck size={18} className="text-emerald-600" />,
      },
    ],
    sideLinks: [
      { label: "Fiscal Periods", href: "/accounting/periods" },
      { label: "SST Tax Codes", href: "/accounting/tax" },
      { label: "Balance Sheet", href: "/accounting/reports/balance-sheet" },
    ],
  },
  hrms: {
    id: "hrms",
    label: "HRMS & Payroll Flow",
    suite: "hrms",
    title: "AutoCount HRMS & Malaysian Statutory Cycle",
    description:
      "From biometric fingerprint logs and leave tracking to monthly payroll computation, KWSP/PERKESO, and GL posting.",
    steps: [
      {
        step: 1,
        title: "Biometric Scans",
        subtitle: "Upload fingerprint Excel reader",
        href: "/hr/attendance/import",
        icon: <IconClock size={18} className="text-emerald-600" />,
      },
      {
        step: 2,
        title: "Attendance & OT",
        subtitle: "Extra hours vs payable OT",
        href: "/hr/attendance",
        icon: <IconCalendar size={18} className="text-amber-600" />,
      },
      {
        step: 3,
        title: "Leave & Absences",
        subtitle: "Annual balance entitlement",
        href: "/hr/leave",
        icon: <IconCheckCircle size={18} className="text-blue-600" />,
      },
      {
        step: 4,
        title: "Run Payroll",
        subtitle: "EPF, SOCSO, EIS & PCB calc",
        href: "/hr/payroll",
        icon: <IconPayroll size={18} className="text-emerald-600" />,
        badge: "AutoCount",
      },
      {
        step: 5,
        title: "Payslips & Post",
        subtitle: "PDF slips & auto-post to GL",
        href: "/hr/payslips",
        icon: <IconPayslip size={18} className="text-blue-600" />,
      },
    ],
    sideLinks: [
      { label: "Employee Master", href: "/hr/employees" },
      { label: "Overtime Requests", href: "/hr/overtime" },
      { label: "Public Holidays", href: "/hr/holidays" },
      { label: "HR Letters", href: "/hr/letters" },
      { label: "Appraisals", href: "/hr/appraisals" },
    ],
  },
  legal: {
    id: "legal",
    label: "Legal AI (Probate / LA)",
    suite: "legal",
    title: "Malaysian Probate & Estate Administration AI Pipeline",
    description:
      "End-to-end estate case management under Rules of Court 2012: dynamic checklist, missing evidence prompt, RAG precedents, and 1-click pack.",
    steps: [
      {
        step: 1,
        title: "Case Intake",
        subtitle: "Estate & probate instructions",
        href: "/cases",
        icon: <IconCase size={18} className="text-amber-600" />,
      },
      {
        step: 2,
        title: "Heirs & Inventory",
        subtitle: "Distribution Act & land titles",
        href: "/cases",
        icon: <IconFileCheck size={18} className="text-amber-600" />,
      },
      {
        step: 3,
        title: "Checklist Engine",
        subtitle: "Malaysian statutory rules",
        href: "/cases/rules",
        icon: <IconLegalAI size={18} className="text-blue-600" />,
        badge: "Deterministic",
      },
      {
        step: 4,
        title: "RAG & Precedents",
        subtitle: "Past scanned case PDF search",
        href: "/documents",
        icon: <IconBrainAI size={18} className="text-purple-600" />,
        badge: "Bilingual",
      },
      {
        step: 5,
        title: "1-Click Court Pack",
        subtitle: "Affidavits, orders, PDF dossier",
        href: "/cases",
        icon: <IconAward size={18} className="text-emerald-600" />,
      },
    ],
    sideLinks: [
      { label: "All Active Matters", href: "/cases" },
      { label: "Questions & Rules", href: "/cases/rules" },
      { label: "Document Templates", href: "/cases/templates" },
      { label: "Document Library", href: "/documents" },
    ],
  },
};

export function WorkflowNavigator({ defaultTab = "sales" }: { defaultTab?: FlowTab }) {
  const [activeTab, setActiveTab] = useState<FlowTab>(defaultTab);
  const flow = FLOWS[activeTab];

  return (
    <div className="plate rounded-xl p-5 sm:p-6 bg-white border border-slate-200 shadow-xs">
      {/* Top Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          {(["sales", "purchases", "gl", "hrms", "legal"] as FlowTab[]).map((tab) => {
            const f = FLOWS[tab];
            const isActive = activeTab === tab;
            return (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition cursor-pointer ${
                  isActive
                    ? "bg-slate-900 text-white font-semibold shadow-xs"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                {tab === "sales" && <IconQuote size={14} />}
                {tab === "purchases" && <IconBill size={14} />}
                {tab === "gl" && <IconJournal size={14} />}
                {tab === "hrms" && <IconHRMS size={14} />}
                {tab === "legal" && <IconLegalAI size={14} />}
                <span>{f.label}</span>
              </button>
            );
          })}
        </div>

        <span className="text-[11px] text-slate-400 font-mono">
          AutoCount Workflow Engine
        </span>
      </div>

      {/* Header Info */}
      <div className="mt-4 mb-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-display text-[16px] font-semibold text-slate-900">
            {flow.title}
          </h3>
          <span className="text-[11px] font-mono uppercase tracking-wider text-amber-700 font-semibold bg-amber-50 border border-amber-200 px-2.5 py-0.5 rounded-full">
            Stage-driven process
          </span>
        </div>
        <p className="mt-1 text-[12.5px] text-slate-600">{flow.description}</p>
      </div>

      {/* Visual Flow Nodes */}
      <div className="overflow-x-auto pb-2 pt-1">
        <div className="flex min-w-[700px] items-stretch gap-3">
          {flow.steps.map((step, idx) => (
            <div key={step.title} className="flex flex-1 items-center gap-3">
              <div className="group relative flex flex-1 flex-col justify-between rounded-xl border border-slate-200 bg-slate-50/50 p-4 transition-all duration-200 hover:border-slate-400 hover:bg-white hover:shadow-md hover:-translate-y-0.5">
                <div>
                  <div className="flex items-center justify-between gap-2 mb-2.5">
                    <span className="grid h-6 w-6 place-items-center rounded-md bg-slate-900 text-[11px] font-bold text-white shadow-xs">
                      {step.step}
                    </span>
                    <div className="flex items-center gap-1.5">
                      {step.badge && (
                        <span className="rounded bg-blue-50 border border-blue-200 px-1.5 py-0.5 text-[9.5px] font-medium text-blue-700">
                          {step.badge}
                        </span>
                      )}
                      <div className="p-1 rounded-md bg-white border border-slate-200 shadow-2xs">
                        {step.icon}
                      </div>
                    </div>
                  </div>

                  <h4 className="text-[13.5px] font-semibold text-slate-900 group-hover:text-amber-700 transition">
                    {step.title}
                  </h4>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-slate-500 line-clamp-2">
                    {step.subtitle}
                  </p>
                </div>

                <div className="mt-4 flex items-center gap-2 border-t border-slate-200 pt-3">
                  <Link
                    href={step.href}
                    prefetch={true}
                    className="flex-1 rounded-md px-2.5 py-1.5 text-center text-[11.5px] font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 hover:text-slate-900 transition"
                  >
                    Open list
                  </Link>
                  {step.newHref && (
                    <Link
                      href={step.newHref}
                      prefetch={true}
                      className="grid h-7 w-7 place-items-center rounded-md bg-amber-500 text-white hover:bg-amber-600 transition shadow-xs"
                      title={`New ${step.title}`}
                    >
                      <IconPlus size={13} strokeWidth={2.5} />
                    </Link>
                  )}
                </div>
              </div>

              {idx < flow.steps.length - 1 && (
                <div className="flex shrink-0 items-center justify-center text-slate-300">
                  <IconArrowRight size={16} />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Auxiliary / Related Shortcuts */}
      {flow.sideLinks && flow.sideLinks.length > 0 && (
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3.5">
          <span className="text-[11.5px] text-slate-500 font-medium mr-1">
            Related modules:
          </span>
          {flow.sideLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              prefetch={true}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-3 py-1 text-[12px] text-slate-700 hover:border-slate-400 hover:bg-slate-50 hover:text-slate-900 transition shadow-2xs font-medium"
            >
              <span>{link.label}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
