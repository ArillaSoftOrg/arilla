/**
 * Son güvenlik regresyonu (P4, karar 0050): proxy + sayfa + route handler
 * zinciri gerçek bir `next start` üzerinden. Arayüz gizleme yetki sayılmaz;
 * burada her istek doğrudan atılır.
 *
 * Kapsam: anonim/normal/moderatör/yönetici sınırları, sahte ve iptal edilmiş
 * oturum, rol düşürme, 12 saat / 30 dk kuralı, kullanıcı A → B (IDOR), açık
 * yönlendirme, sahte iç başlık, CSRF (route handler), cron sırrı, abonelik
 * iptali GET'i, güvenlik başlıkları ve denetim izleri.
 */
import { createHash, randomBytes } from "node:crypto";
import { generateRawToken, hashToken } from "@arilla/core";
import { createDatabase } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function requireLocal(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} tanımlı değil`);
  const host = new URL(value).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`${name} yerel değil (${host}); E2E yalnızca yerelde çalışır.`);
  }
  return value;
}

const BASE = requireLocal("E2E_BASE_URL").replace(/\/+$/, "");
const TAG = `e2e${Date.now().toString(36)}`;
const ids: Record<string, number> = {};
const publicIds: Record<string, string> = {};

type OwnerClient = ReturnType<typeof createDatabase>["$client"];
let ownerPool: OwnerClient | undefined;

async function owner<T>(fn: (client: OwnerClient) => Promise<T>): Promise<T> {
  ownerPool ??= createDatabase(requireLocal("DATABASE_URL_OWNER")).$client;
  return fn(ownerPool);
}

async function createUser(key: string, role: string): Promise<void> {
  await owner(async (client) => {
    const res = await client.query(
      "INSERT INTO app_user (email, role) VALUES ($1, $2) RETURNING id, public_id",
      [`${TAG}-${key}@test.local`, role],
    );
    ids[key] = Number(res.rows[0].id);
    publicIds[key] = String(res.rows[0].public_id);
  });
}

/** `ageMinutes` önce açılmış, `idleMinutes` önce son kullanılmış oturum. */
async function session(key: string, ageMinutes = 1, idleMinutes = 0): Promise<string> {
  const raw = generateRawToken();
  await owner((client) =>
    client.query(
      `INSERT INTO session (user_id, token_hash, expires_at, created_at, last_used_at)
       VALUES ($1, $2, now() + interval '1 day',
               now() - ($3 || ' minutes')::interval, now() - ($4 || ' minutes')::interval)`,
      [ids[key], hashToken(raw), String(ageMinutes), String(idleMinutes)],
    ),
  );
  return raw;
}

async function get(
  path: string,
  options: { token?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    redirect: "manual",
    headers: {
      ...(options.token ? { cookie: `session=${options.token}` } : {}),
      ...options.headers,
    },
  });
}

function location(response: Response): string | null {
  const value = response.headers.get("location");
  return value ? new URL(value, BASE).pathname + new URL(value, BASE).search : null;
}

async function auditCount(action: string, actorKey: string, targetId?: string): Promise<number> {
  return owner(async (client) => {
    const res = await client.query(
      `SELECT count(*)::int AS n FROM admin_audit_event
        WHERE action = $1 AND actor_user_id = $2 AND ($3::text IS NULL OR target_id = $3)`,
      [action, ids[actorKey], targetId ?? null],
    );
    return res.rows[0].n as number;
  });
}

beforeAll(async () => {
  requireLocal("DATABASE_URL_OWNER");
  const health = await fetch(`${BASE}/`, { redirect: "manual" }).catch(() => null);
  if (!health) throw new Error(`Sunucu yok: ${BASE} (önce next start)`);
  for (const [key, role] of [
    ["userA", "user"],
    ["userB", "user"],
    ["moderator", "moderator"],
    ["admin", "admin"],
    ["demoted", "admin"],
  ] as const) {
    await createUser(key, role);
  }
});

afterAll(async () => {
  const all = Object.values(ids);
  await owner(async (client) => {
    await client.query("DELETE FROM admin_audit_event WHERE actor_user_id = ANY($1)", [all]);
    await client.query(
      "DELETE FROM admin_audit_event WHERE target_type = 'app_user' AND target_id = ANY($1::text[])",
      [all.map(String)],
    );
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [all]);
  });
  await ownerPool?.end();
});

describe("yönetim sınırı", () => {
  it("anonim: her yönetim yolu dönüş yoluyla yönetim girişine", async () => {
    for (const path of ["/yonetim", "/yonetim/denetim", "/yonetim/kullanicilar?q=x"]) {
      const response = await get(path);
      expect(response.status).toBe(307);
      expect(location(response)).toMatch(/^\/yonetim\/giris/);
    }
    expect(location(await get("/yonetim/denetim"))).toBe(
      "/yonetim/giris?next=%2Fyonetim%2Fdenetim",
    );
  });

  it("anonim: kullanıcı sayfaları girişe", async () => {
    for (const path of ["/hesap", "/hesap/veri-indir", "/kaydettiklerim", "/alarmlar", "/gecmis"]) {
      const response = await get(path);
      expect(response.status).toBe(307);
      expect(location(response)).toMatch(/^\/giris/);
    }
  });

  it("normal kullanıcı: yönetim 404, varlık açığa çıkmaz; deneme denetimde", async () => {
    const token = await session("userA");
    for (const path of [
      "/yonetim",
      "/yonetim/kullanicilar",
      `/yonetim/kullanicilar/${publicIds.userB}`,
    ]) {
      const response = await get(path, { token });
      expect(response.status).toBe(404);
      const html = await response.text();
      expect(html).not.toContain(`${TAG}-userB`);
    }
    expect(await auditCount("security.access_denied", "userA", "admin.access")).toBe(1);
  });

  it("moderatör: konsol evet; denetim, kullanıcılar, kampanyalar hayır", async () => {
    const token = await session("moderator");
    expect((await get("/yonetim", { token })).status).toBe(200);
    expect((await get("/yonetim/sozluk", { token })).status).toBe(200);
    for (const path of ["/yonetim/denetim", "/yonetim/kullanicilar", "/yonetim/kampanyalar"]) {
      expect((await get(path, { token })).status).toBe(404);
    }
  });

  it("yönetici: tüm konsol; kullanıcı ayrıntısı maskeli ve görüntüleme denetimde", async () => {
    const token = await session("admin");
    for (const path of [
      "/yonetim",
      "/yonetim/denetim",
      "/yonetim/kullanicilar",
      "/yonetim/islemler",
    ]) {
      expect((await get(path, { token })).status).toBe(200);
    }
    const detail = await get(`/yonetim/kullanicilar/${publicIds.userB}`, { token });
    expect(detail.status).toBe(200);
    const html = await detail.text();
    expect(html).not.toContain(`${TAG}-userB@test.local`);
    expect(await auditCount("users.view", "admin", String(ids.userB))).toBe(1);

    // Oturumlar sekmesi (0049) hassastır; oturum kapatma denetimi orada (0050).
    const sessions = await get(`/yonetim/kullanicilar/${publicIds.userB}?sekme=oturumlar`, {
      token,
    });
    expect(sessions.status).toBe(200);
    const sessionsHtml = await sessions.text();
    expect(sessionsHtml).toContain("Tüm oturumları kapat");
    expect(sessionsHtml).not.toContain(`${TAG}-userB@test.local`);
    expect(await auditCount("users.view_tab", "admin", String(ids.userB))).toBe(1);
  });

  it("moderatör hassas kullanıcı sekmelerine adresle de giremez", async () => {
    const token = await session("moderator");
    for (const sekme of ["oturumlar", "aktivite", "denetim"]) {
      const response = await get(`/yonetim/kullanicilar/${publicIds.userB}?sekme=${sekme}`, {
        token,
      });
      expect(response.status).toBe(404);
    }
  });
});

describe("oturum bütünlüğü", () => {
  it("sahte çerez anonimdir", async () => {
    const forged = randomBytes(32).toString("base64url");
    const response = await get("/yonetim", { token: forged });
    expect(response.status).toBe(307);
    expect(location(response)).toBe("/yonetim/giris");
    expect(location(await get("/hesap", { token: forged }))).toBe("/giris");
  });

  it("silinen (iptal edilen) oturum bir sonraki istekte geçersiz", async () => {
    const token = await session("admin");
    expect((await get("/yonetim", { token })).status).toBe(200);
    await owner((client) =>
      client.query("DELETE FROM session WHERE token_hash = $1", [hashToken(token)]),
    );
    expect(location(await get("/yonetim", { token }))).toBe("/yonetim/giris");
  });

  it("rol düşürme: aynı çerezle bir sonraki istekte 404; değişiklik denetimde", async () => {
    const token = await session("demoted");
    expect((await get("/yonetim/denetim", { token })).status).toBe(200);
    await owner((client) =>
      client.query("UPDATE app_user SET role = 'user' WHERE id = $1", [ids.demoted]),
    );
    expect((await get("/yonetim/denetim", { token })).status).toBe(404);
    const rows = await owner(async (client) => {
      const res = await client.query(
        `SELECT before, after FROM admin_audit_event
          WHERE action = 'users.role_change' AND target_id = $1 ORDER BY id`,
        [String(ids.demoted)],
      );
      return res.rows;
    });
    expect(rows.at(-1)).toMatchObject({
      before: { role: "admin" },
      after: { role: "user", outcome: "applied" },
    });
  });

  it("12 saati aşan yönetim oturumu sunucuda silinir; yenileme aşamaz", async () => {
    const token = await session("admin", 13 * 60, 1);
    const first = await get("/yonetim/denetim", { token });
    expect(location(first)).toBe("/yonetim/giris?next=%2Fyonetim%2Fdenetim&neden=sure");
    expect(location(await get("/yonetim/denetim", { token }))).toBe(
      "/yonetim/giris?next=%2Fyonetim%2Fdenetim",
    );
    expect(await auditCount("security.admin_session_ended", "admin")).toBeGreaterThanOrEqual(1);
  });

  it("30 dakika boşta kalan yönetim oturumu kapanır", async () => {
    const token = await session("moderator", 60, 45);
    expect(location(await get("/yonetim/sozluk", { token }))).toBe(
      "/yonetim/giris?next=%2Fyonetim%2Fsozluk&neden=bosta",
    );
  });
});

describe("kullanıcı verisi yalıtımı", () => {
  it("veri indirme yalnızca oturum sahibinin verisini döner (istemci kimliği yok sayılır)", async () => {
    const token = await session("userA");
    const response = await get(
      `/hesap/veri-indir?userId=${ids.userB}&publicId=${publicIds.userB}`,
      {
        token,
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    const data = (await response.json()) as { profile: { publicId: string; email: string } };
    expect(data.profile.publicId).toBe(publicIds.userA);
    expect(JSON.stringify(data)).not.toContain(publicIds.userB);
    expect(JSON.stringify(data)).not.toContain(`${TAG}-userB`);
  });
});

describe("yönlendirme ve başlık sahteciliği", () => {
  it("yönetim girişi dış adrese dönüş yolu kabul etmez", async () => {
    // Next'in yönlendirici durumu mevcut adresi kaçışlı olarak taşır; o bir
    // hedef değildir. Denetlenen: bağlantılar, form değerleri, yönlendirme.
    for (const next of [
      "//evil.example",
      "https://evil.example/yonetim",
      "/\\evil.example",
      "/hesap",
    ]) {
      const response = await get(`/yonetim/giris?next=${encodeURIComponent(next)}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      const html = await response.text();
      expect(html).not.toMatch(/(href|action|value)="[^"]*evil\.example/);
      expect(html).not.toMatch(/(href|action|value)="[^"]*%2Fhesap/);
    }
  });

  it("istemcinin gönderdiği iç yol başlığı ezilir", async () => {
    const response = await get("/yonetim/denetim", {
      headers: { "x-arilla-path": "//evil.example" },
    });
    expect(location(response)).toBe("/yonetim/giris?next=%2Fyonetim%2Fdenetim");
  });

  it("Google girişi: güvensiz next çereze yazılmaz, state çerezi httpOnly", async () => {
    const response = await get(`/giris/google?next=${encodeURIComponent("//evil.example")}`);
    expect([302, 303, 307]).toContain(response.status);
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("auth_next=") && c.includes("evil"))).toBe(false);
    const target = response.headers.get("location") ?? "";
    if (target.startsWith("https://accounts.google.com/")) {
      const state = cookies.find((c) => c.startsWith("google_oauth_state="));
      expect(state).toMatch(/HttpOnly/i);
      expect(state).toMatch(/SameSite=lax/i);
    } else {
      // GOOGLE_* tanımsız ortam: sağlayıcıya hiç gidilmez.
      expect(new URL(target, BASE).pathname).toBe("/giris");
    }
  });
});

