
/**
 * server.js  –  ConectaQ OLT NMS Pro v10
 * Multi-OLT · Caché JSON · Cola de Movimientos · Datos persistentes por serial
 * v10: + OLT Health (CPU/Mem/Uptime/Temp) · + Resync ONT individual · + Estado live post-reinicio
 */

"use strict";
const express = require("express");
const cors    = require("cors");
const net     = require("net");
const fs      = require("fs");
const path    = require("path");

const app  = express();
const PORT = Number(process.env.PORT || 3000);

// ── Archivos de datos ──
const CONFIG_FILE    = path.join(__dirname, "olts.json");
const CUSTOMERS_FILE = path.join(__dirname, "customers.json");
const HISTORY_FILE   = path.join(__dirname, "power_history.json");
const CACHE_FILE     = path.join(__dirname, "onts_cache.json");
const MOVES_FILE     = path.join(__dirname, "moves_queue.json");
const EVENTS_FILE    = path.join(__dirname, "events_log.json");

let olts = [{
  host: "170.246.112.83",
  port: 2333,
  username: "ConectaQ",
  password: "Juan@12345",
  enablePass: "Juan@12345",
  name: "OLT Principal",
  id: 0
}];
let customers    = {};
let powerHistory = {};
let ontsCache    = {};
let movesQueue   = [];
let eventsLog    = [];

function loadJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}

olts         = loadJSON(CONFIG_FILE,    olts);
customers    = loadJSON(CUSTOMERS_FILE, customers);
powerHistory = loadJSON(HISTORY_FILE,   powerHistory);
ontsCache    = loadJSON(CACHE_FILE,     ontsCache);
movesQueue   = loadJSON(MOVES_FILE,     movesQueue);
eventsLog    = loadJSON(EVENTS_FILE,    eventsLog);

const saveOLTs         = () => fs.writeFileSync(CONFIG_FILE,    JSON.stringify(olts,         null, 2));
const saveCustomers    = () => fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify(customers,    null, 2));
const savePowerHistory = () => fs.writeFileSync(HISTORY_FILE,   JSON.stringify(powerHistory, null, 2));
const saveCache        = () => fs.writeFileSync(CACHE_FILE,     JSON.stringify(ontsCache,    null, 2));
const saveMoves        = () => fs.writeFileSync(MOVES_FILE,     JSON.stringify(movesQueue,   null, 2));
const saveEvents       = () => fs.writeFileSync(EVENTS_FILE,    JSON.stringify(eventsLog.slice(-500), null, 2));

const CACHE_TTL = 2 * 60 * 1000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const NUM_PONS = 8;

// ── Registro de eventos ──
function addEvent(type, message, oltIndex = null) {
  eventsLog.push({ time: new Date().toISOString(), type, message, oltIndex });
  if (eventsLog.length > 500) eventsLog.shift();
  saveEvents();
}

// ═══════════════════════════════════════════════
// ENDPOINTS — OLTs
// ═══════════════════════════════════════════════

app.get("/napi/olts", (_req, res) => res.json({ ok: true, olts }));

app.post("/napi/olt/add", (req, res) => {
  const { host, port, username, password, enablePass, name } = req.body;
  const id = olts.length > 0 ? Math.max(...olts.map(o => o.id || 0)) + 1 : 1;
  olts.push({ host, port: Number(port), username, password, enablePass, name, id });
  saveOLTs();
  addEvent("info", `OLT agregado: ${name} (${host})`);
  res.json({ ok: true, message: "OLT agregado", id, index: olts.length - 1 });
});

// ═══════════════════════════════════════════════
// ENDPOINTS — OLT Health (CPU, Mem, Uptime, Temp, Versión)
// ═══════════════════════════════════════════════

