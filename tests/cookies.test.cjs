"use strict";
// All Cookie values below are synthetic fixtures, never real login credentials.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { webcrypto } = require("node:crypto");
const root = path.resolve(__dirname, "../extension");
const source = name => fs.readFileSync(path.join(root, name), "utf8");

function event() {
  const listeners = [];
  return { addListener(fn) { listeners.push(fn); }, emit(...args) { for (const fn of listeners) fn(...args); } };
}

function fixture(overrides = {}) {
  return {
    domain: "mail.sjtu.edu.cn", name: "ZM_AUTH_TOKEN", value: "synthetic-token",
    path: "/", hostOnly: true, secure: true, httpOnly: true,
    sameSite: "lax", session: true, storeId: "0", ...overrides
  };
}

function harness(initial = [], settings = {}) {
  const data = { ...settings };
  let cookies = structuredClone(initial);
  const writes = [];
  const onChanged = event();
  const storageChanged = event();
  let context;
  let nextReadBarrier;
  const chrome = {
    cookies: {
      onChanged,
      async getAll(query) {
        const snapshot = cookies.filter(cookie => {
          const domain = cookie.domain.replace(/^\./, "");
          if (query.domain && domain !== query.domain && !domain.endsWith(`.${query.domain}`)) return false;
          if (query.name !== undefined && cookie.name !== query.name) return false;
          if (query.storeId !== undefined && cookie.storeId !== query.storeId) return false;
          if (query.partitionKey?.topLevelSite && cookie.partitionKey?.topLevelSite !== query.partitionKey.topLevelSite) return false;
          if (!query.partitionKey && cookie.partitionKey) return false;
          return true;
        });
        if (nextReadBarrier) {
          const barrier = nextReadBarrier;
          nextReadBarrier = undefined;
          await barrier;
        }
        return structuredClone(snapshot);
      },
      async set(details) {
        writes.push(structuredClone(details));
        const saved = fixture({
          ...details, domain: details.domain || new URL(details.url).hostname,
          hostOnly: !details.domain, session: details.expirationDate === undefined
        });
        delete saved.url;
        const id = context.SjtuCookiePolicy.key(saved);
        const old = cookies.find(cookie => context.SjtuCookiePolicy.key(cookie) === id);
        if (old) {
          cookies = cookies.filter(cookie => context.SjtuCookiePolicy.key(cookie) !== id);
          onChanged.emit({ removed: true, cause: "overwrite", cookie: structuredClone(old) });
        }
        cookies.push(saved);
        onChanged.emit({ removed: false, cause: "explicit", cookie: structuredClone(saved) });
        return structuredClone(saved);
      }
    },
    storage: {
      onChanged: storageChanged,
      local: {
        async get(defaults) { return { ...defaults, ...data }; },
        async set(values) {
          const changes = {};
          for (const [key, value] of Object.entries(values)) {
            if (JSON.stringify(data[key]) !== JSON.stringify(value)) changes[key] = { oldValue: data[key], newValue: value };
            data[key] = value;
          }
          storageChanged.emit(changes, "local");
        },
        async remove(keys) {
          const changes = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            if (Object.hasOwn(data, key)) changes[key] = { oldValue: data[key] };
            delete data[key];
          }
          storageChanged.emit(changes, "local");
        }
      }
    },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    runtime: { id: "test-extension", onInstalled: event(), onStartup: event(), onMessage: event() }
  };
  context = vm.createContext({ chrome, console, URL, crypto: webcrypto, TextEncoder });
  context.importScripts = name => vm.runInContext(source(name), context);
  vm.runInContext(source("background.js"), context);
  return {
    context, chrome, data, writes,
    get cookies() { return cookies; },
    blockNextRead(promise) { nextReadBarrier = promise; },
    add(cookie) {
      const id = context.SjtuCookiePolicy.key(cookie);
      cookies = cookies.filter(item => context.SjtuCookiePolicy.key(item) !== id);
      cookies.push(structuredClone(cookie));
      onChanged.emit({ removed: false, cause: "explicit", cookie: structuredClone(cookie) });
    },
    remove(cookie) {
      const id = context.SjtuCookiePolicy.key(cookie);
      cookies = cookies.filter(item => context.SjtuCookiePolicy.key(item) !== id);
      onChanged.emit({ removed: true, cause: "explicit", cookie: structuredClone(cookie) });
    },
    async settle() {
      for (let i = 0; i < 3; i++) {
        await new Promise(resolve => setImmediate(resolve));
        await vm.runInContext("Promise.all([...queues.values()])", context);
      }
    }
  };
}

