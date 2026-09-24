import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, type Principal } from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { parseIsoDate, today, toIsoDate } from "./dates.js";
import { findColumn, readDelimited } from "./delimited.js";

/**
 * Attendance, and getting it out of a thumbprint device.
 *
 * The importer is the reason this module is careful. A device export is somebody
 * else's file: the columns vary by model and firmware, the date format varies, the
 * device identifies people by its own number, and the same person scanning twice
 * in thirty seconds produces two rows. Attendance feeds payroll, so every one of
 * those is a route to a wrong payslip.
 *
 * So nothing is written straight through. An import is **staged**, validated
 * row by row, previewed with every rejection and its reason visible, and reaches
 * attendance only when somebody confirms it. That is what the brief asks for, and
 * it is also the only arrangement where a mistake is cheap.
 *
 * **Q-HR-2 is still open**, and this is built accordingly. CAC has not supplied a
 * sample export, so the importer is not written against a particular device's
 * format: it reads any delimited file, maps the columns explicitly, and handles the
 * two shapes real devices use — one row per scan (paired into in and out), or one
 * row per day with both times. Guessing a specific layout would be guessing, and a
 * guess here is a month of misread attendance. Once a real export arrives the
 * mapping is remembered against the device and nobody re-maps it monthly.
 */

export type ImportRowState = "ok" | "problem" | "duplicate" | "imported";
export type AttendanceSource = "device" | "manual" | "imported_corrected" | "leave" | "holiday";

export interface AttendanceColumnMapping {
  /** The device's own number for the person. Preferred over the name. */
  deviceUserId?: number;
  /** A fallback only, and a poor one: two people called Tan is a real situation. */
  employeeName?: number;
  employeeNo?: number;
  /** One row per day with both times in it. */
  date?: number;
  clockIn?: number;
  clockOut?: number;
  /** One row per scan: a timestamp, optionally with an in/out marker. */
  timestamp?: number;
  direction?: number;
  dateFormat?: "auto" | "dmy" | "mdy" | "ymd";
}

export interface StagedRow {
  rowNo: number;
  raw: string[];
  deviceUserId: string | null;
  employeeId: string | null;
  employeeName: string | null;
  workDate: string | null;
  clockIn: string | null;
  clockOut: string | null;
  state: ImportRowState;
  problem: string | null;
}

export interface StagedImport {
  header: string[];
  mapping: AttendanceColumnMapping;
  /** One entry per employee-day after pairing, which is what will be written. */
  rows: StagedRow[];
  earliest: string | null;
  latest: string | null;
  digest: string;
  /** Device numbers in the file that match no employee record. */
  unmappedDeviceIds: string[];
  okCount: number;
  problemCount: number;
  duplicateCount: number;
}

/**
 * Guesses which column is which.
 *
 * Shown to the person before it is used, never applied silently. The candidate
 * lists lean towards what thumbprint devices actually emit — `USERID`, `AC-No.`,
 * `Check In`, `Date/Time` — but the guess is only a starting point.
 */
export function guessAttendanceMapping(header: string[]): Partial<AttendanceColumnMapping> {
  const deviceUserId = findColumn(header, [
    "userid",
    "user id",
    "device user id",
    "acno",
    "ac no",
    "enrollno",
    "enroll number",
    "employee id",
    "id number",
    "no",
  ]);
  const employeeName = findColumn(header, ["name", "employee name", "staff name", "nama"]);
  const employeeNo = findColumn(header, ["employee no", "employee number", "staff no", "emp no"]);
  const date = findColumn(header, ["date", "work date", "attendance date", "tarikh"]);
  const clockIn = findColumn(header, ["check in", "clock in", "time in", "in", "masuk"]);
  const clockOut = findColumn(header, ["check out", "clock out", "time out", "out", "keluar"]);
  const timestamp = findColumn(header, [
    "datetime",
    "date time",
    "date/time",
    "punch time",
    "scan time",
    "time",
    "timestamp",
  ]);
  const direction = findColumn(header, ["status", "in out", "inout", "type", "direction", "state"]);

  const mapping: Partial<AttendanceColumnMapping> = {};
  if (deviceUserId !== -1) mapping.deviceUserId = deviceUserId;
  if (employeeName !== -1) mapping.employeeName = employeeName;
  if (employeeNo !== -1) mapping.employeeNo = employeeNo;
  if (direction !== -1) mapping.direction = direction;

  // A file with separate in and out columns is one row per day. Otherwise it is one
  // row per scan and the timestamps have to be paired.
  if (clockIn !== -1 && clockOut !== -1 && clockIn !== clockOut) {
    if (date !== -1) mapping.date = date;
    mapping.clockIn = clockIn;
    mapping.clockOut = clockOut;
  } else if (timestamp !== -1) {
    mapping.timestamp = timestamp;
  } else if (date !== -1 && clockIn !== -1) {
    mapping.date = date;
    mapping.clockIn = clockIn;
  }

  return mapping;
}

/** Reads a date, refusing an ambiguous one rather than choosing a month by coin flip. */
function readDate(raw: string, format: AttendanceColumnMapping["dateFormat"], field: string): string {
  const text = raw.trim();
  if (text === "") throw new ValidationError("The date is missing.", field);

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) return assemble(Number(iso[1]), Number(iso[2]), Number(iso[3]), text, field);

  const parts = /^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{2,4})/.exec(text);
  if (!parts) throw new ValidationError(`"${text}" is not a date this can read.`, field);

  const a = Number(parts[1]);
  const b = Number(parts[2]);
  const c = Number(parts[3]);
  const year = c < 100 ? 2000 + c : c;

  if (format === "ymd") return assemble(a < 100 ? 2000 + a : a, b, c, text, field);
  if (format === "dmy") return assemble(year, b, a, text, field);
  if (format === "mdy") return assemble(year, a, b, text, field);

  if (a > 12 && b <= 12) return assemble(year, b, a, text, field);
  if (b > 12 && a <= 12) return assemble(year, a, b, text, field);

  throw new ValidationError(
    `"${text}" could be day-first or month-first. Say which the device uses — guessing would ` +
      "decide which month a whole file belongs to.",
    "dateFormat",
  );
}

