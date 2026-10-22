import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdminActor } from "../admin/capabilities.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { applyRunPresence } from "./discovery-presence.ts";
import {
  approveRunDownload,
  planDiscoveryUnits,
  reserveRequests,
  submitDiscoveryBatch,
} from "./discovery-service.ts";
import { closeCollectionRun, startCollectionRun } from "./service.ts";

const U1 = "sitemaps/product/presence_1.xml";
const U2 = "sitemaps/product/presence_2.xml";

const item = (code: string, unit: string) => ({
  externalId: code,
  codeKind: "pm",
  url: `https://www.hepsiburada.com/urun-${code.toLowerCase()}-pm-${code}`,
  title: `Urun ${code}`,
  imageUrl: `https://productimages.hepsiburada.net/s/777/1/${code}.jpg`,
  sourceUnitKey: unit,
});

type Scan = { units: { key: string; items: string[] }[]; skip?: string[] };

describe("kaldirilma takibi - entegrasyon (gercek Postgres, karar 0140)", () => {
  let db: Database;
  let admin: AdminActor;
  const suffix = Date.now();
  let seq = 0;

  async function reset() {
    await withOwnerClient(async (c) => {
      await c.query("DELETE FROM catalog_discovery_scan_state");
      await c.query("DELETE FROM catalog_discovery");
      await c.query("DELETE FROM catalog_intake_record");
      await c.query("DELETE FROM collection_unit");
      await c.query("DELETE FROM collection_run");
      await c.query("DELETE FROM collection_usage_day");
      await c.query("UPDATE collection_source SET enabled = TRUE WHERE source = 'hepsiburada'");
    });
  }

  /** Bir tam tarama koşusu: birimleri planla, gönder, koşuyu `completed` kapat (hesap otomatik). */
  async function scan(input: Scan): Promise<number> {
    const run = await startCollectionRun(db, admin, { source: "hepsiburada" });
    const keys = input.units.map((u) => u.key);
    await planDiscoveryUnits(db, admin, { runId: run.id, kind: "sitemap_file", keys });
    await approveRunDownload(db, admin, {
      runId: run.id,
      bytes: 50_000_000,
      transferOrigin: "admin_wifi",
    });
    await reserveRequests(db, admin, { runId: run.id, count: input.units.length });
    let requests = 0;
    for (const u of input.units) {
      if (input.skip?.includes(u.key)) continue; // birim gönderilmez: pending kalır
      requests += 1;
      seq += 1;
      await submitDiscoveryBatch(db, admin, {
        runId: run.id,
        kind: "sitemap_file",
        unitKey: u.key,
        status: "done",
        bytesReceived: 1000,
        requestsMade: requests,
        fetchedAt: new Date(Date.now() - 100_000_000 + seq * 60_000).toISOString(),
        items: u.items.map((c) => item(c, u.key)),
      });
    }
    await closeCollectionRun(db, admin, { runId: run.id, outcome: "completed" });
    return run.id;
  }

  async function row(code: string) {
    return withOwnerClient(async (c) => {
      const r = await c.query(
        "SELECT presence, missed_scans FROM catalog_discovery WHERE source='hepsiburada' AND external_id=$1",
        [code],
      );
      return r.rows[0] as { presence: string; missed_scans: number };
    });
  }

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (c) => {
      const r = await c.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'admin') RETURNING id",
        [`presence-${suffix}@test.local`],
      );
      admin = { userId: Number(r.rows[0].id), role: "admin" };
    });
    await reset();
  });

  afterAll(async () => {
    await reset();
    await withOwnerClient(async (c) => {
      await c.query("UPDATE collection_source SET enabled = FALSE WHERE source = 'hepsiburada'");
      await c.query("DELETE FROM admin_audit_event WHERE target_type = 'collection_run'");
      await c.query("DELETE FROM app_user WHERE email = $1", [`presence-${suffix}@test.local`]);
    });
  });

  it("iki ardışık tam taramada görülmeyen kayıt kaldırılır; görülen kayıtlar present kalır", async () => {
    await scan({
      units: [
        { key: U1, items: ["HBCPRA0001", "HBCPRB0002"] },
        { key: U2, items: ["HBCPRC0003"] },
      ],
    });
    expect(await row("HBCPRB0002")).toEqual({ presence: "present", missed_scans: 0 });

    await scan({
      units: [
        { key: U1, items: ["HBCPRA0001"] },
        { key: U2, items: ["HBCPRC0003"] },
      ],
    });
    expect(await row("HBCPRB0002")).toEqual({ presence: "missing", missed_scans: 1 });
    expect(await row("HBCPRA0001")).toEqual({ presence: "present", missed_scans: 0 });

    await scan({
      units: [
        { key: U1, items: ["HBCPRA0001"] },
        { key: U2, items: ["HBCPRC0003"] },
      ],
    });
    expect(await row("HBCPRB0002")).toEqual({ presence: "removed", missed_scans: 2 });
    expect(await row("HBCPRC0003")).toEqual({ presence: "present", missed_scans: 0 });
  });

  it("tamamlanmamış birim (pending) içeren koşu hiçbir sayımı değiştirmez", async () => {
    const before = await row("HBCPRB0002");
    const cp = await withOwnerClient(
      async (c) =>
        (
          await c.query(
            "SELECT last_finalized_run_id FROM catalog_discovery_scan_state WHERE source='hepsiburada'",
          )
        ).rows[0],
    );
    await scan({
      units: [
        { key: U1, items: ["HBCPRA0001"] },
        { key: U2, items: ["HBCPRC0003"] },
      ],
      skip: [U2],
    });
    expect(await row("HBCPRB0002")).toEqual(before);
    expect(await row("HBCPRC0003")).toEqual({ presence: "present", missed_scans: 0 });
    const after = await withOwnerClient(
      async (c) =>
        (
          await c.query(
            "SELECT last_finalized_run_id FROM catalog_discovery_scan_state WHERE source='hepsiburada'",
          )
        ).rows[0],
    );
    expect(after).toEqual(cp);
  });

  it("kaldırılan kayıt geri gelirse present olur ve sayaç sıfırlanır", async () => {
    await scan({
      units: [
        { key: U1, items: ["HBCPRA0001", "HBCPRB0002"] },
        { key: U2, items: ["HBCPRC0003"] },
      ],
    });
    expect(await row("HBCPRB0002")).toEqual({ presence: "present", missed_scans: 0 });
  });

  it("aynı koşu iki kez uygulanmaz; eski koşu daha yeni kontrol noktasını geri alamaz", async () => {
    const latest = await withOwnerClient(async (c) =>
      Number(
        (
          await c.query(
            "SELECT last_finalized_run_id FROM catalog_discovery_scan_state WHERE source='hepsiburada'",
          )
        ).rows[0].last_finalized_run_id,
      ),
    );
    const older = await withOwnerClient(async (c) =>
      Number(
        (
          await c.query(
            "SELECT id FROM collection_run WHERE source='hepsiburada' AND status='completed' AND id < $1 ORDER BY id DESC LIMIT 1",
            [latest],
          )
        ).rows[0].id,
      ),
    );
    const again = await db.transaction((tx) =>
      applyRunPresence(tx as unknown as Database, { source: "hepsiburada", runId: latest }),
    );
    expect(again.applied).toBe(false);
    const stale = await db.transaction((tx) =>
      applyRunPresence(tx as unknown as Database, { source: "hepsiburada", runId: older }),
    );
    expect(stale.applied).toBe(false);
  });

  it("kapanış denetim kaydı kaldırılma sayımını taşır", async () => {
    const n = await withOwnerClient(async (c) =>
      Number(
        (
          await c.query(
            "SELECT count(*) FROM admin_audit_event WHERE action = 'catalog_collection.presence'",
          )
        ).rows[0].count,
      ),
    );
    expect(n).toBeGreaterThanOrEqual(1);
  });
});
