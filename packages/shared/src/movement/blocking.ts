/**
 * The wall blocking matrix (SPEC §8.7, AC-WAL-01). "occluder" is the players' copy of a hidden sight-blocker:
 * it blocks sight and light only (movement truth stays on the server).
 */
export type WallKindAny = "wall" | "door" | "window" | "curtain" | "invisible" | "secret" | "occluder";
export type DoorState = "closed" | "open" | "locked" | null | undefined;

const shut = (door: DoorState) => door !== "open";

export function blocksMove(kind: string, door?: DoorState): boolean {
  switch (kind) {
    case "wall":
    case "window":
    case "invisible":
      return true;
    case "door":
    case "secret":
      return shut(door);
    default:
      return false; // curtain, occluder
  }
}

export function blocksSight(kind: string, door?: DoorState): boolean {
  switch (kind) {
    case "wall":
    case "curtain":
    case "occluder":
      return true;
    case "door":
    case "secret":
      return shut(door);
    default:
      return false; // window, invisible
  }
}

/** Light follows sight for every kind (§8.7). */
export const blocksLight = blocksSight;

/** Movement clearance radius of a creature (§16.2): squeeze × its space (Medium: 0.4 × 5 = 2 ft). */
export const clearanceRadius = (sizeFt: number, squeeze = 0.4): number => squeeze * sizeFt;