describe("CSRF ve makine uçları", () => {
  it("telefon doğrulama route handler'ı başka kökenden POST'u reddeder", async () => {
    const response = await fetch(`${BASE}/giris/telefon/dogrula`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "code=123456",
    });
    expect(response.status).toBe(303);
    expect(location(response)).toBe("/giris/telefon?hata=gecersiz");
  });

  it("cron uçları sırsız ve yanlış sırla 401", async () => {
    for (const path of ["/api/cron/cleanup-auth", "/api/cron/trigger-alerts"]) {
      expect((await get(path)).status).toBe(401);
      expect(
        (await get(path, { headers: { authorization: `Bearer ${"x".repeat(40)}` } })).status,
      ).toBe(401);
    }
  });

  it("abonelik iptali GET hiçbir şey değiştirmez; geçersiz token POST 400", async () => {
    const token = createHash("sha256").update(TAG).digest("base64url").slice(0, 43);
    const getResponse = await get(`/api/email/unsubscribe?t=${token}`);
    expect(getResponse.status).toBe(303);
    expect(getResponse.headers.get("referrer-policy")).toBe("no-referrer");
    const post = await fetch(`${BASE}/api/email/unsubscribe?t=${token}`, { method: "POST" });
    expect(post.status).toBe(400);
  });
});

describe("güvenlik başlıkları", () => {
  it("public, giriş ve yönetim yanıtlarında çerçeve yasağı ve CSP", async () => {
    const adminToken = await session("admin");
    for (const [path, token] of [
      ["/", undefined],
      ["/giris", undefined],
      ["/yonetim/giris", undefined],
      ["/yonetim/denetim", adminToken],
    ] as const) {
      const response = await get(path, { token });
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      const csp = response.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(response.headers.get("x-powered-by")).toBeNull();
    }
    const admin = await get("/yonetim/denetim", { token: adminToken });
    expect(admin.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});
