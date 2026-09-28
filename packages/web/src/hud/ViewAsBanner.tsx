import { Eye, X } from "lucide-react";
import { useEffect } from "react";
import { request } from "../net/table.ts";
import { useEntities } from "../state/entities.ts";
import { useFog } from "../state/fog.ts";
import { useViewAs, type ViewAsData } from "../state/viewAs.ts";
import { IconButton } from "../ui/Button.tsx";
import { useHudInsets } from "./insets.ts";

/**
 * View as (SPEC §8.8): while the DM views the board as a player, what that player holds is fetched from the server
 * (`vision.viewAs`, read-only — nothing changes for anyone) and refreshed as the board changes; a banner says whose
 * view this is and ends it.
 */
export function ViewAsBanner() {
  const userId = useViewAs((s) => s.userId);
  const name = useViewAs((s) => s.name);
  const top = useHudInsets((s) => s.top);
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    let seq = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      const my = ++seq;
      try {
        const data = await request<ViewAsData>("vision.viewAs", { userId });
        if (alive && my === seq && useViewAs.getState().userId === userId) useViewAs.getState().set({ data });
      } catch {
        // Gone (left the campaign, table closed): the banner still ends it.
      }
    };
    const soon = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, 150);
    };
    void load();
    const offE = useEntities.subscribe(soon);
    const offF = useFog.subscribe(soon);
    return () => {
      alive = false;
      offE();
      offF();
      if (timer) clearTimeout(timer);
    };
  }, [userId]);
  if (!userId) return null;
  return (
    <div
      role="status"
      data-testid="view-as-banner"
      className="panel pointer-events-auto absolute left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 py-1 pr-1 pl-3"
      style={{ top: top + 8 }}
    >
      <Eye size={16} className="text-brass" aria-hidden />
      <span className="text-14 text-bone">
        Viewing as <span className="font-semibold">{name}</span>
      </span>
      <IconButton
        label="Stop viewing as"
        onClick={() => useViewAs.getState().set({ userId: null, name: "", data: null })}
      >
        <X size={16} />
      </IconButton>
    </div>
  );
}
