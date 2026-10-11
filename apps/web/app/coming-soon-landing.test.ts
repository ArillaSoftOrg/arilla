import { EARLY_ACCESS_LOGIN_PATH, EARLY_ACCESS_PATH } from "@arilla/core";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./public-site-shell.tsx", () => ({
  PublicSiteShell: ({ children }: { children: ReactNode }) => children,
}));

import { ComingSoonLanding } from "./coming-soon-landing.tsx";

describe("prelaunch mascot story", () => {
  it("keeps enrollment links and all story content usable without client JavaScript", () => {
    const html = renderToStaticMarkup(createElement(ComingSoonLanding, { signedIn: false }));
    expect(html).toContain(`href="${EARLY_ACCESS_LOGIN_PATH}"`);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html.match(/data-mascot-stop=""/g)).toHaveLength(3);
    expect(html).toContain("Henüz kullanıma açık değil");
    expect(html).toContain('href="#nasil-calisacak"');
    expect(html).toContain('id="nasil-calisacak"');
    expect(html.match(/<details\b/g)).toHaveLength(3);
    expect(html).not.toMatch(/<video|<form|hero-intro\.mp4|robot-wave|robot-body/);
  });

  it("takes enrolled visitors to their status without offering to enroll again", () => {
    const html = renderToStaticMarkup(createElement(ComingSoonLanding, { signedIn: true }));
    expect(html).toContain(`href="${EARLY_ACCESS_PATH}"`);
    expect(html).not.toContain(`href="${EARLY_ACCESS_LOGIN_PATH}"`);
    expect(html).toContain("Listedesin. İyi ki geldin.");
  });

  it("shows only the supplied real progress and omits the counter when unavailable", () => {
    const html = renderToStaticMarkup(
      createElement(ComingSoonLanding, {
        signedIn: false,
        progress: { count: 125, target: 5000, percent: 2.5 },
      }),
    );
    expect(html).toContain('aria-valuenow="125"');
    expect(html).toContain('aria-valuemax="5000"');
    const hero = html.slice(html.indexOf("<section"), html.indexOf("</section>"));
    expect(hero).toContain('role="progressbar"');
    expect(hero).toContain('data-prominent="true"');
    expect(hero).toContain("Hedefimiz 5.000 kişiyle açılışa başlamak.");
    expect(html.match(/role="progressbar"/g)).toHaveLength(1);
    const withoutProgress = renderToStaticMarkup(
      createElement(ComingSoonLanding, { signedIn: false }),
    );
    expect(withoutProgress).not.toContain('role="progressbar"');
  });

  it("derives the hero goal from the supplied target", () => {
    const html = renderToStaticMarkup(
      createElement(ComingSoonLanding, {
        signedIn: false,
        progress: { count: 0, target: 10000, percent: 0 },
      }),
    );
    expect(html).toContain("Hedefimiz 10.000 kişiyle açılışa başlamak.");
  });
});
