import { beforeEach, describe, expect, it } from "vitest";
import { emptyScene, type SceneData, travelHooks, useEntities } from "./entities.ts";

const scene = (id: string, name: string): SceneData => ({
  ...emptyScene(),
  scene: { id, name } as SceneData["scene"],
});

describe("scene travel (SPEC §8.3 Scene activation)", () => {
  beforeEach(() => {
    useEntities.setState({ live: emptyScene(), prep: null, travel: null, armed: false });
    travelHooks.beforeTravel = null;
  });

  it("travels from one scene to another once armed, freezing the old board first", () => {
    let froze = 0;
    travelHooks.beforeTravel = () => {
      froze++;
    };
    const s = useEntities.getState();
    s.setLive(scene("a", "Tavern"));
    s.arm();
    useEntities.getState().setLive(scene("b", "Crypt"));
    expect(useEntities.getState().travel).toMatchObject({ sceneId: "b", name: "Crypt" });
    expect(froze).toBe(1);
  });

  it("the first scene to arrive just appears: after a slow join's intro, or a reconnect's fresh sync", () => {
    const s = useEntities.getState();
    s.arm();
    s.setLive(scene("a", "Tavern"));
    expect(useEntities.getState().travel).toBeNull();
    // A reconnect resets the store and syncs again.
    useEntities.getState().reset();
    useEntities.getState().setLive(scene("a", "Tavern"));
    expect(useEntities.getState().travel).toBeNull();
  });

  it("doesn't travel before the intro has armed it, or while a DM prepares another scene", () => {
    const s = useEntities.getState();
    s.setLive(scene("a", "Tavern"));
    useEntities.getState().setLive(scene("b", "Crypt"));
    expect(useEntities.getState().travel).toBeNull();
    useEntities.setState({ armed: true, prep: { ...scene("c", "Vault"), meta: {} as never } });
    useEntities.getState().setLive(scene("d", "Road"));
    expect(useEntities.getState().travel).toBeNull();
  });
});
