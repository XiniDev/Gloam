import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { watchSoundCues } from "../audio/cues.ts";
import { ActionBar } from "../hud/ActionBar.tsx";
import { TurnBanner } from "../hud/combat/TurnBanner.tsx";
import { TurnTracker } from "../hud/combat/TurnTracker.tsx";
import { useCombatKeys } from "../hud/combat/useCombatKeys.ts";
import { DiceTray } from "../hud/DiceTray.tsx";
import { Dock } from "../hud/Dock.tsx";
import { JumpTo } from "../hud/dm/JumpTo.tsx";
import { MapToolsPanel } from "../hud/dm/MapToolsPanel.tsx";
import { NewSceneWizard } from "../hud/dm/NewSceneWizard.tsx";
import { TokenSettingsDialog } from "../hud/dm/TokenSettingsDialog.tsx";
import { EmoteLayer } from "../hud/EmoteLayer.tsx";
import { EmoteWheel } from "../hud/EmoteWheel.tsx";
import { FloatingCards } from "../hud/FloatingCards.tsx";
import { FogPanel } from "../hud/FogPanel.tsx";
import { HoverCard } from "../hud/HoverCard.tsx";
import { HpNumbers } from "../hud/HpNumbers.tsx";
import { HpDialog } from "../hud/health/HpDialog.tsx";
import { StatusPicker } from "../hud/health/StatusPicker.tsx";
import { Intro, useIntro } from "../hud/Intro.tsx";
import { useHudInsets } from "../hud/insets.ts";
import { HandoutReveal } from "../hud/journal/HandoutReveal.tsx";
import { dismissKnockCard, showKnockCard } from "../hud/KnockCards.tsx";
import { LeftToolbar } from "../hud/LeftToolbar.tsx";
import { LightsPanel } from "../hud/LightsPanel.tsx";
import { LoadingBar } from "../hud/LoadingBar.tsx";
import { MeasureLabels } from "../hud/MeasureLabels.tsx";
import { MeasurePanel } from "../hud/MeasurePanel.tsx";
import { MoveLabel } from "../hud/MoveLabel.tsx";
import { PhoneTabBar } from "../hud/PhoneTabBar.tsx";
import { PrepBanner } from "../hud/PrepBanner.tsx";
import { QuickUnitDialog } from "../hud/QuickUnitDialog.tsx";
import { RadialMenu } from "../hud/RadialMenu.tsx";
import { RollFeed } from "../hud/RollFeed.tsx";
import { SceneTransition } from "../hud/SceneTransition.tsx";
import { watchPendingArt } from "../hud/sheet/art.ts";
import { CastDialogHost } from "../hud/spells/CastDialog.tsx";
import { EffectChip } from "../hud/spells/EffectChip.tsx";
import { TargetingBar } from "../hud/spells/TargetingBar.tsx";
import { TopBar } from "../hud/TopBar.tsx";
import { useUndoKeys } from "../hud/useUndoKeys.ts";
import { ViewAsBanner } from "../hud/ViewAsBanner.tsx";
import { WallChips } from "../hud/WallChips.tsx";
import { WallsPanel } from "../hud/WallsPanel.tsx";
import { ZoneEditor, ZonesPanel } from "../hud/ZonesPanel.tsx";
import { watchActAs } from "../net/actAs.ts";
import { watchAudio } from "../net/audio.ts";
import { watchClock } from "../net/clock.ts";
import { joinErrorCode } from "../net/colyseus.ts";
import { watchCombat } from "../net/combat.ts";
import { watchDice } from "../net/dice.ts";
import { watchFog } from "../net/fog.ts";
import { watchFun } from "../net/fun.ts";
import { watchHealth } from "../net/health.ts";
import { watchSheets } from "../net/sheets.ts";
import { watchSpells } from "../net/spells.ts";
import { connectTable, disconnectTable, request, tableEvents, useTable } from "../net/table.ts";
import { useSession } from "../state/session.ts";
import { useUi } from "../state/ui.ts";
import { ConnectionBanner } from "../ui/ConnectionBanner.tsx";
import { FullScreenLoader } from "../ui/FullScreenLoader.tsx";
import { LoadFailed } from "../ui/Loadable.tsx";
import { toast } from "../ui/Toast.tsx";
import { TableStage } from "./TableStage.tsx";

