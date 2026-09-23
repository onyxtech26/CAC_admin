import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, hotp, otpauthUri, totp, verifyTotp } from "./totp.js";

/**
 * The published RFC test vectors. These are the reason this is implemented
 * here rather than taken from a package: correctness is demonstrated, not
 * assumed.
 */
describe("HOTP — RFC 4226 Appendix D", () => {
  const secret = Buffer.from("12345678901234567890", "ascii");
  const expected = [
    "755224", "287082", "359152", "969429", "338314",
    "254676", "287922", "162583", "399871", "520489",
  ];

  it.each(expected.map((code, counter) => [counter, code]))(
    "counter %i produces %s",
    (counter, code) => {
      expect(hotp(secret, counter as number, { digits: 6 })).toBe(code);
    },
  );
});

describe("TOTP — RFC 6238 Appendix B", () => {
  // The RFC's SHA-1 vectors use the 20-byte ASCII seed below.
  const seed = base32Encode(Buffer.from("12345678901234567890", "ascii"));

  const vectors: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  it.each(vectors)("t=%i gives %s", (unixSeconds, code) => {
    expect(totp(seed, { now: unixSeconds * 1000, digits: 8, algorithm: "sha1" })).toBe(code);
  });
});

describe("base32", () => {
  it("round-trips arbitrary bytes", () => {
    const input = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base32Decode(base32Encode(input)).equals(input)).toBe(true);
  });

  it("rejects characters outside the alphabet", () => {
    expect(() => base32Decode("ABC!")).toThrow(/Invalid base32/);
  });
});

describe("verifyTotp", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890", "ascii"));
  const now = 1_700_000_000_000;

  it("accepts the current code", () => {
    expect(verifyTotp(secret, totp(secret, { now }), { now })).toBe(true);
  });

  it("tolerates one step of clock drift either way", () => {
    const previous = totp(secret, { now: now - 30_000 });
    const next = totp(secret, { now: now + 30_000 });
    expect(verifyTotp(secret, previous, { now })).toBe(true);
    expect(verifyTotp(secret, next, { now })).toBe(true);
  });

  it("rejects a code two steps away", () => {
    const stale = totp(secret, { now: now - 90_000 });
    expect(verifyTotp(secret, stale, { now })).toBe(false);
  });

  it("rejects malformed input rather than throwing", () => {
    for (const bad of ["", "abcdef", "12345", "1234567", "  ", "<script>"]) {
      expect(verifyTotp(secret, bad, { now })).toBe(false);
    }
  });

  it("rejects a code from a different secret", () => {
    const other = base32Encode(Buffer.from("09876543210987654321", "ascii"));
    expect(verifyTotp(secret, totp(other, { now }), { now })).toBe(false);
  });
});

describe("otpauthUri", () => {
  it("encodes issuer and account for an authenticator app", () => {
    const uri = otpauthUri({
      secret: "JBSWY3DPEHPK3PXP",
      accountName: "director@conglomerate4u.com",
      issuer: "CAC",
    });
    expect(uri).toMatch(/^otpauth:\/\/totp\/CAC:director%40conglomerate4u\.com\?/);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=CAC");
    expect(uri).toContain("period=30");
  });
});
