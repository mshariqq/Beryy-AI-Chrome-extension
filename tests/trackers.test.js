import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ALLOW_RULE_ID_START,
  TRACKER_RESOURCE_TYPES,
  buildTrackerAllowRules,
  normalizeTrackerAllowlist
} from "../extension/shared/tracker-rules.js";

const rules = JSON.parse(
  readFileSync(new URL("../extension/rules/trackers.json", import.meta.url), "utf8")
);

const VALID_RESOURCE_TYPES = new Set([
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "webtransport",
  "webbundle",
  "other"
]);

test("tracker ruleset is valid and never blocks top-level navigation", () => {
  assert.ok(Array.isArray(rules));
  assert.ok(rules.length > 0);

  const ids = new Set();
  for (const rule of rules) {
    assert.ok(Number.isInteger(rule.id) && rule.id > 0);
    assert.ok(!ids.has(rule.id), `duplicate rule id ${rule.id}`);
    ids.add(rule.id);
    assert.equal(rule.priority, 1);
    assert.equal(rule.action?.type, "block");
    assert.ok(rule.condition);
    assert.ok(!(rule.condition.resourceTypes || []).includes("main_frame"));

    for (const type of rule.condition.resourceTypes || []) {
      assert.ok(VALID_RESOURCE_TYPES.has(type), `invalid resource type ${type}`);
    }

    for (const domain of rule.condition.requestDomains || []) {
      assert.match(domain, /^[a-z0-9.-]+$/);
      assert.ok(!domain.includes("://"));
    }
  }
});

test("tracker rules keep first-party app assets unblocked", () => {
  const domains = new Set(
    rules.flatMap((rule) => rule.condition.requestDomains || [])
  );

  for (const domain of ["linkedin.com", "www.linkedin.com", "licdn.com", "google.com", "facebook.com"]) {
    assert.ok(!domains.has(domain), `broad domain should not be blocked: ${domain}`);
  }
  assert.ok(!domains.has("static.licdn.com"));
  assert.ok(!domains.has("media.licdn.com"));
  assert.ok(domains.has("ads.linkedin.com"));
  assert.ok(domains.has("merchantpool1.linkedin.com"));
  assert.ok(domains.has("googletagmanager.com"));
  assert.ok(domains.has("doubleclick.net"));

  const urlFilters = rules.map((rule) => rule.condition.urlFilter).filter(Boolean);
  assert.ok(urlFilters.includes("||linkedin.com/li/track^"));
  assert.ok(
    urlFilters.includes(
      "||linkedin.com/realtime/realtimeFrontendClientConnectivityTracking"
    )
  );
});

test("tracker allowlist normalizes domains and deduplicates", () => {
  assert.deepEqual(
    normalizeTrackerAllowlist([
      "Example.COM",
      "*.example.com",
      "https://news.example.com/path",
      "foo*bar.com",
      "-leading.example",
      "bad:thing",
      "file://",
      ""
    ]),
    ["example.com", "news.example.com"]
  );

  const many = Array.from({ length: 205 }, (_, index) => `site${index}.example`);
  assert.equal(normalizeTrackerAllowlist(many).length, 200);
});

test("tracker allowlist builds higher-priority DNR allow rules", () => {
  const allowRules = buildTrackerAllowRules(["example.com", "*.example.com"]);

  assert.equal(allowRules.length, 1);
  assert.equal(allowRules[0].id, ALLOW_RULE_ID_START);
  assert.equal(allowRules[0].priority, 2);
  assert.deepEqual(allowRules[0].action, { type: "allow" });
  assert.deepEqual(allowRules[0].condition.initiatorDomains, ["example.com"]);
  assert.deepEqual(
    allowRules[0].condition.resourceTypes,
    [...TRACKER_RESOURCE_TYPES]
  );
  assert.deepEqual(buildTrackerAllowRules(""), []);
});
