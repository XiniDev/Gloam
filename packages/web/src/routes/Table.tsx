import { useEffect } from "react";
import { useNavigate } from "react-router";
import { ActionBar } from "../hud/ActionBar.tsx";
import { DiceTray } from "../hud/DiceTray.tsx";
import { Dock } from "../hud/Dock.tsx";
import { MapToolsPanel } from "../hud/dm/MapToolsPanel.tsx";
import { NewSceneWizard } from "../hud/dm/NewSceneWizard.tsx";
import { FogPanel } from "../hud/FogPanel.tsx";
import { Intro, useIntro } from "../hud/Intro.tsx";
import { useHudInsets } from "../hud/insets.ts";
import { dismissKnockCard, showKnockCard } from "../hud/KnockCards.tsx";
import { LeftToolbar } from "../hud/LeftToolbar.tsx";
import { LightsPanel } from "../hud/LightsPanel.tsx";
import { LoadingBar } from "../hud/LoadingBar.tsx";
import { MeasureLabels } from "../hud/MeasureLabels.tsx";
import { MeasurePanel } from "../hud/MeasurePanel.tsx";
import { MoveLabel } from "../hud/MoveLabel.tsx";
import { PrepBanner } from "../hud/PrepBanner.tsx";
import { QuickUnitDialog } from "../hud/QuickUnitDialog.tsx";
import { RadialMenu } from "../hud/RadialMenu.tsx";
import { RequestCards } from "../hud/RequestCards.tsx";
import { RollFeed } from "../hud/RollFeed.tsx";
import { SceneTransition } from "../hud/SceneTransition.tsx";
import { TopBar } from "../hud/TopBar.tsx";
import { useUndoKeys } from "../hud/useUndoKeys.ts";
import { ViewAsBanner } from "../hud/ViewAsBanner.tsx";
import { WallChips } from "../hud/WallChips.tsx";
import { WallsPanel } from "../hud/WallsPanel.tsx";
import { ZoneEditor, ZonesPanel } from "../hud/ZonesPanel.tsx";
import { joinErrorCode } from "../net/colyseus.ts";
import { watchDice } from "../net/dice.ts";
import { watchFog } from "../net/fog.ts";
import { watchSheets } from "../net/sheets.ts";
import { connectTable, disconnectTable, request, tableEvents, useTable } from "../net/table.ts";
import { useSession } from "../state/session.ts";
import { useUi } from "../state/ui.ts";
import { ConnectionBanner } from "../ui/ConnectionBanner.tsx";
import { FullScreenLoader } from "../ui/FullScreenLoader.tsx";
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
        }),
      );
      try {
        await connectTable(campaignId);
      } catch (err) {
        if (cancelled) return;
        const code = joinErrorCode(err);
        if (code === "TABLE_CLOSED") navigate("/closed", { replace: true });
        else if (code === "FORBIDDEN" || code === "UNAUTHENTICATED") navigate("/", { replace: true });
        else toast.danger("Couldn't reach the table", "Check your connection and reload.");
      }
    })();
    return () => {
      cancelled = true;
      for (const off of offs) off();
      disconnectTable();
    };
  }, [navigate, refresh]);

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
      <LeftToolbar />
      <Dock />
      <PrepBanner />
      <MapToolsPanel />
      <LoadingBar />
      <RadialMenu />
      <MoveLabel />
      <WallChips />
      <MeasureLabels />
      <ActionBar />
      <RollFeed />
      <RequestCards />
      <DiceTray />
      <MeasurePanel />
      <WallsPanel />
      <ZonesPanel />
      <LightsPanel />
      <FogPanel />
      <ViewAsBanner />
      <ZoneEditor />
      <QuickUnitDialog />
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
