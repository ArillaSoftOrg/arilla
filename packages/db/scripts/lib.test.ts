import assert from "node:assert/strict";
import { test } from "node:test";
import { isLocal, REMOTE_CONFIRM_ENV, remoteWriteDecision } from "./lib.ts";

const REMOTE = "postgresql://owner:parola@db.example-host.test:5432/postgres";

test("isLocal: loopback adresleri yereldir, uzak adresler degildir", () => {
  for (const url of [
    "postgresql://arilla:x@localhost:5432/arilla",
    "postgresql://arilla:x@127.0.0.1:5432/arilla",
    "postgresql://arilla:x@[::1]:5432/arilla",
  ]) {
    assert.equal(isLocal(url), true, url);
  }
  assert.equal(isLocal(REMOTE), false);
  assert.equal(isLocal("localhost.attacker.test"), false);
  assert.equal(isLocal("postgresql://x@localhost.attacker.test:5432/db"), false);
  assert.equal(isLocal("coz-umlenemez"), false);
});

test("yerel hedefe onay istenmez", () => {
  assert.equal(remoteWriteDecision("postgresql://a:b@localhost:5432/arilla", {}), "local");
});

test("uzak hedef onaysiz durdurulur", () => {
  assert.equal(remoteWriteDecision(REMOTE, {}), "blocked");
  assert.equal(remoteWriteDecision(REMOTE, { [REMOTE_CONFIRM_ENV]: "" }), "blocked");
});

test("onay hedefin makine adi ile birebir eslesmelidir", () => {
  assert.equal(
    remoteWriteDecision(REMOTE, { [REMOTE_CONFIRM_ENV]: "db.example-host.test" }),
    "confirmed",
  );
  assert.equal(
    remoteWriteDecision(REMOTE, { [REMOTE_CONFIRM_ENV]: "  DB.Example-Host.test " }),
    "confirmed",
  );
  // Baska bir hedef icin verilmis onay bu hedefi acmaz; "1"/"true" gibi genel degerler de.
  assert.equal(
    remoteWriteDecision(REMOTE, { [REMOTE_CONFIRM_ENV]: "baska.example.test" }),
    "blocked",
  );
  assert.equal(remoteWriteDecision(REMOTE, { [REMOTE_CONFIRM_ENV]: "1" }), "blocked");
  assert.equal(remoteWriteDecision(REMOTE, { [REMOTE_CONFIRM_ENV]: "true" }), "blocked");
});

test("cozumlenemeyen adres onaysiz da onayli da durdurulur", () => {
  assert.equal(remoteWriteDecision("not a url", {}), "blocked");
  assert.equal(remoteWriteDecision("not a url", { [REMOTE_CONFIRM_ENV]: "not a url" }), "blocked");
});
