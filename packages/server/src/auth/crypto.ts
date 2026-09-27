import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { restrictToOwner } from "../dataDir.ts";

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** 256-bit random token, base64url (session, device, magic-link, API tokens). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Crockford base32 alphabet (no I, L, O, U). */
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 10 Crockford characters ≈ 50 bits of entropy (AC-AUTH-10). */
export function randomCrockford(length = 10): string {
  let out = "";
  for (let i = 0; i < length; i++) out += CROCKFORD[randomInt(0, 32)];
  return out;
}

/** Normalises user input: uppercase, drop separators/spaces, map the Crockford look-alikes (I,L→1, O→0). */
export function normaliseCrockford(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
}

export function formatInviteCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5, 10)}`;
}

/**
 * data/secret.key: 32 random bytes, owner-only. Encrypts the named-tunnel token (AES-256-GCM) and derives HMAC
 * keys (CSRF, signed join tickets). Losing it only invalidates CSRF tokens and the stored tunnel token (§22.8).
 */
export class SecretBox {
  private readonly key: Buffer;
  private constructor(key: Buffer) {
    this.key = key;
  }

  static loadOrCreate(path: string): SecretBox {
    if (!existsSync(path)) {
      writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" });
      restrictToOwner(path, "file");
    }
    const key = readFileSync(path);
    if (key.length !== 32) throw new Error("secret.key must contain exactly 32 bytes");
    return new SecretBox(key);
  }

  private derive(purpose: string): Buffer {
    return createHmac("sha256", this.key).update(`gloam:${purpose}`).digest();
  }

  hmac(purpose: string, data: string): string {
    return createHmac("sha256", this.derive(purpose)).update(data).digest("base64url");
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.derive("aes"), iv);
    const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${enc.toString("base64url")}`;
  }

  decrypt(box: string): string | null {
    const [v, iv, tag, enc] = box.split(".");
    if (v !== "v1" || !iv || !tag || !enc) return null;
    try {
      const d = createDecipheriv("aes-256-gcm", this.derive("aes"), Buffer.from(iv, "base64url"));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString("utf8");
    } catch {
      return null;
    }
  }

  /** Signed, expiring ticket: `<payload b64url>.<exp>.<mac>`. */
  sign(purpose: string, payload: string, ttlMs: number, now = Date.now()): string {
    const body = `${Buffer.from(payload).toString("base64url")}.${now + ttlMs}`;
    return `${body}.${this.hmac(purpose, body)}`;
  }

  verify(purpose: string, ticket: string, now = Date.now()): string | null {
    const parts = ticket.split(".");
    if (parts.length !== 3) return null;
    const [p, exp, mac] = parts as [string, string, string];
    const body = `${p}.${exp}`;
    if (!safeEqual(this.hmac(purpose, body), mac)) return null;
    if (!/^\d+$/.test(exp) || Number(exp) < now) return null;
    return Buffer.from(p, "base64url").toString("utf8");
  }
}
