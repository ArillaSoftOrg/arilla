import { describe, expect, it } from "vitest";
import { CLICK_SURFACES } from "../attribution/record-click.ts";
import { UMAMI_EVENT_DATA_KEYS, UMAMI_EVENTS } from "./config.ts";
import {
  classifyLinkClick,
  ENGAGEMENT_BUCKETS,
  EXIT_SURFACES,
  engagementBucket,
  PAGE_AREAS,
  pageArea,
} from "./events.ts";

const ORIGIN = "https://manicepte.com";
const at = (path: string) => `${ORIGIN}${path}`;

describe("page_engaged süre aralığı", () => {
  it("sınırlar: alt sınır dahil, üst sınır bir sonraki aralık", () => {
    expect(engagementBucket(0)).toBe("0-10s");
    expect(engagementBucket(9_999)).toBe("0-10s");
    expect(engagementBucket(10_000)).toBe("10-30s");
    expect(engagementBucket(29_999)).toBe("10-30s");
    expect(engagementBucket(30_000)).toBe("30-120s");
    expect(engagementBucket(120_000)).toBe("2-10m");
    expect(engagementBucket(600_000)).toBe("10m+");
    expect(engagementBucket(86_400_000)).toBe("10m+");
  });

  it("geçersiz ölçüm gönderilmez", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(engagementBucket(bad)).toBeNull();
    }
  });

  it("yalnızca tanımlı aralıklar üretilir", () => {
    for (const ms of [0, 5_000, 15_000, 60_000, 300_000, 1_000_000]) {
      expect(ENGAGEMENT_BUCKETS).toContain(engagementBucket(ms));
    }
  });
});

describe("sayfa alanı", () => {
  it("arındırılmış yoldan sabit sözlüğe", () => {
    expect(pageArea("/")).toBe("home");
    // `sanitizePage().location` tam adrestir (page_engaged bunu verir): köken atlanır.
    expect(pageArea(at("/"))).toBe("home");
    expect(pageArea(at("/ara?utm_source=x"))).toBe("search");
    expect(pageArea(at("/urun/a"))).toBe("product");
    expect(pageArea(at("/kosullar"))).toBe("other");
    expect(pageArea("/ara/gorsel")).toBe("search");
    expect(pageArea("/urun/kirmizi-elbise")).toBe("product");
    expect(pageArea("/sohbet/[id]")).toBe("chat");
    expect(pageArea("/firsatlar?utm_source=x")).toBe("deals");
    expect(pageArea("/(diger)")).toBe("other");
    expect(pageArea("/kosullar")).toBe("other");
  });

  it("üretilen her alan sözlükte", () => {
    for (const path of ["/", "/ara", "/urun/a", "/trendler/b", "/blog", "/x"]) {
      expect(PAGE_AREAS).toContain(pageArea(path));
    }
  });
});

describe("bağlantı tıklaması", () => {
  it("mağaza çıkışı: yüzey yalnızca bilinen listeden", () => {
    expect(classifyLinkClick("/git/123?surface=product_primary", at("/urun/a"), ORIGIN)).toEqual({
      name: "merchant_exit_clicked",
      data: { area: "product", surface: "product_primary" },
    });
    expect(classifyLinkClick("/git/9?surface=<script>", at("/ara"), ORIGIN)).toEqual({
      name: "merchant_exit_clicked",
      data: { area: "search", surface: "other" },
    });
    expect(classifyLinkClick(at("/git/9"), at("/teklifler"), ORIGIN)?.data).toEqual({
      area: "other", // /teklifler arındırmada "/(diger)" olur
      surface: "other",
    });
  });

  it("ürün sayfası açılışı: ürün kimliği/slug gönderilmez", () => {
    const event = classifyLinkClick("/urun/kirmizi-elbise-42", at("/ara?q=elbise"), ORIGIN);
    expect(event).toEqual({ name: "product_opened", data: { area: "search" } });
    expect(JSON.stringify(event)).not.toContain("kirmizi");
    expect(JSON.stringify(event)).not.toContain("elbise");
  });

  it("ölçülmeyen bağlantılar ve yollar", () => {
    // Dış köken, başka iç sayfalar, kimliksiz /git, iç içe yollar.
    expect(classifyLinkClick("https://magaza.example/urun/a", at("/"), ORIGIN)).toBeNull();
    expect(classifyLinkClick("/kosullar", at("/"), ORIGIN)).toBeNull();
    expect(classifyLinkClick("/git/abc", at("/"), ORIGIN)).toBeNull();
    expect(classifyLinkClick("/urun/a/b", at("/"), ORIGIN)).toBeNull();
    expect(classifyLinkClick("javascript:alert(1)", at("/"), ORIGIN)).toBeNull();
    // Yönetim ve giriş alt yollarında hiçbir şey ölçülmez.
    expect(classifyLinkClick("/urun/a", at("/yonetim/katalog/urunler"), ORIGIN)).toBeNull();
    expect(classifyLinkClick("/git/1", at("/giris/dogrula?token=x"), ORIGIN)).toBeNull();
  });
});

describe("sözlük tutarlılığı", () => {
  it("çıkış yüzeyleri attribution listesiyle aynı", () => {
    expect([...EXIT_SURFACES].sort()).toEqual([...CLICK_SURFACES].sort());
  });

  it("olaylar ve veri alanları izin listesinde", () => {
    for (const name of ["page_engaged", "product_opened", "merchant_exit_clicked"]) {
      expect(UMAMI_EVENTS).toContain(name);
    }
    for (const key of ["area", "surface", "duration"]) {
      expect(UMAMI_EVENT_DATA_KEYS).toContain(key);
    }
  });
});
