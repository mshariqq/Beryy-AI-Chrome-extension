#!/usr/bin/env node
// Native messaging host for Beryy WebSocket bridge
// Reads ~/.beryy/ws-url and returns { url: "ws://..." }

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

function send(obj) {
  const data = JSON.stringify(obj);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(data.length, 0);
  process.stdout.write(len);
  process.stdout.write(data);
}

function main() {
  const urlFile = join(homedir(), '.beryy', 'ws-url');
  let url;
  try {
    url = readFileSync(urlFile, 'utf8').trim();
    if (!url) throw new Error('empty');
  } catch {
    send({ error: 'ws-url file not found or empty' });
    process.exit(1);
  }
  send({ url });
}

main();