function assemble(year: number, month: number, day: number, raw: string, field: string): string {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new ValidationError(`"${raw}" is not a real date.`, field);
  }
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (toIsoDate(parseIsoDate(iso, field)) !== iso) {
    throw new ValidationError(`"${raw}" is not a real date.`, field);
  }
  return iso;
}

/** "08:57", "8:57 AM", "0857" and "08:57:12" all mean the same thing. */
function readTime(raw: string, field: string): string {
  const text = raw.trim().toUpperCase();
  if (text === "") throw new ValidationError("The time is missing.", field);

  const meridiem = /(AM|PM)\s*$/.exec(text);
  const body = text.replace(/\s*(AM|PM)\s*$/, "").trim();

  let hours: number;
  let minutes: number;

  const colon = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(body);
  if (colon) {
    hours = Number(colon[1]);
    minutes = Number(colon[2]);
  } else if (/^\d{3,4}$/.test(body)) {
    hours = Number(body.slice(0, body.length - 2));
    minutes = Number(body.slice(-2));
  } else {
    throw new ValidationError(`"${raw}" is not a time this can read.`, field);
  }

  if (meridiem) {
    if (hours === 12) hours = meridiem[1] === "AM" ? 0 : 12;
    else if (meridiem[1] === "PM") hours += 12;
  }

  if (hours > 23 || minutes > 59) {
    throw new ValidationError(`"${raw}" is not a real time.`, field);
  }

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * A date and time as an instant.
 *
 * Malaysia has no daylight saving and a fixed +08:00 offset, so this is
 * unambiguous. Writing the offset explicitly rather than letting the server's
 * timezone decide is what stops an import run on a machine in another timezone
 * shifting everybody's clock-in by hours.
 */
function instantOf(date: string, time: string): string {
  return `${date}T${time}:00+08:00`;
}

export interface ParseOptions {
  mapping?: Partial<AttendanceColumnMapping>;
  skipRows?: number;
  delimiter?: string;
  /**
   * How long after a scan another scan by the same person is the same event.
   *
   * Devices commonly record two scans seconds apart when a finger is read twice.
   * Treating the second as a clock-out would show a two-minute working day.
   */
  duplicateWindowMinutes?: number;
}

/**
 * Reads a device export into employee-days, without writing anything.
 *
 * Two shapes are handled. **One row per day** maps a date plus an in and an out
 * column. **One row per scan** maps a timestamp; scans are then grouped by person
 * and day, and the earliest becomes the clock-in and the latest the clock-out —
 * which is the correct reading for a device that records every touch, and also
 * deals with somebody who scans four times because they went out for lunch.
 *
 * Every row that cannot be read becomes a problem with a reason, never a silently
 * dropped row. A device number nobody has mapped to an employee is reported
 * separately, because it is a one-off piece of setup rather than a bad row.
 */
export async function parseAttendanceFile(
  db: Executor,
  text: string,
  options: ParseOptions = {},
): Promise<StagedImport> {
  const table = readDelimited(text, {
    skipRows: options.skipRows,
    delimiter: options.delimiter,
    maxRows: 50000,
  });

  const mapping = {
    dateFormat: "auto" as const,
    ...guessAttendanceMapping(table.header),
    ...options.mapping,
  } as AttendanceColumnMapping;

  if (mapping.deviceUserId === undefined && mapping.employeeNo === undefined && mapping.employeeName === undefined) {
    throw new ValidationError(
      "No column identifies the employee. Say which column holds the device user number — or " +
        "the employee number, which is safer than the name.",
      "mapping.deviceUserId",
    );
  }

  const perDay = mapping.clockIn !== undefined && mapping.date !== undefined;
  if (!perDay && mapping.timestamp === undefined) {
    throw new ValidationError(
      "No column holds a time. Either a date with check-in and check-out columns, or a single " +
        "timestamp column with one row per scan.",
      "mapping.timestamp",
    );
  }

  // Everybody the device might be talking about, resolved once.
  const employees = await db.execute<{
    id: string;
    employee_no: string;
    full_name: string;
    device_user_id: string | null;
    joined_on: string;
    last_day: string | null;
  }>(sql`
    SELECT id, employee_no, full_name, device_user_id, joined_on, last_day FROM hr.employee
  `);

  const byDevice = new Map<string, (typeof employees.rows)[number]>();
  const byNumber = new Map<string, (typeof employees.rows)[number]>();
  const byName = new Map<string, (typeof employees.rows)[number]>();
  const ambiguousNames = new Set<string>();

  for (const row of employees.rows ?? []) {
    if (row.device_user_id) byDevice.set(row.device_user_id.trim(), row);
    byNumber.set(row.employee_no.trim().toUpperCase(), row);
    const name = row.full_name.trim().toLowerCase();
    if (byName.has(name)) ambiguousNames.add(name);
    else byName.set(name, row);
  }

  const cell = (row: string[], index: number | undefined) =>
    index === undefined || index < 0 ? "" : (row[index] ?? "").trim();

  interface Scan {
    employeeId: string | null;
    employeeName: string | null;
    deviceUserId: string | null;
    date: string;
    time: string;
    direction: string | null;
    rowNo: number;
    raw: string[];
  }

  const scans: Scan[] = [];
  const problems: StagedRow[] = [];
  const unmapped = new Set<string>();

  table.rows.forEach((raw, index) => {
    const rowNo = index + 1;

    const reject = (problem: string) => {
      problems.push({
        rowNo,
        raw,
        deviceUserId: cell(raw, mapping.deviceUserId) || null,
        employeeId: null,
        employeeName: cell(raw, mapping.employeeName) || null,
        workDate: null,
        clockIn: null,
        clockOut: null,
        state: "problem",
        problem,
      });
    };

    const deviceId = cell(raw, mapping.deviceUserId);
    const employeeNo = cell(raw, mapping.employeeNo);
    const name = cell(raw, mapping.employeeName);

    // Device number first, employee number second, name last and reluctantly.
    let employee = deviceId ? byDevice.get(deviceId) : undefined;
    if (!employee && employeeNo) employee = byNumber.get(employeeNo.toUpperCase());
    if (!employee && name) {
      const key = name.toLowerCase();
      if (ambiguousNames.has(key)) {
        reject(
          `More than one employee is called "${name}", so this row cannot be assigned by name. ` +
            "Map the device number instead.",
        );
        return;
      }
      employee = byName.get(key);
    }

    if (!employee) {
      if (deviceId) unmapped.add(deviceId);
      reject(
        deviceId
          ? `Device number ${deviceId} is not mapped to any employee.`
          : `No employee matches "${name || employeeNo || "(nothing)"}".`,
      );
      return;
    }

    try {
      if (perDay) {
        const date = readDate(cell(raw, mapping.date), mapping.dateFormat, "date");
        const inText = cell(raw, mapping.clockIn);
        const outText = cell(raw, mapping.clockOut);

        if (inText === "" && outText === "") {
          reject("Neither a check-in nor a check-out time is present.");
          return;
        }

        if (inText !== "") {
          scans.push({
            employeeId: employee.id,
            employeeName: employee.full_name,
            deviceUserId: deviceId || employee.device_user_id,
            date,
            time: readTime(inText, "clockIn"),
            direction: "in",
            rowNo,
            raw,
          });
        }
        if (outText !== "") {
          scans.push({
            employeeId: employee.id,
            employeeName: employee.full_name,
            deviceUserId: deviceId || employee.device_user_id,
            date,
            time: readTime(outText, "clockOut"),
            direction: "out",
            rowNo,
            raw,
          });
        }
      } else {
        const stamp = cell(raw, mapping.timestamp);
        // "12/07/2026 08:57" or "12/07/2026,08:57" once split — the date and the
        // time may share a cell.
        const split = stamp.split(/[\sT]+/).filter((part) => part !== "");
        if (split.length < 2) {
          reject(`"${stamp}" has a date but no time, or a time but no date.`);
          return;
        }
        const date = readDate(split[0]!, mapping.dateFormat, "timestamp");
        const time = readTime(split.slice(1).join(" "), "timestamp");

        scans.push({
          employeeId: employee.id,
          employeeName: employee.full_name,
          deviceUserId: deviceId || employee.device_user_id,
          date,
          time,
          direction: cell(raw, mapping.direction).toLowerCase() || null,
          rowNo,
          raw,
        });
      }
    } catch (error) {
      reject(error instanceof Error ? error.message : "This row could not be read.");
    }
  });

  // Group into employee-days. The earliest scan is the arrival and the latest the
  // departure; anything between is somebody going out for lunch, which is not a
  // second working day.
  const window = Math.min(Math.max(options.duplicateWindowMinutes ?? 2, 0), 120);
  const days = new Map<string, Scan[]>();
  for (const scan of scans) {
    const key = `${scan.employeeId}|${scan.date}`;
    const bucket = days.get(key);
    if (bucket) bucket.push(scan);
    else days.set(key, [scan]);
  }

  const rows: StagedRow[] = [];
  let duplicateCount = 0;

  for (const [, bucket] of days) {
    bucket.sort((left, right) => left.time.localeCompare(right.time));

    // Collapse scans within the duplicate window of each other: a finger read
    // twice is one event, and treating the second as a clock-out shows a
    // two-minute working day.
    const collapsed: Scan[] = [];
    for (const scan of bucket) {
      const previous = collapsed[collapsed.length - 1];
      if (previous && minutesBetween(previous.time, scan.time) <= window) {
        duplicateCount += 1;
        continue;
      }
      collapsed.push(scan);
    }

    const first = collapsed[0]!;
    const last = collapsed[collapsed.length - 1]!;
    const single = collapsed.length === 1;

    rows.push({
      rowNo: first.rowNo,
      raw: first.raw,
      deviceUserId: first.deviceUserId,
      employeeId: first.employeeId,
      employeeName: first.employeeName,
      workDate: first.date,
      clockIn: instantOf(first.date, first.time),
      // A single scan for a day is an arrival with no departure — a missing clock,
      // which is a real and common situation. Left as null and reported rather than
      // invented.
      clockOut: single ? null : instantOf(last.date, last.time),
      state: "ok",
      problem: null,
    });
  }

  // Employment-window and existing-record checks, per staged day.
  const byId = new Map((employees.rows ?? []).map((row) => [row.id, row]));
  for (const row of rows) {
    const employee = row.employeeId ? byId.get(row.employeeId) : undefined;
    if (!employee || !row.workDate) continue;

    const joinedOn = String(employee.joined_on).slice(0, 10);
    if (row.workDate < joinedOn) {
      row.state = "problem";
      row.problem = `${employee.full_name} joined on ${joinedOn}, so there is no attendance for ${row.workDate}.`;
      continue;
    }
    if (employee.last_day && row.workDate > String(employee.last_day).slice(0, 10)) {
      row.state = "problem";
      row.problem = `${employee.full_name} left on ${String(employee.last_day).slice(0, 10)}.`;
    }
  }

  const all = [...rows, ...problems].sort((left, right) => left.rowNo - right.rowNo);
  const dates = all
    .map((row) => row.workDate)
    .filter((date): date is string => date !== null)
    .sort();

  return {
    header: table.header,
    mapping,
    rows: all,
    earliest: dates[0] ?? null,
    latest: dates[dates.length - 1] ?? null,
    digest: createHash("sha256").update(text).digest("hex"),
    unmappedDeviceIds: [...unmapped].sort(),
    okCount: all.filter((row) => row.state === "ok").length,
    problemCount: all.filter((row) => row.state === "problem").length,
    duplicateCount,
  };
}

function minutesBetween(left: string, right: string): number {
  const toMinutes = (time: string) => {
    const [hours, minutes] = time.split(":");
    return Number(hours) * 60 + Number(minutes);
  };
  return Math.abs(toMinutes(right) - toMinutes(left));
}

// ---------------------------------------------------------------------------
// Staging and confirming
// ---------------------------------------------------------------------------

export interface StageResult {
  importId: string;
  okCount: number;
  problemCount: number;
  duplicateCount: number;
  unmappedDeviceIds: string[];
}

export async function stageAttendanceImport(
  db: Executor,
  principal: Principal,
  staged: StagedImport,
  input: {
    sourceFilename?: string | null;
    deviceLabel?: string | null;
    notes?: string | null;
    allowDuplicate?: boolean;
  } = {},
  context?: AuditContext,
): Promise<StageResult> {
  requireCapability(principal, "hr.attendance.import");

  if (staged.rows.length === 0) {
    throw new ValidationError("No rows could be read from that file.", "file");
  }

  if (!input.allowDuplicate) {
    const seen = await db.execute<{ id: string; created_at: string; status: string }>(sql`
      SELECT id, created_at, status FROM hr.attendance_import
       WHERE source_digest = ${staged.digest} AND status = 'confirmed' LIMIT 1
    `);
    if (seen.rows?.[0]) {
      throw new ConflictError(
        "This exact file has already been imported and confirmed. Importing it again would " +
          "duplicate every scan in it.",
      );
    }
  }

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO hr.attendance_import
      (source_filename, source_digest, device_label, column_mapping, period_from, period_to, notes, created_by)
    VALUES (${input.sourceFilename?.trim() || null}, ${staged.digest},
            ${input.deviceLabel?.trim() || null}, ${JSON.stringify(staged.mapping)}::jsonb,
            ${staged.earliest}, ${staged.latest}, ${input.notes?.trim() || null}, ${principal.userId})
    RETURNING id
  `);
  const importId = created.rows![0]!.id;

  for (const row of staged.rows) {
    await db.execute(sql`
      INSERT INTO hr.attendance_import_row
        (import_id, row_no, raw, device_user_id, employee_id, work_date, clock_in, clock_out, state, problem)
      VALUES (${importId}, ${row.rowNo}, ${JSON.stringify(row.raw)}::jsonb, ${row.deviceUserId},
              ${row.employeeId}, ${row.workDate}, ${row.clockIn}, ${row.clockOut},
              ${row.state}, ${row.problem})
    `);
  }

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.ATTENDANCE_IMPORT_STAGED,
    entityType: "attendance_import",
    entityId: importId,
    newValues: {
      filename: input.sourceFilename ?? null,
      device: input.deviceLabel ?? null,
      from: staged.earliest,
      to: staged.latest,
      ok: staged.okCount,
      problems: staged.problemCount,
      duplicatesCollapsed: staged.duplicateCount,
      unmappedDeviceIds: staged.unmappedDeviceIds.length,
    },
  });

  return {
    importId,
    okCount: staged.okCount,
    problemCount: staged.problemCount,
    duplicateCount: staged.duplicateCount,
    unmappedDeviceIds: staged.unmappedDeviceIds,
  };
}

export interface ConfirmResult {
  written: number;
  skipped: number;
  /** Days that already had a record, left alone rather than overwritten. */
  clashes: Array<{ employeeName: string; workDate: string }>;
}

/**
 * Writes the staged rows into attendance.
 *
 * Deliberately does **not** overwrite a day that already has a record. A day
 * already recorded may have been corrected by hand, and silently replacing a
 * correction with the raw device reading would undo somebody's work invisibly.
 * Clashes are reported so they can be dealt with one at a time.
 *
 * Only rows in state `ok` are written; problems stay staged with their reason, so
 * the file remains a complete account of what was read and what became of it.
 */
export async function confirmAttendanceImport(
  db: Executor,
  principal: Principal,
  importId: string,
  context?: AuditContext,
): Promise<ConfirmResult> {
  requireCapability(principal, "hr.attendance.import");

  const found = await db.execute<{ status: string; period_from: string; period_to: string }>(
    sql`SELECT status, period_from, period_to FROM hr.attendance_import WHERE id = ${importId} FOR UPDATE`,
  );
  const batch = found.rows?.[0];
  if (!batch) throw new NotFoundError("That import no longer exists.");
  if (batch.status === "confirmed") throw new ConflictError("That import has already been confirmed.");
  if (batch.status === "discarded") throw new ConflictError("That import was discarded.");

  const rows = await db.execute<{
    id: string;
    employee_id: string | null;
    work_date: string;
    clock_in: string | null;
    clock_out: string | null;
  }>(sql`
    SELECT id, employee_id, work_date, clock_in, clock_out
      FROM hr.attendance_import_row
     WHERE import_id = ${importId} AND state = 'ok' AND employee_id IS NOT NULL
     ORDER BY row_no
  `);

  let written = 0;
  let skipped = 0;
  const clashes: ConfirmResult["clashes"] = [];

  for (const row of rows.rows ?? []) {
    const existing = await db.execute<{ id: string; full_name: string }>(sql`
      SELECT a.id, e.full_name
        FROM hr.attendance a
        JOIN hr.employee e ON e.id = a.employee_id
       WHERE a.employee_id = ${row.employee_id} AND a.work_date = ${row.work_date}::date
    `);

    if (existing.rows?.[0]) {
      skipped += 1;
      clashes.push({
        employeeName: existing.rows[0]!.full_name,
        workDate: String(row.work_date).slice(0, 10),
      });
      continue;
    }

    await db.execute(sql`
      INSERT INTO hr.attendance
        (employee_id, work_date, clock_in, clock_out, source, import_id, created_by)
      VALUES (${row.employee_id}, ${row.work_date}, ${row.clock_in}, ${row.clock_out},
              'device', ${importId}, ${principal.userId})
    `);

    await db.execute(
      sql`UPDATE hr.attendance_import_row SET state = 'imported' WHERE id = ${row.id}`,
    );
    written += 1;
  }

  await db.execute(sql`
    UPDATE hr.attendance_import
       SET status = 'confirmed', confirmed_at = now(), confirmed_by = ${principal.userId}
     WHERE id = ${importId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.ATTENDANCE_IMPORT_CONFIRMED,
    entityType: "attendance_import",
    entityId: importId,
    newValues: { written, skipped, from: batch.period_from, to: batch.period_to },
  });

  return { written, skipped, clashes };
}

