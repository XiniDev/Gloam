import { describe, expect, it } from "vitest";
import { feetToMetres, formatDistance, metresToFeet, roundFeet, withinBudget } from "./units.ts";

describe("units (AC-MOV-12)", () => {
  it("rounds feet to the nearest 0.5 ft", () => {
    expect(roundFeet(20.2)).toBe(20);
    expect(roundFeet(20.25)).toBe(20.5);
    expect(roundFeet(20.74)).toBe(20.5);
    expect(roundFeet(20.76)).toBe(21);
    expect(roundFeet(-0.1)).toBe(0);
  });

  it("uses 5 ft = 1.5 m and rounds metres to 0.1 m", () => {
    expect(feetToMetres(5)).toBe(1.5);
    expect(feetToMetres(30)).toBe(9);
    expect(feetToMetres(60)).toBe(18);
    expect(feetToMetres(7)).toBe(2.1);
    expect(feetToMetres(12.34)).toBe(3.7);
    expect(metresToFeet(1.5)).toBeCloseTo(5, 10);
  });

  it("formats in the campaign's units", () => {
    expect(formatDistance(30)).toBe("30 ft");
    expect(formatDistance(30, "m")).toBe("9 m");
    expect(formatDistance(22.3)).toBe("22.5 ft");
    expect(formatDistance(22.3, "m")).toBe("6.7 m");
  });

  it("compares budgets with a 0.05 ft epsilon", () => {
    expect(withinBudget(30.00001, 30)).toBe(true);
    expect(withinBudget(30.05, 30)).toBe(true);
    expect(withinBudget(30.051, 30)).toBe(false);
  });
});
