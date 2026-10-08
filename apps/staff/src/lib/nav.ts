import type { Principal } from "@cac/core";

/**
 * The internal navigation.
 *
 * Grouped the way AutoCount groups it: G/L, A/R, A/P, and HR in the order its setup
 * actually runs, plus Legal AI and Administration.
 */

export type AppSuite = "all" | "accounting" | "hrms" | "legal" | "admin";

export interface NavItem {
  label: string;
  href: string;
  capabilities: string[];
  icon?: string;
  /** Set when the module is not yet implemented. */
  phase?: number;
}

export interface NavSection {
  heading: string;
  suite: "overview" | "accounting" | "hrms" | "legal" | "admin";
  icon?: string;
  items: NavItem[];
}

export const SUITE_METADATA: Record<
  AppSuite,
  { label: string; href: string; description: string; icon: string }
> = {
  all: {
    label: "All Suites",
    href: "/",
    description: "Executive platform command center",
    icon: "dashboard",
  },
  accounting: {
    label: "AutoCount Accounting",
    href: "/accounting",
    description: "Sales, Purchases, G/L, Bank & Financial Reports",
    icon: "accounting",
  },
  hrms: {
    label: "AutoCount HRMS",
    href: "/hr",
    description: "Employees, Attendance, Leave, Payroll & Statutory",
    icon: "hrms",
  },
  legal: {
    label: "Legal AI & Forensics",
    href: "/cases",
    description: "Estate matters, Probate rules & AI contradiction agent",
    icon: "legal",
  },
  admin: {
    label: "Administration",
    href: "/admin",
    description: "Users, Roles, Settings & Audit Logs",
    icon: "admin",
  },
};