export async function discardAttendanceImport(
  db: Executor,
  principal: Principal,
  importId: string,
  reason: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "hr.attendance.import");

  if (!reason?.trim()) throw new ValidationError("Say why it is being discarded.", "reason");

  const found = await db.execute<{ status: string }>(
    sql`SELECT status FROM hr.attendance_import WHERE id = ${importId}`,
  );
  const batch = found.rows?.[0];
  if (!batch) throw new NotFoundError("That import no longer exists.");
  if (batch.status === "confirmed") {
    throw new ConflictError(
      "That import has been confirmed and its rows are in attendance. Correct the days " +
        "themselves rather than the import.",
    );
  }

  await db.execute(
    sql`UPDATE hr.attendance_import SET status = 'discarded' WHERE id = ${importId}`,
  );

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.ATTENDANCE_IMPORT_DISCARDED,
    entityType: "attendance_import",
    entityId: importId,
    reason: reason.trim(),
  });
}

/** Maps a device number to an employee, which is the fix for an unmapped row. */
export async function mapDeviceUser(
  db: Executor,
  principal: Principal,
  employeeId: string,
  deviceUserId: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "hr.employee.edit");

  const id = deviceUserId.trim();
  if (id === "") throw new ValidationError("Enter the device number.", "deviceUserId");

  const clash = await db.execute<{ full_name: string }>(
    sql`SELECT full_name FROM hr.employee WHERE device_user_id = ${id} AND id <> ${employeeId}`,
  );
  if (clash.rows?.[0]) {
    throw new ConflictError(
      `${clash.rows[0]!.full_name} is already mapped to device number ${id}. Two people sharing ` +
        "one number would put one person's attendance on the other's record.",
    );
  }

  await db.execute(
    sql`UPDATE hr.employee SET device_user_id = ${id}, updated_by = ${principal.userId} WHERE id = ${employeeId}`,
  );

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.EMPLOYEE_UPDATED,
    entityType: "employee",
    entityId: employeeId,
    newValues: { deviceUserId: id },
  });
}

