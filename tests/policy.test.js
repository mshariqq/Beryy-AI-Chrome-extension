import test from "node:test";
import assert from "node:assert/strict";
import {
  PERMISSIONS,
  describeAction,
  domainFromUrl,
  domainMatches,
  evaluatePolicy,
  findMatchingDomain,
  grantKey,
  hasGrant,
  normalizeDomainPattern,
  permissionTypeForTool
} from "../extension/shared/policy.js";

test("domain matching is suffix-safe", () => {
  assert.equal(domainMatches("example.com", "example.com"), true);
  assert.equal(domainMatches("www.example.com", "example.com"), true);
  assert.equal(domainMatches("badexample.com", "example.com"), false);
  assert.equal(domainMatches("example.com.evil.com", "example.com"), false);
  assert.equal(domainMatches("EXAMPLE.com", "Example.com"), true);
  assert.equal(domainMatches("", "example.com"), false);
  assert.equal(domainMatches("example.com", ""), false);
});

test("normalizes domain patterns from URLs and wildcards", () => {
  assert.equal(normalizeDomainPattern("*.example.com"), "example.com");
  assert.equal(normalizeDomainPattern(".example.com"), "example.com");
  assert.equal(normalizeDomainPattern("https://Example.com:8443/path"), "example.com");
  assert.equal(normalizeDomainPattern("example.com/foo"), "example.com");
  assert.equal(normalizeDomainPattern("  "), "");
});

test("extracts hosts from URLs", () => {
  assert.equal(domainFromUrl("https://www.example.com/a"), "www.example.com");
  assert.equal(domainFromUrl("chrome://settings"), "settings");
  assert.equal(domainFromUrl("not a url"), "");
  assert.equal(domainFromUrl(""), "");
});

test("maps tools and computer actions to permissions", () => {
  assert.equal(permissionTypeForTool("tabs_context_mcp"), PERMISSIONS.READ);
  assert.equal(permissionTypeForTool("read_page"), PERMISSIONS.READ);
  assert.equal(permissionTypeForTool("navigate"), PERMISSIONS.NAVIGATE);
  assert.equal(permissionTypeForTool("form_input"), PERMISSIONS.TYPE);
  assert.equal(permissionTypeForTool("javascript_tool"), PERMISSIONS.JAVASCRIPT);
  assert.equal(permissionTypeForTool("upload_image"), PERMISSIONS.UPLOAD);
  assert.equal(permissionTypeForTool("tabs_close_mcp"), PERMISSIONS.CONTROL);

  assert.equal(
    permissionTypeForTool("computer", { action: "screenshot" }),
    PERMISSIONS.READ
  );
  assert.equal(
    permissionTypeForTool("computer", { action: "left_click" }),
    PERMISSIONS.CLICK
  );
  assert.equal(
    permissionTypeForTool("computer", { action: "type" }),
    PERMISSIONS.TYPE
  );
  assert.equal(
    permissionTypeForTool("computer", { action: "unknown" }),
    PERMISSIONS.CONTROL
  );
});

test("ask mode prompts for page actions but not group creation", () => {
  const base = {
    mode: "ask",
    host: "example.com",
    blockedDomains: [],
    trustedDomains: [],
    grants: []
  };

  const read = evaluatePolicy({ ...base, tool: "read_page" });
  assert.equal(read.needsPrompt, true);
  assert.equal(read.allowed, false);

  const create = evaluatePolicy({ ...base, tool: "tabs_create_mcp" });
  assert.equal(create.allowed, true);
  assert.equal(create.needsPrompt, false);
});

test("blocked domains win in every mode", () => {
  const decision = evaluatePolicy({
    mode: "auto",
    host: "bank.example.com",
    tool: "read_page",
    blockedDomains: ["example.com"]
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /blocked/i);
});

test("read_only allows reads and blocks mutations", () => {
  const base = {
    mode: "read_only",
    host: "example.com",
    blockedDomains: [],
    trustedDomains: [],
    grants: []
  };

  assert.equal(evaluatePolicy({ ...base, tool: "read_page" }).allowed, true);
  assert.equal(evaluatePolicy({ ...base, tool: "get_page_text" }).allowed, true);

  const click = evaluatePolicy({
    ...base,
    tool: "computer",
    args: { action: "left_click" }
  });
  assert.equal(click.allowed, false);
  assert.equal(click.needsPrompt, false);
  assert.match(click.reason, /read-only/i);
});

test("auto, trusted domains, and session grants allow actions", () => {
  const base = {
    host: "docs.example.com",
    blockedDomains: [],
    trustedDomains: [],
    grants: []
  };

  assert.equal(
    evaluatePolicy({ ...base, mode: "auto", tool: "javascript_tool" }).allowed,
    true
  );

  assert.equal(
    evaluatePolicy({
      ...base,
      mode: "ask",
      tool: "form_input",
      trustedDomains: ["example.com"]
    }).allowed,
    true
  );

  const grant = grantKey("docs.example.com", "*");
  assert.equal(hasGrant("docs.example.com", PERMISSIONS.TYPE, [grant]), true);
  assert.equal(
    evaluatePolicy({
      ...base,
      mode: "ask",
      tool: "form_input",
      grants: [grant]
    }).allowed,
    true
  );
});

test("findMatchingDomain returns the matching pattern", () => {
  assert.equal(
    findMatchingDomain("api.example.com", ["other.com", "*.example.com"]),
    "*.example.com"
  );
  assert.equal(findMatchingDomain("api.example.com", ["other.com"]), null);
});

test("describeAction is human readable", () => {
  assert.equal(describeAction("navigate", { url: "https://example.com" }), "navigate to https://example.com");
  assert.equal(describeAction("computer", { action: "left_click", ref: "ref_2" }), "left_click on ref_2");
  assert.equal(describeAction("computer", { action: "hover", coordinate: [10, 20] }), "hover at (10, 20)");
  assert.equal(describeAction("read_page"), "read_page");
});
