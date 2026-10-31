#!/usr/bin/env node
/**
 * Beryy Opencode Tool (CLI)
 *
 * Command-line client for the Beryy bridge. For opencode integration, prefer
 * the MCP server (beryy-mcp.js) - see BRIDGE_README.md.
 *
 * Usage:
 *   node beryy-tool.js <tool> '{"arg": "value"}'
 *   node beryy-tool.js navigate '{"url": "https://example.com"}'
 */

import { WebSocket } from "ws";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { resolve } from "path";

const WS_URL_FILE = join(homedir(), ".beryy", "ws-url");
const TOOL_TIMEOUT = 120000;

export class BeryyTool {
  constructor() {
    this.ws = null;
    this.requestId = 0;
    this.pending = new Map();
    this.connected = false;
  }

  async connect() {
    // Read WebSocket URL from file
    let url;
    try {
      url = readFileSync(WS_URL_FILE, 'utf8').trim();
    } catch {
      throw new Error('Bridge not running. Start with: node opencode-bridge.js');
    }

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      
      this.ws.on('open', () => {
        this.connected = true;
        resolve();
      });

      this.ws.on('error', (err) => {
        reject(new Error(`WebSocket error: ${err.message}`));
      });

      this.ws.on('close', () => {
        this.connected = false;
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'response') {
            const pending = this.pending.get(msg.id);
            if (pending) {
              this.pending.delete(msg.id);
              clearTimeout(pending.timeout);
              if (msg.payload.ok) {
                pending.resolve(msg.payload.result);
              } else {
                pending.reject(new Error(msg.payload.error));
              }
            }
          } else if (msg.type === 'notification') {
            // Handle notifications if needed
          }
        } catch (e) {
          console.error('Message parse error:', e);
        }
      });
    });
  }

  async executeTool(tool, args = {}) {
    if (!this.connected) {
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Tool ${tool} timed out after ${TOOL_TIMEOUT}ms`));
      }, TOOL_TIMEOUT);

      this.pending.set(id, { resolve, reject, timeout });

      this.ws.send(JSON.stringify({
        type: 'request',
        id,
        method: 'executeTool',
        params: { tool, args }
      }));
    });
  }

  async disconnect() {
    if (this.ws) {
      this.ws.close();
      this.connected = false;
    }
  }
}

// Tool definitions matching Beryy's browser tools
export const TOOLS = {
  navigate: {
    description: 'Navigate a tab to a URL (or back/forward)',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL (https:// added if missing), or "back" / "forward"' },
        tabId: { type: 'number', description: 'Tab ID from tabs_context_mcp' }
      },
      required: ['url']
    }
  },
  tabs_context_mcp: {
    description: 'Get Beryy tab group context (tab IDs, URLs, titles). Call this first.',
    parameters: {
      type: 'object',
      properties: {
        createIfEmpty: { type: 'boolean', description: 'Create group if none exists' }
      }
    }
  },
  tabs_create_mcp: {
    description: 'Create a new tab in the Beryy tab group',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Optional URL to open' }
      }
    }
  },
  tabs_close_mcp: {
    description: 'Close one or more tabs in the Beryy tab group',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        tabIds: { type: 'array', items: { type: 'number' } }
      }
    }
  },
  computer: {
    description: 'Mouse, keyboard, scrolling, screenshots. Use refs from read_page/find for clicks.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'left_click', 'right_click', 'double_click', 'triple_click',
            'hover', 'type', 'key', 'screenshot', 'wait',
            'scroll', 'scroll_to', 'left_click_drag', 'zoom'
          ],
          description: 'The action to perform'
        },
        tabId: { type: 'number' },
        coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        ref: { type: 'string', description: 'Element ref from read_page/find (e.g. ref_12)' },
        text: { type: 'string', description: 'Text to type, or key combo (e.g. ctrl+a, Enter)' },
        duration: { type: 'number', minimum: 0, maximum: 30 },
        scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        scroll_amount: { type: 'number', minimum: 1, maximum: 10 },
        region: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
        repeat: { type: 'number', minimum: 1, maximum: 100 },
        modifiers: { type: 'string', description: 'Modifiers: ctrl, shift, alt, cmd combined with +' }
      },
      required: ['action']
    }
  },
  read_page: {
    description: 'Get accessibility tree with stable element refs',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        filter: { type: 'string', enum: ['interactive', 'all'], default: 'interactive' },
        depth: { type: 'number' },
        ref_id: { type: 'string' },
        max_chars: { type: 'number', default: 50000 }
      }
    }
  },
  get_page_text: {
    description: 'Extract main readable text of the page',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        max_chars: { type: 'number', default: 50000 }
      }
    }
  },
  find: {
    description: 'Find elements by natural-language purpose or text',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to find (e.g. "search bar", "Sign in button")' },
        tabId: { type: 'number' }
      },
      required: ['query']
    }
  },
  // Local file/shell operations (handled by bridge)
  read_file: {
    description: 'Read a local file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    }
  },
  write_file: {
    description: 'Write a local file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content']
    }
  },
  list_files: {
    description: 'List files in a directory',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', default: '.' } }
    }
  },
  run_command: {
    description: 'Run a shell command',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeout: { type: 'number', default: 30000 }
      },
      required: ['command']
    }
  }
};

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
Beryy Browser Tool for Opencode

Usage:
  node beryy-tool.js <tool> [args...]

Available tools:
${Object.entries(TOOLS).map(([name, def]) => `  ${name}: ${def.description}`).join('\n')}

Examples:
  node beryy-tool.js navigate '{"url": "https://example.com"}'
  node beryy-tool.js tabs_context_mcp '{"createIfEmpty": true}'
  node beryy-tool.js computer '{"action": "left_click", "ref": "ref_12"}'
  node beryy-tool.js computer '{"action": "type", "text": "hello"}'
  node beryy-tool.js computer '{"action": "screenshot"}'
  node beryy-tool.js read_page '{}'
  node beryy-tool.js find '{"query": "search bar"}'
  node beryy-tool.js run_command '{"command": "ls -la"}'
`);
    process.exit(0);
  }

  const toolName = args[0];
  const toolDef = TOOLS[toolName];
  
  if (!toolDef) {
    console.error(`Unknown tool: ${toolName}`);
    console.error(`Available: ${Object.keys(TOOLS).join(', ')}`);
    process.exit(1);
  }

  // Parse arguments
  let argsObj = {};
  if (args.length > 1) {
    // If single JSON arg
    if (args.length === 2) {
      try {
        argsObj = JSON.parse(args[1]);
      } catch {
        argsObj = { [toolDef.parameters.required?.[0]]: args[1] };
      }
    } else {
      // Key-value pairs
      for (let i = 1; i < args.length; i += 2) {
        if (i + 1 < args.length) {
          try {
            argsObj[args[i]] = JSON.parse(args[i + 1]);
          } catch {
            argsObj[args[i]] = args[i + 1];
          }
        }
      }
    }
  } else if (toolDef.parameters.required?.length > 0) {
    // Read from stdin if no args provided
    const stdin = await new Promise(resolve => {
      let data = '';
      process.stdin.on('data', chunk => data += chunk);
      process.stdin.on('end', () => resolve(data.trim()));
    });
    if (stdin) {
      try {
        argsObj = JSON.parse(stdin);
      } catch {
        argsObj = { [toolDef.parameters.required[0]]: stdin };
      }
    }
  }

  // Validate required params
    for (const req of toolDef.parameters.required || []) {
      if (!(req in argsObj)) {
        console.error(`Missing required parameter: ${req}`);
        process.exit(1);
      }
    }

  const tool = new BeryyTool();
  
  try {
    const result = await tool.executeTool(toolName, argsObj);
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }, null, 2));
    process.exit(1);
  } finally {
    await tool.disconnect();
  }
}

// Run only when executed directly (not when imported for TOOLS).
const invokedAs = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedAs && fileURLToPath(import.meta.url) === invokedAs) {
  main().catch(err => {
    console.error(JSON.stringify({ error: err.message }, null, 2));
    process.exit(1);
  });
}