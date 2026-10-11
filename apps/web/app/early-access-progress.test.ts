import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EarlyAccessProgress } from "./early-access-progress.tsx";

const progress = { count: 125, target: 5000, percent: 2.5 };

describe("early access progress presentation", () => {
  it("preserves the default presentation on other pages", () => {
    const html = renderToStaticMarkup(createElement(EarlyAccessProgress, { progress }));
    expect(html).not.toContain("data-prominent");
    expect(html).toContain('aria-valuenow="125"');
    expect(html).toContain("inline-size:2.5%");
  });

  it("opts into the hero presentation without changing the real progress", () => {
    const html = renderToStaticMarkup(
      createElement(EarlyAccessProgress, { progress, prominent: true }),
    );
    expect(html).toContain('data-prominent="true"');
    expect(html).toContain('aria-valuenow="125"');
    expect(html).toContain('aria-valuemax="5000"');
    expect(html).toContain("5.000");
  });
});