app.get("/napi/olt/:oltIndex/health", async (req, res) => {
  try {
    const health = await getOltHealth(req.params.oltIndex);
    res.json({ ok: true, health });
  } catch (err) {
    res.status(502).json({ ok: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════
// ENDPOINTS — ONTs con caché
// ═══════════════════════════════════════════════

app.get("/napi/onts/:oltIndex", async (req, res) => {
  const oltIndex = req.params.oltIndex;
  const cache    = ontsCache[oltIndex];
  const now      = Date.now();

  if (cache && cache.data && (now - new Date(cache.updatedAt).getTime()) < CACHE_TTL) {
    res.json({ ...cache.data, fromCache: true, cachedAt: cache.updatedAt });
    if (!cache.refreshing) {
      ontsCache[oltIndex] = { ...cache, refreshing: true };
      readAllPons(oltIndex)
        .then(data => { ontsCache[oltIndex] = { data, updatedAt: new Date().toISOString(), refreshing: false }; saveCache(); })
        .catch(()   => { if (ontsCache[oltIndex]) ontsCache[oltIndex].refreshing = false; });
    }
    return;
  }

  try {
    const data = await readAllPons(oltIndex);
    ontsCache[oltIndex] = { data, updatedAt: new Date().toISOString(), refreshing: false };
    saveCache();
    res.json(data);
  } catch (err) {
    if (cache && cache.data) return res.json({ ...cache.data, fromCache: true, stale: true, cachedAt: cache.updatedAt });
    res.status(502).json({ ok: false, message: err.message });
  }
});

// Forzar refresco completo
app.post("/napi/onts/:oltIndex/refresh", async (req, res) => {
  const oltIndex = req.params.oltIndex;
  try {
    const data = await readAllPons(oltIndex);
    ontsCache[oltIndex] = { data, updatedAt: new Date().toISOString(), refreshing: false };
    saveCache();
    res.json(data);
  } catch (err) {
    res.status(502).json({ ok: false, message: err.message });
  }
});

// ─── NUEVO: Resync de una sola ONT ───
app.get("/napi/onu/:oltIndex/:pon/:ont/state", async (req, res) => {
  try {
    const { oltIndex, pon, ont } = req.params;
    const state = await getSingleOntState(oltIndex, Number(pon), Number(ont));
    // Actualizar en caché
    const cache = ontsCache[oltIndex];
    if (cache && cache.data) {
      for (const p of cache.data.pons) {
        if (p.pon === Number(pon)) {
          const o = p.onts.find(x => x.ont === Number(ont));
          if (o) {
            o.status  = state.status;
            o.rxPower = state.rxPower;
          }
        }
      }
      saveCache();
    }
    res.json({ ok: true, ...state });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

// Potencia individual
app.get("/napi/onu/:oltIndex/:pon/:ont/power", async (req, res) => {
  try {
    const { oltIndex, pon, ont } = req.params;
    const rxPower = await getOntPower(oltIndex, Number(pon), Number(ont));
    const cache = ontsCache[oltIndex];
    if (cache && cache.data) {
      for (const p of cache.data.pons) {
        if (p.pon === Number(pon)) {
          const o = p.onts.find(x => x.ont === Number(ont));
          if (o) o.rxPower = rxPower;
        }
      }
      saveCache();
    }
    res.json({ ok: true, rxPower, updatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

// VLANs
app.get("/napi/vlans/:oltIndex", async (req, res) => {
  try { res.json({ ok: true, vlans: await readVlans(req.params.oltIndex) }); }
  catch (err) { res.status(502).json({ ok: false, message: err.message }); }
});

app.post("/napi/vlan/create", async (req, res) => {
  try {
    const { oltIndex, vlanId, vlanName } = req.body;
    await createVlan(oltIndex, vlanId, vlanName);
    addEvent("success", `VLAN ${vlanId} (${vlanName}) creada`);
    res.json({ ok: true, message: "VLAN creada" });
  } catch (err) { res.status(400).json({ ok: false, message: err.message }); }
});

// Actualizar cliente
app.post("/napi/onu/update", async (req, res) => {
  try {
    const { serial, name, cedula, direccion, marquilla, telefono, vlan, notas } = req.body;
    customers[serial] = { name, cedula, direccion, marquilla, telefono, vlan, notas: notas || "", updatedAt: new Date().toISOString() };
    saveCustomers();
    for (const key of Object.keys(ontsCache)) {
      const cache = ontsCache[key];
      if (cache && cache.data) {
        for (const p of cache.data.pons) {
          for (const o of p.onts) {
            if (o.serial === serial) Object.assign(o, { name, cedula, direccion, marquilla, telefono, vlan, notas });
          }
        }
      }
    }
    saveCache();
    res.json({ ok: true, message: "Cliente actualizado" });
  } catch (err) { res.status(400).json({ ok: false, message: err.message }); }
});

// Autorizar
app.post("/napi/onu/authorize", async (req, res) => {
  try {
    const { oltIndex, pon, ont, serial, name } = req.body;
    const result = await authorizeOnt(oltIndex, pon, ont, serial, name);
    if (!customers[serial]) {
      customers[serial] = { name, cedula: "", direccion: "", marquilla: "", telefono: "", vlan: "", notas: "", updatedAt: new Date().toISOString() };
    }
    saveCustomers();
    addEvent("success", `ONT autorizada: ${serial} PON${pon}:${ont} — ${name}`);
    res.json({ ok: true, message: result });
  } catch (err) { res.status(400).json({ ok: false, message: err.message }); }
});

app.post("/napi/onu/authorize/full", async (req, res) => {
  try {
    const { oltIndex, pon, ont, serial, name, cedula, direccion, marquilla, telefono, vlan, notas } = req.body;
    const result = await authorizeOnt(oltIndex, pon, ont, serial, name);
    customers[serial] = { name, cedula, direccion, marquilla, telefono, vlan, notas: notas || "", updatedAt: new Date().toISOString() };
    saveCustomers();
    addEvent("success", `ONT autorizada (completo): ${serial} PON${pon}:${ont} — ${name}`);
    res.json({ ok: true, message: result });
  } catch (err) { res.status(400).json({ ok: false, message: err.message }); }
});

// Tráfico, IP
app.get("/napi/onu/:oltIndex/:pon/:ont/traffic", async (req, res) => {
  try { res.json({ ok: true, traffic: await getTraffic(req.params.oltIndex, req.params.pon, req.params.ont) }); }
  catch (err) { res.status(400).json({ ok: false, message: err.message }); }
});

app.get("/napi/onu/:oltIndex/:pon/:ont/ip", async (req, res) => {
  try { res.json({ ok: true, ip: await getOnuIP(req.params.oltIndex, req.params.pon, req.params.ont) }); }
  catch (err) { res.status(400).json({ ok: false, message: "No disponible" }); }
});

// Reiniciar / Borrar — con invalidación de caché de la ONT afectada
app.post("/napi/onu/restart", async (req, res) => {
  try {
    const { oltIndex, pon, ont } = req.body;
    const msg = await restartOnu(oltIndex, pon, ont);
    // Marcar esa ONT como "restarting" en caché
    const cache = ontsCache[oltIndex];
    if (cache && cache.data) {
      for (const p of cache.data.pons) {
        if (p.pon === Number(pon)) {
          const o = p.onts.find(x => x.ont === Number(ont));
          if (o) o.status = "restarting";
        }
      }
      saveCache();
    }
    addEvent("warning", `ONT reiniciada: PON${pon}:${ont} (OLT ${oltIndex})`);
    res.json({ ok: true, message: msg });
  } catch (err) { res.status(400).json({ ok: false, message: err.message }); }
});

app.post("/napi/onu/delete", async (req, res) => {
  try {
    const { oltIndex, pon, ont } = req.body;
    const msg = await deleteOnu(oltIndex, pon, ont);
    // Remover de caché
    const cache = ontsCache[oltIndex];
    if (cache && cache.data) {
      for (const p of cache.data.pons) {
        if (p.pon === Number(pon)) {
          p.onts = p.onts.filter(x => x.ont !== Number(ont));
          p.count = p.onts.length;
        }
      }
      saveCache();
    }
    addEvent("danger", `ONT eliminada: PON${pon}:${ont} (OLT ${oltIndex})`);
    res.json({ ok: true, message: msg });
  } catch (err) { res.status(400).json({ ok: false, message: err.message }); }
});

app.post("/napi/pon/restart", async (req, res) => {
  try {
    const { oltIndex, pon } = req.body;
    const msg = await restartPon(oltIndex, pon);
    addEvent("warning", `PON ${pon} reiniciado (OLT ${oltIndex})`);
    res.json({ ok: true, message: msg });
  } catch (err) { res.status(400).json({ ok: false, message: err.message }); }
});

// Mover
app.post("/napi/onu/move", async (req, res) => {
  try {
    const { oltIndex, fromPon, ont, toPon, serial } = req.body;
    const result = await moveOnu(oltIndex, fromPon, ont, toPon, serial);
    if (serial) {
      movesQueue = movesQueue.filter(m => !(m.serial === serial && m.oltIndex == oltIndex));
      saveMoves();
    }
    addEvent("info", `ONT movida: PON${fromPon}:${ont} → PON${toPon} (OLT ${oltIndex})`);
    res.json({ ok: true, message: result });
  } catch (err) { res.status(400).json({ ok: false, message: err.message }); }
});

// Historial de potencia
app.get("/napi/onu/:serial/history", (req, res) => {
  res.json({ ok: true, history: powerHistory[req.params.serial] || [] });
});

app.post("/napi/onu/:serial/history/add", (req, res) => {
  const { serial } = req.params;
  const { power, consumption } = req.body;
  if (!powerHistory[serial]) powerHistory[serial] = [];
  powerHistory[serial].push({ timestamp: new Date().toISOString(), power, consumption });
  if (powerHistory[serial].length > 100) powerHistory[serial].shift();
  savePowerHistory();
  res.json({ ok: true });
});

// ONTs sin autorizar
app.get("/napi/onu/unauthorized/:oltIndex", async (req, res) => {
  try { res.json({ ok: true, unauthorized: await getUnauthorizedOnts(req.params.oltIndex) }); }
  catch (err) { res.status(400).json({ ok: false, message: err.message }); }
});

// Bulk
app.post("/napi/onu/bulk-restart", async (req, res) => {
  try {
    const { oltIndex, actions } = req.body;
    for (const a of actions) await restartOnu(oltIndex, a.pon, a.ont);
    addEvent("warning", `Bulk restart: ${actions.length} ONTs reiniciadas (OLT ${oltIndex})`);
    res.json({ ok: true, message: `${actions.length} ONTs reiniciadas` });
  } catch (err) { res.status(400).json({ ok: false, message: err.message }); }
});

app.post("/napi/onu/bulk-delete", async (req, res) => {
  try {
    const { oltIndex, actions } = req.body;
    for (const a of actions) await deleteOnu(oltIndex, a.pon, a.ont);
    addEvent("danger", `Bulk delete: ${actions.length} ONTs eliminadas (OLT ${oltIndex})`);
    res.json({ ok: true, message: `${actions.length} ONTs eliminadas` });
  } catch (err) { res.status(400).json({ ok: false, message: err.message }); }
});

// Stats de PON
app.get("/napi/pon/:oltIndex/:pon/stats", async (req, res) => {
  try {
    const { oltIndex, pon } = req.params;
    const cache = ontsCache[oltIndex];
    let ponData;
    if (cache && cache.data) ponData = cache.data.pons.find(p => p.pon === Number(pon));
    if (!ponData) {
      const data = await readAllPons(oltIndex);
      ontsCache[oltIndex] = { data, updatedAt: new Date().toISOString(), refreshing: false };
      saveCache();
      ponData = data.pons.find(p => p.pon === Number(pon));
    }
    if (!ponData) throw new Error("PON no encontrado");
    const stats = {
      totalOnts:    ponData.count,
      onlineOnts:   ponData.onts.filter(o => o.status === "working").length,
      offlineOnts:  ponData.onts.filter(o => o.status !== "working").length,
      avgPower:     ponData.onts.length > 0
        ? (ponData.onts.reduce((a, o) => a + (o.rxPower || 0), 0) / ponData.onts.length).toFixed(1) : 0,
      criticalOnts: ponData.onts.filter(o => o.rxPower != null && Math.abs(o.rxPower) >= 27).length,
      onts: ponData.onts
    };
    res.json({ ok: true, stats });
  } catch (err) { res.status(400).json({ ok: false, message: err.message }); }
});

// Eventos — ahora con log real
app.get("/napi/system/events/:oltIndex", (req, res) => {
  const idx   = req.params.oltIndex;
  const items = eventsLog
    .filter(e => e.oltIndex === null || String(e.oltIndex) === String(idx))
    .slice(-50)
    .reverse();
  res.json({ ok: true, events: items });
});

// ═══════════════════════════════════════════════
// COLA DE MOVIMIENTOS (Por Mover)
// ═══════════════════════════════════════════════

app.get("/napi/moves", (req, res) => {
  const enriched = movesQueue.map(m => ({ ...m, customer: customers[m.serial] || null }));
  res.json({ ok: true, moves: enriched });
});

app.post("/napi/moves/add", (req, res) => {
  const { oltIndex, serial, fromPon, fromOnt, toPon, name } = req.body;
  const exists = movesQueue.find(m => m.serial === serial && m.oltIndex == oltIndex);
  if (exists) {
    exists.toPon   = toPon || exists.toPon;
    exists.fromPon = fromPon;
    exists.fromOnt = fromOnt;
    saveMoves();
    return res.json({ ok: true, message: "Movimiento actualizado", id: exists.id });
  }
  const id = Date.now().toString();
  movesQueue.push({ id, oltIndex, serial, fromPon, fromOnt, toPon: toPon || null, name: name || "", addedAt: new Date().toISOString(), status: "pending" });
  saveMoves();
  res.json({ ok: true, message: "Agregado a cola", id });
});

app.patch("/api/moves/:id", (req, res) => {
  const move = movesQueue.find(m => m.id === req.params.id);
  if (!move) return res.status(404).json({ ok: false, message: "No encontrado" });
  if (req.body.toPon   != null) move.toPon   = req.body.toPon;
  if (req.body.fromPon != null) move.fromPon = req.body.fromPon;
  if (req.body.fromOnt != null) move.fromOnt = req.body.fromOnt;
  saveMoves();
  res.json({ ok: true, message: "Actualizado" });
});

app.delete("/napi/moves/:id", (req, res) => {
  movesQueue = movesQueue.filter(m => m.id !== req.params.id);
  saveMoves();
  res.json({ ok: true, message: "Eliminado de cola" });
});

app.post("/napi/moves/:id/execute", async (req, res) => {
  const move = movesQueue.find(m => m.id === req.params.id);
  if (!move) return res.status(404).json({ ok: false, message: "No encontrado" });
  if (!move.toPon) return res.status(400).json({ ok: false, message: "Falta PON destino" });

  try {
    move.status = "executing";
    const result = await moveOnu(move.oltIndex, move.fromPon, move.fromOnt, move.toPon);
    movesQueue = movesQueue.filter(m => m.id !== move.id);
    saveMoves();
    if (ontsCache[move.oltIndex]) ontsCache[move.oltIndex].updatedAt = new Date(0).toISOString();
    saveCache();
    addEvent("info", `Movimiento ejecutado: ${move.serial} PON${move.fromPon}→PON${move.toPon}`);
    res.json({ ok: true, message: result });
  } catch (err) {
    move.status = "pending";
    res.status(400).json({ ok: false, message: err.message });
  }
});

app.post("/napi/moves/execute-all", async (req, res) => {
  const pending = movesQueue.filter(m => m.toPon && m.oltIndex == (req.body.oltIndex ?? m.oltIndex));
  const results = [];
  for (const move of pending) {
    try {
      move.status = "executing";
      const msg = await moveOnu(move.oltIndex, move.fromPon, move.fromOnt, move.toPon);
      movesQueue = movesQueue.filter(m => m.id !== move.id);
      results.push({ serial: move.serial, ok: true, message: msg });
    } catch (e) {
      move.status = "pending";
      results.push({ serial: move.serial, ok: false, message: e.message });
    }
  }
  saveMoves();
  if (ontsCache[req.body.oltIndex]) ontsCache[req.body.oltIndex].updatedAt = new Date(0).toISOString();
  saveCache();
  res.json({ ok: true, results });
});

// Datos de cliente
app.get("/napi/customer/:serial", (req, res) => {
  const data = customers[req.params.serial];
  if (data) res.json({ ok: true, found: true, customer: data });
  else       res.json({ ok: true, found: false });
});

// ═══════════════════════════════════════════════
// LÓGICA NMS
// ═══════════════════════════════════════════════

async function readAllPons(oltIndex) {
  const olt = olts[oltIndex];
  if (!olt) throw new Error("OLT no encontrado");
  const session = await openTelnet(olt);
  try {
    await enterEnable(session, olt);
    await execCmd(session, "terminal length 0", 3000);
    await execCmd(session, "configure terminal", 3000);
    const allOnts = [];
    for (let pon = 1; pon <= NUM_PONS; pon++) {
      try {
        await execCmd(session, `interface gpon 0/${pon}`, 4000);
        const stateOut = await execCmd(session, "show onu state all", 12000);
        const rxOut    = await execCmd(session, "show pon onu all rx-power", 12000);
        const onts     = parseOntState(stateOut, pon);
        const rxMap    = parseRxPower(rxOut);
        for (const ont of onts) {
          ont.rxPower = rxMap.get(ont.ont) ?? null;
          const c = customers[ont.serial];
          if (c) Object.assign(ont, { name: c.name, cedula: c.cedula, direccion: c.direccion, marquilla: c.marquilla, telefono: c.telefono, vlan: c.vlan, notas: c.notas || "" });
          else   Object.assign(ont, { name: "", cedula: "", direccion: "", marquilla: "", telefono: "", vlan: "", notas: "" });
          const inQueue = movesQueue.find(m => m.serial === ont.serial && String(m.oltIndex) === String(oltIndex));
          ont.pendingMove = inQueue ? { toPon: inQueue.toPon, queueId: inQueue.id } : null;
        }
        allOnts.push(...onts);
        await execCmd(session, "exit", 2000);
      } catch (e) { try { await execCmd(session, "exit", 1000); } catch (_) {} }
    }
    return { ok: true, host: olt.host, updatedAt: new Date().toISOString(), totalOnts: allOnts.length, totalWorking: allOnts.filter(o => o.status === "working").length, pons: buildPonList(allOnts) };
  } finally { session.close(); }
}

// ─── NUEVO: Estado de una sola ONT ───
async function getSingleOntState(oltIndex, pon, ont) {
  const olt = olts[oltIndex];
  if (!olt) throw new Error("OLT no encontrado");
  const session = await openTelnet(olt);
  try {
    await enterEnable(session, olt);
    await execCmd(session, "configure terminal", 3000);
    await execCmd(session, `interface gpon 0/${pon}`, 4000);
    const stateOut = await execCmd(session, "show onu state all", 12000);
    const rxOut    = await execCmd(session, "show pon onu all rx-power", 12000);
    await execCmd(session, "exit", 2000);

    const onts  = parseOntState(stateOut, pon);
    const rxMap = parseRxPower(rxOut);
    const found = onts.find(o => o.ont === Number(ont));
    if (!found) throw new Error(`ONT ${ont} no encontrada en PON ${pon}`);
    found.rxPower = rxMap.get(Number(ont)) ?? null;
    return { status: found.status, rxPower: found.rxPower, serial: found.serial, updatedAt: new Date().toISOString() };
  } finally { session.close(); }
}

// ─── NUEVO: Salud del OLT (CPU, Mem, Uptime, Versión) ───
async function getOltHealth(oltIndex) {
  const olt = olts[oltIndex];
  if (!olt) throw new Error("OLT no encontrado");
  const session = await openTelnet(olt);
  try {
    await enterEnable(session, olt);

    // Versión / Uptime
    const verOut  = await execCmd(session, "show version", 8000);
    // CPU
    const cpuOut  = await execCmd(session, "show system cpu", 5000);
    // Memoria
    const memOut  = await execCmd(session, "show system memory", 5000);
    // Temperatura (si existe)
    let tempOut = "";
    try { tempOut = await execCmd(session, "show system temperature", 5000); } catch (_) {}

    return {
      version:     parseVersion(verOut),
      uptime:      parseUptime(verOut),
      cpu:         parseCpu(cpuOut),
      memory:      parseMemory(memOut),
      temperature: parseTemperature(tempOut),
      rawVersion:  verOut.substring(0, 800),
      updatedAt:   new Date().toISOString()
    };
  } finally { session.close(); }
}

async function getOntPower(oltIndex, pon, ont) {
  const olt = olts[oltIndex];
  if (!olt) throw new Error("OLT no encontrado");
  const session = await openTelnet(olt);
  try {
    await enterEnable(session, olt);
    await execCmd(session, "configure terminal", 3000);
    await execCmd(session, `interface gpon 0/${pon}`, 4000);
    const rxOut = await execCmd(session, "show pon onu all rx-power", 12000);
    const rxMap = parseRxPower(rxOut);
    await execCmd(session, "exit", 2000);
    return rxMap.get(Number(ont)) ?? null;
  } finally { session.close(); }
}

async function readVlans(oltIndex) {
  const olt = olts[oltIndex];
  if (!olt) throw new Error("OLT no encontrado");
  const session = await openTelnet(olt);
  try { await enterEnable(session, olt); return parseVlans(await execCmd(session, "show vlan", 12000)); }
  finally { session.close(); }
}

async function createVlan(oltIndex, vlanId, vlanName) {
  const olt = olts[oltIndex];
  if (!olt) throw new Error("OLT no encontrado");
  const session = await openTelnet(olt);
  try { await enterEnable(session, olt); await execCmd(session, "configure terminal", 3000); await execCmd(session, `vlan ${vlanId} name ${vlanName}`, 5000); }
  finally { session.close(); }
}

async function authorizeOnt(oltIndex, pon, ont, serial, name) {
  const olt = olts[oltIndex];
  if (!olt) throw new Error("OLT no encontrado");
  const session = await openTelnet(olt);
  try {
    await enterEnable(session, olt);
    await execCmd(session, "configure terminal", 3000);
    await execCmd(session, `interface gpon 0/${pon}`, 3000);
    let cmd = `onu add ${ont} sn ${serial}`;
    if (name) cmd += ` name ${name}`;
    return await execCmd(session, cmd, 5000);
  } finally { session.close(); }
}

async function getTraffic(oltIndex, pon, ont) {
  const olt = olts[oltIndex];
  if (!olt) throw new Error("OLT no encontrado");
  const session = await openTelnet(olt);
  try {
    await enterEnable(session, olt);
    await execCmd(session, "configure terminal", 3000);
    await execCmd(session, `interface gpon 0/${pon}`, 3000);
    const samples = [];
    for (let i = 0; i < 4; i++) {
      samples.push(parseTrafficStats(await execCmd(session, `show onu statistics ${ont}`, 5000)));
      if (i < 3) await new Promise(r => setTimeout(r, 5000));
    }
    const avgRx = samples.reduce((a, b) => a + (b.rx || 0), 0) / samples.length;
    const avgTx = samples.reduce((a, b) => a + (b.tx || 0), 0) / samples.length;
    return { samples, avgRx: avgRx.toFixed(2), avgTx: avgTx.toFixed(2), maxRx: Math.max(...samples.map(s => s.rx || 0)).toFixed(2), maxTx: Math.max(...samples.map(s => s.tx || 0)).toFixed(2) };
  } finally { session.close(); }
}

async function getOnuIP(oltIndex, pon, ont) {
  const olt = olts[oltIndex];
  if (!olt) throw new Error("OLT no encontrado");
  const session = await openTelnet(olt);
  try {
    await enterEnable(session, olt);
    await execCmd(session, "configure terminal", 3000);
    await execCmd(session, `interface gpon 0/${pon}`, 3000);
    const out = await execCmd(session, `show onu ip-host ${ont}`, 5000);
    const m   = out.match(/(\d+\.\d+\.\d+\.\d+)/);
    return m ? m[1] : "No disponible";
  } finally { session.close(); }
}

async function restartOnu(oltIndex, pon, ont) {
  const olt = olts[oltIndex];
  if (!olt) throw new Error("OLT no encontrado");
  const session = await openTelnet(olt);
  try {
    await enterEnable(session, olt);
    await execCmd(session, "configure terminal", 3000);
    await execCmd(session, `interface gpon 0/${pon}`, 3000);
    await execCmd(session, `onu ${ont} admin-state down`, 5000);
    await new Promise(r => setTimeout(r, 2000));
    await execCmd(session, `onu ${ont} admin-state up`, 5000);
    return "ONT reiniciada";
  } finally { session.close(); }
}

async function deleteOnu(oltIndex, pon, ont) {
  const olt = olts[oltIndex];
  if (!olt) throw new Error("OLT no encontrado");
  const session = await openTelnet(olt);
  try {
    await enterEnable(session, olt);
    await execCmd(session, "configure terminal", 3000);
    await execCmd(session, `interface gpon 0/${pon}`, 3000);
    await execCmd(session, `no onu ${ont}`, 5000);
    return "ONT eliminada";
  } finally { session.close(); }
}

async function restartPon(oltIndex, pon) {
  const olt = olts[oltIndex];
  if (!olt) throw new Error("OLT no encontrado");
  const session = await openTelnet(olt);
  try {
    await enterEnable(session, olt);
    await execCmd(session, "configure terminal", 3000);
    await execCmd(session, `interface gpon 0/${pon}`, 3000);
    await execCmd(session, "shutdown", 3000);
    await execCmd(session, "no shutdown", 5000);
    return "PON reiniciado";
  } finally { session.close(); }
}

async function moveOnu(oltIndex, fromPon, ont, toPon, serial) {
  const olt = olts[oltIndex];
  if (!olt) throw new Error("OLT no encontrado");
  const session = await openTelnet(olt);
  try {
    await enterEnable(session, olt);
    await execCmd(session, "configure terminal", 3000);

    let sn = serial;
    if (!sn) {
      const cache = ontsCache[oltIndex];
      if (cache && cache.data) {
        const ponData = cache.data.pons.find(p => p.pon === Number(fromPon));
        if (ponData) {
          const o = ponData.onts.find(x => x.ont === Number(ont));
          if (o) sn = o.serial;
        }
      }
      if (!sn) {
        await execCmd(session, `interface gpon 0/${fromPon}`, 3000);
        const stateOut = await execCmd(session, "show onu state all", 10000);
        await execCmd(session, "exit", 2000);
        const clean = stateOut.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g," ").replace(/\r/g,"");
        for (const line of clean.split("\n")) {
          const m = line.match(/GPON0\/\d+:(\d+)\s+\S+\s+\S+\s+\w+\s+(\w+)/i);
          if (m && Number(m[1]) === Number(ont)) { sn = m[2]; break; }
        }
      }
      if (!sn) throw new Error(`No se pudo obtener el serial de la ONT ${ont} en PON ${fromPon}`);
    }

    const customerName = customers[sn] ? (customers[sn].name || "") : "";

    await execCmd(session, `interface gpon 0/${fromPon}`, 3000);
    await execCmd(session, `no onu ${ont}`, 5000);
    await execCmd(session, "exit", 2000);

    await execCmd(session, `interface gpon 0/${toPon}`, 3000);
    const destOnts = await execCmd(session, "show onu state all", 10000);
    const usedIds = new Set();
    const cleanDest = destOnts.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g," ").replace(/\r/g,"");
    for (const line of cleanDest.split("\n")) {
      const m = line.match(/GPON0\/\d+:(\d+)/i);
      if (m) usedIds.add(Number(m[1]));
    }
    let newOntId = Number(ont);
    if (usedIds.has(newOntId)) {
      newOntId = 1;
      while (usedIds.has(newOntId)) newOntId++;
    }
    let cmd = `onu add ${newOntId} sn ${sn}`;
    if (customerName) cmd += ` name ${customerName}`;
    await execCmd(session, cmd, 5000);
    await execCmd(session, "exit", 2000);

    return `ONT ${sn} movida de PON ${fromPon}:${ont} → PON ${toPon}:${newOntId}`;
  } finally { session.close(); }
}

async function getUnauthorizedOnts(oltIndex) {
  const olt = olts[oltIndex];
  if (!olt) throw new Error("OLT no encontrado");
  const session = await openTelnet(olt);
  try {
    await enterEnable(session, olt);
    await execCmd(session, "terminal length 0", 3000);
    await execCmd(session, "configure terminal", 3000);
    const unauthorized = [];
    for (let pon = 1; pon <= NUM_PONS; pon++) {
      try {
        await execCmd(session, `interface gpon 0/${pon}`, 3000);
        unauthorized.push(...parseAutoFind(await execCmd(session, "show onu auto-find", 8000), pon));
        await execCmd(session, "exit", 2000);
      } catch (e) { try { await execCmd(session, "exit", 1000); } catch (_) {} }
    }
    return unauthorized;
  } finally { session.close(); }
}

// ── Parsers ──
function parseOntState(output, pon) {
  const onts = [];
  const clean = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, " ").replace(/\[\d+[A-Z]/g, " ").replace(/\r/g, "");
  for (const line of clean.split("\n")) {
    const m = line.match(/GPON0\/(\d+):(\d+)\s+(enable|disable)\s+(enable|disable)\s+(\w+)\s+(\w+)/i);
    if (m && Number(m[1]) === pon) onts.push({ pon, ont: Number(m[2]), serial: m[6], status: m[5].toLowerCase() });
  }
  return onts;
}

function parseRxPower(output) {
  const map   = new Map();
  const clean = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, " ").replace(/\[\d+[A-Z]/g, " ").replace(/\r/g, "");
  for (const line of clean.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(-?\d+(?:\.\d+)?|N\/A)\s*$/i);
    if (m) map.set(Number(m[1]), m[2].toUpperCase() === "N/A" ? null : Number(m[2]));
  }
  return map;
}

function parseVlans(output) {
  const vlans  = [];
  const blocks = output.split("Vlan ID");
  for (const block of blocks) {
    const idM   = block.match(/:\s*(\d+)/);
    const nameM = block.match(/Name\s*:\s*(\S+)/);
    if (!idM) continue;
    vlans.push({ id: Number(idM[1]), name: nameM ? nameM[1] : `VLAN${idM[1]}` });
  }
  return vlans;
}

function parseTrafficStats(output) {
  const rx = (Number((output.match(/RX.*?(\d+)/i) || [0, 0])[1]) / 1000000).toFixed(2);
  const tx = (Number((output.match(/TX.*?(\d+)/i) || [0, 0])[1]) / 1000000).toFixed(2);
  return { rx: Number(rx), tx: Number(tx) };
}

function buildPonList(allOnts) {
  return Array.from({ length: NUM_PONS }, (_, i) => {
    const pon   = i + 1;
    const items = allOnts.filter(o => o.pon === pon);
    return { pon, count: items.length, onts: items };
  });
}

function parseAutoFind(output, pon) {
  const onts  = [];
  const clean = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, " ").replace(/\[\d+[A-Z]/g, " ").replace(/\r/g, "");
  for (const line of clean.split("\n")) {
    const m = line.match(/GPON0\/(\d+):(\d+)\s+(\w+)/i);
    if (m && Number(m[1]) === pon) onts.push({ pon, ont: Number(m[2]), serial: m[3] });
  }
  return onts;
}

// ─── Parsers de salud OLT ───
function parseVersion(output) {
  const clean = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, " ").replace(/\r/g, "");
  const mVer  = clean.match(/[Ss]oftware\s+[Vv]ersion\s*[:\s]+(\S+)/i)
             || clean.match(/[Vv]ersion\s*[:\s]+(\S+)/i)
             || clean.match(/V\d+\.\d+[\w.-]*/);
  return mVer ? mVer[1] || mVer[0] : "N/A";
}

function parseUptime(output) {
  const clean = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, " ").replace(/\r/g, "");
  const mUp   = clean.match(/[Uu]ptime\s*[:\s]+([^\n]+)/i)
             || clean.match(/[Ss]ystem\s+[Uu]p\s+[Tt]ime\s*[:\s]+([^\n]+)/i)
             || clean.match(/(\d+\s*days?\s*\d+\s*hours?[^\n]*)/i)
             || clean.match(/(\d+h\s*\d+m[^\n]*)/i);
  return mUp ? (mUp[1] || mUp[0]).trim().substring(0, 60) : "N/A";
}

function parseCpu(output) {
  const clean = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, " ").replace(/\r/g, "");
  // Buscar patrones: "CPU: 35%", "CPU Usage: 35%", "cpu 5sec: 35%"
  const mCpu  = clean.match(/(?:cpu\s*(?:usage|util(?:ization)?)?\s*[:\s]+)(\d+(?:\.\d+)?)\s*%/i)
             || clean.match(/(\d+(?:\.\d+)?)\s*%\s*(?:cpu|idle)/i)
             || clean.match(/5\s*sec\s*avg\s*[:\s]+(\d+(?:\.\d+)?)\s*%/i)
             || clean.match(/util\w*\s*[:\s]+(\d+(?:\.\d+)?)\s*%/i);
  if (mCpu) {
    const val = parseFloat(mCpu[1]);
    return { percent: val, raw: clean.substring(0, 300) };
  }
  // Intentar extraer cualquier porcentaje del output
  const any = clean.match(/(\d+(?:\.\d+)?)\s*%/);
  return { percent: any ? parseFloat(any[1]) : null, raw: clean.substring(0, 300) };
}

function parseMemory(output) {
  const clean = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, " ").replace(/\r/g, "");
  // Total / Used / Free en KB o MB
  const mTotal = clean.match(/[Tt]otal\s*[:\s]+(\d+)\s*(KB|MB|kB|Mb)?/i);
  const mUsed  = clean.match(/[Uu]sed\s*[:\s]+(\d+)\s*(KB|MB|kB|Mb)?/i);
  const mFree  = clean.match(/[Ff]ree\s*[:\s]+(\d+)\s*(KB|MB|kB|Mb)?/i);
  const total  = mTotal ? Number(mTotal[1]) : null;
  const used   = mUsed  ? Number(mUsed[1])  : null;
  const free   = mFree  ? Number(mFree[1])  : null;
  const pct    = (total && used) ? Math.round(used / total * 100) : null;
  return { total, used, free, percent: pct, raw: clean.substring(0, 300) };
}

function parseTemperature(output) {
  if (!output) return { celsius: null, raw: "" };
  const clean = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, " ").replace(/\r/g, "");
  const mTemp = clean.match(/(\d+(?:\.\d+)?)\s*°?\s*C/i)
             || clean.match(/[Tt]emp(?:erature)?\s*[:\s]+(\d+(?:\.\d+)?)/i);
  return { celsius: mTemp ? parseFloat(mTemp[1]) : null, raw: clean.substring(0, 200) };
}

// ── Telnet ──
async function enterEnable(session, olt) {
  if (session.prompt === "#") return;
  const out = await execCmd(session, "enable", 4000, true);
  if (/password:\s*$/i.test(out)) {
    const r = await session.sendRaw(olt.enablePass + "\r\n", /[#>]\s*$/, 5000);
    session.capturePrompt(r);
  }
}

async function execCmd(session, cmd, timeout, allowPwd = false) { return session.exec(cmd, timeout, allowPwd); }

function openTelnet(olt) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: olt.host, port: olt.port, timeout: 20000 });
    const sess   = makeTelnetSession(socket);

    function fail(err) {
      try { socket.destroy(); } catch (_) {}
      reject(err);
    }

    socket.on("connect", () => {
      sess.waitFor(/login:\s*$/i, 20000)
        .then(() => sess.write(olt.username + "\r\n"))
        .then(() => sess.waitFor(/password:\s*$/i, 20000))
        .then(() => sess.write(olt.password + "\r\n"))
        .then(() => sess.waitFor(/[>#]\s*$/, 20000))
        .then(buf  => { sess.capturePrompt(buf); resolve(sess); })
        .catch(fail);
    });
    socket.on("error", fail);
    socket.on("timeout", () => fail(new Error("Telnet connection timeout")));
  });
}

function makeTelnetSession(socket) {
  let buf = "", waiters = [];
  socket.on("data", data => {
    buf += data.toString();
    if (/--\s*[Mm]ore\s*--/.test(buf)) socket.write(" ");
    for (const w of [...waiters]) {
      if (w.pattern.test(buf)) { clearTimeout(w.timer); waiters = waiters.filter(x => x !== w); w.resolve(buf); }
    }
  });
  return {
    prompt: ">",
    write(text) { socket.write(text); },
    waitFor(pattern, timeout) {
      return new Promise((resolve, reject) => {
        const w = { pattern, resolve, reject, timer: setTimeout(() => { waiters = waiters.filter(x => x !== w); reject(new Error("Timeout")); }, timeout) };
        waiters.push(w);
      });
    },
    async exec(cmd, timeout, allowPwd = false) {
      buf = "";
      socket.write(cmd + "\r\n");
      const out = await this.waitFor(allowPwd ? /(password:\s*$|[>#]\s*$)/i : /[>#]\s*$/, timeout);
      this.capturePrompt(out);
      return out.replace(cmd, "").replace(/\r/g, "").trim();
    },
    async sendRaw(text, pattern, timeout) { buf = ""; socket.write(text); return await this.waitFor(pattern, timeout); },
    capturePrompt(text) { const m = text.match(/([>#])\s*$/); if (m) this.prompt = m[1]; },
    close() { socket.end(); socket.destroy(); }
  };
}

app.listen(PORT, () => console.log(`ConectaQ OLT NMS v10 en puerto ${PORT}`));
