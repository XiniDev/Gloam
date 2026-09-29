import { Settings, Volume2, VolumeX, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import type { Channel } from "../audio/engine.ts";
import { TIERS, type TierName, useTier } from "../board/tiers.ts";
import { useTable } from "../net/table.ts";
import { type DeviceSettings, useSettings } from "../state/settings.ts";
import { BottomSheet } from "../ui/BottomSheet.tsx";
import { Button, IconButton } from "../ui/Button.tsx";
import { Segmented, Slider, Toggle } from "../ui/controls.tsx";
import { ScrollFade } from "../ui/ScrollFade.tsx";
import { DiceSkinPicker } from "./DiceSkinPicker.tsx";
import { useHudInsets, useIsPhone, useObstacle } from "./insets.ts";

export const CHANNEL_LABEL: Record<Channel, string> = {
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

export function Volume({ c }: { c: Channel }) {
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
  const phone = useIsPhone();
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    // Focus the panel itself (Tab reaches every control; focusing a slider would pop its value bubble).
    panel.current?.focus();
    // A popover closes when you press elsewhere; a phone's bottom sheet has its Close (its handle is outside the
    // content, and the board above it stays in play).
    const onDown = (e: PointerEvent) => {
      if (phone) return;
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
  }, [open, phone]);
  useObstacle("settings", panel, open && !phone);

  const dockEdge = useHudInsets((h) => h.right);
  const place = { right: Math.max(12, dockEdge), top: 64 };
  const content = (
    <>
      {phone && role === "admin" ? (
        // On a phone the top bar has no room for it (TopBar).
        <Section title="Host">
          <Button variant="secondary" onClick={() => navigate("/admin")}>
            Admin console
          </Button>
        </Section>
      ) : null}
      {/* The camera first: two short switches, the one a turn in combat is about in view on a phone without a scroll
          (critic P8 r2 I7) — the dice's materials below them. */}
      {!dm ? (
        <Section title="Camera">
          <Toggle
            label="Let the DM move my camera"
            description="The DM's Spotlight can pull your view to a spot on the map."
            checked={s.dmCanMoveCamera}
            onChange={(dmCanMoveCamera) => s.update({ dmCanMoveCamera })}
          />
          <Toggle
            label="Focus camera on my turn"
            description="In combat, the view glides to your creature as its turn begins."
            checked={s.focusOnMyTurn}
            onChange={(focusOnMyTurn) => s.update({ focusOnMyTurn })}
          />
        </Section>
      ) : null}
      {role !== "spectator" ? (
        <Section title="Your dice">
          <DiceSkinPicker />
        </Section>
      ) : null}
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
        <div className="grid grid-cols-[76px_1fr_40px] items-center gap-2">
          <span className="text-13 text-muted">Size</span>
          <Slider
            label="Interface size"
            min={0.9}
            max={1.3}
            step={0.05}
            value={s.uiScale}
            onChange={(uiScale) => s.update({ uiScale })}
          />
          <span className="tabular text-right text-13 text-muted">{Math.round(s.uiScale * 100)}%</span>
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
    </>
  );
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
      {open && phone ? (
        <BottomSheet
          label="Settings"
          testId="settings-sheet"
          initialSnap={1}
          header={
            <header className="flex w-full items-center justify-between pb-1 pl-1">
              <h2 className="caps text-12 text-fog">Settings</h2>
              <IconButton label="Close settings" onClick={() => setOpen(false)}>
                <X size={18} />
              </IconButton>
            </header>
          }
        >
          <div ref={panel} id={id} role="dialog" aria-label="Settings" tabIndex={-1} className="outline-none">
            {content}
          </div>
        </BottomSheet>
      ) : open ? (
        createPortal(
          <div
            ref={panel}
            id={id}
            role="dialog"
            aria-label="Settings"
            tabIndex={-1}
            // Beside the dock's rail: over nothing it would half-hide (a rail button showing at its rounded corner read
            // as a glitch). The dice come to rest clear of it. On the page itself: the top bar's backdrop filter would
            // otherwise be its frame.
            className="panel fixed z-50 flex w-[min(340px,calc(100vw-24px))] flex-col overflow-hidden outline-none"
            style={{ right: place.right, top: place.top, maxHeight: `calc(100dvh - ${place.top + 16}px)` }}
          >
            {/* Taller than the screen: its edges fade where there's more (never a toggle sliced in half). */}
            <ScrollFade testId="settings-more-below">{content}</ScrollFade>
          </div>,
          document.body,
        )
      ) : null}
    </div>
  );
}
