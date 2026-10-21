import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { maintenanceDocument } from "../../../packages/core/src/maintenance/document.ts";
import {
  INITIAL_STATUS,
  isBlocked,
  parseStatus,
  safeReturnPath,
} from "../../../packages/core/src/maintenance/policy.ts";
import {
  readSystemStatus,
  updateMaintenance,
} from "../../../packages/core/src/maintenance/service.ts";
import worker, { MaintenanceState } from "../worker.ts";

const full = { ...INITIAL_STATUS, mode: "maintenance", message: "Planlı güncelleme sürüyor." };
const partial = { ...full, mode: "partial", services: ["image"] };
const token = "test-only-secret-32-characters-long-enough";

function storage() {
  const values = new Map();
  let queue = Promise.resolve();
  const store = {
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => {
      values.set(key, structuredClone(value));
    },
    transaction(fn) {
      const result = queue.then(async () => {
        const backup = structuredClone(values);
        try {
          return await fn(store);
        } catch (e) {
          values.clear();
          for (const [k, v] of backup) values.set(k, v);
          throw e;
        }
      });
      queue = result.catch(() => {});
      return result;
    },
  };
  return store;
}
function environment() {
  const store = storage();
  const state = new MaintenanceState({ storage: store });
  return {
    store,
    env: {
      STATUS: { idFromName: (x) => x, get: () => state },
      ADMIN_TOKEN: token,
      APP_URL: "https://manicepte.com",
    },
  };
}
function request(path, method = "GET", body, authorized = true) {
  return new Request(`https://status.example${path}`, {
    method,
    headers: {
      ...(authorized ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const change = (status = full) => ({ status, reason: "Planlı güncelleme", actorId: 42 });

test("all four modes enforce the expected route policy", () => {
  assert.equal(isBlocked(INITIAL_STATUS, "/ara"), false);
  assert.equal(isBlocked({ ...full, mode: "planned" }, "/ara"), false);
  assert.equal(isBlocked(full, "/urun/1"), true);
  assert.equal(isBlocked(partial, "/ara/gorsel"), true);
  assert.equal(isBlocked(partial, "/ara/link"), false);
  assert.equal(isBlocked(partial, "/ara/gorselxyz"), false);
  for (const path of [
    "/yonetim/bakim",
    "/api/yonetim/catalog",
    "/giris/google/callback",
    "/api/cron/a",
    "/api/health/ready",
    "/api/system-status",
    "/durum",
  ]) {
    assert.equal(isBlocked(full, path), false, path);
  }
});
test("invalid modes, prototype keys, duplicate services and invalid dates rejected", () => {
  for (const bad of [
    { mode: "__proto__" },
    { mode: "unknown" },
    { mode: "partial" },
    { services: ["constructor"] },
    { services: ["image", "image"] },
    { estimatedEnd: "tomorrow" },
    { version: -1 },
    { message: " " },
    { message: "x".repeat(1501) },
  ]) {
    assert.throws(() => parseStatus({ ...full, ...bad }));
  }
  assert.equal(
    parseStatus({ ...full, estimatedEnd: "2020-01-01T00:00:00.000Z" }).mode,
    "maintenance",
    "ETA does not expire maintenance",
  );
});
test("return paths reject external URLs and discard sensitive query strings", () => {
  for (const input of [
    "//evil.test",
    "/\\evil.test",
    "https://evil.test",
    "/\nattack",
    "/durum",
    "/yonetim",
  ])
    assert.equal(safeReturnPath(input), "/");
  assert.equal(safeReturnPath("/ara?token=secret#fragment"), "/ara");
});
test("public status does not expose audit or credentials", async () => {
  const { env } = environment();
  await worker.fetch(request("/admin/status", "PUT", change()), env);
  const response = await worker.fetch(request("/status?path=/ara", "GET", undefined, false), env);
  const result = await response.json();
  assert.equal(result.blocked, true);
  assert.equal(result.version, 1);
  assert.equal(result.history, undefined);
  assert.equal(result.actorId, undefined);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
test("unauthenticated writes and reads cannot access admin state", async () => {
  const { env } = environment();
  assert.equal(
    (await worker.fetch(request("/admin/status", "PUT", change(), false), env)).status,
    401,
  );
  assert.equal(
    (await worker.fetch(request("/admin/status", "GET", undefined, false), env)).status,
    401,
  );
  assert.equal(
    (await worker.fetch(request("/admin/status", "GET"), { ...env, ADMIN_TOKEN: "short" })).status,
    401,
  );
});
test("simultaneous writes preserve one winner and atomic audit history", async () => {
  const { env } = environment();
  const responses = await Promise.all([
    worker.fetch(request("/admin/status", "PUT", change()), env),
    worker.fetch(request("/admin/status", "PUT", change(partial)), env),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const saved = await (await worker.fetch(request("/admin/status"), env)).json();
  assert.equal(saved.status.version, 1);
  assert.equal(saved.history.length, 1);
  assert.equal(saved.history[0].actorId, 42);
  assert.equal(saved.history[0].before.mode, "normal");
  assert.equal(saved.history[0].after.version, 1);
});
test("storage failure never reports write success or normal status", async () => {
  const { env, store } = environment();
  store.put = async () => {
    throw Error("storage down");
  };
  assert.equal((await worker.fetch(request("/admin/status", "PUT", change()), env)).status, 503);
  const saved = await (await worker.fetch(request("/admin/status"), env)).json();
  assert.equal(saved.status.version, 0);
  env.STATUS.get = () => ({
    fetch: async () => {
      throw Error("unavailable");
    },
  });
  assert.equal((await worker.fetch(request("/status"), env)).status, 503);
  const document = await (await worker.fetch(request("/durum"), env)).text();
  assert.match(document, /Sisteme şu anda ulaşılamıyor/);
});
test("worker serves maintenance without ever calling application origin", async (t) => {
  const { env } = environment();
  env.GATEWAY_ORIGIN = "https://origin.example";
  await worker.fetch(request("/admin/status", "PUT", change()), env);
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Error("must not call origin");
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const response = await worker.fetch(request("/ara"), env);
  assert.equal(response.status, 503);
  assert.match(await response.text(), /Planlı güncelleme sürüyor/);
  assert.equal(
    (await worker.fetch(request("/ara", "POST", {}), env)).headers.get("content-type"),
    "application/json",
  );
});
test("origin failure produces standalone screen; recovery requires readiness", async (t) => {
  const { env } = environment();
  env.GATEWAY_ORIGIN = "https://origin.example";
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Error("application down");
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const response = await worker.fetch(
    new Request("https://status.example/ara", { headers: { accept: "text/html" } }),
    env,
  );
  assert.equal(response.status, 503);
  assert.match(await response.text(), /Sisteme şu anda ulaşılamıyor/);
  assert.equal((await worker.fetch(request("/_maintenance/recovery"), env)).status, 503);
  globalThis.fetch = async () => new Response("ready");
  assert.equal((await worker.fetch(request("/_maintenance/recovery"), env)).status, 204);
});
test("self-contained HTML escapes admin text in HTML and script contexts", () => {
  const html = maintenanceDocument({
    status: { ...full, message: '</script><script>alert("x")</script>' },
  });
  assert.ok(!html.includes("</script><script>alert"));
  assert.match(html, /&lt;script&gt;/);
  assert.ok(!/<(?:link|img)\b/.test(html));
});

test("same-zone Route mode requires explicit opt-in and does not mirror the application on workers.dev", async (t) => {
  const { env } = environment();
  env.APP_URL = "https://manicepte.com";
  env.GATEWAY_ORIGIN = "https://manicepte.com";
  const incoming = new Request("https://manicepte.com/ara", { headers: { accept: "text/html" } });
  assert.equal((await worker.fetch(incoming, env)).status, 503);
  const original = globalThis.fetch;
  let target;
  globalThis.fetch = async (request) => {
    target = request.url;
    return new Response("origin response");
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  env.GATEWAY_PASSTHROUGH = "true";
  const response = await worker.fetch(incoming, env);
  assert.equal(await response.text(), "origin response");
  assert.equal(target, "https://manicepte.com/ara");
  assert.equal((await worker.fetch(request("/ara"), env)).status, 404);
  assert.match(await (await worker.fetch(request("/durum"), env)).text(), /ManiCepte/);
});
test("browser waits on failed status and navigates only after confirmed recovery", async () => {
  const html = maintenanceDocument({ status: full, returnPath: "/ara", recoveryUrl: "/ready" });
  const source = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id))
      nodes.set(id, { textContent: "", replaceChildren() {}, append() {}, addEventListener() {} });
    return nodes.get(id);
  };
  const redirects = [];
  let result = null;
  let health = false;
  const context = vm.createContext({
    document: { getElementById: node, createElement: () => ({}) },
    location: { replace: (v) => redirects.push(v) },
    fetch: async (url) =>
      url === "/ready" ? { ok: health } : { ok: !!result, json: async () => result },
    AbortSignal,
    Date,
    setTimeout: () => 1,
    clearTimeout() {},
  });
  vm.runInContext(source, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(redirects, []);
  result = { ...full, blocked: true };
  await vm.runInContext("check()", context);
  assert.deepEqual(redirects, []);
  result = { ...INITIAL_STATUS, blocked: false };
  await vm.runInContext("check()", context);
  assert.deepEqual(redirects, []);
  health = true;
  await vm.runInContext("check()", context);
  assert.deepEqual(redirects, ["/ara"]);
});
test("core rejects unauthorized mutation before network and reports timeout as unknown", async (t) => {
  const before = {
    url: process.env.MAINTENANCE_SERVICE_URL,
    token: process.env.MAINTENANCE_ADMIN_TOKEN,
  };
  process.env.MAINTENANCE_SERVICE_URL = "https://status.example";
  process.env.MAINTENANCE_ADMIN_TOKEN = token;
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw Error("timeout");
  };
  t.after(() => {
    globalThis.fetch = original;
    for (const [name, value] of [
      ["MAINTENANCE_SERVICE_URL", before.url],
      ["MAINTENANCE_ADMIN_TOKEN", before.token],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  await assert.rejects(updateMaintenance({ userId: 1, role: "moderator" }, change()), /yetki yok/);
  assert.equal(calls, 0);
  assert.equal(await readSystemStatus(), null);
  assert.equal(calls, 1);
});
