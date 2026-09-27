# R1 — Rules verification against SRD 5.2.1

Phase 0 task R1 (SPEC §32). Every table and bullet of SPEC §34, plus the §19.3 condition matrix, checked against the official PDF.
All text is paraphrased. Page numbers are printed page numbers, and they match the PDF page index in both documents.

## Sources and method

| Source | File | SHA-256 | Bytes | Pages |
|---|---|---|---|---|
| SRD 5.2.1 (pinned, SPEC §33.1) | `packages/content/.cache/SRD_CC_v5.2.1.pdf` | `8974902d109d6e63672d7c490bde9ccf052410503d9cfa768237154fbc5e3d87` (matches pin) | 6 031 375 (matches pin) | 364 (matches pin) |
| SRD 5.1 | `packages/content/.cache/SRD_CC_v5.1.pdf` from `https://media.wizards.com/2023/downloads/dnd/SRD_CC_v5.1.pdf` (downloaded 2026-09-27) | `2504d2a0abb0a4d491a939be4f17910a2dde0312570ab8d208080225ccf0a1f0` | 3 158 713 | 403 |

- Both PDFs were dumped one text file per page with `packages/content/scripts/dump-pdf-text.ts` (pdfjs, two columns rebuilt from glyph positions). The files are `.cache/srd-5.2.1-text/pNNN.txt` and `.cache/srd-5.1-text/pNNN.txt`. For both PDFs, each page's footer matches its file index, so the file number is the printed page.
- Spell counts come from a script that counts every spell header line ("Level N School (…)" or "School Cantrip (…)"; for 5.1, "Nth-level school" or "school cantrip") in the spell chapters. For 5.2.1 that is pp. 107–175. For 5.1 it is pp. 114–194.
- Citations use the form "SRD 5.2.1 p. N" or "SRD 5.1 p. N". When a rule's header and body fall on different pages, both pages are given.
- Legend: ✓ = matches the SRD. ✗ = differs, and the SRD's version is stated. ◐ = correct but incomplete, ambiguous, or cited to the wrong page.
- Limitation: I could not render PDF pages as images here (`pdftoppm` is not installed), so every check used the text layer of the hash-verified PDF. Tables were read from the text layer and cross-checked against the prose around them.

---

## 34.1 Conditions

General: conditions don't stack, except Exhaustion. ✓ SRD 5.2.1 p. 179 ("Condition"). The same page lists all 15 conditions. ✓

| Condition | SPEC claim | Result |
|---|---|---|
| Blinded | Can't see; automatically fails checks that need sight; attacks against it have Advantage; its attacks have Disadvantage | ✓ p. 177 |
| Charmed | Can't attack the charmer or target it with damaging effects; charmer has Advantage on social checks | ✓ p. 178. The SRD wording is "damaging abilities or magical effects". |
| Deafened | Can't hear; automatically fails checks that need hearing | ✓ p. 181 |
| Exhaustion | Levels are cumulative; D20 Tests −2 × level; Speed −5 ft × level; death at level 6; a Long Rest removes one level | ✓ p. 181. The condition ends when the level reaches 0. |
| Frightened | Disadvantage on checks and attacks while the source is in line of sight; can't willingly move closer to the source | ✓ p. 182 |
| Grappled | Speed 0; Disadvantage on attacks against anyone but the grappler; the grappler can drag it (+1 ft per ft unless it is Tiny or 2+ sizes smaller); escape takes an action, Athletics or Acrobatics vs DC 8 + Str mod + PB | ◐ pp. 182, 190. Speed is 0 and can't increase. The grappler can carry it as well as drag it. The escape check is made against "the grapple's escape DC" (p. 182). **8 + Str mod + PB is the DC for Unarmed Strike grapples only (p. 190).** Monster grapples use the DC printed in the stat block. The condition also ends if the grappler is Incapacitated or the target moves beyond the grapple's range, and the grappler can release it at will (p. 182). |
| Incapacitated | No action, Bonus Action or Reaction; concentration breaks; can't speak; Disadvantage on Initiative | ✓ p. 184 |
| Invisible | Advantage on Initiative; unaffected by effects that need to see it (unless the creator can); gear hidden too; attacks against it have Disadvantage and its attacks have Advantage unless the other creature can see it | ✓ p. 184 |
| Paralyzed | Incapacitated; Speed 0; auto-fails Str and Dex saves; attacks against it have Advantage; hits from within 5 ft are crits | ✓ p. 186 |
| Petrified | As Paralyzed but without automatic crits; Resistance to all damage; immune to Poisoned; weight ×10 | ✓ p. 186. It also stops aging. Nonmagical gear it wears or carries turns to stone with it. |
| Poisoned | Disadvantage on attack rolls and ability checks | ✓ p. 186 |
| Prone | Can only crawl, or spend half its Speed to stand (not at Speed 0); its attacks have Disadvantage; attacks against it have Advantage within 5 ft and Disadvantage beyond; dropping Prone is free | ✓ pp. 186, 14. Standing costs half Speed rounded down (p. 186). Dropping Prone isn't possible at Speed 0 (p. 14). |
| Restrained | Speed 0; attacks against it have Advantage; its attacks have Disadvantage; Disadvantage on Dex saves | ✓ p. 187 |
| Stunned | Incapacitated; auto-fails Str and Dex saves; attacks against it have Advantage; no Speed 0 in 5.2.1 | ✓ p. 189. The SRD gives no Speed effect. |
| Unconscious | Incapacitated and Prone (stays Prone when it ends); drops what it holds; Speed 0; attacks against it have Advantage; auto-fails Str and Dex saves; hits from within 5 ft are crits; unaware of its surroundings | ✓ p. 191 |

## 19.3 Condition metadata matrix

