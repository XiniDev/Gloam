import { Settings, Volume2, VolumeX } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { Channel } from "../audio/engine.ts";
import { TIERS, type TierName, useTier } from "../board/tiers.ts";
import { useTable } from "../net/table.ts";
import { type DeviceSettings, useSettings } from "../state/settings.ts";
import { IconButton } from "../ui/Button.tsx";
import { Segmented, Slider, Toggle } from "../ui/controls.tsx";

const CHANNEL_LABEL: Record<Channel, string> = {
  master: "Master",
  dice: "Dice",
  effects: "Effects",
  ui: "Interface",
  music: "Music",
  ambience: "Ambience",
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 border-t border-[var(--line-soft)] px-4 py-3 first:border-t-0">
      <h3 className="caps text-12 text-brass">{title}</h3>
      {children}
    </section>
  );
}

function Volume({ c }: { c: Channel }) {
  const v = useSettings((s) => s.volumes[c]);
  const muted = useSettings((s) => s.channelMuted[c]);
  const update = useSettings((s) => s.update);
  const set = (patch: Partial<Pick<DeviceSettings, "volumes" | "channelMuted">>) => update(patch);
  return (
    <div className="grid grid-cols-[76px_1fr_32px] items-center gap-2">
      <span className="text-13 text-muted">{CHANNEL_LABEL[c]}</span>
      <Slider
        label={`${CHANNEL_LABEL[c]} volume`}
        value={v}
        disabled={muted}
        onChange={(n) => set({ volumes: { ...useSettings.getState().volumes, [c]: n } })}
      />
      <button
        type="button"
        aria-label={muted ? `Unmute ${CHANNEL_LABEL[c]}` : `Mute ${CHANNEL_LABEL[c]}`}
        aria-pressed={muted}
        onClick={() => set({ channelMuted: { ...useSettings.getState().channelMuted, [c]: !muted } })}
        className="grid h-8 w-8 place-items-center rounded-[var(--radius-control)] text-muted hover:bg-raised hover:text-bone"
      >
        {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
      </button>
    </div>
  );
}

const TIER_LABEL: Record<TierName, string> = { ultra: "Ultra", high: "High", medium: "Medium", low: "Low" };

/**
 * The per-device settings popover (SPEC §8.22): volumes, graphics tier, interface size, motion, colour-blind palette
 * and the DM camera opt-out. Stored in this browser only. Settings for features of later phases join them there.
 */
export function SettingsPopover() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const s = useSettings();
  const tier = useTier((t) => t.name);
  const role = useTable((t) => t.me?.role);
  const dm = role === "dm" || role === "admin";

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("button, input")?.focus();
    const onDown = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative">
      <IconButton
        ref={button}
        label="Settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <Settings size={18} />
      </IconButton>
      {open ? (
        <div
          ref={panel}
          id={id}
          role="dialog"
          aria-label="Settings"
          className="panel absolute right-0 top-full z-50 mt-2 flex max-h-[calc(100dvh-80px)] w-[min(340px,calc(100vw-24px))] flex-col overflow-y-auto"
        >
          <Section title="Sound">
            {(["master", "dice", "effects", "ui", "music", "ambience"] as const).map((c) => (
              <Volume key={c} c={c} />
            ))}
          </Section>
          <Section title="Graphics">
            <Segmented<DeviceSettings["tier"]>
              label="Graphics quality"
              size="S"
              value={s.tier}
              onChange={(t) => s.update({ tier: t })}
              options={[
                { value: "auto", label: "Auto" },
                ...(Object.keys(TIERS) as TierName[]).map((t) => ({ value: t, label: TIER_LABEL[t] })),
              ]}
            />
            <p className="text-12 text-faint" data-testid="tier-readout">
              {s.tier === "auto"
                ? `Auto picks for this device — now ${TIER_LABEL[tier]}.`
                : `Pinned to ${TIER_LABEL[tier]}. Low turns off shadows, bloom and ambient occlusion.`}
            </p>
          </Section>
          <Section title="Interface">
            <div className="grid grid-cols-[76px_1fr] items-center gap-2">
              <span className="text-13 text-muted">Size</span>
              <Slider
                label="Interface size"
                min={0.9}
                max={1.3}
                step={0.05}
                value={s.uiScale}
                onChange={(uiScale) => s.update({ uiScale })}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-13 text-muted">Motion</span>
              <Segmented<DeviceSettings["motion"]>
                label="Motion"
                size="S"
                value={s.motion}
                onChange={(motion) => s.update({ motion })}
                options={[
                  { value: "system", label: "System" },
                  { value: "full", label: "Full" },
                  { value: "reduced", label: "Reduced" },
                ]}
              />
            </div>
            <Toggle
              label="Colour-blind palette"
              description="Okabe–Ito colours for HP and dispositions, with stripes for low HP."
              checked={s.colorBlind}
              onChange={(colorBlind) => s.update({ colorBlind })}
            />
          </Section>
          {!dm ? (
            <Section title="Camera">
              <Toggle
                label="Let the DM move my camera"
                description="The DM's Spotlight can pull your view to a spot on the map."
                checked={s.dmCanMoveCamera}
                onChange={(dmCanMoveCamera) => s.update({ dmCanMoveCamera })}
              />
            </Section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
