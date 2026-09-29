import { PLAYER_COLORS } from "@gloam/shared";
import { AnimatePresence, motion } from "motion/react";
import { type FormEvent, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { audio } from "../audio/engine.ts";
import { ShaderCanvas } from "../board/ambient/ShaderCanvas.tsx";
import { BACKDROP_UNIFORMS, TABLE_BACKDROP } from "../board/ambient/shaders.ts";
import { ApiError, post } from "../net/http.ts";
import { Button } from "../ui/Button.tsx";
import { ColorSwatchPicker } from "../ui/ColorSwatchPicker.tsx";
import { TextInput } from "../ui/Field.tsx";
import { Divider, Filigree, Sparkle } from "../ui/ornaments.tsx";
import { SegmentedCodeInput } from "../ui/SegmentedCodeInput.tsx";

interface ProfileOption {
  id: string;
  displayName: string;
  color: string;
  hasPin: boolean;
}

interface CodeResult {
  device: { id: string; name: string; color: string } | null;
  profiles: ProfileOption[];
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429 && err.retryAfterS) {
      const mins = Math.max(1, Math.ceil(err.retryAfterS / 60));
      return `${err.message} (about ${mins} minute${mins === 1 ? "" : "s"})`;
    }
    return err.message;
  }
  return "Something went wrong — try again.";
}

/** Invite code → identity → waiting room (SPEC §8.2, §29.1). */
export default function Join() {
  const navigate = useNavigate();
  const [step, setStep] = useState<"code" | "identity">("code");
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<CodeResult | null>(null);
  // Typing the tenth character knocks automatically; the button does too. Never send two knocks at once.
  const inFlight = useRef(false);

  async function knock(value = code) {
    if (value.length !== 10 || inFlight.current || step !== "code") return;
    inFlight.current = true;
    setBusy(true);
    setCodeError(null);
    void audio.resume();
    try {
      const r = await post<CodeResult>("/api/join/code", { code: value });
      setInfo(r);
      setStep("identity");
    } catch (err) {
      setCodeError(errorText(err));
      audio.play("error");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <main className="relative grid min-h-[100dvh] place-items-center overflow-hidden bg-bg px-4 py-10">
      <ShaderCanvas
        frag={TABLE_BACKDROP}
        uniforms={BACKDROP_UNIFORMS}
        scale={0.3}
        className="pointer-events-none absolute inset-[-4%] h-[108%] w-[108%] scale-105 blur-[7px]"
      />
      <div className="vignette pointer-events-none absolute inset-0" aria-hidden />
      <div className="panel relative w-full max-w-[440px] px-6 pb-7 pt-8 sm:px-8">
        <Filigree />
        <div className="flex items-center gap-2.5">
          <Sparkle size={24} />
          <h1 className="text-36 tracking-[0.05em] text-bone">GLOAM</h1>
        </div>
        <p className="mt-1 text-16 text-muted">A table awaits.</p>
        <AnimatePresence mode="wait" initial={false}>
          {step === "code" ? (
            <motion.form
              key="code"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2 }}
              className="mt-7"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                void knock();
              }}
            >
              <p className="caps mb-3 text-center text-12 text-fog">Invite code</p>
              <SegmentedCodeInput
                value={code}
                onChange={(v) => {
                  setCode(v);
                  setCodeError(null);
                }}
                onComplete={(v) => void knock(v)}
                label="Invite code"
                invalid={Boolean(codeError)}
                autoFocus
              />
              <div aria-live="polite" className="min-h-[22px]">
                {codeError ? (
                  <p className="mt-3 text-center text-14 text-[var(--ember-400)]">{codeError}</p>
                ) : null}
              </div>
              <Button
                type="submit"
                variant="primary"
                size="L"
                className="mt-4 w-full"
                loading={busy}
                disabled={code.length !== 10}
              >
                Knock on the door
              </Button>
              <p className="mt-3 text-center text-13 text-faint">
                Got the code from your DM? It looks like 7K2QH-9XM4D.
              </p>
            </motion.form>
          ) : info ? (
            <motion.div
              key="identity"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className="mt-6"
            >
              <IdentityStep info={info} onDone={() => navigate("/wait")} onRestart={() => setStep("code")} />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </main>
  );
}

