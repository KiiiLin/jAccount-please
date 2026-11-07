"use strict";

(() => {
  const BASE_DOMAIN = "sjtu.edu.cn";
  const DEFAULTS = Object.freeze({ enabled: true, retentionDays: 30 });

  function inScope(domain) {
    if (typeof domain !== "string") return false;
    const host = domain.replace(/^\./, "").toLowerCase();
    return host === BASE_DOMAIN || host.endsWith(`.${BASE_DOMAIN}`);
  }

  function settings(raw = {}) {
    return {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULTS.enabled,
      retentionDays: DEFAULTS.retentionDays
    };
  }

  function eligible(cookie) {
    return inScope(cookie.domain) && cookie.session === true && cookie.value !== "";
  }

  function key(cookie) {
    const partition = cookie.partitionKey;
    return JSON.stringify([
      cookie.storeId, cookie.domain, cookie.path, cookie.name,
      partition?.topLevelSite ?? null, partition?.hasCrossSiteAncestor ?? null
    ]);
  }

  function sessionDetails(cookie) {
    if (!inScope(cookie.domain)) throw new Error("Cookie 不符合处理范围");
    const details = {
      url: `https://${cookie.domain.replace(/^\./, "")}${cookie.path || "/"}`,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      storeId: cookie.storeId
    };
    // Omitting domain is essential to preserve a host-only cookie.
    if (!cookie.hostOnly) details.domain = cookie.domain;
    if (cookie.partitionKey) details.partitionKey = { ...cookie.partitionKey };
    return details;
  }

  function persistentDetails(cookie, retentionDays, now = Date.now()) {
    if (!eligible(cookie)) throw new Error("Cookie 不符合处理条件");
    return {
      ...sessionDetails(cookie),
      expirationDate: Math.floor(now / 1000) + settings({ retentionDays }).retentionDays * 86400
    };
  }

  globalThis.SjtuCookiePolicy = Object.freeze({ BASE_DOMAIN, DEFAULTS, inScope, settings, eligible, key, persistentDetails, sessionDetails });
})();