export const NAVIGATION: NavSection[] = [
  {
    heading: "Overview",
    suite: "overview",
    icon: "dashboard",
    items: [
      { label: "Dashboard", href: "/", capabilities: [], icon: "dashboard" },
      { label: "Enquiries", href: "/enquiries", capabilities: ["crm.enquiry.view"], icon: "enquiry" },
    ],
  },

  /*
   * A/R — everything owed to CAC, in the order the work happens: quote it, bill it, collect it.
   */
  {
    heading: "Sales & receivables",
    suite: "accounting",
    icon: "quote",
    items: [
      { label: "Quotations", href: "/accounting/quotations", capabilities: ["accounting.quotation.view"], icon: "quote" },
      { label: "Invoices", href: "/accounting/invoices", capabilities: ["accounting.invoice.view"], icon: "invoice" },
      { label: "Receipts", href: "/accounting/receipts", capabilities: ["accounting.receipt.view"], icon: "receipt" },
      { label: "Customers", href: "/accounting/customers", capabilities: ["accounting.customer.view"], icon: "users" },
      { label: "Receivables aging", href: "/accounting/reports/aging", capabilities: ["accounting.report.view"], icon: "chart" },
      { label: "e-Invoice (MyInvois)", href: "/accounting/einvoice", capabilities: ["accounting.einvoice.view"], icon: "check" },
    ],
  },

  /*
   * A/P — everything CAC owes.
   */
  {
    heading: "Purchases & payables",
    suite: "accounting",
    icon: "bill",
    items: [
      { label: "Purchase orders", href: "/accounting/purchase-orders", capabilities: ["accounting.po.view"], icon: "bill" },
      { label: "Supplier bills", href: "/accounting/bills", capabilities: ["accounting.bill.view"], icon: "invoice" },
      { label: "Payment vouchers", href: "/accounting/vouchers", capabilities: ["accounting.voucher.view"], icon: "voucher" },
      { label: "Expense claims", href: "/accounting/claims", capabilities: ["accounting.claim.view"], icon: "receipt" },
      { label: "Petty cash", href: "/accounting/petty-cash", capabilities: ["accounting.pettycash.view"], icon: "wallet" },
      { label: "Suppliers", href: "/accounting/suppliers", capabilities: ["accounting.supplier.view"], icon: "building" },
      { label: "Payables aging", href: "/accounting/reports/payables-aging", capabilities: ["accounting.report.view"], icon: "chart" },
    ],
  },

  /*
   * G/L — the ledger itself and the statements that come out of it.
   */
  {
    heading: "General ledger",
    suite: "accounting",
    icon: "accounting",
    items: [
      { label: "G/L Overview", href: "/accounting", capabilities: ["accounting.journal.view"], icon: "accounting" },
      { label: "Chart of accounts", href: "/accounting/accounts", capabilities: ["accounting.coa.view"], icon: "building" },
      { label: "Journal entries", href: "/accounting/journals", capabilities: ["accounting.journal.view"], icon: "journal" },
      { label: "Bank reconciliation", href: "/accounting/bank", capabilities: ["accounting.bank.view"], icon: "bank" },
      { label: "Fiscal calendar", href: "/accounting/periods", capabilities: ["accounting.period.view"], icon: "calendar" },
      { label: "Tax codes", href: "/accounting/tax", capabilities: ["accounting.tax.view"], icon: "tax" },
      { label: "Trial balance", href: "/accounting/reports/trial-balance", capabilities: ["accounting.report.view"], icon: "chart" },
      { label: "Profit and loss", href: "/accounting/reports/profit-and-loss", capabilities: ["accounting.report.view"], icon: "chart" },
      { label: "Balance sheet", href: "/accounting/reports/balance-sheet", capabilities: ["accounting.report.view"], icon: "chart" },
      { label: "Revenue by matter", href: "/accounting/reports/by-matter", capabilities: ["accounting.report.view"], icon: "chart" },
    ],
  },

  /*
   * HR, in AutoCount HRMS's setup order
   */
  {
    heading: "Human resources",
    suite: "hrms",
    icon: "hrms",
    items: [
      { label: "HRMS Overview", href: "/hr", capabilities: ["hr.employee.view", "hr.leave.view", "hr.leave.request"], icon: "hrms" },
      { label: "Organisation", href: "/hr/organisation", capabilities: ["hr.org.view"], icon: "building" },
      { label: "Public holidays", href: "/hr/holidays", capabilities: ["hr.org.view"], icon: "calendar" },
      { label: "Employees", href: "/hr/employees", capabilities: ["hr.employee.view"], icon: "users" },
      { label: "Attendance", href: "/hr/attendance", capabilities: ["hr.attendance.view"], icon: "clock" },
      { label: "Leave", href: "/hr/leave", capabilities: ["hr.leave.view", "hr.leave.request"], icon: "calendar" },
      { label: "Overtime & time off", href: "/hr/overtime", capabilities: ["hr.overtime.view", "hr.overtime.request"], icon: "clock" },
      { label: "Payroll", href: "/hr/payroll", capabilities: ["hr.payroll.view"], icon: "payroll" },
      { label: "Payslips", href: "/hr/payslips", capabilities: ["hr.payslip.view_own", "hr.payslip.view_all"], icon: "payslip" },
      { label: "Statutory rates", href: "/hr/statutory", capabilities: ["hr.statutory.view"], icon: "tax" },
      { label: "Appraisals", href: "/hr/appraisals", capabilities: ["hr.appraisal.view"], icon: "award" },
      { label: "Letters", href: "/hr/letters", capabilities: ["hr.letter.generate"], icon: "letters" },
    ],
  },

  {
    heading: "Legal AI & Cases",
    suite: "legal",
    icon: "legal",
    items: [
      { label: "Matters & AI Hub", href: "/cases", capabilities: ["case.view", "case.view_all"], icon: "case" },
      { label: "Questions and rules", href: "/cases/rules", capabilities: ["case.rule.view"], icon: "check" },
      { label: "Document templates", href: "/cases/templates", capabilities: ["case.document.generate"], icon: "letters" },
    ],
  },
  {
    heading: "Documents",
    suite: "legal",
    icon: "folder",
    items: [{ label: "Document library", href: "/documents", capabilities: ["doc.view"], icon: "folder" }],
  },
  {
    heading: "Administration",
    suite: "admin",
    icon: "admin",
    items: [
      {
        label: "Admin Hub",
        href: "/admin",
        capabilities: ["admin.user.manage", "admin.role.manage", "admin.settings.manage", "admin.integration.manage", "audit.view"],
        icon: "admin",
      },
      { label: "Users", href: "/admin/users", capabilities: ["admin.user.manage"], icon: "users" },
      { label: "Roles & permissions", href: "/admin/roles", capabilities: ["admin.role.manage"], icon: "check" },
      { label: "Settings", href: "/admin/settings", capabilities: ["admin.settings.manage"], icon: "admin" },
      { label: "Integrations", href: "/admin/integrations", capabilities: ["admin.integration.manage"], icon: "check" },
      { label: "Audit trail", href: "/admin/audit", capabilities: ["audit.view"], icon: "journal" },
    ],
  },
];

export function visibleNavigation(
  principal: Principal,
  suiteFilter: AppSuite = "all",
): NavSection[] {
  return NAVIGATION.filter((section) => {
    if (suiteFilter === "all") return true;
    if (section.heading === "Overview") return true;
    return section.suite === suiteFilter;
  })
    .map((section) => ({
      ...section,
      items: section.items.filter(
        (item) =>
          item.capabilities.length === 0 ||
          item.capabilities.some((c) => principal.capabilities.has(c)),
      ),
    }))
    .filter((section) => section.items.length > 0);
}
