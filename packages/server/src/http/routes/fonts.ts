import { createRequire } from "node:module";
import { join } from "node:path";
import type { Express, Request, Response } from "express";
import type { ServerContext } from "../../context.ts";

/**
 * Same-origin answers for troika-three-text's Unicode fallback lookups (R3 note 44). The board configures
 * `unicodeFontsURL: "/fonts/ufr"`; if any of these requests fails, troika retries against a public CDN — which the
 * CSP blocks and which would leak that someone is playing. So they must always succeed: an empty codepoint index,
 * a Latin-only font catalogue, and the local Cinzel face for any font file it asks for.
 */
export function fontRoutes(app: Express, ctx: ServerContext): void {
  const require = createRequire(join(ctx.config.webRoot, "package.json"));
  let fontFile: string | null = null;
  try {
    fontFile = require.resolve("@fontsource/cinzel/files/cinzel-latin-ext-600-normal.woff");
  } catch {
    ctx.log.warn("Cinzel .woff not found; board name plates fall back to the default face");
  }
  const json = (res: Response, body: unknown) =>
    res
      .type("application/json")
      .setHeader("Cache-Control", "public, max-age=86400")
      .send(JSON.stringify(body));

  app.get("/fonts/ufr/codepoint-index/{*splat}", (_req: Request, res: Response) => json(res, [1, {}]));
  app.get("/fonts/ufr/font-meta/{*splat}", (_req: Request, res: Response) =>
    json(res, [1, { id: "latin", typeforms: { "sans-serif": { normal: [400] } }, ranges: "" }]),
  );
  app.get("/fonts/ufr/font-files/{*splat}", (_req: Request, res: Response) => {
    if (!fontFile) return res.status(404).end();
    res.setHeader("Content-Type", "font/woff");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(fontFile);
  });
}