function IdentityStep({
  info,
  onDone,
  onRestart,
}: {
  info: CodeResult;
  onDone: () => void;
  onRestart: () => void;
}) {
  const [mode, setMode] = useState<"device" | "new" | "returning">(info.device ? "device" : "new");
  const [tab, setTab] = useState<"new" | "returning">("new");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await post("/api/join/identity", body);
      onDone();
    } catch (err) {
      setError(errorText(err));
      audio.play("error");
      if (err instanceof ApiError && err.status === 403 && /code/.test(err.message)) onRestart();
    } finally {
      setBusy(false);
    }
  }

  if (mode === "device" && info.device) {
    return (
      <div className="text-center">
        <span
          className="mx-auto mb-3 block h-12 w-12 rounded-full shadow-[0_0_0_2px_var(--ink-950),0_0_0_3px_var(--brass-600)]"
          style={{ background: info.device.color }}
          aria-hidden
        />
        <h2 className="text-28 text-bone">Welcome back, {info.device.name}</h2>
        <p className="mt-1 text-14 text-muted">This browser remembers you.</p>
        {error ? (
          <p className="mt-3 text-14 text-[var(--ember-400)]" role="alert">
            {error}
          </p>
        ) : null}
        <Button
          variant="primary"
          size="L"
          className="mt-6 w-full"
          loading={busy}
          onClick={() => void submit({ mode: "device" })}
        >
          Continue
        </Button>
        <button
          type="button"
          className="mt-3 text-14 text-muted underline-offset-4 hover:text-bone hover:underline"
          onClick={() => setMode("new")}
        >
          Not you?
        </button>
      </div>
    );
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label="Who are you?"
        className="grid grid-cols-2 gap-1 rounded-[var(--radius-control)] border border-line bg-ink-900 p-1"
      >
        {(["new", "returning"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            onClick={() => {
              setTab(t);
              setError(null);
            }}
            className={`h-10 rounded-chip text-14 font-bold transition-colors ${tab === t ? "bg-raised text-brass-bright shadow-[inset_0_-2px_0_var(--brass-400)]" : "text-muted hover:text-bone"}`}
          >
            {t === "new" ? "New here" : "I've played before"}
          </button>
        ))}
      </div>
      <div className="mt-5" role="tabpanel">
        {tab === "new" ? (
          <NewProfile
            busy={busy}
            error={error}
            taken={info.profiles.map((p) => p.color.toLowerCase())}
            onSubmit={(b) => void submit({ mode: "new", ...b })}
          />
        ) : (
          <Returning
            profiles={info.profiles}
            busy={busy}
            error={error}
            onSubmit={(b) => void submit({ mode: "returning", ...b })}
          />
        )}
      </div>
    </div>
  );
}

