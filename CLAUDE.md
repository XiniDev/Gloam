# Gloam — project memory

Self-hosted 3D virtual tabletop. **Source of truth: docs/SPEC.md** (read the relevant
section before working on anything). Progress: docs/PROGRESS.md. Decisions: docs/DECISIONS.md.
Acceptance criteria: docs/FEATURES.json (never delete or reword entries; only flip `passes`
with evidence).

## Commands
- pnpm dev · pnpm build · pnpm start
- pnpm check (typecheck + lint + tests; must pass before every commit) · pnpm check:fast
- pnpm test · pnpm test:e2e · pnpm shots · pnpm bench
- pnpm content:build · pnpm features:extract · pnpm features:status --verify

## Rules that are easy to forget
- Server authority: every mutation goes through the command bus (SPEC §14); hidden info
  never reaches a player's client (SPEC §13.4, §15).
- No network at runtime: no CDNs, no Google Fonts, no drei Environment presets, no Draco
  decoder on the client (the server decodes Draco uploads), drei <Text> always with a local
  .woff font (SPEC §9.4, §24.9).
- Server TS runs natively on Node (type stripping; host has Node 22.18, target 24 LTS — see
  DECISIONS): erasableSyntaxOnly, .ts extensions in relative imports, no enums/decorators/namespaces.
- Colyseus: use @colyseus/core + ws-transport + tools + schema (not the `colyseus`
  meta-package); schema() builder; ≤ 63 fields per schema; view tags are powers of two;
  .view() collections are undefined until the first add.
- pnpm 12: build scripts need `allowBuilds` in pnpm-workspace.yaml.
- Colours, type, spacing and motion only from design tokens (SPEC §27). No banned patterns
  (SPEC §27.6).
- Every automation offers Skip/manual override (SPEC §2 P2).
- Never weaken or delete a test to make it pass.
- Windows host: use `node` scripts (not shell features) for tooling; paths via node:path.

## When compacting
Preserve: current phase and its open ACs, files modified since the last commit, failing tests
and their error messages, and any decision not yet written to DECISIONS.md.
