/**
 * `/api/cron/interpret-queries` web sınırı (karar 0059): CRON_SECRET kimlik
 * doğrulaması, anahtar yokken güvenli "atlandı", yanıtta sır yok. Gerçek
 * yerel Postgres; Gemini'ye hiçbir istek gitmez (anahtar tanımsız).
 */
import { createDatabase } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];
const SECRET = "interpret-queries-yerel-test-sirri";
const URL_PATH = "http://localhost/api/cron/interpret-queries";

function assertLocal(name: string): string {
  const url = process.env[name];
  if (!url) throw new Error(`${name} tanımlı değil`);
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.includes(host)) {
    throw new Error(`${name} yerel değil (${host}); bu test yalnızca yerel veritabanında çalışır.`);
  }
  return url;
}

describe("interpret-queries cron ucu", () => {
  // Node ve Postgres saatleri ayrisabilir; temizlik kimlik imleciyle.
  let jobCursor = 0;
  const saved = { cron: process.env.CRON_SECRET, gemini: process.env.GEMINI_API_KEY };

  beforeAll(async () => {
    assertLocal("DATABASE_URL");
    const owner = createDatabase(assertLocal("DATABASE_URL_OWNER"));
    const r = await owner.$client.query("SELECT coalesce(max(id), 0) AS id FROM job_run");
    jobCursor = Number(r.rows[0].id);
    await owner.$client.end();
    delete process.env.GEMINI_API_KEY;
  });

  afterAll(async () => {
    if (saved.cron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved.cron;
    if (saved.gemini !== undefined) process.env.GEMINI_API_KEY = saved.gemini;
    const owner = createDatabase(assertLocal("DATABASE_URL_OWNER"));
    await owner.$client.query(
      "DELETE FROM job_run WHERE job = 'query_interpretation' AND id > $1",
      [jobCursor],
    );
    await owner.$client.end();
  });

  it("CRON_SECRET tanımsızsa uç açık kalmaz", async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await import("./route.ts");
    const response = await GET(
      new Request(URL_PATH, { headers: { authorization: `Bearer ${SECRET}` } }),
    );
    expect(response.status).toBe(500);
  });

  it("başlıksız ya da yanlış sır reddedilir", async () => {
    process.env.CRON_SECRET = SECRET;
    const { GET } = await import("./route.ts");
    expect((await GET(new Request(URL_PATH))).status).toBe(401);
    const wrong = await GET(
      new Request(URL_PATH, { headers: { authorization: "Bearer yanlis-deger-yanlis-deger" } }),
    );
    expect(wrong.status).toBe(401);
  });

  it("doğru sır + GEMINI_API_KEY yok: sağlayıcı çağrılmaz, güvenli atlandı", async () => {
    process.env.CRON_SECRET = SECRET;
    process.env.GEMINI_API_KEY = "";
    const { GET } = await import("./route.ts");
    const response = await GET(
      new Request(URL_PATH, { headers: { authorization: `Bearer ${SECRET}` } }),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text);
    expect(body).toMatchObject({
      status: "skipped",
      skippedReason: "missing_api_key",
      attempted: 0,
      providerCalls: 0,
    });
    expect(text).not.toContain(SECRET);
    expect(text.toLowerCase()).not.toContain("gemini_api_key");
    expect(text).not.toContain("x-goog-api-key");
  });
});
