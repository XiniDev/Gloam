import { useState } from "react";
import { request } from "../../net/table.ts";
import type { SceneListItem } from "../../state/library.ts";
import { Button } from "../../ui/Button.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { toast } from "../../ui/Toast.tsx";
import { CalibrationEditor } from "./CalibrationEditor.tsx";

/**
 * Recalibrate an image map (SPEC §8.3, AC-SCN-08): walls, zones, lights and tokens rescale with the map so they stay
 * on its art; creature sizes and light radii are rules distances and don't change.
 */
export function CalibrationDialog({ scene, onClose }: { scene: SceneListItem; onClose: () => void }) {
  const c = scene.calibration;
  const [ftPerPx, setFtPerPx] = useState(c.ftPerPx ?? 5 / 70);
  const [busy, setBusy] = useState(false);
  const imageW = c.imageW ?? 1;
  const imageH = c.imageH ?? 1;
  return (
    <Dialog
      open
      onClose={onClose}
      width={760}
      title={`Recalibrate ${scene.name}`}
      description="Walls, zones, lights and tokens move with the map so they stay on its art."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await request("scene.calibrate", { sceneId: scene.id, ftPerPx });
                toast.success(
                  "Calibrated",
                  `${scene.name}: one 5-ft square is ${(5 / ftPerPx).toFixed(1)} px.`,
                );
                onClose();
              } catch (e) {
                toast.danger("Couldn't calibrate", (e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save calibration
          </Button>
        </>
      }
    >
      {scene.mapAssetId ? (
        <CalibrationEditor
          assetId={scene.mapAssetId}
          imageW={imageW}
          imageH={imageH}
          ftPerPx={ftPerPx}
          onChange={setFtPerPx}
        />
      ) : null}
    </Dialog>
  );
}