test("domain boundary includes root/shared/nested subdomains and excludes lookalikes", () => {
  const p = harness().context.SjtuCookiePolicy;
  for (const host of ["sjtu.edu.cn", ".sjtu.edu.cn", "a.sjtu.edu.cn", "a.b.sjtu.edu.cn"]) assert.equal(p.inScope(host), true);
  for (const host of ["evil-sjtu.edu.cn", "sjtu.edu.cn.evil.example", "example.com", ""]) assert.equal(p.inScope(host), false);
});

test("persistent rewrite preserves host-only, token and security/partition attributes", () => {
  const p = harness().context.SjtuCookiePolicy;
  const c = fixture({ partitionKey: { topLevelSite: "https://sjtu.edu.cn", hasCrossSiteAncestor: true } });
  const d = p.persistentDetails(c, 7, 1700000000000);
  assert.equal(d.expirationDate, 1700000000 + 30 * 86400);
  assert.equal(d.value, c.value);
  for (const field of ["path", "httpOnly", "secure", "sameSite", "storeId"]) assert.equal(d[field], c[field]);
  assert.equal("domain" in d, false);
  assert.equal(d.partitionKey.topLevelSite, c.partitionKey.topLevelSite);
  assert.equal(d.partitionKey.hasCrossSiteAncestor, true);
  assert.equal(c.session, true);
  const shared = p.persistentDetails(fixture({ hostOnly: false, domain: ".sjtu.edu.cn" }), 1, 0);
  assert.equal(shared.domain, ".sjtu.edu.cn");
  assert.equal(shared.expirationDate, 30 * 86400);
});

test("sweep covers arbitrary schools sites and leaves pre-existing persistent cookies alone", async () => {
  const h = harness([
    fixture(), fixture({ domain: "jaccount.sjtu.edu.cn", name: "JAAuthCookie" }),
    fixture({ domain: "arbitrary.deep.sjtu.edu.cn", name: "custom_auth" }),
    fixture({ domain: ".sjtu.edu.cn", hostOnly: false, name: "shared_session" }),
    fixture({ domain: "sjtu.edu.cn", name: "root_session" }),
    fixture({ name: "persistent", session: false, expirationDate: 1900000000 }),
    fixture({ domain: "not-sjtu.edu.cn", name: "foreign" }),
    fixture({ name: "empty_deletion_marker", value: "" })
  ]);
  const result = await h.context.persistAll();
  await h.settle();
  assert.equal(result.converted, 5);
  assert.equal(h.writes.length, 5);
  assert.equal(h.cookies.find(c => c.name === "persistent").expirationDate, 1900000000);
  assert.ok(h.cookies.find(c => c.name === "foreign").session);
  assert.equal(JSON.stringify(h.data).includes("synthetic-token"), false);
});

test("new cookies auto-convert once without a write loop; disabled mode is respected", async () => {
  const h = harness();
  h.add(fixture());
  await h.settle();
  assert.equal(h.writes.length, 1);
  assert.equal(h.cookies[0].session, false);
  await h.chrome.storage.local.set({ enabled: false });
  h.add(fixture({ domain: "new.sjtu.edu.cn" }));
  await h.settle();
  await h.context.persistAll();
  assert.equal(h.writes.length, 1);
});

test("logout removes cookies permanently; deletion event does not recreate them", async () => {
  const h = harness();
  h.add(fixture());
  await h.settle();
  h.remove(h.cookies[0]);
  await h.settle();
  assert.equal(h.cookies.length, 0);
  assert.equal(h.writes.length, 1);
});

test("logout invalidates a stale in-flight read before conversion", async () => {
  const h = harness();
  let release;
  h.blockNextRead(new Promise(resolve => { release = resolve; }));
  const c = fixture();
  h.add(c);
  await new Promise(resolve => setImmediate(resolve));
  h.remove(c);
  release();
  await h.settle();
  assert.equal(h.writes.length, 0);
  assert.equal(h.cookies.length, 0);
});

test("rotation uses the newest value, and shared-domain flags survive", async () => {
  const h = harness();
  const c = fixture({ domain: ".sjtu.edu.cn", hostOnly: false });
  h.add(c);
  h.add({ ...c, value: "synthetic-rotated-token" });
  await h.settle();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].value, "synthetic-rotated-token");
  assert.equal(h.writes[0].domain, ".sjtu.edu.cn");
});

test("startup/installation hooks sweep current cookies and settings validate days", async () => {
  const h = harness([fixture()], { retentionDays: 30 });
  h.chrome.runtime.onInstalled.emit();
  await h.settle();
  assert.equal(h.writes.length, 1);
  assert.ok(h.writes[0].expirationDate > Date.now() / 1000 + 29 * 86400);
  const p = h.context.SjtuCookiePolicy;
  assert.equal(p.settings({ retentionDays: -1 }).retentionDays, 30);
  assert.equal(p.settings({ retentionDays: 100 }).retentionDays, 30);
  assert.equal(p.settings({ retentionDays: 7 }).retentionDays, 30);
});

