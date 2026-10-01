import { Settings, Volume2, VolumeX, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import type { Channel } from "../audio/engine.ts";
import { TIERS, type TierName, useTier } from "../board/tiers.ts";
import { useTable } from "../net/table.ts";
import { type DeviceSettings, useSettings } from "../state/settings.ts";
import { useUi } from "../state/ui.ts";
import { BottomSheet } from "../ui/BottomSheet.tsx";
import { Button, IconButton } from "../ui/Button.tsx";
import { Segmented, Slider, Toggle } from "../ui/controls.tsx";
import { ScrollFade } from "../ui/ScrollFade.tsx";
import { DiceSkinPicker } from "./DiceSkinPicker.tsx";
import { useBoardCovers, useHudInsets, useIsPhone, useObstacle } from "./insets.ts";
import { COLUMN, EDGE, placeSettings, TOP } from "./settingsPlace.ts";

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

  const rail = useBoardCovers((c) => c.rects["dock-rail"]);
  const panelBox = useBoardCovers((c) => c.rects["dock-panel"]);
  const tools = useHudInsets((h) => h.left);
  const [place, setPlace] = useState<ReturnType<typeof placeSettings> | null>(null);
  useLayoutEffect(() => {
    if (!open || phone) return;
    const update = () => {
      const g = button.current?.getBoundingClientRect();
      // (The covers are measured with a 4-px margin: the panel's own box for standing exactly in its place.)
      const panel = panelBox && {
        left: panelBox.left + 4,
        top: panelBox.top + 4,
        right: panelBox.right - 4,
        bottom: panelBox.bottom - 4,
      };
      if (g)
        setPlace(placeSettings(g, { rail, panel, tools }, { w: window.innerWidth, h: window.innerHeight }));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [open, phone, rail, panelBox, tools]);
  const inPanel = Boolean(open && !phone && place?.inPanel);
  useEffect(() => {
    useUi.getState().set({ settingsInPanel: inPanel });
    return () => useUi.getState().set({ settingsInPanel: false });
  }, [inPanel]);

  const camera = !dm ? (
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
  ) : null;
  const dice =
    role !== "spectator" ? (
      <Section title="Your dice">
        <DiceSkinPicker />
      </Section>
    ) : null;
  const sound = (
    <Section title="Sound">
      {(["master", "dice", "effects", "ui", "music", "ambience"] as const).map((c) => (
        <Volume key={c} c={c} />
      ))}
    </Section>
  );
  const graphics = (
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
  );
  const iface = (
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
  );
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
      {camera}
      {dice}
      {sound}
      {graphics}
      {iface}
    </>
  );
  // A wide screen's two columns — the camera, the dice and the graphics; the sound and the interface — each read top
  // to bottom: all of it in view, nothing to scroll (critic RSP-01 r1: the last rows sat below the fold at 1440 × 900).
  const twoColumns = (
    <div className="grid grid-cols-2 divide-x divide-[var(--line-soft)]">
      <div className="flex min-w-0 flex-col">
        {camera}
        {dice}
        {graphics}
      </div>
      <div className="flex min-w-0 flex-col">
        {sound}
        {iface}
      </div>
    </div>
  );
  return (
    <div className="relative">
      <IconButton
        ref={button}
        label="Settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        // Pressed while open, wherever the popover stands (critic RSP-01 r2: not in the panel's place at 768 and 844).
        active={open}
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
            data-testid="settings-popover"
            data-columns={place?.columns ?? 1}
            // Under its gear (placeSettings); hidden for the one frame before it's measured. The dice come to rest
            // clear of it. On the page itself: the top bar's backdrop filter would otherwise be its frame.
            className={`panel fixed z-50 flex flex-col overflow-hidden outline-none ${place ? "" : "invisible"}`}
            style={
              place
                ? { left: place.left, top: place.top, width: place.width, maxHeight: place.maxHeight }
                : { left: EDGE, top: TOP, width: COLUMN }
            }
          >
            {/* In the panel's place, titled as the panels there are (critic RSP-01 r2: the only one without a name). */}
            {place?.inPanel ? (
              <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
                <Settings size={18} className="shrink-0 text-brass" aria-hidden />
                <h2 className="flex-1 text-18 text-bone">Settings</h2>
                <IconButton label="Close settings" onClick={() => setOpen(false)}>
                  <X size={18} />
                </IconButton>
              </header>
            ) : null}
            {/* Taller than the screen: its edges fade where there's more (never a toggle sliced in half). */}
            <ScrollFade testId="settings-more-below">
              {place?.columns === 2 ? twoColumns : content}
            </ScrollFade>
          </div>,
          document.body,
        )
      ) : null}
    </div>
  );
}