// ---------------------------------------------------------------------------
// Reading and correcting attendance
// ---------------------------------------------------------------------------

export interface AttendanceRow {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNo: string;
  workDate: string;
  clockIn: Date | string | null;
  clockOut: Date | string | null;
  source: AttendanceSource;
  scheduledMinutes: number | null;
  workedMinutes: number | null;
  lateMinutes: number | null;
  earlyOutMinutes: number | null;
  extraMinutes: number | null;
  isAbsent: boolean;
  isHoliday: boolean;
  isRestDay: boolean;
  onLeaveType: string | null;
  status: "draft" | "final";
  remarks: string | null;
  correctedReason: string | null;
}

export async function listAttendance(
  db: Executor,
  filters: {
    employeeId?: string;
    from?: string;
    to?: string;
    status?: "draft" | "final";
    departmentId?: string;
    limit?: number;
  } = {},
): Promise<AttendanceRow[]> {
  const where = [sql`true`];
  if (filters.employeeId) where.push(sql`a.employee_id = ${filters.employeeId}`);
  if (filters.from) where.push(sql`a.work_date >= ${toIsoDate(parseIsoDate(filters.from, "from"))}::date`);
  if (filters.to) where.push(sql`a.work_date <= ${toIsoDate(parseIsoDate(filters.to, "to"))}::date`);
  if (filters.status) where.push(sql`a.status = ${filters.status}`);
  if (filters.departmentId) where.push(sql`e.department_id = ${filters.departmentId}`);

  const result = await db.execute<Record<string, never>>(sql`
    SELECT a.id, a.employee_id, e.full_name AS employee_name, e.employee_no, a.work_date,
           a.clock_in, a.clock_out, a.source, a.scheduled_minutes, a.worked_minutes,
           a.late_minutes, a.early_out_minutes, a.extra_minutes, a.is_absent, a.is_holiday,
           a.is_rest_day, a.on_leave_type, a.status, a.remarks, a.corrected_reason
      FROM hr.attendance a
      JOIN hr.employee e ON e.id = a.employee_id
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY a.work_date DESC, e.full_name
     LIMIT ${Math.min(Math.max(filters.limit ?? 500, 1), 5000)}
  `);

  return (result.rows ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      id: String(row.id),
      employeeId: String(row.employee_id),
      employeeName: String(row.employee_name),
      employeeNo: String(row.employee_no),
      workDate: String(row.work_date).slice(0, 10),
      clockIn: (row.clock_in as Date | string) ?? null,
      clockOut: (row.clock_out as Date | string) ?? null,
      source: row.source as AttendanceSource,
      scheduledMinutes: row.scheduled_minutes === null ? null : Number(row.scheduled_minutes),
      workedMinutes: row.worked_minutes === null ? null : Number(row.worked_minutes),
      lateMinutes: row.late_minutes === null ? null : Number(row.late_minutes),
      earlyOutMinutes: row.early_out_minutes === null ? null : Number(row.early_out_minutes),
      extraMinutes: row.extra_minutes === null ? null : Number(row.extra_minutes),
      isAbsent: Boolean(row.is_absent),
      isHoliday: Boolean(row.is_holiday),
      isRestDay: Boolean(row.is_rest_day),
      onLeaveType: (row.on_leave_type as string) ?? null,
      status: row.status as "draft" | "final",
      remarks: (row.remarks as string) ?? null,
      correctedReason: (row.corrected_reason as string) ?? null,
    };
  });
}

