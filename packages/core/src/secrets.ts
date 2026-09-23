import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Symmetric encryption for secrets that must be recoverable — specifically
 * TOTP seeds, which have to be read back to verify a code and therefore cannot
 * be hashed.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than silently yielding rubbish that would then be treated as a TOTP seed.
 *
 * The key comes from APP_ENCRYPTION_KEY and lives in the secret manager, never
 * in the database and never in the repository. Storing it beside the
 * ciphertext would make the encryption decorative.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function getKey(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;

  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "APP_ENCRYPTION_KEY is not set. Refusing to start in production with " +
          "a derived development key — MFA secrets would be trivially decryptable.",
      );
    }
    // Development only, and deliberately obvious in the logs.
    return createHash("sha256").update("cac-development-key-do-not-use-in-production").digest();
  }

  // Accept either 32 raw bytes as base64/hex, or any passphrase (hashed to 32).
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 32) return decoded;
  return createHash("sha256").update(raw).digest();
}

/** Returns `v1.<iv>.<authTag>.<ciphertext>`, all base64url. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(payload: string): string {
  const [version, ivPart, tagPart, dataPart] = payload.split(".");
  if (version !== "v1" || !ivPart || !tagPart || !dataPart) {
    throw new Error("Malformed encrypted secret.");
  }
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** True when a real key is configured — surfaced on the admin health screen. */
export function hasProductionKey(): boolean {
  return Boolean(process.env.APP_ENCRYPTION_KEY);
}
