import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238) over HOTP (RFC 4226).
 *
 * Implemented directly rather than pulled from a package: it is about sixty
 * lines of well-specified arithmetic, it removes a dependency from the
 * authentication path, and — the deciding reason — RFC 6238 publishes test
 * vectors, so correctness can be *proved* in the test suite rather than
 * assumed from a package's download count.
 */

export type TotpAlgorithm = "sha1" | "sha256" | "sha512";

export interface TotpOptions {
  /** Seconds per step. 30 is what every authenticator app expects. */
  period?: number;
  digits?: number;
  algorithm?: TotpAlgorithm;
}

const DEFAULTS = { period: 30, digits: 6, algorithm: "sha1" as TotpAlgorithm };

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP — RFC 4226 section 5.3. */
export function hotp(secret: Buffer, counter: number, options: TotpOptions = {}): string {
  const { digits, algorithm } = { ...DEFAULTS, ...options };

  const counterBuffer = Buffer.alloc(8);
  // Counter is a 64-bit big-endian integer. Written as two 32-bit halves
  // because bitwise operators in JS are 32-bit.
  counterBuffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuffer.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac(algorithm, secret).update(counterBuffer).digest();

  // Dynamic truncation: the low nibble of the last byte picks the offset.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

export function totp(secretBase32: string, options: TotpOptions & { now?: number } = {}): string {
  const { period } = { ...DEFAULTS, ...options };
  const now = options.now ?? Date.now();
  return hotp(base32Decode(secretBase32), Math.floor(now / 1000 / period), options);
}

/**
 * Verifies a submitted code, tolerating a little clock drift.
 *
 * `window: 1` accepts the previous, current and next step — roughly 90 seconds
 * either side of correct. Comparison is constant-time so a timing side channel
 * cannot leak how many leading digits were right.
 */
export function verifyTotp(
  secretBase32: string,
  token: string,
  options: TotpOptions & { window?: number; now?: number } = {},
): boolean {
  return matchTotpStep(secretBase32, token, options) !== null;
}

/**
 * The counter step a code matched, or null.
 *
 * `verifyTotp` answers yes or no, which is not enough to stop a replay: the drift window accepts
 * three steps, so a code seen over a shoulder or captured by a phishing page kept working for about
 * ninety seconds. Knowing *which* step matched lets the caller record it and refuse that step and
 * everything before it, which spends the code.
 *
 * `after` is the last step already spent. A match at or below it is treated as no match at all, and
 * deliberately so: the caller cannot then accidentally accept a replay by ignoring a flag.
 */
export function matchTotpStep(
  secretBase32: string,
  token: string,
  options: TotpOptions & { window?: number; now?: number; after?: number | null } = {},
): number | null {
  const { period, digits } = { ...DEFAULTS, ...options };
  const window = options.window ?? 1;
  const now = options.now ?? Date.now();

  const submitted = token.replace(/\s/g, "");
  if (!/^\d+$/.test(submitted) || submitted.length !== digits) return null;

  const secret = base32Decode(secretBase32);
  const counter = Math.floor(now / 1000 / period);
  const submittedBuffer = Buffer.from(submitted);
  const after = options.after ?? null;

  let matchedStep: number | null = null;
  for (let drift = -window; drift <= window; drift++) {
    const step = counter + drift;
    const candidate = Buffer.from(hotp(secret, step, options));
    // Do not break early: comparing every candidate keeps the work constant
    // regardless of which step matched.
    if (
      candidate.length === submittedBuffer.length &&
      timingSafeEqual(candidate, submittedBuffer) &&
      (after === null || step > after)
    ) {
      matchedStep = step;
    }
  }
  return matchedStep;
}

/** otpauth:// URI for authenticator QR codes. */
export function otpauthUri(params: {
  secret: string;
  accountName: string;
  issuer: string;
  options?: TotpOptions;
}): string {
  const { period, digits, algorithm } = { ...DEFAULTS, ...params.options };
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.accountName)}`;
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: algorithm.toUpperCase(),
    digits: String(digits),
    period: String(period),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
