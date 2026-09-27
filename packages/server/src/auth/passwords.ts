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

export { passwordStrength } from "@gloam/shared";