/**
 * Records or corrects a day by hand.
 *
 * A correction needs a reason and the record keeps it, because the difference
 * between the device's reading and a human's is the first thing queried when a
 * payslip is disputed. The source is set to say which it was.
 */
export async function recordAttendance(
  db: Executor,
  principal: Principal,
  input: {
    employeeId: string;
    workDate: string;
    clockIn?: string | null;
    clockOut?: string | null;
    isAbsent?: boolean;
    onLeaveType?: string | null;
    remarks?: string | null;
    reason?: string | null;
  },
  context?: AuditContext,
): Promise<{ id: string; created: boolean }> {
  requireCapability(principal, "hr.attendance.edit");

  const workDate = toIsoDate(parseIsoDate(input.workDate, "workDate"));

  const existing = await db.execute<{ id: string; status: string; source: string }>(sql`
    SELECT id, status, source FROM hr.attendance
     WHERE employee_id = ${input.employeeId} AND work_date = ${workDate}::date
     FOR UPDATE
  `);
  const current = existing.rows?.[0];

  if (current?.status === "final") {
    throw new ConflictError(
      `Attendance for ${workDate} is final. Reopen the period to change it.`,
    );
  }

  if (current && !input.reason?.trim()) {
    throw new ValidationError(
      "Changing a recorded day needs a reason. It is the first thing asked when a payslip is " +
        "queried.",
      "reason",
    );
  }

  const clockIn = input.clockIn?.trim() || null;
  const clockOut = input.clockOut?.trim() || null;
  if (clockIn && clockOut && clockOut <= clockIn) {
    throw new ValidationError("The clock-out is not after the clock-in.", "clockOut");
  }

  if (current) {
    await db.execute(sql`
      UPDATE hr.attendance
         SET clock_in = ${clockIn}, clock_out = ${clockOut},
             is_absent = ${input.isAbsent ?? false},
             on_leave_type = ${input.onLeaveType?.trim() || null},
             remarks = ${input.remarks?.trim() || null},
             corrected_reason = ${input.reason?.trim() ?? null},
             source = ${current.source === "device" ? "imported_corrected" : "manual"},
             -- The Phase 6 engine recomputes; stale figures would be worse than none.
             worked_minutes = NULL, late_minutes = NULL, early_out_minutes = NULL,
             extra_minutes = NULL, scheduled_minutes = NULL,
             updated_by = ${principal.userId}
       WHERE id = ${current.id}
    `);

    await writeAudit(db, {
      ...context,
      actorUserId: principal.userId,
      actorLabel: principal.email,
      action: AUDIT.ATTENDANCE_CORRECTED,
      entityType: "attendance",
      entityId: current.id,
      newValues: { workDate, clockIn, clockOut, isAbsent: input.isAbsent ?? false },
      reason: input.reason?.trim() ?? null,
    });

    return { id: current.id, created: false };
  }

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO hr.attendance
      (employee_id, work_date, clock_in, clock_out, is_absent, on_leave_type, remarks, source, created_by)
    VALUES (${input.employeeId}, ${workDate}, ${clockIn}, ${clockOut},
            ${input.isAbsent ?? false}, ${input.onLeaveType?.trim() || null},
            ${input.remarks?.trim() || null}, 'manual', ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.ATTENDANCE_CORRECTED,
    entityType: "attendance",
    entityId: id,
    newValues: { workDate, clockIn, clockOut, entered: "by hand" },
    reason: input.reason?.trim() ?? null,
  });

  return { id, created: true };
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

