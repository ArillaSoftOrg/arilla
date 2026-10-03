/**
 * Karar 0050 güvenlik sertleştirmesi - gerçek YEREL Postgres.
 *
 * - Rol değişikliği motorda denetlenir (0036 tetikleyicisi): aktör, hedef,
 *   eski/yeni rol, sonuç, bağlanan veritabanı rolü; geri alınan işlemde iz yok.
 * - Reddedilen yönetim erişimi kaydı (tekilleştirmeli).
 * - Oturum kapatma: kendi (`revokeOwnSessions`) ve yönetici (`revokeUserSessions`).
 * - Hesap silme: yetkili hesap silinemez; eski personel silinir, denetim
 *   satırları kalır (aktör NULL); oturum/kimlik/giriş bağlantısı temizlenir.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteAccount, StaffAccountDeletionError } from "../account/delete-account.ts";
import { verifySessionToken } from "../auth/session.ts";
import { hashToken } from "../auth/token.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { AdminForbiddenError } from "./capabilities.ts";
import {
  ACCESS_DENIED_DEDUPE_MINUTES,
  recordAccessDenied,
  recordAdminSessionEnded,
  revokeOwnSessions,
  revokeUserSessions,
  SessionRevokeValidationError,
} from "./security.ts";

function assertLocal(): void {
  for (const name of ["DATABASE_URL", "DATABASE_URL_OWNER"]) {
    const host = new URL(process.env[name] ?? "").hostname;
    if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
      throw new Error(`${name} yerel degil; bu test yalnizca yerel veritabaninda calisir.`);
    }
  }
}

const TAG = `sec${Date.now().toString(36)}`;
const created: number[] = [];
let db: Database;

async function createUser(
  key: string,
  role = "user",
): Promise<{ id: number; publicId: string; email: string }> {
  const email = `${TAG}-${key}@test.local`;
  const row = await withOwnerClient(async (client) => {
    const res = await client.query(
      "INSERT INTO app_user (email, role) VALUES ($1, $2) RETURNING id, public_id",
      [email, role],
    );
    return res.rows[0];
  });
  const id = Number(row.id);
  created.push(id);
  return { id, publicId: String(row.public_id), email };
}

async function addSession(userId: number, raw: string): Promise<void> {
  await withOwnerClient((client) =>
    client.query("INSERT INTO session (user_id, token_hash, expires_at) VALUES ($1, $2, $3)", [
      userId,
      hashToken(raw),
      new Date(Date.now() + 60 * 60 * 1000),
    ]),
  );
}

async function sessionCount(userId: number): Promise<number> {
  return withOwnerClient(async (client) => {
    const res = await client.query("SELECT count(*)::int AS n FROM session WHERE user_id = $1", [
      userId,
    ]);
    return res.rows[0].n as number;
  });
}

interface AuditRow {
  actor_user_id: string | null;
  actor_role: string;
  action: string;
  target_type: string;
  target_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
}

async function auditRows(action: string, targetId: string | number): Promise<AuditRow[]> {
  return withOwnerClient(async (client) => {
    const res = await client.query(
      `SELECT actor_user_id, actor_role, action, target_type, target_id, before, after, reason
         FROM admin_audit_event WHERE action = $1 AND target_id = $2 ORDER BY id`,
      [action, String(targetId)],
    );
    return res.rows as AuditRow[];
  });
}

/** Uygulama rolüyle (arilla_app) ham SQL: ele geçirilmiş uygulama rolünü taklit eder. */
async function asAppRole(statements: (client: import("pg").Client) => Promise<void>) {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await statements(client);
  } finally {
    await client.end();
  }
}

beforeAll(() => {
  assertLocal();
  db = getTestDb();
});

afterAll(async () => {
  await withOwnerClient(async (client) => {
    await client.query("DELETE FROM admin_audit_event WHERE target_id = ANY($1::text[])", [
      created.map(String),
    ]);
    await client.query("DELETE FROM admin_audit_event WHERE actor_user_id = ANY($1::bigint[])", [
      created,
    ]);
    await client.query("DELETE FROM auth_token WHERE email LIKE $1", [`${TAG}-%`]);
    await client.query("DELETE FROM app_user WHERE id = ANY($1::bigint[])", [created]);
  });
});

