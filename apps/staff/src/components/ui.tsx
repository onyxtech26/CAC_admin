import type { ReactNode } from "react";

/**
 * Enterprise primitives for CAC Platform.
 *
 * Spacious, high-legibility enterprise components:
 * - Generous padding and crisp boundaries
 * - Clear contrast and readable status badges
 * - Tabular alignment for financial figures and time logs
 */

type Tone = "neutral" | "ok" | "warn" | "danger" | "info";

const TONE: Record<Tone, string> = {
  neutral: "bg-[var(--color-surface-2)] text-[var(--color-body)] border-[var(--color-line)]",
  ok: "bg-[var(--color-ok-bg)] text-[var(--color-ok)] border-[var(--color-ok-border)]",
  warn: "bg-[var(--color-warn-bg)] text-[var(--color-warn)] border-[var(--color-warn-border)]",
  danger: "bg-[var(--color-danger-bg)] text-[var(--color-danger)] border-[var(--color-danger-border)]",
  info: "bg-[var(--color-info-bg)] text-[var(--color-info)] border-[var(--color-info-border)]",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium ${TONE[tone]}`}
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
    <section className="plate rounded-xl overflow-hidden">
      {(title || action) && (
        <header className="flex items-start justify-between gap-4 border-b border-[var(--color-line)] bg-slate-50/70 px-6 py-4">
          <div>
            {title && (
              <h2 className="text-[15.5px] font-semibold text-slate-900 tracking-tight">
                {title}
              </h2>
            )}
            {description && (
              <p className="mt-0.5 text-[12.5px] text-[var(--color-muted)]">{description}</p>
            )}
          </div>
          {action}
        </header>
      )}
      <div className="p-6">{children}</div>
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
    <div className="plate plate-interactive rounded-xl p-5 transition-all duration-200 hover:-translate-y-0.5">
      <p className="eyebrow text-[10.5px] text-[var(--color-faint)] font-medium">{label}</p>
      <p className="numeric mt-2 text-[26px] leading-none font-bold text-slate-900 tracking-tight">
        {value}
      </p>
      {hint && (
        <p className="mt-2 text-[12px]">
          <span
            className={
              tone === "warn"
                ? "text-[var(--color-warn)] font-medium"
                : tone === "danger"
                  ? "text-[var(--color-danger)] font-medium"
                  : tone === "ok"
                    ? "text-[var(--color-ok)] font-medium"
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
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--color-line-strong)] bg-slate-50/40 px-6 py-12 text-center">
      <p className="text-[14.5px] font-semibold text-slate-900 tracking-tight">{title}</p>
      {body && <p className="mt-1 max-w-md text-[12.5px] text-[var(--color-muted)]">{body}</p>}
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
    <div className="overflow-x-auto rounded-xl border border-[var(--color-line)] bg-white shadow-xs">
      <table className="data-table w-full border-collapse text-[13.5px]">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-[var(--color-line)] bg-slate-50/80">
            {columns.map((c, index) => (
              <th
                key={`${c}-${index}`}
                scope="col"
                className="eyebrow px-4 py-3 text-left text-[10.5px] font-semibold text-[var(--color-faint)]"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-line)]">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, numeric }: { children: ReactNode; numeric?: boolean }) {
  return (
    <td
      className={`px-4 py-3.5 text-[13.5px] text-[var(--color-body)] ${numeric ? "numeric text-right" : ""}`}
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
  onClick,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger";
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
}) {
  const styles = { primary: "btn-primary", secondary: "btn-secondary", danger: "btn-danger" }[
    variant
  ];
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`btn ${styles}`}
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
  inputMode?: "text" | "numeric" | "decimal";
}) {
  const id = `f-${name}`;
  return (
    <div>
      <label htmlFor={id} className="block text-[12.5px] font-medium text-[var(--color-navy)]">
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
        className="control mt-1.5"
      />
      {hint && <p className="mt-1 text-[11.5px] text-[var(--color-faint)]">{hint}</p>}
    </div>
  );
}

export function Alert({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <div className={`rounded-xl border px-4 py-3 text-[13.5px] ${TONE[tone]}`} role="alert">
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
      <label htmlFor={id} className="block text-[12.5px] font-medium text-[var(--color-navy)]">
        {label}
      </label>
      <select
        id={id}
        name={name}
        required={required}
        defaultValue={defaultValue ?? ""}
        className="control mt-1.5"
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {hint && <p className="mt-1 text-[11.5px] text-[var(--color-faint)]">{hint}</p>}
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
      <label htmlFor={id} className="block text-[12.5px] font-medium text-[var(--color-navy)]">
        {label}
      </label>
      <textarea
        id={id}
        name={name}
        rows={rows}
        required={required}
        maxLength={maxLength}
        defaultValue={defaultValue}
        className="control mt-1.5"
      />
      {hint && <p className="mt-1 text-[11.5px] text-[var(--color-faint)]">{hint}</p>}
    </div>
  );
}

export function LinkButton({
  href,
  children,
  variant = "secondary",
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "secondary";
}) {
  const styles = variant === "primary" ? "btn-primary" : "btn-secondary";
  return (
    <a href={href} className={`btn ${styles}`}>
      {children}
    </a>
  );
}

export function TotalRow({ children }: { children: ReactNode }) {
  return (
    <tr className="border-t-2 border-[var(--color-line-strong)] bg-slate-50/50 font-semibold text-[var(--color-navy)]">
      {children}
    </tr>
  );
}

export function FieldSet({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-4">
      <legend className="eyebrow mb-1 text-[10.5px] text-[var(--color-gold)] font-semibold">
        {legend}
      </legend>
      {children}
    </fieldset>
  );
}
