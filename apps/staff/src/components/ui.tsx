import type { ReactNode } from "react";

/**
 * The platform's primitives, in the brand's clothes.
 *
 * Dense on purpose — data tables, status badges and stat tiles are the vocabulary of accounting
 * and HR software. What changed when the platform took on the public site's identity is the
 * surface underneath them: panels are the site's gold-edged plate, the primary action is its gold
 * button, and headings are set in Playfair. What deliberately did not change is the behaviour.
 * Nothing floats, drifts or glows: those belong to a page somebody scrolls past once, not to a
 * screen somebody reads a figure off forty times a day.
 *
 * Colour lives in tokens (globals.css) and never in this file, which is why the theme could be
 * swapped underneath all 93 screens at once.
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
    <section className="plate rounded-lg">
      {(title || action) && (
        <header className="flex items-start justify-between gap-4 border-b border-[var(--color-line)] px-4 py-3">
          <div>
            {title && (
              <h2 className="font-display text-[15px] font-semibold text-[var(--color-body)]">
                {title}
              </h2>
            )}
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
    <div className="plate rounded-lg px-4 py-3">
      <p className="eyebrow text-[10px] text-[var(--color-faint)]">{label}</p>
      {/* The figure is the point of the tile, so it gets the display face. Tabular, because a row
          of tiles that do not share a digit width reads as though the numbers are wandering. */}
      <p className="numeric font-display mt-1.5 text-[26px] leading-none font-semibold text-[var(--color-gold-2)]">
        {value}
      </p>
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
      <p className="font-display text-[15px] font-semibold text-[var(--color-body)]">{title}</p>
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
      <table className="data-table w-full border-collapse text-[13px]">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-[var(--color-line)]">
            {/* Keyed by position as well as label: a table may legitimately have
                two blank column headings, and React needs the keys to differ. */}
            {columns.map((c, index) => (
              <th
                key={`${c}-${index}`}
                scope="col"
                className="eyebrow px-3 py-2 text-left text-[10px] text-[var(--color-faint)]"
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
  onClick,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger";
  type?: "button" | "submit";
  disabled?: boolean;
  /** Only from a client component. A server component passing this is a build error, which is the right place to find out. */
  onClick?: () => void;
}) {
  // The look is three classes in globals.css rather than three strings here, so that the forty
  // buttons written inline across the screens can say the same thing without repeating it.
  const styles = { primary: "btn-primary", secondary: "btn-secondary", danger: "btn-danger" }[
    variant
  ];
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`btn px-3 py-2 text-[13px] ${styles}`}
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
      <label htmlFor={id} className="block text-[12px] font-medium text-[var(--color-muted)]">
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
        className="control mt-1"
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
      <label htmlFor={id} className="block text-[12px] font-medium text-[var(--color-muted)]">
        {label}
      </label>
      <select
        id={id}
        name={name}
        required={required}
        defaultValue={defaultValue ?? ""}
        className="control mt-1"
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
      <label htmlFor={id} className="block text-[12px] font-medium text-[var(--color-muted)]">
        {label}
      </label>
      <textarea
        id={id}
        name={name}
        rows={rows}
        required={required}
        maxLength={maxLength}
        defaultValue={defaultValue}
        className="control mt-1"
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
  const styles = variant === "primary" ? "btn-primary" : "btn-secondary";
  return (
    <a href={href} className={`btn px-3 py-2 text-[13px] ${styles}`}>
      {children}
    </a>
  );
}

/** A table row of totals: heavier rule, no bottom border, tabular figures. */
export function TotalRow({ children }: { children: ReactNode }) {
  return (
    <tr className="border-t-2 border-[var(--color-line-strong)] font-semibold text-[var(--color-gold-2)]">
      {children}
    </tr>
  );
}

export function FieldSet({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="eyebrow mb-1 text-[10px] text-[var(--color-gold-soft)]">
        {legend}
      </legend>
      {children}
    </fieldset>
  );
}
