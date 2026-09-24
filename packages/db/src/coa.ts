/**
 * The default chart of accounts.
 *
 * Built for what CAC actually does — property forensic investigation, land and
 * title work, estate administration, valuation and advisory — operating as a
 * Malaysian company. It is a *starting* chart: accounts can be added, renamed
 * and deactivated from the application. The `system` ones cannot, because other
 * modules resolve them by code (payroll posts to 6150, receipts clear 1210),
 * and renumbering them under a running ledger would break those postings.
 *
 * Statutory payables are separate accounts per contribution type rather than
 * one "statutory" bucket: EPF, SOCSO, EIS and PCB are remitted to different
 * bodies on different dates, and reconciling one lump sum against four
 * statements is the sort of thing that makes month-end miserable.
 *
 * Nothing here asserts a tax rate. See TAX_CODES below.
 */

export interface AccountSeed {
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  /** A heading: groups other accounts, cannot be posted to. */
  header?: boolean;
  parent?: string;
  /** Opposite normal side to its type: accumulated depreciation, fee rebates. */
  contra?: boolean;
  /** Referenced by code from other modules; protected from renumbering. */
  system?: boolean;
  subtype?: string;
  description?: string;
}

export const CHART_OF_ACCOUNTS: AccountSeed[] = [
  // -------------------------------------------------------------------------
  // Assets
  // -------------------------------------------------------------------------
  { code: "1000", name: "Assets", type: "ASSET", header: true },

  { code: "1100", name: "Non-current assets", type: "ASSET", header: true, parent: "1000" },
  { code: "1110", name: "Office equipment", type: "ASSET", parent: "1100", subtype: "fixed_asset" },
  { code: "1111", name: "Accumulated depreciation - office equipment", type: "ASSET", parent: "1100", contra: true, subtype: "accumulated_depreciation" },
  { code: "1120", name: "Computer equipment", type: "ASSET", parent: "1100", subtype: "fixed_asset" },
  { code: "1121", name: "Accumulated depreciation - computer equipment", type: "ASSET", parent: "1100", contra: true, subtype: "accumulated_depreciation" },
  { code: "1130", name: "Motor vehicles", type: "ASSET", parent: "1100", subtype: "fixed_asset" },
  { code: "1131", name: "Accumulated depreciation - motor vehicles", type: "ASSET", parent: "1100", contra: true, subtype: "accumulated_depreciation" },
  { code: "1140", name: "Furniture and fittings", type: "ASSET", parent: "1100", subtype: "fixed_asset" },
  { code: "1141", name: "Accumulated depreciation - furniture and fittings", type: "ASSET", parent: "1100", contra: true, subtype: "accumulated_depreciation" },
  { code: "1150", name: "Renovation", type: "ASSET", parent: "1100", subtype: "fixed_asset" },
  { code: "1151", name: "Accumulated depreciation - renovation", type: "ASSET", parent: "1100", contra: true, subtype: "accumulated_depreciation" },

  { code: "1200", name: "Current assets", type: "ASSET", header: true, parent: "1000" },
  {
    code: "1210",
    name: "Trade receivables",
    type: "ASSET",
    parent: "1200",
    system: true,
    subtype: "receivable_control",
    description:
      "Accounts receivable control. Every issued invoice debits this account and every allocated receipt credits it, so its balance must always equal the sum of outstanding invoices.",
  },
  { code: "1215", name: "Other receivables", type: "ASSET", parent: "1200" },
  { code: "1220", name: "Deposits", type: "ASSET", parent: "1200" },
  { code: "1225", name: "Prepayments", type: "ASSET", parent: "1200" },
  {
    code: "1230",
    name: "Accrued revenue - work in progress",
    type: "ASSET",
    parent: "1200",
    description: "Fees earned on assignments not yet invoiced.",
  },
  { code: "1235", name: "Recoverable disbursements", type: "ASSET", parent: "1200", description: "Search fees, court fees and other costs paid on a client's behalf and recoverable from them." },
  { code: "1240", name: "Amount due from related parties", type: "ASSET", parent: "1200" },

  { code: "1250", name: "Cash and bank", type: "ASSET", header: true, parent: "1200" },
  { code: "1251", name: "Cash at bank - operating account", type: "ASSET", parent: "1250", system: true, subtype: "bank" },
  {
    code: "1252",
    name: "Cash at bank - client account",
    type: "ASSET",
    parent: "1250",
    subtype: "bank",
    description:
      "Monies held for clients on estate and conveyancing matters. Its balance must always equal account 2170. Never used to settle the company's own expenses.",
  },
  { code: "1255", name: "Petty cash", type: "ASSET", parent: "1250", system: true, subtype: "cash" },
  { code: "1256", name: "Undeposited receipts", type: "ASSET", parent: "1250", system: true, subtype: "cash", description: "Cash and cheques received but not yet banked." },

  {
    code: "1260",
    name: "SST input tax recoverable",
    type: "ASSET",
    parent: "1200",
    system: true,
    subtype: "tax",
    description: "Used only while the company is SST registered. See setting tax.sst_registered.",
  },
  {
    code: "1290",
    name: "Suspense",
    type: "ASSET",
    parent: "1200",
    system: true,
    description:
      "Temporary home for amounts that cannot yet be classified, typically unidentified bank credits. A balance here is a to-do list, not a result: it should be empty at period close.",
  },

  // -------------------------------------------------------------------------
  // Liabilities
  // -------------------------------------------------------------------------
  { code: "2000", name: "Liabilities", type: "LIABILITY", header: true },

  { code: "2100", name: "Current liabilities", type: "LIABILITY", header: true, parent: "2000" },
  {
    code: "2110",
    name: "Trade payables",
    type: "LIABILITY",
    parent: "2100",
    system: true,
    subtype: "payable_control",
    description: "Accounts payable control. Balance equals the sum of unpaid supplier invoices.",
  },
  { code: "2115", name: "Other payables", type: "LIABILITY", parent: "2100" },
  { code: "2120", name: "Accruals", type: "LIABILITY", parent: "2100" },
  { code: "2125", name: "Advance fees received", type: "LIABILITY", parent: "2100", description: "Fees received before the work is performed. Revenue only when earned." },
  {
    code: "2130",
    name: "SST output tax payable",
    type: "LIABILITY",
    parent: "2100",
    system: true,
    subtype: "tax",
    description: "Used only while the company is SST registered. See setting tax.sst_registered.",
  },

  { code: "2140", name: "Statutory payables", type: "LIABILITY", header: true, parent: "2100" },
  { code: "2141", name: "EPF payable", type: "LIABILITY", parent: "2140", system: true, subtype: "statutory" },
  { code: "2142", name: "SOCSO payable", type: "LIABILITY", parent: "2140", system: true, subtype: "statutory" },
  { code: "2143", name: "EIS payable", type: "LIABILITY", parent: "2140", system: true, subtype: "statutory" },
  { code: "2144", name: "PCB (monthly tax deduction) payable", type: "LIABILITY", parent: "2140", system: true, subtype: "statutory" },
  { code: "2145", name: "HRD Corp levy payable", type: "LIABILITY", parent: "2140", system: true, subtype: "statutory" },
  { code: "2146", name: "Zakat payable", type: "LIABILITY", parent: "2140", subtype: "statutory" },

  { code: "2150", name: "Salaries and wages payable", type: "LIABILITY", parent: "2100", system: true },
  { code: "2155", name: "Staff claims payable", type: "LIABILITY", parent: "2100", system: true },
  { code: "2160", name: "Amount due to related parties", type: "LIABILITY", parent: "2100" },
  {
    code: "2170",
    name: "Client monies held in trust",
    type: "LIABILITY",
    parent: "2100",
    description: "The other side of account 1252. Client money is a liability, never income.",
  },

  { code: "2200", name: "Non-current liabilities", type: "LIABILITY", header: true, parent: "2000" },
  { code: "2210", name: "Hire purchase payable", type: "LIABILITY", parent: "2200" },
  { code: "2220", name: "Term loan", type: "LIABILITY", parent: "2200" },

  // -------------------------------------------------------------------------
  // Equity
  // -------------------------------------------------------------------------
  { code: "3000", name: "Equity", type: "EQUITY", header: true },
  { code: "3100", name: "Share capital", type: "EQUITY", parent: "3000" },
  { code: "3200", name: "Retained earnings", type: "EQUITY", parent: "3000", system: true },
  {
    code: "3900",
    name: "Opening balance equity",
    type: "EQUITY",
    parent: "3000",
    system: true,
    description:
      "Counterpart for opening balances brought in from the previous system. Cleared to retained earnings once the opening trial balance agrees; a balance here after go-live means the migration is unfinished.",
  },

  // -------------------------------------------------------------------------
  // Revenue
  // -------------------------------------------------------------------------
  { code: "4000", name: "Revenue", type: "REVENUE", header: true },

  { code: "4100", name: "Professional fees", type: "REVENUE", header: true, parent: "4000" },
  { code: "4110", name: "Property forensic investigation", type: "REVENUE", parent: "4100" },
  { code: "4120", name: "Land and title investigation", type: "REVENUE", parent: "4100" },
  { code: "4130", name: "Estate administration and probate services", type: "REVENUE", parent: "4100" },
  { code: "4140", name: "Property valuation and appraisal", type: "REVENUE", parent: "4100" },
  { code: "4150", name: "Advisory and consultancy", type: "REVENUE", parent: "4100" },
  { code: "4160", name: "Documentation and agency services", type: "REVENUE", parent: "4100" },

  { code: "4200", name: "Other income", type: "REVENUE", header: true, parent: "4000" },
  { code: "4210", name: "Disbursements recovered", type: "REVENUE", parent: "4200" },
  { code: "4220", name: "Interest income", type: "REVENUE", parent: "4200" },
  { code: "4230", name: "Gain on disposal of assets", type: "REVENUE", parent: "4200" },
  { code: "4290", name: "Sundry income", type: "REVENUE", parent: "4200" },

  { code: "4900", name: "Revenue adjustments", type: "REVENUE", header: true, parent: "4000" },
  { code: "4910", name: "Fee discounts and rebates", type: "REVENUE", parent: "4900", contra: true },
  { code: "4920", name: "Credit notes issued", type: "REVENUE", parent: "4900", contra: true, system: true },

  // -------------------------------------------------------------------------
  // Direct costs
  // -------------------------------------------------------------------------
  { code: "5000", name: "Direct costs", type: "EXPENSE", header: true },
  { code: "5110", name: "Land office and search fees", type: "EXPENSE", parent: "5000" },
  { code: "5120", name: "Court and filing fees", type: "EXPENSE", parent: "5000" },
  { code: "5130", name: "Subcontracted professional fees", type: "EXPENSE", parent: "5000" },
  { code: "5140", name: "Site inspection and survey costs", type: "EXPENSE", parent: "5000" },
  { code: "5150", name: "Assignment travel and transport", type: "EXPENSE", parent: "5000" },
  { code: "5160", name: "Reports, plans and printing - client work", type: "EXPENSE", parent: "5000" },
  { code: "5190", name: "Other direct costs", type: "EXPENSE", parent: "5000" },

  // -------------------------------------------------------------------------
  // Staff costs
  // -------------------------------------------------------------------------
  { code: "6000", name: "Staff costs", type: "EXPENSE", header: true },
  { code: "6110", name: "Salaries and wages", type: "EXPENSE", parent: "6000", system: true },
  { code: "6115", name: "Directors' remuneration", type: "EXPENSE", parent: "6000" },
  { code: "6120", name: "Overtime", type: "EXPENSE", parent: "6000", system: true },
  { code: "6125", name: "Bonus and incentives", type: "EXPENSE", parent: "6000", system: true },
  { code: "6130", name: "Allowances", type: "EXPENSE", parent: "6000", system: true },
  { code: "6150", name: "EPF - employer contribution", type: "EXPENSE", parent: "6000", system: true },
  { code: "6160", name: "SOCSO - employer contribution", type: "EXPENSE", parent: "6000", system: true },
  { code: "6165", name: "EIS - employer contribution", type: "EXPENSE", parent: "6000", system: true },
  { code: "6170", name: "HRD Corp levy", type: "EXPENSE", parent: "6000", system: true },
  { code: "6180", name: "Staff welfare", type: "EXPENSE", parent: "6000" },
  { code: "6185", name: "Staff medical and insurance", type: "EXPENSE", parent: "6000" },
  { code: "6190", name: "Staff training and development", type: "EXPENSE", parent: "6000" },

  // -------------------------------------------------------------------------
  // Administrative expenses
  // -------------------------------------------------------------------------
  { code: "7000", name: "Administrative expenses", type: "EXPENSE", header: true },
  { code: "7110", name: "Rental of premises", type: "EXPENSE", parent: "7000" },
  { code: "7115", name: "Utilities", type: "EXPENSE", parent: "7000" },
  { code: "7120", name: "Telephone and internet", type: "EXPENSE", parent: "7000" },
  { code: "7125", name: "Printing and stationery", type: "EXPENSE", parent: "7000" },
  { code: "7130", name: "Postage and courier", type: "EXPENSE", parent: "7000" },
  { code: "7135", name: "Office supplies", type: "EXPENSE", parent: "7000" },
  { code: "7140", name: "Repairs and maintenance", type: "EXPENSE", parent: "7000" },
  { code: "7145", name: "Insurance", type: "EXPENSE", parent: "7000" },
  { code: "7150", name: "Licences, permits and subscriptions", type: "EXPENSE", parent: "7000" },
  { code: "7155", name: "Software and IT services", type: "EXPENSE", parent: "7000" },
  { code: "7160", name: "Audit fees", type: "EXPENSE", parent: "7000" },
  { code: "7165", name: "Tax and secretarial fees", type: "EXPENSE", parent: "7000" },
  { code: "7170", name: "Legal and professional fees", type: "EXPENSE", parent: "7000" },
  { code: "7175", name: "Bank charges", type: "EXPENSE", parent: "7000", system: true },
  { code: "7180", name: "Travelling and accommodation", type: "EXPENSE", parent: "7000" },
  { code: "7185", name: "Entertainment", type: "EXPENSE", parent: "7000", description: "Deductibility is restricted. Kept separate so the tax computation does not have to unpick it." },
  { code: "7190", name: "Advertising and marketing", type: "EXPENSE", parent: "7000" },
  { code: "7195", name: "Motor vehicle running costs", type: "EXPENSE", parent: "7000" },
  { code: "7200", name: "Depreciation", type: "EXPENSE", parent: "7000", system: true },
  { code: "7210", name: "Bad debts written off", type: "EXPENSE", parent: "7000", system: true },
  {
    code: "7220",
    name: "Rounding differences",
    type: "EXPENSE",
    parent: "7000",
    system: true,
    description:
      "Where a document total and the sum of its tax-rounded lines differ by a cent. It exists so rounding has a declared home; the posting engine never plugs a difference of any other size.",
  },
  { code: "7230", name: "Loss on disposal of assets", type: "EXPENSE", parent: "7000" },
  { code: "7290", name: "Other administrative expenses", type: "EXPENSE", parent: "7000" },

  // -------------------------------------------------------------------------
  // Finance costs and taxation
  // -------------------------------------------------------------------------
  { code: "8000", name: "Finance costs", type: "EXPENSE", header: true },
  { code: "8110", name: "Interest on hire purchase", type: "EXPENSE", parent: "8000" },
  { code: "8120", name: "Interest on term loan", type: "EXPENSE", parent: "8000" },
  { code: "8190", name: "Other finance costs", type: "EXPENSE", parent: "8000" },

  { code: "9000", name: "Taxation", type: "EXPENSE", header: true },
  { code: "9110", name: "Income tax expense", type: "EXPENSE", parent: "9000" },
];

