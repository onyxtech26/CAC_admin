import type { Principal } from "@cac/core";

/**
 * The internal navigation.
 *
 * **Grouped the way AutoCount groups it**, because AutoCount is what CAC's staff, CAC's accountant
 * and whoever audits CAC already have in their heads: G/L, A/R, A/P, and HR in the order its setup
 * actually runs. The previous arrangement was nineteen accounting screens in one flat list, in the
 * order they happened to be built. See docs/AUTOCOUNT_ALIGNMENT.md for the research, what was
 * adopted, and — with reasons — what was not.
 *
 * Two departures from AutoCount, both deliberate:
 *
 * - AutoCount lists an invoice under both **Sales** and **A/R**, because in its world those are
 *   different documents: one moves stock, one does not. CAC sells professional time and has no
 *   stock, so there is one invoice and one menu. Splitting it would be copying a distinction that
 *   does not exist here.
 * - There is no **Stock** menu, no Delivery Order and no Goods Received Note. CAC holds no
 *   inventory. A stock menu with nothing in it is a menu that lies.
 *
 * Each entry declares the capabilities that make it relevant; an item is shown only when the caller
 * holds at least one of them. Items for modules that are not built yet are present with `phase`, so
 * the menu doubles as an honest statement of where the platform actually is — rather than a set of
 * links that lead nowhere. The dashboard's "what is live" panel reads the same field, so the two
 * cannot disagree.
 *
 * Filtering here is presentation only. The route itself is protected server-side by
 * requireCapability; hiding the link is not the control.
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
    items: [
      { label: "Dashboard", href: "/", capabilities: [] },
      // Where the website's enquiry form arrives. High in the list on purpose: an enquiry nobody
      // looks at is a client who went elsewhere.
      { label: "Enquiries", href: "/enquiries", capabilities: ["crm.enquiry.view"] },
    ],
  },

  /*
   * A/R — everything owed to CAC, in the order the work happens: quote it, bill it, collect it.
   * AutoCount's A/R menu is Debtor Maintenance, Invoice Entry, Payment Receipt, then Aging and
   * Statement; this is that, with the customer list at the end rather than the beginning because
   * nobody starts their day there.
   */
  {
    heading: "Sales & receivables",
    items: [
      { label: "Quotations", href: "/accounting/quotations", capabilities: ["accounting.quotation.view"] },
      { label: "Invoices", href: "/accounting/invoices", capabilities: ["accounting.invoice.view"] },
      { label: "Receipts", href: "/accounting/receipts", capabilities: ["accounting.receipt.view"] },
      { label: "Customers", href: "/accounting/customers", capabilities: ["accounting.customer.view"] },
      { label: "Receivables aging", href: "/accounting/reports/aging", capabilities: ["accounting.report.view"] },
      { label: "e-Invoice (MyInvois)", href: "/accounting/einvoice", capabilities: ["accounting.einvoice.view"] },
    ],
  },

  /*
   * A/P — everything CAC owes. AutoCount mirrors A/R exactly here, and the mirror is the point:
   * an accountant who has learned one side has learned the other. CAC's is not yet a full mirror
   * — there is no supplier invoice document and so no payables aging (gaps A1 and A2 in
   * docs/AUTOCOUNT_ALIGNMENT.md). What is here is ordered the same way regardless.
   */
  {
    heading: "Purchases & payables",
    items: [
      { label: "Purchase orders", href: "/accounting/purchase-orders", capabilities: ["accounting.po.view"] },
      { label: "Supplier bills", href: "/accounting/bills", capabilities: ["accounting.bill.view"] },
      { label: "Payment vouchers", href: "/accounting/vouchers", capabilities: ["accounting.voucher.view"] },
      { label: "Expense claims", href: "/accounting/claims", capabilities: ["accounting.claim.view"] },
      { label: "Petty cash", href: "/accounting/petty-cash", capabilities: ["accounting.pettycash.view"] },
      { label: "Suppliers", href: "/accounting/suppliers", capabilities: ["accounting.supplier.view"] },
      { label: "Payables aging", href: "/accounting/reports/payables-aging", capabilities: ["accounting.report.view"] },
    ],
  },

  /*
   * G/L — the ledger itself and the statements that come out of it. AutoCount's G/L menu in the
   * same order: accounts, entries, bank, then the reports.
   */
  {
    heading: "General ledger",
    items: [
      { label: "Overview", href: "/accounting", capabilities: ["accounting.journal.view"] },
      { label: "Chart of accounts", href: "/accounting/accounts", capabilities: ["accounting.coa.view"] },
      { label: "Journal entries", href: "/accounting/journals", capabilities: ["accounting.journal.view"] },
      { label: "Bank reconciliation", href: "/accounting/bank", capabilities: ["accounting.bank.view"] },
      { label: "Fiscal calendar", href: "/accounting/periods", capabilities: ["accounting.period.view"] },
      { label: "Tax codes", href: "/accounting/tax", capabilities: ["accounting.tax.view"] },

      { label: "Trial balance", href: "/accounting/reports/trial-balance", capabilities: ["accounting.report.view"] },
      { label: "Profit and loss", href: "/accounting/reports/profit-and-loss", capabilities: ["accounting.report.view"] },
      { label: "Balance sheet", href: "/accounting/reports/balance-sheet", capabilities: ["accounting.report.view"] },
      // No AutoCount equivalent. CAC's analytical dimension is the matter, not a project code.
      { label: "Revenue by matter", href: "/accounting/reports/by-matter", capabilities: ["accounting.report.view"] },
    ],
  },

  /*
   * HR, in AutoCount HRMS's setup order rather than alphabetically — because that order is the
   * order the dependencies run in. Company and calendar before people; people before attendance;
   * attendance before payroll; payroll before payslips and statutory.
   */
  {
    heading: "Human resources",
    items: [
      { label: "Organisation", href: "/hr/organisation", capabilities: ["hr.org.view"] },
      { label: "Public holidays", href: "/hr/holidays", capabilities: ["hr.org.view"] },
      { label: "Employees", href: "/hr/employees", capabilities: ["hr.employee.view"] },

      { label: "Attendance", href: "/hr/attendance", capabilities: ["hr.attendance.view"] },
      { label: "Leave", href: "/hr/leave", capabilities: ["hr.leave.view", "hr.leave.request"] },
      { label: "Overtime & time off", href: "/hr/overtime", capabilities: ["hr.overtime.view", "hr.overtime.request"] },

      { label: "Payroll", href: "/hr/payroll", capabilities: ["hr.payroll.view"] },
      { label: "Payslips", href: "/hr/payslips", capabilities: ["hr.payslip.view_own", "hr.payslip.view_all"] },
      { label: "Statutory rates", href: "/hr/statutory", capabilities: ["hr.statutory.view"] },

      { label: "Appraisals", href: "/hr/appraisals", capabilities: ["hr.appraisal.view"] },
      { label: "Letters", href: "/hr/letters", capabilities: ["hr.letter.generate"] },
    ],
  },

  {
    heading: "Cases",
    items: [
      { label: "All cases", href: "/cases", capabilities: ["case.view", "case.view_all"] },
      { label: "Questions and rules", href: "/cases/rules", capabilities: ["case.rule.view"] },
      { label: "Document templates", href: "/cases/templates", capabilities: ["case.document.generate"] },
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
      {
        label: "Integrations",
        href: "/admin/integrations",
        capabilities: ["admin.integration.manage"],
      },
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
