import type { Room } from "@colyseus/sdk";
import type { AudioSync } from "@gloam/shared/protocol";
import { Table, type TableState } from "@gloam/shared/state";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TableRoom } from "../rooms/TableRoom.ts";
import { wav } from "./assetFixtures.ts";
import {
  type Agent,
  createCampaign,
  joinAsNew,
  openTable,
  rq,
  setupAdmin,
  sleep,
  startTestServer,
  type TestServer,
  waitFor,
} from "./harness.ts";

type TableRoomClient = Room<unknown, TableState>;

const headers = (a: Agent) => ({
  cookie: a.cookieHeader(),
  origin: a.base,
  "x-gloam-csrf": a.cookies.get("gloam_csrf") ?? "",
});

async function uploadWav(a: Agent, name: string, ms: number): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav(ms))]), name);
  const res = await fetch(`${a.base}/api/assets?purpose=audio`, {
    method: "POST",
    headers: headers(a),
    body: form,
  });
  const body = (await res.json()) as { data?: { asset: { id: string } }; error?: unknown };
  if (!body.data) throw new Error(`upload failed: ${JSON.stringify(body.error)}`);
  return body.data.asset.id;
}

/**
 * Music and ambience on the server (SPEC §8.17, §25.3; AC-AUD-02/03 server side, AC-UNDO-05): the DM's player —
 * presets, tracks, playlists; pause, resume, next, previous, stop, loop, shuffle, volumes — kept as a timeline on the
 * server's clock and sent to everyone as `audio.sync` (and to each client as it joins, where it is); the server moves
 * the music on when a track ends; the ambience's mix to everyone; players can't touch any of it; none of it undoes.
 */