/**
 * Codes other modules depend on.
 *
 * Every module that posts resolves its accounts through this map rather than
 * writing a literal, so the set of hard dependencies on the chart is visible in
 * one place and the seeded `is_system` flags can be checked against it.
 */
export const SYSTEM_ACCOUNTS = {
  receivableControl: "1210",
  bankOperating: "1251",
  pettyCash: "1255",
  undepositedReceipts: "1256",
  sstInput: "1260",
  suspense: "1290",
  payableControl: "2110",
  sstOutput: "2130",
  epfPayable: "2141",
  socsoPayable: "2142",
  eisPayable: "2143",
  pcbPayable: "2144",
  hrdLevyPayable: "2145",
  salariesPayable: "2150",
  staffClaimsPayable: "2155",
  retainedEarnings: "3200",
  openingBalanceEquity: "3900",
  creditNotes: "4920",
  salariesExpense: "6110",
  overtimeExpense: "6120",
  bonusExpense: "6125",
  allowancesExpense: "6130",
  epfExpense: "6150",
  socsoExpense: "6160",
  eisExpense: "6165",
  hrdLevyExpense: "6170",
  bankCharges: "7175",
  depreciation: "7200",
  badDebts: "7210",
  rounding: "7220",
} as const;

export type SystemAccountKey = keyof typeof SYSTEM_ACCOUNTS;

