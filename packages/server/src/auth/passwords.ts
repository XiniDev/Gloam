import { hash, verify } from "@node-rs/argon2";

/**
 * argon2id with @node-rs/argon2 defaults (m = 19 456 KiB, t = 2, p = 1) — SPEC §22.2. The library defaults are
 * exactly the spec parameters (verified by R3); its const enums can't be imported under verbatimModuleSyntax.
 */

export function hashSecret(plain: string): Promise<string> {
  return hash(plain);
}

export async function verifySecret(hashValue: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashValue, plain);
  } catch {
    return false;
  }
}

/** Rough strength estimate for the setup meter (0–4). The hard rule is length ≥ 12 (SPEC §8.1). */
export function passwordStrength(pw: string): number {
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/\d/.test(pw)) classes++;
  if (/[^A-Za-z0-9]/.test(pw)) classes++;
  const unique = new Set(pw).size;
  let score = 0;
  if (pw.length >= 12) score++;
  if (pw.length >= 16) score++;
  if (classes >= 3) score++;
  if (unique >= 10 && pw.length >= 14) score++;
  return Math.min(4, score);
}
