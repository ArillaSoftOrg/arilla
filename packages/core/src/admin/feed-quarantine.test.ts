import { describe, expect, it } from "vitest";
import {
  type FeedQuarantineItem,
  feedQuarantineFindings,
  quarantineCommand,
} from "./feed-quarantine.ts";

const NOW = new Date("2026-11-25T18:00:00Z");
const ITEM: FeedQuarantineItem = {
  feedId: 7,
  name: "10-25$",
  snapshotId: 146,
  records: 3_129_872,
  median: 4_946_783,
  since: new Date("2026-11-14T22:18:00Z"),
  approved: false,
};

describe("feedQuarantineFindings", () => {
  it("karantina yoksa bulgu yok", () => {
    expect(feedQuarantineFindings([], NOW)).toEqual([]);
  });

  it("onay bekleyen besleme: uyarı, gün sayısı, kanıt ve onay komutu", () => {
    const [f] = feedQuarantineFindings([ITEM], NOW);
    expect(f?.severity).toBe("warning");
    expect(f?.key).toBe("feeds.quarantine.7");
    expect(f?.title).toBe("10-25$ 10 gündür karantinada: onay bekliyor");
    expect(f?.evidence).toContain("%63");
    expect(f?.evidence).toContain("Sürüm 146");
    expect(f?.action).toContain(quarantineCommand(ITEM));
    expect(f?.href).toBe("/yonetim/ingest/beslemeler");
  });

  it("onay verilmiş besleme yalnızca bilgi (dikkat listesine girmez)", () => {
    const [f] = feedQuarantineFindings([{ ...ITEM, approved: true }], NOW);
    expect(f?.severity).toBe("info");
  });

  it("medyan yoksa oran yazılmaz; aynı gün 'bugün'", () => {
    const [f] = feedQuarantineFindings([{ ...ITEM, median: null, since: NOW }], NOW);
    expect(f?.title).toContain("bugün karantinada");
    expect(f?.evidence).not.toContain("%");
  });

  it("komut seviye onayı ve --confirm içerir, gerçek ad/gerekçe uydurmaz", () => {
    const cmd = quarantineCommand(ITEM);
    expect(cmd).toContain("--feed 7 --snapshot 146 --level");
    expect(cmd).toContain("--confirm");
    expect(cmd).toContain("--by <ad>");
  });
});