describe("rol değişikliği denetimi (0036 tetikleyicisi)", () => {
  it("uygulama rolüyle yapılan rol yükseltmesi bile iz bırakır: eski/yeni rol, sonuç, db rolü", async () => {
    const target = await createUser("promote");
    await asAppRole(async (client) => {
      await client.query("UPDATE app_user SET role = 'admin' WHERE id = $1", [target.id]);
    });

    const rows = await auditRows("users.role_change", target.id);
    expect(rows).toHaveLength(1);
    const row = rows[0] as AuditRow;
    expect(row.actor_user_id).toBeNull();
    expect(row.actor_role).toBe("db");
    expect(row.target_type).toBe("app_user");
    expect(row.before).toEqual({ role: "user" });
    expect(row.after).toMatchObject({ role: "admin", outcome: "applied" });
    // Bağlanan rol yazılır; sahte aktör ayarı bunu değiştiremez.
    expect(typeof row.after?.dbRole).toBe("string");
    expect(row.after?.dbRole).not.toBe("");
    // Kişisel veri yok.
    expect(JSON.stringify(row)).not.toContain(target.email);
  });

  it("aktör ve gerekçe oturum ayarından okunur (betik yolu)", async () => {
    const actor = await createUser("actor", "admin");
    const target = await createUser("demote", "moderator");
    await withOwnerClient(async (client) => {
      await client.query("BEGIN");
      await client.query(
        `SELECT set_config('arilla.audit_actor_user_id', $1, true),
                set_config('arilla.audit_actor_role', 'cli', true),
                set_config('arilla.audit_reason', 'yetki geri alindi', true)`,
        [String(actor.id)],
      );
      await client.query("UPDATE app_user SET role = 'user' WHERE id = $1", [target.id]);
      await client.query("COMMIT");
    });

    const rows = await auditRows("users.role_change", target.id);
    // İlki hesap 'moderator' olarak açılırken (INSERT), ikincisi düşürme.
    expect(rows.map((r) => r.after?.role)).toEqual(["moderator", "user"]);
    const demotion = rows[1] as AuditRow;
    expect(Number(demotion.actor_user_id)).toBe(actor.id);
    expect(demotion.actor_role).toBe("cli");
    expect(demotion.before).toEqual({ role: "moderator" });
    expect(demotion.reason).toBe("yetki geri alindi");
  });

  it("geri alınan rol değişikliği denetimde görünmez (satır = uygulandı)", async () => {
    const target = await createUser("rollback");
    await withOwnerClient(async (client) => {
      await client.query("BEGIN");
      await client.query("UPDATE app_user SET role = 'admin' WHERE id = $1", [target.id]);
      await client.query("ROLLBACK");
    });
    expect(await auditRows("users.role_change", target.id)).toHaveLength(0);
  });

  it("rolü değişmeyen güncelleme ve normal hesap açılışı satır yazmaz", async () => {
    const target = await createUser("noop");
    await withOwnerClient((client) =>
      client.query("UPDATE app_user SET role = role, last_seen_at = now() WHERE id = $1", [
        target.id,
      ]),
    );
    expect(await auditRows("users.role_change", target.id)).toHaveLength(0);
  });

  it("uygulama rolü denetim kaydını değiştiremez, silemez, tetikleyiciyi kapatamaz", async () => {
    const target = await createUser("immutable");
    await withOwnerClient((client) =>
      client.query("UPDATE app_user SET role = 'moderator' WHERE id = $1", [target.id]),
    );
    for (const statement of [
      "UPDATE admin_audit_event SET reason = 'x' WHERE target_id = $1",
      "DELETE FROM admin_audit_event WHERE target_id = $1",
    ]) {
      await asAppRole(async (client) => {
        await expect(client.query(statement, [String(target.id)])).rejects.toMatchObject({
          code: "42501",
        });
      });
    }
    await asAppRole(async (client) => {
      await expect(
        client.query("ALTER TABLE app_user DISABLE TRIGGER app_user_role_change_audit"),
      ).rejects.toMatchObject({ code: "42501" });
    });
    expect(await auditRows("users.role_change", target.id)).toHaveLength(1);
  });
});

