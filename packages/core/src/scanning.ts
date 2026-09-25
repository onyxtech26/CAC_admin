import { createConnection } from "node:net";

/**
 * The malware-scanning boundary.
 *
 * Files arrive from clients by email and on memory sticks, and they land in a system
 * that staff then open. Scanning them is not optional, and neither is being honest about
 * whether it happened.
 *
 * So, exactly as with the e-Invoice boundary:
 *
 *   - `MalwareScanner` is what the pipeline talks to. Nothing else knows what is behind
 *     it.
 *   - `NotConfiguredScanner` is what is installed by default, and it refuses. It never
 *     returns "clean". A document it was asked about stays in quarantine.
 *   - `ClamAvScanner` is real: it speaks clamd's INSTREAM protocol over TCP and reports
 *     what clamd actually says. It will not construct without a host and a port, so it
 *     cannot silently become the active scanner.
 *
 * **There is no stub that reports clean.** A fake that answers "no threat found" is
 * worse than no scanner at all: the file is marked safe, somebody opens it, and nobody
 * discovers otherwise. What exists instead is quarantine, and a deliberate, audited,
 * reasoned *release* by a named person — which records `released_unscanned`, never
 * `clean`. That distinction is the whole point, and it survives into every screen and
 * every download.
 */

export type ScanVerdict = "clean" | "infected";

export interface ScanResult {
  verdict: ScanVerdict;
  /** What the scanner is, so the verdict can be attributed. */
  scanner: string;
  scannerVersion: string | null;
  /** The signature name for an infected file; the raw reply otherwise. */
  detail: string;
}

export class ScannerNotConfiguredError extends Error {
  readonly code = "SCANNER_NOT_CONFIGURED";
  constructor(message: string) {
    super(message);
    this.name = "ScannerNotConfiguredError";
  }
}

/** A scanner that was reachable but could not give a verdict. Distinct from absent. */
export class ScanFailedError extends Error {
  readonly code = "SCAN_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "ScanFailedError";
  }
}

export interface MalwareScanner {
  readonly name: string;
  /** True when a scan can actually be attempted. */
  isConfigured(): boolean;
  /** The scanner's own version string, for the audit trail. Null when unknown. */
  version(): Promise<string | null>;
  scan(bytes: Uint8Array, filename: string): Promise<ScanResult>;
}

/**
 * What is installed until CAC provides a scanner.
 *
 * Every call raises, with a sentence naming what is missing. Uploaded documents stay
 * quarantined; the screens say so and say what would change it.
 */
export class NotConfiguredScanner implements MalwareScanner {
  readonly name = "none";

  isConfigured(): boolean {
    return false;
  }

  async version(): Promise<string | null> {
    return null;
  }

  async scan(): Promise<ScanResult> {
    throw new ScannerNotConfiguredError(
      "No malware scanner is configured, so this file cannot be declared clean. Set CAC_CLAMAV_HOST and CAC_CLAMAV_PORT to a clamd instance, or release the document explicitly with a reason — which records it as unscanned, not as clean.",
    );
  }
}

export interface ClamAvOptions {
  host: string;
  port: number;
  /** Milliseconds. A scan that hangs must not hang an upload. */
  timeoutMs?: number;
  /** clamd's own limit; sending more than it accepts produces a protocol error. */
  maxBytes?: number;
}

/**
 * A real scanner: clamd over TCP, INSTREAM.
 *
 * INSTREAM rather than SCAN-by-path because the bytes are in the database and in this
 * process, not on a filesystem clamd can see. The protocol is: `zINSTREAM\0`, then
 * length-prefixed chunks, then a zero-length chunk, then read the reply — which is
 * `stream: OK`, or `stream: <signature> FOUND`, or an error.
 *
 * Anything that is not a clear OK or FOUND is a `ScanFailedError`, never a clean
 * verdict. A scanner that cannot answer has not answered.
 */
export class ClamAvScanner implements MalwareScanner {
  readonly name = "clamav";
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(options: ClamAvOptions) {
    if (!options.host?.trim()) {
      throw new ScannerNotConfiguredError("A clamd host is required.");
    }
    if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
      throw new ScannerNotConfiguredError("A valid clamd port is required.");
    }
    this.host = options.host.trim();
    this.port = options.port;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  }

  isConfigured(): boolean {
    return true;
  }

  async version(): Promise<string | null> {
    try {
      const reply = await this.command(Buffer.from("zVERSION\0", "ascii"));
      return reply.trim() || null;
    } catch {
      // A version we could not read is not a reason to refuse a scan.
      return null;
    }
  }

  async scan(bytes: Uint8Array, filename: string): Promise<ScanResult> {
    if (bytes.byteLength > this.maxBytes) {
      throw new ScanFailedError(
        `${filename} is larger than the scanner accepts (${this.maxBytes} bytes), so it has not been scanned.`,
      );
    }

    const header = Buffer.from("zINSTREAM\0", "ascii");
    const size = Buffer.alloc(4);
    size.writeUInt32BE(bytes.byteLength, 0);
    const terminator = Buffer.alloc(4); // a zero-length chunk ends the stream
    const payload = Buffer.concat([header, size, Buffer.from(bytes), terminator]);

    const reply = (await this.command(payload)).trim();

    if (/\bOK$/.test(reply)) {
      return {
        verdict: "clean",
        scanner: this.name,
        scannerVersion: await this.version(),
        detail: reply,
      };
    }
    const found = /^(?:stream:\s*)?(.+?)\s+FOUND$/.exec(reply);
    if (found) {
      return {
        verdict: "infected",
        scanner: this.name,
        scannerVersion: await this.version(),
        detail: found[1],
      };
    }
    // Explicitly not a verdict.
    throw new ScanFailedError(
      `The scanner did not give a verdict for ${filename}: ${reply || "no reply"}`,
    );
  }

  private command(payload: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port });
      const parts: Buffer[] = [];
      let settled = false;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new ScanFailedError(error.message));
      };

      socket.setTimeout(this.timeoutMs, () => fail(new Error("the scanner did not respond in time")));
      socket.on("error", (error) => fail(error));
      socket.on("data", (chunk: Buffer) => parts.push(chunk));
      socket.on("end", () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(parts).toString("utf8").replace(/\0+$/, ""));
      });
      socket.on("connect", () => {
        socket.write(payload);
      });
    });
  }
}

/**
 * The scanner this deployment has.
 *
 * Reads the environment and nothing else — no fallback, no "development mode" that
 * pretends. Absent configuration produces `NotConfiguredScanner`, which refuses.
 */
export function scannerFromEnv(
  env: Record<string, string | undefined> = process.env,
): MalwareScanner {
  const host = env.CAC_CLAMAV_HOST?.trim();
  const port = Number(env.CAC_CLAMAV_PORT ?? "3310");

  if (!host) return new NotConfiguredScanner();

  try {
    return new ClamAvScanner({ host, port });
  } catch {
    // Misconfiguration is not a licence to declare files clean.
    return new NotConfiguredScanner();
  }
}
