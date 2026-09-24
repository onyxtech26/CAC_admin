import type { ReactNode } from "react";

/**
 * Enterprise primitives.
 *
 * Small, plain and dense on purpose. Data tables, status badges and stat
 * tiles are the vocabulary of accounting and HR software; cards that float
 * and glow are not.
 */

type Tone = "neutral" | "ok" | "warn" | "danger" | "info";

const TONE: Record<Tone, string> = {
  neutral: "bg-[var(--color-canvas)] text-[var(--color-muted)] border-[var(--color-line-strong)]",
  ok: "bg-[var(--color-ok-bg)] text-[var(--color-ok)] border-[color-mix(in_srgb,var(--color-ok)_25%,transparent)]",
  warn: "bg-[var(--color-warn-bg)] text-[var(--color-warn)] border-[color-mix(in_srgb,var(--color-warn)_25%,transparent)]",
  danger:
    "bg-[var(--color-danger-bg)] text-[var(--color-danger)] border-[color-mix(in_srgb,var(--color-danger)_25%,transparent)]",
  info: "bg-[var(--color-info-bg)] text-[var(--color-info)] border-[color-mix(in_srgb,var(--color-info)_25%,transparent)]",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}

export function Panel({
  title,
  description,
  action,
  children,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]">
      {(title || action) && (
        <header className="flex items-start justify-between gap-4 border-b border-[var(--color-line)] px-4 py-3">
          <div>
            {title && <h2 className="text-[13px] font-semibold text-[var(--color-body)]">{title}</h2>}
            {description && (
              <p className="mt-0.5 text-[12px] text-[var(--color-muted)]">{description}</p>
            )}
          </div>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
}) {
  return (
    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-faint)]">
        {label}
      </p>
      <p className="numeric mt-1 text-2xl font-semibold text-[var(--color-body)]">{value}</p>
      {hint && (
        <p className="mt-1 text-[12px]">
          <span
            className={
              tone === "warn"
                ? "text-[var(--color-warn)]"
                : tone === "danger"
                  ? "text-[var(--color-danger)]"
                  : "text-[var(--color-muted)]"
            }
          >
            {hint}
          </span>
        </p>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-line-strong)] px-6 py-12 text-center">
      <p className="text-[13px] font-medium text-[var(--color-body)]">{title}</p>
      {body && <p className="mt-1 max-w-md text-[12px] text-[var(--color-muted)]">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function DataTable({
  columns,
  children,
  caption,
}: {
  columns: string[];
  children: ReactNode;
  caption?: string;
}) {
  return (
    // Wide tables scroll inside their own container; the page body never
    // scrolls sideways.
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-[var(--color-line)]">
            {/* Keyed by position as well as label: a table may legitimately have
                two blank column headings, and React needs the keys to differ. */}
            {columns.map((c, index) => (
              <th
                key={`${c}-${index}`}
                scope="col"
                className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--color-faint)]"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, numeric }: { children: ReactNode; numeric?: boolean }) {
  return (
    <td
      className={`border-b border-[var(--color-line)] px-3 py-2 ${numeric ? "numeric text-right" : ""}`}
    >
      {children}
    </td>
  );
}

export function Button({
  children,
  variant = "primary",
  type = "button",
  disabled,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger";
  type?: "button" | "submit";
  disabled?: boolean;
}) {
  const styles = {
    primary: "bg-[var(--color-navy)] text-white hover:bg-[var(--color-navy-2)]",
    secondary:
      "border border-[var(--color-line-strong)] bg-[var(--color-surface)] text-[var(--color-body)] hover:bg-[var(--color-canvas)]",
    danger: "bg-[var(--color-danger)] text-white hover:opacity-90",
  }[variant];
  return (
    <button
      type={type}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-[13px] font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${styles}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  name,
  type = "text",
  required,
  autoComplete,
  defaultValue,
  hint,
  inputMode,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  autoComplete?: string;
  defaultValue?: string;
  hint?: string;
  inputMode?: "text" | "numeric";
}) {
  const id = `f-${name}`;
  return (
    <div>
      <label htmlFor={id} className="block text-[12px] font-medium text-[var(--color-body)]">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        required={required}
        autoComplete={autoComplete}
        defaultValue={defaultValue}
        inputMode={inputMode}
        className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px] outline-none focus:border-[var(--color-info)]"
      />
      {hint && <p className="mt-1 text-[11px] text-[var(--color-muted)]">{hint}</p>}
    </div>
  );
}

export function Alert({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <div className={`rounded-md border px-3 py-2 text-[13px] ${TONE[tone]}`} role="alert">
      {children}
    </div>
  );
}

export function Select({
  label,
  name,
  options,
  defaultValue,
  required,
  hint,
  placeholder,
}: {
  label: string;
  name: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  defaultValue?: string;
  required?: boolean;
  hint?: string;
  placeholder?: string;
}) {
  const id = `f-${name}`;
  return (
    <div>
      <label htmlFor={id} className="block text-[12px] font-medium text-[var(--color-body)]">
        {label}
      </label>
      <select
        id={id}
        name={name}
        required={required}
        defaultValue={defaultValue ?? ""}
        className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px] outline-none focus:border-[var(--color-info)]"
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {hint && <p className="mt-1 text-[11px] text-[var(--color-muted)]">{hint}</p>}
    </div>
  );
}

export function Textarea({
  label,
  name,
  rows = 3,
  defaultValue,
  required,
  hint,
  maxLength,
}: {
  label: string;
  name: string;
  rows?: number;
  defaultValue?: string;
  required?: boolean;
  hint?: string;
  maxLength?: number;
}) {
  const id = `f-${name}`;
  return (
    <div>
      <label htmlFor={id} className="block text-[12px] font-medium text-[var(--color-body)]">
        {label}
      </label>
      <textarea
        id={id}
        name={name}
        rows={rows}
        required={required}
        maxLength={maxLength}
        defaultValue={defaultValue}
        className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px] outline-none focus:border-[var(--color-info)]"
      />
      {hint && <p className="mt-1 text-[11px] text-[var(--color-muted)]">{hint}</p>}
    </div>
  );
}

/**
 * A link styled as a button.
 *
 * An <a> rather than a <button> with an onClick: navigation should work with the
 * middle mouse button, open in a new tab, and function before hydration.
 */
export function LinkButton({
  href,
  children,
  variant = "secondary",
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "secondary";
}) {
  const styles =
    variant === "primary"
      ? "bg-[var(--color-navy)] text-white hover:bg-[var(--color-navy-2)]"
      : "border border-[var(--color-line-strong)] bg-[var(--color-surface)] text-[var(--color-body)] hover:bg-[var(--color-canvas)]";
  return (
    <a
      href={href}
      className={`inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-[13px] font-medium transition ${styles}`}
    >
      {children}
    </a>
  );
}

/** A table row of totals: heavier rule, no bottom border, tabular figures. */
export function TotalRow({ children }: { children: ReactNode }) {
  return (
    <tr className="border-t-2 border-[var(--color-line-strong)] font-semibold">{children}</tr>
  );
}

export function FieldSet({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-faint)]">
        {legend}
      </legend>
      {children}
    </fieldset>
  );
}
