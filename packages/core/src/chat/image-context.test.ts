import { describe, expect, it } from "vitest";
import {
  cleanImageSummary,
  decideContextImage,
  IMAGE_SUMMARY_MAX,
  type ImageContextMessage,
  refersToImage,
} from "./image-context.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const user = (content: string, attachmentId: string | null = null): ImageContextMessage => ({
  role: "user",
  content,
  attachmentId,
});
const assistant = (summary?: { attachmentId: string; text: string }): ImageContextMessage => ({
  role: "assistant",
  imageSummary: summary ?? null,
});

describe("refersToImage", () => {
  it.each([
    "bu fotoğraftaki ayakkabının mavisi",
    "Fotoğraf gibi olsun",
    "görseldekine benzer",
    "resimdeki gibi",
    "bunun aynısı",
    "buna benzer bir şey",
    "şunun siyahı var mı",
  ])("atıf: %s", (text) => {
    expect(refersToImage(text)).toBe(true);
  });

  it.each(["siyah olsun", "Nike olsun", "2500 TL altı", "daha uygun fiyatlı", ""])(
    "atıf değil: %s",
    (text) => {
      expect(refersToImage(text)).toBe(false);
    },
  );
});

describe("decideContextImage", () => {
  it("görsel yok: karar yok", () => {
    const decision = decideContextImage([user("siyah ayakkabı")], 12);
    expect(decision).toEqual({
      sendImage: false,
      attachmentId: null,
      ownerIndex: -1,
      summary: null,
    });
  });

  it("görsel bu turun mesajında: gönderilir", () => {
    const decision = decideContextImage([user("", A)], 12);
    expect(decision.sendImage).toBe(true);
    expect(decision.attachmentId).toBe(A);
  });

  it("takip turunda özet varsa görsel gönderilmez, özet döner", () => {
    const messages = [
      user("", A),
      assistant({ attachmentId: A, text: "beyaz deri spor ayakkabı" }),
      user("siyah olsun"),
    ];
    const decision = decideContextImage(messages, 12);
    expect(decision.sendImage).toBe(false);
    expect(decision.summary).toBe("beyaz deri spor ayakkabı");
    expect(decision.ownerIndex).toBe(0);
  });

  it("takip turunda özet yoksa görsel yeniden gönderilir", () => {
    const messages = [user("", A), assistant(), user("siyah olsun")];
    const decision = decideContextImage(messages, 12);
    expect(decision.sendImage).toBe(true);
    expect(decision.summary).toBeNull();
  });

  it("kullanıcı görsele atıf yaparsa özet olsa da görsel yeniden gönderilir", () => {
    const messages = [
      user("", A),
      assistant({ attachmentId: A, text: "beyaz deri spor ayakkabı" }),
      user("fotoğraftakinin tabanı nasıl"),
    ];
    const decision = decideContextImage(messages, 12);
    expect(decision.sendImage).toBe(true);
    expect(decision.summary).toBe("beyaz deri spor ayakkabı");
  });

  it("yeni görsel gelince en son görsel esas alınır", () => {
    const messages = [
      user("", A),
      assistant({ attachmentId: A, text: "eski ürün" }),
      user("buna bak", B),
    ];
    const decision = decideContextImage(messages, 12);
    expect(decision.attachmentId).toBe(B);
    expect(decision.ownerIndex).toBe(2);
    expect(decision.sendImage).toBe(true);
    expect(decision.summary).toBeNull();
  });

  it("başka bir eke ait özet kullanılmaz", () => {
    const messages = [
      user("", A),
      assistant({ attachmentId: A, text: "eski ürün" }),
      user("", B),
      assistant(),
      user("mavi olsun"),
    ];
    const decision = decideContextImage(messages, 12);
    expect(decision.attachmentId).toBe(B);
    expect(decision.summary).toBeNull();
    expect(decision.sendImage).toBe(true);
  });

  it("bağlam penceresi dışına çıkan görsel eklenmez", () => {
    const messages = [
      user("", A),
      assistant(),
      user("a"),
      assistant(),
      user("b"),
      assistant(),
      user("c"),
    ];
    expect(decideContextImage(messages, 4).attachmentId).toBeNull();
    expect(decideContextImage(messages, 7).attachmentId).toBe(A);
  });
});

describe("cleanImageSummary", () => {
  it("geçerli metni kırpar ve boşlukları sadeleştirir", () => {
    expect(cleanImageSummary("  beyaz   deri \n ayakkabı ")).toBe("beyaz deri ayakkabı");
    expect(cleanImageSummary("x".repeat(IMAGE_SUMMARY_MAX + 50))).toHaveLength(IMAGE_SUMMARY_MAX);
  });

  it("geçersiz girdi, boş metin ve bağlantı atılır", () => {
    expect(cleanImageSummary(null)).toBeUndefined();
    expect(cleanImageSummary(42)).toBeUndefined();
    expect(cleanImageSummary("   ")).toBeUndefined();
    expect(cleanImageSummary("bkz https://example.com")).toBeUndefined();
  });
});