describe("reddedilen yönetim erişimi", () => {
  it("hesap + yetenek başına tekilleştirilir, yetenek adı hedeftir, kişisel veri yok", async () => {
    const user = await createUser("denied");
    await recordAccessDenied(db, { id: user.id, role: "user" }, "admin.access");
    await recordAccessDenied(db, { id: user.id, role: "user" }, "admin.access");
    await recordAccessDenied(db, { id: user.id, role: "user" }, "users.read");

    const rows = await withOwnerClient(async (client) => {
      const res = await client.query(
        `SELECT actor_role, target_type, target_id, after FROM admin_audit_event
          WHERE action = 'security.access_denied' AND actor_user_id = $1 ORDER BY id`,
        [user.id],
      );
      return res.rows;
    });
    expect(ACCESS_DENIED_DEDUPE_MINUTES).toBeGreaterThan(0);
    expect(rows.map((r) => r.target_id)).toEqual(["admin.access", "users.read"]);
    expect(rows[0]).toMatchObject({
      actor_role: "user",
      target_type: "capability",
      after: { outcome: "denied" },
    });
  });

  it("eşzamanlı istekler (layout + sayfa) tek satır yazar", async () => {
    const user = await createUser("denied-race");
    await Promise.all(
      Array.from({ length: 8 }, () =>
        recordAccessDenied(db, { id: user.id, role: "user" }, "admin.access"),
      ),
    );
    const n = await withOwnerClient(async (client) => {
      const res = await client.query(
        `SELECT count(*)::int AS n FROM admin_audit_event
          WHERE action = 'security.access_denied' AND actor_user_id = $1`,
        [user.id],
      );
      return res.rows[0].n as number;
    });
    expect(n).toBe(1);
  });

  it("yönetim oturumu sonlandırması denetime yazılır", async () => {
    const admin = await createUser("ended", "admin");
    await recordAdminSessionEnded(db, { id: admin.id, role: "admin" }, "idle");
    const rows = await auditRows("security.admin_session_ended", admin.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.after).toEqual({ reason: "idle", outcome: "session_deleted" });
  });
});

describe("oturum kapatma", () => {
  it("kendi isteği: bütün oturumlar gider; yetkili hesapta denetim satırı, normal hesapta yok", async () => {
    const admin = await createUser("selfadmin", "admin");
    const user = await createUser("selfuser");
    for (const n of [1, 2, 3]) await addSession(admin.id, `${TAG}-sa-${n}`);
    for (const n of [1, 2]) await addSession(user.id, `${TAG}-su-${n}`);

    expect(await revokeOwnSessions(db, { id: admin.id, role: "admin" })).toEqual({ count: 3 });
    expect(await revokeOwnSessions(db, { id: user.id, role: "user" })).toEqual({ count: 2 });
    expect(await sessionCount(admin.id)).toBe(0);
    expect(await sessionCount(user.id)).toBe(0);
    expect(await verifySessionToken(db, `${TAG}-sa-1`)).toBeNull();

    const adminRows = await auditRows("sessions.revoke_all", admin.id);
    expect(adminRows).toHaveLength(1);
    expect(adminRows[0]?.after).toEqual({ count: 3, scope: "self", outcome: "applied" });
    expect(await auditRows("sessions.revoke_all", user.id)).toHaveLength(0);
  });

  it("yönetici: hedefin oturumları gider, başkasınınki kalır, gerekçe denetime yazılır", async () => {
    const admin = await createUser("revoker", "admin");
    const target = await createUser("victim", "moderator");
    const bystander = await createUser("bystander");
    await addSession(target.id, `${TAG}-v-1`);
    await addSession(target.id, `${TAG}-v-2`);
    await addSession(bystander.id, `${TAG}-b-1`);

    const result = await revokeUserSessions(
      db,
      { userId: admin.id, role: "admin" },
      { publicId: target.publicId.toUpperCase(), reason: "cerez sizintisi suphesi" },
    );
    expect(result).toEqual({ found: true, count: 2 });
    expect(await sessionCount(target.id)).toBe(0);
    expect(await sessionCount(bystander.id)).toBe(1);

    const rows = await auditRows("sessions.revoke_all", target.id);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.actor_user_id)).toBe(admin.id);
    expect(rows[0]?.reason).toBe("cerez sizintisi suphesi");
    expect(rows[0]?.after).toEqual({ count: 2, scope: "admin", outcome: "applied" });
  });

  it("moderatör ve normal kullanıcı yönetici oturum kapatmasını yapamaz; gerekçe zorunlu", async () => {
    const target = await createUser("protected");
    await addSession(target.id, `${TAG}-p-1`);
    for (const role of ["moderator", "user"] as const) {
      await expect(
        revokeUserSessions(
          db,
          { userId: target.id, role },
          { publicId: target.publicId, reason: "deneme" },
        ),
      ).rejects.toBeInstanceOf(AdminForbiddenError);
    }
    await expect(
      revokeUserSessions(
        db,
        { userId: target.id, role: "admin" },
        { publicId: target.publicId, reason: "x" },
      ),
    ).rejects.toBeInstanceOf(SessionRevokeValidationError);
    expect(
      await revokeUserSessions(
        db,
        { userId: target.id, role: "admin" },
        { publicId: "not-a-uuid", reason: "gecerli gerekce" },
      ),
    ).toEqual({ found: false });
    expect(await sessionCount(target.id)).toBe(1);
  });
});

