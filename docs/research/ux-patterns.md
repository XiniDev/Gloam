# R5 — UX patterns for Gloam

Phase 0 research task R5 (SPEC §32). Researched 27 September 2026. The subject is **interaction patterns** in Divinity: Original Sin 2 (DOS2), Baldur's Gate 3 (BG3), Foundry VTT, Owlbear Rodeo and TaleSpire. Roll20, Tabletop Simulator, the Dice So Nice module, platform guidelines and WCAG are included where they bear on dice or touch. Everything below describes *patterns*. Nothing here copies an asset, a name, trade dress or a distinctive visual identity. Colours are named by their **role token** from SPEC §27.2 (for example `--path-ok` or `--warning`), never by hex.

## How to read this

Every takeaway carries one tag:

| Tag | Meaning |
|---|---|
| **[SPEC §x]** | The spec already covers it. The takeaway only confirms it, tunes a number or adds a detail inside the existing requirement. |
| **[ADD]** | New, but inside the scope of an existing spec feature. Adopting it needs a one-line `docs/DECISIONS.md` entry because it goes beyond the literal text. |
| **[TRAP]** | A constraint I'm raising that nobody asked about: an information leak, a rules subtlety or a protocol hazard. These matter more than the polish items. |

Numbers marked [ADD] are **starting values** for the visual critic to tune (SPEC §36.3). They are not measurements taken from the reference games.

**Source reliability.** Official docs, patch notes and developer blogs are cited directly. Community wikis, guides and forum threads are labelled as such. **[snippet]** means only the search engine's summary could be read: Steam Community, Nexus Mods, docs.owlbear.rodeo, the Roll20 help centre and wiki, and GameFAQs all refused automated fetches (HTTP 403 or 429). Treat [snippet] claims as weaker. **[unverified]** means I looked and could not confirm the claim; it is listed in this doc §15.

---

## 0. Findings that apply everywhere