describe("P11 — music and ambience on the server (AUD)", () => {
  let t: TestServer;
  let admin: Agent;
  let player: Agent;
  let campaignId: string;
  let dm: TableRoomClient;
  let dave: TableRoomClient;
  const syncs: { who: "dm" | "dave"; state: AudioSync; at: number }[] = [];
  const room = () => t.server.ctx.rooms.tables.get(campaignId) as unknown as TableRoom;
  const last = (who: "dm" | "dave") => syncs.filter((s) => s.who === who).at(-1)?.state;
  let short = "";
  let long = "";
  let third = "";

  beforeAll(async () => {
    t = await startTestServer();
    admin = await setupAdmin(t);
    campaignId = await createCampaign(admin);
    const code = (await openTable(admin, "local")).code;
    dm = (await admin.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    dm.onMessage("*", (type, p) => {
      if (type === "audio.sync") syncs.push({ who: "dm", state: p as AudioSync, at: Date.now() });
    });
    const p = await joinAsNew(t, code, "Dave");
    await admin.post("/api/admin/table/knocks/decide", { sessionId: p.sessionId, decision: "admitPlayer" });
    await waitFor(() => p.messages.find((m) => m.type === "admitted"));
    await p.agent.post("/api/join/enter");
    player = p.agent;
    dave = (await p.agent.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    dave.onMessage("*", (type, pl) => {
      if (type === "audio.sync") syncs.push({ who: "dave", state: pl as AudioSync, at: Date.now() });
    });
    short = await uploadWav(admin, "short.wav", 400);
    long = await uploadWav(admin, "long.wav", 1200);
    third = await uploadWav(admin, "third.wav", 500);
  });
  afterAll(async () => {
    await t?.stop();
  });

  it("sends the audio to each client as it joins, and every change to everyone", async () => {
    await waitFor(() => last("dave"));
    expect(last("dm")?.music.kind).toBe("none");
    const before = Date.now();
    await rq(dm, "audio.music", { action: "playPreset", preset: "tavern" });
    await waitFor(() => last("dave")?.music.kind === "preset");
    const m = last("dm")?.music;
    expect(m?.preset).toBe("tavern");
    // Its timeline on the server's clock, and its seed: every client plays the same notes from the same moment.
    expect(m?.startedAtServerMs).toBeGreaterThanOrEqual(before);
    expect(m?.startedAtServerMs).toBeLessThanOrEqual(Date.now());
    expect(m?.seed).toBeGreaterThanOrEqual(0);
    expect(last("dm")).toEqual(last("dm"));
  });

  it("pauses where it is and resumes from there; stop ends it; players may do none of it", async () => {
    await rq(dm, "audio.music", { action: "playTrack", trackId: long });
    await sleep(300);
    await rq(dm, "audio.music", { action: "pause" });
    const paused = last("dm")?.music;
    expect(paused?.paused).toBe(true);
    expect(paused?.pausedAtMs).toBeGreaterThanOrEqual(250);
    await sleep(400);
    await rq(dm, "audio.music", { action: "resume" });
    const resumed = last("dm")?.music;
    // Position = now − start: it carries on from the pause, not from where the clock went.
    const pos = Date.now() - (resumed?.startedAtServerMs ?? 0);
    expect(Math.abs(pos - (paused?.pausedAtMs ?? 0))).toBeLessThan(150);
    await expect(rq(dave, "audio.music", { action: "stop" })).rejects.toThrow(/FORBIDDEN/);
    await expect(rq(dave, "audio.ambience", { preset: "storm" })).rejects.toThrow(/FORBIDDEN/);
    await expect(rq(dave, "audio.playlist", { action: "create", name: "Mine" })).rejects.toThrow(/FORBIDDEN/);
    // The server's own "the track ended" isn't anyone else's to send.
    await expect(rq(dm, "audio.music", { action: "ended", rev: resumed?.rev ?? 0 })).rejects.toThrow(
      /FORBIDDEN/,
    );
    await rq(dm, "audio.music", { action: "stop" });
    expect(last("dm")?.music.kind).toBe("none");
  });

  it("plays a playlist through: the server moves on when each track ends (its length as a DM's browser measured it); next, previous, loop and shuffle", async () => {
    // The lengths, as the DM's browser reports them after decoding (the first measurement stays; a player can't).
    const measure = async (a: Agent, id: string, durationMs: number) =>
      fetch(`${a.base}/api/assets/${id}/audio`, {
        method: "PATCH",
        headers: { ...headers(a), "content-type": "application/json" },
        body: JSON.stringify({ durationMs, loudnessLufs: -18 }),
      });
    expect((await measure(player, short, 99_000)).status).toBe(404);
    for (const [id, ms] of [
      [short, 400],
      [long, 1200],
      [third, 500],
    ] as const)
      expect((await measure(admin, id, ms)).status).toBe(200);
    const again = (await (await measure(admin, short, 90_000)).json()) as { data: { set: boolean } };
    expect(again.data.set).toBe(false);
    expect(t.server.ctx.assets.dtoById(short)?.durationMs).toBe(400);
    expect(t.server.ctx.assets.dtoById(short)?.loudnessLufs).toBe(-18);

    const { playlistId } = await rq<{ playlistId: string }>(dm, "audio.playlist", {
      action: "create",
      name: "Road",
    });
    await rq(dm, "audio.playlist", { action: "setTracks", playlistId, trackIds: [short, third, long] });
    await rq(dm, "audio.music", { action: "loop", loop: false });
    await rq(dm, "audio.music", { action: "playPlaylist", playlistId });
    expect(last("dm")?.music.trackId).toBe(short);
    // 400 ms on, the next track, by itself; then the third; then, not looping, silence.
    await waitFor(() => last("dave")?.music.trackId === third, 3000);
    await waitFor(() => last("dave")?.music.trackId === long, 3000);
    await waitFor(() => last("dave")?.music.kind === "none", 4000);

    // Next / previous by hand; looping round from the last to the first.
    await rq(dm, "audio.music", { action: "loop", loop: true });
    await rq(dm, "audio.music", { action: "playPlaylist", playlistId, at: 2 });
    expect(last("dm")?.music.trackId).toBe(long);
    await rq(dm, "audio.music", { action: "next" });
    expect(last("dm")?.music.trackId).toBe(short);
    await rq(dm, "audio.music", { action: "previous" });
    expect(last("dm")?.music.trackId).toBe(long);
    // Shuffled: what's playing stays; the rest in some order — each track once.
    await rq(dm, "audio.music", { action: "shuffle", shuffle: true });
    const s = last("dm")?.music;
    expect(s?.trackId).toBe(long);
    expect([...(s?.order ?? [])].sort()).toEqual([0, 1, 2]);
    expect(s?.order[s.index]).toBe(2);
    // A track's own volume, and the music's.
    await rq(dm, "audio.music", { action: "trackVolume", trackId: long, volume: 0.5 });
    await rq(dm, "audio.music", { action: "volume", volume: 0.6 });
    expect(last("dm")?.trackVolumes[long]).toBe(0.5);
    expect(last("dm")?.music.volume).toBe(0.6);
    // Deleting the playlist that's playing: the track plays out, then the music stops.
    await rq(dm, "audio.playlist", { action: "delete", playlistId });
    expect(last("dm")?.playlists).toEqual([]);
    expect(last("dm")?.music.trackId).toBe(long);
    await waitFor(() => last("dm")?.music.kind === "none", 3000);
    // Undo puts the playlist back (an edit), but never the playback (AC-UNDO-05).
    await rq(dm, "history.undo", {});
    expect(last("dm")?.playlists.map((p) => p.name)).toEqual(["Road"]);
    // Dave's client heard every change as the DM's did — all but the DM's playlists (a player is told what plays, not
    // what's lined up: security review M2).
    await waitFor(() => JSON.stringify(last("dave")) === JSON.stringify({ ...last("dm"), playlists: [] }));
    expect(last("dave")?.playlists).toEqual([]);
  });

  it("sets the ambience from a preset or layer by layer, for everyone; a late joiner hears it as it is", async () => {
    await rq(dm, "audio.ambience", { preset: "tavernHearth" });
    const a = last("dm")?.ambience;
    expect(a?.preset).toBe("tavernHearth");
    expect(a?.levels).toEqual({ wind: 0.3, fire: 0.8, murmur: 0.7 });
    await rq(dm, "audio.ambience", { levels: { rain: 0.5, fire: 0 } });
    expect(last("dm")?.ambience).toMatchObject({
      preset: null,
      levels: { wind: 0.3, rain: 0.5, murmur: 0.7 },
    });
    expect(last("dm")?.ambience.levels.fire).toBeUndefined();
    await waitFor(() => JSON.stringify(last("dave")?.ambience) === JSON.stringify(last("dm")?.ambience));
    // A second tab of Dave's joins: it gets the music and the ambience as they are.
    const late = (await player.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    let got: AudioSync | null = null;
    late.onMessage("*", (type, p) => {
      if (type === "audio.sync") got = p as AudioSync;
    });
    await waitFor(() => got);
    expect((got as unknown as AudioSync).ambience).toEqual(last("dm")?.ambience);
    await late.leave();
  });

  it("keeps none of the playback in the undo stack, but every change in the campaign (and so its saves)", async () => {
    await rq(dm, "audio.music", { action: "playPreset", preset: "wonder" });
    const before = last("dm")?.music;
    await rq(dm, "history.undo", {}).catch(() => {});
    // Undo took back the last undoable thing (not the music): wonder still plays.
    expect(last("dm")?.music.preset).toBe("wonder");
    expect(last("dm")?.music.rev).toBeGreaterThanOrEqual(before?.rev ?? 0);
    // It's written to the campaign: a reopened table plays on from it.
    const row = t.server.ctx.sqlite
      .prepare("SELECT settings_json FROM campaigns WHERE id = ?")
      .get(campaignId) as {
      settings_json: string;
    };
    expect(JSON.parse(row.settings_json).audio.music.preset).toBe("wonder");
    const history = t.server.ctx.sqlite
      .prepare("SELECT type, undoable FROM history WHERE campaign_id = ? AND type = 'audio.music'")
      .all(campaignId) as { type: string; undoable: number }[];
    expect(history.length).toBeGreaterThan(0);
    expect(history.every((h) => h.undoable === 0)).toBe(true);
    expect(room().model.campaign.settings.audio?.music.preset).toBe("wonder");
  });
});
