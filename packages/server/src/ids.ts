import { customAlphabet } from "nanoid";

/** Type-prefixed IDs: `nanoid(16)` with a prefix (SPEC §12.1). */
export type IdPrefix =
  | "cmp"
  | "scn"
  | "tok"
  | "act"
  | "wal"
  | "lgt"
  | "zon"
  | "eff"
  | "usr"
  | "ses"
  | "inv"
  | "rol"
  | "req"
  | "his"
  | "snp"
  | "hnd"
  | "log"
  | "tpl"
  | "api"
  | "ast"
  | "dev"
  | "tbs"
  | "cmb";

const nano = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ", 16);

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${nano()}`;
}

export function idPrefix(id: string): string {
  return id.split("_", 1)[0] ?? "";
}
