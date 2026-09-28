import { LIGHT_PRESETS } from "@gloam/shared";
import { Brush, Link2, Link2Off, ScanLine } from "lucide-react";
import { useMemo, useState } from "react";
import { request, useTable } from "../../../net/table.ts";
import { useBoard } from "../../../state/entities.ts";
import { Button } from "../../../ui/Button.tsx";
import { Dialog } from "../../../ui/Dialog.tsx";
import { toast } from "../../../ui/Toast.tsx";
import { AssetPicker } from "../AssetPicker.tsx";
import type { SheetCtx } from "../context.ts";
import { DrawingPad } from "../DrawingPad.tsx";
import { PaperCutout } from "../PaperCutout.tsx";
import { SectionTitle } from "../primitives.tsx";

/**
 * Token (§8.10 UI): the character's art — portrait and token image, which its linked tokens take — a drawing pad and
 * a paper cutout to make some, and the light it carries; for the DM, its tokens on this scene with their link to the
 * sheet (SPEC §8.5; relinking asks before a token's own values are replaced) and who shares their sight.
 */
export function TokenTab({ ctx }: { ctx: SheetCtx }) {
  const c = ctx.sheet.core;
  const ro = !ctx.canEdit;
  const [maker, setMaker] = useState<"draw" | "cutout" | null>(null);
  const allTokens = useBoard((d) => d.tokens);
  const tokensHere = useMemo(
    () => [...allTokens.values()].filter((t) => t.actorId === ctx.actor.id),
    [allTokens, ctx.actor.id],
  );
  return (
    <div className="flex flex-col gap-1 text-14 text-paper-ink">
      <SectionTitle>Art</SectionTitle>
      {ro ? (
        <p className="text-13 text-paper-muted">Only the character's player and the DM change its art.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <AssetPicker
            label="Portrait"
            purpose="portrait"
            value={c.portraitAssetId}
            onChange={(id) => void ctx.set(["core", "portraitAssetId"], id)}
          />
          <AssetPicker
            label="Token image"
            purpose="token"
            value={c.tokenAssetId}
            onChange={(id) => void ctx.set(["core", "tokenAssetId"], id)}
          />
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="S" icon={<Brush size={15} />} onClick={() => setMaker("draw")}>
              Draw…
            </Button>
            <Button
              variant="secondary"
              size="S"
              icon={<ScanLine size={15} />}
              onClick={() => setMaker("cutout")}
            >
              From a photo of paper…
            </Button>
          </div>
        </div>
      )}

      <SectionTitle>Light carried</SectionTitle>
      <select
        aria-label="Light carried"
        value={c.light ?? ""}
        disabled={ro}
        onChange={(e) => void ctx.set(["core", "light"], e.target.value || undefined)}
        className="h-8 min-h-[var(--touch-min)] self-start rounded-[var(--radius-control)] border border-parchment-edge bg-parchment/60 px-2 text-14 text-paper-ink"
      >
        <option value="">None</option>
        {LIGHT_PRESETS.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>

      {ctx.dm ? <TokensOfCharacter ctx={ctx} /> : null}

      <DrawingPad
        open={maker === "draw"}
        onClose={() => setMaker(null)}
        onUse={(assetId, as) => {
          if (as === "portrait") return void ctx.set(["core", "portraitAssetId"], assetId);
          void ctx.set(["core", "tokenAssetId"], assetId);
          // A standee or a coin: the character's tokens here take that look.
          for (const t of tokensHere)
            void request("token.update", { tokenId: t.id, appearance: { mode: as } }).catch(() => {});
        }}
      />
      <PaperCutout
        open={maker === "cutout"}
        onClose={() => setMaker(null)}
        onUse={(assetId, as) =>
          void ctx.set(["core", as === "portrait" ? "portraitAssetId" : "tokenAssetId"], assetId)
        }
      />
    </div>
  );
}

/** The DM's view of the character's tokens here: each linked (a view of the sheet) or its own copy; shared sight. */
function TokensOfCharacter({ ctx }: { ctx: SheetCtx }) {
  const allTokens = useBoard((d) => d.tokens);
  const tokens = useMemo(
    () => [...allTokens.values()].filter((t) => t.actorId === ctx.actor.id),
    [allTokens, ctx.actor.id],
  );
  const presence = useTable((s) => s.presence);
  const players = useMemo(() => presence.filter((p) => p.role === "player"), [presence]);
  const [ask, setAsk] = useState<{ tokenId: string; message: string } | null>(null);
  const setLink = async (tokenId: string, link: "linked" | "unlinked", overwrite = false) => {
    try {
      await request("token.setLink", { tokenId, link, overwrite });
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === "CONFLICT" && link === "linked" && !overwrite)
        setAsk({ tokenId, message: err.message });
      else toast.danger("Couldn't change the link", err.message);
    }
  };
  return (
    <>
      <SectionTitle>Tokens on this scene</SectionTitle>
      {tokens.length === 0 ? <p className="text-13 italic text-paper-muted">None here.</p> : null}
      <ul className="flex flex-col gap-1.5" data-testid="character-tokens">
        {tokens.map((t) => {
          const linked = t.dm?.link !== "unlinked";
          let shares: string[] = [];
          try {
            shares =
              (JSON.parse(t.dm?.overridesJson || "{}") as { shareVisionWith?: string[] }).shareVisionWith ??
              [];
          } catch {
            shares = [];
          }
          return (
            <li
              key={t.id}
              className="rounded-[var(--radius-control)] border border-parchment-edge/60 p-2"
              data-testid="character-token"
              data-link={linked ? "linked" : "unlinked"}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-bold">{t.name}</span>
                <button
                  type="button"
                  onClick={() => void setLink(t.id, linked ? "unlinked" : "linked")}
                  className="inline-flex h-8 min-h-[var(--touch-min)] items-center gap-1 rounded-[var(--radius-control)] border border-paper-ink/40 px-2 text-13 font-bold text-paper-ink hover:bg-parchment-deep"
                  title={
                    linked ? "Its own copy of the numbers from now on" : "Show the sheet's numbers again"
                  }
                >
                  {linked ? <Link2Off size={14} aria-hidden /> : <Link2 size={14} aria-hidden />}
                  {linked ? "Unlink" : "Link to sheet"}
                </button>
              </div>
              <p className="text-13 text-paper-muted">
                {linked
                  ? "Linked — shows the sheet's HP and conditions."
                  : "Unlinked — keeps its own numbers."}
              </p>
              {players.length ? (
                <div className="mt-1 flex flex-wrap items-center gap-2 text-13">
                  <span className="text-paper-muted">Sight shared with</span>
                  {players.map((p) => (
                    <label key={p.userId} className="inline-flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={shares.includes(p.userId)}
                        onChange={(e) =>
                          void request("token.update", {
                            tokenId: t.id,
                            shareVisionWith: e.target.checked
                              ? [...shares, p.userId]
                              : shares.filter((u) => u !== p.userId),
                          }).catch((err) => toast.danger("Couldn't share its sight", (err as Error).message))
                        }
                        className="accent-[var(--wax-500)]"
                      />
                      {p.name}
                    </label>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <Dialog
        open={ask !== null}
        onClose={() => setAsk(null)}
        title="Link this token to the sheet?"
        description={ask?.message}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAsk(null)}>
              Keep its own
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const a = ask;
                setAsk(null);
                if (a) void setLink(a.tokenId, "linked", true);
              }}
            >
              Replace with the sheet's
            </Button>
          </div>
        }
      />
    </>
  );
}
