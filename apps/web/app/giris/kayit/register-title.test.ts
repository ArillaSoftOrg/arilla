import { safeRedirectPath } from "@arilla/core";
import { describe, expect, it } from "vitest";
import { registerTitle } from "./register-title.ts";

describe("registerTitle", () => {
  it("erken erişim akışında başlığı değiştirir", () => {
    expect(registerTitle(safeRedirectPath("/erken-erisim"))).toBe(
      "Erken erişim için hesap oluştur",
    );
  });

  it("normal kayıtta ve başka hedeflerde 'Hesap oluştur' kalır", () => {
    for (const next of [undefined, "/", "/ara", "/erken-erisim/x", "/erken-erisim?x=1"]) {
      expect(registerTitle(safeRedirectPath(next))).toBe("Hesap oluştur");
    }
  });

  it("güvensiz next erken erişim başlığını açmaz", () => {
    for (const next of ["//erken-erisim", "https://evil.test/erken-erisim", "/\\erken-erisim"]) {
      expect(registerTitle(safeRedirectPath(next))).toBe("Hesap oluştur");
    }
  });
});
