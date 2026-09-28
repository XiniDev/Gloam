/** An ability score's modifier (SRD 5.2.1): ⌊(score − 10) ÷ 2⌋. */
export const abilityMod = (score: number): number => Math.floor((score - 10) / 2);
