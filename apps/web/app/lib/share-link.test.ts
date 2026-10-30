import { describe, expect, it, vi } from "vitest";
import { canonicalShareUrl, type ShareEnvironment, shareLink } from "./share-link.ts";

const TARGET = { url: "https://manicepte.com/urun/kosu-ayakkabisi", title: "Koşu ayakkabısı" };

function domError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function env(overrides: Partial<ShareEnvironment> = {}) {
  const writeText = vi.fn(async (_text: string) => {});
  const environment: ShareEnvironment = { clipboard: { writeText }, ...overrides };
  return { environment, writeText };
}

describe("shareLink", () => {
  it("Web Share destekleniyorsa yalnız başlık ve adres paylaşılır", async () => {
    const share = vi.fn(async (_data: ShareData) => {});
    const { environment, writeText } = env({ share, canShare: () => true });
    expect(await shareLink(environment, TARGET)).toBe("shared");
    expect(share).toHaveBeenCalledWith({ title: TARGET.title, url: TARGET.url });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("`canShare` yoksa da Web Share denenir", async () => {
    const share = vi.fn(async () => {});
    expect(await shareLink(env({ share }).environment, TARGET)).toBe("shared");
  });

  it("kullanıcı paylaşım sayfasını kapatırsa iptaldir; panoya yazılmaz", async () => {
    const share = vi.fn(async () => {
      throw domError("AbortError");
    });
    const { environment, writeText } = env({ share });
    expect(await shareLink(environment, TARGET)).toBe("cancelled");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("Web Share izin hatası verirse adres panoya kopyalanır", async () => {
    const share = vi.fn(async () => {
      throw domError("NotAllowedError");
    });
    const { environment, writeText } = env({ share });
    expect(await shareLink(environment, TARGET)).toBe("copied");
    expect(writeText).toHaveBeenCalledWith(TARGET.url);
  });

  it("`canShare` adresi reddederse ya da fırlatırsa pano kullanılır", async () => {
    const share = vi.fn(async () => {});
    for (const canShare of [
      () => false,
      () => {
        throw new TypeError("x");
      },
    ]) {
      const { environment, writeText } = env({ share, canShare });
      expect(await shareLink(environment, TARGET)).toBe("copied");
      expect(writeText).toHaveBeenCalledWith(TARGET.url);
    }
    expect(share).not.toHaveBeenCalled();
  });

  it("Web Share yoksa (masaüstü) adres panoya kopyalanır", async () => {
    const { environment, writeText } = env();
    expect(await shareLink(environment, TARGET)).toBe("copied");
    expect(writeText).toHaveBeenCalledWith(TARGET.url);
  });

  it("pano reddederse ya da yoksa sonuç başarısızdır (fırlatmaz)", async () => {
    const denied = env();
    denied.writeText.mockRejectedValueOnce(domError("NotAllowedError"));
    expect(await shareLink(denied.environment, TARGET)).toBe("failed");
    expect(await shareLink({}, TARGET)).toBe("failed");
  });
});

describe("canonicalShareUrl", () => {
  const origin = "https://manicepte.com";

  it("göreli yolu kökene göre mutlak yapar", () => {
    expect(canonicalShareUrl("/urun/x", origin)).toBe("https://manicepte.com/urun/x");
  });

  it("sorgu dizisi ve parça (beden, takip, oturum) paylaşılmaz", () => {
    expect(
      canonicalShareUrl("https://manicepte.com/urun/x?boyut=42&utm_source=a&token=t#fiyat", origin),
    ).toBe("https://manicepte.com/urun/x");
  });

  it("http(s) dışı ya da kimlik bilgili adres reddedilir", () => {
    expect(canonicalShareUrl("javascript:alert(1)", origin)).toBeNull();
    expect(canonicalShareUrl("https://a:b@manicepte.com/urun/x", origin)).toBeNull();
    expect(canonicalShareUrl("/urun/x", "gecersiz")).toBeNull();
  });
});
