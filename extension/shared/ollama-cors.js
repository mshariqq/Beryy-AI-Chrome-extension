export const OLLAMA_ORIGIN_RULE_ID = 900;

const LOCAL_HOSTS = [
  ["localhost", "http://localhost"],
  ["127.0.0.1", "http://127.0.0.1"]
];

export function buildOllamaOriginRules(extensionId) {
  if (!extensionId) return [];

  return LOCAL_HOSTS.map(([host, origin], index) => ({
    id: OLLAMA_ORIGIN_RULE_ID + index,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        {
          header: "Origin",
          operation: "set",
          value: origin
        }
      ]
    },
    condition: {
      initiatorDomains: [extensionId],
      requestDomains: [host],
      resourceTypes: ["xmlhttprequest"]
    }
  }));
}

export function ollamaOriginRuleIds() {
  return LOCAL_HOSTS.map((_, index) => OLLAMA_ORIGIN_RULE_ID + index);
}
