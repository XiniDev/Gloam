import { type ChildProcess, fork } from "node:child_process";
import { join } from "node:path";
import type { Logger } from "../logger.ts";
import {
  JOB_TIMEOUT_MS,
  PROCESSOR_RSS_LIMIT,
  type ProcessJob,
  type ProcessorMessage,
  type ProcessResult,
} from "./types.ts";

interface Pending {
  job: ProcessJob;
  resolve(r: ProcessResult): void;
}

const PROCESSOR_ENTRY = join(import.meta.dirname, "processor.ts");

/**
 * Parent side of the asset processor (SPEC §21.1 step 5): one child process, one job at a time. A job that times
 * out, a child whose resident memory passes 1.5 GB, or a child that dies mid-job is killed with SIGKILL; the job
 * fails with a readable reason and the next job gets a fresh process. The server itself never loads a decoder.
 */
export class AssetProcessor {
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private readonly queue: Pending[] = [];
  private current: (Pending & { timer: NodeJS.Timeout; settled: boolean; child?: ChildProcess }) | null =
    null;
  private stopped = false;
  private readonly log: Logger;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeouts: Record<"image" | "model" | "audio", number>;
  private readonly rssLimit: number;
  /** Diagnostics for tests: how many child processes were started, and the current child's pid. */
  spawned = 0;
  get pid(): number | undefined {
    return this.child?.pid;
  }

  constructor(
    log: Logger,
    opts: {
      testHooks?: boolean;
      timeoutMs?: Partial<Record<"image" | "model" | "audio", number>>;
      rssLimit?: number;
    } = {},
  ) {
    this.log = log;
    this.timeouts = { ...JOB_TIMEOUT_MS, ...opts.timeoutMs };
    this.rssLimit = opts.rssLimit ?? PROCESSOR_RSS_LIMIT;
    this.env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      NODE_ENV: process.env.NODE_ENV,
      ...(opts.testHooks ? { GLOAM_TEST_PROCESSOR_HOOKS: "1" } : {}),
    };
  }

  process(job: ProcessJob): Promise<ProcessResult> {
    if (this.stopped) return Promise.resolve({ ok: false, reason: "The server is shutting down." });
    return new Promise((resolve) => {
      this.queue.push({ job, resolve });
      void this.pump();
    });
  }

  private spawn(): Promise<void> {
    this.spawned++;
    // Only a minimal environment: the processor needs no secrets, config or network. (Its own flags, not the server's:
    // the glTF validator is compiled Dart that sets prototypes through __proto__, which the server disallows; the
    // processor walks no path a client chose.)
    const child = fork(PROCESSOR_ENTRY, [], {
      execArgv: ["--max-old-space-size=768", "--disable-warning=ExperimentalWarning"],
      env: this.env,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "advanced",
    });
    this.child = child;
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    const ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`processor did not start: ${stderr}`)), 30_000);
      child.once("message", (m: ProcessorMessage) => {
        if (m.type === "ready") {
          clearTimeout(t);
          resolve();
        }
      });
      child.once("exit", () => {
        clearTimeout(t);
        reject(new Error(`processor exited during start: ${stderr}`));
      });
    });
    child.on("message", (m: ProcessorMessage) => {
      // A killed child's late messages must never touch its successor or the next job.
      if (child !== this.child) return;
      if (m.type === "rss" && m.rss > this.rssLimit) {
        this.log.warn(
          { rss: m.rss, job: this.current?.job.id },
          "asset processor over memory limit; killing",
        );
        this.kill("This file needs more memory to process than Gloam allows.");
      } else if (m.type === "result" && this.current?.job.id === m.id) {
        this.finish(m.result);
      }
    });
    child.on("exit", (code, signal) => {
      if (this.child === child) {
        this.child = null;
        this.ready = null;
      }
      // Only the job that was running on THIS child fails (after a kill, the next job may already be running
      // on a fresh process when the old one's exit event arrives).
      if (this.current && !this.current.settled && this.current.child === child) {
        this.log.warn({ code, signal, job: this.current.job.id, stderr }, "asset processor died mid-job");
        this.finish({
          ok: false,
          reason: "Processing this file crashed the processor — it may be malformed.",
        });
      }
    });
    return ready;
  }

  private kill(reason: string): void {
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (child && child.exitCode === null) child.kill("SIGKILL");
    if (this.current && !this.current.settled) this.finish({ ok: false, reason });
  }

  private finish(result: ProcessResult): void {
    const cur = this.current;
    if (!cur || cur.settled) return;
    cur.settled = true;
    clearTimeout(cur.timer);
    this.current = null;
    cur.resolve(result);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.current || this.stopped) return;
    const next = this.queue.shift();
    if (!next) return;
    const cur = {
      ...next,
      timer: undefined as unknown as NodeJS.Timeout,
      settled: false,
      child: undefined as ChildProcess | undefined,
    };
    this.current = cur;
    try {
      if (!this.child) this.ready = this.spawn();
      await this.ready;
    } catch (err) {
      this.log.error({ err }, "asset processor failed to start");
      this.finish({ ok: false, reason: "The file processor couldn't start." });
      return;
    }
    if (this.current !== cur || cur.settled) return;
    // The clock runs from when the job reaches a ready processor (starting one takes about a second).
    cur.timer = setTimeout(
      () => this.kill("Processing this file took too long — it may be malformed or too complex."),
      this.timeouts[next.job.cls],
    );
    cur.child = this.child ?? undefined;
    this.child?.send({ type: "job", job: next.job });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const p of this.queue.splice(0)) p.resolve({ ok: false, reason: "The server is shutting down." });
    this.kill("The server is shutting down.");
  }
}
