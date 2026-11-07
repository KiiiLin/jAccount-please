"use strict";
importScripts("policy.js");

const policy = globalThis.SjtuCookiePolicy;
const revisions = new Map();
const queues = new Map();
const RECORD_PREFIX = "modifiedCookie:";
let conversionEpoch = 0;
let configurationQueue = Promise.resolve();

const recordKey = cookie => RECORD_PREFIX + policy.key(cookie);

async function fingerprint(cookie) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cookie.value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function findCurrent(locator) {
  const query = {
    domain: locator.domain.replace(/^\./, ""),
    name: locator.name,
    storeId: locator.storeId
  };
  if (locator.partitionKey) query.partitionKey = locator.partitionKey;
  return (await chrome.cookies.getAll(query)).find(cookie => policy.key(cookie) === policy.key(locator));
}

async function readSettings() {
  return policy.settings(await chrome.storage.local.get(policy.DEFAULTS));
}

async function badge() {
  const { enabled } = await readSettings();
  await chrome.action.setBadgeText({ text: enabled ? "ON" : "OFF" });
  await chrome.action.setBadgeBackgroundColor({ color: enabled ? "#16a66e" : "#89929e" });
}

async function allSchoolCookies() {
  // An empty partition filter includes all partition keys, as well as ordinary cookies.
  const cookies = await chrome.cookies.getAll({ domain: policy.BASE_DOMAIN, partitionKey: {} });
  return cookies.filter(cookie => policy.inScope(cookie.domain));
}

async function persist(snapshot, revision) {
  const id = policy.key(snapshot);
  const epoch = conversionEpoch;
  const config = await readSettings();
  if (!config.enabled || revisions.get(id) !== revision) return "skipped";

  // Re-read before writing: a queued notification may refer to an old or deleted value.
  const current = await findCurrent(snapshot);
  if (revisions.get(id) !== revision || !current || !policy.eligible(current) || current.value !== snapshot.value) {
    return "skipped";
  }
  const details = policy.persistentDetails(current, config.retentionDays);
  // Persist each record separately so independent Cookie writes cannot lose each other's records.
  // Only a locator, expiry and one-way fingerprint are saved; never the credential value.
  const record = {
    domain: current.domain, name: current.name, path: current.path, storeId: current.storeId,
    expirationDate: details.expirationDate, fingerprint: await fingerprint(current)
  };
  if (current.partitionKey) record.partitionKey = { ...current.partitionKey };
  await chrome.storage.local.set({ [recordKey(current)]: record });
  const latestConfig = await readSettings();
  if (!latestConfig.enabled || epoch !== conversionEpoch || revisions.get(id) !== revision) {
    await chrome.storage.local.remove(recordKey(current));
    return "skipped";
  }
  const saved = await chrome.cookies.set(details);
  return saved ? "converted" : "failed";
}

function enqueue(cookie) {
  const id = policy.key(cookie);
  if (!revisions.has(id)) revisions.set(id, 0);
  const revision = revisions.get(id);
  const previous = queues.get(id) || Promise.resolve();
  const job = previous.catch(() => {}).then(() => persist(cookie, revision)).catch(() => "failed");
  queues.set(id, job);
  void job.then(() => { if (queues.get(id) === job) queues.delete(id); });
  return job;
}

async function persistAll() {
  const config = await readSettings();
  if (!config.enabled) return { converted: 0, failed: 0, skipped: 0 };
  const candidates = (await allSchoolCookies()).filter(policy.eligible);
  const results = await Promise.all(candidates.map(enqueue));
  const summary = {
    converted: results.filter(result => result === "converted").length,
    failed: results.filter(result => result === "failed").length,
    skipped: results.filter(result => result === "skipped").length
  };
  // The summary only contains counts, never Cookie values.
  await chrome.storage.local.set({ lastRun: { ...summary, at: Date.now() } });
  return summary;
}

async function restoreRecordedOnce() {
  const stored = await chrome.storage.local.get(null);
  const records = Object.entries(stored).filter(([key, record]) =>
    key.startsWith(RECORD_PREFIX) && record && policy.inScope(record.domain));
  const results = await Promise.all(records.map(async ([key, record]) => {
    try {
      const id = policy.key(record);
      const revision = revisions.get(id);
      const current = await findCurrent(record);
      if (!current || current.session || current.expirationDate !== record.expirationDate
        || await fingerprint(current) !== record.fingerprint || revisions.get(id) !== revision) {
        await chrome.storage.local.remove(key);
        return "skipped";
      }
      // Omitting expirationDate changes only the lifetime back to a session Cookie.
      const saved = await chrome.cookies.set(policy.sessionDetails(current));
      if (!saved) return "failed";
      await chrome.storage.local.remove(key);
      return "restored";
    } catch { return "failed"; }
  }));
  return {
    restored: results.filter(result => result === "restored").length,
    failed: results.filter(result => result === "failed").length,
    skipped: results.filter(result => result === "skipped").length
  };
}

function configureFeatures(rawConfig) {
  const next = policy.settings(rawConfig);
  const job = configurationQueue.catch(() => {}).then(async () => {
    const previous = await readSettings();
    conversionEpoch++;
    await chrome.storage.local.set(next);
    await badge();
    if (next.enabled) return await persistAll();
    // Finish any already-started writes before doing exactly one restoration pass.
    await Promise.all([...queues.values()]);
    return previous.enabled ? await restoreRecordedOnce() : { restored: 0, failed: 0, skipped: 0 };
  });
  configurationQueue = job;
  return job;
}

function quietRun(task) {
  void task.catch(() => {
    // Do not print API errors that could include authentication details.
    void chrome.storage.local.set({ lastError: "处理失败，请检查扩展的网站访问权限。" }).catch(() => {});
  });
}

chrome.cookies.onChanged.addListener(change => {
  const cookie = change.cookie;
  if (!policy.inScope(cookie.domain)) return;
  const id = policy.key(cookie);
  revisions.set(id, (revisions.get(id) || 0) + 1);
  if (change.removed && change.cause !== "overwrite") {
    quietRun(chrome.storage.local.remove(recordKey(cookie)));
  }
  // A removal, including logout or expiration, must never recreate a Cookie.
  // Our own writes are persistent cookies, so they do not trigger another conversion.
  if (!change.removed && policy.eligible(cookie)) {
    quietRun(enqueue(cookie).then(result => {
      if (result === "failed") throw new Error("Cookie write failed");
    }));
  }
});

chrome.runtime.onInstalled.addListener(() => quietRun((async () => {
  await chrome.storage.local.set(await readSettings());
  await badge();
  await persistAll();
})()));

chrome.runtime.onStartup.addListener(() => quietRun((async () => {
  await badge();
  await persistAll();
})()));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.enabled || changes.retentionDays)) quietRun(badge());
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const task = (async () => {
    if (message?.type === "status") {
      return { config: await readSettings() };
    }
    if (message?.type === "configure") {
      return await configureFeatures(message.config);
    }
    if (message?.type === "apply") return await persistAll();
    throw new Error("Unknown request");
  })();
  void task.then(result => sendResponse({ ok: true, result }), () => {
    sendResponse({ ok: false, error: "处理失败，请检查扩展的网站访问权限。" });
  });
  return true;
});
