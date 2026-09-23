import { hash, verify, Algorithm } from "@node-rs/argon2";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Password and token hashing.
 *
 * argon2id for passwords — memory-hard, so custom hardware buys an attacker far
 * less than it would against SHA-family or bcrypt. Parameters follow current
 * OWASP guidance; they are recorded inside the hash string, so raising them
 * later does not invalidate existing hashes.
 */
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

/**
 * Always returns a boolean. A malformed stored hash is a failed verification,
 * never an exception that a caller might mistake for success.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    return await verify(stored, plain, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

export interface PasswordPolicy {
  minLength: number;
}

export interface PasswordCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Length first, as current guidance prefers, plus a small set of obviously
 * weak shapes. Composition rules (one upper, one symbol…) are deliberately
 * absent: they push people towards Password1! and buy little.
 *
 * A breached-password check belongs here too — see docs/SECURITY_MODEL.md.
 * It is not wired up yet because it needs an outbound allowlist decision.
 */
export function checkPasswordPolicy(plain: string, policy: PasswordPolicy): PasswordCheck {
  const problems: string[] = [];

  if (plain.length < policy.minLength) {
    problems.push(`Use at least ${policy.minLength} characters.`);
  }
  if (/^(.)\1+$/.test(plain)) {
    problems.push("Do not repeat a single character.");
  }
  if (/^(?:0123456789|1234567890|abcdefghij|qwertyuiop)/i.test(plain)) {
    problems.push("Avoid keyboard or alphabet sequences.");
  }
  const common = ["password", "passw0rd", "letmein", "welcome", "admin", "conglomerate", "cac"];
  if (common.some((c) => plain.toLowerCase().includes(c))) {
    problems.push("Avoid common words and the company name.");
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Opaque session/reset tokens.
 *
 * The raw token goes to the client exactly once; only `hash` is stored, so a
 * database leak yields nothing usable. SHA-256 is right here — unlike a
 * password, the input already has 256 bits of entropy, so slow hashing would
 * only cost us latency on every request.
 */
export function generateToken(bytes = 32): { token: string; hash: string } {
  const token = randomBytes(bytes).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Recovery codes for when the authenticator is lost. Ambiguous characters
 * (0/O, 1/I) are excluded because these get written down and read back.
 */
export function generateRecoveryCodes(count = 10): { codes: string[]; hashes: string[] } {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = randomBytes(10);
    let code = "";
    for (let j = 0; j < 10; j++) {
      code += alphabet[raw[j]! % alphabet.length];
      if (j === 4) code += "-";
    }
    codes.push(code);
  }
  return { codes, hashes: codes.map(hashToken) };
}