/** `/table` — the board and HUD for admitted players, DMs and the Admin (SPEC §23.1, §29.3). */
export default function TableRoute() {
  const navigate = useNavigate();
  const refresh = useSession((s) => s.refresh);
  const connection = useTable((s) => s.connection);
  const me = useTable((s) => s.me);
  const introPhase = useIntro((s) => s.phase);
  useUndoKeys();
  useCombatKeys();
  const introReduced = useIntro((s) => s.reduced);
  // While the table is up, overlays that float over the HUD (toasts) keep clear of the dock.
  useEffect(() => {
    useHudInsets.getState().set({ active: true });
    return () => useHudInsets.getState().set({ active: false });
  }, []);
  // The fog of the active scene: a snapshot whenever the scene or its fog mode changes, then patches (SPEC §15.8).
  useEffect(() => watchFog(), []);
  useEffect(() => watchDice(), []);
  useEffect(() => watchSheets(), []);
  useEffect(() => watchHealth(), []);
  useEffect(() => watchCombat(), []);
  useEffect(() => watchSoundCues(), []);
  useEffect(() => watchClock(), []);
  useEffect(() => watchAudio(), []);
  useEffect(() => watchFun(), []);
  useEffect(() => watchActAs(), []);
  useEffect(() => watchSpells(), []);
  useEffect(() => watchPendingArt(), []);
  // The first join failing for a reason other than a closed table or a lost seat: said, with Try again (AC-DS-05) —
  // the candle waiting forever said nothing.
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt (Try again) joins again
  useEffect(() => {
    let cancelled = false;
    const offs: (() => void)[] = [];
    void (async () => {
      const m = await refresh();
      if (cancelled) return;
      if (!m?.authenticated) return navigate("/join", { replace: true });
      const campaignId = m.table.campaignId ?? m.campaignId;
      if (!campaignId) return navigate(m.session?.kind === "admin" ? "/admin" : "/join", { replace: true });
      if (m.session?.kind === "player" && m.session.status !== "admitted")
        return navigate("/wait", { replace: true });
      // (Declared before the listeners: `tableEvents.on` replays a buffered event at once — a stale "left" from the
      // page before ran the listener while this was still in its dead zone, and the table never set up.)
      const rejoin = async (attempt: number): Promise<void> => {
        await new Promise((r) => setTimeout(r, Math.min(10_000, 1000 * 2 ** attempt)));
        if (cancelled || useTable.getState().room) return;
        try {
          await connectTable(campaignId);
        } catch (err) {
          if (cancelled) return;
          const code = joinErrorCode(err);
          // A seat that didn't survive (a player's session ended with the table): knock again.
          if (code === "FORBIDDEN" || code === "UNAUTHENTICATED") navigate("/join", { replace: true });
          else void rejoin(attempt + 1);
        }
      };
      // Subscribed before (re)joining; events that arrived during the waiting room's dissolve are replayed.
      offs.push(
        tableEvents.on("knock", (k) => {
          const role = useTable.getState().me?.role;
          showKnockCard(
            k,
            async (sessionId, decision) => {
              try {
                await request("lobby.decide", { sessionId, decision });
              } catch (e) {
                toast.danger("Couldn't do that", (e as Error).message);
              }
            },
            role === "admin",
          );
        }),
        tableEvents.on("knock.resolved", (r) => dismissKnockCard(r.sessionId)),
        tableEvents.on("kicked", (k) => {
          toast.warning("Back to the waiting room", k.message);
          navigate("/wait", { replace: true });
        }),
        tableEvents.on("banned", () => navigate("/closed", { replace: true })),
        tableEvents.on("closing", () => {
          if (useTable.getState().me?.role !== "admin") navigate("/closed", { replace: true });
          else toast.info("The table is closed", "Players have been shown the closed screen.");
        }),
        tableEvents.on("toast", (t) =>
          t.kind === "warning" ? toast.warning(t.message) : toast.info(t.message),
        ),
        tableEvents.on("hand.raised", (p) => toast.info(`${p.name} raised a hand`)),
        tableEvents.on("left", ({ code }) => {
          if (code === 4005) navigate("/closed", { replace: true });
          else if (code === 4401) navigate("/join", { replace: true });
          // Lost for good (the SDK's reconnection gave up — the server went away and came back, SPEC §8.15
          // AC-PER-06): join again, backing off to 10 s, while the banner says so; the board resyncs from the join.
          // (1000 and 4000: a leave someone chose — this screen closing, a navigation.)
          else if (code !== 1000 && code !== 4000) void rejoin(0);
        }),
      );
      try {
        await connectTable(campaignId);
      } catch (err) {
        if (cancelled) return;
        const code = joinErrorCode(err);
        if (code === "TABLE_CLOSED") navigate("/closed", { replace: true });
        else if (code === "FORBIDDEN" || code === "UNAUTHENTICATED") navigate("/", { replace: true });
        else setFailed((err as Error).message || "The table didn't answer.");
      }
    })();
    return () => {
      cancelled = true;
      for (const off of offs) off();
      disconnectTable();
    };
  }, [navigate, refresh, attempt]);

  if (!me && failed)
    return (
      <div className="grid min-h-[100dvh] place-items-center bg-bg p-4">
        <div className="panel w-full max-w-md">
          <LoadFailed
            what="the table"
            error={failed}
            retry={() => {
              setFailed(null);
              setAttempt((n) => n + 1);
            }}
          />
        </div>
      </div>
    );
  if (!me) return <FullScreenLoader label="Opening the door…" />;
  return (
    <div
      className="relative h-[100dvh] w-full overflow-hidden bg-bg"
      data-intro={introPhase === "done" ? undefined : introPhase}
      data-intro-reduced={introReduced || undefined}
    >
      <TableStage />
      <SceneTransition />
      <TopBar />
      <CastDialogHost />
      <LeftToolbar />
      <Dock />
      <PrepBanner />
      <MapToolsPanel />
      <LoadingBar />
      <RadialMenu />
      <EmoteWheel />
      <EmoteLayer />
      <HandoutReveal />
      <HoverCard />
      <HpNumbers />
      <MoveLabel />
      <WallChips />
      <MeasureLabels />
      <ActionBar />
      <TargetingBar />
      <EffectChip />
      <RollFeed />
      <PhoneTabBar />
      <TurnTracker />
      <TurnBanner />
      <FloatingCards />
      <DiceTray />
      <HpDialog />
      <StatusPicker />
      <MeasurePanel />
      <WallsPanel />
      <ZonesPanel />
      <LightsPanel />
      <FogPanel />
      <ViewAsBanner />
      <ZoneEditor />
      <QuickUnitDialog />
      <TokenSettingsDialog />
      <JumpTo />
      <SceneWizardHost />
      <ConnectionBanner connection={connection} />
      <Intro />
    </div>
  );
}

/** The New scene wizard, opened from the Scenes panel or by dropping a Library map on the board (SPEC §8.3). */
function SceneWizardHost() {
  const wizard = useUi((s) => s.sceneWizard);
  const dm = useTable((s) => s.me?.role === "dm" || s.me?.role === "admin");
  return (
    <NewSceneWizard
      open={Boolean(wizard) && dm}
      initialAssetId={typeof wizard === "object" && wizard ? wizard.assetId : undefined}
      onClose={() => useUi.getState().set({ sceneWizard: null })}
    />
  );
}
