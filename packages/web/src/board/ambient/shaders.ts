import { BOARD_COLORS } from "@gloam/shared";

/** "#RRGGBB" → linear-ish vec3 for shader uniforms (colours come from the shared constants, SPEC §27.2). */
export function vec3Of(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const NOISE = `
float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),u.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x), u.y); }
float fbm(vec2 p){ float v=0.0, a=0.5; for(int i=0;i<5;i++){ v+=a*noise(p); p=p*2.03+vec2(1.7,9.2); a*=0.5; } return v; }
`;

/**
 * Join-page backdrop: a candle-lit oak table with a map sheet on it, slowly panning, rendered soft (the canvas
 * is low-res and CSS-blurred) — "a blurred, slowly panning render of a candle-lit board" (SPEC §29.1).
 */
export const TABLE_BACKDROP = `
uniform float uTime; uniform vec2 uRes; uniform vec3 uWood; uniform vec3 uWoodDark; uniform vec3 uPaper; uniform vec3 uInk;
uniform vec3 uCandle; uniform vec3 uVoid;
${NOISE}
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (gl_FragCoord.xy - 0.5*uRes) / uRes.y;
  vec2 pan = vec2(sin(uTime*0.021)*0.35, cos(uTime*0.017)*0.2);
  vec2 q = p*2.2 + pan;
  // oak: long rings with grain
  float rings = fbm(vec2(q.x*0.6, q.y*6.0)) ;
  float grain = noise(vec2(q.x*40.0, q.y*3.0));
  vec3 wood = mix(uWoodDark, uWood, smoothstep(0.25, 0.8, rings + grain*0.15));
  // a map sheet lying on the table
  vec2 m = q - vec2(0.2, -0.05);
  float sheet = step(abs(m.x), 0.95) * step(abs(m.y), 0.62);
  float edge = fbm(m*9.0)*0.05;
  sheet *= smoothstep(0.0, 0.02, 0.95 - abs(m.x) - edge) * smoothstep(0.0, 0.02, 0.62 - abs(m.y) - edge);
  float corridors = smoothstep(0.52, 0.5, fbm(m*3.3 + 4.0)) * 0.55;
  float lines = smoothstep(0.015, 0.0, abs(fract(fbm(m*5.0)*6.0) - 0.5) - 0.47) * 0.25;
  vec3 paper = mix(uPaper, uInk, corridors*0.35 + lines);
  vec3 col = mix(wood, paper, sheet*0.92);
  // candle glow with flicker
  vec2 c = p - vec2(-0.55 + pan.x*0.2, 0.18);
  float flick = 0.85 + 0.15*noise(vec2(uTime*3.1, 1.3));
  float glow = exp(-dot(c,c)*3.2) * flick;
  col *= 0.18 + glow*1.25;
  col += uCandle * glow * 0.28;
  // deep darkness at the edges
  float vig = smoothstep(1.25, 0.25, length(p*vec2(0.9,1.1)));
  col = mix(uVoid, col, vig);
  gl_FragColor = vec4(col, 1.0);
}`;

/** Waiting-room candle flame (SPEC §29.2 "a single animated candle"): transparent outside the flame. */
export const CANDLE_FLAME = `
uniform float uTime; uniform vec2 uRes; uniform vec3 uCore; uniform vec3 uOuter; uniform vec3 uBlue;
${NOISE}
void main(){
  vec2 p = (gl_FragCoord.xy - vec2(0.5*uRes.x, 0.18*uRes.y)) / uRes.y;
  float t = uTime;
  float sway = (noise(vec2(t*1.3, 0.0)) - 0.5) * 0.06 * p.y * 2.0;
  vec2 q = p - vec2(sway, 0.0);
  q.x += (fbm(vec2(q.y*6.0 - t*2.4, t*0.7)) - 0.5) * 0.05 * smoothstep(0.0, 0.5, q.y);
  float h = 0.52 + 0.04*sin(t*7.0) + 0.03*noise(vec2(t*5.0, 3.0));
  float w = 0.085 * (1.0 - smoothstep(0.0, h, q.y)) * smoothstep(-0.05, 0.05, q.y + 0.02);
  float d = abs(q.x) / max(w, 1e-4);
  float shape = smoothstep(1.0, 0.55, d) * step(-0.03, q.y) * step(q.y, h);
  float core = smoothstep(0.6, 0.0, d) * smoothstep(h*0.8, 0.05, q.y);
  vec3 col = mix(uOuter, uCore, core);
  col = mix(col, uBlue, smoothstep(0.06, -0.02, q.y) * shape * 0.6);
  // The halo fades out before the canvas edges, so the glow never ends in a hard line (the canvas is small).
  vec2 uv = gl_FragCoord.xy / uRes;
  float edge = smoothstep(0.0, 0.3, uv.x) * smoothstep(1.0, 0.7, uv.x) * smoothstep(0.0, 0.12, uv.y) * smoothstep(1.0, 0.75, uv.y);
  float halo = exp(-dot(p - vec2(0.0, 0.2), p - vec2(0.0, 0.2)) * 12.0) * 0.35 * edge;
  float a = clamp(shape + halo, 0.0, 1.0);
  gl_FragColor = vec4((col*shape + uOuter*halo) , a);
}`;

export const BACKDROP_UNIFORMS = {
  uWood: vec3Of(BOARD_COLORS.oak),
  uWoodDark: vec3Of(BOARD_COLORS.oakDark),
  uPaper: vec3Of(BOARD_COLORS.mapPaper),
  uInk: vec3Of(BOARD_COLORS.mapInk),
  uCandle: vec3Of(BOARD_COLORS.candle),
  uVoid: vec3Of(BOARD_COLORS.ink950),
};

export const FLAME_UNIFORMS = {
  uCore: vec3Of(BOARD_COLORS.flameCore),
  uOuter: vec3Of(BOARD_COLORS.flameOuter),
  uBlue: vec3Of(BOARD_COLORS.flameBlue),
};
