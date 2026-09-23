import {
  boolean,
  index,
  inet,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const authSchema = pgSchema("auth");

/**
 * A person who can sign in. `employeeId` is nullable on purpose — not every
 * account is a member of staff (an auditor or an external reviewer may hold a
 * login without an employment record), and HR data must not be a precondition
 * for authentication.
 */
export const user = authSchema.table(
  "user",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    fullName: text("full_name").notNull(),
    /** active | suspended | locked */
    status: text("status").notNull().default("active"),
    mfaEnforced: boolean("mfa_enforced").notNull().default(true),
    employeeId: uuid("employee_id"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    /** Consecutive failures. Reset to 0 on any success. */
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Emails are normalised to lower case at the application boundary, so a
    // plain unique index gives case-insensitive uniqueness without citext.
    emailUnique: uniqueIndex("user_email_unique").on(t.email),
  }),
);

/**
 * Server-side sessions. We store only a hash of the token: a database leak
 * must not hand an attacker usable sessions. Revocation is a column rather
 * than a delete so "log out everywhere" is auditable.
 */
export const session = authSchema.table(
  "session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    deviceLabel: text("device_label"),
    /** Set once TOTP has been satisfied. Until then the session may only reach /login/mfa. */
    mfaSatisfiedAt: timestamp("mfa_satisfied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    tokenUnique: uniqueIndex("session_token_hash_unique").on(t.tokenHash),
    byUser: index("session_user_idx").on(t.userId),
  }),
);

export const mfaDevice = authSchema.table("mfa_device", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  type: text("type").notNull().default("totp"),
  label: text("label").notNull().default("Authenticator app"),
  /** Encrypted with the app key, never the raw secret. */
  secretEnc: text("secret_enc").notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const recoveryCode = authSchema.table("recovery_code", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const role = authSchema.table("role", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  /** System roles cannot be deleted or renamed through the admin UI. */
  isSystem: boolean("is_system").notNull().default(true),
});

export const permission = authSchema.table("permission", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  domain: text("domain").notNull(),
  description: text("description"),
});

export const rolePermission = authSchema.table(
  "role_permission",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => role.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permission.id, { onDelete: "cascade" }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.roleId, t.permissionId] }) }),
);

export const userRole = authSchema.table(
  "user_role",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => role.id, { onDelete: "cascade" }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.roleId] }) }),
);

/**
 * Per-user overrides layered on top of roles. `deny` always wins, so a single
 * row can remove a capability from someone without unpicking their roles.
 */
export const userPermission = authSchema.table(
  "user_permission",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permission.id, { onDelete: "cascade" }),
    /** allow | deny */
    effect: text("effect").notNull(),
    reason: text("reason"),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.permissionId] }) }),
);

/**
 * Every attempt, successful or not. Drives throttling and answers "who tried
 * to get in" during an incident. Never stores the submitted password.
 */
export const loginAttempt = authSchema.table(
  "login_attempt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email"),
    ip: inet("ip"),
    success: boolean("success").notNull(),
    /** bad_credentials | locked | mfa_failed | ok | unknown_user */
    reason: text("reason"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byEmail: index("login_attempt_email_idx").on(t.email, t.createdAt),
    byIp: index("login_attempt_ip_idx").on(t.ip, t.createdAt),
  }),
);

export const passwordReset = authSchema.table("password_reset", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
