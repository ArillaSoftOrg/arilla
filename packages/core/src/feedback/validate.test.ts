import { describe, expect, it } from "vitest";
import { FEEDBACK_LIMITS, validateFeedback } from "./validate.ts";

const VALID = {
  category: "bug",
  title: "Filtre çalışmıyor",
  message: "Arama sonuçlarında fiyat filtresi uygulanmıyor.",
  priority: "high",
};

function entries(fields: Record<string, string>): [string, unknown][] {
  return Object.entries(fields);
}

describe("validateFeedback()", () => {
  it("gecerli anonim gonderimi kabul eder ve e-postayi normalize eder", () => {
    const result = validateFeedback(entries({ ...VALID, email: "  Ada@Example.TEST " }), {
      authenticated: false,
    });
    expect(result).toEqual({
      ok: true,
      value: { ...VALID, email: "ada@example.test" },
    });
  });

  it("oncelik ve e-posta istege baglidir", () => {
    const result = validateFeedback(
      entries({ category: "other", title: VALID.title, message: VALID.message, priority: "" }),
      { authenticated: false },
    );
    expect(result).toEqual({
      ok: true,
      value: {
        category: "other",
        title: VALID.title,
        message: VALID.message,
        priority: null,
        email: null,
      },
    });
  });

  it("izin listesinde olmayan kategoriyi reddeder", () => {
    const result = validateFeedback(entries({ ...VALID, category: "spam" }), {
      authenticated: false,
    });
    expect(result).toEqual({ ok: false, fieldErrors: { category: "invalid" } });
  });

  it("eksik kategoriyi zorunlu alan hatasi olarak dondurur", () => {
    const { category: _omit, ...rest } = VALID;
    const result = validateFeedback(entries(rest), { authenticated: false });
    expect(result).toEqual({ ok: false, fieldErrors: { category: "required" } });
  });

  it("bos, kisa ve uzun basligi reddeder", () => {
    for (const [title, error] of [
      ["   ", "required"],
      ["ab", "too_short"],
      ["a".repeat(FEEDBACK_LIMITS.titleMax + 1), "too_long"],
    ] as const) {
      const result = validateFeedback(entries({ ...VALID, title }), { authenticated: false });
      expect(result).toEqual({ ok: false, fieldErrors: { title: error } });
    }
  });

  it("kisa ve uzun mesaji reddeder", () => {
    expect(
      validateFeedback(entries({ ...VALID, message: "kısa" }), { authenticated: false }),
    ).toEqual({ ok: false, fieldErrors: { message: "too_short" } });
    const long = validateFeedback(
      entries({ ...VALID, message: "a".repeat(FEEDBACK_LIMITS.messageMax + 1) }),
      { authenticated: false },
    );
    expect(long.ok).toBe(false);
  });

  it("uzunlugu kod noktasi olarak olcer (emoji iki birim sayilmaz)", () => {
    const title = "😀".repeat(FEEDBACK_LIMITS.titleMax);
    const result = validateFeedback(entries({ ...VALID, title }), { authenticated: false });
    expect(result.ok).toBe(true);
  });

  it("gecersiz e-posta bicimini reddeder", () => {
    for (const email of ["ada", "ada@", "ada@example", "a b@example.test"]) {
      const result = validateFeedback(entries({ ...VALID, email }), { authenticated: false });
      expect(result).toEqual({ ok: false, fieldErrors: { email: "invalid" } });
    }
  });

  it("gecersiz onceligi reddeder", () => {
    const result = validateFeedback(entries({ ...VALID, priority: "urgent" }), {
      authenticated: false,
    });
    expect(result).toEqual({ ok: false, fieldErrors: { priority: "invalid" } });
  });

  it("girisli kullanicida formdaki e-postayi yok sayar", () => {
    const result = validateFeedback(entries({ ...VALID, email: "baskasi@example.test" }), {
      authenticated: true,
    });
    expect(result.ok && result.value.email).toBe(null);
  });

  it("bilinmeyen alani (istemcinin user_id'si dahil) reddeder", () => {
    for (const extra of ["user_id", "userId", "status", "source"]) {
      const result = validateFeedback(entries({ ...VALID, [extra]: "1" }), {
        authenticated: false,
      });
      expect(result).toEqual({ ok: false, fieldErrors: {}, formError: "malformed" });
    }
  });

  it("Next'in $ACTION alanlarini yok sayar", () => {
    const result = validateFeedback(
      entries({ ...VALID, $ACTION_ID_abc: "", "$ACTION_1:0": "{}" }),
      {
        authenticated: false,
      },
    );
    expect(result.ok).toBe(true);
  });

  it("tekrarlanan alani ve metin olmayan degeri reddeder", () => {
    expect(
      validateFeedback(
        [
          ["title", "Birinci başlık"],
          ["title", "İkinci başlık"],
        ],
        { authenticated: false },
      ),
    ).toMatchObject({ ok: false, formError: "malformed" });
    expect(
      validateFeedback([...entries(VALID), ["email", new Blob(["x"])]], { authenticated: false }),
    ).toMatchObject({ ok: false, formError: "malformed" });
  });

  it("asiri buyuk govdeyi alan sinirlarindan once reddeder", () => {
    const result = validateFeedback(
      entries({ ...VALID, message: "a".repeat(FEEDBACK_LIMITS.payloadMax + 1) }),
      { authenticated: false },
    );
    expect(result).toEqual({ ok: false, fieldErrors: {}, formError: "too_large" });
  });

  it("NUL ve kontrol karakterlerini atar, satir sonlarini korur", () => {
    const result = validateFeedback(
      entries({ ...VALID, message: "Birinci satır\u0000\r\nİkinci satır\u0007" }),
      { authenticated: false },
    );
    expect(result.ok && result.value.message).toBe("Birinci satır\nİkinci satır");
  });
});