export interface AttendancePeriodView {
  id: string;
  periodFrom: string;
  periodTo: string;
  status: "open" | "finalised";
  notes: string | null;
  finalisedAt: Date | string | null;
  finalisedByName: string | null;
  reopenReason: string | null;
  recordCount: number;
  draftCount: number;
}

export async function openAttendancePeriod(
  db: Executor,
  principal: Principal,
  input: { periodFrom: string; periodTo: string; notes?: string | null },
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "hr.attendance.finalise");

  const from = toIsoDate(parseIsoDate(input.periodFrom, "periodFrom"));
  const to = toIsoDate(parseIsoDate(input.periodTo, "periodTo"));
  if (to < from) throw new ValidationError("The period ends before it begins.", "periodTo");

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO hr.attendance_period (period_from, period_to, notes, created_by)
    VALUES (${from}, ${to}, ${input.notes?.trim() || null}, ${principal.userId})
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.ATTENDANCE_PERIOD_OPENED,
    entityType: "attendance_period",
    entityId: id,
    newValues: { from, to },
  });

  return { id };
}

/**
 * Closes a period.
 *
 * Every draft row inside it becomes final in the same transaction, and nothing can
 * afterwards be inserted into or edited inside it — both enforced by trigger.
 * Payroll reads final rows only, so this is the act that says March is ready to be
 * paid.
 */
