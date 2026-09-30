import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocMarkdown } from "./DocMarkdown.tsx";

describe("links in table Markdown (SPEC §22.6, security review L2)", () => {
  it("open in a new tab, tell the page nothing, and a script link isn't one", () => {
    const html = renderToStaticMarkup(
      createElement(
        DocMarkdown,
        null,
        "See [the map](https://example.com/map) — or [this](javascript:alert(1)).",
      ),
    );
    expect(html).toContain('href="https://example.com/map"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).not.toContain("javascript:");
  });
});
