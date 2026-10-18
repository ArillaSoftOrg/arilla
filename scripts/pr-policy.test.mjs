// PR politikası birim testleri (docs/decisions/0137).  node --test scripts/
import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalValid, classify, decide, parseDependencies } from "./pr-policy.mjs";

const f = (filename, extra = {}) => ({ filename, additions: 1, deletions: 0, ...extra });
const ids = (files) => classify(files).reasons.map((r) => r.id);

test("salt dokümantasyon ve sıradan UI değişikliği düşük risk", () => {
  assert.equal(classify([f("docs/glossary.md"), f("README.md")]).level, "low");
  assert.equal(
    classify([f("apps/web/app/ara/SearchBox.tsx"), f("packages/ui/src/Button.tsx")]).level,
    "low",
  );
});

test("hassas alanlar yüksek risk", () => {
  assert.deepEqual(ids([f("packages/db/migrations/0091_x.sql")]), ["migration"]);
  assert.deepEqual(ids([f("docs/schema.sql")]), ["migration"]);
  assert.deepEqual(ids([f("packages/core/src/auth/session.ts")]), ["auth"]);
  assert.deepEqual(ids([f("apps/web/app/yonetim/page.tsx")]), ["auth"]);
  assert.deepEqual(ids([f("apps/web/proxy.ts")]), ["auth"]);
  assert.deepEqual(ids([f(".github/workflows/ci.yml")]), ["production-config"]);
  assert.deepEqual(ids([f("infra/vps/bin/arilla-deploy")]), ["production-config"]);
  assert.deepEqual(ids([f("CLAUDE.md")]), ["production-config"]);
  assert.deepEqual(ids([f("scripts/pr-policy.mjs")]), ["production-config"]);
  assert.deepEqual(ids([f("pnpm-lock.yaml")]), ["dependencies"]);
  assert.deepEqual(ids([f("packages/core/src/tracking-links/x.ts")]), ["payment"]);
  assert.deepEqual(ids([f("apps/web/app/api/cron/purge-uploads/route.ts")]), ["data-deletion"]);
  assert.deepEqual(ids([f("services/ingest/catalog_build/run.py")]), ["catalog-publish"]);
});

test("yeniden adlandırmada eski yol da sayılır", () => {
  assert.deepEqual(
    ids([f("packages/core/src/x.ts", { previous_filename: "packages/core/src/auth/x.ts" })]),
    ["auth"],
  );
});

test("eklenen satırda yıkıcı SQL yüksek risk; silinen satır ya da .md değil", () => {
  assert.deepEqual(ids([f("packages/core/src/a.ts", { patch: "+await sql`DELETE FROM click`" })]), [
    "destructive-sql",
  ]);
  assert.equal(classify([f("packages/core/src/a.ts", { patch: "-DROP TABLE x" })]).level, "low");
  assert.equal(classify([f("docs/notes.md", { patch: "+DROP TABLE x" })]).level, "low");
});

test("büyük ya da belirsiz değişiklik yüksek risk", () => {
  assert.deepEqual(ids([f("apps/web/a.tsx", { additions: 1600 })]), ["large"]);
  const many = Array.from({ length: 61 }, (_, i) => f(`apps/web/c${i}.tsx`));
  assert.deepEqual(ids(many), ["large"]);
  assert.deepEqual(ids([]), ["unknown"]);
});

test("bağımlılık satırları", () => {
  const body = "Özet\n\nDepends on #12 and #15\n- Bağımlı: #20, #21\n**Requires** #30\nSee #99";
  assert.deepEqual(parseDependencies(body), [12, 15, 20, 21, 30]);
  assert.deepEqual(parseDependencies(null), []);
  assert.deepEqual(parseDependencies("Fixes #4"), []);
});

test("onay: insan, yazma yetkisi, (varsa) liste", () => {
  const human = { login: "dev", type: "User" };
  assert.equal(approvalValid({ labelPresent: true, actor: human, permission: "write" }), true);
  assert.equal(approvalValid({ labelPresent: false, actor: human, permission: "admin" }), false);
  assert.equal(approvalValid({ labelPresent: true, actor: human, permission: "read" }), false);
  assert.equal(
    approvalValid({
      labelPresent: true,
      actor: { login: "github-actions[bot]", type: "Bot" },
      permission: "admin",
    }),
    false,
  );
  assert.equal(
    approvalValid({ labelPresent: true, actor: human, permission: "admin", approvers: ["boss"] }),
    false,
  );
  assert.equal(
    approvalValid({ labelPresent: true, actor: human, permission: "admin", approvers: ["dev"] }),
    true,
  );
});

test("karar: bağımlılık ve onay", () => {
  const low = classify([f("apps/web/a.tsx")]);
  const high = classify([f("packages/db/migrations/0091_x.sql")]);
  assert.equal(decide({ risk: low, deps: [], approved: false }).state, "success");
  assert.equal(decide({ risk: high, deps: [], approved: false }).state, "failure");
  assert.equal(decide({ risk: high, deps: [], approved: true }).state, "success");
  const open = decide({
    risk: low,
    deps: [{ number: 7, merged: false, state: "open" }],
    approved: false,
  });
  assert.equal(open.state, "failure");
  assert.match(open.description, /#7/);
  const closed = decide({
    risk: high,
    deps: [{ number: 8, merged: false, state: "closed" }],
    approved: true,
  });
  assert.match(closed.description, /birleşmeden kapandı/);
  assert.equal(
    decide({ risk: low, deps: [{ number: 9, merged: true, state: "closed" }], approved: false })
      .state,
    "success",
  );
});