describe("hesap silme", () => {
  it("yetkili hesap kendini silemez; hiçbir şey silinmez", async () => {
    const admin = await createUser("staffdel", "admin");
    await addSession(admin.id, `${TAG}-sd-1`);
    await expect(deleteAccount(db, admin.id)).rejects.toBeInstanceOf(StaffAccountDeletionError);
    expect(await sessionCount(admin.id)).toBe(1);
    const exists = await withOwnerClient(
      async (client) =>
        (await client.query("SELECT 1 FROM app_user WHERE id = $1", [admin.id])).rowCount,
    );
    expect(exists).toBe(1);
  });

  it("rolü düşürülmüş eski personel silinir: denetim satırları kalır (aktör NULL), oturum/kimlik/bağlantı temizlenir", async () => {
    const former = await createUser("former", "moderator");
    const identityEmail = `${TAG}-former-apple@test.local`;
    await addSession(former.id, `${TAG}-f-1`);
    await withOwnerClient(async (client) => {
      // Eski personelin yazdığı denetim izi ve incelediği eşleşme (FK'ler 0036 öncesi silmeyi engelliyordu).
      await client.query(
        `INSERT INTO admin_audit_event (actor_user_id, actor_role, action, target_type, target_id)
         VALUES ($1, 'moderator', 'lexicon.update', 'lexicon', $2)`,
        [former.id, `${TAG}-lex`],
      );
      await client.query(
        `INSERT INTO user_identity (user_id, provider, provider_subject, email, email_verified)
         VALUES ($1, 'apple', $2, $3, true)`,
        [former.id, `${TAG}-apple-sub`, identityEmail],
      );
      await client.query(
        `INSERT INTO auth_token (email, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour'),
                                                                      ($3, $4, now() + interval '1 hour')`,
        [former.email, hashToken(`${TAG}-t1`), identityEmail.toUpperCase(), hashToken(`${TAG}-t2`)],
      );
      await client.query("UPDATE app_user SET role = 'user' WHERE id = $1", [former.id]);
    });

    await deleteAccount(db, former.id);

    const state = await withOwnerClient(async (client) => {
      const q = async (sql: string, params: unknown[]) =>
        Number((await client.query(sql, params)).rows[0].n);
      return {
        user: await q("SELECT count(*) AS n FROM app_user WHERE id = $1", [former.id]),
        sessions: await q("SELECT count(*) AS n FROM session WHERE user_id = $1", [former.id]),
        identities: await q("SELECT count(*) AS n FROM user_identity WHERE user_id = $1", [
          former.id,
        ]),
        tokens: await q("SELECT count(*) AS n FROM auth_token WHERE lower(email) = ANY($1)", [
          [former.email, identityEmail],
        ]),
        auditKept: await q(
          `SELECT count(*) AS n FROM admin_audit_event
            WHERE target_id = $1 AND action = 'lexicon.update' AND actor_user_id IS NULL
              AND actor_role = 'moderator'`,
          [`${TAG}-lex`],
        ),
        roleHistory: await q(
          "SELECT count(*) AS n FROM admin_audit_event WHERE action = 'users.role_change' AND target_id = $1",
          [String(former.id)],
        ),
      };
    });
    expect(state).toEqual({
      user: 0,
      sessions: 0,
      identities: 0,
      tokens: 0,
      auditKept: 1,
      roleHistory: 2,
    });
    expect(await verifySessionToken(db, `${TAG}-f-1`)).toBeNull();
  });
});
