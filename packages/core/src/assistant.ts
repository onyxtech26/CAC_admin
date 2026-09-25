/**
 * The boundary for AI assistance on a case.
 *
 * The governing rule for this phase, from the plan and repeated here because it is the
 * whole design: **the rule engine decides requirements; the model assists, cites and
 * drafts. It never determines a legal requirement alone, and it never submits anything.**
 *
 * That rule is kept structurally rather than by discipline:
 *
 *   - A `CaseAssistant` can only return a *draft* and the *citations* it rests on. The
 *     type has no field that could set a requirement, answer a fact, verify anything or
 *     send anything. There is no code path from an assistant's reply into a write.
 *   - Every reply carries `reviewed: false`. Nothing marks it reviewed except a person,
 *     through the ordinary approval path for whatever it becomes.
 *   - A reply whose citations do not resolve to passages the *caller* may read is
 *     discarded by `checkCitations` rather than shown. A model that cites a document
 *     somebody cannot open has either hallucinated it or leaked it, and both are refusals.
 *   - `NotConfiguredAssistant` is what is installed. It refuses.
 *
 * **Why no stub.** A fake that returns plausible drafting is the most dangerous stub in
 * this platform. Everything else that is absent here fails visibly — an unscanned file
 * stays in quarantine, an empty checklist says it is empty. A fabricated legal draft looks
 * exactly like a real one, and the person reading it has no way to tell. So there is
 * nothing to fall back to, and the deterministic work in `case-agent.ts` — which needs no
 * model at all — is what the agent screen actually runs.
 */

export interface AssistantCitation {
  /** A chunk in the document library. Checked against the caller's own access. */
  chunkId: string;
  /** What the model says this passage supports. Its claim, not a verified one. */
  claim: string;
}

export interface AssistantReply {
  /** Prose, for a person to read and rewrite. Never treated as a decision. */
  draft: string;
  citations: AssistantCitation[];
  /** The model that produced it, recorded with anything kept. */
  model: string;
  /** Always false on the way out of a provider. Only a person changes it. */
  reviewed: false;
  /** What the model says it could not do. Surfaced rather than smoothed over. */
  limitations: string[];
}

export interface AssistantRequest {
  /** What is being asked for, in the caller's words. */
  question: string;
  /**
   * The passages the caller may read, already retrieved and permission-filtered.
   *
   * The assistant is given its context rather than searching for itself: retrieval is
   * where access control lives, and a model that could search would be a model that could
   * reach a matter the caller cannot.
   */
  context: Array<{ chunkId: string; documentNo: string; text: string }>;
  /** A bounded summary of the matter. Never the whole file. */
  matterSummary: string;
}

export class AssistantNotConfiguredError extends Error {
  readonly code = "ASSISTANT_NOT_CONFIGURED";
  constructor(message: string) {
    super(message);
    this.name = "AssistantNotConfiguredError";
  }
}

export interface CaseAssistant {
  readonly name: string;
  readonly model: string;
  isConfigured(): boolean;
  /** Drafts. Cannot write, decide, verify or send — the return type has no room for it. */
  draft(request: AssistantRequest): Promise<AssistantReply>;
}

export class NotConfiguredAssistant implements CaseAssistant {
  readonly name = "none";
  readonly model = "none";

  isConfigured(): boolean {
    return false;
  }

  async draft(_request: AssistantRequest): Promise<AssistantReply> {
    throw new AssistantNotConfiguredError(
      "No case assistant is configured, and nothing here will draft legal text without one. The deterministic parts of the agent — the intake order, the missing information, the contradictions and the similar matters — need no model and are what this screen runs. Enabling a model is Q-AI-1 (which provider, hosted where) and Q-LEGAL-2 (which authorities it may cite); a legal reviewer must also be appointed under Q-LEGAL-1 before any drafted document can be approved.",
    );
  }
}

/**
 * Discards a reply whose citations do not hold.
 *
 * Two failures, and both mean the reply is thrown away rather than shown with a caveat:
 * a citation to a passage that was not in the context the model was given (it invented
 * it), and a citation to a passage the caller may not read (it has reached across a
 * permission boundary, which cannot happen given how context is assembled, and which must
 * be treated as a fault rather than explained away if it ever does).
 *
 * A "mostly cited" draft is not usable. Somebody would read the prose, not the footnotes.
 */
export function checkCitations(
  reply: AssistantReply,
  allowedChunkIds: Iterable<string>,
): { ok: true } | { ok: false; reason: string } {
  const allowed = new Set(allowedChunkIds);

  for (const citation of reply.citations) {
    if (!allowed.has(citation.chunkId)) {
      return {
        ok: false,
        reason: `The draft cites a passage that was not among the ones it was given (${citation.chunkId}). A citation to something that was not there is a fabricated citation, so the draft has been discarded rather than shown.`,
      };
    }
  }

  if (reply.draft.trim() === "") {
    return { ok: false, reason: "The draft came back empty." };
  }

  return { ok: true };
}

/** The assistant this deployment has. Nothing is wired, deliberately. */
export function assistantFromEnv(
  _env: Record<string, string | undefined> = process.env,
): CaseAssistant {
  return new NotConfiguredAssistant();
}
