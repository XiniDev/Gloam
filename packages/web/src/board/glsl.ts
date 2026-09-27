/** Shared GLSL helpers for the procedural table and floors (value noise, fbm, Voronoi). */
export const NOISE_GLSL = /* glsl */ `
float g_hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec2 g_hash2(vec2 p) { return vec2(g_hash(p), g_hash(p + 19.19)); }
float g_noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(g_hash(i), g_hash(i + vec2(1.0, 0.0)), u.x), mix(g_hash(i + vec2(0.0, 1.0)), g_hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float g_fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * g_noise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return v;
}
// Returns (distance to nearest feature point, distance to cell border, cell hash).
vec3 g_voronoi(vec2 p) {
  vec2 n = floor(p), f = fract(p);
  vec2 mg, mr; float md = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 r = g + g_hash2(n + g) - f;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; }
  }
  float border = 8.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 g = mg + vec2(float(i), float(j));
    vec2 r = g + g_hash2(n + g) - f;
    if (dot(mr - r, mr - r) > 0.00001) border = min(border, dot(0.5 * (mr + r), normalize(r - mr)));
  }
  return vec3(sqrt(md), border, g_hash(n + mg));
}
`;
