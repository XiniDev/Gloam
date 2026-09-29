import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { keepHyphenated } from "./text.tsx";

const html = (s: string) => renderToStaticMarkup(createElement("p", null, keepHyphenated(s)));

describe("keepHyphenated", () => {
  it("keeps each hyphenated word on one line and leaves the rest as it was", () => {
    expect(html("Damage — Fire-scarred Ogre")).toBe(
      '<p>Damage — <span class="whitespace-nowrap">Fire-scarred</span> Ogre</p>',
    );
    expect(html("Half-Orc spear-thrower's turn")).toBe(
      '<p><span class="whitespace-nowrap">Half-Orc</span> <span class="whitespace-nowrap">spear-thrower&#x27;s</span> turn</p>',
    );
  });

  it("passes plain words, dashes between words and anything but a string through", () => {
    expect(keepHyphenated("Goblin")).toBe("Goblin");
    expect(html("Mira - the bold")).toBe("<p>Mira - the bold</p>");
    const node = createElement("b", null, "Fire-scarred");
    expect(keepHyphenated(node)).toBe(node);
  });
});
