import { EyeOff } from "lucide-react";
import { useRef, useState } from "react";
import { openPrep, request } from "../net/table.ts";
import { useEntities } from "../state/entities.ts";
import { Button } from "../ui/Button.tsx";
import { toast } from "../ui/Toast.tsx";
import { insetMeasures, useHudInsets, useIsPhone, useMeasuredInset } from "./insets.ts";

/**
 * Prep view banner (SPEC §8.3, §13.7): while a DM edits a scene the players can't see, the board says so and offers
 * the two ways out — back to the live scene, or bring everyone here.
 */
export function PrepBanner() {
  const scene = useEntities((s) => s.prep?.scene ?? null);
  const [busy, setBusy] = useState<"back" | "activate" | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const phone = useIsPhone();
  const right = useHudInsets((s) => s.right);
  useMeasuredInset("banner", ref, insetMeasures.banner, Boolean(scene));
  if (!scene) return null;
  const run = async (what: "back" | "activate") => {
    setBusy(what);
    try {
      if (what === "back") await openPrep(null);
      else {
        await request("scene.activate", { sceneId: scene.id });
        toast.success(`${scene.name} is live`, "Everyone is travelling there now.");
      }
    } catch (e) {
      toast.danger("Couldn't do that", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div
      ref={ref}
      role="status"
      data-testid="prep-banner"
      // Centred in the board area the dock leaves free; on phones a full-width strip under the top bar (the dock and
      // tool panels move down below it).
      className="pointer-events-none absolute left-0 top-[60px] z-30 flex justify-center px-3"
      style={{ right: phone ? 0 : right }}
    >
      <div className="panel pointer-events-auto flex max-w-full flex-wrap items-center gap-x-4 gap-y-2 border-[var(--brass-600)] px-4 py-2">
        <span className="flex min-w-0 items-center gap-2 text-14 text-bone">
          <EyeOff size={16} className="shrink-0 text-accent" aria-hidden />
          <span className="truncate">
            Only DMs see this scene — <b className="font-bold">{scene.name}</b>
          </span>
        </span>
        <span className="flex gap-2">
          <Button size="S" variant="ghost" loading={busy === "back"} onClick={() => void run("back")}>
            Back to live
          </Button>
          <Button
            size="S"
            variant="primary"
            loading={busy === "activate"}
            onClick={() => void run("activate")}
          >
            Activate for players
          </Button>
        </span>
      </div>
    </div>
  );
}