export async function finaliseAttendancePeriod(
  db: Executor,
  principal: Principal,
  periodId: string,
  context?: AuditContext,
): Promise<{ finalised: number }> {
  requireCapability(principal, "hr.attendance.finalise");

  const found = await db.execute<{ status: string; period_from: string; period_to: string }>(
    sql`SELECT status, period_from, period_to FROM hr.attendance_period WHERE id = ${periodId} FOR UPDATE`,
  );
  const period = found.rows?.[0];
  if (!period) throw new NotFoundError("That period no longer exists.");
  if (period.status === "finalised") throw new ConflictError("That period is already finalised.");

  const from = String(period.period_from).slice(0, 10);
  const to = String(period.period_to).slice(0, 10);

  // A day with no clock-out and no explanation is exactly what finalising must not
  // wave through: it becomes a payroll figure nobody can defend.
  const unresolved = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM hr.attendance
     WHERE work_date BETWEEN ${from}::date AND ${to}::date
       AND status = 'draft'
       AND clock_in IS NOT NULL AND clock_out IS NULL
       AND NOT is_absent AND on_leave_type IS NULL
       AND COALESCE(remarks, '') = ''
  `);
  const missing = unresolved.rows?.[0]?.count ?? 0;
  if (missing > 0) {
    throw new ConflictError(
      `${missing} day${missing === 1 ? "" : "s"} in this period have a clock-in and no clock-out, ` +
        "with nothing said about why. Correct them, or add a remark explaining each, before " +
        "finalising — payroll cannot defend a figure nobody has looked at.",
    );
  }

  const updated = await db.execute<{ count: number }>(sql`
    WITH done AS (
      UPDATE hr.attendance
         SET status = 'final', finalised_at = now(), finalised_by = ${principal.userId},
             updated_by = ${principal.userId}
       WHERE work_date BETWEEN ${from}::date AND ${to}::date AND status = 'draft'
      RETURNING 1
    )
    SELECT count(*)::int AS count FROM done
  `);

  await db.execute(sql`
    UPDATE hr.attendance_period
       SET status = 'finalised', finalised_at = now(), finalised_by = ${principal.userId}
     WHERE id = ${periodId}
  `);

  const finalised = updated.rows?.[0]?.count ?? 0;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.ATTENDANCE_FINALISED,
    entityType: "attendance_period",
    entityId: periodId,
    newValues: { from, to, finalised },
  });

  return { finalised };
}

export async function reopenAttendancePeriod(
  db: Executor,
  principal: Principal,
  periodId: string,
  reason: string,
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "hr.attendance.finalise");

  if (!reason?.trim()) {
    throw new ValidationError(
      "Reopening a closed period needs a reason on the record — payroll may already have been " +
        "run against it.",
      "reason",
    );
  }

  const found = await db.execute<{ status: string; period_from: string; period_to: string }>(
    sql`SELECT status, period_from, period_to FROM hr.attendance_period WHERE id = ${periodId} FOR UPDATE`,
  );
  const period = found.rows?.[0];
  if (!period) throw new NotFoundError("That period no longer exists.");
  if (period.status !== "finalised") throw new ConflictError("That period is already open.");

  await db.execute(sql`
    UPDATE hr.attendance_period
       SET status = 'open', reopened_at = now(), reopened_by = ${principal.userId},
           reopen_reason = ${reason.trim()}, finalised_at = NULL, finalised_by = NULL
     WHERE id = ${periodId}
  `);

  // The rows go back to draft too, or the period would be open while everything in
  // it stayed frozen.
  await db.execute(sql`
    UPDATE hr.attendance
       SET status = 'draft', finalised_at = NULL, finalised_by = NULL, updated_by = ${principal.userId}
     WHERE work_date BETWEEN ${String(period.period_from).slice(0, 10)}::date
                         AND ${String(period.period_to).slice(0, 10)}::date
       AND status = 'final'
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.ATTENDANCE_REOPENED,
    entityType: "attendance_period",
    entityId: periodId,
    oldValues: {
      from: String(period.period_from).slice(0, 10),
      to: String(period.period_to).slice(0, 10),
    },
    reason: reason.trim(),
  });
}

