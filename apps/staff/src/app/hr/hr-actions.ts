"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@cac/db";
import {
  addPublicHoliday,
  confirmAttendanceImport,
  createDepartment,
  createEmployee,
  createPosition,
  createWorkSchedule,
  discardAttendanceImport,
  finaliseAttendancePeriod,
  formatAmount,
  getEmployee,
  getEmployeeSensitive,
  mapDeviceUser,
  openAttendancePeriod,
  parseAttendanceFile,
  recordAttendance,
  recordEmploymentEvent,
  removePublicHoliday,
  reopenAttendancePeriod,
  stageAttendanceImport,
  updateDepartment,
  updateEmployee,
  updatePosition,
  updateWorkSchedule,
  type AttendanceColumnMapping,
  type EmployeeInput,
  type EmploymentEventKind,
  type EmploymentType,
} from "@cac/core";
import { getRequestContext, requireCapability } from "@/lib/auth";
import { toFormState, type FormState } from "../accounting/action-errors";

export type { FormState };

/**
 * Server actions for HR.
 *
 * Two things here differ from the accounting actions and are worth knowing.
 *
 * The employee form deliberately sends **every** field, including ones it did not
 * change, because `updateEmployee` treats an absent field as "leave alone" and a
 * present empty one as "clear". Half-sending a form would silently clear whatever
 * was left out — which is how the device number linking somebody to their
 * attendance disappears without a trace.
 *
 * The attendance import is parse-then-confirm, like the bank one, and the file
 * travels in a hidden field between the two steps rather than living on the server
 * in between.
 */

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const optional = (form: FormData, key: string) => text(form, key) || null;
const checkbox = (form: FormData, key: string) => form.get(key) !== null;
const number = (form: FormData, key: string, fallback: number) => {
  const value = text(form, key);
  if (value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

async function begin(capability: string) {
  const principal = await requireCapability(capability);
  const db = await getDb();
  const context = await getRequestContext();
  return { principal, db, context };
}

// ---------------------------------------------------------------------------
// Organisation
// ---------------------------------------------------------------------------

export async function saveDepartment(_prev: FormState, form: FormData): Promise<FormState> {
  const departmentId = optional(form, "departmentId");

  const input = {
    code: text(form, "code"),
    name: text(form, "name"),
    parentId: optional(form, "parentId"),
    costCentreId: optional(form, "costCentreId"),
    headEmployeeId: optional(form, "headEmployeeId"),
    notes: optional(form, "notes"),
    isActive: form.has("isActive") ? checkbox(form, "isActive") : true,
  };

  try {
    const { principal, db, context } = await begin("hr.org.manage");
    await db.transaction(async (tx) => {
      if (departmentId) await updateDepartment(tx, principal, departmentId, input, context);
      else await createDepartment(tx, principal, input, context);
    });
  } catch (error) {
    return toFormState(error, "The department could not be saved.");
  }

  revalidatePath("/hr/organisation");
  return { notice: departmentId ? "Department updated." : "Department added." };
}

export async function savePosition(_prev: FormState, form: FormData): Promise<FormState> {
  const positionId = optional(form, "positionId");

  const input = {
    code: text(form, "code"),
    title: text(form, "title"),
    departmentId: optional(form, "departmentId"),
    grade: optional(form, "grade"),
    description: optional(form, "description"),
    isActive: form.has("isActive") ? checkbox(form, "isActive") : true,
  };

  try {
    const { principal, db, context } = await begin("hr.org.manage");
    await db.transaction(async (tx) => {
      if (positionId) await updatePosition(tx, principal, positionId, input, context);
      else await createPosition(tx, principal, input, context);
    });
  } catch (error) {
    return toFormState(error, "The position could not be saved.");
  }

  revalidatePath("/hr/organisation");
  return { notice: positionId ? "Position updated." : "Position added." };
}

export async function saveSchedule(_prev: FormState, form: FormData): Promise<FormState> {
  const scheduleId = optional(form, "scheduleId");

  // Working days arrive as repeated checkboxes, so a four-day week is expressible
  // without a column per day.
  const workDays = form
    .getAll("workDays")
    .map((value) => Number(String(value)))
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7);

  const input = {
    code: text(form, "code"),
    name: text(form, "name"),
    workDays,
    startsAt: text(form, "startsAt"),
    endsAt: text(form, "endsAt"),
    breakMinutes: number(form, "breakMinutes", 60),
    graceMinutes: number(form, "graceMinutes", 10),
    crossesMidnight: checkbox(form, "crossesMidnight"),
    isDefault: checkbox(form, "isDefault"),
    isActive: form.has("isActive") ? checkbox(form, "isActive") : true,
    notes: optional(form, "notes"),
  };

  try {
    const { principal, db, context } = await begin("hr.schedule.manage");
    await db.transaction(async (tx) => {
      if (scheduleId) await updateWorkSchedule(tx, principal, scheduleId, input, context);
      else await createWorkSchedule(tx, principal, input, context);
    });
  } catch (error) {
    return toFormState(error, "The schedule could not be saved.");
  }

  revalidatePath("/hr/organisation");
  return { notice: scheduleId ? "Schedule updated." : "Schedule added." };
}

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

export async function saveHoliday(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("hr.holiday.manage");
    await db.transaction(async (tx) => {
      await addPublicHoliday(
        tx,
        principal,
        {
          holidayOn: text(form, "holidayOn"),
          name: text(form, "name"),
          appliesTo: text(form, "appliesTo")
            .split(",")
            .map((state) => state.trim())
            .filter((state) => state !== ""),
          isHalfDay: checkbox(form, "isHalfDay"),
          sourceRef: optional(form, "sourceRef"),
          notes: optional(form, "notes"),
        },
        context,
      );
    });
  } catch (error) {
    return toFormState(error, "The holiday could not be added.");
  }

  revalidatePath("/hr/holidays");
  return { notice: "Holiday added." };
}

