'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── PATHS ────────────────────────────────────────────────
const ROOT       = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

// En Railway: añade la variable DATA_DIR=/data
//             y monta un volumen persistente en /data desde el dashboard.
// En local:   usa ./data automáticamente (sin configurar nada).
const DATA_DIR   = process.env.DATA_DIR || path.join(ROOT, 'data');
const BOOKINGS_F   = path.join(DATA_DIR, 'bookings.json');
const SOURCES_F    = path.join(DATA_DIR, 'ical-sources.json');
const PROP_NOTES_F = path.join(DATA_DIR, 'prop-notes.json');

for (const d of [DATA_DIR, PUBLIC_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

console.log(`[Detalo] Datos en: ${DATA_DIR}`);

// ── VILLA LA PALMA — CAPACIDAD (9 villas físicas, anuncios combinados) ──────
// Fuentes con unidades >= 2 son "anuncios combinados". Cuando quedan < 2
// villas libres, sus propIds se bloquean para evitar doble-reserva.
const VLP = {
  pids:  ['tq1','tq2','tq3','tq4','tq5','tq6','tq7','tq8','tq9'],
  total: 9,
};

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

function readJSON(file, def) {
  try   { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return def; }
}

// Escritura atómica: nunca deja el archivo a medias si el proceso muere.
// Escribe en .tmp y luego renombra (operación atómica en el mismo filesystem).
function writeJSON(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
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

function buildIcal(propId, allBookings, allSources) {
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
  const overrides = allBookings.filter(b => b.type === 'ical-override' && b.pid === propId);
  for (const bk of allBookings.filter(b => b.pid === propId)) {
    if (!bk.s || !bk.e) continue;
    if (bk.type === 'ical-override') continue;
    if (bk.type === 'capacity-block') continue; // los capacity-blocks son internos
    if (bk.type === 'ical-block' && overrides.some(o => bk.s >= o.s && bk.e <= o.e)) continue;
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
  const ics = buildIcal(req.params.propId, readJSON(BOOKINGS_F, []), readJSON(SOURCES_F, []));
  res.setHeader('Content-Type',        'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="${req.params.propId}.ics"`);
  res.send(ics);
});

// ── ICAL SYNC (importar desde plataformas) ───────────────

// Headers que imitan un navegador real para evitar bloqueos de Booking.com y similares.
// IMPORTANTE: NO incluir Accept-Encoding: gzip porque Node http no descomprime automáticamente
// y recibiríamos bytes binarios en lugar de texto iCal.
const BROWSER_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept':          'text/calendar, text/html, application/xhtml+xml, */*;q=0.8',
  'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
  'Accept-Encoding': 'identity',   // sin compresión → texto plano siempre
  'Cache-Control':   'no-cache',
  'Pragma':          'no-cache',
};

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 15000, headers: BROWSER_HEADERS }, res => {
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

// ── SYNC CON LOGS DETALLADOS ─────────────────────────────
// log acumulado del último sync (accesible en GET /api/sync/debug)
let lastSyncLog = [];
function slog(...args) {
  const line = args.join(' ');
  console.log('[Sync]', line);
  lastSyncLog.push(line);
}

async function syncSourceDebug(src, dryRun = false) {
  const allPropIds = src.propIds && src.propIds.length ? src.propIds : [src.propId];

  // Soporte multi-URL: si hay un array urls[] con varias entradas se usa mapeado
  // 1:1 (urls[i] → propIds[i]).  Si hay una sola URL (caso clásico) se asigna
  // a todos los propIds, como antes.
  const urlList   = (src.urls && src.urls.length > 1) ? src.urls : [src.url];
  const use1to1   = urlList.length > 1 && urlList.length === allPropIds.length;

  const report = {
    src: { id: src.id, platform: src.platform, url: src.url, urls: urlList, propIds: allPropIds },
    steps: [], blocks: [], error: null,
  };

  const blocks = [];
  let anySuccess = false;
  let lastError  = null;

  for (let ui = 0; ui < urlList.length; ui++) {
    const urlEntry  = urlList[ui];
    const pidsForUrl = use1to1 ? [allPropIds[ui]] : allPropIds;
    const urlLabel  = urlList.length > 1 ? `URL ${ui + 1}` : 'URL';

    let text;
    try {
      text = await fetchText(urlEntry);
      anySuccess = true;
      report.steps.push({ ok: true, msg: `${urlLabel}: Descargado ${text.length} bytes` });
      slog(`  ${urlLabel}: ${urlEntry}`);
      slog(`  Bytes: ${text.length}`);
      const preview = text.split('\n').slice(0, 8).join('\n');
      slog(`  Primeras líneas:\n${preview}`);
    } catch (err) {
      const errMsg = err.message || err.code || String(err);
      lastError = errMsg;
      report.steps.push({ ok: false, msg: `${urlLabel}: Error al descargar: ${errMsg}` });
      slog(`  ${urlLabel}: ERROR: ${errMsg}`);
      if (urlList.length === 1) {
        // URL única → fallo total, retornar de inmediato
        return { updated: { ...src, lastSync: new Date().toISOString(), lastStatus: 'error', lastError: errMsg }, blocks: [], report };
      }
      continue; // con múltiples URLs seguir con las demás
    }

    const events = parseIcalText(text);
    slog(`  ${urlLabel}: ${events.length} eventos VEVENT`);
    report.steps.push({ ok: true, msg: `${urlLabel}: ${events.length} eventos VEVENT encontrados` });

    for (const ev of events) {
      let s = icalDateToYmd(ev['DTSTART']);
      let e = icalDateToYmd(ev['DTEND']);
      const uid     = ev['UID']     || '';
      const status  = (ev['STATUS'] || '').toUpperCase();
      const summary = ev['SUMMARY'] || '';

      slog(`    VEVENT uid=${uid} summary="${summary}" dtstart=${ev['DTSTART']} dtend=${ev['DTEND']} status=${status}`);

      if (!s) {
        slog(`      → SALTADO: DTSTART no tiene fecha válida`);
        report.steps.push({ ok: false, msg: `Saltado (sin DTSTART): uid=${uid}` });
        continue;
      }
      if (!e) e = s;
      const eOrig = e;
      e = addDays(e, -1);   // DTEND es exclusivo → restar 1 día
      if (e < s) e = s;

      if (uid.endsWith('@detalo')) {
        slog(`      → SALTADO: UID termina en @detalo (evento propio)`);
        report.steps.push({ ok: false, msg: `Saltado (UID @detalo): uid=${uid}` });
        continue;
      }
      if (status === 'CANCELLED') {
        slog(`      → SALTADO: STATUS=CANCELLED`);
        report.steps.push({ ok: false, msg: `Saltado (CANCELLED): uid=${uid}` });
        continue;
      }

      slog(`      → ACEPTADO s=${s} e=${e} (DTEND ${eOrig} -1 día) pids=${pidsForUrl.join(',')}`);
      report.steps.push({ ok: true, msg: `Aceptado: "${summary}" ${s} → ${e} pids=${pidsForUrl.join(',')}` });

      for (const pid of pidsForUrl) {
        const blk = {
          id: genId(), pid,
          type: 'ical-block',
          name: summary || 'Bloqueado',
          phone: '', s, e, income: 0,
          platform: src.platform || '',
          notes: `Importado de ${src.platform || 'iCal'}`,
          source: 'ical', sourceId: src.id, icalUid: uid,
          syncedAt: new Date().toISOString(),
        };
        blocks.push(blk);
        report.blocks.push({ pid, s, e, summary });
      }
    }
  }

  // Si todas las URLs fallaron (multi-URL)
  if (!anySuccess) {
    return { updated: { ...src, lastSync: new Date().toISOString(), lastStatus: 'error', lastError: lastError }, blocks: [], report };
  }

  slog(`  Bloques creados: ${blocks.length}`);
  return {
    updated: {
      ...src,
      lastSync: new Date().toISOString(),
      lastStatus: lastError ? 'partial' : 'ok',
      lastError: lastError || null,
      importedCount: blocks.length,
    },
    blocks,
    report,
  };
}

// Wrapper para mantener compatibilidad con _doSync
async function syncSource(src) {
  const result = await syncSourceDebug(src);
  return result;
}

// ── VILLA LA PALMA CAPACITY BLOCKS ──────────────────────────────────────────
// Para cada anuncio combinado (unidades >= 2) de VLP:
//   disponibles_totales = 9 − villas_ocupadas_ese_día (sin importar cuáles)
//   si disponibles_totales < unidades_del_anuncio → capacity-block en sus propIds
function computeVLPCapacityBlocks(bookings, sources) {
  // Fuentes combinadas de VLP (unidades >= 2 con al menos un propId de VLP)
  const combinedSrcs = sources.filter(s => {
    const ids = s.propIds && s.propIds.length ? s.propIds : [s.propId];
    return (s.unidades || 1) >= 2 && ids.some(id => VLP.pids.includes(id));
  });
  if (!combinedSrcs.length) return [];

  // Ocupación real de VLP: excluir capacity-block (evitar ciclos) e ical-override
  // (los overrides LIBERAN fechas, no las ocupan)
  const vlpBks = bookings.filter(b =>
    b.type !== 'capacity-block' &&
    b.type !== 'ical-override' &&
    VLP.pids.includes(b.pid) && b.s && b.e
  );
  if (!vlpBks.length) return [];

  // Mapa fecha → Set<pid> con villas ocupadas ese día
  const occ = new Map();
  for (const bk of vlpBks) {
    let d = new Date(bk.s + 'T12:00:00Z');
    const z = new Date(bk.e + 'T12:00:00Z');
    while (d <= z) {
      const ds = d.toISOString().slice(0, 10);
      if (!occ.has(ds)) occ.set(ds, new Set());
      occ.get(ds).add(bk.pid);
      d.setUTCDate(d.getUTCDate() + 1);
    }
  }

  const allBlocks = [];

  // Procesar cada fuente combinada de forma independiente
  for (const src of combinedSrcs) {
    const srcPids = (src.propIds && src.propIds.length ? src.propIds : [src.propId])
      .filter(id => VLP.pids.includes(id));
    if (!srcPids.length) continue;

    // Villas que necesita este anuncio (usa unidades configuradas)
    const needed = src.unidades || 2;

    // Fechas donde el total de villas disponibles en VLP es menor al necesario
    const blockDates = [];
    for (const [ds, occSet] of [...occ.entries()].sort(([a], [b]) => a < b ? -1 : 1)) {
      if (VLP.total - occSet.size < needed) blockDates.push(ds);
    }
    if (!blockDates.length) continue;

    // Fusionar fechas consecutivas en rangos
    const ranges = [];
    for (const ds of blockDates) {
      if (ranges.length) {
        const prev = ranges[ranges.length - 1];
        const next = new Date(prev.e + 'T12:00:00Z');
        next.setUTCDate(next.getUTCDate() + 1);
        if (next.toISOString().slice(0, 10) === ds) { prev.e = ds; continue; }
      }
      ranges.push({ s: ds, e: ds });
    }

    for (const { s, e } of ranges) {
      for (const pid of srcPids) {
        allBlocks.push({
          id: genId(), pid,
          type: 'capacity-block',
          name: 'Bloqueo por capacidad',
          phone: '', s, e, income: 0, platform: '',
          notes: `VLP: disponibilidad insuficiente para "${src.platform||'combinado'}" (necesita ${needed}, quedan < ${needed})`,
          source: 'capacity',
          syncedAt: new Date().toISOString(),
        });
      }
    }
  }

  slog(`[VLP Capacidad] ${combinedSrcs.length} fuente(s) combinada(s) → ${allBlocks.length} bloques generados`);
  return allBlocks;
}

async function _doSync() {
  lastSyncLog = [];
  const sources = readJSON(SOURCES_F, []);
  if (!sources.length) { slog('Sin fuentes iCal configuradas.'); return; }
  slog(`=== Sync iniciado: ${new Date().toISOString()} | ${sources.length} fuente(s) ===`);
  let bookings = readJSON(BOOKINGS_F, []);
  // Limpiar capacity-blocks anteriores; se recalcularán al final
  bookings = bookings.filter(b => b.type !== 'capacity-block');
  const updatedSources = [];
  for (const src of sources) {
    slog(`\nFuente: ${src.platform || '(sin plataforma)'} | propIds: ${(src.propIds||[src.propId]).join(',')}`);
    const { updated, blocks } = await syncSource(src);
    bookings = bookings.filter(b => !(b.source === 'ical' && b.sourceId === src.id));
    bookings.push(...blocks);
    updatedSources.push(updated);
    if (updated.lastStatus === 'ok')
      slog(`  ✓ ${src.platform || src.propId}: ${updated.importedCount} bloques guardados`);
    else
      slog(`  ✗ ${src.propId}: ${updated.lastError}`);
  }
  // Limpiar ical-blocks huérfanos (cuya fuente ya no existe)
  bookings = cleanOrphans(bookings, updatedSources);

  // Suprimir ical-blocks cubiertos por ical-overrides manuales
  const overrides = bookings.filter(b => b.type === 'ical-override');
  if (overrides.length) {
    const before = bookings.length;
    bookings = bookings.filter(b => {
      if (b.type !== 'ical-block') return true;
      return !overrides.some(o => o.pid === b.pid && b.s >= o.s && b.e <= o.e);
    });
    const suppressed = before - bookings.length;
    if (suppressed > 0) slog(`[Overrides] ${suppressed} bloque(s) iCal suprimidos por override manual`);
  }
  // Calcular y agregar bloques de capacidad (Villa La Palma)
  const capBlocks = computeVLPCapacityBlocks(bookings, updatedSources);
  bookings.push(...capBlocks);

  writeJSON(BOOKINGS_F, bookings);
  writeJSON(SOURCES_F,  updatedSources);
  syncState.lastRun = new Date().toISOString();
  slog(`\n=== Sync completado: ${syncState.lastRun} | Total bookings en DB: ${bookings.length} (${capBlocks.length} de capacidad) ===`);
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

// ── DEBUG: diagnóstico completo de una fuente ─────────────
// GET /api/sync/debug          → reporte del último sync (logs acumulados)
// POST /api/sync/debug/:id     → fuerza re-sync de esa fuente y devuelve reporte detallado
app.get('/api/sync/debug', (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(lastSyncLog.length
    ? lastSyncLog.join('\n')
    : 'No hay logs del último sync. Haz click en "Sincronizar ahora" primero.');
});

app.post('/api/sync/debug/:id', async (req, res) => {
  const sources = readJSON(SOURCES_F, []);
  const src = sources.find(s => s.id === req.params.id);
  if (!src) return res.status(404).json({ error: 'Fuente no encontrada' });

  const { updated, blocks, report } = await syncSourceDebug(src);
  const bookings = readJSON(BOOKINGS_F, []);
  const icalForThis = bookings.filter(b => b.source === 'ical' && b.sourceId === src.id);

  res.json({
    source: src,
    result: updated,
    eventsCreated: blocks.length,
    blocksAlreadyInDB: icalForThis.length,
    blocksInDB: icalForThis,
    report,
  });
});

// ── PROP NOTES ───────────────────────────────────────────
app.get('/api/prop-notes', (_req, res) => {
  res.json(readJSON(PROP_NOTES_F, {}));
});
app.put('/api/prop-notes/:propId', (req, res) => {
  const notes = readJSON(PROP_NOTES_F, {});
  const text  = (req.body.text || '').trim();
  if (text) notes[req.params.propId] = text;
  else      delete notes[req.params.propId];
  writeJSON(PROP_NOTES_F, notes);
  res.json({ ok: true });
});

// ── DETECCIÓN DE CONFLICTOS ──────────────────────────────
function findConflicts(bookings) {
  const relevant = bookings.filter(b => b.s && b.e && b.pid &&
    b.type !== 'capacity-block' && b.type !== 'ical-override');
  const conflicts = [];
  const seen = new Set();
  for (let i = 0; i < relevant.length; i++) {
    for (let j = i + 1; j < relevant.length; j++) {
      const a = relevant[i], b = relevant[j];
      if (a.pid !== b.pid) continue;
      if (!(a.s <= b.e && a.e >= b.s)) continue;
      const key = [a.id, b.id].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      conflicts.push({
        pid: a.pid,
        propName: PROP_NAMES[a.pid] || a.pid,
        bk1: { id: a.id, type: a.type, name: a.name || a.type, platform: a.platform, s: a.s, e: a.e },
        bk2: { id: b.id, type: b.type, name: b.name || b.type, platform: b.platform, s: b.s, e: b.e },
        overlapStart: a.s > b.s ? a.s : b.s,
        overlapEnd:   a.e < b.e ? a.e : b.e,
      });
    }
  }
  return conflicts;
}

// ── LIMPIEZA DE BLOQUES HUÉRFANOS ────────────────────────
function cleanOrphans(bookings, sources) {
  const sourceIds = new Set((sources || []).map(s => s.id));
  const before = bookings.length;
  // Eliminar ical-blocks cuya fuente ya no existe
  const cleaned = bookings.filter(b => {
    if (b.type !== 'ical-block') return true;
    if (!b.sourceId) return true; // sin sourceId, conservar
    return sourceIds.has(b.sourceId);
  });
  const removed = before - cleaned.length;
  if (removed > 0) slog(`[Orphan cleanup] Eliminados ${removed} ical-block(s) huérfanos (fuente eliminada)`);
  return cleaned;
}

// ── /api/ical-check ─────────────────────────────────────
app.get('/api/ical-check', (_req, res) => {
  const bookings = readJSON(BOOKINGS_F, []);
  const sources  = readJSON(SOURCES_F,  []);
  const allPids  = [...new Set(bookings.map(b => b.pid))].sort();

  const report = allPids.map(pid => {
    const dbBlocks = bookings.filter(b =>
      b.pid === pid &&
      b.type !== 'capacity-block' &&
      b.type !== 'ical-override'
    );
    const icalText   = buildIcal(pid, bookings, sources);
    const icalEvents = parseIcalText(icalText);
    const byType = {};
    for (const b of dbBlocks) byType[b.type] = (byType[b.type] || 0) + 1;
    return {
      propId: pid,
      name: PROP_NAMES[pid] || pid,
      dbTotal: dbBlocks.length,
      icalTotal: icalEvents.length,
      mismatch: dbBlocks.length !== icalEvents.length,
      byType,
    };
  });

  const mismatches = report.filter(r => r.mismatch).length;
  res.json({ ok: mismatches === 0, mismatches, total: report.length, report });
});

// ── /api/conflicts ───────────────────────────────────────
app.get('/api/conflicts', (_req, res) => {
  const bookings = readJSON(BOOKINGS_F, []);
  res.json(findConflicts(bookings));
});

// ── /api/alerts ─────────────────────────────────────────
app.get('/api/alerts', (_req, res) => {
  const bookings = readJSON(BOOKINGS_F, []);
  const sources  = readJSON(SOURCES_F,  []);
  const alerts   = [];

  // 1. Errores de sincronización
  for (const src of sources) {
    if (src.lastStatus === 'error') {
      alerts.push({
        type: 'sync-error', level: 'error',
        message: `Sync fallido: ${src.platform || src.propId} — ${src.lastError || 'error desconocido'}`,
        sourceId: src.id,
      });
    } else if (src.lastStatus === 'partial') {
      alerts.push({
        type: 'sync-error', level: 'warning',
        message: `Sync parcial: ${src.platform || src.propId} — algunas URLs fallaron`,
        sourceId: src.id,
      });
    }
  }

  // 2. Conflictos de bloqueos duplicados
  const conflicts = findConflicts(bookings);
  for (const c of conflicts) {
    alerts.push({
      type: 'conflict', level: 'warning',
      message: `Conflicto en ${c.propName}: "${c.bk1.name}" vs "${c.bk2.name}" (${c.overlapStart} → ${c.overlapEnd})`,
      pid: c.pid, overlapStart: c.overlapStart, overlapEnd: c.overlapEnd,
      bk1: c.bk1, bk2: c.bk2,
    });
  }

  // 3. iCal con menos eventos que DB
  const allPids = [...new Set(bookings.map(b => b.pid))];
  for (const pid of allPids) {
    const dbBlocks = bookings.filter(b =>
      b.pid === pid &&
      b.type !== 'capacity-block' &&
      b.type !== 'ical-override'
    );
    if (!dbBlocks.length) continue;
    const icalText   = buildIcal(pid, bookings, sources);
    const icalEvents = parseIcalText(icalText);
    if (icalEvents.length < dbBlocks.length) {
      alerts.push({
        type: 'ical-mismatch', level: 'warning',
        message: `${PROP_NAMES[pid] || pid}: ${dbBlocks.length} bloques en DB pero solo ${icalEvents.length} en iCal de salida`,
        pid, dbTotal: dbBlocks.length, icalTotal: icalEvents.length,
      });
    }
  }

  res.json({ count: alerts.length, alerts });
});

// ── FALLBACK ─────────────────────────────────────────────
app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ── START ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🏡  Detalo v2  →  http://localhost:${PORT}\n`);
  setTimeout(() => syncAll().catch(console.error), 3000);          // sync al arrancar
  setInterval(() => syncAll().catch(console.error), 5 * 60 * 1000); // cada 5 min
});
