#!/usr/bin/env node
'use strict';
const fs   = require('fs');
const path = require('path');

const PROJECTS_DIR = '/root/.claude/projects/-storage-self-primary-rbang';
const OUT          = path.join(__dirname, '..', 'conversation.md');

// Prendre le fichier JSONL le plus récent du projet
const jsonls = fs.readdirSync(PROJECTS_DIR)
  .filter(f => f.endsWith('.jsonl'))
  .map(f => ({ f, mt: fs.statSync(path.join(PROJECTS_DIR, f)).mtimeMs }))
  .sort((a, b) => b.mt - a.mt);

if (!jsonls.length) { console.error('Aucun fichier JSONL trouvé.'); process.exit(1); }

const src   = path.join(PROJECTS_DIR, jsonls[0].f);
const lines = fs.readFileSync(src, 'utf8').trim().split('\n');

let out = '# rBang — Journal de conversation\n\n';
let lastRole = null;

for (const line of lines) {
  let obj;
  try { obj = JSON.parse(line); } catch (_) { continue; }
  const msg = obj.message;
  if (!msg || !['user', 'assistant'].includes(msg.role)) continue;

  const text = Array.isArray(msg.content)
    ? msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim()
    : String(msg.content || '').trim();

  if (!text) continue;

  if (msg.role === 'user') {
    out += '---\n**Utilisateur**\n\n' + text + '\n\n';
  } else {
    out += '**Claude**\n\n' + text + '\n\n';
  }
  lastRole = msg.role;
}

fs.writeFileSync(OUT, out, 'utf8');
console.log(`conversation.md mis à jour — ${(out.length / 1024).toFixed(1)} Ko`);