test("manifest grants school-only host access and no content/network permissions", () => {
  const manifest = JSON.parse(source("manifest.json"));
  assert.deepEqual(manifest.permissions, ["cookies", "storage"]);
  assert.deepEqual(manifest.host_permissions, ["*://*.sjtu.edu.cn/*"]);
  assert.equal(manifest.incognito, "not_allowed");
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  for (const file of ["background.js", "policy.js", "popup.js"]) {
    assert.doesNotMatch(source(file), /\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/);
  }
});

test("disabling restores recorded cookies once and clears completed records", async () => {
  const native = fixture({ name: "native_persistent", session: false, expirationDate: 1900000000 });
  const h = harness([fixture(), native]);
  await h.context.persistAll();
  await h.settle();
  assert.equal(Object.keys(h.data).filter(key => key.startsWith("modifiedCookie:")).length, 1);
  const result = await h.context.configureFeatures({ enabled: false });
  await h.settle();
  assert.equal(result.restored, 1);
  const restored = h.cookies.find(c => c.name === "ZM_AUTH_TOKEN");
  assert.equal(restored.session, true);
  assert.equal(restored.expirationDate, undefined);
  assert.equal(restored.value, "synthetic-token");
  assert.equal(restored.httpOnly, true);
  assert.equal(restored.secure, true);
  assert.equal(restored.hostOnly, true);
  assert.equal(h.cookies.find(c => c.name === native.name).expirationDate, native.expirationDate);
  assert.equal(Object.keys(h.data).filter(key => key.startsWith("modifiedCookie:")).length, 0);
  assert.equal(h.writes.length, 2);
  h.add(fixture({ domain: "another.sjtu.edu.cn" }));
  await h.settle();
  const repeated = await h.context.configureFeatures({ enabled: false });
  assert.equal(repeated.restored, 0);
  assert.equal(h.writes.length, 2);
});

test("restore records survive background restart without saving credential values", async () => {
  const first = harness([fixture({ domain: ".sjtu.edu.cn", hostOnly: false })]);
  await first.context.persistAll();
  await first.settle();
  assert.equal(JSON.stringify(first.data).includes("synthetic-token"), false);
  const restarted = harness(first.cookies, structuredClone(first.data));
  const result = await restarted.context.configureFeatures({ enabled: false });
  await restarted.settle();
  assert.equal(result.restored, 1);
  assert.equal(restarted.cookies[0].session, true);
  assert.equal(restarted.writes[0].domain, ".sjtu.edu.cn");
});

test("restore does not resurrect deleted cookies or modify replacement credentials", async () => {
  const h = harness([fixture(), fixture({ name: "deleted_cookie" })]);
  await h.context.persistAll();
  await h.settle();
  h.remove(h.cookies.find(c => c.name === "deleted_cookie"));
  h.add({ ...h.cookies.find(c => c.name === "ZM_AUTH_TOKEN"), value: "synthetic-replacement" });
  await h.settle();
  const before = h.writes.length;
  const result = await h.context.configureFeatures({ enabled: false });
  await h.settle();
  assert.equal(result.restored, 0);
  assert.equal(h.writes.length, before);
  assert.equal(h.cookies.length, 1);
  assert.equal(h.cookies[0].value, "synthetic-replacement");
  assert.equal(h.cookies[0].session, false);
  assert.equal(Object.keys(h.data).filter(key => key.startsWith("modifiedCookie:")).length, 0);
});

test("turning off during a queued conversion cancels the write", async () => {
  const h = harness();
  let release;
  h.blockNextRead(new Promise(resolve => { release = resolve; }));
  h.add(fixture());
  await new Promise(resolve => setImmediate(resolve));
  const disabling = h.context.configureFeatures({ enabled: false });
  await new Promise(resolve => setImmediate(resolve));
  release();
  await disabling;
  await h.settle();
  assert.equal(h.writes.length, 0);
  assert.equal(h.cookies[0].session, true);
  assert.equal(Object.keys(h.data).filter(key => key.startsWith("modifiedCookie:")).length, 0);
});

test("each enable-disable cycle tracks and restores its own conversions", async () => {
  const h = harness([fixture()]);
  await h.context.persistAll();
  for (let i = 0; i < 2; i++) {
    const result = await h.context.configureFeatures({ enabled: false });
    await h.settle();
    assert.equal(result.restored, 1);
    assert.equal(h.cookies[0].session, true);
    if (i === 0) {
      await h.context.configureFeatures({ enabled: true });
      await h.settle();
      assert.equal(h.cookies[0].session, false);
    }
  }
});