function PinInput({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  const length = Math.min(8, Math.max(4, value.length + (value.length >= 4 && value.length < 8 ? 1 : 0)));
  return <SegmentedCodeInput kind="pin" length={length} value={value} onChange={onChange} label={label} />;
}

function NewProfile({
  busy,
  error,
  taken,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  /** Colours the table's players already have (hex): a newcomer starts on one nobody has. */
  taken: string[];
  onSubmit: (b: { name: string; color: string; pin?: string }) => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(
    () => (PLAYER_COLORS.find((c) => !taken.includes(c.hex.toLowerCase())) ?? PLAYER_COLORS[0]).id,
  );
  const [pin, setPin] = useState("");
  const nameOk = /^[\p{L}\p{M}\p{N} \-'_.]{2,24}$/u.test(name.trim());
  const pinOk = pin === "" || /^\d{4,8}$/.test(pin);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (nameOk && pinOk) onSubmit({ name: name.trim(), color, ...(pin ? { pin } : {}) });
      }}
    >
      <TextInput
        label="Your name at the table"
        value={name}
        maxLength={24}
        onChange={(e) => setName(e.target.value)}
        autoFocus
        error={name.length > 0 && !nameOk ? "2–24 letters, digits, spaces and - ' _ ." : null}
        placeholder="e.g. Dave"
      />
      <p className="caps mb-2 mt-5 text-12 text-fog">Your colour</p>
      <ColorSwatchPicker value={color} onChange={setColor} />
      <p className="caps mb-2 mt-5 text-12 text-fog">PIN (optional)</p>
      <PinInput value={pin} onChange={setPin} label="PIN" />
      <p className="mt-2 text-13 text-muted">A PIN lets you rejoin from a new link. 4–8 digits.</p>
      <Divider className="my-5" />
      {error ? (
        <p className="mb-3 text-14 text-[var(--ember-400)]" role="alert">
          {error}
        </p>
      ) : null}
      <Button
        type="submit"
        variant="primary"
        size="L"
        className="w-full"
        loading={busy}
        disabled={!nameOk || !pinOk}
      >
        Continue
      </Button>
    </form>
  );
}

function Returning({
  profiles,
  busy,
  error,
  onSubmit,
}: {
  profiles: ProfileOption[];
  busy: boolean;
  error: string | null;
  onSubmit: (b: { profileId: string; pin?: string }) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [filter, setFilter] = useState("");
  const shown = useMemo(
    () => profiles.filter((p) => p.displayName.toLowerCase().includes(filter.trim().toLowerCase())),
    [profiles, filter],
  );
  const chosen = profiles.find((p) => p.id === picked);
  if (profiles.length === 0) {
    return (
      <p className="py-6 text-center text-14 text-muted">Nobody has played here yet — choose "New here".</p>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (chosen && (!chosen.hasPin || /^\d{4,8}$/.test(pin)))
          onSubmit({ profileId: chosen.id, ...(chosen.hasPin ? { pin } : {}) });
      }}
    >
      {profiles.length > 6 ? (
        <TextInput
          label="Find your name"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="mb-3"
        />
      ) : null}
      <div
        role="radiogroup"
        aria-label="Your profile"
        className="grid max-h-[220px] gap-1.5 overflow-y-auto pr-1"
      >
        {shown.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={picked === p.id}
            onClick={() => {
              setPicked(p.id);
              setPin("");
            }}
            className={`flex h-11 items-center gap-3 rounded-[var(--radius-control)] border px-3 text-left transition-colors ${
              picked === p.id ? "border-brass bg-raised" : "border-line bg-ink-900 hover:border-line-strong"
            }`}
          >
            <span className="h-4 w-4 shrink-0 rounded-full" style={{ background: p.color }} aria-hidden />
            <span className="flex-1 truncate text-16 text-bone">{p.displayName}</span>
            <span className="caps text-12 text-faint">{p.hasPin ? "PIN" : "no PIN"}</span>
          </button>
        ))}
      </div>
      {chosen ? (
        chosen.hasPin ? (
          <div className="mt-5">
            <p className="caps mb-2 text-12 text-fog">PIN for {chosen.displayName}</p>
            <PinInput value={pin} onChange={setPin} label={`PIN for ${chosen.displayName}`} />
          </div>
        ) : (
          <p className="mt-4 rounded-[var(--radius-control)] border border-[var(--warning)] bg-[var(--warning-soft)] px-3 py-2 text-13 text-bone">
            This profile has no PIN, so the DM will see you as <strong>unverified</strong> and decide.
          </p>
        )
      ) : null}
      <Divider className="my-5" />
      {error ? (
        <p className="mb-3 text-14 text-[var(--ember-400)]" role="alert">
          {error}
        </p>
      ) : null}
      <Button
        type="submit"
        variant="primary"
        size="L"
        className="w-full"
        loading={busy}
        disabled={!chosen || (chosen.hasPin && !/^\d{4,8}$/.test(pin))}
      >
        Continue
      </Button>
    </form>
  );
}
