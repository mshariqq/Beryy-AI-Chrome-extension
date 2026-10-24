import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = join(root, "extension");
const errors = [];
const checked = [];

function walk(directory) {
  const entries = [];
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name === ".git") continue;
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) entries.push(...walk(path));
    else entries.push(path);
  }
  return entries;
}

function fail(message) {
  errors.push(message);
}

const files = walk(root).filter((file) => {
  const rel = relative(root, file);
  return !rel.startsWith("node_modules") && !rel.startsWith(".git");
});

const jsFiles = files.filter((file) => [".js", ".mjs"].includes(extname(file)));

for (const file of jsFiles) {
  const rel = relative(root, file);
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    encoding: "utf8"
  });
  checked.push(rel);
  if (result.status !== 0) {
    fail(`${rel}: syntax error\n${result.stderr || result.stdout}`);
  }
}

const importPattern =
  /(?:^|[^\w$])(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/g;
const dynamicPattern = /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;

for (const file of jsFiles) {
  const source = readFileSync(file, "utf8");
  for (const pattern of [importPattern, dynamicPattern]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source))) {
      const specifier = match[1];
      let target = resolve(dirname(file), specifier);
      if (!extname(target)) {
        if (existsSync(`${target}.js`)) target = `${target}.js`;
        else if (existsSync(`${target}.mjs`)) target = `${target}.mjs`;
        else if (existsSync(join(target, "index.js"))) target = join(target, "index.js");
      }
      if (!existsSync(target)) {
        fail(
          `${relative(root, file)}: cannot resolve import "${specifier}" (looked for ${relative(root, target)})`
        );
      }
    }
  }
}

for (const jsonFile of ["package.json", "extension/manifest.json"]) {
  try {
    JSON.parse(readFileSync(join(root, jsonFile), "utf8"));
  } catch (error) {
    fail(`${jsonFile}: invalid JSON: ${error.message}`);
  }
}

const manifestPath = join(extensionDir, "manifest.json");
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const references = [];

  if (manifest.background?.service_worker) references.push(manifest.background.service_worker);
  if (manifest.side_panel?.default_path) references.push(manifest.side_panel.default_path);
  if (manifest.options_page) references.push(manifest.options_page);
  if (manifest.options_ui?.page) references.push(manifest.options_ui.page);
  for (const script of manifest.content_scripts || []) {
    for (const file of script.js || []) references.push(file);
    for (const file of script.css || []) references.push(file);
  }
  for (const icon of Object.values(manifest.icons || {})) references.push(icon);
  for (const actionIcon of Object.values(manifest.action?.default_icon || {})) {
    references.push(actionIcon);
  }
  const ruleResources = manifest.declarative_net_request?.rule_resources || [];
  for (const resource of ruleResources) {
    if (resource.path) references.push(resource.path);
  }

  for (const ref of references) {
    if (!existsSync(join(extensionDir, ref))) {
      fail(`manifest.json references missing file: ${ref}`);
    }
  }

  for (const resource of ruleResources) {
    if (!resource.id || !resource.path) continue;
    try {
      const rules = JSON.parse(readFileSync(join(extensionDir, resource.path), "utf8"));
      if (!Array.isArray(rules)) {
        fail(`${resource.path}: declarativeNetRequest rules must be an array`);
      }
    } catch (error) {
      fail(`${resource.path}: invalid JSON: ${error.message}`);
    }
  }

  for (const permission of ["sidePanel", "tabs", "debugger", "scripting", "tabGroups", "storage", "declarativeNetRequest"]) {
    if (!(manifest.permissions || []).includes(permission)) {
      fail(`manifest.json is missing the "${permission}" permission`);
    }
  }

  if (!(manifest.host_permissions || []).includes("<all_urls>")) {
    fail('manifest.json is missing "<all_urls>" host permission');
  }
}

for (const icon of ["icon16.png", "icon48.png", "icon128.png"]) {
  const path = join(extensionDir, "icons", icon);
  if (!existsSync(path)) fail(`missing icon: extension/icons/${icon}`);
}

if (errors.length) {
  console.error(`Checked ${checked.length} scripts. ${errors.length} problem(s):\n`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Checked ${checked.length} scripts and the manifest. No problems found.`);
