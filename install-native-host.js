#!/usr/bin/env node
/**
 * Install native messaging host for Beryy WebSocket bridge
 * Run with: node install-native-host.js <extension-id>
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { platform } from 'os';

const EXTENSION_ID = process.argv[2];
if (!EXTENSION_ID) {
  console.error('Usage: node install-native-host.js <extension-id>');
  console.error('Get your extension ID from chrome://extensions (Developer mode)');
  process.exit(1);
}

const HOST_NAME = 'com.beryy.ws_bridge';
const MANIFEST = {
  name: HOST_NAME,
  description: 'Beryy WebSocket URL bridge',
  path: join(process.cwd(), 'native', 'ws-bridge', 'index.js'),
  type: 'stdio',
  allowed_origins: [`chrome-extension://${EXTENSION_ID}`]
};

function getManifestDir() {
  const home = homedir();
  const sys = platform();
  
  if (sys === 'win32') {
    // Windows: registry (we'll write a .reg file)
    return null;
  } else if (sys === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
  } else {
    // Linux
    return join(home, '.config', 'google-chrome', 'NativeMessagingHosts');
  }
}

function install() {
  const manifestDir = getManifestDir();
  
  if (manifestDir) {
    mkdirSync(manifestDir, { recursive: true });
    const manifestPath = join(manifestDir, `${HOST_NAME}.json`);
    writeFileSync(manifestPath, JSON.stringify(MANIFEST, null, 2));
    console.log(`✓ Installed native host manifest to ${manifestPath}`);
    console.log(`  Extension ID: ${EXTENSION_ID}`);
    console.log(`  Host path: ${MANIFEST.path}`);
  } else {
    // Windows - generate .reg file
    const regPath = join(process.cwd(), 'install-native-host.reg');
    const escapedPath = MANIFEST.path.replace(/\\/g, '\\\\');
    const regContent = `Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}]
@="${escapedPath.replace(/\\/g, '\\\\')}"
`;
    writeFileSync(regPath, regContent);
    console.log(`✓ Generated Windows registry file: ${regPath}`);
    console.log('  Run this file (double-click) to install the native host.');
    console.log(`  Extension ID: ${EXTENSION_ID}`);
  }
  
  console.log('\nNext steps:');
  console.log('1. Reload the Beryy extension in chrome://extensions');
  console.log('2. Run the bridge: node opencode-bridge.js');
  console.log('3. Open the Beryy sidepanel - it should connect automatically');
}

install();