import { normalizeDomainPattern } from "./policy.js";

export const TRACKER_RULESET_ID = "trackers";
export const ALLOW_RULE_ID_START = 1000;
export const TRACKER_RESOURCE_TYPES = Object.freeze([
  "script",
  "image",
  "xmlhttprequest",
  "sub_frame",
  "ping",
  "other",
  "media"
]);

const DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeTrackerAllowlist(value) {
  const values = Array.isArray(value)
    ? value
    : String(value ?? "").split(/[\n,]/);
  const seen = new Set();
  const domains = [];

  for (const item of values) {
    const domain = normalizeDomainPattern(item);
    if (!DOMAIN_PATTERN.test(domain)) continue;
    if (seen.has(domain)) continue;
    seen.add(domain);
    domains.push(domain);
    if (domains.length >= 200) break;
  }

  return domains;
}

export function buildTrackerAllowRules(value) {
  return normalizeTrackerAllowlist(value).map((domain, index) => ({
    id: ALLOW_RULE_ID_START + index,
    priority: 2,
    action: { type: "allow" },
    condition: {
      initiatorDomains: [domain],
      resourceTypes: [...TRACKER_RESOURCE_TYPES]
    }
  }));
}
