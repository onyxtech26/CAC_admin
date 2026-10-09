"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  IconBill,
  IconCase,
  IconChevronDown,
  IconInvoice,
  IconJournal,
  IconPlus,
  IconQuote,
  IconReceipt,
  IconUserPlus,
  IconVoucher,
} from "./icons";

interface QuickAction {
  title: string;
  category: "Accounting" | "HRMS" | "Legal AI";
  href: string;
  icon: React.ReactNode;
}

const ACTIONS: QuickAction[] = [
  {
    title: "New Quotation",
    category: "Accounting",
    href: "/accounting/quotations/new",
    icon: <IconQuote size={15} className="text-amber-600" />,
  },
  {
    title: "New Customer Invoice",
    category: "Accounting",
    href: "/accounting/invoices/new",
    icon: <IconInvoice size={15} className="text-amber-600" />,
  },
  {
    title: "Record Receipt",
    category: "Accounting",
    href: "/accounting/receipts/new",
    icon: <IconReceipt size={15} className="text-emerald-600" />,
  },
  {
    title: "New Supplier Bill",
    category: "Accounting",
    href: "/accounting/bills/new",
    icon: <IconBill size={15} className="text-amber-600" />,
  },
  {
    title: "New Payment Voucher",
    category: "Accounting",
    href: "/accounting/vouchers/new",
    icon: <IconVoucher size={15} className="text-emerald-600" />,
  },
  {
    title: "New Journal Entry",
    category: "Accounting",
    href: "/accounting/journals/new",
    icon: <IconJournal size={15} className="text-blue-600" />,
  },
  {
    title: "Add Employee",
    category: "HRMS",
    href: "/hr/employees/new",
    icon: <IconUserPlus size={15} className="text-blue-600" />,
  },
  {
    title: "Import Attendance Scans",
    category: "HRMS",
    href: "/hr/attendance/import",
    icon: <IconUserPlus size={15} className="text-emerald-600" />,
  },
  {
    title: "Apply Leave",
    category: "HRMS",
    href: "/hr/leave",
    icon: <IconUserPlus size={15} className="text-amber-600" />,
  },
  {
    title: "Generate HR Letter",
    category: "HRMS",
    href: "/hr/letters",
    icon: <IconUserPlus size={15} className="text-blue-600" />,
  },
  {
    title: "New Estate Matter (LA / Probate)",
    category: "Legal AI",
    href: "/cases",
    icon: <IconCase size={15} className="text-purple-600" />,
  },
  {
    title: "Upload Case PDF (RAG Knowledge)",
    category: "Legal AI",
    href: "/documents",
    icon: <IconCase size={15} className="text-purple-600" />,
  },
];

export function QuickActionMenu() {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open]);

  return (
    <div className="relative inline-block text-left" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-[12.5px] font-medium text-slate-800 hover:bg-slate-50 hover:border-slate-400 transition-all duration-150 cursor-pointer shadow-xs"
        aria-expanded={open}
        aria-haspopup="true"
      >
        <span className="grid h-4 w-4 place-items-center rounded bg-amber-500 text-white font-bold">
          <IconPlus size={12} strokeWidth={3} />
        </span>
        <span className="hidden sm:inline">Quick Action</span>
        <IconChevronDown size={14} className="text-slate-500" />
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-72 rounded-xl border border-slate-200 bg-white p-2 shadow-xl ring-1 ring-black/5">
          <div className="border-b border-slate-100 px-3 py-2">
            <p className="font-display text-[13px] font-semibold text-slate-900">
              Fast Creation Deck
            </p>
            <p className="text-[11px] text-slate-500">
              Jump straight to document creation
            </p>
          </div>

          <div className="max-h-80 overflow-y-auto py-1 divide-y divide-slate-100">
            {(["Accounting", "HRMS", "Legal AI"] as const).map((cat) => {
              const items = ACTIONS.filter((a) => a.category === cat);
              return (
                <div key={cat} className="py-1.5">
                  <span className="px-3 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400 font-mono">
                    {cat}
                  </span>
                  <div className="mt-1 space-y-0.5">
                    {items.map((action) => (
                      <Link
                        key={action.title}
                        href={action.href}
                        prefetch={true}
                        onClick={() => setOpen(false)}
                        className="flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-[12.5px] text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition-colors"
                      >
                        <span className="shrink-0">{action.icon}</span>
                        <span>{action.title}</span>
                      </Link>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