export async function deleteHoliday(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { principal, db, context } = await begin("hr.holiday.manage");
    await db.transaction(async (tx) => {
      await removePublicHoliday(tx, principal, text(form, "holidayId"), text(form, "reason"), context);
    });
  } catch (error) {
    return toFormState(error, "The holiday could not be removed.");
  }

  revalidatePath("/hr/holidays");
  return { notice: "Holiday removed." };
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

/**
 * Reads the employee form.
 *
 * Every optional field is read as a string rather than left undefined, because the
 * form always posts all of them — `updateEmployee` would otherwise read an absent
 * field as "leave alone" and a cleared one would never actually clear.
 */
function readEmployee(form: FormData): EmployeeInput {
  return {
    fullName: text(form, "fullName"),
    preferredName: optional(form, "preferredName"),
    employeeNo: optional(form, "employeeNo") ?? undefined,
    nric: optional(form, "nric"),
    passportNo: optional(form, "passportNo"),
    nationality: text(form, "nationality") || "Malaysian",
    dateOfBirth: optional(form, "dateOfBirth"),
    gender: optional(form, "gender"),
    maritalStatus: optional(form, "maritalStatus"),
    email: optional(form, "email"),
    personalEmail: optional(form, "personalEmail"),
    phone: optional(form, "phone"),
    address: optional(form, "address"),
    emergencyContact: optional(form, "emergencyContact"),
    emergencyPhone: optional(form, "emergencyPhone"),
    positionId: optional(form, "positionId"),
    departmentId: optional(form, "departmentId"),
    reportsToId: optional(form, "reportsToId"),
    costCentreId: optional(form, "costCentreId"),
    workScheduleId: optional(form, "workScheduleId"),
    employmentType: (optional(form, "employmentType") ?? "permanent") as EmploymentType,
    joinedOn: text(form, "joinedOn"),
    probationMonths: number(form, "probationMonths", 3),
    epfNo: optional(form, "epfNo"),
    socsoNo: optional(form, "socsoNo"),
    incomeTaxNo: optional(form, "incomeTaxNo"),
    epfApplicable: checkbox(form, "epfApplicable"),
    socsoApplicable: checkbox(form, "socsoApplicable"),
    eisApplicable: checkbox(form, "eisApplicable"),
    pcbApplicable: checkbox(form, "pcbApplicable"),
    taxDependants: number(form, "taxDependants", 0),
    bankName: optional(form, "bankName"),
    bankAccountNo: optional(form, "bankAccountNo"),
    basicSalary: text(form, "basicSalary") || "0",
    payFrequency: (optional(form, "payFrequency") ?? "monthly") as "monthly",
    deviceUserId: optional(form, "deviceUserId"),
    notes: optional(form, "notes"),
  };
}

