import { MIN_ADMIN_PASSWORD, passwordStrength } from "@gloam/shared";
import { type FormEvent, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ApiError, get, post } from "../net/http.ts";
import { Button } from "../ui/Button.tsx";
import { TextInput } from "../ui/Field.tsx";
import { FullScreenLoader } from "../ui/FullScreenLoader.tsx";
import { LoadFailed } from "../ui/Loadable.tsx";
import { Divider, Filigree, Sparkle } from "../ui/ornaments.tsx";

const LABELS = ["Too short", "Weak", "Fair", "Strong", "Excellent"];
const TONES = [
  "var(--blood-500)",
  "var(--ember-400)",
  "var(--brass-400)",
  "var(--verdigris-400)",
  "var(--verdigris-400)",
];

/** First-run setup (SPEC §8.1): Admin password ≥ 12 characters, strength meter, confirmation. Local-only. */
export default function Setup() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const [status, setStatus] = useState<"checking" | "ready" | "invalid" | "done" | "unreachable">("checking");
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // (A link the server turned down has expired; a server that couldn't be asked is a different thing — said so, with
  // Try again, rather than calling a good link expired.)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt (Try again) asks again
  useEffect(() => {
    setStatus("checking");
    void get<{ needed: boolean; tokenValid: boolean }>(`/api/setup/status?token=${encodeURIComponent(token)}`)
      .then((r) => setStatus(!r.needed ? "done" : r.tokenValid ? "ready" : "invalid"))
      .catch((e: Error) => {
        if (e instanceof ApiError && e.code !== "NETWORK" && e.status < 500) setStatus("invalid");
        else {
          setUnreachable(e.message || null);
          setStatus("unreachable");
        }
      });
  }, [token, attempt]);

  const score = pw.length < MIN_ADMIN_PASSWORD ? 0 : passwordStrength(pw);
  const mismatch = confirm.length > 0 && confirm !== pw;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (pw.length < MIN_ADMIN_PASSWORD) return setError(`Use at least ${MIN_ADMIN_PASSWORD} characters.`);
    if (pw !== confirm) return setError("The two passwords don't match.");
    setBusy(true);
    try {
      await post("/api/setup", { token, password: pw });
      navigate("/admin", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Setup failed — try again.");
      setBusy(false);
    }
  }

  if (status === "checking") return <FullScreenLoader label="Checking the setup link…" />;

  return (
    <main className="relative grid min-h-[100dvh] place-items-center overflow-hidden bg-bg p-4">
      <div className="vignette pointer-events-none absolute inset-0" aria-hidden />
      <div className="panel relative w-full max-w-[480px] px-7 pb-8 pt-9">
        <Filigree />
        <div className="flex items-center gap-2">
          <Sparkle size={20} />
          <span className="display text-22 font-semibold tracking-[0.04em] text-bone">GLOAM</span>
        </div>
        {status === "unreachable" ? (
          <div className="mt-6">
            <LoadFailed what="the setup page" error={unreachable} retry={() => setAttempt((n) => n + 1)} />
          </div>
        ) : status === "invalid" ? (
          <div className="mt-6">
            <h1 className="text-28 text-bone">This setup link has expired</h1>
            <p className="mt-3 text-16 text-muted">
              Setup links work once, for 30 minutes, on this PC only. Stop the server (Ctrl+C) and run{" "}
              <code className="mono text-14 text-brass-bright">pnpm start</code> again for a fresh link.
            </p>
          </div>
        ) : status === "done" ? (
          <div className="mt-6">
            <h1 className="text-28 text-bone">Already set up</h1>
            <p className="mt-3 text-16 text-muted">
              The Admin password is set. Use the admin link printed in the terminal to sign in.
            </p>
            <Button className="mt-6" variant="primary" onClick={() => navigate("/admin")}>
              Go to the Admin console
            </Button>
          </div>
        ) : (
          <form className="mt-6" onSubmit={submit} noValidate>
            <h1 className="text-28 text-bone">Set the Admin password</h1>
            <p className="mt-2 text-14 text-muted">
              You'll use it to run the table from this PC. Friends never need it — they join with an invite
              code.
            </p>
            <Divider className="my-6" />
            <TextInput
              label="Password"
              type="password"
              autoComplete="new-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              data-autofocus
              autoFocus
              help={`At least ${MIN_ADMIN_PASSWORD} characters. A short sentence works well.`}
            />
            <div className="mt-2.5 flex items-center gap-3" aria-live="polite">
              <div className="flex flex-1 gap-1" aria-hidden>
                {[1, 2, 3, 4].map((i) => (
                  <span
                    key={i}
                    className="h-1.5 flex-1 rounded-full transition-colors duration-[var(--dur-base)]"
                    style={{ background: pw && score >= i ? TONES[score] : "var(--ink-700)" }}
                  />
                ))}
              </div>
              <span
                className="caps w-[84px] text-right text-12"
                style={{ color: pw ? TONES[score] : "var(--fog-400)" }}
              >
                {pw ? LABELS[score] : "Strength"}
              </span>
            </div>
            <TextInput
              className="mt-5"
              label="Confirm password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              error={mismatch ? "The two passwords don't match." : null}
            />
            {error ? (
              <p role="alert" className="mt-4 text-14 text-[var(--ember-400)]">
                {error}
              </p>
            ) : null}
            <Button type="submit" variant="primary" size="L" className="mt-6 w-full" loading={busy}>
              Set password and continue
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
