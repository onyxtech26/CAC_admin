import { useId, useRef, useState } from "react";
import { Icon } from "./Icon";
import { CONTACT, SERVICE_OPTIONS } from "../data";

/**
 * The enquiry form.
 *
 * Every primary call to action on this site — "Start Investigation", "Book Consultation", "Engage
 * this discipline" and every Contact link — pointed at a page with no form on it, so a visitor who
 * clicked the main button arrived somewhere they could only leave from. `SERVICE_OPTIONS` sat in
 * `data.ts`, exported and used by nothing: the dropdown source for this.
 *
 * Three things are deliberate.
 *
 * **It says what actually happens.** No "we will respond within 24 hours": there is no mail
 * transport and nobody has promised a response time. The enquiry lands on a screen the firm reads,
 * and the confirmation says so, with the reference and the same phone number that is on the rest of
 * the page for anybody who would rather not wait.
 *
 * **It fails towards the telephone.** If the endpoint is unreachable — a deployment where the staff
 * platform is not yet configured, an office with no connectivity — the message says so and puts the
 * phone number in front of the visitor rather than spinning. A form that swallows an enquiry is
 * worse than no form, because the visitor believes they have been in touch.
 *
 * **It is honest about what it is for.** A confidential matter should not be typed into a web form,
 * and the note under the message box says to keep it to what is needed to start a conversation.
 */

const ENDPOINT = import.meta.env.VITE_ENQUIRY_ENDPOINT ?? "/api/enquiries";

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; reference: string | null }
  | { kind: "failed"; message: string };