export async function saveEmployee(_prev: FormState, form: FormData): Promise<FormState> {
  const employeeId = optional(form, "employeeId");
  let id = employeeId;

  try {
    const { principal, db, context } = await begin(
      employeeId ? "hr.employee.edit" : "hr.employee.create",
    );
    const input = readEmployee(form);

    await db.transaction(async (tx) => {
      if (employeeId) await updateEmployee(tx, principal, employeeId, input, context);
      else id = (await createEmployee(tx, principal, input, context)).id;
    });
  } catch (error) {
    return toFormState(error, "The employee record could not be saved.");
  }

  revalidatePath("/hr/employees");
  redirect(`/hr/employees/${id}`);
}

export async function saveEmploymentEvent(_prev: FormState, form: FormData): Promise<FormState> {
  const employeeId = text(form, "employeeId");
  const kind = text(form, "kind") as EmploymentEventKind;

  try {
    const { principal, db, context } = await begin(
      kind === "resigned" || kind === "terminated" ? "hr.employee.terminate" : "hr.employee.edit",
    );
    await db.transaction(async (tx) => {
      await recordEmploymentEvent(
        tx,
        principal,
        employeeId,
        {
          kind,
          effectiveFrom: text(form, "effectiveFrom"),
          basicSalary: optional(form, "basicSalary"),
          positionId: optional(form, "positionId"),
          departmentId: optional(form, "departmentId"),
          employmentType: (optional(form, "employmentType") as EmploymentType) ?? null,
          reason: optional(form, "reason"),
          notes: optional(form, "notes"),
        },
        context,
      );
    });
  } catch (error) {
    return toFormState(error, "That could not be recorded.");
  }

  revalidatePath(`/hr/employees/${employeeId}`);
  return { notice: "Recorded, and the history now shows it." };
}

export async function saveDeviceMapping(_prev: FormState, form: FormData): Promise<FormState> {
  const employeeId = text(form, "employeeId");

  try {
    const { principal, db, context } = await begin("hr.employee.edit");
    await db.transaction(async (tx) => {
      await mapDeviceUser(tx, principal, employeeId, text(form, "deviceUserId"), context);
    });
  } catch (error) {
    return toFormState(error, "The device number could not be mapped.");
  }

  revalidatePath(`/hr/employees/${employeeId}`);
  revalidatePath("/hr/attendance");
  return { notice: "Mapped. Their scans will be recognised from the next import." };
}

// ---------------------------------------------------------------------------
// Attendance import
// ---------------------------------------------------------------------------

export interface AttendancePreviewState extends FormState {
  preview?: {
    fileText: string;
    filename: string | null;
    header: string[];
    mapping: AttendanceColumnMapping;
    skipRows: number;
    rows: Array<{
      rowNo: number;
      employeeName: string | null;
      deviceUserId: string | null;
      workDate: string | null;
      clockIn: string | null;
      clockOut: string | null;
      state: string;
      problem: string | null;
      raw: string[];
    }>;
    earliest: string | null;
    latest: string | null;
    okCount: number;
    problemCount: number;
    duplicateCount: number;
    unmappedDeviceIds: string[];
  };
}

function readMapping(form: FormData): Partial<AttendanceColumnMapping> {
  const mapping: Partial<AttendanceColumnMapping> = {};
  const at = (key: string) => {
    const value = text(form, `mapping.${key}`);
    if (value === "") return undefined;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
  };

  const fields = [
    "deviceUserId",
    "employeeName",
    "employeeNo",
    "date",
    "clockIn",
    "clockOut",
    "timestamp",
    "direction",
  ] as const;

  for (const field of fields) {
    const index = at(field);
    if (index !== undefined) mapping[field] = index;
  }

  const format = text(form, "mapping.dateFormat");
  if (format === "dmy" || format === "mdy" || format === "ymd" || format === "auto") {
    mapping.dateFormat = format;
  }

  return mapping;
}