export async function listAttendancePeriods(db: Executor): Promise<AttendancePeriodView[]> {
  const result = await db.execute<{
    id: string;
    period_from: string;
    period_to: string;
    status: "open" | "finalised";
    notes: string | null;
    finalised_at: Date | string | null;
    finalised_by_name: string | null;
    reopen_reason: string | null;
    record_count: number;
    draft_count: number;
  }>(sql`
    SELECT p.id, p.period_from, p.period_to, p.status, p.notes, p.finalised_at,
           u.full_name AS finalised_by_name, p.reopen_reason,
           COALESCE(c.total, 0)::int AS record_count,
           COALESCE(c.drafts, 0)::int AS draft_count
      FROM hr.attendance_period p
      LEFT JOIN auth."user" u ON u.id = p.finalised_by
      LEFT JOIN LATERAL (
        SELECT count(*) AS total, count(*) FILTER (WHERE status = 'draft') AS drafts
          FROM hr.attendance
         WHERE work_date BETWEEN p.period_from AND p.period_to
      ) c ON true
     ORDER BY p.period_from DESC
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    periodFrom: String(row.period_from).slice(0, 10),
    periodTo: String(row.period_to).slice(0, 10),
    status: row.status,
    notes: row.notes,
    finalisedAt: row.finalised_at,
    finalisedByName: row.finalised_by_name,
    reopenReason: row.reopen_reason,
    recordCount: row.record_count,
    draftCount: row.draft_count,
  }));
}

export interface ImportSummary {
  id: string;
  sourceFilename: string | null;
  deviceLabel: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  status: "staged" | "confirmed" | "discarded";
  rowCount: number;
  acceptedCount: number;
  rejectedCount: number;
  createdAt: Date | string;
  createdByName: string | null;
  confirmedByName: string | null;
}

export async function listAttendanceImports(
  db: Executor,
  limit = 50,
): Promise<ImportSummary[]> {
  const result = await db.execute<{
    id: string;
    source_filename: string | null;
    device_label: string | null;
    period_from: string | null;
    period_to: string | null;
    status: "staged" | "confirmed" | "discarded";
    row_count: number;
    accepted_count: number;
    rejected_count: number;
    created_at: Date | string;
    created_by_name: string | null;
    confirmed_by_name: string | null;
  }>(sql`
    SELECT i.id, i.source_filename, i.device_label, i.period_from, i.period_to, i.status,
           i.row_count, i.accepted_count, i.rejected_count, i.created_at,
           c.full_name AS created_by_name, f.full_name AS confirmed_by_name
      FROM hr.attendance_import i
      LEFT JOIN auth."user" c ON c.id = i.created_by
      LEFT JOIN auth."user" f ON f.id = i.confirmed_by
     ORDER BY i.created_at DESC
     LIMIT ${Math.min(Math.max(limit, 1), 200)}
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    sourceFilename: row.source_filename,
    deviceLabel: row.device_label,
    periodFrom: row.period_from ? String(row.period_from).slice(0, 10) : null,
    periodTo: row.period_to ? String(row.period_to).slice(0, 10) : null,
    status: row.status,
    rowCount: row.row_count,
    acceptedCount: row.accepted_count,
    rejectedCount: row.rejected_count,
    createdAt: row.created_at,
    createdByName: row.created_by_name,
    confirmedByName: row.confirmed_by_name,
  }));
}

export interface ImportRowView {
  id: string;
  rowNo: number;
  raw: string[];
  deviceUserId: string | null;
  employeeId: string | null;
  employeeName: string | null;
  workDate: string | null;
  clockIn: Date | string | null;
  clockOut: Date | string | null;
  state: ImportRowState;
  problem: string | null;
}

export async function getAttendanceImport(
  db: Executor,
  importId: string,
): Promise<{ summary: ImportSummary; rows: ImportRowView[] } | null> {
  const summaries = await listAttendanceImports(db, 200);
  const summary = summaries.find((row) => row.id === importId);
  if (!summary) return null;

  const rows = await db.execute<{
    id: string;
    row_no: number;
    raw: unknown;
    device_user_id: string | null;
    employee_id: string | null;
    employee_name: string | null;
    work_date: string | null;
    clock_in: Date | string | null;
    clock_out: Date | string | null;
    state: ImportRowState;
    problem: string | null;
  }>(sql`
    SELECT r.id, r.row_no, r.raw, r.device_user_id, r.employee_id, e.full_name AS employee_name,
           r.work_date, r.clock_in, r.clock_out, r.state, r.problem
      FROM hr.attendance_import_row r
      LEFT JOIN hr.employee e ON e.id = r.employee_id
     WHERE r.import_id = ${importId}
     ORDER BY r.row_no
  `);

  return {
    summary,
    rows: (rows.rows ?? []).map((row) => ({
      id: row.id,
      rowNo: row.row_no,
      raw: Array.isArray(row.raw) ? (row.raw as string[]) : [],
      deviceUserId: row.device_user_id,
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      workDate: row.work_date ? String(row.work_date).slice(0, 10) : null,
      clockIn: row.clock_in,
      clockOut: row.clock_out,
      state: row.state,
      problem: row.problem,
    })),
  };
}

/** Employees the device knows nothing about yet — the setup gap, listed. */
export async function listUnmappedEmployees(
  db: Executor,
): Promise<Array<{ id: string; employeeNo: string; fullName: string }>> {
  const result = await db.execute<{ id: string; employee_no: string; full_name: string }>(sql`
    SELECT id, employee_no, full_name FROM hr.employee
     WHERE device_user_id IS NULL AND status IN ('active', 'on_leave', 'suspended')
     ORDER BY full_name
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    employeeNo: row.employee_no,
    fullName: row.full_name,
  }));
}

/** Today's date, so a screen and the server agree about "today" in Malaysia. */
export function attendanceToday(): string {
  return toIsoDate(today());
}
