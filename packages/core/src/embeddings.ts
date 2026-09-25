/**
 * The embedding boundary.
 *
 * Vector retrieval needs a model to turn text into vectors, and which model CAC may use
 * is not a detail: these documents contain a family's identification numbers, their
 * holdings and their disagreements, and sending them to a third-party API is a data
 * export. Q-AI-1 covers which provider, hosted where, under what terms; Q-DATA-2 covers
 * whether personal data may leave the country at all.
 *
 * So the same shape as the scanner and the e-Invoice provider:
 *
 *   - `EmbeddingProvider` is the seam.
 *   - `NotConfiguredEmbeddingProvider` is installed, and refuses.
 *   - Nothing fabricates a vector.
 *
 * **Why a fake would be worse than nothing here.** A random or hashed vector produces a
 * search that returns results — ranked, plausible-looking, and unrelated to the query.
 * Lexical search that finds nothing is obviously finding nothing; semantic search
 * returning noise looks like it is working. The retrieval in `library.ts` is therefore
 * built lexical-first: PostgreSQL full-text search over the chunks, which is real and
 * works today, with the vector half wired and reporting itself unavailable.
 */

export interface EmbeddingProvider {
  readonly name: string;
  /** The model identifier recorded against every vector it produces. */
  readonly model: string;
  /** Vector length, so a mismatch is caught before it is stored. */
  readonly dimensions: number;
  isConfigured(): boolean;
  /** One vector per input, in order. */
  embed(texts: string[]): Promise<number[][]>;
}

export class EmbeddingNotConfiguredError extends Error {
  readonly code = "EMBEDDING_NOT_CONFIGURED";
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingNotConfiguredError";
  }
}

export class NotConfiguredEmbeddingProvider implements EmbeddingProvider {
  readonly name = "none";
  readonly model = "none";
  readonly dimensions = 0;

  isConfigured(): boolean {
    return false;
  }

  async embed(): Promise<number[][]> {
    throw new EmbeddingNotConfiguredError(
      "No embedding model is configured, so semantic search is unavailable. Full-text search over the same documents works and is used instead. Configuring a model is not only a technical choice — these documents hold personal data, and whether they may be sent to a third party is Q-AI-1 and Q-DATA-2.",
    );
  }
}

/**
 * The provider this deployment has.
 *
 * Nothing is wired, deliberately. When a model is chosen it is constructed here from
 * explicit configuration — a base URL, a model name, a key, a stated dimension — and a
 * missing or partial configuration produces the refusing implementation rather than a
 * silent fallback to something that returns numbers.
 */
export function embeddingProviderFromEnv(
  _env: Record<string, string | undefined> = process.env,
): EmbeddingProvider {
  return new NotConfiguredEmbeddingProvider();
}

/**
 * Cosine similarity, for when there are vectors to compare.
 *
 * Here rather than in the retrieval code because it is arithmetic and worth testing on
 * its own. Returns null for a length mismatch or a zero vector instead of NaN: a
 * similarity that silently becomes NaN sorts unpredictably and produces a ranking nobody
 * can explain.
 */
export function cosineSimilarity(a: number[], b: number[]): number | null {
  if (a.length === 0 || a.length !== b.length) return null;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return null;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