export async function previewAttendance(
  _prev: AttendancePreviewState,
  form: FormData,
): Promise<AttendancePreviewState> {
  await requireCapability("hr.attendance.import");
  const db = await getDb();

  const upload = form.get("file");
  const pasted = text(form, "pasted");
  const carried = String(form.get("fileText") ?? "");

  let fileText = carried;
  let filename = optional(form, "filename");

  if (upload instanceof File && upload.size > 0) {
    if (upload.size > 10_000_000) {
      return { error: "That file is larger than 10 MB. Import one month at a time." };
    }
    fileText = await upload.text();
    filename = upload.name;
  } else if (pasted !== "") {
    fileText = pasted;
    filename = filename ?? "pasted";
  }

  if (fileText.trim() === "") {
    return { error: "Choose the device export, or paste the rows." };
  }

  const skipRows = number(form, "skipRows", 0);

  try {
    const staged = await parseAttendanceFile(db, fileText, {
      mapping: readMapping(form),
      skipRows,
    });

    return {
      preview: {
        fileText,
        filename,
        header: staged.header,
        mapping: staged.mapping,
        skipRows,
        rows: staged.rows.slice(0, 300).map((row) => ({
          rowNo: row.rowNo,
          employeeName: row.employeeName,
          deviceUserId: row.deviceUserId,
          workDate: row.workDate,
          clockIn: row.clockIn,
          clockOut: row.clockOut,
          state: row.state,
          problem: row.problem,
          raw: row.raw,
        })),
        earliest: staged.earliest,
        latest: staged.latest,
        okCount: staged.okCount,
        problemCount: staged.problemCount,
        duplicateCount: staged.duplicateCount,
        unmappedDeviceIds: staged.unmappedDeviceIds,
      },
    };
  } catch (error) {
    return toFormState(error, "That file could not be read.");
  }
}

export async function stageAttendance(_prev: FormState, form: FormData): Promise<FormState> {
  let importId: string | null = null;

  try {
    const { principal, db, context } = await begin("hr.attendance.import");
    const staged = await parseAttendanceFile(db, String(form.get("fileText") ?? ""), {
      mapping: readMapping(form),
      skipRows: number(form, "skipRows", 0),
    });

    await db.transaction(async (tx) => {
      const result = await stageAttendanceImport(
        tx,
        principal,
        staged,
        {
          sourceFilename: optional(form, "filename"),
          deviceLabel: optional(form, "deviceLabel"),
          notes: optional(form, "notes"),
          allowDuplicate: checkbox(form, "allowDuplicate"),
        },
        context,
      );
      importId = result.importId;
    });
  } catch (error) {
    return toFormState(error, "The import could not be staged.");
  }

  revalidatePath("/hr/attendance");
  redirect(`/hr/attendance/imports/${importId}`);
}

export async function importAction(_prev: FormState, form: FormData): Promise<FormState> {
  const importId = text(form, "importId");
  const action = text(form, "action");
  let notice = "Done.";

  try {
    const { principal, db, context } = await begin("hr.attendance.import");
    await db.transaction(async (tx) => {
      if (action === "confirm") {
        const result = await confirmAttendanceImport(tx, principal, importId, context);
        notice =
          result.skipped === 0
            ? `${result.written} day${result.written === 1 ? "" : "s"} written into attendance.`
            : `${result.written} written. ${result.skipped} left alone because those days were ` +
              "already recorded — a day corrected by hand is not overwritten.";
      } else if (action === "discard") {
        await discardAttendanceImport(tx, principal, importId, text(form, "reason"), context);
        notice = "Discarded. Nothing reached attendance.";
      } else {
        throw new Error(`Unknown import action: ${action}`);
      }
    });
  } catch (error) {
    return toFormState(error, "That could not be done.");
  }

  revalidatePath(`/hr/attendance/imports/${importId}`);
  revalidatePath("/hr/attendance");
  return { notice };
}

// ---------------------------------------------------------------------------
// Attendance days and periods
// ---------------------------------------------------------------------------

export async function saveAttendance(_prev: FormState, form: FormData): Promise<FormState> {
  const employeeId = text(form, "employeeId");
  const workDate = text(form, "workDate");

  // A time on its own is meaningless: the date decides which day it belongs to, and
  // the offset is fixed because Malaysia has no daylight saving.
  const instant = (time: string) => (time === "" ? null : `${workDate}T${time}:00+08:00`);

  try {
    const { principal, db, context } = await begin("hr.attendance.edit");
    await db.transaction(async (tx) => {
      await recordAttendance(
        tx,
        principal,
        {
          employeeId,
          workDate,
          clockIn: instant(text(form, "clockIn")),
          clockOut: instant(text(form, "clockOut")),
          isAbsent: checkbox(form, "isAbsent"),
          onLeaveType: optional(form, "onLeaveType"),
          remarks: optional(form, "remarks"),
          reason: optional(form, "reason"),
        },
        context,
      );
    });
  } catch (error) {
    return toFormState(error, "The day could not be saved.");
  }

  revalidatePath("/hr/attendance");
  return { notice: "Saved." };
}

