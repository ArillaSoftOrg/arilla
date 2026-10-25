import { describe, expect, it } from "vitest";
import {
  checkPasswordPolicy,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "./password-policy.ts";

describe("checkPasswordPolicy", () => {
  it("yeterince uzun ve yaygın olmayan şifreyi kabul eder", () => {
    expect(checkPasswordPolicy("Mavi-Kedi-Pazar-42")).toBeNull();
    // Karakter sınıfı kuralı yok: uzun bir cümle yeter.
    expect(checkPasswordPolicy("sabah erkenden kalkip yuruyuse ciktim")).toBeNull();
  });

  it("kısa şifreyi reddeder (en az 10)", () => {
    expect(checkPasswordPolicy("a".repeat(PASSWORD_MIN_LENGTH - 1))).toBe("too_short");
    expect(checkPasswordPolicy("Ab1-Cd2-Ef")).toBeNull();
  });

  it("çok uzun şifreyi reddeder (en fazla 128)", () => {
    expect(checkPasswordPolicy(`Ab1-${"x".repeat(PASSWORD_MAX_LENGTH)}`)).toBe("too_long");
  });

  it("yaygın ve tek karakterden oluşan şifreleri reddeder", () => {
    expect(checkPasswordPolicy("1234567890")).toBe("too_common");
    expect(checkPasswordPolicy("Password123")).toBe("too_common");
    expect(checkPasswordPolicy("aaaaaaaaaaaa")).toBe("too_common");
  });

  it("e-posta adresinin kendisi ya da yerel kısmı olan şifreyi reddeder", () => {
    expect(
      checkPasswordPolicy("ayse.yilmaz@example.com", { email: "Ayse.Yilmaz@example.com" }),
    ).toBe("same_as_email");
    expect(checkPasswordPolicy("ayse.yilmaz", { email: "ayse.yilmaz@example.com" })).toBe(
      "same_as_email",
    );
  });

  it("uzunluğu kod noktasıyla ölçer (emoji tek karakter sayılır)", () => {
    expect(checkPasswordPolicy("😀".repeat(9))).toBe("too_short");
    expect(checkPasswordPolicy("😀😁😂🤣😃😄😅😆😉😊")).toBeNull();
  });
});
