import type { Principal } from "@cac/core";

/**
 * The internal navigation.
 *
 * Each entry declares the capabilities that make it relevant; an item is shown
 * only when the caller holds at least one of them. Items for modules that are
 * not built yet are present with `phase`, so the menu doubles as an honest
 * statement of where the platform actually is — rather than a set of links
 * that lead nowhere.
 *
 * Filtering here is presentation only. The route itself is protected
 * server-side by requireCapability; hiding the link is not the control.
 */

export interface NavItem {
  label: string;
  href: string;
  capabilities: string[];
  /** Set when the module is not yet implemented. */
  phase?: number;
}

export interface NavSection {
  heading: string;
  items: NavItem[];
}

export const NAVIGATION: NavSection[] = [
  {
    heading: "Overview",
    items: [{ label: "Dashboard", href: "/", capabilities: [] }],
  },
  {
    heading: "Accounting",
    items: [
      { label: "Overview", href: "/accounting", capabilities: ["accounting.journal.view"] },

      // Day to day, in the order the work happens.
      { label: "Quotations", href: "/accounting/quotations", capabilities: ["accounting.quotation.view"] },
      { label: "Invoices", href: "/accounting/invoices", capabilities: ["accounting.invoice.view"] },
      { label: "Receipts", href: "/accounting/receipts", capabilities: ["accounting.receipt.view"] },
      { label: "Payment vouchers", href: "/accounting/vouchers", capabilities: ["accounting.voucher.view"] },
      { label: "Purchase orders", href: "/accounting/purchase-orders", capabilities: ["accounting.po.view"] },
      { label: "Petty cash", href: "/accounting/petty-cash", capabilities: ["accounting.pettycash.view"] },
      { label: "Claims", href: "/accounting/claims", capabilities: ["accounting.claim.view"] },

      { label: "Customers", href: "/accounting/customers", capabilities: ["accounting.customer.view"] },
      { label: "Suppliers", href: "/accounting/suppliers", capabilities: ["accounting.supplier.view"] },

      // The ledger itself.
      { label: "Journals", href: "/accounting/journals", capabilities: ["accounting.journal.view"] },
      { label: "Chart of accounts", href: "/accounting/accounts", capabilities: ["accounting.coa.view"] },
      { label: "Fiscal calendar", href: "/accounting/periods", capabilities: ["accounting.period.view"] },
      { label: "Tax", href: "/accounting/tax", capabilities: ["accounting.tax.view"] },

      // Reports.
      { label: "Trial balance", href: "/accounting/reports/trial-balance", capabilities: ["accounting.report.view"] },
      { label: "Profit and loss", href: "/accounting/reports/profit-and-loss", capabilities: ["accounting.report.view"] },
      { label: "Balance sheet", href: "/accounting/reports/balance-sheet", capabilities: ["accounting.report.view"] },
      { label: "Receivables aging", href: "/accounting/reports/aging", capabilities: ["accounting.report.view"] },

      { label: "Bank reconciliation", href: "/accounting/bank", capabilities: ["accounting.bank.view"] },
      { label: "e-Invoice (MyInvois)", href: "/accounting/einvoice", capabilities: ["accounting.einvoice.view"] },
    ],
  },
  {
    heading: "Human resources",
    items: [
      { label: "Employees", href: "/hr/employees", capabilities: ["hr.employee.view"] },
      { label: "Organisation", href: "/hr/organisation", capabilities: ["hr.org.view"] },
      { label: "Attendance", href: "/hr/attendance", capabilities: ["hr.attendance.view"] },
      { label: "Public holidays", href: "/hr/holidays", capabilities: ["hr.org.view"] },
      { label: "Leave", href: "/hr/leave", capabilities: ["hr.leave.view", "hr.leave.request"] },
      { label: "Overtime", href: "/hr/overtime", capabilities: ["hr.overtime.view", "hr.overtime.request"] },
      { label: "Appraisals", href: "/hr/appraisals", capabilities: ["hr.appraisal.view"] },
      { label: "Payroll", href: "/hr/payroll", capabilities: ["hr.payroll.view"] },
      { label: "Payslips", href: "/hr/payslips", capabilities: ["hr.payslip.view_own", "hr.payslip.view_all"] },
      { label: "Statutory rules", href: "/hr/statutory", capabilities: ["hr.statutory.view"] },
      { label: "Letters", href: "/hr/letters", capabilities: ["hr.letter.generate"] },
    ],
  },
  {
    heading: "Cases",
    items: [
      { label: "All cases", href: "/cases", capabilities: ["case.view", "case.view_all"] },
      { label: "Questions and rules", href: "/cases/rules", capabilities: ["case.rule.view"] },
      { label: "Templates", href: "/cases/templates", capabilities: ["template.view"], phase: 12 },
    ],
  },
  {
    heading: "Documents",
    items: [{ label: "Document library", href: "/documents", capabilities: ["doc.view"] }],
  },
  {
    heading: "Administration",
    items: [
      { label: "Users", href: "/admin/users", capabilities: ["admin.user.manage"] },
      { label: "Roles & permissions", href: "/admin/roles", capabilities: ["admin.role.manage"] },
      { label: "Settings", href: "/admin/settings", capabilities: ["admin.settings.manage"] },
      { label: "Audit trail", href: "/admin/audit", capabilities: ["audit.view"] },
    ],
  },
  {
    heading: "Account",
    items: [{ label: "My account", href: "/account", capabilities: [] }],
  },
];

export function visibleNavigation(principal: Principal): NavSection[] {
  return NAVIGATION.map((section) => ({
    heading: section.heading,
    items: section.items.filter(
      (item) =>
        item.capabilities.length === 0 ||
        item.capabilities.some((c) => principal.capabilities.has(c)),
    ),
  })).filter((section) => section.items.length > 0);
}