Each cell of SPEC §19.3 was checked against the condition's glossary entry (pages as in 34.1).

| Condition | speedZero | incapacitated | noSight | autoFail Str/Dex | Against it | Its attacks | Other | Verdict |
|---|---|---|---|---|---|---|---|---|
| Blinded | – ✓ | – ✓ | ✓ ✓ | – ✓ | adv ✓ | dis ✓ | fails sight checks ✓ | ✓ p. 177 |
| Charmed | – ✓ | – ✓ | – ✓ | – ✓ | – ✓ | can't target charmer ✓ | charmer adv. on social checks ✓ | ✓ p. 178 |
| Deafened | – ✓ | – ✓ | – ✓ | – ✓ | – ✓ | – ✓ | fails hearing checks ✓ | ✓ p. 181 |
| Exhaustion | – ✓ | – ✓ | – ✓ | – ✓ | – ✓ | – ✓ | −2×lvl, −5 ft×lvl, dies at 6 ✓ | ✓ p. 181 |
| Frightened | – ✓ | – ✓ | – ✓ | – ✓ | – ✓ | dis while source in sight ✓ | dis on checks; can't approach ✓ | ✓ p. 182 |
| Grappled | ✓ ✓ | – ✓ | – ✓ | – ✓ | – ✓ | dis vs anyone but the grappler ✓ | – | ✓ p. 182 |
| Incapacitated | – ✓ | ✓ ✓ | – ✓ | – ✓ | – ✓ | – ✓ | no actions/BA/reactions; breaks conc.; dis on Initiative ✓ | ◐ p. 184. The row omits **can't speak**, which rules out spells with a Verbal component. |
| Invisible | – ✓ | – ✓ | – ✓ | – ✓ | dis unless seen ✓ | adv unless seen ✓ | adv on Initiative ✓ | ✓ p. 184 |
| Paralyzed | ✓ ✓ | ✓ ✓ | – ✓ | ✓ ✓ | adv; crit within 5 ft ✓ | – ✓ | – | ✓ p. 186 |
| Petrified | ✓ ✓ | ✓ ✓ | – ✓ | ✓ ✓ | adv ✓ | – ✓ | Resistance to all damage ✓ | ◐ p. 186. The row omits **immunity to the Poisoned condition**. |
| Poisoned | – ✓ | – ✓ | – ✓ | – ✓ | – ✓ | dis ✓ | dis on checks ✓ | ✓ p. 186 |
| Prone | – ✓ | – ✓ | – ✓ | – ✓ | adv within 5 ft, else dis ✓ | dis ✓ | crawl ×2, stand = half Speed ✓ | ✓ p. 186 |
| Restrained | ✓ ✓ | – ✓ | – ✓ | – ✓ | adv ✓ | dis ✓ | dis on Dex saves ✓ | ✓ p. 187 |
| Stunned | – ✓ | ✓ ✓ | – ✓ | ✓ ✓ | adv ✓ | – ✓ | 5.1 only: can't move ✓ (SRD 5.1 p. 359) | ✓ p. 189 |
| Unconscious | ✓ ✓ | ✓ ✓ | ✓ ◐ | ✓ ✓ | adv; crit within 5 ft ✓ | – ✓ | also Prone; drops items ✓ | ✓ p. 191. noSight is inferred: the SRD says "unaware of your surroundings", not "can't see". The inference is reasonable. |

**Implementation traps (volunteered):**

1. **Unconscious includes Prone.** Attacks against an Unconscious creature from beyond 5 ft get Advantage from Unconscious and Disadvantage from Prone. Advantage and Disadvantage cancel, so the roll is normal (cancel rule: SRD 5.2.1 p. 176 Advantage, p. 181 Disadvantage). Within 5 ft the roll has Advantage and a hit is a crit. The engine must **combine** the flags of every condition present (including implied ones). It must never let one condition's `attacksAgainst` value override another's. The same applies to Paralyzed, Petrified, Stunned and Unconscious, which all imply Incapacitated.
2. **Conditional flags.** Grappled's Disadvantage applies to every target except the grappler, and Frightened's Disadvantage applies only while its source is in line of sight. The engine can only evaluate these if the condition stores its **source** (SPEC §8.11 already records one, e.g. "from Dragon").
3. **Speed 0 "can't increase".** Grappled, Paralyzed, Petrified, Restrained and Unconscious all say the Speed is 0 and can't increase (pp. 182–191). Dash, Haste and DM `bonusMove` must not lift it. SPEC §19.4 lets `bonusMove` bypass the Dash doubling, but it must still be 0 under a speedZero condition.
4. **Special speeds follow Speed.** Anything that reduces, halves or zeroes Speed changes every special speed by the same amount for the same duration (SRD 5.2.1 p. 188). This covers Exhaustion, Slow, Grappled and the rest. SPEC §19.4's per-mode formula agrees.

## 34.2 Status-related glossary