/**
 * Tax codes, with no rates attached.
 *
 * A `tax_code` says "this is where output service tax would go"; a `tax_rate`
 * says "it is 6% from this date, per this instrument". Only the first is seeded.
 *
 * This is deliberate. Whether CAC is SST registered, from when, and at what rate
 * its particular taxable services fall is a question for CAC and its tax agent
 * (docs/OPEN_QUESTIONS.md, Q-FIN-1). Seeding a plausible-looking rate here would
 * put an unverified statutory figure on real invoices, which is precisely the
 * kind of fabricated compliance this project refuses to do. Until a rate row is
 * entered — with its `source_ref` — invoices carry no tax, and the settings
 * screen says so.
 */
export const TAX_CODES = [
  {
    code: "NONE",
    name: "No tax",
    kind: "none" as const,
    description: "Default while the company is not SST registered.",
  },
  {
    code: "SST-OUT",
    name: "Service tax - output",
    kind: "output" as const,
    description: "Service tax charged to customers. Inactive until a rate is entered.",
  },
  {
    code: "SST-IN",
    name: "Service tax - input",
    kind: "input" as const,
    description: "Service tax paid to suppliers. Inactive until a rate is entered.",
  },
  {
    code: "EXEMPT",
    name: "Exempt",
    kind: "exempt" as const,
    description: "Supplies outside the scope of service tax.",
  },
];
