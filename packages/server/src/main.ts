/**
 * Entry point for `pnpm start` (--production) and `pnpm dev` (--dev). Sets NODE_ENV before anything that reads
 * it is imported (cross-platform; `NODE_ENV=… node` doesn't work in cmd.exe), then starts the server and wires
 * SIGINT/SIGTERM/uncaughtException to the graceful shutdown (SPEC §8.1, §11).
 */
export {};

const argv = process.argv.slice(2);
if (argv.includes("--production")) process.env.NODE_ENV = "production";
else if (argv.includes("--dev"))
  process.env.NODE_ENV = process.env.NODE_ENV === "test" ? "test" : "development";

const { startServer } = await import("./server.ts");
const { ConfigError } = await import("./config.ts");
const { testBlackout } = await import("./testHooks.ts");

let gloam: Awaited<ReturnType<typeof startServer>>;
try {
  gloam = await startServer();
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`\n${err.message}\n\n`);
    process.exit(78);
  }
  const code = (err as { code?: string }).code;
  if (code === "EADDRINUSE") {
    process.stderr.write("\nPort is already in use. Start on another port, e.g.  PORT=4750 pnpm start\n\n");
    process.exit(98);
  }
  throw err;
}

let stopping = false;
async function stop(reason: string, exitCode: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  // Hard limit: exit within 10 s whatever happens (SPEC §8.1).
  setTimeout(() => process.exit(exitCode), 10_000).unref();
  try {
    await gloam.shutdown(reason);
  } finally {
    process.exit(exitCode);
  }
}
process.on("SIGINT", () => void stop("SIGINT", 0));
process.on("SIGTERM", () => void stop("SIGTERM", 0));
if (process.env.NODE_ENV === "test" && typeof process.send === "function") {
  process.send({ type: "gloam:ready", port: gloam.port, bootstrapLink: gloam.bootstrapLink });
}

// Test mode only: Windows can't deliver SIGINT/SIGTERM to another process gracefully (kill = TerminateProcess),
// so the E2E harness sends the signal name over IPC and we raise the same event the OS would.
if (process.env.NODE_ENV === "test" && typeof process.send === "function") {
  process.on("message", (m) => {
    if (m === "SIGINT" || m === "SIGTERM") process.emit(m, m);
    // A dropped connection (AC-AUTH-07): cut a user's sockets without a close handshake, as a network loss would.
    if (typeof m === "object" && m && (m as { type?: string }).type === "gloam:drop") {
      const userId = (m as { userId?: string }).userId;
      for (const room of gloam.ctx.rooms.tables.values())
        for (const c of (
          room as unknown as {
            clients: Iterable<{ auth?: { userId?: string }; ref?: { terminate?(): void } }>;
          }
        ).clients)
          if (c.auth?.userId === userId) c.ref?.terminate?.();
    }
    // The host gone a while and back (AC-PER-06): every table connection cut, none accepted for `ms`.
    if (typeof m === "object" && m && (m as { type?: string }).type === "gloam:blackout") {
      testBlackout.until = Date.now() + Number((m as { ms?: number }).ms ?? 0);
      for (const room of gloam.ctx.rooms.tables.values())
        for (const c of (room as unknown as { clients: Iterable<{ ref?: { terminate?(): void } }> }).clients)
          c.ref?.terminate?.();
    }
  });
}
process.on("uncaughtException", (err) => {
  gloam.ctx.log.fatal({ err }, "uncaught exception");
  void stop("uncaughtException", 1);
});

if (argv.includes("--open")) {
  const mode = gloam.ctx.settings.get().tunnelMode;
  try {
    const status = await gloam.ctx.table.open(mode, { confirmLan: gloam.ctx.settings.get().lanConfirmed });
    process.stdout.write(
      `  Table OPEN (${mode}) at ${status.publicUrl}  code ${status.invite?.display ?? ""}\n\n`,
    );
  } catch (err) {
    process.stdout.write(`  Could not open the table: ${(err as Error).message}\n\n`);
  }
}