| SPEC bullet | Result |
|---|---|
| **Bloodied** (p. 177): at half HP or fewer; no effect on its own (p. 16); not in 5.1 | ✓ SRD 5.2.1 pp. 177, 16. It has no game effect by itself but can trigger other effects. The word doesn't appear anywhere in the SRD 5.1 text. |
| **Concentration** (p. 179): ends on starting another concentration effect, on Incapacitated or on death; damage forces a Con save, DC = max(10, half the damage), max 30 | ✓ SRD 5.2.1 p. 179. It breaks when you *start casting* the other spell or activate the other effect. Half the damage is rounded down. The creator can end it at any time. |
| **Heroic Inspiration** (p. 183): spend to reroll any die just rolled, keeping the new roll; hold at most one | ✓ SRD 5.2.1 p. 183. Only player characters have it. If you gain one while already holding one, the new one is lost unless you give it to a PC who lacks it. |
| **Surprise** (pp. 13, 189): Disadvantage on the Initiative roll; 5.1: no move or action on the first turn and no Reaction until it ends | ✓ SRD 5.2.1 pp. 13, 189; SRD 5.1 p. 90. |
| **Hide** (p. 183): DC 15 Dex (Stealth) while Heavily Obscured or behind three-quarters/total cover and out of enemies' line of sight; grants Invisible; the total is the Perception DC to find you; ends on noise above a whisper, being found, attacking, or casting a Verbal spell | ✓ SRD 5.2.1 p. 183. The SRD says "make an attack roll". |
| **0 HP** (pp. 17–18): monsters die unless the GM decides otherwise; PCs fall Unconscious and make death saves. Stable = 0 HP, no death saves, still Unconscious, regains 1 HP after 1d4 hours. A revived creature loses its attunements and returns with one fewer Exhaustion level | ◐ The first sentences are ✓ SRD 5.2.1 pp. 17–18. **The revival clauses are on p. 180 (glossary "Dead"), not pp. 17–18.** p. 180 also says a revived creature keeps any ongoing conditions, contagions and curses whose durations haven't expired. Also on p. 17: a creature whose HP **maximum** drops to 0 dies. |
| **Temporary HP** (p. 18): lost first; don't stack (choose which to keep); last until used up or a Long Rest; aren't healing; don't restore consciousness | ✓ SRD 5.2.1 p. 18. Healing can't restore them, and a creature at full HP can still receive them. |
| **Burning** (hazard, p. 178): 1d4 fire damage at the start of each turn; an action and going Prone puts it out | ✓ SRD 5.2.1 p. 178. Dousing, submerging or smothering also puts it out. |
| **Rests**, pages to be confirmed by R1 | Pages confirmed: **Short Rest SRD 5.2.1 p. 187**, **Long Rest SRD 5.2.1 p. 185**. Details below. |

Rest details:

- **Short Rest ◐** (p. 187). It lasts 1 hour, and you need at least 1 HP to start. Each Hit Die spent restores the die roll + Con modifier, **with a minimum of 1 HP per die**; SPEC omits this minimum. You decide whether to spend another die after each roll. Rolling Initiative, casting any spell other than a cantrip, or taking damage interrupts it, and an interrupted Short Rest gives no benefit.
- **Long Rest ✓/◐** (p. 185). It lasts at least 8 hours (6 asleep, during which you are Unconscious), and you need at least 1 HP to start. You regain all HP and all spent Hit Dice, a reduced HP maximum returns to normal, and Exhaustion drops by 1. **Reduced ability scores are also restored**, which SPEC omits. Another Long Rest can't start for 16 hours. Initiative, a non-cantrip spell, any damage, or 1 hour of exertion interrupts it. If at least 1 hour had passed before the interruption, you get Short Rest benefits. You can resume the rest by adding 1 hour per interruption.
- **Temporary HP:** they end with a Long Rest (p. 18) ✓.
- **Features:** their recharge is stated per feature ✓ (pp. 185, 187, "Special Feature").
- **SRD 5.1 Long Rest ✓:** regain all HP and spent Hit Dice up to half your total, minimum one (SRD 5.1 p. 87). Only one Long Rest per 24 hours, and you need at least 1 HP (SRD 5.1 p. 87).

## 34.3 Vision, light and senses

| SPEC bullet | Result |
|---|---|
| **Light** (p. 11): Bright Light is normal; Dim Light makes an area Lightly Obscured; Darkness (including magical Darkness) makes it Heavily Obscured | ✓ SRD 5.2.1 p. 11. The glossary entries on pp. 178, 180 and 181 say the same. |
| **Obscurement** (pp. 182, 184): Lightly Obscured gives Disadvantage on sight-based Perception; Heavily Obscured gives Blinded when trying to see something there | ✓ SRD 5.2.1 pp. 182, 184, and p. 11 |
| **Blindsight** (p. 177): within range, sees anything not behind Total Cover, even while Blinded or in Darkness, including Invisible creatures | ✓ SRD 5.2.1 p. 177 |
| **Darkvision** (p. 180): Dim Light counts as Bright, and Darkness as Dim; greyscale in Darkness | ✓ SRD 5.2.1 p. 180 |
| **Tremorsense** (p. 190): pinpoints creatures and moving objects within range that touch the same surface or liquid; nothing in the air; doesn't count as sight | ✓ SRD 5.2.1 p. 190 |
| **Truesight** (p. 190): sees through normal and magical Darkness, sees Invisible creatures and objects, visual illusions look transparent, sees true forms, sees into the Ethereal Plane | ✓ SRD 5.2.1 p. 190. SPEC omits that the creature also **automatically succeeds on saves against visual illusions**. |

Light sources:

| Row | Bright | +Dim | Duration | Notes | Result |
|---|---|---|---|---|---|
| Candle | 5 | 5 | 1 h | | ✓ SRD 5.2.1 p. 96 |
| Torch | 20 | 20 | 1 h | | ✓ SRD 5.2.1 p. 100. It can also be used as a Simple Melee weapon that deals 1 Fire damage. |
| Lamp | 15 | 30 | 6 h per flask | | ✓ SRD 5.2.1 p. 98 (entry) and p. 99 (Oil: a flask burns 6 h, not necessarily all at once; putting it out or relighting it is a Utilize action) |
| Hooded Lantern | 30 | 30 | 6 h per flask | Bonus Action to lower the hood, leaving Dim Light in 5 ft only | ✓ SRD 5.2.1 p. 98. The duration comes from Oil on p. 99, but SPEC cites only p. 98. The hood can also be raised again as a Bonus Action. |
| Bullseye Lantern | 60-ft Cone | 60 | 6 h per flask | Cone ≈ 53.13° | ✓ SRD 5.2.1 p. 98 (duration p. 99). The 53.13° is derived: a Cone's width equals its distance from the origin (p. 179), so the full angle is 2·atan(½) = 53.13°. |
| Tinderbox | — | — | — | Lighting a Candle, Lamp, Lantern or Torch takes a Bonus Action | ✓ SRD 5.2.1 p. 100. This covers anything with exposed fuel. Lighting any other fire takes 1 minute. |

