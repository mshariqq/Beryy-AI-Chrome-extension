#!/usr/bin/env node
/**
 * Install Beryy Bridge as a system service (systemd/launchd/Windows)
 * Run with: node install-service.js
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { platform, arch } from 'process';
import { execSync } from 'child_process';

const SERVICE_NAME = 'beryy-bridge';
const BRIDGE_SCRIPT = join(process.cwd(), 'opencode-bridge.js');
const NODE_BIN = execSync('which node', { encoding: 'utf8' }).trim() || 'node';
const USER = process.env.USER || process.env.USERNAME;
const HOME = homedir();

function getServiceConfig() {
  const sys = platform();
  
  if (sys === 'linux') {
    return {
      type: 'systemd',
      path: `/etc/systemd/system/${SERVICE_NAME}.service`,
      content: `[Unit]
Description=Beryy Bridge - WebSocket bridge for Chrome extension
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=${USER}
WorkingDirectory=${process.cwd()}
ExecStart=${NODE_BIN} ${BRIDGE_SCRIPT}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production
Environment=HOME=${HOME}

[Install]
WantedBy=multi-user.target
`
    };
  } else if (sys === 'darwin') {
    const plistPath = join(HOME, 'Library', 'LaunchAgents', `com.beryy.bridge.plist`);
    return {
      type: 'launchd',
      path: plistPath,
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.beryy.bridge</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${BRIDGE_SCRIPT}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${process.cwd()}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${HOME}/.beryy/bridge.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/.beryy/bridge-error.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
</dict>
</plist>
`
    };
  } else if (sys === 'win32') {
    // Windows: create a .bat wrapper and use NSSM or Windows Service
    // Simpler: create a startup shortcut in shell:startup
    const startupDir = join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const batPath = join(startupDir, `${SERVICE_NAME}.bat`);
    return {
      type: 'windows-startup',
      path: batPath,
      content: `@echo off
cd /d "${process.cwd()}"
"${NODE_BIN}" "${BRIDGE_SCRIPT}" >> "%USERPROFILE%\\.beryy\\bridge.log" 2>> "%USERPROFILE%\\.beryy\\bridge-error.log"
`
    };
  }
  
  return null;
}

function install() {
  const config = getServiceConfig();
  
  if (!config) {
    console.error('Unsupported platform:', platform());
    process.exit(1);
  }
  
  console.log(`Installing ${SERVICE_NAME} as ${config.type} service...`);
  
  if (config.type === 'systemd') {
    // Need sudo for systemd
    try {
      execSync(`sudo tee ${config.path} > /dev/null << 'EOF'\n${config.content}\nEOF`, { stdio: 'inherit' });
      execSync('sudo systemctl daemon-reload', { stdio: 'inherit' });
      execSync(`sudo systemctl enable ${SERVICE_NAME}`, { stdio: 'inherit' });
      execSync(`sudo systemctl start ${SERVICE_NAME}`, { stdio: 'inherit' });
      console.log('✓ Systemd service installed and started');
      console.log('  Status: sudo systemctl status beryy-bridge');
      console.log('  Logs: journalctl -u beryy-bridge -f');
    } catch (e) {
      console.error('Failed to install systemd service. Run with sudo?');
      process.exit(1);
    }
  } else if (config.type === 'launchd') {
    try {
      writeFileSync(config.path, config.content);
      execSync(`launchctl load ${config.path}`, { stdio: 'inherit' });
      console.log('✓ LaunchAgent installed and loaded');
      console.log('  Status: launchctl list | grep beryy');
      console.log('  Logs: tail -f ~/.beryy/bridge.log');
    } catch (e) {
      console.error('Failed to install launchd service:', e.message);
      process.exit(1);
    }
  } else if (config.type === 'windows-startup') {
    try {
      writeFileSync(config.path, config.content);
      console.log('✓ Windows startup shortcut created');
      console.log('  Bridge will start on next login');
      console.log('  Logs: %USERPROFILE%\\.beryy\\bridge.log');
    } catch (e) {
      console.error('Failed to create startup shortcut:', e.message);
      process.exit(1);
    }
  }
  
  console.log('\n✓ Service installed. Bridge will run automatically on boot and restart on failure.');
}

function uninstall() {
  const config = getServiceConfig();
  
  if (!config) return;
  
  console.log(`Uninstalling ${SERVICE_NAME}...`);
  
  try {
    if (config.type === 'systemd') {
      execSync(`sudo systemctl stop ${SERVICE_NAME}`, { stdio: 'inherit' });
      execSync(`sudo systemctl disable ${SERVICE_NAME}`, { stdio: 'inherit' });
      execSync(`sudo rm ${config.path}`, { stdio: 'inherit' });
      execSync('sudo systemctl daemon-reload', { stdio: 'inherit' });
    } else if (config.type === 'launchd') {
      execSync(`launchctl unload ${config.path}`, { stdio: 'inherit' });
      execSync(`rm ${config.path}`, { stdio: 'inherit' });
    } else if (config.type === 'windows-startup') {
      execSync(`del "${config.path}"`, { stdio: 'inherit', shell: true });
    }
    console.log('✓ Service uninstalled');
  } catch (e) {
    console.error('Uninstall failed:', e.message);
  }
}

const cmd = process.argv[2] || 'install';
if (cmd === 'uninstall') {
  uninstall();
} else {
  install();
}