export async function periodAction(_prev: FormState, form: FormData): Promise<FormState> {
  const action = text(form, "action");
  let notice = "Done.";

  try {
    const { principal, db, context } = await begin("hr.attendance.finalise");
    await db.transaction(async (tx) => {
      switch (action) {
        case "open":
          await openAttendancePeriod(
            tx,
            principal,
            {
              periodFrom: text(form, "periodFrom"),
              periodTo: text(form, "periodTo"),
              notes: optional(form, "notes"),
            },
            context,
          );
          notice = "Period opened.";
          break;
        case "finalise": {
          const result = await finaliseAttendancePeriod(tx, principal, text(form, "periodId"), context);
          notice = `Finalised. ${result.finalised} day${result.finalised === 1 ? "" : "s"} are now evidence and cannot be edited.`;
          break;
        }
        case "reopen":
          await reopenAttendancePeriod(
            tx,
            principal,
            text(form, "periodId"),
            text(form, "reason"),
            context,
          );
          notice = "Reopened. The days in it are editable again.";
          break;
        default:
          throw new Error(`Unknown period action: ${action}`);
      }
    });
  } catch (error) {
    return toFormState(error, "That could not be done.");
  }

  revalidatePath("/hr/attendance");
  return { notice };
}

// ---------------------------------------------------------------------------
// Looking at somebody's identity details
// ---------------------------------------------------------------------------

export interface SensitiveState extends FormState {
  revealed?: {
    fullName: string;
    nric: string | null;
    passportNo: string | null;
    dateOfBirth: string | null;
    address: string | null;
    personalEmail: string | null;
    emergencyContact: string | null;
    emergencyPhone: string | null;
    epfNo: string | null;
    socsoNo: string | null;
    incomeTaxNo: string | null;
    bankName: string | null;
    bankAccountNo: string | null;
    basicSalary: string;
  };
}

/**
 * Reveals the identity and pay details, on the record.
 *
 * A reason is required. The capability alone would be enough to satisfy the code,
 * but PDPA makes "why did you look at this person's identity card number" a real
 * question, and a lookup with a stated purpose is worth far more six months later
 * than one without. `getEmployeeSensitive` writes the audit row.
 */
export async function revealSensitive(
  _prev: SensitiveState,
  form: FormData,
): Promise<SensitiveState> {
  const employeeId = text(form, "employeeId");
  const reason = text(form, "reason");

  if (reason.length < 8) {
    return {
      error:
        "Say why these details are needed — preparing a statutory submission, a bank instruction, " +
        "an audit request. It is recorded against your name.",
      field: "reason",
    };
  }

  try {
    const { principal, db, context } = await begin("hr.employee.view_sensitive");
    const employee = await getEmployee(db, employeeId);
    if (!employee) return { error: "That employee no longer exists." };

    const sensitive = await getEmployeeSensitive(db, principal, employeeId, { reason, context });
    if (!sensitive) return { error: "That employee no longer exists." };

    return {
      revealed: {
        fullName: employee.fullName,
        nric: sensitive.nric,
        passportNo: sensitive.passportNo,
        dateOfBirth: sensitive.dateOfBirth,
        address: sensitive.address,
        personalEmail: sensitive.personalEmail,
        emergencyContact: sensitive.emergencyContact,
        emergencyPhone: sensitive.emergencyPhone,
        epfNo: sensitive.epfNo,
        socsoNo: sensitive.socsoNo,
        incomeTaxNo: sensitive.incomeTaxNo,
        bankName: sensitive.bankName,
        bankAccountNo: sensitive.bankAccountNo,
        basicSalary: formatAmount(sensitive.basicSalary),
      },
    };
  } catch (error) {
    return toFormState(error, "Those details could not be shown.");
  }
}