## 34.4 Light, darkness, obscurement and sense spells

Checked row by row against each spell's entry. Pages are where the spell's name appears. A second page means its effect text continues there.

| Spell | Page | Lvl | Light | Obscurement / sense | Shape | Moves? | Conc. | Result |
|---|---|---|---|---|---|---|---|---|
| Light | 144 ✓ | 0 ✓ | 20/20 ✓ | — | touched object, Large or smaller ✓ | with object ✓ | no, 1 h ✓ | ✓. The light can be any colour, an opaque cover blocks it, and recasting ends the previous casting. |
| Dancing Lights | 121 ✓ (text p. 122) | 0 ✓ | Dim 10 per light, up to 4 ✓ | — | each light within 20 ft of another, range 120 ✓ | Bonus Action: up to 60 ft ✓ | yes, 1 min ✓ | ✓. A light vanishes if it leaves the spell's range. The four can be merged into one Medium humanoid shape. |
| Starry Wisp | 165 ✓ | 0 ✓ | Dim 10 on the target ✓ | target can't benefit from Invisible ✓ | target | with target ✓ | — | ✓. Duration is Instantaneous, but the light and anti-Invisible effect last **until the end of the caster's next turn**, and only on a hit. |
| Produce Flame | 156 ✓ | 0 ✓ | 20/20 ✓ | — | in hand ✓ | with caster ✓ | no, 10 min ✓ | ✓. Cast as a Bonus Action. |
| Continual Flame | 119 ✓ | 2 ✓ | 20/20 ✓ | — | touched object ✓ | with object ✓ | no, until dispelled ✓ | ✓ |
| Flame Blade | 132 ✓ | 2 ✓ | 10/10 ✓ | — | in hand ✓ | with caster ✓ | yes, 10 min ✓ | ✓ |
| Flaming Sphere | 132 ✓ | 2 ✓ | 20/20 ✓ | — | "5-ft sphere" ◐ | Bonus Action: 30 ft ✓ | yes, 1 min | ◐ The sphere is **5 ft in diameter**. Damage hits creatures ending their turn **within 5 ft of** it (p. 132). |
| Shining Smite | 162 ✓ | 2 ✓ | Bright 5 on the target ✓ | target can't be Invisible ✓ | target | with target ✓ | **✗ SPEC "—"** | ✗ The SRD gives **Concentration, up to 1 minute** (p. 162). It also gives **attack rolls against the target Advantage**, which SPEC omits. |
| Faerie Fire | 129 ✓ | 1 ✓ | Dim 10 per outlined target ✓ | no Invisible benefit ✓ | 20-ft Cube ✓ | with targets ✓ | yes, 1 min ✓ | ✓. Objects in the Cube are outlined automatically; creatures only on a failed Dex save. Attacks against them have Advantage if the attacker can see them. |
| Moonbeam | 150 ✓ (text p. 151) | 2 ✓ | Dim fills the area ✓ | — | Cylinder r 5, h 40 ✓ | Magic action: 60 ft ✓ | yes, 1 min ✓ | ✓ |
| Daylight | 122 ✓ | 3 ✓ | Bright in area, +60 Dim ✓ | dispels spell Darkness of level 3 or lower where they overlap ✓ | Sphere r 60, or 60-ft Emanation from an object ✓ | object version moves ✓ (Emanation rule, p. 181) | no, 1 h ✓ | ✓. An opaque cover blocks the light. |
| Fire Shield | 132 ✓ | 4 ✓ | 10/10 ✓ | — | self ✓ | with caster ✓ | no, 10 min ✓ | ✓ |
| Wall of Fire | 172 ✓ | 4 ✓ | not stated ✓ | wall is opaque ✓ | up to 60×20×1 ft, or ring up to 20 ft across ×20×1 ✓ | fixed ✓ | yes, 1 min ✓ | ✓ |
| Conjure Celestial | **no page in SPEC → 118** | 7 ✓ | Bright fills area ✓ | — | Cylinder r 10, h 40 ✓ | can move 30 ft when you move ✓ | yes ✓, **up to 10 min** | ◐ The page is missing from SPEC: it is SRD 5.2.1 p. 118. The duration is 10 minutes. |
| Sunbeam | 166 ✓ | 6 ✓ | 30/30 sunlight from a mote above you ✓ | — | Line 60 × 5 ✓ | mote moves with caster ✓ | yes, 1 min ✓ | ✓ |
| Sunburst | 167 ✓ | 8 ✓ | — ✓ | dispels any spell's Darkness in its area ✓ | Sphere r 60 ✓ | instantaneous ✓ | no ✓ | ✓ |
| Prismatic Wall | 155 ✓ | 9 ✓ | Bright within 100, +100 Dim ✓ | opaque ✓ | wall ✓ | fixed ✓ | — (10 min, no conc.) ✓ | ✓. Size: a wall up to 90 ft long × 30 ft high × 1 inch thick, or a globe up to 30 ft in diameter. Creatures that see it and come within 20 ft must save or be Blinded. |
| Darkness | 122 ✓ | 2 ✓ | — | magical Darkness; Darkvision can't see through it; nonmagical light can't light it; dispels spell light of level 2 or lower where they overlap ✓ | Sphere r 15, or 15-ft Emanation from an object ✓ | object version moves ✓ | yes, 10 min ✓ | ✓. An opaque cover blocks it. |
| Fog Cloud | 133 ✓ | 1 ✓ | — | Heavily Obscured ✓ | Sphere r 20, +20 per slot above 1 ✓ | fixed; strong wind disperses it ✓ | yes, 1 h ✓ | ✓ |
| Sleet Storm | 163 ✓ | 3 ✓ | douses exposed flames ✓ | Heavily Obscured; Difficult Terrain ✓ | Cylinder r 20, h 40 ✓ | fixed ✓ | yes, 1 min ✓ | ✓. On a failed Dex save a creature falls Prone **and loses Concentration**. |
| Stinking Cloud | 165 ✓ | 3 ✓ | — | Heavily Obscured ✓ | Sphere r 20 ✓ | fixed; wind disperses it ✓ | yes, 1 min ✓ | ✓ |
| Cloudkill | 116 ✓ | 5 ✓ | — | Heavily Obscured ✓ | Sphere r 20 ✓ | moves 10 ft away from you at the start of each of your turns ✓ | yes, 10 min ✓ | ✓. Strong wind disperses it and ends the spell. |
| Incendiary Cloud | 142 ✓ (text p. 143) | 8 ✓ | — | Heavily Obscured ✓ | Sphere r 20 ✓ | ◐ | yes, 1 min ✓ | ◐ It moves 10 ft **away from you**, in a direction you choose, at the start of each of your turns. SPEC drops "away from you". Strong wind disperses it. |
| Web | 174 ✓ | 2 ✓ | — | Lightly Obscured; Difficult Terrain ✓ | 20-ft Cube ✓ | fixed ✓ | yes, **1 h** ✓ | ✓. If it isn't anchored, it collapses at the start of your next turn. |
| Insect Plague | 143 ✓ | 5 ✓ | — | Lightly Obscured ◐ | Sphere r 20 ✓ | fixed ✓ | yes, 10 min ✓ | ◐ The area is **also Difficult Terrain** (p. 143). |
| Tiny Hut | 169 ✓ | 3 (ritual) ✓ | interior can be Dim or Dark ✓ | opaque from outside, transparent from inside ✓ | 10-ft Emanation, stationary ✓ | fixed ✓ | no, 8 h ✓ | ✓. Spells of level 3 or lower can't pass through it. |
| Silence | 162 ✓ | 2 (ritual) ✓ | — | no sound; Deafened while entirely inside; Thunder immunity; no Verbal spells ✓ | Sphere r 20 ✓ | fixed ✓ | yes, 10 min ✓ | ✓ |
| Darkvision | 122 ✓ | 2 ✓ | — | grants Darkvision 150 ft ✓ (5.1: 60 ft ✓, SRD 5.1 p. 133) | touch ✓ | on target ✓ | no, 8 h ✓ | ✓ |
| See Invisibility | 160 ✓ | 2 ✓ | — | sees Invisible creatures and objects and into the Ethereal Plane ✓ | self ✓ | on caster ✓ | no, 1 h ✓ | ✓ |
| True Seeing | 171 ✓ | 6 ✓ | — | grants Truesight 120 ft ✓ | touch ✓ | on target ✓ | no, 1 h ✓ | ✓ |
| Invisibility | 143 ✓ | 2 ✓ | — | Invisible; ends after the target makes an attack roll, deals damage or casts a spell; +1 target per slot above 2 ✓ | touch ✓ | on target ✓ | yes, 1 h ✓ | ✓ |
| Greater Invisibility | 137 ✓ | 4 ✓ | — | Invisible; doesn't end early ✓ | touch ✓ | on target ✓ | yes, 1 min ✓ | ✓ |

