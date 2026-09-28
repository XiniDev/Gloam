/**
 * Seeded dice for tests (SPEC §18.2: `GLOAM_TEST_SEED` in test mode only): xoshiro128** seeded through splitmix32,
 * with rejection sampling so every face is exactly equally likely. Production rolls use `crypto.randomInt` on the
 * server; this module never decides a real roll.
 */

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/** xoshiro128**: uniform 32-bit integers. */
export function xoshiro128ss(seed: number): () => number {
  const init = splitmix32(seed);
  let a = init();
  let b = init();
  let c = init();
  let d = init();
  if ((a | b | c | d) === 0) a = 1;
  return () => {
    const r = Math.imul(rotl(Math.imul(b, 5) >>> 0, 7), 9) >>> 0;
    const t = (b << 9) >>> 0;
    c ^= a;
    d ^= b;
    b ^= c;
    a ^= d;
    c ^= t;
    d = rotl(d >>> 0, 11);
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    return r;
  };
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** A die from 32-bit integers: 1..sides, uniform (rejects the uneven top of the range). */
export function dieFrom(next: () => number): (sides: number) => number {
  return (sides) => {
    const limit = 2 ** 32 - (2 ** 32 % sides);
    for (;;) {
      const v = next();
      if (v < limit) return (v % sides) + 1;
    }
  };
}

/** A seeded die (tests and `GLOAM_TEST_SEED`). */
export function seededDie(seed: number): (sides: number) => number {
  return dieFrom(xoshiro128ss(seed));
}
