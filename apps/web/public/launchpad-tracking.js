/* LaunchPad website tracking v1. Loading this file sends nothing and stores nothing. */
(function (global) {
  "use strict";
  var eventTypes = ["page.viewed", "product.viewed", "checkout.observed"];
  var defaultKeys = ["path", "referrer", "utm_source", "utm_medium", "utm_campaign", "utm_content", "campaign", "consent"];
  function invalid(message) { throw new Error(message); }
  function plain(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Supply an object.");
    return value;
  }
  function uuid() {
    if (!global.crypto || !global.crypto.getRandomValues) invalid("Tracking requires a secure browser context.");
    if (global.crypto.randomUUID) return global.crypto.randomUUID();
    var bytes = global.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    var hex = Array.from(bytes, function (byte) { return byte.toString(16).padStart(2, "0"); }).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  }
  function create(options) {
    plain(options);
    if (typeof options.sourceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(options.sourceId)) invalid("Supply a tracking source ID.");
    var endpoint = new URL(options.endpoint);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/" ||
      (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1"].includes(endpoint.hostname))))
      invalid("Use the HTTPS LaunchPad origin, without a path or query string.");
    var keys = options.propertyKeys === undefined ? defaultKeys.slice() : options.propertyKeys;
    if (!Array.isArray(keys) || keys.length > 30 || keys.some(function (key) {
      return typeof key !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) ||
        /password|secret|token|authorization|owner|contact|paid|revenue|amount|currency/i.test(key);
    })) invalid("Use up to 30 configured observation property names.");
    keys = keys.slice();
    var base = endpoint.origin + "/api/tracking/ingest/" + encodeURIComponent(options.sourceId);
    var storageKey = "launchpad-visit-v1:" + endpoint.origin + ":" + options.sourceId;
    var consent = options.consent === true, generation = 0, visitor = null, pending = null;
    var controller = new AbortController();
    function clearStorage() { try { global.sessionStorage.removeItem(storageKey); } catch (_) { /* Storage is optional. */ } }
    function restore() {
      if (!consent) return;
      try {
        var value = JSON.parse(global.sessionStorage.getItem(storageKey) || "null");
        if (value && typeof value.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(value.token) &&
          typeof value.expiresAt === "number" && value.expiresAt > Date.now() && value.expiresAt <= Date.now() + 86400000) visitor = value;
        else clearStorage();
      } catch (_) { /* Storage is optional. */ }
    }
    restore();
    function props(value) {
      var input = value === undefined ? {} : plain(value), result = {};
      if (Object.keys(input).length > 30) invalid("Too many tracking properties.");
      Object.keys(input).forEach(function (key) {
        var value = input[key];
        if (!keys.includes(key)) invalid("Use only configured tracking properties.");
        if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") invalid("Tracking properties must be scalar values.");
        if ((typeof value === "string" && value.length > 1000) || (typeof value === "number" && !Number.isFinite(value))) invalid("Tracking property is invalid or too long.");
        // A caller may explicitly provide a path or referrer, but query strings and fragments are never transmitted.
        if ((key === "path" || key === "referrer") && typeof value === "string") {
          var url = new URL(value, global.location.origin);
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) invalid("Use a website path or referrer.");
          value = key === "path" ? url.pathname : url.origin + url.pathname;
        }
        result[key] = value;
      });
      return result;
    }
    async function post(path, value, expectedGeneration) {
      if (!consent || generation !== expectedGeneration) invalid("Tracking consent is required.");
      var raw = JSON.stringify(value);
      if (new TextEncoder().encode(raw).byteLength > 32768) invalid("Tracking request is too large.");
      var response = await global.fetch(base + path, {
        method: "POST", mode: "cors", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" }, body: raw, signal: controller.signal,
      });
      if (!consent || generation !== expectedGeneration) invalid("Tracking consent was withdrawn.");
      var body = await response.json();
      if (!response.ok) {
        var error = new Error("Tracking request could not be accepted.");
        error.code = body && typeof body.code === "string" && /^[A-Z_]{1,80}$/.test(body.code) ? body.code : "TRACKING_FAILED";
        throw error;
      }
      return body;
    }
    async function visit(expectedGeneration) {
      if (visitor && visitor.expiresAt > Date.now()) return visitor.token;
      if (pending) return pending;
      var request = post("/visitor", {}, expectedGeneration).then(function (body) {
        if (!consent || generation !== expectedGeneration) invalid("Tracking consent was withdrawn.");
        if (!body || typeof body.visitorToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.visitorToken) ||
          typeof body.expiresInSeconds !== "number" || body.expiresInSeconds <= 0 || body.expiresInSeconds > 86400) invalid("Invalid visitor acknowledgement.");
        visitor = { token: body.visitorToken, expiresAt: Date.now() + body.expiresInSeconds * 1000 };
        try { global.sessionStorage.setItem(storageKey, JSON.stringify(visitor)); } catch (_) { /* Use memory if storage is blocked. */ }
        return visitor.token;
      }).finally(function () { if (pending === request) pending = null; });
      pending = request;
      return request;
    }
    async function send(path, value) {
      if (!consent) return { accepted: false, reason: "CONSENT_REQUIRED" };
      var current = generation;
      value.visitorToken = await visit(current);
      return post(path, value, current);
    }
    return Object.freeze({
      setConsent: function (allowed) {
        if (typeof allowed !== "boolean") invalid("Set consent explicitly to true or false.");
        if (consent === allowed) { if (!allowed) clearStorage(); return; }
        consent = allowed; generation += 1; controller.abort(); controller = new AbortController(); pending = null; visitor = null;
        if (allowed) restore(); else clearStorage();
      },
      track: async function (type, properties) {
        if (!consent) return { accepted: false, reason: "CONSENT_REQUIRED" };
        if (!eventTypes.includes(type)) invalid("Choose a supported browser observation event.");
        return send("/collect", { schemaVersion: 1, eventId: uuid(), type: type, properties: props(properties) });
      },
      submit: async function (input) {
        if (!consent) return { accepted: false, reason: "CONSENT_REQUIRED" };
        plain(input);
        if (Object.keys(input).some(function (key) { return !["eventId", "email", "name", "properties"].includes(key); })) invalid("Use the supported form fields.");
        var eventId = input.eventId === undefined ? uuid() : input.eventId;
        if (typeof eventId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(eventId)) invalid("Supply a stable form event ID.");
        if (typeof input.email !== "string" || input.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) invalid("Supply a valid form email.");
        if (input.name !== undefined && (typeof input.name !== "string" || input.name.length > 200 || /[\u0000-\u001f]/.test(input.name))) invalid("Supply a bounded form name.");
        return send("/form", { schemaVersion: 1, eventId: eventId, email: input.email,
          ...(input.name === undefined ? {} : { name: input.name }), properties: props(input.properties) });
      },
    });
  }
  global.LaunchPadTracking = Object.freeze({ create: create });
})(window);