Notes below the table:

- **Hunger of Hadar** appears in neither SRD. There is no match anywhere in the 5.2.1 or 5.1 text ✓.
- **Arcane Eye:** its eye has Darkvision 30 ft ✓ SRD 5.2.1 p. 110.
- **Hallow** has Darkness and Daylight options ✓ SRD 5.2.1 p. 138; the Daylight option's text is on p. 139. In each option, the other kind of spell can't override it only if that spell is of a lower level.
- **Gust of Wind** disperses gas or vapour ✓ p. 138. It also puts out candles and unprotected flames, and has a 50% chance to put out protected flames such as lanterns.
- **Wind Wall** keeps fog, smoke and gases away ✓ p. 174.

## 34.5 Areas of effect

| SPEC bullet | Result |
|---|---|
| Line of effect: every area has a point of origin; a location is excluded if every straight line to it is blocked, and only Total Cover blocks a line; an unseen origin behind a wall appears on your side of it; targeting needs a clear path (p. 106) | ✓ SRD 5.2.1 p. 177 (Area of Effect) and p. 106 (A Clear Path to the Target). |
| Cone (p. 179): width equals distance; the effect sets the length; origin excluded unless chosen | ✓ SRD 5.2.1 p. 179 |
| Cube (p. 179): origin anywhere on a face; size is the side length; origin excluded unless chosen | ✓ SRD 5.2.1 p. 179 |
| Cylinder (p. 180): origin at the centre of the top or bottom circle; the effect sets radius and height; origin included | ✓ SRD 5.2.1 p. 180 |
| Emanation (p. 181): spreads from a creature or object; moves with it unless instantaneous or stationary; the origin is excluded unless chosen | ✓ SRD 5.2.1 p. 181 |
| Line (p. 184): the effect sets length and width; origin excluded unless chosen | ✓ SRD 5.2.1 p. 184 |
| Sphere (p. 188): radius from the origin; origin included | ✓ SRD 5.2.1 p. 188 |
| 5.1 has the same Total Cover rule and no Emanation shape | ✓ SRD 5.1 pp. 102–103 lists five shapes and gives the Total Cover rule. The near-side-of-obstruction rule is also on SRD 5.1 p. 102. In 5.1 a Cylinder's origin is the centre of a circle on the ground or at the top of the effect (p. 103). |