export function EnquiryForm() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const formRef = useRef<HTMLFormElement>(null);
  const id = useId();

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status.kind === "sending") return;

    const data = new FormData(event.currentTarget);
    setStatus({ kind: "sending" });

    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: data.get("name"),
          email: data.get("email"),
          phone: data.get("phone"),
          company: data.get("company"),
          service: data.get("service"),
          message: data.get("message"),
          // The field no human fills in.
          website: data.get("website"),
        }),
      });

      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; reference?: string | null; error?: string }
        | null;

      if (response.ok && body?.ok) {
        setStatus({ kind: "sent", reference: body.reference ?? null });
        formRef.current?.reset();
        return;
      }

      setStatus({
        kind: "failed",
        message:
          body?.error ??
          "The enquiry could not be sent. Please call or email us instead — the details are below.",
      });
    } catch {
      setStatus({
        kind: "failed",
        message:
          "We could not reach our system just now. Please call or email us instead — the details " +
          "are below, and they reach the same people.",
      });
    }
  }

  if (status.kind === "sent") {
    return (
      <div
        className="corner-ticks rounded-xl border border-gold-2/40 bg-gradient-to-br from-navy-3 to-ink p-6"
        role="status"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full border border-gold-2 text-gold-2">
            <Icon name="seal" size={18} />
          </span>
          <div>
            <h3 className="font-display text-2xl text-ivory">Your enquiry is with us.</h3>
            {status.reference && (
              <p className="mt-2 font-mono text-[12px] uppercase tracking-wide-2 text-gold-2">
                Reference {status.reference}
              </p>
            )}
            <p className="mt-3 text-stone">
              It is on the desk of the consultant who handles new matters. We have not set a
              turnaround we cannot keep to — if your matter is urgent, call{" "}
              <a href={`tel:+${CONTACT.phoneRaw}`} className="underline hover:text-gold-2">
                {CONTACT.phoneDisplay}
              </a>{" "}
              and quote that reference.
            </p>
            <button
              type="button"
              onClick={() => setStatus({ kind: "idle" })}
              className="mt-4 font-mono text-[11px] uppercase tracking-wide-2 text-gold-2 underline"
            >
              Send another
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form
      ref={formRef}
      onSubmit={submit}
      className="corner-ticks rounded-xl border border-gold-2/25 bg-gradient-to-br from-navy-3 to-ink p-6 sm:p-8"
      noValidate={false}
    >
      <h3 className="font-display text-2xl text-ivory">Tell us about the matter</h3>
      <p className="mt-2 text-[13px] text-stone">
        Enough to start a conversation. Nothing confidential needs to go in this box — we will ask
        for documents when we know what we are looking at.
      </p>

      {status.kind === "failed" && (
        <div
          role="alert"
          className="mt-5 rounded-lg border border-red-500/40 bg-red-950/30 p-3 text-[13px] text-red-200"
        >
          {status.message}
        </div>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Field id={`${id}-name`} name="name" label="Your name" required autoComplete="name" />
        <Field
          id={`${id}-company`}
          name="company"
          label="Company or firm"
          hint="Optional"
          autoComplete="organization"
        />
        <Field
          id={`${id}-email`}
          name="email"
          label="Email"
          type="email"
          autoComplete="email"
          hint="Email or phone — one of the two, so we can reply"
        />
        <Field id={`${id}-phone`} name="phone" label="Phone" type="tel" autoComplete="tel" />
      </div>

      <div className="mt-4">
        <label
          htmlFor={`${id}-service`}
          className="font-mono text-[11px] uppercase tracking-wide-2 text-gold-2"
        >
          What it concerns
        </label>
        <select
          id={`${id}-service`}
          name="service"
          defaultValue=""
          className="mt-2 w-full rounded-lg border border-gold-2/25 bg-ink/60 px-3 py-2.5 text-ivory outline-none focus:border-gold-2"
        >
          <option value="">Not sure yet</option>
          {SERVICE_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-4">
        <label
          htmlFor={`${id}-message`}
          className="font-mono text-[11px] uppercase tracking-wide-2 text-gold-2"
        >
          What you need <span className="text-red-400">*</span>
        </label>
        <textarea
          id={`${id}-message`}
          name="message"
          required
          rows={5}
          maxLength={4000}
          aria-describedby={`${id}-message-hint`}
          className="mt-2 w-full rounded-lg border border-gold-2/25 bg-ink/60 px-3 py-2.5 text-ivory outline-none focus:border-gold-2"
        />
        <p id={`${id}-message-hint`} className="mt-1.5 text-[12px] text-mute">
          A sentence or two. Where the property is, what has happened, and what you are trying to
          establish.
        </p>
      </div>

      {/* Left empty by a person and filled by a script. Hidden from everyone: off-screen rather than
          display:none, because some automation skips what is not rendered, and aria-hidden with a
          negative tabindex so it is not read out or tabbed into. */}
      <div className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden" aria-hidden="true">
        <label htmlFor={`${id}-website`}>Leave this field empty</label>
        <input id={`${id}-website`} name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <button
        type="submit"
        disabled={status.kind === "sending"}
        className="mt-6 inline-flex items-center gap-2 rounded-lg border border-gold-2 bg-gold-2/10 px-5 py-3 font-mono text-[12px] uppercase tracking-wide-2 text-gold-2 transition hover:bg-gold-2/20 disabled:opacity-60"
      >
        {status.kind === "sending" ? "Sending…" : "Send the enquiry"}
        <Icon name="chevron-right" size={14} />
      </button>

      <p className="mt-4 text-[12px] text-mute">
        What you send is stored on CAC&rsquo;s own system and read by the consultants who handle new
        matters. It is not sent anywhere else.
      </p>
    </form>
  );
}

function Field({
  id,
  name,
  label,
  type = "text",
  required,
  hint,
  autoComplete,
}: {
  id: string;
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  hint?: string;
  autoComplete?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="font-mono text-[11px] uppercase tracking-wide-2 text-gold-2">
        {label} {required && <span className="text-red-400">*</span>}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        required={required}
        autoComplete={autoComplete}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="mt-2 w-full rounded-lg border border-gold-2/25 bg-ink/60 px-3 py-2.5 text-ivory outline-none focus:border-gold-2"
      />
      {hint && (
        <p id={`${id}-hint`} className="mt-1.5 text-[12px] text-mute">
          {hint}
        </p>
      )}
    </div>
  );
}
