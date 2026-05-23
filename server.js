'use strict';

const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const https    = require('https');
const http     = require('http');
const crypto   = require('crypto');
const { DatabaseSync } = require('node:sqlite'); // integrado en Node.js ≥ 22.5

const app  = express();
const PORT = process.env.PORT || 3000;

// ── PATHS ────────────────────────────────────────────────
const ROOT       = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

// Base de datos SQLite
//   Railway : define la variable DB_PATH=/data/detalo.db
//             (volumen persistente montado en /data en el dashboard de Railway)
//   Local   : usa ./data/detalo.db por defecto
const DB_FILE = process.env.DB_PATH || path.join(ROOT, 'data', 'detalo.db');
const DB_DIR  = path.dirname(DB_FILE);

for (const d of [DB_DIR, PUBLIC_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ── SQLITE ───────────────────────────────────────────────
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL'); // mejor rendimiento / recuperación ante crash
db.exec(`
  CREATE TABLE IF NOT EXISTS store (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '[]'
  )
`);
console.log(`[DB] SQLite: ${DB_FILE}`);

// Migración única desde archivos JSON legacy (solo útil en desarrollo local)
const LEGACY_DIR = path.join(ROOT, 'data');
for (const [key, fname] of [['bookings','bookings.json'],['sources','ical-sources.json']]) {
  const f = path.join(LEGACY_DIR, fname);
  if (fs.existsSync(f) && !db.prepare('SELECT 1 FROM store WHERE key=?').get(key)) {
    try {
      const raw = fs.readFileSync(f, 'utf8').trim();
      JSON.parse(raw); // validar antes de insertar
      db.prepare('INSERT INTO store(key,value) VALUES(?,?)').run(key, raw);
      console.log(`[DB] Migrado ${fname} → SQLite`);
    } catch(e) { console.warn(`[DB] Migración ${fname}: ${e.message}`); }
  }
}

// ── PROPERTY MAP (para nombres en iCal de salida) ────────
const PROP_NAMES = {
  tq1:'Villa 1',   tq2:'Villa 2',   tq3:'Villa 3',   tq4:'Villa 4',   tq5:'Villa 5',
  tq6:'Villa 6',   tq7:'Villa 7',   tq8:'Villa 8',   tq9:'Villa 9',
  ta1:'Cabaña Lobo', ta2:'Cabaña Ciervo', ta3:'Cabaña Oso',
  ta4:'Cabaña Tigre', ta5:'Cabaña Puma',  ta6:'Cabaña Venado', ta7:'Cabaña Lince',
  ta8:'Cabaña El Cielo', ta9:'Villa 1 (La Cumbre)', ta10:'Villa 2 (La Cumbre)',
  mz1:'Cabaña Grande', mz2:'Esmeralda 1', mz3:'Esmeralda 2', mz4:'Esmeralda 3',
  nv1:'Riviera Capri',
  gd1:'Solares Liva', gd2:'Solares Soare', gd3:'Casita Azul', gd4:'Xima Diana',
  sp5:'Casa de Campo', sp1:'Depto 1', sp2:'Depto 2', sp3:'Depto 3', sp4:'Depto 4',
};

// ── MIDDLEWARE ───────────────────────────────────────────
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ── HELPERS ──────────────────────────────────────────────
const genId = () => crypto.randomBytes(8).toString('hex');

// Claves en la tabla `store` (reemplazan las rutas de archivo anteriores)
const BOOKINGS_F = 'bookings';
const SOURCES_F  = 'sources';

function readJSON(key, def) {
  try {
    const row = db.prepare('SELECT value FROM store WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : def;
  } catch { return def; }
}
function writeJSON(key, data) {
  db.prepare('INSERT OR REPLACE INTO store(key,value) VALUES(?,?)')
    .run(key, JSON.stringify(data, null, 2));
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── BOOKINGS API ─────────────────────────────────────────

app.get('/api/bookings', (_req, res) => {
  res.json(readJSON(BOOKINGS_F, []));
});

app.post('/api/bookings', (req, res) => {
  const list = readJSON(BOOKINGS_F, []);
  const bk   = { ...req.body, id: req.body.id || genId(), createdAt: new Date().toISOString() };
  list.push(bk);
  writeJSON(BOOKINGS_F, list);
  res.json(bk);
});

app.put('/api/bookings/:id', (req, res) => {
  const list = readJSON(BOOKINGS_F, []);
  const i    = list.findIndex(b => b.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Not found' });
  list[i] = { ...list[i], ...req.body, id: req.params.id };
  writeJSON(BOOKINGS_F, list);
  res.json(list[i]);
});

app.delete('/api/bookings/:id', (req, res) => {
  writeJSON(BOOKINGS_F, readJSON(BOOKINGS_F, []).filter(b => b.id !== req.params.id));
  res.json({ ok: true });
});

// ── ICAL SOURCES API ─────────────────────────────────────

app.get('/api/ical-sources', (_req, res) => {
  res.json(readJSON(SOURCES_F, []));
});

app.post('/api/ical-sources', (req, res) => {
  const list = readJSON(SOURCES_F, []);
  const src  = { ...req.body, id: genId(), lastSync: null, lastStatus: null, lastError: null };
  list.push(src);
  writeJSON(SOURCES_F, list);
  res.json(src);
});

app.delete('/api/ical-sources/:id', (req, res) => {
  // Eliminar también los bloques importados de esa fuente
  writeJSON(BOOKINGS_F,
    readJSON(BOOKINGS_F, []).filter(b => b.sourceId !== req.params.id));
  writeJSON(SOURCES_F,
    readJSON(SOURCES_F,  []).filter(s => s.id     !== req.params.id));
  res.json({ ok: true });
});

// ── ICAL OUTPUT (por unidad) ─────────────────────────────

function esc(s) {
  return (s || '').replace(/\\/g,'\\\\').replace(/;/g,'\\;')
                  .replace(/,/g,'\\,').replace(/\n/g,'\\n');
}

function buildIcal(propId, allBookings) {
  const name  = PROP_NAMES[propId] || propId;
  const stamp = new Date().toISOString().replace(/[-:.]/g,'').slice(0,15) + 'Z';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Detalo//Vacation Rental//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:Detalo - ${esc(name)}`,
    'X-WR-TIMEZONE:America/Mexico_City',
  ];
  for (const bk of allBookings.filter(b => b.pid === propId)) {
    if (!bk.s || !bk.e) continue;
    const dtS = bk.s.replace(/-/g,'');
    const dtE = addDays(bk.e, 1).replace(/-/g,''); // DTEND exclusivo
    const sum = bk.type === 'reservation' ? esc(bk.name || 'Reserva') : 'BLOCKED';
    lines.push('BEGIN:VEVENT',
      `UID:${bk.id}@detalo`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${dtS}`,
      `DTEND;VALUE=DATE:${dtE}`,
      `SUMMARY:${sum}`,
      'STATUS:CONFIRMED');
    if (bk.type === 'reservation' && bk.platform)
      lines.push(`DESCRIPTION:Plataforma: ${esc(bk.platform)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

app.get('/api/ical/:propId.ics', (req, res) => {
  const ics = buildIcal(req.params.propId, readJSON(BOOKINGS_F, []));
  res.setHeader('Content-Type',        'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="${req.params.propId}.ics"`);
  res.send(ics);
});

// ── ICAL SYNC (importar desde plataformas) ───────────────

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 15000, headers: { 'User-Agent': 'Detalo/2.0' } }, res => {
      // Seguir un nivel de redirect
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location)
        return fetchText(res.headers.location).then(resolve).catch(reject);
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c  => buf += c);
      res.on('end',  () => resolve(buf));
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function parseIcalText(raw) {
  // Desplegar líneas continuas (RFC 5545 §3.1)
  const text = raw
    .replace(/\r\n[ \t]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g,   '\n')
    .replace(/\n[ \t]/g, '');
  const events = [];
  let ev = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t === 'BEGIN:VEVENT')  { ev = {}; continue; }
    if (t === 'END:VEVENT')    { if (ev) { events.push(ev); ev = null; } continue; }
    if (!ev) continue;
    const ci = t.indexOf(':');
    if (ci < 1) continue;
    const key = t.slice(0, ci).split(';')[0].toUpperCase();
    ev[key]   = t.slice(ci + 1).trim();
  }
  return events;
}

function icalDateToYmd(s) {
  if (!s) return null;
  const d = s.replace(/\D/g, '').slice(0, 8);
  return d.length >= 8 ? `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}` : null;
}

// Estado global del sync
const syncState = { running: false, lastRun: null };
let _syncPromise = null; // deduplicación: varias llamadas concurrentes comparten la misma promise

async function syncSource(src) {
  let text;
  try   { text = await fetchText(src.url); }
  catch (err) {
    return { updated: { ...src, lastSync: new Date().toISOString(), lastStatus: 'error', lastError: err.message }, blocks: [] };
  }
  const events = parseIcalText(text);
  const blocks = [];
  for (const ev of events) {
    let s = icalDateToYmd(ev['DTSTART']);
    let e = icalDateToYmd(ev['DTEND']);
    if (!s) continue;
    if (!e) e = s;
    e = addDays(e, -1);          // DTEND es exclusivo → restar 1 día
    if (e < s) e = s;
    const uid = ev['UID'] || '';
    if (uid.endsWith('@detalo')) continue;               // evitar nuestros propios eventos
    if ((ev['STATUS'] || '').toUpperCase() === 'CANCELLED') continue;
    // Crear un bloque por cada unidad que ocupa este anuncio
    const propIds = src.propIds && src.propIds.length ? src.propIds : [src.propId];
    for (const pid of propIds) {
      blocks.push({
        id: genId(), pid,
        type: 'ical-block',
        name: ev['SUMMARY'] || 'Bloqueado',
        phone: '', s, e, income: 0,
        platform: src.platform || '',
        notes: `Importado de ${src.platform || 'iCal'}`,
        source: 'ical', sourceId: src.id, icalUid: uid,
        syncedAt: new Date().toISOString(),
      });
    }
  }
  return {
    updated: { ...src, lastSync: new Date().toISOString(), lastStatus: 'ok', lastError: null, importedCount: blocks.length },
    blocks,
  };
}

async function _doSync() {
  const sources = readJSON(SOURCES_F, []);
  if (!sources.length) return;
  console.log(`[Detalo Sync] Iniciando sync de ${sources.length} fuente(s)…`);
  let bookings = readJSON(BOOKINGS_F, []);
  const updatedSources = [];
  for (const src of sources) {
    const { updated, blocks } = await syncSource(src);
    bookings = bookings.filter(b => !(b.source === 'ical' && b.sourceId === src.id));
    bookings.push(...blocks);
    updatedSources.push(updated);
    if (updated.lastStatus === 'ok')
      console.log(`  ✓ ${src.platform || src.propId}: ${updated.importedCount} eventos`);
    else
      console.log(`  ✗ ${src.propId}: ${updated.lastError}`);
  }
  writeJSON(BOOKINGS_F, bookings);
  writeJSON(SOURCES_F,  updatedSources);
  syncState.lastRun = new Date().toISOString();
  console.log('[Detalo Sync] Completado.');
}

async function syncAll() {
  if (_syncPromise) return _syncPromise;            // deduplicar llamadas concurrentes
  syncState.running = true;
  _syncPromise = _doSync()
    .catch(e => console.error('[Sync error]', e.message))
    .finally(() => { syncState.running = false; _syncPromise = null; });
  return _syncPromise;
}

app.get('/api/sync/status', (_req, res) => {
  res.json({ ...syncState, sources: readJSON(SOURCES_F, []) });
});

app.post('/api/sync', async (_req, res) => {
  await syncAll();
  res.json({ ok: true, sources: readJSON(SOURCES_F, []), lastRun: syncState.lastRun });
});

// ── FALLBACK ─────────────────────────────────────────────
app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ── START ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🏡  Detalo v2  →  http://localhost:${PORT}\n`);
  setTimeout(() => syncAll().catch(console.error), 3000);          // sync al arrancar
  setInterval(() => syncAll().catch(console.error), 5 * 60 * 1000); // cada 5 min
});