## 34.6 Movement and combat

| SPEC bullet | Result |
|---|---|
| **Your turn** (pp. 13–14): move up to your Speed and take one action, splitting movement around it; one free object interaction | ✓ SRD 5.2.1 pp. 13–14. The free interaction happens during your move or action; a second needs the Utilize action (p. 13; also p. 12). |
| **Difficult terrain** (pp. 14, 181): +1 ft per ft; never cumulative | ✓ SRD 5.2.1 pp. 14, 181. On a grid, a Difficult square costs 2 squares (p. 13). The list on p. 181 includes a creature that isn't Tiny or your ally, and a slope of 20° or more. |
| **Climbing, crawling, swimming** (pp. 178, 179, 189): +1 ft per ft (+2 in Difficult Terrain); a Climb or Swim Speed removes the extra cost | ✓ SRD 5.2.1 p. 178 (Climbing), p. 179 (Crawling), p. 189 (Swimming). |
| **Dash** (p. 180): extra movement equal to your Speed; a special speed can be used instead | ✓ SRD 5.2.1 p. 180. The extra movement is your Speed **after modifiers**. |
| **Jumps** (pp. 183–185): long jump up to your Str score in feet after a 10-ft run-up (half standing); high jump 3 + Str mod ft (minimum 0; half standing); each foot jumped costs a foot of movement | ✓ SRD 5.2.1 p. 183 (High Jump), pp. 184–185 (Long Jump). Landing a long jump in Difficult Terrain needs a DC 10 Acrobatics check or you fall Prone (p. 185). |
| **Moving through creatures** (p. 14): allies, Incapacitated creatures, Tiny creatures, or one "two or more sizes" larger or smaller; a non-Tiny, non-ally space is Difficult Terrain; you can't end your move in another creature's space; ending your turn there leaves you Prone unless you are Tiny or larger | ◐ SRD 5.2.1 p. 14. The SRD says "**two sizes** larger or smaller", without "or more". Reading it as "at least two" matches SRD 5.1's "at least two sizes" (SRD 5.1 p. 92) and is almost certainly intended, but it is an interpretation and should be logged. The rest ✓. 5.1 comparison ✓ SRD 5.1 p. 92. |
| **Size and space** (p. 14): Tiny 2½, Small/Medium 5, Large 10, Huge 15, Gargantuan 20 | ✓ SRD 5.2.1 p. 14. A square holds 4 Tiny creatures. |
| **Initiative** (p. 13): a Dexterity check; one roll per group of identical creatures; optional fixed score 10 + Dex mod, ±5 for Advantage/Disadvantage (p. 184) | ✓ SRD 5.2.1 pp. 13, 184. On a tie, the GM orders monsters and players order their characters; the GM decides a monster–PC tie (pp. 13–14). This isn't in §34 but is relevant to SPEC's house rule. |
| **Actions** (pp. 9–10): Attack, Dash, Disengage, Dodge, Help (also stabilises: DC 10 Wis (Medicine)), Hide, Influence (DC max(15, target's Int)), Magic, Ready (a readied spell needs Concentration), Search, Study, Utilize | ✓ SRD 5.2.1 pp. 9–10 (Actions table). Help's first-aid use is in the table (p. 10); the stabilise check is on **p. 18** ("Stabilizing a Character"). The glossary Help entry (pp. 182–183) lists only Assist an Ability Check and Assist an Attack Roll. Influence DC: p. 184. Ready and Concentration: p. 187. |
| **Bonus Action** (p. 10): only when a feature grants one; at most one per turn. **Reaction** (p. 10): one until the start of your next turn; resolves right after its trigger | ✓ SRD 5.2.1 p. 10, with the glossary on pp. 177 and 186. Anything that stops you taking actions also stops Bonus Actions (p. 10). |
| **Opportunity attack** (pp. 15, 185): triggered when a creature you can see leaves your reach using its action, Bonus Action, Reaction or a speed; your Reaction makes one melee attack just before it leaves; Disengage, teleporting and forced movement don't provoke | ✓ SRD 5.2.1 pp. 15, 185, and p. 190 (Teleportation never provokes). |
| **Cover** (p. 15): half +2 to AC and Dex saves; three-quarters +5; total means it can't be targeted directly; only the best degree applies | ✓ SRD 5.2.1 p. 15 (also p. 179). Cover counts only if the attack or effect comes from the opposite side of it (p. 15). |
| **Death saving throws** (pp. 17–18) | ✓ SRD 5.2.1 pp. 17–18. Successes and failures reset when the creature regains HP or becomes Stable (p. 17). |
| **Massive damage / Critical hit** (p. 16) | ✓ Massive damage: SRD 5.2.1 p. 17 (SPEC gives no page; it applies to characters). Critical Hit doubles the damage dice: p. 16 (also p. 179). |
| **Damage types** (p. 180): 13 types | ✓ SRD 5.2.1 p. 180 |
| **Order of adjustments** (p. 17): bonuses, penalties and multipliers; then Resistance (halve, round down); then Vulnerability (double); each at most once per instance; Immunity means no damage | ✓ SRD 5.2.1 p. 17, with the glossary on pp. 187 and 191. SPEC §19.2's code follows this order. |

Also volunteered, because the movement and combat engines need these rules (not in §34):

- **Grid rules**, SRD 5.2.1 p. 13. Every square costs 1 to enter, diagonals included; there is no 5-10-5 rule. Diagonal moves can't cut the corner of a wall or other space-filling feature. Range on a grid is counted from a square adjacent to one creature to the other's space, by the shortest route.
- **Unseen attackers and targets**, p. 14. Attacking a target you can't see has Disadvantage. Attacking a creature that can't see you has Advantage. A hidden attacker reveals its location when the attack hits or misses.
- **Ranged attacks in close combat**, p. 16. A ranged attack has Disadvantage if you are within 5 ft of an enemy who can see you and isn't Incapacitated. A shot beyond normal range has Disadvantage, and nothing can be targeted beyond long range.
- **Switching speeds**, p. 188. When you change to another speed, subtract the distance already moved from the new speed. This matches SPEC §19.4, which keeps `used` across a mode switch.
- **Falling**, p. 182. A fall deals 1d6 Bludgeoning per 10 ft, to a maximum of 20d6, and you land Prone unless you took no damage. A flier falls if it is Incapacitated, falls Prone, or its Fly Speed drops to 0, unless it can hover.
- **Knocking out a creature**, pp. 17, 184. A melee attack that would drop a creature to 0 HP can leave it at 1 HP and Unconscious instead.

## 34.7 Spell counts

I counted the headers myself (method above).

| Claim | Result |
|---|---|
| SRD 5.2.1: 339 spells, 27 / 57 / 57 / 42 / 34 / 38 / 31 / 20 / 17 / 16 | ✓ My count gives exactly 339, with the same split. Spell chapter pp. 107–175, from Acid Arrow to Zone of Truth. No duplicate names. |
| SRD 5.1: 319 spells, 24 / 49 / 54 / 42 / 31 / 37 / 31 / 20 / 16 / 15 | ✓ My count gives exactly 319, with the same split. Spell chapter pp. 114–193. |
| New in 5.2.1 (22), as listed in SPEC | ✓ A name diff returns exactly those 22. |
| Dropped from 5.1: Branding Smite, Feeblemind | ✓ A name diff returns exactly those 2. Both SRDs use the same generic spell names, so a name diff is valid. 339 − 22 + 2 = 319 ✓. |
| (§33.2) 109 spells have "Using a Higher-Level Spell Slot." and 15 cantrips have "Cantrip Upgrade." | ✓ Counted in the 5.2.1 spell chapter: 109 and 15. This belongs to R2's scope and is noted here only because the check was cheap. |

## 34.8 Differences when a campaign uses SRD 5.1

| SPEC claim | Result |
|---|---|
| Exhaustion is the 6-step table | ✓ SRD 5.1 p. 358. Effects are cumulative. A Long Rest removes 1 level **only if the creature has eaten and drunk**. |
| Stunned creatures can't move | ✓ SRD 5.1 p. 359. They can also speak only falteringly. |
| Surprise skips the first turn | ✓ SRD 5.1 p. 90. A surprised creature can't move or act on its first turn and can't take a Reaction until that turn ends. |
| No Bloodied | ✓ The term appears nowhere in the SRD 5.1 text. |
| No Emanation shape | ✓ SRD 5.1 p. 102 lists five shapes. |
| Blindsight doesn't mention invisibility or Total Cover | ✓ SRD 5.1 pp. 86, 257 |
| Tremorsense can't detect flying or incorporeal creatures | ✓ SRD 5.1 p. 257 |
| Darkvision (spell) grants 60 ft | ✓ SRD 5.1 p. 133 |
| Produce Flame 10/+10 | ✓ SRD 5.1 p. 172. It is cast as an action, hurling ends the spell, and the hurl range is 30 ft. |
| Continual Flame is as bright as a torch | ✓ SRD 5.1 p. 130 ("equivalent in brightness to a torch", so 20/20 via Torch, SRD 5.1 p. 68) |
| Holy Aura sheds Dim Light 5 ft | ◐ SRD 5.1 p. 155. The light comes from **each creature the caster chose** in the 30-ft radius, not from the caster alone. |
| Darkness and Fog Cloud spread around corners | ✓ SRD 5.1 p. 133 (Darkness), p. 146 (Fog Cloud; 5.1 wind threshold is at least 10 mph) |
| Lighting a torch or lowering a lantern hood takes an action | ✓ SRD 5.1 p. 68 (Tinderbox, Lantern, Hooded) |

**5.1 differences SPEC §34.8 and §19.3 don't list (volunteered). A 5.1 pack needs these:**

1. **Concentration**, SRD 5.1 p. 102. The DC is the higher of 10 and half the damage, with **no cap of 30**, and a separate save is made for each damage source. SPEC §19.2 and §19.5 hard-code `min(30, …)`, which is 5.2.1-only.
2. **Inspiration**, SRD 5.1 pp. 59–60. It gives **Advantage** on one attack roll, save or ability check; it is not a reroll. The name "Heroic Inspiration" doesn't exist in 5.1.
3. **Hide**, SRD 5.1 pp. 80, 93. It is a Stealth check contested by Perception, with no DC 15 and no Invisible condition.
4. **Grappled**, SRD 5.1 pp. 358, 95–96. The condition has no attack penalty. It ends if the grappler is Incapacitated or the target is moved out of reach. Escape is a contested Athletics or Acrobatics check against the grappler's Athletics. Dragging a grappled creature **halves the grappler's speed** unless it is 2+ sizes smaller; 5.2.1 instead charges +1 ft per ft.
5. **Incapacitated**, SRD 5.1 p. 358. It only stops actions and reactions: it doesn't stop speech and has no Initiative effect. Concentration still breaks, but that rule is in the Concentration rules on p. 102.
6. **Invisible**, SRD 5.1 p. 358. No Advantage on Initiative. For hiding, the creature counts as Heavily Obscured, and noise or tracks give away its location.
7. **Charmed**, SRD 5.1 p. 358. It forbids "harmful" abilities or effects against the charmer, which is broader than 5.2.1's "damaging".
8. **Petrified**, SRD 5.1 p. 359. The creature is also unaware of its surroundings and is immune to poison and disease.
9. **Creature spaces**, SRD 5.1 p. 91. Any other creature's space is Difficult Terrain, hostile or not; 5.2.1 exempts Tiny creatures and allies.

(Checked and the same in both: the Dodge action, SRD 5.1 p. 93 vs SRD 5.2.1 p. 181.)

`conditions.json` records a `srd51` summary for Charmed, Exhaustion, Grappled, Incapacitated, Invisible, Petrified and Stunned.

---

## Discrepancies with SPEC

1. **§34.4 Shining Smite: Conc. "—" is wrong.** SRD 5.2.1 p. 162 gives Concentration, up to 1 minute. The spell also gives attack rolls against the target Advantage, which SPEC doesn't mention.
2. **§34.4 Conjure Celestial has no page.** It is SRD 5.2.1 p. 118, and its duration is Concentration, up to 10 minutes.
3. **§34.2 0 HP cites the wrong page for revival.** The loss of Attunement and the one fewer Exhaustion level come from the "Dead" glossary entry, SRD 5.2.1 p. 180, not pp. 17–18. The same entry says ongoing conditions, contagions and curses carry over.
4. **§34.1 Grappled escape DC is over-general.** 8 + Str mod + PB is the Unarmed Strike grapple DC (p. 190). The condition itself uses "the grapple's escape DC" (p. 182), so monster grapples use the DC in their stat block. The condition also ends when the grappler is Incapacitated or the distance exceeds the grapple's range.
5. **§34.6 Moving through creatures: SRD says "two sizes", not "two or more sizes"** (SRD 5.2.1 p. 14). Keeping "≥ 2" is a reasonable reading (5.1 p. 92 says "at least two"), but it should go in DECISIONS.md as an interpretation.
6. **§34.4 Incendiary Cloud** moves 10 ft **away from the caster**, in a direction the caster chooses (SRD 5.2.1 pp. 142–143). SPEC omits the "away" constraint.
7. **§34.4 Insect Plague** is also **Difficult Terrain** (SRD 5.2.1 p. 143). SPEC omits this.
8. **§34.4 Flaming Sphere "5-ft sphere"** is a 5-ft **diameter** sphere. Its damage zone is creatures ending their turn within 5 ft of it (SRD 5.2.1 p. 132).
9. **§19.3 Incapacitated omits "can't speak"** (SRD 5.2.1 p. 184), which blocks Verbal spells. **Petrified omits immunity to the Poisoned condition** (p. 186).
10. **§34.2 Rests are incomplete.** A Short Rest restores a minimum of 1 HP per Hit Die (SRD 5.2.1 p. 187). A Long Rest also restores reduced ability scores, both rests need at least 1 HP to start, and rules for interruptions and the 16-hour gap apply (p. 185). AC-HP-13 inherits these gaps.
11. **§34.3 Truesight omits** automatic success on saves against visual illusions (SRD 5.2.1 p. 190).
12. **§34.3 light table.** Lamp and lantern burn time comes from the Oil entry on p. 99, while the Hooded and Bullseye rows cite only p. 98. The hood can also be raised again as a Bonus Action. (Minor citation issue.)
13. **§34.8 Holy Aura (5.1).** The dim light is shed by each creature the caster chooses, not by the caster alone (SRD 5.1 p. 155).
14. **§34.8 and §19.3's 5.1 notes are incomplete.** The 5.1 concentration cap, Inspiration, Hide, Grappled, Incapacitated, Invisible, Charmed, Petrified and creature-space differences are all missing (listed above). The most dangerous is the **Concentration DC cap of 30**, which SPEC §19.2 and §19.5 apply unconditionally and SRD 5.1 p. 102 doesn't have.
15. **§19.3 Unconscious noSight** is inferred from "unaware of its surroundings" (SRD 5.2.1 p. 191); the SRD doesn't say it literally. Not wrong, but noted.
16. **Citation detail (not an error).** Several §34.4 page numbers are where the spell's name appears, but the effect text continues on the next page: Dancing Lights 121→122, Moonbeam 150→151, Incendiary Cloud 142→143, and Hallow's Daylight option on p. 139.
17. **Attribution quotes (not an error).** PDF p. 1 prints the statement with typographic quotes (“SRD 5.2.1”); Appendix I uses straight quotes. The text is otherwise identical. `conditions.json` uses Appendix I's string. The SRD 5.1 statement in Appendix I matches SRD 5.1 p. 1.

Confirmed while checking other claims (no discrepancy): §33.1 pin (hash, size, 364 pages); §33.6 "D&D" appears on pp. 5 and 24; §33.2 counts of 109 higher-level entries and 15 cantrip upgrades.

## Could not verify

- **Visual layout of tables.** `pdftoppm` isn't available, so no page was rendered as an image. Table contents were read from the text layer of the hash-verified PDF: Creature Size (p. 14), Cover (p. 15), Damage Types (p. 180), Exhaustion 5.1 (SRD 5.1 p. 358). The text is consistent with the prose around each table, and I found no garbling.
- **The 5.1 PDF has no pinned hash in SPEC.** I recorded its SHA-256 and size above for pinning. The download came from the official Wizards URL given in the task.
- **Items outside R1's scope were not checked:** §33.4 cylinder and emanation sizes and the wall list (R2), except where they overlap §34.4 (Darkness, Daylight, Moonbeam, Sleet Storm, Conjure Celestial, Tiny Hut, all ✓ above).
- **Ambiguous in the SRD.** Charmed says "target the charmer with damaging abilities or magical effects" (p. 178). It isn't clear whether "damaging" also qualifies "magical effects", i.e. whether a charmed creature may target the charmer with a *harmless* magical effect. I summarised it with "damaging" applying to both, matching SPEC. A DM may read it otherwise.
