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
  | "prm"
  | "his"
  | "snp"
  | "hnd"
  | "log"
  | "tpl"
  | "blk"
  | "prp"
  | "api"
  | "ast"
  | "dev"
  | "tbs"
  | "cmb"
  | "job";

const nano = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ", 16);

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${nano()}`;
}

export function idPrefix(id: string): string {
  return id.split("_", 1)[0] ?? "";
}
