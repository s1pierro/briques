/**
 * dynamics.js — source de vérité pour les types de slots, joints et liaisons.
 * Charge assembly-mechanics.toml, expose une API synchrone partagée par
 * Assembler et Forge.
 */

// ─── Parser TOML minimal ──────────────────────────────────────────────────────
// Supporte [[section]] (tableaux de tables) et key = value sur la même ligne.
// Ignore les lignes vides et les commentaires (#).

function parseToml(text) {
  const result = {};
  let current = null;
  let section = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const arrayHeader = line.match(/^\[\[(\w+)\]\]$/);
    if (arrayHeader) {
      section = arrayHeader[1];
      if (!result[section]) result[section] = [];
      current = {};
      result[section].push(current);
      continue;
    }

    if (current && line.includes('=')) {
      const eq = line.indexOf('=');
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      current[key] = val;
    }
  }
  return result;
}

// ─── Sérialiseur TOML ─────────────────────────────────────────────────────────

function toToml(data) {
  const COL = 12; // largeur de la colonne clé pour alignement
  const pad = k => k.padEnd(COL);
  const block = (arr, section) =>
    arr.map(obj =>
      `[[${section}]]\n` +
      Object.entries(obj).map(([k, v]) => `${pad(k)} = ${v}`).join('\n') +
      '\n'
    ).join('\n');

  return [
    '# ════════════════════════════════════════════════════════════════',
    '#  assembly-mechanics.toml',
    '#  Source de vérité des types de slots et des liaisons rBang',
    '# ════════════════════════════════════════════════════════════════',
    '',
    '',
    '# ────────────────────────────────────────────────────────────────',
    '#  SECTION 1 · TYPES DE SLOTS',
    '# ────────────────────────────────────────────────────────────────',
    '',
    block(data.slot || [], 'slot'),
    '# ────────────────────────────────────────────────────────────────',
    '#  SECTION 2 · TYPES DE JOINTS',
    '# ────────────────────────────────────────────────────────────────',
    '',
    block(data.joint || [], 'joint'),
    '# ────────────────────────────────────────────────────────────────',
    '#  SECTION 3 · LIAISONS',
    '# ────────────────────────────────────────────────────────────────',
    '',
    block(data.liaison || [], 'liaison'),
  ].join('\n');
}

// ─── État interne ─────────────────────────────────────────────────────────────

let _raw   = null;   // { slot[], joint[], liaison[] } — données brutes parsées
let _toml  = '';     // texte TOML courant (pour save)
let _index = new Map(); // Map<typeA, Map<typeB, liaison>>

// ─── Chargement ───────────────────────────────────────────────────────────────

export async function init() {
  if (_raw) return;
  const res  = await fetch('/data/assembly-mechanics.toml');
  _toml = await res.text();
  _raw  = parseToml(_toml);
  _buildIndex();
}

function _buildIndex() {
  _index.clear();
  for (const l of (_raw.liaison || [])) {
    _set(l.slotA, l.slotB, l);
    _set(l.slotB, l.slotA, l);
  }
}

function _set(a, b, liaison) {
  if (!_index.has(a)) _index.set(a, new Map());
  _index.get(a).set(b, liaison);
}

function _ensure() {
  if (!_raw) throw new Error('dynamics.init() not called');
}

// ─── API requêtes ─────────────────────────────────────────────────────────────

export function isCompatible(typeA, typeB) {
  _ensure();
  return _index.get(typeA)?.has(typeB) ?? false;
}

export function getJointType(typeA, typeB) {
  _ensure();
  return _index.get(typeA)?.get(typeB)?.joint ?? null;
}

export function getRule(typeA, typeB) {
  _ensure();
  return _index.get(typeA)?.get(typeB) ?? null;
}

export function getCompatibles(slotType) {
  _ensure();
  const map = _index.get(slotType);
  return map ? Array.from(map.keys()) : [];
}

export function getAllLiaisons() {
  _ensure();
  return _raw.liaison || [];
}

export function getLiaisonById(id) {
  _ensure();
  return (_raw.liaison || []).find(l => l.id === id) ?? null;
}

export function getAllSlotTypes() {
  _ensure();
  return (_raw.slot || []).map(s => s.id);
}

export function getAllSlots() {
  _ensure();
  return _raw.slot || [];
}

export function getSlotMeta(id) {
  _ensure();
  return (_raw.slot || []).find(s => s.id === id)
    ?? { id, label: id, role: 'unknown', family: 'unknown', color: '#888888', description: '' };
}

export function getSlotColor(id) {
  const meta = getSlotMeta(id);
  return parseInt((meta.color || '#888888').replace('#', ''), 16);
}

export function getAllJointDefs() {
  _ensure();
  const map = {};
  for (const j of (_raw.joint || [])) map[j.id] = j;
  return map;
}

export function getAllJoints() {
  _ensure();
  return _raw.joint || [];
}

// ─── API mutations (Forge) ────────────────────────────────────────────────────

export function updateSlot(id, patch) {
  _ensure();
  const slot = (_raw.slot || []).find(s => s.id === id);
  if (slot) { Object.assign(slot, patch); }
}

export function addSlot(slot) {
  _ensure();
  if ((_raw.slot || []).find(s => s.id === slot.id)) return false;
  if (!_raw.slot) _raw.slot = [];
  _raw.slot.push(slot);
  return true;
}

export function removeSlot(id) {
  _ensure();
  _raw.slot = (_raw.slot || []).filter(s => s.id !== id);
  // Supprimer aussi les liaisons qui référencent ce slot
  _raw.liaison = (_raw.liaison || []).filter(l => l.slotA !== id && l.slotB !== id);
  _buildIndex();
}

export function updateLiaison(id, patch) {
  _ensure();
  const l = (_raw.liaison || []).find(l => l.id === id);
  if (l) { Object.assign(l, patch); _buildIndex(); }
}

export function addLiaison(liaison) {
  _ensure();
  if (_index.get(liaison.slotA)?.has(liaison.slotB)) return false;
  if (!liaison.id) liaison.id = 'liaison-' + Math.random().toString(36).slice(2, 10);
  if (!_raw.liaison) _raw.liaison = [];
  _raw.liaison.push(liaison);
  _buildIndex();
  return true;
}

export function removeLiaison(id) {
  _ensure();
  _raw.liaison = (_raw.liaison || []).filter(l => l.id !== id);
  _buildIndex();
}

export function updateJoint(id, patch) {
  _ensure();
  const j = (_raw.joint || []).find(j => j.id === id);
  if (j) Object.assign(j, patch);
}

// ─── Sauvegarde ───────────────────────────────────────────────────────────────

export async function save() {
  _ensure();
  _toml = toToml(_raw);
  const res = await fetch('/mechanics', {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: _toml,
  });
  return res.json();
}

export function getRawToml() { return _toml; }
export function getRawData() { return _raw; }
