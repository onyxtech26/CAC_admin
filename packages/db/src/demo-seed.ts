import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { closeDb, getDb, type Database } from "./client.js";
import { runMigrations } from "./migrate.js";
import { seed } from "./seed.js";

/**
 * Enterprise Malaysian Demo Dataset Seeder for Conglomerate Appraisal Consultancy (CAC).
 *
 * Populates authentic, interconnected demo data across all four platform suites:
 * 1. Administration & Master Data (Users, Roles, Tax Rates, Bank Accounts, Settings)
 * 2. HRMS & Payroll (Departments, Positions, Employees, Employment Events, Attendance, Leaves, March 2026 Payroll)
 * 3. Accounting & Finance (Customers, Suppliers, Quotations, Invoices, Receipts, Allocations, Bills, Vouchers, Journals)
 * 4. Legal AI & Estate Matters (Cases, Assignments, Requirement Rules, Checklist Requirements, Tasks, Public Enquiries)
 */

export async function seedDemo(db?: Database): Promise<void> {
  const database = db ?? (await getDb());

  console.log("--> [1/10] Running base migrations and system schema seed...");
  await runMigrations(database);
  await seed(database);

  // Dynamic import of core utilities so @cac/db does not bundle core at runtime
  const { hashPassword, encryptSecret } = await import("@cac/core");
  const DEMO_PASSWORD_HASH = await hashPassword("Admin@cac2026!");

  console.log("--> [2/10] Configuring company settings & Malaysian SST...");
  const settingsToUpdate = [
    { key: "company.name", value: "Conglomerate Appraisal Consultancy Sdn Bhd" },
    { key: "company.short_name", value: "CAC" },
    { key: "company.registration_no", value: "202001018899 (1367890-X)" },
    { key: "company.email", value: "admin@conglomerate4u.com" },
    { key: "company.phone", value: "+60 11-5960 1300" },
    { key: "company.address", value: "85-01, Jalan Wira 2, Taman Tan Sri Yaacob, 81300 Skudai, Johor, Malaysia" },
    { key: "tax.sst_registered", value: true },
    { key: "tax.sst_registration_no", value: "W10-2401-32000045" },
    { key: "tax.tin", value: "C25890123000" },
    { key: "accounting.approval_threshold_myr", value: 50000 },
    { key: "accounting.invoice_terms_days", value: 30 },
    { key: "accounting.quotation_validity_days", value: 30 },
  ];

  for (const s of settingsToUpdate) {
    await database.execute(sql`
      UPDATE org.setting
         SET value = ${JSON.stringify(s.value)}::jsonb,
             needs_review = false,
             requires_approval = false,
             updated_at = now()
       WHERE key = ${s.key}
    `);
  }

  // Cost Centres
  const costCentres = [
    { code: "HQ", name: "Executive & Headquarters" },
    { code: "VAL", name: "Forensic Property Appraisal" },
    { code: "LEGAL", name: "Estate Administration & Probate" },
    { code: "OPS", name: "Land Search & Survey Operations" },
  ];
  for (const cc of costCentres) {
    await database.execute(sql`
      INSERT INTO org.cost_centre (code, name, is_active)
      VALUES (${cc.code}, ${cc.name}, true)
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
    `);
  }

  // Activate tax codes and insert Malaysian Service Tax Rates (6% & 8%)
  await database.execute(sql`UPDATE accounting.tax_code SET is_active = true WHERE code IN ('SST-OUT', 'SST-IN')`);

  const sstOutRow = await database.execute<{ id: string }>(sql`SELECT id FROM accounting.tax_code WHERE code = 'SST-OUT'`);
  const sstInRow = await database.execute<{ id: string }>(sql`SELECT id FROM accounting.tax_code WHERE code = 'SST-IN'`);

  if (sstOutRow.rows?.[0]?.id) {
    await database.execute(sql`
      INSERT INTO accounting.tax_rate (tax_code_id, rate, effective_from, source_ref)
      VALUES (${sstOutRow.rows[0].id}, 0.060000, '2024-03-01', 'Service Tax (Amendment) Regulations 2024 (PU(A) 64/2024)')
      ON CONFLICT DO NOTHING
    `);
  }
  if (sstInRow.rows?.[0]?.id) {
    await database.execute(sql`
      INSERT INTO accounting.tax_rate (tax_code_id, rate, effective_from, source_ref)
      VALUES (${sstInRow.rows[0].id}, 0.060000, '2024-03-01', 'Service Tax (Amendment) Regulations 2024 (PU(A) 64/2024)')
      ON CONFLICT DO NOTHING
    `);
  }

  console.log("--> [3/10] Seeding Auth Users & Executive Roles...");
  const demoUsers = [
    {
      email: "admin@conglomerate4u.com",
      fullName: "Dato' Sri Vincent Tan",
      roles: ["SUPER_ADMIN", "DIRECTOR", "ACCOUNTANT", "HR_MANAGER", "CASE_MANAGER", "LAWYER_OR_AUTHORISED_REVIEWER"],
    },
    {
      email: "valuer@conglomerate4u.com",
      fullName: "Sr. Ahmad Fauzi bin Razak",
      roles: ["DIRECTOR", "CASE_MANAGER", "LAWYER_OR_AUTHORISED_REVIEWER"],
    },
    {
      email: "legal@conglomerate4u.com",
      fullName: "Sarah binti Kamaruddin",
      roles: ["LAWYER_OR_AUTHORISED_REVIEWER", "CASE_MANAGER"],
    },
    {
      email: "accountant@conglomerate4u.com",
      fullName: "Lim Wei Seng, CA(M)",
      roles: ["ACCOUNTANT", "DIRECTOR"],
    },
    {
      email: "hr@conglomerate4u.com",
      fullName: "Noraini binti Yusof",
      roles: ["HR_MANAGER"],
    },
    {
      email: "staff@conglomerate4u.com",
      fullName: "Muhammad Hafiz bin Rosli",
      roles: ["EMPLOYEE", "CASE_STAFF"],
    },
  ];

  const userIds: Record<string, string> = {};

  for (const u of demoUsers) {
    const existing = await database.execute<{ id: string }>(sql`SELECT id FROM auth."user" WHERE email = ${u.email}`);
    let uid = existing.rows?.[0]?.id;
    if (!uid) {
      const created = await database.execute<{ id: string }>(sql`
        INSERT INTO auth."user" (email, password_hash, full_name, must_change_password, mfa_enforced, status)
        VALUES (${u.email}, ${DEMO_PASSWORD_HASH}, ${u.fullName}, false, false, 'active')
        RETURNING id
      `);
      uid = created.rows[0].id;
    } else {
      await database.execute(sql`
        UPDATE auth."user"
           SET password_hash = ${DEMO_PASSWORD_HASH},
               full_name = ${u.fullName},
               must_change_password = false,
               mfa_enforced = false,
               status = 'active',
               updated_at = now()
         WHERE id = ${uid}
      `);
    }
    userIds[u.email] = uid;

    for (const rKey of u.roles) {
      await database.execute(sql`
        INSERT INTO auth.user_role (user_id, role_id)
        SELECT ${uid}, id FROM auth.role WHERE key = ${rKey}
        ON CONFLICT DO NOTHING
      `);
    }
  }

  const adminUid = userIds["admin@conglomerate4u.com"];
  const valuerUid = userIds["valuer@conglomerate4u.com"];
  const legalUid = userIds["legal@conglomerate4u.com"];
  const accountantUid = userIds["accountant@conglomerate4u.com"];
  const hrUid = userIds["hr@conglomerate4u.com"];

  console.log("--> [4/10] Seeding Fiscal Year 2026 & Monthly Accounting Periods...");
  const fyInsert = await database.execute<{ id: string }>(sql`
    INSERT INTO accounting.fiscal_year (name, starts_on, ends_on, status, created_by)
    VALUES ('FY-2026', '2026-01-01', '2026-12-31', 'open', ${adminUid})
    ON CONFLICT (name) DO UPDATE SET status = 'open'
    RETURNING id
  `);
  const fiscalYearId = fyInsert.rows?.[0]?.id;

  const monthEnds = ["31", "28", "31", "30", "31", "30", "31", "31", "30", "31", "30", "31"];
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  for (let m = 1; m <= 12; m++) {
    const pad = String(m).padStart(2, "0");
    const code = `2026-${pad}`;
    const name = `${monthNames[m - 1]} 2026`;
    const startsOn = `2026-${pad}-01`;
    const endsOn = `2026-${pad}-${monthEnds[m - 1]}`;
    await database.execute(sql`
      INSERT INTO accounting.period (fiscal_year_id, code, name, starts_on, ends_on, status)
      VALUES (${fiscalYearId}, ${code}, ${name}, ${startsOn}, ${endsOn}, 'open')
      ON CONFLICT (code) DO UPDATE SET status = 'open'
    `);
  }

  // Fetch period IDs for transactions
  const janPeriod = await database.execute<{ id: string }>(sql`SELECT id FROM accounting.period WHERE code = '2026-01'`);
  const janPeriodId = janPeriod.rows[0].id;
  const marPeriod = await database.execute<{ id: string }>(sql`SELECT id FROM accounting.period WHERE code = '2026-03'`);
  const marPeriodId = marPeriod.rows[0].id;

  console.log("--> [5/10] Seeding Bank Accounts (Maybank & CIMB Trust)...");
  const acc1251 = await database.execute<{ id: string }>(sql`SELECT id FROM accounting.account WHERE code = '1251'`);
  const acc1252 = await database.execute<{ id: string }>(sql`SELECT id FROM accounting.account WHERE code = '1252'`);

  if (acc1251.rows?.[0]?.id) {
    await database.execute(sql`
      INSERT INTO accounting.bank_account (account_id, bank_name, account_no, account_label, swift_code, currency, is_active, notes, created_by)
      VALUES (${acc1251.rows[0].id}, 'Maybank Islamic Berhad', '5140-1234-8899', 'Maybank Islamic Operating Current A/C', 'MBBEMYKL', 'MYR', true, 'Primary firm operating account for billing collections and payments', ${adminUid})
      ON CONFLICT (account_id) DO UPDATE SET bank_name = EXCLUDED.bank_name, account_no = EXCLUDED.account_no
    `);
  }
  if (acc1252.rows?.[0]?.id) {
    await database.execute(sql`
      INSERT INTO accounting.bank_account (account_id, bank_name, account_no, account_label, swift_code, currency, is_active, notes, created_by)
      VALUES (${acc1252.rows[0].id}, 'CIMB Bank Berhad', '8009-8877-6655', 'CIMB Estate Clients Trust A/C', 'CIBBMYKL', 'MYR', true, 'Segregated fiduciary client trust account for estate and probate funds', ${adminUid})
      ON CONFLICT (account_id) DO UPDATE SET bank_name = EXCLUDED.bank_name, account_no = EXCLUDED.account_no
    `);
  }

  console.log("--> [6/10] Seeding HR Organisation Hierarchy, Employees & Employment Events...");
  // Departments
  const departments = [
    { code: "EXEC", name: "Executive Board & Management" },
    { code: "VAL", name: "Property Valuation & Forensic Appraisal" },
    { code: "LEGAL", name: "Estate Administration & Probate Legal" },
    { code: "FIN", name: "Finance, Treasury & Accounts" },
    { code: "HR", name: "People, Culture & Administration" },
    { code: "OPS", name: "Land Title Registry & Field Operations" },
  ];
  const deptIds: Record<string, string> = {};
  for (const d of departments) {
    const res = await database.execute<{ id: string }>(sql`
      INSERT INTO hr.department (code, name, is_active, created_by)
      VALUES (${d.code}, ${d.name}, true, ${adminUid})
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `);
    deptIds[d.code] = res.rows[0].id;
  }

  // Positions
  const positions = [
    { code: "MD", title: "Managing Director & Registered Appraiser", dept: "EXEC" },
    { code: "HEAD_VAL", title: "Head of Valuation & Senior Appraiser", dept: "VAL" },
    { code: "SR_COUNSEL", title: "Senior Estate Legal Counsel", dept: "LEGAL" },
    { code: "FIN_CONTROLLER", title: "Financial Controller & Chief Accountant", dept: "FIN" },
    { code: "HR_MGR", title: "Human Resources & Operations Manager", dept: "HR" },
    { code: "SR_VALUER", title: "Senior Property Valuer", dept: "VAL" },
    { code: "EST_OFFICER", title: "Probate & Estate Specialist", dept: "LEGAL" },
    { code: "TITLE_OFFICER", title: "Field Surveyor & Title Registry Officer", dept: "OPS" },
  ];
  const posIds: Record<string, string> = {};
  for (const p of positions) {
    const res = await database.execute<{ id: string }>(sql`
      INSERT INTO hr.position (code, title, department_id, is_active, created_by)
      VALUES (${p.code}, ${p.title}, ${deptIds[p.dept]}, true, ${adminUid})
      ON CONFLICT (code) DO UPDATE SET title = EXCLUDED.title, department_id = EXCLUDED.department_id
      RETURNING id
    `);
    posIds[p.code] = res.rows[0].id;
  }

  // Work Schedule
  const schedRes = await database.execute<{ id: string }>(sql`
    INSERT INTO hr.work_schedule (code, name, work_days, starts_at, ends_at, break_minutes, is_default, created_by)
    VALUES ('STD', 'Standard 5-Day Week (09:00 - 18:00)', ARRAY[1, 2, 3, 4, 5], '09:00', '18:00', 60, true, ${adminUid})
    ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `);
  const defaultScheduleId = schedRes.rows[0].id;

  // Employees data
  const staffData = [
    {
      empNo: "EMP-0001",
      userEmail: "admin@conglomerate4u.com",
      fullName: "Dato' Sri Vincent Tan",
      dept: "EXEC",
      pos: "MD",
      nric: "720815-01-5589",
      salary: "18500.00",
      joined: "2023-01-01",
      bankName: "Maybank",
      bankAcc: "1140-1234-9988",
      epf: "18293847",
      tax: "SG283948290",
    },
    {
      empNo: "EMP-0002",
      userEmail: "valuer@conglomerate4u.com",
      fullName: "Sr. Ahmad Fauzi bin Razak",
      dept: "VAL",
      pos: "HEAD_VAL",
      nric: "780322-01-6123",
      salary: "13500.00",
      joined: "2023-03-01",
      bankName: "CIMB Bank",
      bankAcc: "7012-3847-5920",
      epf: "19384729",
      tax: "SG394829102",
    },
    {
      empNo: "EMP-0003",
      userEmail: "legal@conglomerate4u.com",
      fullName: "Sarah binti Kamaruddin",
      dept: "LEGAL",
      pos: "SR_COUNSEL",
      nric: "841105-01-5246",
      salary: "11500.00",
      joined: "2023-06-01",
      bankName: "Maybank",
      bankAcc: "1142-9988-1234",
      epf: "20394857",
      tax: "SG482910394",
    },
    {
      empNo: "EMP-0004",
      userEmail: "accountant@conglomerate4u.com",
      fullName: "Lim Wei Seng, CA(M)",
      dept: "FIN",
      pos: "FIN_CONTROLLER",
      nric: "860419-01-5833",
      salary: "9800.00",
      joined: "2023-07-01",
      bankName: "Public Bank",
      bankAcc: "3182-9485-7192",
      epf: "21948572",
      tax: "SG592019384",
    },
    {
      empNo: "EMP-0005",
      userEmail: "hr@conglomerate4u.com",
      fullName: "Noraini binti Yusof",
      dept: "HR",
      pos: "HR_MGR",
      nric: "890912-01-5412",
      salary: "7800.00",
      joined: "2024-01-01",
      bankName: "RHB Bank",
      bankAcc: "2120-9482-1928",
      epf: "22849102",
      tax: "SG691029482",
    },
    {
      empNo: "EMP-0006",
      userEmail: "staff@conglomerate4u.com",
      fullName: "Muhammad Hafiz bin Rosli",
      dept: "OPS",
      pos: "TITLE_OFFICER",
      nric: "940520-01-6287",
      salary: "4500.00",
      joined: "2024-05-01",
      bankName: "Maybank",
      bankAcc: "1148-2910-3847",
      epf: "23948192",
      tax: "SG782910293",
    },
  ];

  const empIds: Record<string, string> = {};

  for (const s of staffData) {
    const nricEnc = encryptSecret(s.nric);
    const nricLast4 = s.nric.replace(/-/g, "").slice(-4);
    const bankEnc = encryptSecret(s.bankAcc);
    const bankLast4 = s.bankAcc.replace(/[^0-9]/g, "").slice(-4);

    const existingEmp = await database.execute<{ id: string }>(sql`
      SELECT id FROM hr.employee WHERE employee_no = ${s.empNo}
    `);

    let empId = existingEmp.rows?.[0]?.id;
    if (!empId) {
      const created = await database.execute<{ id: string }>(sql`
        INSERT INTO hr.employee (
          employee_no, full_name, email, phone, status, joined_on,
          department_id, position_id, work_schedule_id, basic_salary,
          nric_enc, nric_last4, bank_name, bank_account_enc, bank_account_last4,
          epf_no, income_tax_no, marital_status, tax_dependants,
          epf_applicable, socso_applicable, eis_applicable, pcb_applicable,
          user_id, created_by
        ) VALUES (
          ${s.empNo}, ${s.fullName}, ${s.userEmail}, '+60 12-789 4561', 'active', ${s.joined},
          ${deptIds[s.dept]}, ${posIds[s.pos]}, ${defaultScheduleId}, ${s.salary},
          ${nricEnc}, ${nricLast4}, ${s.bankName}, ${bankEnc}, ${bankLast4},
          ${s.epf}, ${s.tax}, 'married', 2,
          true, true, true, true,
          ${s.userEmail ? userIds[s.userEmail] ?? null : null}, ${adminUid}
        ) RETURNING id
      `);
      empId = created.rows[0].id;
    } else {
      await database.execute(sql`
        UPDATE hr.employee
           SET full_name = ${s.fullName},
               department_id = ${deptIds[s.dept]},
               position_id = ${posIds[s.pos]},
               basic_salary = ${s.salary},
               nric_enc = ${nricEnc},
               nric_last4 = ${nricLast4},
               bank_name = ${s.bankName},
               bank_account_enc = ${bankEnc},
               bank_account_last4 = ${bankLast4},
               updated_at = now()
         WHERE id = ${empId}
      `);
    }
    empIds[s.empNo] = empId;

    // Link user to employee
    if (s.userEmail && userIds[s.userEmail]) {
      await database.execute(sql`
        UPDATE auth."user" SET employee_id = ${empId} WHERE id = ${userIds[s.userEmail]}
      `);
    }

    // Crucial: Employment Event (for payroll salary calculation & audit stream)
    const existingEv = await database.execute<{ id: string }>(sql`
      SELECT id FROM hr.employment_event WHERE employee_id = ${empId} AND kind = 'hired'
    `);
    if (!existingEv.rows?.[0]) {
      await database.execute(sql`
        INSERT INTO hr.employment_event (
          employee_id, kind, effective_from, basic_salary,
          position_id, department_id, employment_type, status,
          epf_applicable, socso_applicable, eis_applicable, pcb_applicable,
          reason, created_by
        ) VALUES (
          ${empId}, 'hired', ${s.joined}, ${s.salary},
          ${posIds[s.pos]}, ${deptIds[s.dept]}, 'permanent', 'active',
          true, true, true, true,
          'Initial appointment of corporate staff', ${adminUid}
        )
      `);
    }
  }

  // Set Department Heads
  await database.execute(sql`UPDATE hr.department SET head_employee_id = ${empIds["EMP-0001"]} WHERE code = 'EXEC'`);
  await database.execute(sql`UPDATE hr.department SET head_employee_id = ${empIds["EMP-0002"]} WHERE code = 'VAL'`);
  await database.execute(sql`UPDATE hr.department SET head_employee_id = ${empIds["EMP-0003"]} WHERE code = 'LEGAL'`);
  await database.execute(sql`UPDATE hr.department SET head_employee_id = ${empIds["EMP-0004"]} WHERE code = 'FIN'`);
  await database.execute(sql`UPDATE hr.department SET head_employee_id = ${empIds["EMP-0005"]} WHERE code = 'HR'`);
  await database.execute(sql`UPDATE hr.department SET head_employee_id = ${empIds["EMP-0006"]} WHERE code = 'OPS'`);

  console.log("--> [7/10] Seeding Statutory Rules, Leaves & 30-Day Attendance Records...");
  // Leave Types
  const leaveTypes = [
    { code: "AL", name: "Annual Leave", days: 16, source: "Employment Act 1955, s60E" },
    { code: "MC", name: "Medical / Sick Leave", days: 14, source: "Employment Act 1955, s60F" },
    { code: "HL", name: "Hospitalisation Leave", days: 60, source: "Employment Act 1955, s60F(1)(bb)" },
  ];
  const leaveTypeIds: Record<string, string> = {};
  for (const lt of leaveTypes) {
    const res = await database.execute<{ id: string }>(sql`
      INSERT INTO hr.leave_type (code, name, default_days, entitlement_source, is_paid, is_active, created_by)
      VALUES (${lt.code}, ${lt.name}, ${lt.days}, ${lt.source}, true, true, ${adminUid})
      ON CONFLICT (code) DO UPDATE SET default_days = EXCLUDED.default_days, entitlement_source = EXCLUDED.entitlement_source
      RETURNING id
    `);
    leaveTypeIds[lt.code] = res.rows[0].id;
  }

  // Leave Balances for 2026
  for (const empNo of Object.keys(empIds)) {
    const eid = empIds[empNo];
    for (const lt of leaveTypes) {
      await database.execute(sql`
        INSERT INTO hr.leave_balance (employee_id, leave_type_id, year, entitled_days, carried_days, adjustment_days, taken_days, created_by)
        VALUES (${eid}, ${leaveTypeIds[lt.code]}, 2026, ${lt.days}, 2, 0, 0, ${adminUid})
        ON CONFLICT (employee_id, leave_type_id, year) DO NOTHING
      `);
    }
  }

  // Sample Approved Leave Requests (e.g. for Hafiz and Sarah)
  const sampleLeaves = [
    {
      reqNo: "LV-2026-0001",
      empId: empIds["EMP-0006"],
      ltId: leaveTypeIds["AL"],
      start: "2026-02-12",
      end: "2026-02-13",
      days: 2,
      reason: "Family reunion event",
    },
    {
      reqNo: "LV-2026-0002",
      empId: empIds["EMP-0003"],
      ltId: leaveTypeIds["AL"],
      start: "2026-03-05",
      end: "2026-03-06",
      days: 2,
      reason: "Attending Malaysian Bar seminar",
    },
  ];
  for (const sl of sampleLeaves) {
    const exists = await database.execute(sql`SELECT id FROM hr.leave_request WHERE request_no = ${sl.reqNo}`);
    if (!exists.rows?.[0]) {
      await database.execute(sql`
        INSERT INTO hr.leave_request (
          request_no, employee_id, leave_type_id, starts_on, ends_on, days,
          reason, status, decided_at, decided_by, created_by
        ) VALUES (
          ${sl.reqNo}, ${sl.empId}, ${sl.ltId}, ${sl.start}, ${sl.end}, ${sl.days},
          ${sl.reason}, 'approved', now(), ${hrUid}, ${hrUid}
        )
      `);
    }
  }

  // 30 Days of Attendance for March 2026 (Mon-Fri)
  console.log("   - Generating daily biometric attendance punches for March 2026...");
  for (let d = 2; d <= 31; d++) {
    const dayDate = new Date(2026, 2, d); // Month 2 is March (0-indexed)
    const dayOfWeek = dayDate.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) continue; // Skip weekends

    const dayStr = `2026-03-${String(d).padStart(2, "0")}`;

    for (const [idx, empNo] of Object.keys(empIds).entries()) {
      const eid = empIds[empNo];
      const minuteOffset = (idx * 3 + (d % 7)) % 15;
      const inTime = `08:${String(50 + (minuteOffset % 10)).padStart(2, "0")}:00`;
      const outTime = `18:${String(10 + minuteOffset).padStart(2, "0")}:00`;
      const clockIn = `${dayStr} ${inTime}+08`;
      const clockOut = `${dayStr} ${outTime}+08`;

      await database.execute(sql`
        INSERT INTO hr.attendance (
          employee_id, work_date, clock_in, clock_out, source,
          scheduled_minutes, worked_minutes, late_minutes, status,
          finalised_at, finalised_by, created_by
        ) VALUES (
          ${eid}, ${dayStr}, ${clockIn}::timestamptz, ${clockOut}::timestamptz, 'device',
          540, 540, 0, 'final',
          now(), ${hrUid}, ${hrUid}
        )
        ON CONFLICT (employee_id, work_date) DO NOTHING
      `);
    }
  }

  // Malaysian Statutory Rules (EPF, SOCSO, EIS, PCB)
  console.log("   - Approving Malaysian statutory deduction tables (EPF, SOCSO, EIS, PCB)...");
  const statutoryRules = [
    {
      kind: "epf_employee",
      table: { bands: [{ wageFrom: "0", wageTo: null, ratePercent: "11" }] },
      source: "Employees Provident Fund Act 1991, Third Schedule",
    },
    {
      kind: "epf_employer",
      table: {
        bands: [
          { wageFrom: "0", wageTo: "5000", ratePercent: "13" },
          { wageFrom: "5000", wageTo: null, ratePercent: "12" },
        ],
      },
      source: "Employees Provident Fund Act 1991, Third Schedule",
    },
    {
      kind: "socso",
      table: {
        bands: [
          { wageFrom: "0", wageTo: "3000", employee: "14.75", employer: "51.65" },
          { wageFrom: "3000", wageTo: "5000", employee: "24.75", employer: "86.65" },
          { wageFrom: "5000", wageTo: null, employee: "29.75", employer: "104.15" },
        ],
      },
      source: "Employees' Social Security Act 1969, Category 1",
    },
    {
      kind: "eis",
      table: {
        bands: [
          { wageFrom: "0", wageTo: "5000", employee: "0.2%", employer: "0.2%" },
          { wageFrom: "5000", wageTo: null, employee: "9.90", employer: "9.90" },
        ],
      },
      source: "Employment Insurance System Act 2017, Second Schedule",
    },
    {
      kind: "pcb",
      table: {
        bands: [
          { wageFrom: "0", wageTo: "5000", ratePercent: "0" },
          { wageFrom: "5000", wageTo: "10000", ratePercent: "5" },
          { wageFrom: "10000", wageTo: null, ratePercent: "15" },
        ],
      },
      source: "Income Tax (Deduction from Remuneration) Rules 2014",
    },
  ];

  const statRuleIds: Record<string, string> = {};
  for (const sr of statutoryRules) {
    const existingRule = await database.execute<{ id: string }>(sql`
      SELECT id FROM hr.statutory_rule_version WHERE kind = ${sr.kind} AND status = 'approved'
    `);
    if (!existingRule.rows?.[0]) {
      const res = await database.execute<{ id: string }>(sql`
        INSERT INTO hr.statutory_rule_version (
          kind, effective_from, source_ref, table_data, status,
          approved_at, approved_by, created_by
        ) VALUES (
          ${sr.kind}, '2026-01-01', ${sr.source}, ${JSON.stringify(sr.table)}::jsonb, 'approved',
          now(), ${valuerUid}, ${hrUid}
        ) RETURNING id
      `);
      statRuleIds[sr.kind] = res.rows[0].id;
    } else {
      statRuleIds[sr.kind] = existingRule.rows[0].id;
    }
  }

  // March 2026 Payroll Run & Payslips
  console.log("   - Preparing and finalising March 2026 itemized payroll run...");
  const payrollRunNo = "PR-2026-03";
  let prId: string;
  const existingPr = await database.execute<{ id: string }>(sql`
    SELECT id FROM hr.payroll_run WHERE run_no = ${payrollRunNo}
  `);

  if (!existingPr.rows?.[0]) {
    const prRes = await database.execute<{ id: string }>(sql`
      INSERT INTO hr.payroll_run (
        run_no, period_from, period_to, pay_date, status, kind,
        created_by
      ) VALUES (
        ${payrollRunNo}, '2026-03-01', '2026-03-31', '2026-03-28', 'prepared', 'regular',
        ${hrUid}
      ) RETURNING id
    `);
    prId = prRes.rows[0].id;

    // Generate Payslips & Itemized breakdown lines
    for (const s of staffData) {
      const eid = empIds[s.empNo];
      const salary = parseFloat(s.salary);
      const epfEmp = Math.round(salary * 0.11 * 100) / 100;
      const epfEmpyr = Math.round(salary * (salary > 5000 ? 0.12 : 0.13) * 100) / 100;
      const socsoEmp = salary >= 5000 ? 29.75 : 24.75;
      const socsoEmpyr = salary >= 5000 ? 104.15 : 86.65;
      const eisEmp = salary >= 5000 ? 9.90 : Math.round(salary * 0.002 * 100) / 100;
      const eisEmpyr = salary >= 5000 ? 9.90 : Math.round(salary * 0.002 * 100) / 100;
      const pcb = salary > 10000 ? Math.round((salary - 10000) * 0.15 * 100) / 100 : 0;
      const allowance = 500.00;

      const psRes = await database.execute<{ id: string }>(sql`
        INSERT INTO hr.payslip (
          run_id, employee_id, employee_no, employee_name, department_name, position_title,
          basic_salary, bank_name, bank_account_last4
        ) VALUES (
          ${prId}, ${eid}, ${s.empNo}, ${s.fullName}, ${s.dept}, ${s.pos},
          ${s.salary}, ${s.bankName}, ${s.bankAcc.slice(-4)}
        ) RETURNING id
      `);
      const psId = psRes.rows[0].id;

      // Payslip breakdown lines
      const lines = [
        { no: 1, kind: "earning", code: "BASIC", desc: "Monthly Basic Salary", amt: salary.toFixed(2), acct: "6110" },
        { no: 2, kind: "earning", code: "ALLOWANCE", desc: "Executive Transport & Phone Allowance", amt: allowance.toFixed(2), acct: "6130" },
        { no: 3, kind: "deduction", code: "EPF_EMP", desc: "EPF Employee Contribution (11%)", amt: epfEmp.toFixed(2), acct: "2141", stat: statRuleIds["epf_employee"] },
        { no: 4, kind: "deduction", code: "SOCSO_EMP", desc: "SOCSO Employee Contribution", amt: socsoEmp.toFixed(2), acct: "2142", stat: statRuleIds["socso"] },
        { no: 5, kind: "deduction", code: "EIS_EMP", desc: "EIS Employee Contribution", amt: eisEmp.toFixed(2), acct: "2143", stat: statRuleIds["eis"] },
        ...(pcb > 0 ? [{ no: 6, kind: "deduction", code: "PCB", desc: "Monthly Tax Deduction (PCB/MTD)", amt: pcb.toFixed(2), acct: "2144", stat: statRuleIds["pcb"] }] : []),
        { no: 7, kind: "employer", code: "EPF_EMPYR", desc: "EPF Employer Contribution", amt: epfEmpyr.toFixed(2), acct: "6150", contra: "2141", stat: statRuleIds["epf_employer"] },
        { no: 8, kind: "employer", code: "SOCSO_EMPYR", desc: "SOCSO Employer Contribution", amt: socsoEmpyr.toFixed(2), acct: "6160", contra: "2142", stat: statRuleIds["socso"] },
        { no: 9, kind: "employer", code: "EIS_EMPYR", desc: "EIS Employer Contribution", amt: eisEmpyr.toFixed(2), acct: "6165", contra: "2143", stat: statRuleIds["eis"] },
      ];

      for (const line of lines) {
        await database.execute(sql`
          INSERT INTO hr.payslip_line (
            payslip_id, line_no, kind, code, description, amount,
            account_code, contra_account_code, statutory_rule_id
          ) VALUES (
            ${psId}, ${line.no}, ${line.kind}, ${line.code}, ${line.desc}, ${line.amt},
            ${line.acct}, ${line.contra ?? null}, ${line.stat ?? null}
          )
        `);
      }
    }

    // Approve & Finalise run
    await database.execute(sql`
      UPDATE hr.payroll_run
         SET status = 'approved',
             approved_at = '2026-03-27 15:00:00+08',
             approved_by = ${valuerUid}
       WHERE id = ${prId}
    `);
    await database.execute(sql`
      UPDATE hr.payroll_run
         SET status = 'finalised',
             finalised_at = '2026-03-28 10:00:00+08',
             finalised_by = ${adminUid}
       WHERE id = ${prId}
    `);
  }

  console.log("--> [8/10] Seeding Malaysian Clients, Vendors, Sales Cycle & Payables...");
  // Customers
  const customersData = [
    { code: "CUST-001", name: "Sime Darby Property Berhad", reg: "197301002258", email: "procurement@simedarbyproperty.com", phone: "+60 3-7849 5000", contact: "En. Razif bin Mokhtar", terms: 30, limit: "500000.00" },
    { code: "CUST-002", name: "Mah Sing Group Berhad", reg: "199101019838", email: "legal.property@mahsing.com.my", phone: "+60 3-9221 8888", contact: "Ms. Chloe Tan", terms: 30, limit: "350000.00" },
    { code: "CUST-003", name: "Eco World Development Group Berhad", reg: "197401000725", email: "finance@ecoworld.my", phone: "+60 3-3344 2552", contact: "Mr. Kelvin Wong", terms: 30, limit: "400000.00" },
    { code: "CUST-004", name: "IOI Properties Group Berhad", reg: "201301005955", email: "corporate@ioiproperties.com.my", phone: "+60 3-8064 8888", contact: "Pn. Norlia binti Hashim", terms: 30, limit: "300000.00" },
    { code: "CUST-005", name: "Zaid Ibrahim & Co (in association with KPMG)", reg: "LLP0002891", email: "estates@zicolaw.com", phone: "+60 3-2087 9999", contact: "Dato' Zaid partner", terms: 14, limit: "200000.00" },
    { code: "CUST-006", name: "Skrine & Co Advocates & Solicitors", reg: "LLP0001244", email: "litigation@skrine.com", phone: "+60 3-2081 3999", contact: "Mr. Khoo Guan Huat", terms: 14, limit: "150000.00" },
    { code: "CUST-007", name: "Amanah Raya Berhad (Public Trustee)", reg: "199501014522", email: "probate@amanahraya.my", phone: "+60 3-2723 7273", contact: "Pn. Fauziah binti Aris", terms: 30, limit: "250000.00" },
    { code: "CUST-008", name: "Perbadanan Kemajuan Negeri Selangor (PKNS)", reg: "SW-PKNS-1964", email: "tanah@pkns.gov.my", phone: "+60 3-5525 0300", contact: "Tuan Haji Shukor", terms: 30, limit: "500000.00" },
  ];
  const custIds: Record<string, string> = {};
  for (const c of customersData) {
    const res = await database.execute<{ id: string }>(sql`
      INSERT INTO accounting.customer (
        code, name, registration_no, email, phone, contact_person,
        payment_terms_days, credit_limit, is_active, created_by
      ) VALUES (
        ${c.code}, ${c.name}, ${c.reg}, ${c.email}, ${c.phone}, ${c.contact},
        ${c.terms}, ${c.limit}, true, ${adminUid}
      )
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email
      RETURNING id
    `);
    custIds[c.code] = res.rows[0].id;
  }

  // Suppliers
  const suppliersData = [
    { code: "SUPP-001", name: "Tenaga Nasional Berhad", reg: "199001009294", email: "corporatebilling@tnb.com.my", phone: "+60 3-2296 5566", bank: "Maybank", acc: "5140-1122-3344" },
    { code: "SUPP-002", name: "Telekom Malaysia Berhad (Unifi)", reg: "198401016101", email: "businesscare@tm.com.my", phone: "+60 3-2240 9494", bank: "CIMB Bank", acc: "8001-2233-4455" },
    { code: "SUPP-003", name: "AutoCount Sdn Bhd", reg: "200601008892", email: "billing@autocountsoft.com", phone: "+60 3-3080 8888", bank: "Public Bank", acc: "3120-4928-1928" },
    { code: "SUPP-004", name: "Pejabat Tanah dan Galian Johor", reg: "GOV-PTG-JOHOR", email: "ptg@johor.gov.my", phone: "+60 7-266 1999", bank: "Maybank", acc: "5010-8899-0011" },
    { code: "SUPP-005", name: "Canon Marketing (Malaysia) Sdn Bhd", reg: "198701004508", email: "corporate@canon.com.my", phone: "+60 3-7844 6000", bank: "Standard Chartered", acc: "3128-4920-1928" },
  ];
  const suppIds: Record<string, string> = {};
  for (const s of suppliersData) {
    const res = await database.execute<{ id: string }>(sql`
      INSERT INTO accounting.supplier (
        code, name, registration_no, email, phone, bank_name, bank_account_no, is_active, created_by
      ) VALUES (
        ${s.code}, ${s.name}, ${s.reg}, ${s.email}, ${s.phone}, ${s.bank}, ${s.acc}, true, ${adminUid}
      )
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `);
    suppIds[s.code] = res.rows[0].id;
  }

  // Quotations
  const quotationsData = [
    { no: "QT-2026-0001", cust: "CUST-001", subject: "Valuation of 120-Acre Master Planned Mixed Commercial Development", status: "converted", amt: "45000.00" },
    { no: "QT-2026-0002", cust: "CUST-002", subject: "Forensic Land Title Search & Boundary Retracement at Mukim Pulai", status: "accepted", amt: "18500.00" },
    { no: "QT-2026-0003", cust: "CUST-003", subject: "High Court Expert Valuation Affidavit for Highway Acquisition Compensation", status: "accepted", amt: "28000.00" },
    { no: "QT-2026-0004", cust: "CUST-005", subject: "Probate Real Estate Appraisal & Beneficiary Share Determination", status: "sent", amt: "15000.00" },
    { no: "QT-2026-0005", cust: "CUST-004", subject: "Industrial Logistics Hub Asset Valuation in Senai Airport City", status: "sent", amt: "38000.00" },
    { no: "QT-2026-0006", cust: "CUST-007", subject: "Small Estate Real Property Comprehensive Inventory", status: "draft", amt: "8500.00" },
  ];
  const quoteIds: Record<string, string> = {};
  for (const q of quotationsData) {
    const existing = await database.execute<{ id: string }>(sql`SELECT id FROM accounting.quotation WHERE quotation_no = ${q.no}`);
    if (!existing.rows?.[0]) {
      const res = await database.execute<{ id: string }>(sql`
        INSERT INTO accounting.quotation (
          quotation_no, customer_id, quotation_date, valid_until, subject,
          status, currency, created_by
        ) VALUES (
          ${q.no}, ${custIds[q.cust]}, '2026-02-15', '2026-03-31', ${q.subject},
          'draft', 'MYR', ${adminUid}
        ) RETURNING id
      `);
      const qid = res.rows[0].id;
      quoteIds[q.no] = qid;

      // Line
      const taxAmt = Math.round(parseFloat(q.amt) * 0.06 * 100) / 100;
      const total = parseFloat(q.amt) + taxAmt;
      await database.execute(sql`
        INSERT INTO accounting.quotation_line (
          quotation_id, line_no, description, quantity, unit_price,
          discount_amount, tax_code_id, tax_amount, line_subtotal, line_total, account_id
        ) VALUES (
          ${qid}, 1, ${q.subject}, 1, ${q.amt},
          0, ${sstOutRow.rows[0].id}, ${taxAmt.toFixed(4)}, ${q.amt}, ${total.toFixed(4)},
          (SELECT id FROM accounting.account WHERE code = '4140')
        )
      `);

      // Advance status
      if (q.status === "sent") {
        await database.execute(sql`
          UPDATE accounting.quotation
             SET status = 'sent',
                 sent_at = '2026-02-16 14:00:00+08',
                 approved_at = '2026-02-16 11:00:00+08',
                 approved_by = ${valuerUid}
           WHERE id = ${qid}
        `);
      } else if (q.status === "accepted") {
        await database.execute(sql`
          UPDATE accounting.quotation
             SET status = 'sent',
                 sent_at = '2026-02-16 14:00:00+08',
                 approved_at = '2026-02-16 11:00:00+08',
                 approved_by = ${valuerUid}
           WHERE id = ${qid}
        `);
        await database.execute(sql`
          UPDATE accounting.quotation
             SET status = 'accepted',
                 decided_at = '2026-02-18 10:00:00+08'
           WHERE id = ${qid}
        `);
      } else if (q.status === "converted") {
        await database.execute(sql`
          UPDATE accounting.quotation
             SET status = 'sent',
                 sent_at = '2026-02-16 14:00:00+08',
                 approved_at = '2026-02-16 11:00:00+08',
                 approved_by = ${valuerUid}
           WHERE id = ${qid}
        `);
        await database.execute(sql`
          UPDATE accounting.quotation
             SET status = 'accepted',
                 decided_at = '2026-02-18 10:00:00+08'
           WHERE id = ${qid}
        `);
        await database.execute(sql`
          UPDATE accounting.quotation
             SET status = 'converted'
           WHERE id = ${qid}
        `);
      }
    }
  }

  // Invoices (8 Invoices, SST 6%)
  const invoicesData = [
    { no: "INV-2026-0001", cust: "CUST-001", sub: "45000.00", tax: "2700.00", tot: "47700.00", date: "2026-03-01", due: "2026-03-31", desc: "Professional Valuation: 120-Acre Commercial Mixed Development", status: "paid" },
    { no: "INV-2026-0002", cust: "CUST-002", sub: "18500.00", tax: "1110.00", tot: "19610.00", date: "2026-03-05", due: "2026-04-04", desc: "Forensic Land Title Search & Boundary Retracement at Mukim Pulai", status: "paid" },
    { no: "INV-2026-0003", cust: "CUST-003", sub: "28000.00", tax: "1680.00", tot: "29680.00", date: "2026-03-10", due: "2026-04-09", desc: "High Court Valuation Report & Expert Witness Appearance", status: "paid" },
    { no: "INV-2026-0004", cust: "CUST-005", sub: "15000.00", tax: "900.00", tot: "15900.00", date: "2026-03-12", due: "2026-03-26", desc: "Estate Asset Appraisal & Probate Title Investigation Advisory", status: "paid" },
    { no: "INV-2026-0005", cust: "CUST-004", sub: "38000.00", tax: "2280.00", tot: "40280.00", date: "2026-03-18", due: "2026-04-17", desc: "Industrial Logistics Hub Asset Valuation in Senai Airport City", status: "issued" },
    { no: "INV-2026-0006", cust: "CUST-006", sub: "12000.00", tax: "720.00", tot: "12720.00", date: "2026-03-22", due: "2026-04-05", desc: "Letters of Administration Real Property Inventory Report", status: "issued" },
    { no: "INV-2026-0007", cust: "CUST-007", sub: "8500.00", tax: "510.00", tot: "9010.00", date: "2026-03-25", due: "2026-04-24", desc: "Small Estate Distribution Valuation & Title Verification", status: "issued" },
    { no: "INV-2026-0008", cust: "CUST-008", sub: "22000.00", tax: "1320.00", tot: "23320.00", date: "2026-03-28", due: "2026-04-27", desc: "Forensic Property Search & Acquisition Impact Assessment", status: "approved" },
  ];

  const invIds: Record<string, string> = {};
  for (const inv of invoicesData) {
    const existing = await database.execute<{ id: string }>(sql`SELECT id FROM accounting.invoice WHERE invoice_no = ${inv.no}`);
    if (!existing.rows?.[0]) {
      // 1. Insert header as draft
      const res = await database.execute<{ id: string }>(sql`
        INSERT INTO accounting.invoice (
          customer_id, invoice_date, due_date, subject, status, currency, created_by
        ) VALUES (
          ${custIds[inv.cust]}, ${inv.date}, ${inv.due}, ${inv.desc}, 'draft', 'MYR', ${accountantUid}
        ) RETURNING id
      `);
      const iid = res.rows[0].id;
      invIds[inv.no] = iid;

      // 2. Insert line
      await database.execute(sql`
        INSERT INTO accounting.invoice_line (
          invoice_id, line_no, description, quantity, unit_price,
          discount_amount, tax_code_id, tax_amount, line_subtotal, line_total, account_id
        ) VALUES (
          ${iid}, 1, ${inv.desc}, 1, ${inv.sub},
          0, ${sstOutRow.rows[0].id}, ${inv.tax}, ${inv.sub}, ${inv.tot},
          (SELECT id FROM accounting.account WHERE code = '4140')
        )
      `);

      // 3. Lifecycle transitions
      await database.execute(sql`UPDATE accounting.invoice SET status = 'pending_approval' WHERE id = ${iid}`);
      await database.execute(sql`
        UPDATE accounting.invoice
           SET status = 'approved',
               approved_at = now(),
               approved_by = ${valuerUid}
         WHERE id = ${iid}
      `);

      if (inv.status === "issued" || inv.status === "paid") {
        const jrnNo = `JRN-${inv.no}`;
        const jrnRes = await database.execute<{ id: string }>(sql`
          INSERT INTO accounting.journal (
            journal_no, period_id, entry_date, memo, source_type, source_id, status, created_by
          ) VALUES (
            ${jrnNo}, ${marPeriodId}, ${inv.date}, ${`Invoice ${inv.no} - ${inv.desc}`}, 'invoice', ${iid}, 'draft', ${accountantUid}
          ) RETURNING id
        `);
        const jid = jrnRes.rows[0].id;

        await database.execute(sql`
          INSERT INTO accounting.journal_line (journal_id, line_no, account_id, debit, credit, description)
          VALUES (${jid}, 1, (SELECT id FROM accounting.account WHERE code = '1210'), ${inv.tot}, 0, ${inv.desc})
        `);
        await database.execute(sql`
          INSERT INTO accounting.journal_line (journal_id, line_no, account_id, debit, credit, description)
          VALUES (${jid}, 2, (SELECT id FROM accounting.account WHERE code = '4140'), 0, ${inv.sub}, ${inv.desc})
        `);
        if (parseFloat(inv.tax) > 0) {
          await database.execute(sql`
            INSERT INTO accounting.journal_line (journal_id, line_no, account_id, debit, credit, description)
            VALUES (${jid}, 3, (SELECT id FROM accounting.account WHERE code = '2130'), 0, ${inv.tax}, 'SST 6% Output tax')
          `);
        }

        await database.execute(sql`
          UPDATE accounting.journal
             SET status = 'posted',
                 posted_at = ${inv.date}::date + interval '10 hours',
                 posted_by = ${adminUid}
           WHERE id = ${jid}
        `);

        await database.execute(sql`
          UPDATE accounting.invoice
             SET status = 'issued',
                 invoice_no = ${inv.no},
                 journal_id = ${jid},
                 issued_at = ${inv.date}::date + interval '10 hours',
                 issued_by = ${adminUid}
           WHERE id = ${iid}
        `);
      } else {
        await database.execute(sql`
          UPDATE accounting.invoice
             SET invoice_no = ${inv.no}
           WHERE id = ${iid}
        `);
      }
    } else {
      invIds[inv.no] = existing.rows[0].id;
    }
  }

  // Receipts & Allocations (for INV 1 to 4)
  const receiptsData = [
    { no: "RCP-2026-0001", invNo: "INV-2026-0001", cust: "CUST-001", amt: "47700.00", date: "2026-03-15", ref: "MBB-IBG-998811", method: "transfer" },
    { no: "RCP-2026-0002", invNo: "INV-2026-0002", cust: "CUST-002", amt: "19610.00", date: "2026-03-20", ref: "CIMB-RENTAS-887722", method: "transfer" },
    { no: "RCP-2026-0003", invNo: "INV-2026-0003", cust: "CUST-003", amt: "29680.00", date: "2026-03-22", ref: "PBB-EFT-776633", method: "transfer" },
    { no: "RCP-2026-0004", invNo: "INV-2026-0004", cust: "CUST-005", amt: "15900.00", date: "2026-03-25", ref: "HLB-CHQ-123456", method: "cheque" },
  ];

  for (const r of receiptsData) {
    const existing = await database.execute<{ id: string }>(sql`SELECT id FROM accounting.receipt WHERE receipt_no = ${r.no}`);
    if (!existing.rows?.[0]) {
      // Insert receipt as draft then post
      const res = await database.execute<{ id: string }>(sql`
        INSERT INTO accounting.receipt (
          receipt_no, customer_id, receipt_date, amount, method,
          reference, deposit_account_id, status, created_by
        ) VALUES (
          ${r.no}, ${custIds[r.cust]}, ${r.date}, ${r.amt}, ${r.method},
          ${r.ref}, ${acc1251.rows[0].id}, 'draft', ${accountantUid}
        ) RETURNING id
      `);
      const rid = res.rows[0].id;

      // Create receipt journal
      const jrnNo = `JRN-${r.no}`;
      const jrnRes = await database.execute<{ id: string }>(sql`
        INSERT INTO accounting.journal (
          journal_no, period_id, entry_date, memo, source_type, source_id, status, created_by
        ) VALUES (
          ${jrnNo}, ${marPeriodId}, ${r.date}, ${`Receipt ${r.no} - ${r.ref}`}, 'receipt', ${rid}, 'draft', ${accountantUid}
        ) RETURNING id
      `);
      const jid = jrnRes.rows[0].id;

      await database.execute(sql`
        INSERT INTO accounting.journal_line (journal_id, line_no, account_id, debit, credit, description)
        VALUES (${jid}, 1, ${acc1251.rows[0].id}, ${r.amt}, 0, 'Receipt collection deposit')
      `);
      await database.execute(sql`
        INSERT INTO accounting.journal_line (journal_id, line_no, account_id, debit, credit, description)
        VALUES (${jid}, 2, (SELECT id FROM accounting.account WHERE code = '1210'), 0, ${r.amt}, 'Customer invoice collection')
      `);

      await database.execute(sql`
        UPDATE accounting.journal
           SET status = 'posted',
               posted_at = ${r.date}::date + interval '14 hours',
               posted_by = ${adminUid}
         WHERE id = ${jid}
      `);

      await database.execute(sql`
        UPDATE accounting.receipt
           SET status = 'posted',
               journal_id = ${jid},
               posted_at = ${r.date}::date + interval '14 hours',
               posted_by = ${adminUid}
         WHERE id = ${rid}
      `);

      // Allocate to invoice (trigger derives invoice.status = 'paid'!)
      const targetInvoiceId = invIds[r.invNo];
      if (targetInvoiceId) {
        await database.execute(sql`
          INSERT INTO accounting.allocation (
            invoice_id, source_type, receipt_id, amount, allocated_by
          ) VALUES (
            ${targetInvoiceId}, 'receipt', ${rid}, ${r.amt}, ${adminUid}
          )
        `);
      }
    }
  }

  // Supplier Invoices (Bills)
  const billsData = [
    { no: "BILL-2026-0001", docNo: "PTG-INV-2026-8819", supp: "SUPP-004", sub: "4200.00", tax: "0.00", tot: "4200.00", date: "2026-03-02", due: "2026-03-16", desc: "PTG Johor Official Land Search & Title Extract Fees", acct: "5110", status: "settled" },
    { no: "BILL-2026-0002", docNo: "TNB-BILL-908234", supp: "SUPP-001", sub: "1850.00", tax: "111.00", tot: "1961.00", date: "2026-03-05", due: "2026-03-25", desc: "Tenaga Nasional Corporate Office Electricity Consumption", acct: "7110", status: "settled" },
    { no: "BILL-2026-0003", docNo: "TM-2026-03-49102", supp: "SUPP-002", sub: "680.00", tax: "40.80", tot: "720.80", date: "2026-03-08", due: "2026-03-28", desc: "TM Unifi Business High-Speed Fibre Broadband (800Mbps)", acct: "7115", status: "settled" },
    { no: "BILL-2026-0004", docNo: "AC-SUB-2026-03", supp: "SUPP-003", sub: "3600.00", tax: "216.00", tot: "3816.00", date: "2026-03-15", due: "2026-04-14", desc: "AutoCount ERP Cloud Subscription & Multi-User License", acct: "7140", status: "posted" },
    { no: "BILL-2026-0005", docNo: "CN-LEASE-2026-03", supp: "SUPP-005", sub: "1450.00", tax: "87.00", tot: "1537.00", date: "2026-03-20", due: "2026-04-19", desc: "Canon Heavy-Duty Colour Scanner & Laser Plotter Rental", acct: "7150", status: "posted" },
  ];

  const billIds: Record<string, string> = {};
  for (const b of billsData) {
    const existing = await database.execute<{ id: string }>(sql`SELECT id FROM accounting.supplier_invoice WHERE bill_no = ${b.no}`);
    if (!existing.rows?.[0]) {
      // 1. Insert header as draft
      const res = await database.execute<{ id: string }>(sql`
        INSERT INTO accounting.supplier_invoice (
          supplier_id, supplier_doc_no, bill_date, due_date, received_date, subject, status, currency, created_by
        ) VALUES (
          ${suppIds[b.supp]}, ${b.docNo}, ${b.date}, ${b.due}, ${b.date}, ${b.desc}, 'draft', 'MYR', ${accountantUid}
        ) RETURNING id
      `);
      const bid = res.rows[0].id;
      billIds[b.no] = bid;

      // 2. Insert line
      await database.execute(sql`
        INSERT INTO accounting.supplier_invoice_line (
          supplier_invoice_id, line_no, description, quantity, unit_price,
          discount_amount, tax_code_id, tax_amount, line_subtotal, line_total, account_id
        ) VALUES (
          ${bid}, 1, ${b.desc}, 1, ${b.sub},
          0, ${parseFloat(b.tax) > 0 ? sstInRow.rows[0].id : null}, ${b.tax}, ${b.sub}, ${b.tot},
          (SELECT id FROM accounting.account WHERE code = ${b.acct})
        )
      `);

      // 3. Advance to pending_approval -> approved -> posted
      await database.execute(sql`UPDATE accounting.supplier_invoice SET status = 'pending_approval' WHERE id = ${bid}`);
      await database.execute(sql`
        UPDATE accounting.supplier_invoice
           SET status = 'approved',
               approved_at = now(),
               approved_by = ${adminUid}
         WHERE id = ${bid}
      `);
      // Create bill journal
      const jrnNo = `JRN-${b.no}`;
      const jrnRes = await database.execute<{ id: string }>(sql`
        INSERT INTO accounting.journal (
          journal_no, period_id, entry_date, memo, source_type, source_id, status, created_by
        ) VALUES (
          ${jrnNo}, ${marPeriodId}, ${b.date}, ${`Bill ${b.no} - ${b.desc}`}, 'supplier_invoice', ${bid}, 'draft', ${accountantUid}
        ) RETURNING id
      `);
      const jid = jrnRes.rows[0].id;

      await database.execute(sql`
        INSERT INTO accounting.journal_line (journal_id, line_no, account_id, debit, credit, description)
        VALUES (${jid}, 1, (SELECT id FROM accounting.account WHERE code = ${b.acct}), ${b.sub}, 0, ${b.desc})
      `);

      let nextLineNo = 2;
      if (parseFloat(b.tax) > 0) {
        await database.execute(sql`
          INSERT INTO accounting.journal_line (journal_id, line_no, account_id, debit, credit, description)
          VALUES (${jid}, ${nextLineNo++}, (SELECT id FROM accounting.account WHERE code = '1260'), ${b.tax}, 0, 'SST 6% Input tax')
        `);
      }

      await database.execute(sql`
        INSERT INTO accounting.journal_line (journal_id, line_no, account_id, debit, credit, description)
        VALUES (${jid}, ${nextLineNo}, (SELECT id FROM accounting.account WHERE code = '2110'), 0, ${b.tot}, ${b.desc})
      `);

      await database.execute(sql`
        UPDATE accounting.journal
           SET status = 'posted',
               posted_at = ${b.date}::date + interval '12 hours',
               posted_by = ${accountantUid}
         WHERE id = ${jid}
      `);

      await database.execute(sql`
        UPDATE accounting.supplier_invoice
           SET status = 'posted',
               bill_no = ${b.no},
               journal_id = ${jid},
               posted_at = ${b.date}::date + interval '12 hours',
               posted_by = ${accountantUid}
         WHERE id = ${bid}
      `);
    } else {
      billIds[b.no] = existing.rows[0].id;
    }
  }

  // Payment Vouchers (Settling bills 1 to 3)
  const vouchersData = [
    { no: "PV-2026-0001", billNo: "BILL-2026-0001", supp: "SUPP-004", amt: "4200.00", date: "2026-03-10", ref: "MBB-TRANSFER-1100" },
    { no: "PV-2026-0002", billNo: "BILL-2026-0002", supp: "SUPP-001", amt: "1961.00", date: "2026-03-18", ref: "MBB-JOMPAY-5544" },
    { no: "PV-2026-0003", billNo: "BILL-2026-0003", supp: "SUPP-002", amt: "720.80", date: "2026-03-22", ref: "MBB-AUTOPAY-9988" },
  ];

  for (const v of vouchersData) {
    const existing = await database.execute<{ id: string }>(sql`SELECT id FROM accounting.payment_voucher WHERE voucher_no = ${v.no}`);
    if (!existing.rows?.[0]) {
      const res = await database.execute<{ id: string }>(sql`
        INSERT INTO accounting.payment_voucher (
          voucher_no, supplier_id, voucher_date, reference, subject,
          kind, settlement, method, payment_account_id, status, currency,
          subtotal, total, created_by
        ) VALUES (
          ${v.no}, ${suppIds[v.supp]}, ${v.date}, ${v.ref}, 'Supplier Bill Settlement',
          'settlement', 'paid', 'transfer', ${acc1251.rows[0].id}, 'draft', 'MYR',
          ${v.amt}, ${v.amt}, ${accountantUid}
        ) RETURNING id
      `);
      const vid = res.rows[0].id;

      await database.execute(sql`
        INSERT INTO accounting.payment_voucher_line (
          voucher_id, line_no, description, quantity, unit_price,
          line_subtotal, line_total, account_id
        ) VALUES (
          ${vid}, 1, 'Bill settlement', 1, ${v.amt},
          ${v.amt}, ${v.amt}, (SELECT id FROM accounting.account WHERE code = '2110')
        )
      `);

      await database.execute(sql`UPDATE accounting.payment_voucher SET status = 'pending_approval' WHERE id = ${vid}`);
      await database.execute(sql`
        UPDATE accounting.payment_voucher
           SET status = 'approved',
               approved_at = now(),
               approved_by = ${adminUid}
         WHERE id = ${vid}
      `);

      // Create voucher journal
      const jrnNo = `JRN-${v.no}`;
      const jrnRes = await database.execute<{ id: string }>(sql`
        INSERT INTO accounting.journal (
          journal_no, period_id, entry_date, memo, source_type, source_id, status, created_by
        ) VALUES (
          ${jrnNo}, ${marPeriodId}, ${v.date}, ${`Voucher ${v.no} - ${v.ref}`}, 'voucher', ${vid}, 'draft', ${accountantUid}
        ) RETURNING id
      `);
      const jid = jrnRes.rows[0].id;

      await database.execute(sql`
        INSERT INTO accounting.journal_line (journal_id, line_no, account_id, debit, credit, description)
        VALUES (${jid}, 1, (SELECT id FROM accounting.account WHERE code = '2110'), ${v.amt}, 0, 'Supplier bill settlement')
      `);
      await database.execute(sql`
        INSERT INTO accounting.journal_line (journal_id, line_no, account_id, debit, credit, description)
        VALUES (${jid}, 2, ${acc1251.rows[0].id}, 0, ${v.amt}, 'Maybank electronic payment')
      `);

      await database.execute(sql`
        UPDATE accounting.journal
           SET status = 'posted',
               posted_at = ${v.date}::date + interval '15 hours',
               posted_by = ${accountantUid}
         WHERE id = ${jid}
      `);

      await database.execute(sql`
        UPDATE accounting.payment_voucher
           SET status = 'posted',
               journal_id = ${jid},
               posted_at = ${v.date}::date + interval '15 hours',
               posted_by = ${accountantUid}
         WHERE id = ${vid}
      `);

      // Settle bill
      const targetBillId = billIds[v.billNo];
      if (targetBillId) {
        await database.execute(sql`
          INSERT INTO accounting.payable_settlement (
            supplier_invoice_id, source_type, voucher_id, amount, settled_by
          ) VALUES (
            ${targetBillId}, 'voucher', ${vid}, ${v.amt}, ${accountantUid}
          )
        `);
      }
    }
  }

  console.log("--> [9/10] Seeding Balanced General Ledger Journals (0 Trial Balance Discrepancy)...");
  // Balanced Opening Journal: Cash RM 350k, Equipment RM 35k, Renovation RM 65k = Share Capital RM 450k
  const openingJrn = await database.execute<{ id: string }>(sql`
    SELECT id FROM accounting.journal WHERE journal_no = 'JRN-2026-0001'
  `);
  if (!openingJrn.rows?.[0]) {
    const res = await database.execute<{ id: string }>(sql`
      INSERT INTO accounting.journal (
        journal_no, period_id, entry_date, memo, source_type, status, created_by
      ) VALUES (
        'JRN-2026-0001', ${janPeriodId}, '2026-01-01', 'Opening balances brought forward into CAC platform', 'opening', 'draft', ${adminUid}
      ) RETURNING id
    `);
    const jid = res.rows[0].id;

    // Line 1: Maybank Operating (1251) Debit RM 350,000
    await database.execute(sql`
      INSERT INTO accounting.journal_line (journal_id, line_no, account_id, debit, credit, description)
      VALUES (${jid}, 1, ${acc1251.rows[0].id}, 350000.0000, 0, 'Opening cash at bank balance')
    `);
    // Line 2: Computer Equipment (1120) Debit RM 35,000
    await database.execute(sql`
      INSERT INTO accounting.journal_line (journal_id, line_no, account_id, debit, credit, description)
      VALUES (${jid}, 2, (SELECT id FROM accounting.account WHERE code = '1120'), 35000.0000, 0, 'High-performance appraisal computing hardware & servers')
    `);
    // Line 3: Renovation (1150) Debit RM 65,000
    await database.execute(sql`
      INSERT INTO accounting.journal_line (journal_id, line_no, account_id, debit, credit, description)
      VALUES (${jid}, 3, (SELECT id FROM accounting.account WHERE code = '1150'), 65000.0000, 0, 'Skudai office executive fit-out & client lounge')
    `);
    // Line 4: Share Capital (3100) Credit RM 450,000
    await database.execute(sql`
      INSERT INTO accounting.journal_line (journal_id, line_no, account_id, debit, credit, description)
      VALUES (${jid}, 4, (SELECT id FROM accounting.account WHERE code = '3100'), 0, 450000.0000, 'Issued and paid-up ordinary share capital')
    `);

    // Post opening journal
    await database.execute(sql`
      UPDATE accounting.journal
         SET status = 'posted',
             posted_at = '2026-01-01 09:00:00+08',
             posted_by = ${adminUid}
       WHERE id = ${jid}
    `);
  }

  // Month-End Adjustment Journal: Debits Utilities RM 350, Credits Payables RM 350
  const adjJrn = await database.execute<{ id: string }>(sql`
    SELECT id FROM accounting.journal WHERE journal_no = 'JRN-2026-0002'
  `);
  if (!adjJrn.rows?.[0]) {
    const res = await database.execute<{ id: string }>(sql`
      INSERT INTO accounting.journal (
        journal_no, period_id, entry_date, memo, source_type, status, created_by
      ) VALUES (
        'JRN-2026-0002', ${marPeriodId}, '2026-03-31', 'Month-end utilities accrual adjustment for Skudai branch office', 'manual', 'draft', ${accountantUid}
      ) RETURNING id
    `);
    const jid = res.rows[0].id;

    await database.execute(sql`
      INSERT INTO accounting.journal_line (journal_id, line_no, account_id, debit, credit, description)
      VALUES (${jid}, 1, (SELECT id FROM accounting.account WHERE code = '7110'), 350.0000, 0, 'Accrued TNB electricity expenses for March')
    `);
    await database.execute(sql`
      INSERT INTO accounting.journal_line (journal_id, line_no, account_id, debit, credit, description)
      VALUES (${jid}, 2, (SELECT id FROM accounting.account WHERE code = '2110'), 0, 350.0000, 'Accrued trade creditors liability')
    `);

    await database.execute(sql`
      UPDATE accounting.journal
         SET status = 'posted',
             posted_at = '2026-03-31 18:00:00+08',
             posted_by = ${adminUid}
       WHERE id = ${jid}
    `);
  }

  console.log("--> [10/10] Seeding Legal AI Estate Cases, Checklist Rules & CRM Enquiries...");
  // Requirement Rules
  const reqRules = [
    {
      code: "DEATH_CERT",
      title: "Certified Copy of Official Death Certificate (JPN)",
      kind: "document",
      source: "Births and Deaths Registration Act 1957 (Act 299)",
      matters: ["probate", "letters_of_administration", "estate_inventory"],
    },
    {
      code: "WILL_ORIGINAL",
      title: "Original Testamentary Will and Codicils",
      kind: "document",
      source: "Wills Act 1959 (Act 346), s4 & s5",
      matters: ["probate"],
    },
    {
      code: "LAND_TITLE_SEARCH",
      title: "Certified Land Registry Title Search & Ownership Verification",
      kind: "document",
      source: "National Land Code (Revised 2020), s384",
      matters: ["probate", "letters_of_administration", "estate_inventory", "valuation"],
    },
    {
      code: "BORANG_A",
      title: "Borang A - Application for Small Estate Distribution",
      kind: "form",
      source: "Small Estates (Distribution) Act 1955 (Act 98), s8",
      matters: ["letters_of_administration"],
    },
    {
      code: "LHDN_TAX_CLEARANCE",
      title: "LHDN Inland Revenue Board Estate Tax Clearance Letter",
      kind: "document",
      source: "Income Tax Act 1967, s74",
      matters: ["probate", "letters_of_administration"],
    },
  ];

  const ruleIds: Record<string, string> = {};
  for (const r of reqRules) {
    const existingRule = await database.execute<{ id: string }>(sql`
      SELECT id FROM estate.requirement_rule WHERE code = ${r.code} AND version = 1
    `);
    if (!existingRule.rows?.[0]) {
      const mattersArrayStr = `{${r.matters.join(",")}}`;
      const res = await database.execute<{ id: string }>(sql`
        INSERT INTO estate.requirement_rule (
          code, version, title, kind, source_ref, matter_types, status,
          approved_at, approved_by, created_by
        ) VALUES (
          ${r.code}, 1, ${r.title}, ${r.kind}, ${r.source}, ${mattersArrayStr}::text[], 'approved',
          now(), ${legalUid}, ${valuerUid}
        ) RETURNING id
      `);
      ruleIds[r.code] = res.rows[0].id;
    } else {
      ruleIds[r.code] = existingRule.rows[0].id;
    }
  }

  // Estate Cases
  const casesData = [
    {
      no: "EST-2026-0001",
      type: "probate",
      title: "Estate of Late Tan Sri Lim Ah Lek (Grant of Probate)",
      deceased: "Tan Sri Lim Ah Lek",
      nric: "450912-01-5231",
      dod: "2025-11-20",
      pod: "Pantai Hospital Kuala Lumpur",
      opened: "2026-01-10",
      status: "open",
      courtRef: "High Court of Malaya at Johor Bahru WA-31NCvC-104-01/2026",
      registry: "Johor Bahru High Court Probate Registry",
      notes: "Substantial freehold commercial assets in Iskandar Puteri and Bukit Indah.",
    },
    {
      no: "EST-2026-0002",
      type: "letters_of_administration",
      title: "Estate of Late Dato' Haji Mohd Yusof bin Kassim",
      deceased: "Dato' Haji Mohd Yusof bin Kassim",
      nric: "520314-01-5847",
      dod: "2025-12-05",
      pod: "KPJ Johor Specialist Hospital",
      opened: "2026-01-15",
      status: "open",
      courtRef: "High Court of Malaya at Muar 32NCvC-45-01/2026",
      registry: "Muar High Court Registry",
      notes: "Intestate estate requiring Distribution Act 1958 Faraid and civil consensus.",
    },
    {
      no: "EST-2026-0003",
      type: "letters_of_administration",
      title: "Estate of Late Dr. K. Ramanathan (Small Estate Distribution)",
      deceased: "Dr. K. Ramanathan a/l Krishnan",
      nric: "581225-01-5493",
      dod: "2026-01-02",
      pod: "Hospital Sultanah Aminah Johor Bahru",
      opened: "2026-02-01",
      status: "open",
      courtRef: "Pejabat Tanah Johor Bahru BP/JKPTG/JB/2026/088",
      registry: "Unit Pembahagian Pusaka Kecil Negeri Johor",
      notes: "Total gross value under RM 5,000,000. Proceeding under Act 98 Borang A.",
    },
    {
      no: "EST-2026-0004",
      type: "estate_inventory",
      title: "Estate of Late Madam Chong Sook Yin (Asset Tracing & Title Tracing)",
      deceased: "Chong Sook Yin",
      nric: "610708-01-5120",
      dod: "2026-01-18",
      pod: "Kulai Private Medical Centre",
      opened: "2026-02-10",
      status: "open",
      courtRef: null,
      registry: null,
      notes: "Forensic title reconstruction across 4 parcels in Mukim Senai.",
    },
    {
      no: "EST-2026-0005",
      type: "probate",
      title: "Estate of Late Capt. Ahmad Razali (Probate Advisory)",
      deceased: "Capt. Ahmad Razali bin Othman",
      nric: "630419-01-6109",
      dod: "2026-02-05",
      pod: "Subang Jaya Medical Centre",
      opened: "2026-02-25",
      status: "open",
      courtRef: "High Court of Malaya WA-31NCvC-215-02/2026",
      registry: "Kuala Lumpur High Court Probate Registry",
      notes: "Co-executors instructed CAC to extract formal grant and evaluate port warehouse.",
    },
    {
      no: "EST-2026-0006",
      type: "valuation",
      title: "Estate of Late Lee Swee Kiat (Comprehensive Valuation & Probate)",
      deceased: "Lee Swee Kiat",
      nric: "550505-01-5678",
      dod: "2026-02-14",
      pod: "Columbia Asia Hospital Iskandar Puteri",
      opened: "2026-03-01",
      status: "open",
      courtRef: null,
      registry: null,
      notes: "Valuation of 2 industrial factories in Senai Airport City for probate schedule.",
    },
  ];

  for (const c of casesData) {
    const existingCase = await database.execute<{ id: string }>(sql`
      SELECT id FROM estate.case WHERE case_no = ${c.no}
    `);
    if (!existingCase.rows?.[0]) {
      const decIdEnc = encryptSecret(c.nric);
      const decIdLast4 = c.nric.replace(/-/g, "").slice(-4);

      const res = await database.execute<{ id: string }>(sql`
        INSERT INTO estate.case (
          case_no, matter_type, title, status, customer_id, instructed_by,
          deceased_name, deceased_id_enc, deceased_id_last4, date_of_death, place_of_death,
          domicile_state, court_reference, registry, opened_on, notes, created_by
        ) VALUES (
          ${c.no}, ${c.type}, ${c.title}, ${c.status}, ${custIds["CUST-005"]}, 'Lead Executor / Solicitor',
          ${c.deceased}, ${decIdEnc}, ${decIdLast4}, ${c.dod}, ${c.pod},
          'Johor', ${c.courtRef}, ${c.registry}, ${c.opened}, ${c.notes}, ${legalUid}
        ) RETURNING id
      `);
      const cid = res.rows[0].id;

      // Assignments: Legal Counsel (Lead), Valuer (Contributor)
      await database.execute(sql`
        INSERT INTO estate.case_assignment (case_id, employee_id, role, assigned_by)
        VALUES (${cid}, ${empIds["EMP-0003"]}, 'lead', ${adminUid})
      `);
      await database.execute(sql`
        INSERT INTO estate.case_assignment (case_id, employee_id, role, assigned_by)
        VALUES (${cid}, ${empIds["EMP-0002"]}, 'contributor', ${adminUid})
      `);

      // Checklist Requirements
      const reqList = [
        { code: "DEATH_CERT", title: "Certified Copy of Official Death Certificate (JPN)", stat: "satisfied" },
        { code: "LAND_TITLE_SEARCH", title: "Certified Land Registry Title Search & Ownership Verification", stat: "in_progress" },
        ...(c.type === "probate" ? [{ code: "WILL_ORIGINAL", title: "Original Testamentary Will and Codicils", stat: "satisfied" }] : []),
        { code: "LHDN_TAX_CLEARANCE", title: "LHDN Inland Revenue Board Estate Tax Clearance Letter", stat: "outstanding" },
      ];

      for (const [sIdx, req] of reqList.entries()) {
        const rid = ruleIds[req.code];
        let docId: string | null = null;
        if (req.stat === "satisfied") {
          const docRes = await database.execute<{ id: string }>(sql`
            INSERT INTO estate.case_document (
              case_id, title, doc_kind, form, received_on, received_from, filed_at, created_by
            ) VALUES (
              ${cid}, ${req.title}, 'statutory', 'certified_copy', '2026-01-20',
              'Lead Executor / Solicitor', 'CAC Central Safe Archive B-04', ${legalUid}
            ) RETURNING id
          `);
          docId = docRes.rows[0].id;
        }

        const reqInsert = await database.execute<{ id: string }>(sql`
          INSERT INTO estate.case_requirement (
            case_id, rule_id, rule_code, rule_version, title, kind, source_ref,
            status, document_id, satisfied_at, satisfied_by, sort_order, created_by
          ) VALUES (
            ${cid}, ${rid}, ${req.code}, 1, ${req.title}, 'document', 'Statutory Checklist',
            ${req.stat}, ${docId}, ${docId ? sql`now()` : null}, ${docId ? legalUid : null},
            ${(sIdx + 1) * 10}, ${legalUid}
          ) RETURNING id
        `);
        const requirementId = reqInsert.rows[0].id;

        // Create associated task for each in_progress or outstanding item
        if (req.stat === "in_progress" || req.stat === "outstanding") {
          await database.execute(sql`
            INSERT INTO estate.case_task (
              case_id, requirement_id, title, detail, assignee_id, due_on,
              priority, status, created_by
            ) VALUES (
              ${cid}, ${requirementId}, ${`Follow up: ${req.title}`}, 'Liaise with Land Registry and family representatives',
              ${empIds["EMP-0006"]}, '2026-04-15', 'high', 'in_progress', ${legalUid}
            )
          `);
        }
      }
    }
  }

  // Public Appraisal & Estate Enquiries (CRM)
  console.log("   - Seeding public appraisal & estate enquiries (org.enquiry)...");
  const enquiriesData = [
    {
      ref: "ENQ-2026-0001",
      name: "Datin Hajah Faridah binti Mansor",
      email: "faridah.mansor@gmail.com",
      phone: "+60 19-712 3456",
      company: "Family Estate",
      service: "Estate Administration & Probate",
      msg: "We are seeking consultation for the probate of agricultural land (approx. 25 acres) in Kulai left by my late husband. Will was drafted in 2018.",
      status: "in_progress",
    },
    {
      ref: "ENQ-2026-0002",
      name: "Marcus Tan Kian Meng",
      email: "marcus.tan@apexcapital.my",
      phone: "+60 12-388 9911",
      company: "Apex Capital Partners",
      service: "Property Forensic & Valuation",
      msg: "Need valuation report for 3 contiguous 3-storey shop offices in Taman Molek, Johor Bahru for mortgage refinancing with RHB Bank.",
      status: "answered",
      handledNote: "Called client, sent formal engagement proposal and quotation QT-2026-0002.",
    },
    {
      ref: "ENQ-2026-0003",
      name: "Tuan Haji Kamaruzzaman bin Ariffin",
      email: "kamaruzzaman@johorland.com.my",
      phone: "+60 13-987 6543",
      company: "Johor Land Berhad",
      service: "Land Registry Search & Forensic Survey",
      msg: "Urgent title historical tracing required for alienation parcel in Mukim Plentong dating back to 1982.",
      status: "new",
    },
    {
      ref: "ENQ-2026-0004",
      name: "Dr. Evelyn Wong Sook Fong",
      email: "evelyn.wong@gleneagles.com.my",
      phone: "+60 16-222 8901",
      company: null,
      service: "Estate Administration & Probate",
      msg: "Inquiry on Small Estate Distribution procedure for semi-detached home in Horizon Hills without a will. Estimated value RM 1.8M.",
      status: "in_progress",
    },
    {
      ref: "ENQ-2026-0005",
      name: "Syed Alwi bin Syed Hassan",
      email: "alwi.hassan@yusofholding.com",
      phone: "+60 17-555 4321",
      company: "Yusof Holding Sdn Bhd",
      service: "Property Forensic & Valuation",
      msg: "Appraisal needed for industrial land in Tanjung Langsat Heavy Industrial Park for internal corporate restructuring.",
      status: "answered",
      handledNote: "Detailed scope of valuation agreed. Site inspection scheduled for next Tuesday.",
    },
    {
      ref: "ENQ-2026-0006",
      name: "Rajesh Kumar a/l Subramaniam",
      email: "rajesh.kumar@rklegal.my",
      phone: "+60 12-444 7788",
      company: "Messrs Rajesh & Associates",
      service: "Expert Witness & Court Valuation",
      msg: "Seeking registered appraiser for court expert testimony in compulsory land acquisition compensation dispute in Segamat.",
      status: "new",
    },
  ];

  for (const eq of enquiriesData) {
    const existing = await database.execute(sql`SELECT id FROM org.enquiry WHERE reference = ${eq.ref}`);
    if (!existing.rows?.[0]) {
      await database.execute(sql`
        INSERT INTO org.enquiry (
          reference, name, email, phone, company, service, message, source,
          status, assigned_to, handled_at, handled_by, handling_note
        ) VALUES (
          ${eq.ref}, ${eq.name}, ${eq.email}, ${eq.phone}, ${eq.company}, ${eq.service}, ${eq.msg}, 'website',
          ${eq.status}, ${adminUid},
          ${eq.status === "answered" ? sql`now()` : null},
          ${eq.status === "answered" ? adminUid : null},
          ${eq.handledNote ?? null}
        )
      `);
    }
  }

  // Update Sequences so subsequent UI creations increment seamlessly
  console.log("   - Updating system sequence counters for seamless UI usage...");
  await database.execute(sql`UPDATE org.document_sequence SET next_value = '9' WHERE key = 'invoice'`);
  await database.execute(sql`UPDATE org.document_sequence SET next_value = '5' WHERE key = 'receipt'`);
  await database.execute(sql`UPDATE org.document_sequence SET next_value = '7' WHERE key = 'quotation'`);
  await database.execute(sql`UPDATE org.document_sequence SET next_value = '6' WHERE key = 'supplier_invoice'`);
  await database.execute(sql`UPDATE org.document_sequence SET next_value = '4' WHERE key = 'payment_voucher'`);
  await database.execute(sql`UPDATE org.document_sequence SET next_value = '7' WHERE key = 'case'`);
  await database.execute(sql`UPDATE org.document_sequence SET next_value = '7' WHERE key = 'enquiry'`);
  await database.execute(sql`UPDATE org.document_sequence SET next_value = '7' WHERE key = 'employee'`);

  // Append Audit Events
  console.log("   - Recording system audit events for client audit trail demo...");
  await database.execute(sql`
    INSERT INTO audit.event (actor_user_id, actor_label, action, entity_type, entity_id, reason)
    VALUES (
      ${adminUid}, 'admin@conglomerate4u.com', 'DEMO_DATASET_INITIALISED', 'system', ${adminUid},
      'Client demonstration master dataset successfully populated across Accounting, HRMS, Legal AI and CRM'
    )
  `);

  console.log("\n==========================================================================");
  console.log(" SUCCESS: Conglomerate Appraisal Consultancy (CAC) Demo Dataset Seeded!");
  console.log("==========================================================================");
  console.log(" Auth Demo Accounts (Password for all: Admin@cac2026!):");
  console.log("   - Super Admin & Director : admin@conglomerate4u.com");
  console.log("   - Lead Appraiser         : valuer@conglomerate4u.com");
  console.log("   - Senior Legal Counsel   : legal@conglomerate4u.com");
  console.log("   - Financial Controller   : accountant@conglomerate4u.com");
  console.log("   - HR & People Manager    : hr@conglomerate4u.com");
  console.log("   - Operations Specialist  : staff@conglomerate4u.com");
  console.log("==========================================================================\n");
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  (async () => {
    await seedDemo();
    await closeDb();
    process.exit(0);
  })().catch((error) => {
    console.error("Demo seed failed:", error);
    process.exit(1);
  });
}
