import { describe, expect, it } from "vitest";
import type { AdminActor } from "../admin/capabilities.ts";
import { getConfigView } from "../admin/config-view.ts";
import { isAliExpressImageVariantsEnabled } from "./image-config.ts";

describe("isAliExpressImageVariantsEnabled (karar 0167)", () => {
  it("varsayilan kapali: tanimsiz, bos ve 'true' disindaki her deger", () => {
    for (const value of [undefined, "", " ", "false", "0", "1", "yes", "on", "truee"]) {
      expect(isAliExpressImageVariantsEnabled({ IMAGE_VARIANTS_ALIEXPRESS_ENABLED: value })).toBe(
        false,
      );
    }
    expect(isAliExpressImageVariantsEnabled({})).toBe(false);
  });

  it("yalnizca 'true' (bosluk ve buyuk/kucuk harf toleransli) acar", () => {
    for (const value of ["true", " true ", "TRUE", "True"]) {
      expect(isAliExpressImageVariantsEnabled({ IMAGE_VARIANTS_ALIEXPRESS_ENABLED: value })).toBe(
        true,
      );
    }
  });

  it("her cagrida ortami yeniden okur (onbellek yok): calisma zamani gecisi", () => {
    const env: Record<string, string | undefined> = {};
    expect(isAliExpressImageVariantsEnabled(env)).toBe(false);
    env.IMAGE_VARIANTS_ALIEXPRESS_ENABLED = "true";
    expect(isAliExpressImageVariantsEnabled(env)).toBe(true);
    env.IMAGE_VARIANTS_ALIEXPRESS_ENABLED = "false";
    expect(isAliExpressImageVariantsEnabled(env)).toBe(false);
  });
});

describe("yonetim ayar gorunumu", () => {
  const actor: AdminActor = { userId: 1, role: "admin" };
  it("bayragi etkin degeriyle listeler ve gizli degil", () => {
    const off = getConfigView(actor, {}).entries.find(
      (e) => e.key === "IMAGE_VARIANTS_ALIEXPRESS_ENABLED",
    );
    expect(off?.value).toBe("Kapalı");
    expect(off?.state).toBe("default");
    expect(off?.secret).toBe(false);
    const on = getConfigView(actor, { IMAGE_VARIANTS_ALIEXPRESS_ENABLED: "true" }).entries.find(
      (e) => e.key === "IMAGE_VARIANTS_ALIEXPRESS_ENABLED",
    );
    expect(on?.value).toBe("Açık");
    expect(on?.state).toBe("set");
  });
});