1. **The preview must equal the result.** BG3 spell tooltips were wrong for months while the percentage-to-hit stayed correct, and it made news ([PC Gamer headline](https://www.pcgamer.com/games/baldurs-gate/baldur-s-gate-3-s-spell-tooltips-have-been-lying-to-you-for-potentially-months-though-if-you-ve-been-running-off-the-chance-to-hit-you-re-just-fine/); only the headline was readable). Gloam already requires this for path cost (AC-MOV-02). Extend the same parity test to AoE target lists, cover hints and damage previews (this doc §3, hit-feedback item 5).
2. **Markers and handles need a minimum screen size, not only a world size.** One module's whole reason to exist is to keep door icons the same size at every grid scale ([Smart Doors README](https://github.com/farling42/foundryvtt-smart-doors/blob/master/README.md)). BG3 players reported opportunity-attack arrows hidden under large creatures "due to constant arrow length" ([Larian forums, 26/03/21](https://forums.larian.com/ubbthreads.php?ubb=showflat&Number=767903)).
3. **Say why, not just no.** BG3 Patch 4 added "cursor messages for surfaces and Attacks of Opportunity" and fixed a misleading "Path is interrupted!" error ([Patch 4 notes](https://baldursgate3.game/news/patch-4-now-live_96)). Every refusal in Gloam should name its cause: the wall, the creature, the condition or the range.
4. **Don't auto-route players into trouble.** A BG3 player wrote that the UI "auto-paths characters in ways that provoke attacks unexpectedly" ([Larian forums](https://forums.larian.com/ubbthreads.php?ubb=showflat&Number=767903)).
5. **"Harmless" visuals leak secrets.** Roll20 players could watch a GM's whispered 3D dice and "understand what dice I am rolling" ([Roll20 forum](https://app.roll20.net/forum/post/12359761/whispered-3d-dice-rolls-visible-to-all)). P4 applies to animations, previews and bubbles as well as to entities.
6. **The camera is the biggest source of friction in 3D tabletops.** One reviewer said a Blender-like camera was "the biggest complaint from all the players" ([Gnome Stew](https://gnomestew.com/a-3d-vtt-roundup-and-review/)). Another saw groups "operating a tool during play" ([Advanced RPGs](https://advancedrpgs.com/talespire-review-3d-battle-maps-table-use-and-limits/)).
7. **Transient things clean themselves up.** TaleSpire: "The dices, once rolled, have no use to my players and I have to spend my time deleting them asap" ([Dev Log 446 comments](https://bouncyrock.com/news/articles/talespire-dev-log-446)).
8. **Use shape and pattern, never colour alone.** BG3 Patch 4 extended its colour-blind modes to "portrait frames in turn order" ([Patch 4](https://baldursgate3.game/news/patch-4-now-live_96)). Gloam's rule already exists in §8.22 and §30.1; apply it to every new marker below.

### The [TRAP] items, collected (decide these before Phase 3)

| # | Trap | Where it bites | Recommendation |
|---|---|---|---|
| T-1 | `move.preview` is relayed to "players who can currently see that token" (SPEC §3 step 1, §13.5). For DM-driven NPCs this broadcasts the DM's *intentions*: where a monster might go, and the hesitations along the way. | §8.6 "Others see planning" | Don't relay the DM's previews to players (per-DM setting, default off). The server clips each relayed polyline at the first point that viewer can't perceive, mirroring §15.6 for committed moves. |
| T-2 | `roll.masked` payload is unspecified. §18.3 says masked rolls animate "?" dice. If the payload carries the die list, the formula or the label, players learn "the DM rolled 8d6" or "one d20 for Insight". | §8.9, §18.3 | `roll.masked` carries only `{id, rollerId, visibility}`. Animate a fixed generic throw (the same two "?" dice every time) whatever the real formula. |
| T-3 | A client-side opportunity-attack warning needs each hostile's **reach**, so the value must be in the player's state. | §8.6 OA warnings, AC-SEC-07 | Send `reach` only for hostiles the player currently perceives (BG3 effectively shows it). Record the decision so the frame-inspection test expects it. |
| T-4 | An emote "pops above the player's token (or their portrait if they have no token visible)". If "visible" is judged from the emoter's side, the bubble reveals the token's position in darkness. | §8.18 | Decide per **viewer**. Send the token anchor only to viewers who perceive the token; everyone else gets a portrait-only emote. |
| T-5 | Feathered fog edges (1–2 ft, §8.8) can push light and visibility **through** a wall. Foundry has a report of faint light "leaking through some of the walls a very small distance" ([issue #10281](https://github.com/foundryvtt/foundryvtt/issues/10281); Foundry marked it unverified or non-reproducible). | §8.8, §15.7 | Erode the visibility mask by the feather width before blurring, or feather only along edges that aren't walls. Test that zero luminance appears inside a closed room with a lit exterior. |
| T-6 | "Share my rulers" defaults to on. A DM's measurement (the distance to an invisible trap, or to a hidden token) then leaks. | §8.6 measurement, §8.22 | Default on for players and **off for DMs**. Holding Shift while finishing a measurement keeps that one private. |
| T-7 | "Unknown" silhouettes in the turn strip, placed at their true position, reveal an unseen creature's **initiative slot** (a tactical tell), even though the setting was only meant to reveal the count. | §8.12 | Collect unknowns into a single "? ×N" chip at the round divider, or show nothing (the existing setting). Never place them in order. |
| T-8 | A hit-chance percentage shown to players against NPCs reveals **AC**, which is hidden (§8.13, AC-SEC-07). | Combat readability | Players see their modifier and their advantage or disadvantage state. Only the DM's card shows "hits on 12+ (45%)". |
| T-9 | Opportunity-attack rules depend on the **attacker** seeing the mover (SPEC §34.6, SRD p. 15), which the mover's client can't know. | §8.6 | Word the tooltip "Possible opportunity attack". Suppress it for Teleport, DM moves, Incapacitated hostiles and hostiles whose Reaction is already used (this doc §2 item 5). |
| T-10 | Torch flicker, lightning flashes and critical-hit sparkles can cross the WCAG 2.3.1 flash threshold when they cover a large part of the screen. | §8.8 lights, §24.5 VFX | Cap luminance swings (this doc §5 item 2). No more than 3 flashes per second. Never flash the whole screen. |

---

## 1. Movement and path preview

**What the references do**

- **DOS2.** While you point at a destination, a label beside the cursor shows how many Action Points the move will cost. Action Points appear as circles: green for available, red for the cost of the pending action ([gamepressure DOS2 combat guide](https://www.gamepressure.com/originalsinii/combat/z09214)). A yellow ring around the character shows its attack range, and "if standing on higher ground, there will be an additional green circle extending a few meters extra" ([Fextralife DOS2 wiki: Combat](https://divinityoriginalsin2.wiki.fextralife.com/Combat)).
- **BG3.** A white line shows the path before you click ([GamerGuides](https://www.gamerguides.com/baldurs-gate-3/guide/gameplay/getting-started/climbing-and-jumping-explained-in-baldurs-gate-3); [Shacknews](https://www.shacknews.com/article/136590/combat-explainer-baldurs-gate-3)). The stretch through difficult terrain turns **yellow** ([gamepressure BG3 combat guide](https://www.gamepressure.com/baldurs-gate-iii/combat/zed2dd)). Guides disagree about where the remaining-movement readout sits: "just above the quick access… marked in Orange" per gamepressure, a "blue circle in the bottom-right" per Shacknews. Patch 4 added cursor messages for surfaces and opportunity attacks ([Patch 4](https://baldursgate3.game/news/patch-4-now-live_96)).
- **Foundry VTT v13.** Dragging a token measures cost as well as distance. Ctrl+click adds waypoints and "right-clicking removes existing waypoints". Tab cycles movement types. Tokens "automatically rotate to face their movement direction" ([release 13.341](https://foundryvtt.com/releases/13.341)). "Holding ALT while measuring will measure privately" ([release 13.332](https://foundryvtt.com/releases/13.332)).
- **TaleSpire.** "When you pick up a creature you should be able to see all the places you could walk to within a given range", computed by flood fill ([Dev Log 132](https://bouncyrock.com/news/articles/talespire-dev-log-132)). A reviewer: "A player rotating the camera to check a line can lose track of where their mini started" ([Advanced RPGs](https://advancedrpgs.com/talespire-review-3d-battle-maps-table-use-and-limits/)).
- [unverified] I could not confirm from a readable source exactly what BG3 or DOS2 draws at the point where movement runs out: whether the rest of the line is recoloured, cut off or labelled.

**Takeaways**

1. **[SPEC §8.6]** Keep the 0.6-ft ribbon, but never draw it narrower than **3 px on screen**, so it survives zooming out to 400 ft. Flowing dashes move toward the destination at a constant **~40 px/s** on screen, so the speed doesn't change with zoom. `--path-ok` within budget; `--path-over` plus hatching beyond it; double-dash for difficult terrain. Like BG3, the preview draws before any click.
2. **[SPEC §8.6] Label placement.** Desktop: the label sits **16 px right and 20 px above** the pointer hotspot. Touch: **64 px above** the contact point, flipping below near the top edge, clamped inside a 16-px gutter. Numbers use tabular figures (§27.3). Show "10 left" in `--success` and "5 over" in `--path-over`; the rest of the text is `--text` on a `--raised` chip with radius 4. This is the same near-cursor cost readout DOS2 uses.
3. **[ADD] Crossing the budget.** When the previewed cost crosses the remaining budget in either direction, the max-reach ring does a pop spring (§27.5 pop, scale 1 → 1.25 → 1 over ~220 ms) and plays a quiet wooden tick at −18 dB, at most once every 300 ms so hovering on the boundary doesn't chatter. On Android only, add an 8-ms `navigator.vibrate` as a progressive enhancement: it is "not Baseline" and needs sticky user activation ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/vibrate)). The visual pop is the required equivalent (AC-A11Y-05).
4. **[ADD] Route hysteresis.** Keep the current route until a new optimum is cheaper by **≥ 1 ft or ≥ 3 %**, or the old route becomes invalid. Otherwise the line flips between the two sides of a pillar every frame. This is my own design reasoning; no source reports the problem.
5. **[ADD] Show reach while carrying the mini.** In combat, while you drag your active token, draw the §16.6 range field automatically at about **35 % opacity**. `G` still pins it at full strength. This is the TaleSpire "see where you can walk on pick-up" pattern. Keep it off in exploration.
6. **[ADD] Turn-start anchor.** After the first segment of your turn, leave a faint brass ring (`--accent` at 40 %) at `turnStart` with a small ↺ glyph. Hovering it shows "Reset move (Backspace)"; clicking it resets (§8.6 already defines Reset). Each committed segment leaves a thin `--text-muted` trail at 40 % until the turn ends, so the effect of Ctrl/Cmd+Z is visible in advance. This answers the "lose track of where the mini started" complaint.
7. **[ADD] Hazards on the path.** If the routed path crosses a hazard zone the player can see, put a small hazard glyph where it enters and extend the label: `20 ft · 10 left · crosses Burning floor`. The router gives visible hazard zones a *routing-only* penalty and goes around them when the detour costs ≤ 10 % more. The displayed cost stays the real cost. Hidden zones are never in player state (P4), so no leak. This is BG3's surface cursor message combined with the fix for the auto-path complaint.
8. **[ADD] Dash hint.** If the path is over budget, the Action pip is unused and the path fits within budget + speed, show the label as `35 ft · 5 over · Dash covers it` in `--text-muted`. Pressing Dash updates the preview live. This is a suggestion, not an action (P2).
9. **[ADD] Waypoint editing.** Waypoints are numbered brass diamonds at 12 px on screen. A right-*click* on a waypoint (the pointer moves less than 4 px between down and up) removes it, as Foundry does. A right-*drag* still orbits (§8.4).

**Avoid**

- Auto-routes that provoke or cross hazards without saying so. A BG3 player called the UI "deliberately set against you" for exactly this ([Larian forums](https://forums.larian.com/ubbthreads.php?ubb=showflat&Number=767903)).
- Generic failures. Replace `No path` with its cause: `No path — wall`, `No path — Goblin 2 blocks`, `Can't move — Grappled` (§8.6 already has the Grappled wording).
- Coding difficult terrain by colour, as BG3 does with yellow. Gloam's pattern (double-dash) is correct: it is colour-blind safe and leaves only two colour meanings on the path.
- Two movement readouts in different places. BG3 guides can't agree where the movement meter is. Keep one, next to the pips (§29.3).

---

## 2. Opportunity-attack warnings

**What the references do**

- **DOS2.** "A red circle with a sword appears around that enemy while you're pointing at the movement destination." Engagement range depends on the weapon: "a spear's range is far greater than a dagger's" ([Fextralife DOS2 wiki: Opportunist](https://divinityoriginalsin2.wiki.fextralife.com/Opportunist)).
- **BG3.** "A sharp red arrow will point from the feet of an enemy toward you" ([GameRant](https://gamerant.com/baldurs-gate-3-bg3-how-avoid-opportunity-attacks-reaction-hit-melee-move/); [Jezner](https://www.jezner.com/2023/10/21/baldurs-gate-3-understanding-combat-basics/)). Patch 4 added a cursor message ([Patch 4](https://baldursgate3.game/news/patch-4-now-live_96)). Each reaction can be set to Ask, Always or Never, and a dialogue-bubble icon marks the ones set to Ask ([bg3.wiki: Reactions](https://bg3.wiki/wiki/Reactions)).
- **Complaints.** In the early-access forums (30/10/20), players asked for "the move line turn red, or some other blatantly apparent marking" ([Larian forums](https://forums.larian.com/ubbthreads.php?ubb=showflat&Number=723421)). Later (25–26/03/21) they reported that arrows are hard to see under large creatures and that "what the game shows me, i.e. the position circles under the creatures, is not the same as what the game uses for determining OA" ([Larian forums](https://forums.larian.com/ubbthreads.php?ubb=showflat&Number=767903)).

**Takeaways**

1. **[SPEC §8.6, AC-MOV-15]** Crossed-swords marker at the exit point. Tuning: a fixed **22 px** on screen (28 px on touch), drawn *above* tokens with no depth test and a 1-px ink outline, a `--warning` glyph on an ink disc. The marker sits on the path, not under the creature, which fixes the arrows-under-big-monsters complaint.
2. **[ADD] Warn at both ends.** While a path provokes, draw the threatening hostile's **reach ring** on the floor as a `--warning` hairline (1.5 px, dashed 6/4 px), measured from its base edge exactly as the rule check measures it: base radius + reach. It pulses gently on a 1.2-s cycle. Hovering the marker highlights the ring and hovering the ring highlights the marker. This combines DOS2's enemy marking with BG3's enemy-to-you arrow, and the ring always matches the rule geometry, which answers the "circles aren't what the game uses" complaint.
3. **[ADD] Put it in the label, not in the line colour.** `20 ft · 10 left · ⚔ Goblin 2`, or `⚔ 2` for two or more. Also break the ribbon with a **1-ft `--warning` notch** at each exit. Players asked for the whole line to turn red. In Gloam, `--path-over` already means "over budget", and giving one colour two meanings would repeat BG3's ambiguity, so use the notch, the label and the ring instead.
4. **[ADD] Tie-break to avoid provoking.** Among routes within **+5 ft** of the shortest, prefer the one with fewer provoking exits and say so: `… · avoids ⚔`. Never add more than 5 ft silently. This fixes the auto-path complaint without overriding the player.
5. **[TRAP] Suppression rules.** No warning for DM moves or Teleport, because teleporting and being moved without using your own movement don't provoke (SPEC §34.6, SRD p. 15). No warning from hostiles that are Incapacitated, since they can't take reactions (§34.1). Grey the marker out, "reaction used", for hostiles whose Reaction pip is marked used (§8.12). Word the tooltip "*Possible* opportunity attack from Goblin 2", because the rule depends on the attacker seeing the mover (T-9).
6. **[ADD] After the move, a nudge for the DM.** When a committed move crosses an exit, the DM gets an inline toast in the top-right stack (§28 Toast; not a modal, per §27.6): "Thorin left Goblin 2's reach — [Opportunity attack] [Ignore]". It lasts 8 s. [Opportunity attack] opens the normal attack resolution card with Goblin 2's Reaction pip pre-marked. This mirrors BG3's "Ask" reaction mode, and it is still a suggestion (P2), but it goes past §8.6's "hint only", so log it in DECISIONS.md.
7. **[TRAP]** The reach value has to reach the client (T-3).

**Avoid**

- Warnings you can't find, such as markers hidden under big creatures.
- Warning geometry that doesn't match the rule geometry.
- Warnings for opportunity attacks that can't happen (Teleport, Disengaged movers, Incapacitated hostiles).
- A red warning line that looks the same as over-budget.

---

## 3. Turn tracker, action economy and combat readability

**What the references do**

- **DOS2.** The top of the screen "always contains the current and the following turn"; enemy portraits are "encircled by a red garnishing". The cost of a pending skill turns its Action Point circles red before you commit ([gamepressure DOS2](https://www.gamepressure.com/originalsinii/combat/z09214)).
- **BG3.** The turn order runs across the top of the screen. The Action is a green circle and the Bonus Action an orange triangle, and each greys out once used ([Jezner](https://www.jezner.com/2023/10/21/baldurs-gate-3-understanding-combat-basics/)). Characters who join combat after the first round show "greyed out with an hourglass on it" ([bg3.wiki: Initiative](https://bg3.wiki/wiki/Initiative)). When combat starts, each character shows "a number from a d20" above its head ([Shacknews](https://www.shacknews.com/article/136590/combat-explainer-baldurs-gate-3)). Patch 4 split the combat log into rounds ("Combat rounds are now displayed under separate headings"), extended the colour-blind modes to turn-order frames, and added an option so End Turn needs "a hold instead of a tap" on a controller ([Patch 4](https://baldursgate3.game/news/patch-4-now-live_96)). The accuracy indicator shows a white number with "a red or a green circle fragment" for disadvantage or advantage ([gamepressure BG3](https://www.gamepressure.com/baldurs-gate-iii/combat/zed2dd)). Players built a mod to show "Reaction Points on Hotbar" ([mod.io](https://mod.io/g/baldursgate3/m/reaction-points-on-hotbar), [snippet]). Forum complaint about the hotbar: "I spend more time managing than playing" ([Larian forums](https://forums.larian.com/ubbthreads.php?ubb=showflat&Number=789683)).
- **Foundry.** Hidden combatants are removed from players' view entirely; defeated ones appear "faded out"; a tracker setting skips defeated combatants ([Foundry: Combat](https://foundryvtt.com/article/combat/)). In v13, turn markers appear beneath the active token with spin or pulse animations ([13.332](https://foundryvtt.com/releases/13.332)). A popular portrait-carousel module shows hover tooltips filtered by permission ([Carousel Combat Tracker](https://foundryvtt.com/packages/combat-tracker-dock), [snippet]).
- **Hit feedback.** Sakurai on hitstop: "the more damage an attack inflicts, the longer the hitstop period", with a cap. Characters "vibrate visually, but keep the hurtbox locations static"; grounded characters shake horizontally and airborne ones vertically ([Source Gaming translation of Sakurai's column](https://sourcegaming.info/2015/11/11/thoughts-on-hitstop-sakurais-famitsu-column-vol-490-1/)). Foundry's dynamic token ring can play "a simple animated effect… when the creature takes damage" or "glow when the creature is targeted" ([Foundry: Dynamic Token Rings](https://foundryvtt.com/article/dynamic-token-rings/)). The case for adding effects is "Juice It or Lose It" ([GDC Vault](https://gdcvault.com/play/1016789/Juice-It-or-Lose)); the counterpoint is that over-juicing costs immersion (Folmer Kelly, GDC Europe 2014, [Game Developer](https://www.gamedeveloper.com/design/video-indies-resist-the-urge-to-juice-it-or-lose-it-)). A DOS2 mod exists purely to reduce "number bloat" ([Nexus](https://www.nexusmods.com/divinityoriginalsin2/mods/58), [snippet], title only).

**Takeaways: turn strip and pips**

1. **[SPEC §8.12, §27.5]** Portrait sizes: **56 px** active, **44 px** next up, **40 px** for the rest. On phones, current + next two (spec) at 40/32 px. Turn start: the portrait swells over 220 ms (pop spring), a brass ring sweeps clockwise over 600 ms, and the "your turn" bell plays (§31). Strip names in Cinzel (§27.3).
2. **[SPEC §8.12]** Draw the round-wrap divider with the engraved brass divider ornament (§27.4) and a small "R3" label. When the round increments, the divider slides past the active slot over 320 ms (§27.5 panel), giving a physical "new round" beat.
3. **[ADD] Late joiners and the defeated.** Combatants added mid-round show at 50 % with an hourglass glyph until their first turn (the BG3 pattern). Defeated combatants are desaturated with the skull icon (§30.2), and the DM gets a "Skip defeated" tracker setting (the Foundry pattern).
4. **[ADD] Preview the cost on hover.** Hovering an attack or spell on the hotbar or sheet pulses the pip it would consume (opacity 100 → 40 %, 700-ms loop). For anything that costs movement, such as Stand up at half speed, a ghost segment appears on the movement bar. While you drag a token, the movement bar shows the previewed cost as a ghost segment in `--path-ok` / `--path-over`. This is DOS2's "cost turns red before you commit", translated.
5. **[ADD] Reactions visible off-turn.** Every combatant you control shows a tiny ◆ badge on its strip portrait: filled when the Reaction is available, hollow when used. Reactions happen on other creatures' turns, which is exactly when the action bar isn't showing them. Players cared enough about this to write a mod.
6. **[ADD] End turn safety.** The floating phone button needs a **400-ms hold** with a radial brass fill (BG3's hold option). Desktop Ctrl+Enter stays instant. On hover, the desktop End turn button's label changes to "End turn (Action unused)" or "(20 ft unused)": a warning in advance, not a modal.
7. **[ADD] Initiative reveal.** At Quick start, each combatant's initiative total floats above its token in the display face (28 px, `--accent`) for 1.5 s, then flies into its slot as the strip fills live (§8.12). Only tokens the viewer perceives take part. This is BG3's "d20 number above each head" beat.
8. **[ADD] Strip affordances.** Clicking a portrait focuses the camera on that token (the `F` behaviour) if you perceive it. A 400-ms hover shows the permission-filtered hover card (§8.5). The colour-blind swap covers the strip rings, plus a shape cue: hostile frames get a small notch at 12 o'clock (the BG3 Patch 4 lesson). The roll feed and campaign log insert "Round N" headings during combat (Patch 4).

**Takeaways: hit chance, damage preview and hit feedback**

1. **[TRAP] No hit percentage for players against NPCs** (T-8). BG3's ring works because a single-player game may know everything. A VTT with a DM can't copy it. Players see `+7 · ▲ ADV (Invisible)`; the DM's resolution card shows "hits on 12+ (45 %)".
2. **[ADD] Advantage and disadvantage badges.** ▲ ADV in `--success`, ▼ DIS in `--warning`, followed by the reason chips (§8.9 condition hints), on the roll button and the roll card. This carries the meaning of BG3's green and red fragments with shape and text.
3. **[SPEC §8.11, AC-HP-11] Floating numbers, tuned.** Rise 1.2 ft over 900 ms (ease-out), fading over the last 300 ms. Display face at 22 px; a critical hit is 28 px with a brass underline. The typed parts of one damage instance stack as **one group** (for example "12" in the slashing colour over "7" in the fire colour), not as separate floaters. Stagger separate instances by 120 ms. Cap each token at **3 live groups** and fold the rest into "+2 more". A miss is a small-caps "Miss" in `--text-muted` at 16 px with a short whoosh, not a number. Numbers appear only on tokens the viewer perceives (spec).
4. **[SPEC §8.11 + ADD] Hit reaction.** On impact, hold the victim's visual mesh still for 60–100 ms. Then shake it horizontally (vertically for flying tokens) with amplitude `clamp(damage / maxHP, 0.1, 0.6) × 0.35 ft`, three oscillations over 240 ms. The base and the logical position never move (Sakurai's static hurtbox). The base ring flashes `--danger` for 180 ms; healing glows `--success` for 400 ms (the Foundry ring pattern). A critical hit adds a two-frame brass spark and a 120-ms hold. With reduced motion on, only the ring flash plays.
5. **[ADD] Parity test for previews.** The damage preview ("Goblin takes 7 → 0 HP", §8.11), the AoE target list and the cover hint must come from the same `packages/shared` functions as the applied result. Add a randomised parity test like AC-MOV-02.
6. **[ADD] Restraint.** Shake the camera only for tokens *you* control, and only when one hit costs ≥ 25 % of max HP. Never shake the camera for other players' events: five people watch the same board, and the over-juicing critique applies.
7. **[TRAP, minor]** A floating number on an NPC shows damage *after* resistance, so it reveals resistances. That is usually fine at the table, but add a campaign setting "Damage numbers on NPCs: exact / hidden" (default exact) so the DM can choose.

**Avoid**

- Hotbar management overload (the Larian forum complaint). The action bar holds 1–9 slots plus the sheet; it doesn't auto-fill every spell.
- Floating numbers for events the viewer can't see. BG3 players report "0"s drifting in the background during dialogue ([snippet](https://steamcommunity.com/app/1086940/discussions/0/3808408963760305271)).
- Hit percentages that reveal hidden stats.
- Stacks of separate numbers for a single hit.

---

## 4. Walls, doors and zones editing

**What the references do**

- **Foundry walls.** Seven drawing tools: normal, terrain, invisible, ethereal, door, secret door and window. Each wall kind has its own colour on the Walls layer; for example, locked doors are red and secret doors dark magenta. Chaining requires "holding Ctrl… while placing a wall". Snapping uses an adaptive sub-grid (1/4 to 1/16 of a grid cell). Directional walls show "an arrow icon". When a player tries a locked door, "a 'locked' sound plays and the door remains closed". Doors animate (Ascend, Descend, Slide, Swing, Swivel) with a configurable duration ([Foundry: Walls](https://foundryvtt.com/article/walls/); [13.341](https://foundryvtt.com/releases/13.341)).
- **Foundry style guide.** Holding Shift, which disables sub-grid snapping, "is the most common cause of light leaking through walls". "Microwalls should be deleted." Prefer long segments ([Content Creation Style Guide](https://foundryvtt.com/article/content-creation-guide/)). Leak reports: vision "bleeds through" a T-junction of wall points ([lichtgeschwindigkeit #5](https://github.com/manuelVo/foundryvtt-lichtgeschwindigkeit/issues/5)); faint light leaks a short distance through walls ([foundry #10281](https://github.com/foundryvtt/foundryvtt/issues/10281)).
- **Smart Doors module.** Door icons "rendered the same size in every scene, regardless of the configured grid size". When a player tries a locked door, the attempt is announced. Secret doors are tinted grey "to make them easier to discern… when being zoomed further out" ([README](https://github.com/farling42/foundryvtt-smart-doors/blob/master/README.md)).
- **Owlbear Rodeo dynamic fog.** Walls are generated from fog shapes. Doors are made by dragging along a shape's edge. "When a door is closed the door path will be red… When a door is opened the door path will be green" ([extension page](https://extensions.owlbear.rodeo/dynamic-fog); [2.3 blog](https://blog.owlbear.rodeo/owlbear-rodeo-2-3-release-week-day-3/)).

**Takeaways**

1. **[SPEC §8.7]** Gloam chains by default (click, click, double-click or Esc to end), which is better than Foundry's hold-Ctrl chaining because it removes a mode error. Snap ring: 1 ft in the world, but at least **12 px** on screen. When snapped, the ring fills brass and plays a soft felt tick; when not snapped, it stays hollow. While drawing, the live segment shows its length (for example "12.5 ft") at its midpoint and, with Shift held, its angle ("45°").
2. **[TRAP/ADD] Make leaks impossible.**
   - (a) **Weld** any endpoint that lands within 0.1 ft of another endpoint, *even with Ctrl* (snapping off). The 1-ft snap is a user-facing feature; the 0.1-ft weld is geometric hygiene.
   - (b) When an endpoint lands on the interior of another segment, **split that segment** at the contact point, so T-junctions are real vertices.
   - (c) On commit, discard segments shorter than 0.25 ft ("microwalls").
   - (d) Add a DM **Check walls** action that puts `--warning` rings on unwelded endpoints within 0.5 ft of another wall, and on zero-length or duplicate segments.
   - Foundry's two leak reports and its style guide are the evidence.
3. **[TRAP]** Feathered fog must not pass through walls (T-5). This belongs to vision, but it shows up while editing walls, so the Check walls pass should include a leak probe.
4. **[SPEC §8.7 + ADD] Kinds by role and by pattern** in the DM walls overlay:
   - Wall: solid `--text`, 2 px.
   - Door: `--accent`, 3 px, with its handle.
   - Window: `--hp-temp`, double line.
   - Curtain: `--mental`, dotted.
   - Invisible wall: `--magic`, long dash.
   - Secret door: `--accent`, dashed, with a small wax-seal glyph (DM only).
   - Any kind hidden from players: 40 % opacity with an eye-slash glyph at the midpoint.
   Every kind differs by line pattern as well as colour (§8.22), unlike Foundry's colour-only coding.
5. **[SPEC §8.7 + ADD] Door handle.** A fixed **24 px** on screen with a **44 px** hit target on touch (Smart Doors lesson), billboarded at the midpoint. Its state shows by glyph, not only colour: closed door, door ajar, padlock. Hover shows either "Open" or the reason it can't be used: "Too far — 12 ft (need 5 ft)", "Locked". Render handles for players only on door segments they currently perceive or have in explored memory. That isn't a secret (doors are in state), but it avoids clutter and spoiling the layout of unexplored rooms.
6. **[SPEC §8.7 + ADD] Locked door.** The padlock glyph shakes three times over 180 ms and the metallic rattle plays (§31). The DM gets a toast: "Dave tried a locked door (Crypt door) — [Unlock]". Smart Doors announces the attempt in chat; Gloam has no chat (§41), so it uses a toast plus a log line.
7. **[SPEC §8.7]** In 3D, the door leaf swings over 300 ms (in-out easing). The creak starts at 0 ms; when closing, the thud lands at 300 ms, in sync with the leaf. Keep only the swing animation. Foundry's slide and ascend variants are scope creep.

**Avoid**

- Hold-to-chain modes.
- Door icons that shrink with the map scale.
- Letting "snapping off" also turn off welding.
- Colour-only kind coding.
- **Directional or proximity walls**: Foundry has them, but they are not in the §8.7 matrix, so this report doesn't propose them.

---

## 5. Lights and vision

**What the references do**

- **Foundry lighting.** Placing a light is "click and drag anywhere on a scene canvas"; editing is "double clicking the lightbulb icon". Shift+wheel rotates the emission angle, with Control "for finer adjustments". Right-clicking "the light source itself" toggles it. Bright and dim radii can each be 0, which "effectively disables that light level". Other settings: colour intensity (default 0.5), emission angle (default 360°), darkness activation range, luminosity, and animations (Torch, Flickering Light, Pulse and others) with speed, intensity and reverse. There are darkness sources and priorities ([Foundry: Lighting](https://foundryvtt.com/article/lighting/)). Style guide: lights look best with "logical, visible origins", and one light should stand in for a cluster of candles ([style guide](https://foundryvtt.com/article/content-creation-guide/)).
- **Foundry vision modes.** Darkvision desaturates areas "where no light source exists". Tremorsense is "similar to a radar sweep, which pulses and visually obscures the scene's background but preserves details such as fog exploration and wall placement". Vision modes (how things look) are kept separate from detection modes (what can be perceived) ([Foundry: Tokens](https://foundryvtt.com/article/tokens/)).
- **GM view helpers.** The GM Vision module "shows all tokens even if they wouldn't be visible normally" with "a hatched overlay", toggles with Ctrl+G, and its bulb icon is outlined when off and solid when on ([gm-vision](https://github.com/dev7355608/gm-vision)). Less Fog makes the fog "partially transparent, allowing the GM to see the entire map, while still indicating which portion… has not yet been revealed" ([lessfog](https://github.com/trdischat/lessfog)).
- **Owlbear dynamic fog.** Lights have Range, Angle and Edge (solid or blurred). "Secondary" lights stay hidden until the characters discover them. The fog has "soft shadows and feathered edges" ([extension](https://extensions.owlbear.rodeo/dynamic-fog); [2.3 blog](https://blog.owlbear.rodeo/owlbear-rodeo-2-3-release-week-day-3/)).
- **TaleSpire.** Line of sight hides minis that your creature can't see; the check runs "when you place a creature that you control" ([Dev Log 186](https://bouncyrock.com/news/articles/talespire-dev-log-186); [Tales Tavern guide](https://talestavern.com/the-ultimate-players-guide-to-talespire/)).

**Takeaways**

1. **[SPEC §8.8 + ADD] Placing a light.** Click-drag outward from the source point. The drag sets the **dim** radius, and the bright radius follows at 50 % (Foundry's default split). Radii snap to 5 ft (Ctrl for 1 ft). On release, an **inline popover** (never a modal, §27.6) offers preset chips from §34.3: Torch, Lantern, Candle, Light cantrip, and so on. Afterwards, handles on both rings resize them. Right-click the light's glyph to toggle it on or off (Foundry). The glyph is a fixed 28-px brass flame, hollow when off.
2. **[ADD, TRAP T-10] Flicker that's alive but safe.**
   - Seed each light's phase from its ID, so ten sconces don't pulse in unison.
   - Torch: 2–3 noise octaves at 4–10 Hz, luminance swing ≤ **8 %** of the light's intensity. Candle: ≤ 5 %. Pulse: 0.5–1 Hz.
   - WCAG 2.3.1 counts as a flash any pair of opposing luminance changes of ≥ 10 % that occurs more than three times a second over 25 % of any 10° field ([W3C](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html)). A close-up torch that swings more than 10 % at 8 Hz would break it.
   - Reduced motion halves flicker amplitude.
   - The lightning VFX flash (§24.5, "flickers 3 frames + flash") stays local, is never full-screen, and never exceeds 3 flashes per second.
3. **[ADD] Live footprint while editing.** While the DM drags a light or its handles, show its bright and dim footprint **clipped by walls** in real time, visible through the hatched fog, so the DM sees what players will get before letting go.
4. **[SPEC §8.8 + ADD] Tremorsense cue.** Borrow Foundry's radar-sweep idea but confine it to the sensing range: every 2 s a ring expands from the creature to its tremorsense range (`--hp-temp` at 30 % alpha, 600 ms), and the sensed markers (§8.8) blink on as the ring passes them. Don't obscure the whole screen as Foundry's mode does. Gloam's players need the map.
5. **[SPEC §8.8 + ADD] Make "View as" unmistakable.** A persistent brass banner under the tracker reads "Viewing as Dave · Esc to return". All DM-only overlays (walls, hatching, hidden tokens) switch off in this mode. The DM's normal fog hatching gets an opacity slider (20–80 %) in Vision & Fog, the Less Fog pattern. The toolbar icon shows the mode by shape (outlined vs solid eye) as well as colour, like GM Vision's bulb.
6. **[ADD] Help in total darkness.** If a player's creature currently perceives nothing because it is dark (no light, no darkvision, and no other sense in range), show a one-line hint chip: "It's pitch dark — you have no light." If the sheet carries a light source, add a [Light torch] button. Foundry's troubleshooting guide describes this same "why can't I see?" confusion: with Token Vision on and Global Illumination off, "tokens will need Lights, or have values set for their vision" ([Foundry: Troubleshooting Scene Loading](https://foundryvtt.com/article/ts-scene-loading/)).
7. **[SPEC §24.5 + §8.24]** Every free light in the demo gets a visible origin mesh (sconce, brazier), per Foundry's style guide. The DM Lights panel's "add free light" defaults to placing a small brazier or sconce glyph as well.

**Avoid**

- Unison flicker and strobing.
- Lights with no visible source.
- Modes a DM can forget they're in (View as without a banner).
- Tremorsense that blacks out the whole screen.
- **Sound-reactive lights**: Foundry v13 has them ([13.341](https://foundryvtt.com/releases/13.341)). Not proposed; scope creep.

---

## 6. Fog tools

**What the references do**

- **Owlbear Rodeo.**
  - The legacy tool used P (polygon), R (rectangle), B (brush), T (toggle), E (erase), C (cut), L (single or multi layer) and F (preview). Enter accepts a polygon, Esc cancels and Backspace removes the last point ([DeepWiki on the open-sourced 1.0](https://deepwiki.com/owlbear-rodeo/owlbear-rodeo-legacy/8.3-keyboard-shortcuts)).
  - In 1.8, single-layer mode replaced edge snapping because it "removes the need for you to be precise" and fixes "a build up of overlapping fog shapes that were hard to toggle" ([Patreon v1.8.0](https://www.patreon.com/posts/v1-8-0-released-47899653), [snippet]).
  - Version 2.4 has four operations (Fit, Overlay, Trim, Join), "Shift/Alt shortcuts to enable the Join and Trim modes temporarily", shape snapping, and **Forecast**, which auto-fogs a map and admits it "might miss hard to spot rooms" ([2.4 notes](https://blog.owlbear.rodeo/owlbear-rodeo-2-4-release-notes/)).
  - An "infinite fog plane" means "players will no longer see the edges of the base fog layer" ([Dev Log 3](https://blog.owlbear.rodeo/owlbear-rodeo-2-0-dev-log-3/)).
  - The developers compare static fog to "hiding parts of a dungeon from your players with pieces of paper" ([2.3](https://blog.owlbear.rodeo/owlbear-rodeo-2-3-release-week-day-3/)).
- **Foundry.** The Reset Fog of War button "resets the recorded Fog of War exploration for that scene for all Users" ([Foundry: Lighting](https://foundryvtt.com/article/lighting/)). Gloam's spec lets the DM reset per player *or* for everyone (AC-VIS-14), which is finer-grained.

**Takeaways**

1. **[SPEC §8.8, App. H]** B is the brush and R is Reveal room (spec). Inside the Fog tool, rectangle and polygon are sub-modes on the tool-options bar. Polygons follow Owlbear's and Gloam's own wall-drawing grammar: Enter accepts, Backspace removes the last point, Esc cancels.
2. **[ADD] Invert with a modifier.** Hold **Shift** while painting to swap reveal and hide temporarily (Owlbear's temporary-modifier pattern). Use Shift, not Alt: Alt+click pings everywhere (§8.18), and Shift has no meaning inside the Fog tool.
3. **[ADD] Brush cursor.** An outer ring shows the brush diameter in world feet; a faint inner ring shows the hard core inside the soft edge. `[` and `]` resize it inside the Fog tool (the template rotation keys only apply while placing a template, so there's no clash); Shift+wheel works too. **[TRAP]** Don't use Ctrl+wheel. Chrome and Firefox deliver trackpad pinch-zoom as wheel events with `ctrlKey: true`, so a DM pinching to zoom would resize the brush instead ([Dan Burzo, "Pinch me, I'm zooming"](https://danburzo.ro/dom-gestures/); [Mozilla bug 1052253](https://bugzilla.mozilla.org/show_bug.cgi?id=1052253)). "Brush 10 ft" shows beside the cursor for 800 ms after each change. Range 2.5–60 ft.
4. **[ADD] Preview Reveal room.** With R active, hovering shows the flood-fill region as a marching brass dashed outline (1.5 px) *before* the click. If the fill leaks because the room isn't closed, for example when it would cover more than 40 % of the scene, the outline turns `--warning` with "Room isn't closed — would reveal 62 % of the map", and the click needs Shift to confirm. This is the "might miss rooms" lesson from Forecast, applied to Gloam's own flood fill; the Check walls action (this doc §4) finds the gap.
5. **[SPEC §8.8 + ADD] Painting for a target.** The target selector shows player-colour chips in the tool options. When painting for particular players, the stroke preview is tinted with their colour and a legend reads "Painting for: Dave, Mira". Reveals animate over 300 ms (spec), with the war fog appearing to burn back from the stroke.
6. **[ADD] No fog edges.** The players' war fog extends past the scene bounds into the table's fade-out (§8.4), so fog never ends in a hard rectangle (the Owlbear "infinite fog plane" lesson).
7. **[SPEC AC-UNDO-01, AC-VIS-14]** Each stroke is one undo step. "Reset explored memory" names who is affected in its confirmation ("Reset for Dave only" or "for everyone").

**Avoid**

- Vector fog shapes that pile up. Gloam's raster fog (§15.8) avoids this by construction, so don't switch to shapes.
- Tools that demand precision.
- One-click reveals that silently leak into the whole dungeon.
- **Computer-vision auto-fog** (Forecast): not proposed. Reveal room covers the need deterministically.

---

## 7. Tokens and the radial menu

**What the references do**

- **Foundry Token HUD.** Right-click opens it: editable resource bars, status effects ("small icons overlaid on the token art in the upper left corner"), elevation, a target toggle and a combat toggle ([Foundry: Tokens](https://foundryvtt.com/article/tokens/)). A popular module adds "a repositionable HUD of actions for a selected token", so rolls happen without opening the sheet ([Token Action HUD](https://github.com/Larkinabout/fvtt-token-action-hud-core), [snippet]).
- **TaleSpire.** "Hold left-click to drag the mini around". Shift+click teleports. Alt+drag rotates. Flyers move up and down with Control. Right-clicking a mini gives health, emotes, stats and a torch toggle. Holding Tab shows every mini's name ([Tales Tavern guide](https://talestavern.com/the-ultimate-players-guide-to-talespire/)). A *third-party* re-implementation describes the pick-up feel as a mini that "lifts and tilts, its contact shadow stays on the ground, and a tether runs to the hover location" ([thirdfold issue #287](https://github.com/tougenrip/thirdfold/issues/287), [snippet]; this is not TaleSpire's own documentation). PC Gamer described a tilt-shift look that makes the minis read as figurines ([PC Gamer](https://www.pcgamer.com/talespire-wants-to-be-the-digital-tabletop-roleplaying-system-of-your-dreams/), [snippet]).
- **Radial-menu evidence.** "Eight seems to be the reasonable maximum for radial menus" ([Big Medium](https://bigmedium.com/ideas/radial-menus-for-touch-ui.html)). Pie menus are "harder to learn" at first but gain with familiarity; implementations where you "tap items after lifting" lose the movement-time advantage ([NN/g](https://www.nngroup.com/articles/expandable-menus/)).
- **BG3.** Persistent combat outlines drew complaints that they make models look "misplaced and cartoony" ([Larian forums](https://forums.larian.com/ubbthreads.php?ubb=showflat&Number=665361)).

**Takeaways**

1. **[SPEC §8.5 + ADD] Pick-up and put-down feel.**
   - On drag start, the real mini lifts **0.6 ft** over 120 ms (pop spring) and tilts up to **6°** toward the drag direction, scaled by pointer velocity.
   - Its contact shadow stays on the floor, getting slightly softer as the mini rises. The translucent ghost follows the pointer (spec).
   - The pick-up "felt tap" plays (§31).
   - On drop: a 3 % squash, a 180-ms settle, the felt tap and the first footstep thump.
   - With reduced motion: no tilt or squash, an 80-ms fade.
2. **[ADD] A fixed angle for every action.** Each action has its own slot. Suggested: Sheet at 12 o'clock, Damage/Heal at 2, Conditions at 4, Target at 6, Light at 8, Emote at 10, Elevation and Facing sharing the remaining slots on flyers. An action the viewer isn't allowed to use leaves its slot **empty** instead of repacking the ring, so muscle memory survives. AC-TOK-06 is still met because only permitted actions are present.
3. **[ADD] No more than 8 slices per ring.** Players see at most eight options. DM-only actions (Hide/Reveal, Lock, Duplicate, Delete, Count as movement, and the §8.19 overrides) sit behind one **"DM ▸"** slice that opens a second ring. §8.5 lists 12 or more possible actions, which is beyond the 8-slice guideline.
4. **[ADD] Marking-menu selection.** Press the right button (or hold a finger), drag toward a slice, release to select. This works alongside click-to-open and click-to-select. Slice hit areas reach out to the screen edge (Fitts). A 24-px dead zone in the centre cancels. Keys 1–8 select (spec). On touch, the ring opens after a 450-ms long-press (this doc §12).
5. **[ADD] Base-ring states** (Foundry's dynamic-ring idea, drawn on Gloam's base ring): **targeted** is a brass dashed ring rotating once every 12 s plus a crosshair glyph; **damaged** is a 180-ms `--danger` flash; **healed** is a 400-ms `--success` glow; **selected** is the brass glow pulse (spec). These stay subtle, per the complaint about BG3's heavy outlines.
6. **[ADD] Reveal every name.** Hold **Q** to show all name plates and HP bars, ignoring the far-zoom fade (§8.5); this is TaleSpire's hold-Tab. Tab itself can't be used because it is keyboard focus navigation (§8.22). Q is free in Appendix H.
7. **[SPEC §29.3, App. H]** The bottom action bar with hotbar slots 1–9 plays the role of Foundry's popular token action HUD. Make sure attacks, spells, checks and saves can all be dragged from the sheet into slots, so everyday rolls never need the sheet open.

**Avoid**

- HUD buttons scaled by token size, which makes them tiny on Tiny creatures.
- Status icons painted over the token art (Foundry). Gloam's placement under the HP bar (§8.5) is right.
- Rings that reshuffle depending on permissions.
- Rings with more than 8 slices.
- Hidden destructive actions. A reviewer found deleting a token in Owlbear unintuitive: "you need to grab it with the hand tool and then move it; this causes a 'trash can' icon to appear" ([Lair of Secrets](https://lairofsecrets.com/gaming/review-owlbear-rodeo/)). Keep Delete as a labelled DM slice with an undo toast.

---

## 8. Measurement and AoE templates

**What the references do**

- **Foundry.** Circle, cone ("about 53 degrees"), rectangle and ray shapes are placed by click-and-drag. To rotate one, hover its origin and use Shift+wheel (Control for "smaller adjustments"). "Gridless maps will not show highlighted spaces, though it will still show the area of the effect." Right-clicking the origin hides a template, and its icon turns orange ([Foundry: Measurement](https://foundryvtt.com/article/measurement/)). The ruler chains with Ctrl+click, and Space moves your token to the end of the ruler ([Foundry: Tokens](https://foundryvtt.com/article/tokens/)).
- **Owlbear Rodeo.** The ruler redesign added "flat sides, division indicators and a large center text". Rulers now persist and can be moved ([Dev Log 3](https://blog.owlbear.rodeo/owlbear-rodeo-2-0-dev-log-3/)).
- **TaleSpire.** M opens line, cone and sphere rulers; you adjust them by dragging their white dots, and the cone angle is customisable ([Tales Tavern](https://talestavern.com/the-ultimate-players-guide-to-talespire/)).
- **BG3.** Tooltips show range as "a dashed line connecting two dots" and radius as a "circle drawn by compass" ([GamerGuides](https://www.gamerguides.com/baldurs-gate-3/guide/gameplay/getting-started/spell-duration-range-casting-time-and-concentration-explained)). [unverified] Enemies inside a Fireball circle are outlined red while aiming, and the cursor says "Target out of range" or "No line of sight"; this came only from search summaries.

**Takeaways**

1. **[SPEC §8.13, §17.3 + ADD] Range ring and reasons.** A dashed `--accent` ring (1.5 px, 8/6 dash) marks the spell's range from the caster's base edge. It brightens while the pointer is inside and turns `--warning` outside. An invalid template turns red and hatched (spec) **and** gets a reason chip at its origin: "Out of range · 150 ft max · 172 ft" or "No line of effect — wall". For the wall case, the blocking segment glows briefly. This is the "say why" rule.
2. **[SPEC §8.13 + ADD] Highlight by role.** Hostiles get a `--warning` outline. **Allies and party** get a brass outline with a small warning glyph (friendly fire). The caster gets a `--magic` outline when "Include myself" applies. Creatures blocked by a wall get a hollow ring with a wall glyph, matching the card's "blocked" row (§29.5). A live chip on the template reads "4 creatures · 1 ally". Gloam has no grid, so highlight **creatures** rather than squares (§41), filling the gap Foundry leaves on gridless maps.
3. **[SPEC §8.13 + ADD] Rotation.** `[`/`]` or the wheel turn the template in 15° steps (spec). Shift+`[`/`]` (or Shift+wheel) gives **1° fine rotation** (Foundry offers a finer adjustment on Control+wheel, but in a browser Ctrl+wheel is also what a trackpad pinch sends; see this doc §6 item 3). **[TRAP]** A trackpad's two-finger scroll sends a stream of small wheel deltas, and pinching sends ctrl+wheel. Accumulate `deltaY` and step 15° per ~100 px of travel (not per event), and send ctrl+wheel (a pinch) to camera zoom rather than rotation, or the template will spin. A "45°" readout chip shows while rotating. On touch, the rotate handle (spec) is a 44-px knob at the template's far edge that snaps to 15° unless you hold it for 400 ms first, which unlocks free rotation.
4. **[ADD] Rulers.** Tick marks every 5 ft with longer ticks every 30 ft (Owlbear's "division indicators"). The total sits at the end in the display face at 22 px; each segment's length sits at its midpoint at 13 px. Handles stay draggable until Esc, as in TaleSpire, so you can adjust instead of re-measuring. The 3-s share (spec) sends the final shape.
5. **[TRAP T-6]** "Share my rulers" defaults to off for DMs; holding Shift while finishing keeps one measurement private.
6. **[TRAP]** Keep AoE **aiming** local. §8.13 already broadcasts only the confirmed cast (the VFX). Don't add an aiming-preview broadcast later: a DM who aims and then cancels would leak the intent.

**Avoid**

- Rulers that litter the board (Owlbear's rulers persist until removed). Gloam's timed share plus Esc is better.
- Rotation that can only be coarse.
- Templates that highlight nothing on a gridless board.
- Invalid states with no reason given.

---

## 9. Dice feel

**What the references do**

- **Owlbear Rodeo.** Deterministic physics lets everyone share "the feeling of seeing a dice teeter on a natural 2 then fall to land on a 20". Each player's tray is visible to the others as a small preview window that expands on click. Players see only that a hidden GM roll happened, not its result. Materials change the sound: "a plastic d4 will have lighter hit sounds compared to the low thunk of the metal d20" ([Dice deep dive](https://blog.owlbear.rodeo/owlbear-rodeo-2-0-dice-deep-dive/)). Dice were merged into the party sidebar so each roll is tied to a player ([Towards 2.0](https://blog.owlbear.rodeo/towards-owlbear-rodeo-2-0-2/)).
- **Roll20.** Other players see your 3D dice only if they have enabled them too. The dice "stay on the tabletop after you roll them until you either interact with the tabletop… or make another roll", and they take the player's colour ([Roll20 help](https://help.roll20.net/hc/en-us/articles/360039715613-3D-Dice), [snippet]). The whispered-roll leak is described in this doc §0.
- **TaleSpire.** You pick dice, then "click and drag your left mouse button over this pop up then shake your mouse" to throw; everyone sees the results; a history is available ([Tales Tavern](https://talestavern.com/the-ultimate-players-guide-to-talespire/)). Dice thrown off-screen or into thick atmospheric fog get lost, and players have asked for a picture-in-picture view ([feedback board](https://feedback.talespire.com/p/dice-thrown-off-screen-or-into-atmospheric-fog-displays-a-pip-of-each-dice), [snippet]). There is also the clutter complaint (this doc §0) and a report of 300+ dice crashing clients ([issue tracker](https://github.com/Bouncyrock/TaleSpire-Beta-Public-Issue-Tracker/issues/1007), [snippet]).
- **Tabletop Simulator.** Players ask for an "invisible fence" so dice stop rolling off the table, and for dice that don't knock over the pieces ([Steam](https://steamcommunity.com/app/286160/discussions/0/2860219962100958287/), [snippet]).
- **Dice So Nice (Foundry).** "Ghost dice" show "faceless dice to players on GM/Blind rolls", and a keybinding will "instantly dismiss visible dice" ([guide](https://riccisi.gitlab.io/foundryvtt-dice-so-nice/guide/getting-started/)). Some users want GM secret rolls hidden entirely, "without alerting a player that a roll has been made" ([issue #360](https://gitlab.com/riccisi/foundryvtt-dice-so-nice/-/issues/360)).
- [unverified] I could not find a readable description of how Alchemy RPG presents dice.

**Takeaways**

1. **[SPEC §8.9, §18.4]** Rolling dice in a HUD overlay, with invisible tray walls and no contact with the board, is confirmed right: it avoids TaleSpire's lost dice and TTS's knocked-over pieces. Keep the tray area to roughly the **lower-middle 60 % × 45 %** of the viewport, so the tracker and the active token stay visible.
2. **[SPEC §8.9 + ADD] The result beat.** After the last die sleeps: a **120-ms pause**, then the total pops into the roll card (pop spring) with the settle tick (§31). A natural 20 turns the number gold, plays the rising shimmer and fires a one-shot brass spark around that die (bloom-eligible, §24.6; ≤ 3 flashes, T-10). A natural 1 dims the die by 30 % and plays the deflating womp.
3. **[ADD] Dismiss on demand.** Clicking or tapping empty tray space, or pressing Esc, clears settled dice at once (Dice So Nice's dismiss key). Otherwise they fade at 2.5 s (spec). Dice never wait for a click, which is the Roll20 behaviour to avoid.
4. **[ADD] Show who is rolling.** While a player's dice tumble, their portrait in the party list and the turn strip shows a small spinning d20 glyph in their colour, and a skeleton roll card saying "Mira is rolling…" appears immediately. Owlbear ties dice to players in the same way.
5. **[TRAP T-2] Masked rolls reveal nothing about their contents.** They animate a **fixed** generic "?" throw. Add an [ADD] DM roll option, **Silent** (no masked card at all), for the "don't alert players" use case. The default stays "The DM rolls…" (§8.9).
6. **[ADD, optional] Flick to throw.** A flick on the Roll button (mouse or touch) sets the throw direction and strength, clamped and validated. It travels in the roll request and comes back in `RollResult`, so every client's deterministic simulation uses the same vector. The number is still the server's, through the symmetry remap (§18.4). This captures TaleSpire's most tactile dice moment without giving up server authority.
7. **[SPEC §8.9, §31 + ADD]** Contact sounds scale with impulse, and the pitch varies by material (Owlbear confirms it's worth the effort). Cap simultaneous clack voices at 8, and duck other sound effects by −6 dB while dice roll. The tray surface should *sound* like felt over wood.
8. **[SPEC AC-DICE-09]** At most 20 physical dice, the rest shown as chips. TaleSpire's 300-dice crash confirms the cap.

**Avoid**

- Dice that stay until clicked.
- Dice that world geometry or fog can hide.
- Dice that collide with the board.
- Masked animations that reveal what was rolled.
- Forcing 3D dice on anyone. The per-device toggle stays (§8.22).
- **Physical dice that persist on the table** (Roll20): rejected.

---

## 10. Pings, emotes and social

**What the references do**

- **Foundry pings.** Pressing and holding makes "a pulsing circle… using your selected user color". Alt+hold makes "a pulsing red triangle" (a warning). Shift+hold (GM) moves every user's camera. Anyone not looking at the ping sees "a pulsing arrow along the edge of the UI indicating the direction of the ping" ([Foundry: Pings](https://foundryvtt.com/article/pings/)).
- **Owlbear pointer.** It leaves a trail, shows "who is using the pointer as a tag above the pointer", and shows "directional indicators when off-screen" ([Dev Log 3](https://blog.owlbear.rodeo/owlbear-rodeo-2-0-dev-log-3/)). Players choose the pointer's colour ([v1.8.0](https://www.patreon.com/posts/v1-8-0-released-47899653), [snippet]).
- **TaleSpire.** Emotes live in the mini's right-click menu ([Tales Tavern](https://talestavern.com/the-ultimate-players-guide-to-talespire/)).

**Takeaways**

1. **[SPEC §8.18, §31] How a ping looks.** Three rings expand from 0 to 6 ft over 900 ms each, 150 ms apart, in the player's colour fading from 80 % to 0 % alpha. A 12-px solid dot lingers for 2.5 s, with the player's name (Cinzel 12) below it. The sonar sound is **panned** by the ping's horizontal screen position (a `StereoPannerNode`), so you can hear roughly where it is.
2. **[ADD] Off-screen indicator.** When a ping, emote or the active combatant is outside your view, a chevron in that player's colour sits on the screen edge pointing at it, with the name, for 3 s. Clicking it flies the camera there (400 ms; a jump cut with reduced motion). Both Foundry and Owlbear do this.
3. **[SPEC §8.18] Spotlight.** Alt+Shift+click pulls cameras (spec). Don't change the pulled players' zoom unless they're zoomed out past 200 ft. Whether a pull-ping should also set zoom has been argued about in Foundry's tracker ([issue #7763](https://github.com/foundryvtt/foundryvtt/issues/7763), [snippet]).
4. **[SPEC §8.18 + ADD] The emote wheel exceeds 8 slices.** It holds 12 emotes, 8 phrases and up to 6 custom phrases. Layout: an **inner ring of 8** favourite emotes (reorderable), an **outer ring** of the other 4 emotes and the 8 phrases, and custom phrases as a strip beneath. Keys: `E` opens it, 1–8 pick from the inner ring, Shift+1–8 from the outer. Animation: pop 0 → 1.15 → 1 over 220 ms, float up 0.5 ft, fade over the last 400 ms of the 2.5 s (spec), with the bubbly pop sound (§31).
5. **[TRAP T-4]** Emote placement is decided per viewer.
6. **[ADD, low priority] Warning ping.** Hold Alt+click for 600 ms (or long-press on touch for 1 s) to get an ember triangle ping instead of the ring: Foundry's warning ping. Take it or leave it; it adds a gesture.

**Avoid**

- Pings nobody notices because they're off-screen.
- Social bubbles that reveal positions.
- Unlimited ping spam. The spec already rate-limits `ping.send` to 3/s (§13.5).
- **Chat or voice as a social channel**: out of scope (§41). Everything here is non-verbal on purpose.

---

## 11. Camera

**What the references do**

- **TaleSpire.** WASD or right-drag pans; holding the middle button and dragging rotates; the wheel zooms "limited to a maximum and minimum height"; F2 or double-clicking a portrait recentres ([Tales Tavern](https://talestavern.com/the-ultimate-players-guide-to-talespire/)). Reviewers: "the controls and camera movement can be finicky, especially when maps are built with roofs and interiors" ([Gnome Stew](https://gnomestew.com/a-3d-vtt-roundup-and-review/)); "camera occlusion" hurts readability ([Advanced RPGs](https://advancedrpgs.com/talespire-review-3d-battle-maps-table-use-and-limits/)).
- **Other 3D VTTs.** Foundry's 3D Canvas module has a camera "more akin to a 3D builder like blender than an FPS… the biggest complaint from all the players"; Rolltable was "the first 3D VTT that I instantly understood how to use" ([Gnome Stew](https://gnomestew.com/a-3d-vtt-roundup-and-review/)).
- **BG3.** Middle-drag rotates, O toggles the "top-down tactical camera", Home centres on the selected character, and the camera can feel "clunky… when Goblins are raining arrows down upon you from a second story" ([PCGamesN](https://www.pcgamesn.com/baldurs-gate-3/camera-controls)). [snippet/unverified] Players dislike an automatic combat camera that jumps between characters.

**Takeaways**

1. **[SPEC §8.4]** The control mapping is right: left-drag pans, right-drag orbits, the wheel dollies toward the cursor, and `T` flips between top-down and tabletop (the same idea as BG3's O). **[ADD]** Arrow keys pan, since W, D and E are taken by walls, dice and emotes in Appendix H, so WASD isn't available. **Home** is an alias for `F` (focus).
2. **[ADD] Getting your bearings back.** A small brass compass rose (36 px) sits bottom-right of the board. Click it to turn north-up (400 ms); double-click it for the Tabletop preset. This fixes the disorientation after orbiting that TaleSpire's reviewers describe.
3. **[ADD] Wall cut-away** (Walls in 3D, §8.7). When an 8-ft wall stands between the camera and a token you control or have selected, dither-fade that wall to 25 % within a 6-ft radius of the token, and draw your own tokens' silhouettes through walls. Apply it only to tokens the viewer already perceives, so it can't leak anything. This addresses the occlusion complaints from both TaleSpire and BG3.
4. **[SPEC §8.12, AC-CMB-05]** Turn focus stays opt-in. **Never move the camera for other creatures' turns.** Instead, pulse the active portrait and show the off-screen chevron (this doc §10) when the active token is out of view.
5. **[ADD] Soft limits.** At the pitch, distance and bounds clamps (§8.4), ease into the limit with a 120-ms spring instead of stopping dead, so the user feels a limit rather than a failed input.
6. **[ADD, optional, Ultra only]** A subtle depth-of-field focused on the camera target at the Tabletop and Low presets (off at top-down) gives the miniature, tilt-shift reading PC Gamer noticed in TaleSpire. It isn't in the §24.6 chain, so it has to fit the performance budget or be dropped.

**Avoid**

- Blender-style modifier camera schemes.
- Auto-follow in combat.
- Hard stops at the clamps.
- Having no "reset" or "north".
- Letting walls hide your own mini.

---

## 12. Touch and phone

**What the references do**

- **Platform numbers.**
  - Android: `DEFAULT_LONG_PRESS_TIMEOUT = 400` ms, `DOUBLE_TAP_TIMEOUT = 300` ms, `TOUCH_SLOP = 8` dp ([AOSP ViewConfiguration.java](https://android.googlesource.com/platform/frameworks/base/+/master/core/java/android/view/ViewConfiguration.java)).
  - iOS: long-press minimum 0.5 s with 10-pt allowable movement ([Apple](https://developer.apple.com/documentation/uikit/uilongpressgesturerecognizer/minimumpressduration), [snippet]). Hit targets at least 44 × 44 pt ([Apple HIG: Accessibility](https://developers.apple.com/design/human-interface-guidelines/foundations/accessibility), [snippet]).
  - WCAG 2.5.1: multipoint gestures need a single-pointer alternative, for example "a map… supports the pinch/spread gesture… the map also includes plus/minus buttons" ([W3C](https://www.w3.org/WAI/WCAG22/Understanding/pointer-gestures.html)). WCAG 2.5.7: dragging needs a non-drag alternative ([W3C](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)).
- **Foundry.** "Does not support mobile devices as part of the core software", and it "will not work via iPad at this time" ([Foundry FAQ](https://foundryvtt.com/article/faq/)). It is "designed for mouse and keyboard" with a 1366 × 768 minimum ([Requirements](https://foundryvtt.com/article/requirements/)).
- **Roll20.** Retired its mobile app on 18 Feb 2026 because "the current experience sucks compared to the standards we've committed to", betting instead on the mobile browser ([Roll20 blog](https://blog.roll20.net/posts/were-retiring-the-roll20-mobile-app-to-build-something-better-heres-why/)). Its mobile browser users "won't see maps or move tokens" ([Roll20 help](https://help.roll20.net/hc/en-us/articles/4411213438231-Roll20-Mobile-App-FAQ), [snippet]).
- **Owlbear Rodeo.** The 2.0 redesign is "a lot more compact horizontally which will help the UI scale better on phones" ([Towards 2.0](https://blog.owlbear.rodeo/towards-owlbear-rodeo-2-0-2/)).

**Takeaways**

1. **[SPEC §8.21 + ADD] Gesture timings.**
   - Tap: ≤ 250 ms and ≤ 10 px.
   - Long-press: **450 ms** (between Android's 400 and iOS's 500) with **10-px slop**. A brass ring grows under the finger from 150 ms onward, so the user sees the long-press coming and can cancel by moving.
   - Double-tap: 300-ms window.
   - Drag: begins after 10 px, with pointer capture (spec).
2. **[ADD] Lock two-finger gestures.** Classify within the first 12 px or 8°: a change in finger distance means zoom; a change in angle means orbit; the two fingers moving vertically together means tilt. Lock that choice for the rest of the gesture, so orbit never creeps in while pinching.
3. **[ADD, WCAG 2.5.1 / 2.5.7] Single-pointer alternatives.** The phone and tablet camera button (App. H) expands into a cluster: + and − zoom, rotate 45° left and right, and the three pitch presets. Tap token, then tap floor, is the non-drag way to move (click-to-move defaults on in §8.6; keep it on for touch).
4. **[ADD] Keep labels out from under the finger.** The path label, ruler label and template reason chip sit **64 px above** the touch point and flip below near the top. The max-reach marker gets a 44-px ring while touch is active (§8.21's 44-px minimum).
5. **[SPEC §8.21 + ADD] Bottom sheets and the board.** While a sheet is at 60 % or higher, move the camera target up by half the sheet's height, so the token you're acting on stays visible above it.
6. **[ADD] End turn** on touch needs the 400-ms hold (this doc §3, turn-strip item 6).
7. **[ADD] Haptics.** Android only, as a progressive enhancement: 8 ms when a long-press is recognised and when the budget is crossed. iOS Safari lacks `navigator.vibrate`, and it is "not Baseline" ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/vibrate)). There is always a visual equivalent (AC-A11Y-05).

**Avoid**

- A separate native app (Roll20 retired theirs).
- A phone mode where you can't see the map or move your token (Roll20's mobile browser).
- Assuming desktop only (Foundry).
- Combined pinch-and-twist without a lock.
- Labels hidden under the thumb.

---

## 13. Onboarding and joining

**What the references do**

- **Owlbear Rodeo 2.0.** "Moving away from the password protected rooms" to a **request-access** flow. On the request screen, "you can set your name… and ask to join the room". Anonymous players need no account. "Once a player has been accepted into a room they will be able to come back to this room at any time". A kicked player "will need to request access again" ([Dev Log 7](https://blog.owlbear.rodeo/owlbear-rodeo-dev-log-7/); [docs](https://docs.owlbear.rodeo/docs/getting-started/), [snippet]).
- **Owlbear review.** "What you see is what you get"; setup takes about 10 minutes ([Lair of Secrets](https://lairofsecrets.com/gaming/review-owlbear-rodeo/)).
- **TaleSpire.** "Requires every person to own their own copy of the game", which is a barrier for casual play ([Gnome Stew](https://gnomestew.com/a-3d-vtt-roundup-and-review/)).

**Takeaways**

1. **[SPEC §8.2]** Gloam's code → identity → waiting room → knock → admit flow matches Owlbear's request-to-join model, which is the confirmation. Returning players recognised by device cookie ("Welcome back, Dave") are the equivalent of Owlbear's "come back at any time".
2. **[ADD + TRAP] One-tap join from Discord.** Accept the invite code in the URL **fragment** (`…/join#7K2QH-9XM4D`) to pre-fill the code step. Still require a press of **Knock on the door**: no auto-submit, so link-preview bots can't knock (they don't run JavaScript, and fragments are never sent to a server anyway). A fragment never reaches the server, the tunnel logs or `Referer`. After reading it, clear it with `history.replaceState`. Add the fragment URL to "Copy Discord message" (AC-HOST-05). Rate limits (AC-AUTH-01) are unchanged.
3. **[SPEC §8.2 + ADD] Waiting-room feedback.** "The DM has been notified · waiting 0:42", with a live timer. After 2 minutes a gentle line: "The DM might be mid-scene — draw your character while you wait". This gives players the certainty that someone knows they're there, which Owlbear's request flow provides.
4. **[ADD] First-time coachmarks** (AC-DEMO-03 requires guidance text). One-line, brass-edged hints anchored to the relevant control, shown **once per profile**, dismissible, never modal (§27.6):
   - First board load: "Drag your token to move · right-drag to look around".
   - First combat turn: "Your turn — move, then End turn (Ctrl+Enter)".
   - First long-press on touch.
   - First DM wall tool: "Click to chain walls · double-click to finish".
5. **[SPEC §8.2]** Name and colour are chosen before knocking and shown on the DM's knock card with the sound (spec), matching Owlbear's "set your name… ask to join".

**Avoid**

- Passwords pasted into Discord (Owlbear moved away from them).
- Accounts or per-player purchases.
- Setup longer than about 10 minutes for players. Owlbear's benchmark; Gloam's players only type a code.

---

## 14. Explicitly *not* proposed

Out of scope under SPEC §41 or not SRD:

- **Grid highlighting** of affected squares (Foundry): Gloam is gridless (§41). Highlight creatures instead (this doc §8).
- **Chat-based notifications** (Smart Doors' chat message, chat-card rolls): no chat (§41). Use toasts and log entries.
- **Voice or text chat** for social features (§41).
- **Jump arcs, climbing previews and automatic falling** (BG3): jumping and falling automation are out of scope (§41). The spec's elevation stepper for flyers covers vertical placement.
- **High-ground attack bonus** (BG3's +2 at 2.5 m, [bg3.wiki](https://bg3.wiki/wiki/High_ground_rules), [snippet]) and DOS2's height damage boost and extended range ring: these are the games' own rules, not SRD 5.2.1. Adding them as defaults would put homebrew into the rules engine. A DM can still narrate them.
- **Elemental surfaces** (DOS2): not SRD. Gloam's hazard zones and persistent effects cover the tabletop equivalent.
- **Directional or proximity walls, sound-reactive lights, computer-vision auto-fog**: not in the spec's feature set. See this doc §4, §5 and §6.

---

## 15. Unverified or inaccessible

- **Blocked sites.** Steam Community threads, Nexus Mods pages, docs.owlbear.rodeo, the Roll20 help centre and wiki, GameFAQs and developer.apple.com all refused automated fetches. Claims from them are marked [snippet] and rest on search summaries. The PC Gamer articles were truncated to their headlines.
- **BG3 and DOS2 at the end of movement.** Exactly what they draw where movement runs out (colour, truncation, label) could not be confirmed.
- **BG3 movement meter.** Its location and colour: two guides disagree (orange strip above the hotbar vs blue circle bottom-right).
- **BG3 AoE aiming.** That enemies inside an AoE circle are outlined red while aiming, and the exact cursor strings ("Target out of range", "No line of sight"), come from search summaries only.
- **BG3 turn order.** Whether BG3 or DOS2 draw a divider where the round wraps, and how BG3 shows hidden enemies in the turn order: not found.
- **BG3 combat camera.** Player dislike of BG3's automatic combat camera comes from search summaries only.
- **Floating numbers.** The colour schemes of floating damage numbers in BG3 and DOS2: not documented anywhere readable.
- **Foundry pings.** Default durations and sizes: the API documents `duration` and `size` but not their defaults ([PingOptions](https://foundryvtt.com/api/v12/interfaces/client.PingOptions.html)).
- **Foundry door controls.** When players can see them: the API confirms only that they are "always visible if the user is a GM and no Tokens are controlled" ([DoorControl](https://foundryvtt.com/api/classes/foundry.canvas.containers.DoorControl.html)).
- **TaleSpire pick-up feel.** The lift, tilt and tether description is from a third-party clone's issue tracker, not Bouncyrock.
- **TaleSpire atmosphere.** Its time-of-day controls appear only in that same third-party project's issues, so they are not used here.
- **Alchemy RPG.** How it presents dice: not found.
