const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose();
const { Server: SocketIOServer } = require('socket.io');

dotenv.config();

const PORT = Number(process.env.PORT || 8400);
const HOST = process.env.HOST || '127.0.0.1';
const DB_FILE = path.resolve(
  process.env.DB_FILE || path.join(__dirname, 'data', 'qlog-pro.sqlite3')
);
const OFFICE_ACCESS_CODE = String(process.env.OFFICE_ACCESS_CODE || '').trim();
const REPORT_ADMIN_PASSWORD = String(process.env.REPORT_ADMIN_PASSWORD || '').trim();
const CORS_ORIGIN = String(
  process.env.CORS_ORIGIN ||
  'https://qlogproult.mdmsportal.uk,https://qlog-api.mdmsportal.uk'
).trim();
const PUBLIC_API_URL = String(
  process.env.PUBLIC_API_URL || 'https://qlog-api.mdmsportal.uk'
).trim();

const DATASETS = [
  'people', 'logs', 'books', 'borrowLogs', 'reservations',
  'auditLogs', 'equipment', 'equipLogs', 'configData',
  'dynamicFilterData', 'borrowPolicies'
];
const ARRAY_DATASETS = new Set([
  'people', 'logs', 'books', 'borrowLogs', 'reservations',
  'auditLogs', 'equipment', 'equipLogs'
]);
const GLOBAL_DATASETS = new Set(['people', 'books', 'equipment']);

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new sqlite3.Database(DB_FILE);
db.configure('busyTimeout', 10000);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}
function exec(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, err => (err ? reject(err) : resolve()));
  });
}
function nowIso() { return new Date().toISOString(); }
async function getCentralResetGeneration(){
  const row=await get('SELECT meta_value FROM system_meta WHERE meta_key=?',['central_reset_generation']);
  const n=Number(row && row.meta_value);
  return Number.isFinite(n) && n>=0 ? n : 0;
}
async function bumpCentralResetGeneration(){
  const next=(await getCentralResetGeneration())+1;
  await run(
    `INSERT INTO system_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value`,
    ['central_reset_generation',String(next)]
  );
  return next;
}
function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('hex'); }
function tokenHash(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }
function safeJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function clampText(v, max = 500) { const s = v == null ? '' : String(v); return s.length > max ? s.slice(0, max) : s; }
function norm(v) { return clampText(v, 240).trim().replace(/\s+/g, ' '); }
function stableNormalize(value) {
  if (Array.isArray(value)) return value.map(stableNormalize);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).sort().forEach(k => {
      if (!['_qlogCentral','_qlogServer','updatedAt','serverRevision'].includes(k)) {
        out[k] = stableNormalize(value[k]);
      }
    });
    return out;
  }
  return value;
}
function contentHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableNormalize(value))).digest('hex');
}
function identityValue(obj, keys) {
  const o = obj || {};
  for (const key of keys) {
    const value = o[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim().toLowerCase();
    }
  }
  return '';
}
function quantityValue(obj) {
  const o = obj || {};
  const keys = ['qty','quantity','copies','copyCount','stock','count'];
  for (const key of keys) {
    const value = o[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      const n = Number(value);
      return Number.isFinite(n) ? String(n) : String(value).trim().toLowerCase();
    }
  }
  return '';
}

/*
 * School-wide canonical identity.
 * These identities deliberately do NOT contain office/profile information.
 * That is what prevents the same imported school inventory from multiplying
 * Central counts when another office receives the same inventory file.
 */
function globalIdentityKey(dataset, obj) {
  const o = obj || {};
  let source;

  if (dataset === 'people') {
    const unique = identityValue(o, [
      'id','employeeId','employeeID','learnerId','learnerID','studentId','studentID','clientId','clientID'
    ]);
    source = unique
      ? { type: 'people-unique', value: unique }
      : {
          type: 'people-fallback',
          name: String(o.name || o.fullName || '').trim().toLowerCase(),
          grade: String(o.grade || o.gradeLevel || '').trim().toLowerCase(),
          section: String(o.section || '').trim().toLowerCase(),
          category: String(o.category || o.type || '').trim().toLowerCase()
        };
  } else if (dataset === 'books') {
    const unique = identityValue(o, [
      'id','bookId','bookID','productId','productID','inventoryId','itemId','itemID',
      'accessionNo','accession','barcode','barCode','qrCode','isbn','ISBN'
    ]);
    source = unique
      ? { type: 'books-unique', value: unique }
      : {
          type: 'books-fallback',
          title: String(o.title || o.bookTitle || o.name || '').trim().toLowerCase(),
          author: String(o.author || '').trim().toLowerCase(),
          category: String(o.category || '').trim().toLowerCase()
        };
  } else if (dataset === 'equipment') {
    const unique = identityValue(o, [
      'id','equipmentId','equipmentID','eqId','productId','productID','inventoryId','itemId','itemID',
      'assetNo','asset','propertyNo','propertyID','serialNo','serial','barcode','barCode','qrCode','code'
    ]);
    source = unique
      ? { type: 'equipment-unique', value: unique }
      : {
          type: 'equipment-fallback',
          name: String(o.name || o.eqName || o.title || '').trim().toLowerCase(),
          category: String(o.category || o.type || '').trim().toLowerCase(),
          manufacturer: String(o.manufacturer || '').trim().toLowerCase(),
          model: String(o.model || '').trim().toLowerCase()
        };
  } else {
    source = stableNormalize(o);
  }

  return crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex');
}
function profileKey(facility, inCharge) {
  const s = `${String(facility || '').trim().toLowerCase()}|${String(inCharge || '').trim().toLowerCase()}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16);
}
function recordFingerprint(dataset, obj) {
  return globalIdentityKey(dataset, obj);
}

function inventoryNaturalKey(dataset, obj) {
  const o = obj || {};
  if (dataset === 'books') return norm(o.id || o.bookId || o.bookID || o.isbn || o.ISBN || o.barcode || o.qrCode || o.title || o.bookTitle || o.name);
  if (dataset === 'equipment') return norm(o.id || o.equipmentId || o.equipmentID || o.eqId || o.assetNo || o.asset || o.propertyNo || o.serialNo || o.barcode || o.qrCode || o.name || o.eqName || o.title);
  return '';
}

function activeBorrowedQty(status) {
  const s = String(status || '').trim().toUpperCase();
  return (s === 'BORROWED' || s === 'OVERDUE') ? 1 : 0;
}

function normalizeInventoryNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function loadCentralInventoryCard(dataset, limit) {
  const inventory = await all(`
    SELECT profile_key,record_key,record_json,content_hash,updated_at,revision,facility,in_charge,fingerprint
    FROM profile_records
    WHERE dataset=? AND deleted_at IS NULL
    ORDER BY updated_at DESC, revision DESC
    LIMIT ?`, [dataset, limit]);

  // The same inventory identity is canonical only inside the same
  // In-Charge + Office profile. This prevents one office's edit from
  // replacing another office's record in Central.
  const latestByProfileIdentity = new Map();
  for (const row of inventory) {
    const obj = safeJson(row.record_json, {});
    const fp = row.fingerprint || recordFingerprint(dataset, obj);
    const key = row.profile_key + '|' + fp;
    if (!latestByProfileIdentity.has(key)) latestByProfileIdentity.set(key, row);
  }

  const selected = Array.from(latestByProfileIdentity.values());
  const profiles = Array.from(new Set(selected.map(r => r.profile_key)));
  const availability = new Map();

  if (profiles.length) {
    const placeholders = profiles.map(() => '?').join(',');
    const logDataset = dataset === 'books' ? 'borrowLogs' : 'equipLogs';
    const logs = await all(`
      SELECT profile_key,record_json
      FROM profile_records
      WHERE dataset=? AND deleted_at IS NULL AND profile_key IN (${placeholders})`,
      [logDataset, ...profiles]);

    for (const row of logs) {
      const log = safeJson(row.record_json, {});
      const qty = Math.max(1, normalizeInventoryNumber(log.qty, 1));
      if (dataset === 'books') {
        const bookKeys = [log.b, log.isbn, log.bookId, log.id].map(norm).filter(Boolean);
        if (activeBorrowedQty(log.s)) {
          bookKeys.forEach(k => {
            const key = row.profile_key + '|book|' + k;
            availability.set(key, (availability.get(key) || 0) + qty);
          });
        } else if (String(log.s || '').toUpperCase() === 'LOST' || String(log.s || '').toUpperCase() === 'DAMAGED') {
          bookKeys.forEach(k => {
            const lossKey = row.profile_key + '|book-loss|' + k;
            availability.set(lossKey, (availability.get(lossKey) || 0) + qty);
          });
        }
      } else {
        const eqKeys = [log.eqId, log.equipmentId, log.id, log.assetNo, log.qrCode].map(norm).filter(Boolean);
        if (activeBorrowedQty(log.s)) {
          eqKeys.forEach(k => {
            const key = row.profile_key + '|equipment|' + k;
            availability.set(key, (availability.get(key) || 0) + qty);
          });
        }
      }
    }
  }

  const rows = selected.map(row => {
    const obj = safeJson(row.record_json, {});
    const keys = dataset === 'books'
      ? [obj.id, obj.bookId, obj.bookID, obj.isbn, obj.ISBN, obj.barcode, obj.qrCode, obj.title, obj.bookTitle, obj.name].map(norm).filter(Boolean)
      : [obj.id, obj.equipmentId, obj.equipmentID, obj.eqId, obj.assetNo, obj.asset, obj.propertyNo, obj.serialNo, obj.barcode, obj.qrCode, obj.code, obj.name, obj.eqName, obj.title].map(norm).filter(Boolean);
    const total = Math.max(0, normalizeInventoryNumber(dataset === 'books' ? (obj.copies ?? obj.qty ?? obj.quantity) : (obj.qty ?? obj.quantity ?? obj.copies), 1));
    const borrowed = Math.max(0, ...keys.map(k => availability.get(row.profile_key + '|' + (dataset === 'books' ? 'book|' : 'equipment|') + k) || 0));
    const lost = dataset === 'books' ? Math.max(0, ...keys.map(k => availability.get(row.profile_key + '|book-loss|' + k) || 0)) : 0;
    const available = Math.max(0, total - borrowed - lost);

    obj.availableQty = available;
    obj.borrowedQty = borrowed;
    if (dataset === 'books') obj.lostQty = lost;

    return {
      identityKey: row.profile_key + '|' + (row.fingerprint || recordFingerprint(dataset, obj)),
      data: obj,
      contentHash: row.content_hash,
      updatedAt: row.updated_at,
      revision: row.revision,
      occurrences: 1,
      lastProfileKey: row.profile_key,
      lastFacility: row.facility,
      lastInCharge: row.in_charge,
      facility: row.facility,
      inCharge: row.in_charge
    };
  });

  return rows;
}

async function loadCentralRelatedLogs(dataset, limit) {
  const records = await all(`
    SELECT profile_key,record_key,record_json,record_date,record_name,updated_at,revision,facility,in_charge
    FROM profile_records
    WHERE dataset=? AND deleted_at IS NULL
    ORDER BY updated_at DESC, revision DESC
    LIMIT ?`, [dataset, limit]);
  return records.map(r => {
    const data = safeJson(r.record_json, {});
    return {
      identityKey: r.profile_key + '|' + r.record_key,
      data, updatedAt: r.updated_at, revision: r.revision,
      facility: r.facility, inCharge: r.in_charge, profileKey: r.profile_key,
      recordDate: r.record_date, recordName: r.record_name
    };
  });
}

function recordKey(dataset, obj, index = 0) {
  const o = obj || {};
  if (dataset === 'people' || dataset === 'books' || dataset === 'equipment') {
    return String(o.id || o.isbn || o.ISBN || o.assetNo || o.asset || o.ID || `${dataset}:${index}`);
  }
  if (dataset === 'logs') return [o.id || '', o.date || '', o.timein || '', o.category || '', o.name || ''].join('|');
  if (dataset === 'borrowLogs') return [o.l || '', o.b || '', o.borrowedAt || '', o.returnedAt || '', o.s || '', o.qty || ''].join('|');
  if (dataset === 'reservations') return [o.isbn || '', o.lId || o.learnerId || '', o.createdAt || o.reservedAt || '', o.status || ''].join('|');
  if (dataset === 'auditLogs') return [o.timestamp || '', o.action || '', o.details || ''].join('|');
  if (dataset === 'equipLogs') return String(o.ref || [o.eqId || '', o.borrowerId || '', o.borrowedMs || ''].join('|'));
  return dataset;
}
function metadataFor(dataset, obj) {
  const o = obj || {};
  let date = o.date || o.returnDate || '';
  if (o.borrowedAt && !date) date = String(o.borrowedAt).slice(0, 10);
  return {
    date: clampText(date, 80),
    name: clampText(o.name || o.learnerName || o.borrowerName || o.eqName || '', 240)
  };
}

async function initDb() {
  await exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;

    CREATE TABLE IF NOT EXISTS devices(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL UNIQUE,
      facility TEXT NOT NULL DEFAULT '',
      in_charge TEXT NOT NULL DEFAULT '',
      designation TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT '',
      profile_key TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      data_version INTEGER NOT NULL DEFAULT 0,
      sync_ready INTEGER NOT NULL DEFAULT 0,
      auth_generation INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS records(
      source_id TEXT NOT NULL,
      dataset TEXT NOT NULL,
      record_key TEXT NOT NULL,
      record_json TEXT NOT NULL,
      record_date TEXT NOT NULL DEFAULT '',
      record_name TEXT NOT NULL DEFAULT '',
      fingerprint TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT DEFAULT NULL,
      updated_by TEXT NOT NULL DEFAULT '',
      facility TEXT NOT NULL DEFAULT '',
      profile_key TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(source_id,dataset,record_key),
      FOREIGN KEY(source_id) REFERENCES devices(source_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sync_aliases(
      source_id TEXT NOT NULL,
      dataset TEXT NOT NULL,
      incoming_key TEXT NOT NULL,
      canonical_source_id TEXT NOT NULL,
      canonical_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY(source_id,dataset,incoming_key)
    );

    CREATE TABLE IF NOT EXISTS sync_cursors(
      source_id TEXT PRIMARY KEY,
      last_pulled_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
      FOREIGN KEY(source_id) REFERENCES devices(source_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sync_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS profile_assignments(
      profile_key TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL UNIQUE,
      in_charge TEXT NOT NULL,
      facility TEXT NOT NULL,
      designation TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      started_at TEXT NOT NULL,
      ended_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT DEFAULT NULL,
      replaced_by_profile_key TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS profile_records(
      profile_key TEXT NOT NULL,
      dataset TEXT NOT NULL,
      record_key TEXT NOT NULL,
      record_json TEXT NOT NULL,
      record_date TEXT NOT NULL DEFAULT '',
      record_name TEXT NOT NULL DEFAULT '',
      fingerprint TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT DEFAULT NULL,
      updated_by TEXT NOT NULL DEFAULT '',
      facility TEXT NOT NULL DEFAULT '',
      in_charge TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(profile_key,dataset,record_key)
    );

    CREATE TABLE IF NOT EXISTS profile_aliases(
      profile_key TEXT NOT NULL,
      dataset TEXT NOT NULL,
      incoming_key TEXT NOT NULL,
      canonical_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY(profile_key,dataset,incoming_key)
    );

    /* School-wide canonical registry for strong cross-office dedup. */
    CREATE TABLE IF NOT EXISTS central_registry(
      dataset TEXT NOT NULL,
      identity_key TEXT NOT NULL,
      record_json TEXT NOT NULL,
      content_hash TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      occurrences INTEGER NOT NULL DEFAULT 0,
      last_profile_key TEXT NOT NULL DEFAULT '',
      last_facility TEXT NOT NULL DEFAULT '',
      last_in_charge TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(dataset,identity_key)
    );

    CREATE TABLE IF NOT EXISTS system_meta(
      meta_key TEXT PRIMARY KEY,
      meta_value TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_records_dataset_date ON records(dataset,record_date);
    CREATE INDEX IF NOT EXISTS idx_records_dataset_fingerprint ON records(dataset,fingerprint);
    CREATE INDEX IF NOT EXISTS idx_records_source_updated ON records(source_id,updated_at);
    CREATE INDEX IF NOT EXISTS idx_profile_records_dataset ON profile_records(dataset,updated_at);
    CREATE INDEX IF NOT EXISTS idx_profile_records_fingerprint ON profile_records(profile_key,dataset,fingerprint);
    CREATE INDEX IF NOT EXISTS idx_profile_records_deleted ON profile_records(profile_key,dataset,deleted_at);
    CREATE INDEX IF NOT EXISTS idx_registry_dataset ON central_registry(dataset);
  `);

  for (const stmt of [
    "ALTER TABLE devices ADD COLUMN data_version INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE devices ADD COLUMN sync_ready INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE devices ADD COLUMN auth_generation INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE records ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE records ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE records ADD COLUMN deleted_at TEXT DEFAULT NULL",
    "ALTER TABLE records ADD COLUMN updated_by TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE records ADD COLUMN facility TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE devices ADD COLUMN profile_key TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE records ADD COLUMN profile_key TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE profile_records ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE central_registry ADD COLUMN identity_key TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE central_registry ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE central_registry ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE central_registry ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE central_registry ADD COLUMN occurrences INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE central_registry ADD COLUMN last_profile_key TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE central_registry ADD COLUMN last_facility TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE central_registry ADD COLUMN last_in_charge TEXT NOT NULL DEFAULT ''"
  ]) {
    try { await run(stmt); }
    catch (e) {
      if (!/duplicate column/i.test(e.message)) throw e;
    }
  }

  const devices = await all(
    "SELECT source_id,facility,in_charge,designation,role,profile_key FROM devices WHERE profile_key<>''"
  );
  for (const d of devices) {
    const exists = await get('SELECT profile_key FROM profile_assignments WHERE profile_key=?', [d.profile_key]);
    if (!exists) {
      const ts = nowIso();
      await run(
        `INSERT INTO profile_assignments(profile_key,assignment_id,in_charge,facility,designation,role,status,started_at,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [d.profile_key, `ASSIGN-${d.profile_key}`, d.in_charge || '', d.facility || '', d.designation || '', d.role || '', 'ACTIVE', ts, ts, ts]
      );
    }
  }

  /* Migrate legacy device-scoped records into profile scope where possible. */
  const legacy = await all(
    `SELECT profile_key,dataset,record_key,record_json,record_date,record_name,fingerprint,updated_at,revision,deleted_at,updated_by,facility,source_id
     FROM records WHERE profile_key<>''`
  );
  for (const r of legacy) {
    const parsed = safeJson(r.record_json, {});
    const fp = recordFingerprint(r.dataset, parsed);
    const ch = contentHash(parsed);
    const p = await get('SELECT in_charge,facility FROM profile_assignments WHERE profile_key=?', [r.profile_key]);
    const existing = await get(
      'SELECT updated_at FROM profile_records WHERE profile_key=? AND dataset=? AND record_key=?',
      [r.profile_key, r.dataset, r.record_key]
    );
    if (!existing || String(r.updated_at) > String(existing.updated_at)) {
      await run(
        `INSERT INTO profile_records(profile_key,dataset,record_key,record_json,record_date,record_name,fingerprint,content_hash,updated_at,revision,deleted_at,updated_by,facility,in_charge)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(profile_key,dataset,record_key) DO UPDATE SET
           record_json=excluded.record_json,
           record_date=excluded.record_date,
           record_name=excluded.record_name,
           fingerprint=excluded.fingerprint,
           content_hash=excluded.content_hash,
           updated_at=excluded.updated_at,
           revision=excluded.revision,
           deleted_at=excluded.deleted_at,
           updated_by=excluded.updated_by,
           facility=excluded.facility,
           in_charge=excluded.in_charge`,
        [r.profile_key,r.dataset,r.record_key,r.record_json,r.record_date||'',r.record_name||'',fp,ch,r.updated_at,r.revision||1,r.deleted_at||null,r.updated_by||r.source_id,p?.facility||r.facility||'',p?.in_charge||'']
      );
    }
  }

  /* Always rebuild Central's school-wide canonical registry from profile records. */
  await rebuildGlobalRegistry();

  /*
   * Only create the unique registry index AFTER the rebuild has cleared
   * any legacy rows. This is important when an old registry gained a new
   * identity_key column with a temporary default value.
   */
  await exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS
      idx_central_registry_identity
    ON central_registry(dataset, identity_key);

    CREATE INDEX IF NOT EXISTS
      idx_central_registry_dataset
    ON central_registry(dataset);
  `);
}

let globalRegistryRebuildPromise = null;

async function rebuildGlobalRegistry(){
  // Serialize every rebuild. Multiple simultaneous sync/admin requests used to
  // DELETE and INSERT into central_registry at the same time, causing
  // UNIQUE constraint failures on (dataset, identity_key).
  if (globalRegistryRebuildPromise) {
    return globalRegistryRebuildPromise;
  }

  globalRegistryRebuildPromise = (async () => {
    await run('BEGIN IMMEDIATE TRANSACTION');
    try {
      await run('DELETE FROM central_registry');

      const rows = await all(`
        SELECT
          profile_key,
          dataset,
          record_key,
          record_json,
          fingerprint,
          updated_at,
          revision,
          deleted_at,
          facility,
          in_charge
        FROM profile_records
        WHERE deleted_at IS NULL
          AND dataset IN ('people','books','equipment')
        ORDER BY updated_at DESC, revision DESC
      `);

      const counts = await all(`
        SELECT
          dataset,
          fingerprint AS identity_key,
          COUNT(*) AS occurrences
        FROM profile_records
        WHERE deleted_at IS NULL
          AND dataset IN ('people','books','equipment')
          AND fingerprint <> ''
        GROUP BY dataset, fingerprint
      `);

      const occMap = new Map();
      for (const row of counts) {
        occMap.set(
          row.dataset + '|' + row.identity_key,
          Number(row.occurrences || 0)
        );
      }

      const seen = new Set();

      for (const row of rows) {
        const obj = safeJson(row.record_json, {});
        const identity = row.fingerprint || recordFingerprint(row.dataset, obj);
        if (!identity) continue;

        const key = row.dataset + '|' + identity;
        if (seen.has(key)) continue;
        seen.add(key);

        // UPSERT is an additional safety net even though the rebuild is locked.
        await run(`
          INSERT INTO central_registry(
            dataset,
            identity_key,
            record_json,
            content_hash,
            updated_at,
            revision,
            occurrences,
            last_profile_key,
            last_facility,
            last_in_charge
          )
          VALUES(?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(dataset,identity_key) DO UPDATE SET
            record_json=excluded.record_json,
            content_hash=excluded.content_hash,
            updated_at=excluded.updated_at,
            revision=excluded.revision,
            occurrences=excluded.occurrences,
            last_profile_key=excluded.last_profile_key,
            last_facility=excluded.last_facility,
            last_in_charge=excluded.last_in_charge
        `,[
          row.dataset,
          identity,
          row.record_json,
          contentHash(obj),
          row.updated_at,
          row.revision || 1,
          occMap.get(key) || 0,
          row.profile_key,
          row.facility || '',
          row.in_charge || ''
        ]);
      }

      await run('COMMIT');
    } catch (e) {
      try { await run('ROLLBACK'); } catch (_) {}
      throw e;
    }
  })().finally(() => {
    globalRegistryRebuildPromise = null;
  });

  return globalRegistryRebuildPromise;
}

async function refreshGlobalIdentity(dataset, identity) {
  if (!identity || !['people','books','equipment'].includes(dataset)) return;
  const row = await get(
    `SELECT profile_key,record_json,updated_at,revision,facility,in_charge
     FROM profile_records
     WHERE dataset=? AND fingerprint=? AND deleted_at IS NULL
     ORDER BY updated_at DESC, revision DESC LIMIT 1`,
    [dataset, identity]
  );
  if (!row) {
    await run('DELETE FROM central_registry WHERE dataset=? AND identity_key=?', [dataset, identity]);
    return;
  }
  const occ = await get(
    `SELECT COUNT(*) n FROM profile_records WHERE dataset=? AND fingerprint=? AND deleted_at IS NULL`,
    [dataset, identity]
  );
  const ch = contentHash(safeJson(row.record_json, {}));
  await run(
    `INSERT INTO central_registry(dataset,identity_key,record_json,content_hash,updated_at,revision,occurrences,last_profile_key,last_facility,last_in_charge)
     VALUES(?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(dataset,identity_key) DO UPDATE SET
       record_json=excluded.record_json,
       content_hash=excluded.content_hash,
       updated_at=excluded.updated_at,
       revision=excluded.revision,
       occurrences=excluded.occurrences,
       last_profile_key=excluded.last_profile_key,
       last_facility=excluded.last_facility,
       last_in_charge=excluded.last_in_charge`,
    [dataset,identity,row.record_json,ch,row.updated_at,row.revision||1,occ.n,row.profile_key,row.facility||'',row.in_charge||'']
  );
}

function parseBearer(req) {
  const h = req.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

async function requireDevice(req,res,next) {
  try {
    const token = parseBearer(req);
    if (!token) return res.status(401).json({ok:false,error:'DEVICE_AUTH_REQUIRED'});
    const row = await get(
      `SELECT d.source_id,d.facility,d.in_charge,d.designation,d.role,d.profile_key,d.data_version,
              d.sync_ready,
              d.auth_generation,
              COALESCE(p.status,'ACTIVE') profile_status,p.assignment_id
       FROM devices d LEFT JOIN profile_assignments p ON p.profile_key=d.profile_key
       WHERE d.token_hash=?`,
      [tokenHash(token)]
    );
    if (!row) return res.status(401).json({ok:false,error:'INVALID_DEVICE_TOKEN'});
    if (row.profile_status !== 'ACTIVE') return res.status(403).json({ok:false,error:'PROFILE_ARCHIVED',profileKey:row.profile_key,assignmentId:row.assignment_id||''});
    req.device = row;
    await run('UPDATE devices SET last_seen_at=? WHERE source_id=?', [nowIso(), row.source_id]);
    next();
  } catch (e) { next(e); }
}

const adminTokens = new Map();
function requireAdmin(req,res,next) {
  const token = parseBearer(req);
  const item = token && adminTokens.get(token);
  if (!item || item.expiresAt < Date.now()) {
    if (token) adminTokens.delete(token);
    return res.status(401).json({ok:false,error:'ADMIN_AUTH_REQUIRED'});
  }
  next();
}
function newAdminToken() {
  const token = randomToken();
  adminTokens.set(token, {expiresAt: Date.now() + 12*60*60*1000});
  return token;
}

const app = express();
const httpServer = http.createServer(app);

function normalizeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`.toLowerCase().replace(/\/$/, '');
  } catch {
    return raw.toLowerCase().replace(/\/$/, '');
  }
}
const configuredOrigins = CORS_ORIGIN === '*'
  ? '*'
  : CORS_ORIGIN.split(',').map(normalizeOrigin).filter(Boolean);
const allowedOrigins = configuredOrigins === '*'
  ? '*'
  : Array.from(new Set([
      ...configuredOrigins,
      normalizeOrigin('https://qlogproult.mdmsportal.uk'),
      normalizeOrigin('https://qlog-api.mdmsportal.uk'),
      normalizeOrigin(PUBLIC_API_URL)
    ]));
function isAllowedOrigin(origin) {
  if (!origin || allowedOrigins === '*') return true;
  return allowedOrigins.includes(normalizeOrigin(origin));
}

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: (origin, cb) => {
      if (isAllowedOrigin(origin)) return cb(null,true);
      console.warn(`[QLog] Socket.IO CORS blocked origin: ${origin}`);
      return cb(new Error('CORS origin not allowed'));
    },
    methods: ['GET','POST']
  }
});

app.disable('x-powered-by');
app.use(cors({
  origin: (origin, cb) => {
    if (isAllowedOrigin(origin)) return cb(null,true);
    console.warn(`[QLog] HTTP CORS blocked origin: ${origin}`);
    return cb(new Error('CORS origin not allowed'));
  },
  methods: ['GET','POST','DELETE','OPTIONS']
}));
app.use(express.json({limit:'60mb'}));
app.use(express.urlencoded({extended:true,limit:'2mb'}));

app.get('/api/health', async (req,res) => {
  try {
    const devices = await get('SELECT COUNT(*) n FROM devices');
    const profiles = await get("SELECT COUNT(*) n FROM profile_assignments WHERE status='ACTIVE'");
    const globalPeople = await get("SELECT COUNT(*) n FROM central_registry WHERE dataset='people'");
    const globalBooks = await get("SELECT COUNT(*) n FROM central_registry WHERE dataset='books'");
    const globalEquipment = await get("SELECT COUNT(*) n FROM central_registry WHERE dataset='equipment'");
    const centralResetGeneration=await getCentralResetGeneration();
    res.json({ok:true,service:'QLog Pro Ultimate Central',db:'sqlite3',syncModel:'profile+global-dedup+revision+tombstone',time:nowIso(),devices:devices.n,activeProfiles:profiles.n,registeredPeople:globalPeople.n,books:globalBooks.n,equipment:globalEquipment.n,centralResetGeneration,publicApiUrl:PUBLIC_API_URL});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

app.post('/api/auth/device', async (req,res,next) => {
  try {
    if (!OFFICE_ACCESS_CODE) return res.status(503).json({ok:false,error:'OFFICE_ACCESS_CODE_NOT_CONFIGURED'});
    const {accessCode,sourceId,facility,inCharge,designation,role} = req.body || {};
    if (String(accessCode || '') !== OFFICE_ACCESS_CODE) return res.status(403).json({ok:false,error:'INVALID_OFFICE_ACCESS_CODE'});
    if (!sourceId) return res.status(400).json({ok:false,error:'SOURCE_ID_REQUIRED'});
    const f=norm(facility), ic=norm(inCharge), dg=norm(designation), rl=norm(role);
    if (!f || !ic) return res.status(400).json({ok:false,error:'PROFILE_REQUIRED'});
    const pk=profileKey(f,ic), ts=nowIso(), token=randomToken();
    const assignment=await get('SELECT * FROM profile_assignments WHERE profile_key=?',[pk]);
    if (assignment && assignment.status !== 'ACTIVE') return res.status(403).json({ok:false,error:'PROFILE_ARCHIVED',profileKey:pk});
    if (!assignment) {
      await run(`INSERT INTO profile_assignments(profile_key,assignment_id,in_charge,facility,designation,role,status,started_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,[pk,`ASSIGN-${pk}`,ic,f,dg,rl,'ACTIVE',ts,ts,ts]);
    } else {
      await run(`UPDATE profile_assignments SET designation=?,role=?,updated_at=? WHERE profile_key=?`,[dg,rl,ts,pk]);
    }
    const centralResetGeneration=await getCentralResetGeneration();
    const existing=await get('SELECT id FROM devices WHERE source_id=?',[String(sourceId)]);
    if (existing) {
      await run(`UPDATE devices SET token_hash=?,facility=?,in_charge=?,designation=?,role=?,profile_key=?,last_seen_at=?,sync_ready=0,auth_generation=? WHERE source_id=?`,[tokenHash(token),f,ic,dg,rl,pk,ts,centralResetGeneration,String(sourceId)]);
    } else {
      await run(`INSERT INTO devices(source_id,token_hash,facility,in_charge,designation,role,profile_key,created_at,last_seen_at,sync_ready,auth_generation) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,[String(sourceId),tokenHash(token),f,ic,dg,rl,pk,ts,ts,0,centralResetGeneration]);
    }
    res.json({ok:true,token,sourceId:String(sourceId),profileKey:pk,assignmentId:`ASSIGN-${pk}`,centralResetGeneration,syncReady:false,profile:{facility:f,inCharge:ic,designation:dg,role:rl,status:'ACTIVE'}});
  } catch(e) { next(e); }
});

async function fullProfileRows(pk) {
  return all(`SELECT profile_key,dataset,record_key,record_json,record_date,record_name,fingerprint,content_hash,updated_at,revision,deleted_at,facility,in_charge FROM profile_records WHERE profile_key=? ORDER BY dataset,updated_at ASC,revision ASC`,[pk]);
}
function buildDatasetsFromRows(rows) {
  const datasets={};
  for (const row of rows) {
    if (row.deleted_at) continue;
    if (!datasets[row.dataset]) datasets[row.dataset]=[];
    datasets[row.dataset].push(safeJson(row.record_json, null));
  }
  return datasets;
}

async function emitUpdated(event) {
  io.emit('qlog:updated', event);
}


app.post('/api/auth/switch-profile', async (req,res,next) => {
  try {
    const token = parseBearer(req);
    if (!token) return res.status(401).json({ok:false,error:'DEVICE_AUTH_REQUIRED'});
    const device = await get(`SELECT * FROM devices WHERE token_hash=?`, [tokenHash(token)]);
    if (!device) return res.status(401).json({ok:false,error:'INVALID_DEVICE_TOKEN'});
    const {facility,inCharge,designation,role} = req.body || {};
    const f=norm(facility), ic=norm(inCharge), dg=norm(designation), rl=norm(role);
    if(!f||!ic) return res.status(400).json({ok:false,error:'PROFILE_REQUIRED'});
    const pk=profileKey(f,ic), ts=nowIso();
    const assignment=await get('SELECT * FROM profile_assignments WHERE profile_key=?',[pk]);
    if(assignment && assignment.status !== 'ACTIVE') return res.status(403).json({ok:false,error:'PROFILE_ARCHIVED',profileKey:pk});
    if(!assignment){
      await run(`INSERT INTO profile_assignments(profile_key,assignment_id,in_charge,facility,designation,role,status,started_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,[pk,`ASSIGN-${pk}`,ic,f,dg,rl,'ACTIVE',ts,ts,ts]);
    }else{
      await run(`UPDATE profile_assignments SET designation=?,role=?,updated_at=? WHERE profile_key=?`,[dg,rl,ts,pk]);
    }
    const generation=await getCentralResetGeneration();
    await run(`UPDATE devices SET facility=?,in_charge=?,designation=?,role=?,profile_key=?,last_seen_at=?,sync_ready=0,auth_generation=? WHERE source_id=?`,[f,ic,dg,rl,pk,ts,generation,device.source_id]);
    res.json({ok:true,sourceId:device.source_id,token,profileKey:pk,facility:f,inCharge:ic,designation:dg,role:rl,centralResetGeneration:generation,syncReady:false});
  }catch(e){next(e);}
});

app.post('/api/device/activate-sync', requireDevice, async(req,res,next)=>{
  try {
    const currentGeneration = await getCentralResetGeneration();
    const deviceGeneration = Number(req.device.auth_generation || 0);
    const requestedGeneration = Number((req.body || {}).centralResetGeneration || 0);
    const mode = String((req.body || {}).mode || 'existing').toLowerCase();

    if (deviceGeneration !== currentGeneration || requestedGeneration !== currentGeneration) {
      return res.status(409).json({
        ok:false,
        error:'CENTRAL_RESET_REQUIRED',
        centralResetGeneration:currentGeneration
      });
    }

    if (mode !== 'empty' && mode !== 'existing') {
      return res.status(400).json({ok:false,error:'INVALID_SYNC_ACTIVATION_MODE'});
    }

    await run(
      'UPDATE devices SET sync_ready=1,auth_generation=? WHERE source_id=?',
      [currentGeneration,req.device.source_id]
    );

    res.json({
      ok:true,
      syncReady:true,
      mode,
      centralResetGeneration:currentGeneration
    });
  } catch(e) {
    next(e);
  }
});

app.get('/api/state', requireDevice, async (req,res,next)=>{
  try {
    const rows=await fullProfileRows(req.device.profile_key);
    res.json({ok:true,sourceId:req.device.source_id,facility:req.device.facility,inCharge:req.device.in_charge,profileKey:req.device.profile_key,datasets:buildDatasetsFromRows(rows),snapshotAt:nowIso()});
  } catch(e){next(e);}
});

/* GET and POST are both supported so old/new clients can rebuild safely. */
async function rebuildHandler(req,res,next){
  try {
    const rows=await fullProfileRows(req.device.profile_key);
    const ts=nowIso();
    await run(`INSERT INTO sync_events(source_id,event_type,created_at,details_json) VALUES(?,?,?,?)`,[req.device.source_id,'PROFILE_REBUILD',ts,JSON.stringify({profileKey:req.device.profile_key,recordCount:rows.length,method:req.method})]);
    res.json({ok:true,mode:'PROFILE_REBUILD',sourceId:req.device.source_id,assignmentId:req.device.assignment_id||`ASSIGN-${req.device.profile_key}`,facility:req.device.facility,inCharge:req.device.in_charge,profileKey:req.device.profile_key,datasets:buildDatasetsFromRows(rows),snapshotAt:ts});
  }catch(e){next(e);}
}
app.get('/api/profile/rebuild', requireDevice, rebuildHandler);
app.post('/api/profile/rebuild', requireDevice, rebuildHandler);

app.get('/api/visitors/lookup', requireDevice, async(req,res,next)=>{
  try {
    const qr=String(req.query.qr||'').trim();
    if(!qr) return res.status(400).json({ok:false,error:'VISITOR_QR_REQUIRED'});
    let rows=await all(`SELECT profile_key,record_key,record_json,updated_at,revision,facility,in_charge
                        FROM profile_records
                        WHERE dataset='logs' AND deleted_at IS NULL AND record_key=?
                        ORDER BY updated_at DESC, revision DESC LIMIT 20`,[qr]);
    if(!rows.length){
      rows=await all(`SELECT profile_key,record_key,record_json,updated_at,revision,facility,in_charge
                      FROM profile_records
                      WHERE dataset='logs' AND deleted_at IS NULL
                      ORDER BY updated_at DESC, revision DESC LIMIT 50000`);
      rows=rows.filter(r=>safeJson(r.record_json,{}).id===qr);
    }
    for(const row of rows){
      const d=safeJson(row.record_json,{});
      if(String(d.category||'').toUpperCase()!=='VISITOR') continue;
      const descriptor=Array.isArray(d.faceDescriptor)?d.faceDescriptor.map(Number).filter(Number.isFinite):[];
      if(descriptor.length<64) continue;
      return res.json({ok:true,found:true,visitor:{id:String(d.id||row.record_key||qr),name:String(d.name||''),nameSource:String(d.nameSource||(d.identityVerificationMethod==='ID_OCR'?'ID_OCR':'MANUAL')),faceDescriptor:descriptor,profileKey:row.profile_key,facility:row.facility||'',inCharge:row.in_charge||'',updatedAt:row.updated_at||''}});
    }
    return res.json({ok:true,found:false});
  }catch(e){next(e);}
});

// Cross-office visitor recognition is FACE + registered NAME based. QR is not the
// identity key. This endpoint returns the Centralized visitor face directory so any
// office/device can recognize a returning visitor without relying on a local log or QR.
app.get('/api/visitors/faces', requireDevice, async(req,res,next)=>{
  try {
    let rows;
    try {
      rows=await all(`SELECT profile_key,record_key,record_json,updated_at,revision,facility,in_charge
                      FROM profile_records
                      WHERE dataset='logs' AND deleted_at IS NULL
                        AND json_extract(record_json,'$.category')='VISITOR'
                      ORDER BY updated_at DESC, revision DESC LIMIT 50000`);
    } catch(_e) {
      rows=await all(`SELECT profile_key,record_key,record_json,updated_at,revision,facility,in_charge
                      FROM profile_records
                      WHERE dataset='logs' AND deleted_at IS NULL
                      ORDER BY updated_at DESC, revision DESC LIMIT 50000`);
    }
    const seen=new Set();
    const visitors=[];
    for(const row of rows){
      const d=safeJson(row.record_json,{});
      if(String(d.category||'').toUpperCase()!=='VISITOR') continue;
      const name=String(d.name||'').trim();
      const descriptor=Array.isArray(d.faceDescriptor)?d.faceDescriptor.map(Number).filter(Number.isFinite):[];
      if(!name || descriptor.length<64) continue;
      const id=String(d.visitorProfileId||d.id||'').trim();
      // Keep distinct real face samples from Central visit records so a returning
      // visitor can match against more than one capture of the same face.
      const fingerprint=descriptor.slice(0,16).map(v=>Number(v).toFixed(5)).join(',');
      const key=(id || name.toLowerCase())+'::'+fingerprint;
      if(seen.has(key)) continue;
      seen.add(key);
      visitors.push({
        id:id || row.record_key,
        name,
        nameSource:String(d.nameSource||(d.identityVerificationMethod==='ID_OCR'?'ID_OCR':'MANUAL')),
        faceDescriptor:descriptor,
        profileKey:row.profile_key,
        facility:row.facility||'',
        inCharge:row.in_charge||'',
        updatedAt:row.updated_at||''
      });
    }
    return res.json({ok:true,count:visitors.length,visitors,source:'central-face-directory',identityKey:'FACE+NAME'});
  } catch(e) { next(e); }
});

app.get('/api/reconcile', requireDevice, async(req,res,next)=>{
  try {
    const since=String(req.query.since||'1970-01-01T00:00:00.000Z');
    const rows=await all(`SELECT profile_key,dataset,record_key,record_json,record_date,record_name,fingerprint,content_hash,updated_at,revision,deleted_at,facility,in_charge FROM profile_records WHERE profile_key=? AND updated_at>? ORDER BY updated_at ASC,revision ASC`,[req.device.profile_key,since]);
    res.json({ok:true,sourceId:req.device.source_id,facility:req.device.facility,inCharge:req.device.in_charge,profileKey:req.device.profile_key,since,serverTime:nowIso(),records:rows.map(r=>({profileKey:r.profile_key,dataset:r.dataset,recordKey:r.record_key,data:safeJson(r.record_json,{}),recordDate:r.record_date,recordName:r.record_name,fingerprint:r.fingerprint,contentHash:r.content_hash,updatedAt:r.updated_at,revision:r.revision,deletedAt:r.deleted_at,facility:r.facility,inCharge:r.in_charge}))});
  }catch(e){next(e);}
});

async function upsertProfileRecord(profile,device,dataset,key,obj,ts){
  const meta=metadataFor(dataset,obj);
  const fp=recordFingerprint(dataset,obj);
  const ch=contentHash(obj);
  const existing=await get(`SELECT revision FROM profile_records WHERE profile_key=? AND dataset=? AND record_key=?`,[profile,dataset,key]);
  const revision=(existing?.revision||0)+1;
  await run(`INSERT INTO profile_records(profile_key,dataset,record_key,record_json,record_date,record_name,fingerprint,content_hash,updated_at,revision,deleted_at,updated_by,facility,in_charge)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(profile_key,dataset,record_key) DO UPDATE SET
               record_json=excluded.record_json,
               record_date=excluded.record_date,
               record_name=excluded.record_name,
               fingerprint=excluded.fingerprint,
               content_hash=excluded.content_hash,
               updated_at=excluded.updated_at,
               revision=profile_records.revision+1,
               deleted_at=NULL,
               updated_by=excluded.updated_by,
               facility=excluded.facility,
               in_charge=excluded.in_charge`,
    [profile,dataset,key,JSON.stringify(obj),meta.date,meta.name,fp,ch,ts,revision,null,device.source_id,device.facility,device.in_charge]);
  if (GLOBAL_DATASETS.has(dataset)) await refreshGlobalIdentity(dataset,fp);
  return {key,revision,fingerprint:fp,contentHash:ch};
}

async function canonicalKeyFor(profile,dataset,incomingKey,fp){
  const alias=await get(`SELECT canonical_key FROM profile_aliases WHERE profile_key=? AND dataset=? AND incoming_key=?`,[profile,dataset,incomingKey]);
  if(alias) return {key:alias.canonical_key,alias:true};
  if(!GLOBAL_DATASETS.has(dataset)) return {key:incomingKey,alias:false};
  const row=await get(`SELECT record_key FROM profile_records WHERE profile_key=? AND dataset=? AND fingerprint=? AND deleted_at IS NULL ORDER BY revision DESC,updated_at DESC LIMIT 1`,[profile,dataset,fp]);
  if(row) return {key:row.record_key,alias:true};
  return {key:incomingKey,alias:false};
}

app.post('/api/inventory/check-batch', requireDevice, async(req,res,next)=>{
  try {
    const body=req.body||{};
    const dataset=String(body.dataset||'equipment').trim();
    if(dataset!=='equipment' && dataset!=='books'){
      return res.status(400).json({ok:false,error:'INVALID_INVENTORY_DATASET'});
    }
    const items=Array.isArray(body.items)?body.items:[];
    const conflicts=[];
    const allowed=[];
    const seen=new Set();

    for(let i=0;i<items.length;i++){
      const item=items[i]||{};
      const identity=recordFingerprint(dataset,item);
      if(!identity){
        allowed.push(i);
        continue;
      }

      if(seen.has(identity)){
        conflicts.push({
          index:i,
          reason:'DUPLICATE_IN_IMPORT',
          identityKey:identity
        });
        continue;
      }
      seen.add(identity);

      const existing=await get(
        `SELECT identity_key,last_facility,last_in_charge,last_profile_key,record_json
         FROM central_registry
         WHERE dataset=? AND identity_key=?`,
        [dataset,identity]
      );

      if(existing && existing.last_profile_key!==req.device.profile_key){
        const oldObj=safeJson(existing.record_json,{});
        conflicts.push({
          index:i,
          reason:'ALREADY_ASSIGNED_TO_OTHER_PROFILE',
          identityKey:identity,
          existingFacility:existing.last_facility||oldObj.unit||oldObj.facility||'',
          existingInCharge:existing.last_in_charge||'',
          existingId:oldObj.id||oldObj.assetNo||oldObj.asset||oldObj.productId||oldObj.equipmentId||'' ,
          existingName:oldObj.name||oldObj.eqName||oldObj.title||''
        });
      }else{
        allowed.push(i);
      }
    }

    res.json({ok:true,dataset,allowed,conflicts});
  }catch(e){next(e);}
});

app.post('/api/sync', requireDevice, async(req,res,next)=>{
  try {
    const currentGeneration = await getCentralResetGeneration();
    if (Number(req.device.auth_generation || 0) !== currentGeneration || Number(req.device.sync_ready || 0) !== 1) {
      return res.status(409).json({
        ok:false,
        error:'SYNC_NOT_ACTIVATED',
        centralResetGeneration:currentGeneration
      });
    }
    const incoming=(req.body&&req.body.datasets)||{};
    const deletions=(req.body&&req.body.deletions)||{};
    const changed=new Set();
    const accepted=[];
    const deduped=[];
    const deleted=[];
    const ts=nowIso();

    const requestedFacility=norm(req.body?.device?.facility||'');
    const requestedInCharge=norm(req.body?.device?.inCharge||'');
    if ((requestedFacility||requestedInCharge) && profileKey(requestedFacility||req.device.facility,requestedInCharge||req.device.in_charge)!==req.device.profile_key) {
      return res.status(409).json({ok:false,error:'PROFILE_SCOPE_MISMATCH'});
    }

    await run('BEGIN IMMEDIATE TRANSACTION');
    try {
      await run('UPDATE devices SET last_seen_at=?,data_version=data_version+1 WHERE source_id=?',[ts,req.device.source_id]);

      for (const dataset of DATASETS) {
        if (!Object.prototype.hasOwnProperty.call(incoming,dataset)) continue;
        const value=incoming[dataset];

        if (!ARRAY_DATASETS.has(dataset)) {
          const key=dataset;
          const existing=await get(`SELECT record_json,content_hash,revision,fingerprint FROM profile_records WHERE profile_key=? AND dataset=? AND record_key=? AND deleted_at IS NULL`,[req.device.profile_key,dataset,key]);
          const ch=contentHash(value||{});
          const same=existing && (existing.content_hash || contentHash(safeJson(existing.record_json,{})))===ch;
          if (!same) {
            const result=await upsertProfileRecord(req.device.profile_key,req.device,dataset,key,value||{},ts);
            accepted.push({dataset,key,revision:result.revision,action:existing?'updated':'created'});
            changed.add(dataset);
          }
          continue;
        }

        const rows=Array.isArray(value)?value:[];
        for (let i=0;i<rows.length;i++) {
          const obj=rows[i]||{};
          const incomingKey=recordKey(dataset,obj,i);
          const fp=recordFingerprint(dataset,obj);
          const canonical=await canonicalKeyFor(req.device.profile_key,dataset,incomingKey,fp);

          if (canonical.alias) {
            await run(`INSERT INTO profile_aliases(profile_key,dataset,incoming_key,canonical_key,fingerprint,created_at,last_seen_at)
                       VALUES(?,?,?,?,?,?,?)
                       ON CONFLICT(profile_key,dataset,incoming_key) DO UPDATE SET
                         canonical_key=excluded.canonical_key,
                         fingerprint=excluded.fingerprint,
                         last_seen_at=excluded.last_seen_at`,
              [req.device.profile_key,dataset,incomingKey,canonical.key,fp,ts,ts]);
          }

          const existing=await get(`SELECT record_json,content_hash,revision,fingerprint FROM profile_records WHERE profile_key=? AND dataset=? AND record_key=? AND deleted_at IS NULL`,[req.device.profile_key,dataset,canonical.key]);
          const ch=contentHash(obj);
          const same=existing && (existing.content_hash || contentHash(safeJson(existing.record_json,{})))===ch;

          if (same) {
            deduped.push({dataset,key:incomingKey,canonicalKey:canonical.key,action:'unchanged'});
            if (GLOBAL_DATASETS.has(dataset)) await refreshGlobalIdentity(dataset,fp);
            continue;
          }

          const result=await upsertProfileRecord(req.device.profile_key,req.device,dataset,canonical.key,obj,ts);
          accepted.push({dataset,key:canonical.key,revision:result.revision,action:existing?'updated':'created'});
          changed.add(dataset);
        }
      }

      /* Explicit deletes only. Missing rows are NEVER treated as deletes. */
      for (const dataset of DATASETS) {
        const keys=Array.isArray(deletions[dataset])?deletions[dataset]:[];
        for (const kRaw of keys) {
          const k=String(kRaw||'');
          if(!k) continue;
          const row=await get(`SELECT revision,fingerprint FROM profile_records WHERE profile_key=? AND dataset=? AND record_key=?`,[req.device.profile_key,dataset,k]);
          if(!row) continue;
          await run(`UPDATE profile_records SET deleted_at=?,updated_at=?,revision=revision+1,updated_by=? WHERE profile_key=? AND dataset=? AND record_key=?`,[ts,ts,req.device.source_id,req.device.profile_key,dataset,k]);
          if(GLOBAL_DATASETS.has(dataset)) await refreshGlobalIdentity(dataset,row.fingerprint);
          deleted.push({dataset,key:k});
          changed.add(dataset);
        }
      }

      await run(`INSERT INTO sync_events(source_id,event_type,created_at,details_json) VALUES(?,?,?,?)`,[
        req.device.source_id,'SYNC',ts,JSON.stringify({profileKey:req.device.profile_key,changed:Array.from(changed),accepted:accepted.length,deduped:deduped.length,deleted:deleted.length})
      ]);
      await run(`INSERT INTO sync_cursors(source_id,last_pulled_at) VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET last_pulled_at=excluded.last_pulled_at`,[req.device.source_id,ts]);
      await run('COMMIT');
    }catch(e){try{await run('ROLLBACK');}catch(_){}throw e;}

    if (Array.from(changed).some(ds => GLOBAL_DATASETS.has(ds))) {
      await rebuildGlobalRegistry();
    }

    const liveSummaryRows = await Promise.all([
      get('SELECT COUNT(*) n FROM devices'),
      get("SELECT COUNT(*) n FROM profile_assignments WHERE status='ACTIVE'"),
      get("SELECT COUNT(*) n FROM central_registry WHERE dataset='people'"),
      get("SELECT COUNT(*) n FROM (SELECT profile_key,fingerprint FROM profile_records WHERE dataset='books' AND deleted_at IS NULL GROUP BY profile_key,fingerprint)"),
      get("SELECT COUNT(*) n FROM (SELECT profile_key,fingerprint FROM profile_records WHERE dataset='equipment' AND deleted_at IS NULL GROUP BY profile_key,fingerprint)"),
      get("SELECT COUNT(*) n FROM profile_records WHERE dataset='logs' AND deleted_at IS NULL"),
      get("SELECT COUNT(*) n FROM profile_records WHERE dataset='logs' AND deleted_at IS NULL AND UPPER(record_json) LIKE '%\"category\":\"VISITOR\"%'"),
      get("SELECT COUNT(*) n FROM profile_records WHERE dataset='borrowLogs' AND deleted_at IS NULL"),
      get("SELECT COUNT(*) n FROM profile_records WHERE dataset='equipLogs' AND deleted_at IS NULL")
    ]);
    const liveSummary={
      devices:liveSummaryRows[0].n,
      activeProfiles:liveSummaryRows[1].n,
      people:liveSummaryRows[2].n,
      books:liveSummaryRows[3].n,
      equipment:liveSummaryRows[4].n,
      logs:liveSummaryRows[5].n,
      visitors:liveSummaryRows[6].n,
      borrowLogs:liveSummaryRows[7].n,
      equipLogs:liveSummaryRows[8].n
    };

    const event={
      sourceId:req.device.source_id,
      profileKey:req.device.profile_key,
      facility:req.device.facility,
      inCharge:req.device.in_charge,
      changed:Array.from(changed),
      datasets:Array.from(changed),
      at:ts,
      counts:{accepted:accepted.length,deduped:deduped.length,deleted:deleted.length},
      globalDedupDatasets:Array.from(new Set(accepted.filter(x=>GLOBAL_DATASETS.has(x.dataset)).map(x=>x.dataset))),
      summary:liveSummary
    };
    await emitUpdated(event);

    res.json({ok:true,profileKey:req.device.profile_key,changed:Array.from(changed),accepted,deduped,deleted,syncedAt:ts});
  }catch(e){next(e);}
});

app.post('/api/admin/login', async(req,res)=>{
  const password=String((req.body||{}).password||'');
  if(!REPORT_ADMIN_PASSWORD) return res.status(503).json({ok:false,error:'REPORT_ADMIN_PASSWORD_NOT_CONFIGURED'});
  if(password!==REPORT_ADMIN_PASSWORD) return res.status(403).json({ok:false,error:'INVALID_REPORT_ADMIN_PASSWORD'});
  res.json({ok:true,token:newAdminToken(),expiresInSeconds:43200});
});

app.get('/api/admin/summary', requireAdmin, async(req,res,next)=>{
  try {
    const [devices,profiles,logs,visitors,people,books,borrowLogs,equipment,equipLogs]=await Promise.all([
      get('SELECT COUNT(*) n FROM devices'),
      get("SELECT COUNT(*) n FROM profile_assignments WHERE status='ACTIVE'"),
      get("SELECT COUNT(*) n FROM profile_records WHERE dataset='logs' AND deleted_at IS NULL"),
      get("SELECT COUNT(*) n FROM profile_records WHERE dataset='logs' AND deleted_at IS NULL AND UPPER(record_json) LIKE '%\"category\":\"VISITOR\"%'"),
      get("SELECT COUNT(*) n FROM central_registry WHERE dataset='people'"),
      get("SELECT COUNT(*) n FROM (SELECT profile_key,fingerprint FROM profile_records WHERE dataset='books' AND deleted_at IS NULL GROUP BY profile_key,fingerprint)"),
      get("SELECT COUNT(*) n FROM profile_records WHERE dataset='borrowLogs' AND deleted_at IS NULL"),
      get("SELECT COUNT(*) n FROM (SELECT profile_key,fingerprint FROM profile_records WHERE dataset='equipment' AND deleted_at IS NULL GROUP BY profile_key,fingerprint)"),
      get("SELECT COUNT(*) n FROM profile_records WHERE dataset='equipLogs' AND deleted_at IS NULL")
    ]);
    const recent=await all('SELECT source_id,event_type,created_at,details_json FROM sync_events ORDER BY id DESC LIMIT 20');
    res.json({ok:true,summary:{devices:devices.n,activeProfiles:profiles.n,logs:logs.n,visitors:visitors.n,people:people.n,books:books.n,borrowLogs:borrowLogs.n,equipment:equipment.n,equipLogs:equipLogs.n},recent});
  }catch(e){next(e);}
});

app.get('/api/admin/global', requireAdmin, async(req,res,next)=>{
  try{
    const dataset=String(req.query.dataset||'people');
    if(!GLOBAL_DATASETS.has(dataset)) return res.status(400).json({ok:false,error:'INVALID_GLOBAL_DATASET'});
    const limit=Math.min(Math.max(Number(req.query.limit||5000),1),20000);
    const rows=await all(`SELECT dataset,identity_key,record_json,content_hash,updated_at,revision,occurrences,last_profile_key,last_facility,last_in_charge FROM central_registry WHERE dataset=? ORDER BY updated_at DESC LIMIT ?`,[dataset,limit]);
    const q=String(req.query.q||'').trim().toLowerCase();
    const date=String(req.query.date||'').trim();
    let out=rows.map(r=>({identityKey:r.identity_key,data:safeJson(r.record_json,{}),contentHash:r.content_hash,updatedAt:r.updated_at,revision:r.revision,occurrences:r.occurrences,lastProfileKey:r.last_profile_key,lastFacility:r.last_facility,lastInCharge:r.last_in_charge}));
    if(q) out=out.filter(r=>JSON.stringify(r.data||{}).toLowerCase().includes(q)||String(r.lastFacility||'').toLowerCase().includes(q)||String(r.lastInCharge||'').toLowerCase().includes(q));
    if(date) out=out.filter(r=>{ const d=(r.data&& (r.data.date||r.data.registeredAt||r.data.addedAt||r.data.createdAt||r.data.borrowedAt)) || r.updatedAt || ''; return String(d).slice(0,10)===date || String(d).includes(date); });
    res.json({ok:true,dataset,rows:out});
  }catch(e){next(e);}
});

app.get('/api/admin/card-records', requireAdmin, async(req,res,next)=>{
  try{
    const kind=String(req.query.kind||'').trim();
    const limit=Math.min(Math.max(Number(req.query.limit||10000),1),20000);
    const q=String(req.query.q||'').trim().toLowerCase();
    const date=String(req.query.date||'').trim();
    let rows=[];
    if(kind==='devices'){
      rows=await all(`SELECT source_id,facility,in_charge,designation,role,profile_key,created_at,last_seen_at,data_version FROM devices ORDER BY last_seen_at DESC LIMIT ?`,[limit]);
      rows=rows.map(r=>({identityKey:r.source_id,data:r,updatedAt:r.last_seen_at,facility:r.facility,inCharge:r.in_charge,occurrences:1}));
    } else if(kind==='profiles'){
      rows=await all(`SELECT profile_key,assignment_id,in_charge,facility,designation,role,status,started_at,ended_at,created_at,updated_at,archived_at,replaced_by_profile_key FROM profile_assignments ORDER BY updated_at DESC LIMIT ?`,[limit]);
      rows=rows.map(r=>({identityKey:r.profile_key,data:r,updatedAt:r.updated_at,facility:r.facility,inCharge:r.in_charge,occurrences:1}));
    } else if(kind==='books' || kind==='equipment'){
      rows=await loadCentralInventoryCard(kind,limit);
      const related=await loadCentralRelatedLogs(kind==='books'?'borrowLogs':'equipLogs',Math.max(limit,20000));
      // Return related transactions with the inventory response so Books and
      // Equipment can own their borrowing/return tabs instead of separate cards.
      if(q) rows=rows.filter(r=>JSON.stringify(r.data||{}).toLowerCase().includes(q)||String(r.facility||r.lastFacility||'').toLowerCase().includes(q)||String(r.inCharge||r.lastInCharge||'').toLowerCase().includes(q));
      if(date) rows=rows.filter(r=>{const d=(r.data&&((r.data.date)||(r.data.registeredAt)||(r.data.addedAt)||(r.data.createdAt)))||r.updatedAt||'';return String(d).slice(0,10)===date||String(d).includes(date)||String(d).includes(date.replaceAll('-','/'));});
      if(kind==='books'){
        const titlesByProfileAndBook=new Map();
        rows.forEach(r=>{const d=r.data||{}; const title=d.title||d.bookTitle||d.name||''; [d.id,d.bookId,d.bookID,d.isbn,d.ISBN,d.barcode,d.qrCode,d.title,d.bookTitle,d.name].map(norm).filter(Boolean).forEach(k=>titlesByProfileAndBook.set(r.lastProfileKey+'|'+k,title));});
        related.forEach(r=>{const d=r.data||{}; const k=r.profileKey+'|'+norm(d.b||d.isbn||d.bookId||d.id); if(!d.title){d.title=titlesByProfileAndBook.get(k)||d.bookTitle||d.name||d.b||'';}});
      }
      return res.json({ok:true,kind,rows,relatedRows:related});
    } else if(GLOBAL_DATASETS.has(kind)){
      await rebuildGlobalRegistry();
      rows=await all(`SELECT dataset,identity_key,record_json,content_hash,updated_at,revision,occurrences,last_profile_key,last_facility,last_in_charge FROM central_registry WHERE dataset=? ORDER BY updated_at DESC LIMIT ?`,[kind,limit]);
      rows=rows.map(r=>({identityKey:r.identity_key,data:safeJson(r.record_json,{}),contentHash:r.content_hash,updatedAt:r.updated_at,revision:r.revision,occurrences:r.occurrences,lastProfileKey:r.last_profile_key,lastFacility:r.last_facility,lastInCharge:r.last_in_charge,facility:r.last_facility,inCharge:r.last_in_charge}));
    } else if(kind==='attendance' || kind==='visitors' || kind==='borrowLogs' || kind==='equipLogs'){
      const dataset=kind==='attendance'||kind==='visitors'?'logs':kind;
      const records=await all(`SELECT profile_key,dataset,record_key,record_json,record_date,record_name,updated_at,revision,facility,in_charge FROM profile_records WHERE dataset=? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`,[dataset,limit]);
      rows=records.map(r=>({identityKey:r.profile_key+'|'+r.record_key,data:safeJson(r.record_json,{}),updatedAt:r.updated_at,revision:r.revision,facility:r.facility,inCharge:r.in_charge,profileKey:r.profile_key}));
      if(kind==='visitors') rows=rows.filter(r=>String((r.data||{}).category||'').toUpperCase()==='VISITOR');
    } else {
      return res.status(400).json({ok:false,error:'INVALID_CARD_KIND'});
    }
    if(q) rows=rows.filter(r=>JSON.stringify(r.data||{}).toLowerCase().includes(q)||String(r.facility||r.lastFacility||'').toLowerCase().includes(q)||String(r.inCharge||r.lastInCharge||'').toLowerCase().includes(q));
    if(date) rows=rows.filter(r=>{ const d=(r.data&&((r.data.date)||(r.data.registeredAt)||(r.data.addedAt)||(r.data.createdAt)||(r.data.borrowedAt)||(r.data.returnedAt))) || r.updatedAt || ''; return String(d).slice(0,10)===date || String(d).includes(date) || String(d).includes(date.replaceAll('-','/')); });
    res.json({ok:true,kind,rows});
  }catch(e){next(e);}
});

app.get('/api/admin/logs', requireAdmin, async(req,res,next)=>{
  try{
    const dataset=String(req.query.dataset||'logs');
    if(!DATASETS.includes(dataset)) return res.status(400).json({ok:false,error:'INVALID_DATASET'});
    const limit=Math.min(Math.max(Number(req.query.limit||5000),1),20000);
    if(GLOBAL_DATASETS.has(dataset)) {
      const r=await all(`SELECT dataset,identity_key,record_json,content_hash,updated_at,revision,occurrences,last_profile_key,last_facility,last_in_charge FROM central_registry WHERE dataset=? ORDER BY updated_at DESC LIMIT ?`,[dataset,limit]);
      return res.json({ok:true,dataset,rows:r.map(x=>({profileKey:x.last_profile_key,sourceId:'',recordKey:x.identity_key,data:safeJson(x.record_json,{}),recordDate:'',recordName:safeJson(x.record_json,{}).name||'',fingerprint:x.identity_key,updatedAt:x.updated_at,revision:x.revision,facility:x.last_facility,inCharge:x.last_in_charge,occurrences:x.occurrences}))});
    }
    const rows=await all(`SELECT profile_key,dataset,record_key,record_json,record_date,record_name,fingerprint,content_hash,updated_at,revision,deleted_at,facility,in_charge FROM profile_records WHERE dataset=? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`,[dataset,limit]);
    const category=String(req.query.category||'').trim().toUpperCase();
    const date=String(req.query.date||'').trim();
    let out=rows.map(r=>({profileKey:r.profile_key,sourceId:'',recordKey:r.record_key,data:safeJson(r.record_json,{}),recordDate:r.record_date,recordName:r.record_name,fingerprint:r.fingerprint,updatedAt:r.updated_at,revision:r.revision,facility:r.facility,inCharge:r.in_charge}));
    if(category) out=out.filter(r=>String(r.data.category||'').toUpperCase()===category);
    if(date) out=out.filter(r=>String(r.data.date||r.recordDate||'')===date||String(r.recordDate||'')===date);
    res.json({ok:true,dataset,rows:out});
  }catch(e){next(e);}
});

app.get('/api/admin/devices', requireAdmin, async(req,res,next)=>{try{res.json({ok:true,devices:await all(`SELECT d.source_id,d.facility,d.in_charge,d.designation,d.role,d.profile_key,d.created_at,d.last_seen_at,d.data_version,COALESCE(p.status,'ACTIVE') profile_status,p.assignment_id FROM devices d LEFT JOIN profile_assignments p ON p.profile_key=d.profile_key ORDER BY d.last_seen_at DESC`)});}catch(e){next(e);}});
app.get('/api/admin/profiles', requireAdmin, async(req,res,next)=>{try{res.json({ok:true,profiles:await all(`SELECT profile_key,assignment_id,in_charge,facility,designation,role,status,started_at,ended_at,created_at,updated_at,archived_at,replaced_by_profile_key FROM profile_assignments ORDER BY status ASC,facility ASC,in_charge ASC`)});}catch(e){next(e);}});

app.post('/api/admin/profiles/archive', requireAdmin, async(req,res,next)=>{try{
  const pk=norm((req.body||{}).profileKey); if(!pk)return res.status(400).json({ok:false,error:'PROFILE_KEY_REQUIRED'});
  const row=await get('SELECT profile_key,status FROM profile_assignments WHERE profile_key=?',[pk]);
  if(!row)return res.status(404).json({ok:false,error:'PROFILE_NOT_FOUND'});
  if(row.status==='ARCHIVED')return res.json({ok:true,alreadyArchived:true});
  const ts=nowIso();
  await run("UPDATE profile_assignments SET status='ARCHIVED',ended_at=?,archived_at=?,updated_at=? WHERE profile_key=?",[ts,ts,ts,pk]);
  for(const d of await all('SELECT source_id FROM devices WHERE profile_key=?',[pk])) await run('UPDATE devices SET token_hash=?,last_seen_at=? WHERE source_id=?',[tokenHash(randomToken()),ts,d.source_id]);
  await run('INSERT INTO sync_events(source_id,event_type,created_at,details_json) VALUES(?,?,?,?)',['CENTRAL_ADMIN','PROFILE_ARCHIVE',ts,JSON.stringify({profileKey:pk})]);
  io.emit('qlog:profile_changed',{profileKey:pk,action:'ARCHIVED'});
  res.json({ok:true,profileKey:pk,status:'ARCHIVED'});
}catch(e){next(e);}});

app.post('/api/admin/profiles/restore', requireAdmin, async(req,res,next)=>{try{
  const pk=norm((req.body||{}).profileKey); if(!pk)return res.status(400).json({ok:false,error:'PROFILE_KEY_REQUIRED'});
  const row=await get('SELECT profile_key FROM profile_assignments WHERE profile_key=?',[pk]); if(!row)return res.status(404).json({ok:false,error:'PROFILE_NOT_FOUND'});
  const ts=nowIso();
  await run("UPDATE profile_assignments SET status='ACTIVE',ended_at=NULL,archived_at=NULL,updated_at=? WHERE profile_key=?",[ts,pk]);
  await run('INSERT INTO sync_events(source_id,event_type,created_at,details_json) VALUES(?,?,?,?)',['CENTRAL_ADMIN','PROFILE_RESTORE',ts,JSON.stringify({profileKey:pk})]);
  io.emit('qlog:profile_changed',{profileKey:pk,action:'RESTORED'});
  res.json({ok:true,profileKey:pk,status:'ACTIVE'});
}catch(e){next(e);}});

app.post('/api/admin/profiles/transfer', requireAdmin, async(req,res,next)=>{try{
  const b=req.body||{}; const fromPk=norm(b.fromProfileKey); const f=norm(b.facility); const ic=norm(b.inCharge); const dg=norm(b.designation||'In-Charge'); const rl=norm(b.role||'incharge');
  if(!fromPk||!f||!ic)return res.status(400).json({ok:false,error:'TRANSFER_FIELDS_REQUIRED'});
  const source=await get('SELECT * FROM profile_assignments WHERE profile_key=?',[fromPk]); if(!source)return res.status(404).json({ok:false,error:'SOURCE_PROFILE_NOT_FOUND'});
  const newPk=profileKey(f,ic), ts=nowIso(), existing=await get('SELECT * FROM profile_assignments WHERE profile_key=?',[newPk]);
  if(existing && existing.status==='ARCHIVED') await run("UPDATE profile_assignments SET status='ACTIVE',ended_at=NULL,archived_at=NULL,replaced_by_profile_key=NULL,designation=?,role=?,updated_at=? WHERE profile_key=?",[dg,rl,ts,newPk]);
  else if(!existing) await run('INSERT INTO profile_assignments(profile_key,assignment_id,in_charge,facility,designation,role,status,started_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',[newPk,`ASSIGN-${newPk}`,ic,f,dg,rl,'ACTIVE',ts,ts,ts]);
  if(source.status!=='ARCHIVED'){
    await run("UPDATE profile_assignments SET status='ARCHIVED',ended_at=?,archived_at=?,updated_at=?,replaced_by_profile_key=? WHERE profile_key=?",[ts,ts,ts,newPk,fromPk]);
    for(const d of await all('SELECT source_id FROM devices WHERE profile_key=?',[fromPk])) await run('UPDATE devices SET token_hash=?,last_seen_at=? WHERE source_id=?',[tokenHash(randomToken()),ts,d.source_id]);
  }
  await run('INSERT INTO sync_events(source_id,event_type,created_at,details_json) VALUES(?,?,?,?)',['CENTRAL_ADMIN','PROFILE_TRANSFER',ts,JSON.stringify({fromProfileKey:fromPk,toProfileKey:newPk})]);
  io.emit('qlog:profile_changed',{profileKey:fromPk,action:'TRANSFERRED',replacedBy:newPk});
  io.emit('qlog:profile_changed',{profileKey:newPk,action:'CREATED'});
  res.json({ok:true,fromProfileKey:fromPk,toProfileKey:newPk,assignmentId:`ASSIGN-${newPk}`});
}catch(e){next(e);}});

/*
 * CENTRAL MASTER RESET
 * Deletes all application data but keeps database schema.
 * A persistent reset generation invalidates every office cache so an old
 * local copy can never repopulate the newly-empty Central database.
 */
app.post('/api/admin/reset-database', requireAdmin, async(req,res,next)=>{
  try {
    const ts=nowIso();
    await run('BEGIN IMMEDIATE TRANSACTION');
    let generation;
    try {
      generation=(await getCentralResetGeneration())+1;
      await run('DELETE FROM central_registry');
      await run('DELETE FROM profile_aliases');
      await run('DELETE FROM profile_records');
      await run('DELETE FROM sync_aliases');
      await run('DELETE FROM sync_cursors');
      await run('DELETE FROM sync_events');
      await run('DELETE FROM records');
      await run('DELETE FROM devices');
      await run('DELETE FROM profile_assignments');
      await run(
        `INSERT INTO system_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value`,
        ['central_reset_generation',String(generation)]
      );
      await run('COMMIT');
    } catch(e) {
      try{await run('ROLLBACK');}catch(_){}
      throw e;
    }
    try { await run('PRAGMA wal_checkpoint(TRUNCATE)'); } catch(_) {}
    try { await exec('VACUUM'); } catch(_) {}
    io.emit('qlog:central_reset',{ok:true,at:ts,centralResetGeneration:generation});
    res.json({
      ok:true,
      reset:true,
      centralResetGeneration:generation,
      at:ts,
      message:'Central database was completely reset. All Central records, profiles, devices, synchronization caches, aliases, cursors, events and the school-wide dedup registry were deleted. All office caches are invalidated and cannot re-upload old data.'
    });
  }catch(e){next(e);}
});

app.get('/api/admin/visitors/export.html', requireAdmin, async(req,res,next)=>{try{
  const rows=await all(`SELECT profile_key,record_key,record_json,facility,in_charge FROM profile_records WHERE dataset='logs' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 20000`);
  const visitors=rows.map(r=>({profileKey:r.profile_key,recordKey:r.record_key,data:safeJson(r.record_json,{}),facility:r.facility,inCharge:r.in_charge})).filter(r=>String(r.data.category||'').toUpperCase()==='VISITOR');
  const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const body=visitors.map((r,i)=>{const d=r.data||{};const image=typeof d.face==='string'&&d.face.startsWith('data:image/')?`<img src="${esc(d.face)}" alt="Visitor image" loading="lazy">`:'<span>No visitor image</span>';return `<tr><td>${i+1}</td><td>${esc(d.name)}</td><td>${esc(d.reason)}</td><td>${esc(d.timein)}</td><td>${esc(d.timeout||'')}</td><td>${esc(d.date)}</td><td>${esc(r.inCharge)}<br>${esc(r.facility)}</td><td>${image}</td></tr>`;}).join('');
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>QLog Pro Ultimate — Central Visitor Logs</title><style>body{font-family:Arial,sans-serif;margin:24px;color:#0f172a}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border:1px solid #cbd5e1;padding:8px;font-size:12px;vertical-align:top}th{background:#f1f5f9}img{width:110px;height:82px;object-fit:cover;border-radius:8px;border:1px solid #cbd5e1}@media print{button{display:none}}</style></head><body><h1>QLog Pro Ultimate — Central Visitor Logs</h1><p>Generated ${esc(nowIso())}. Total visitor records: ${visitors.length}</p><button onclick="window.print()">Print</button><table><thead><tr><th>#</th><th>Name</th><th>Reason</th><th>Time In</th><th>Time Out</th><th>Date</th><th>In-Charge / Office</th><th>Visitor Image</th></tr></thead><tbody>${body||'<tr><td colspan="8">No visitor records.</td></tr>'}</tbody></table></body></html>`);
}catch(e){next(e);}});

app.get('/api/admin/diagnostics', requireAdmin, async(req,res,next)=>{try{
  const size=fs.existsSync(DB_FILE)?fs.statSync(DB_FILE).size:0;
  const registry=await all(`SELECT dataset,COUNT(*) n FROM central_registry GROUP BY dataset`);
  res.json({ok:true,dbFile:DB_FILE,dbSizeBytes:size,publicApiUrl:PUBLIC_API_URL,corsOrigin:CORS_ORIGIN,allowedOrigins,registry});
}catch(e){next(e);}});

app.use('/central-assets',express.static(path.join(__dirname,'central-assets')));
app.get('/central.html',(req,res)=>{res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate'); res.set('Pragma','no-cache'); res.set('Expires','0'); res.sendFile(path.join(__dirname,'central.html'));});
app.get('/',(req,res)=>res.redirect('/central.html'));
app.use((err,req,res,next)=>{
  console.error('[QLog] API error:',err);
  if(res.headersSent)return next(err);
  res.status(err.status||500).json({ok:false,error:err.code||'SERVER_ERROR',message:process.env.NODE_ENV==='production'?'Internal server error':err.message});
});
io.on('connection',socket=>socket.emit('qlog:connected',{ok:true,at:nowIso()}));

(async()=>{
  try {
    await initDb();
    httpServer.listen(PORT,HOST,()=>console.log(`[QLog] Central API listening on http://${HOST}:${PORT} | public ${PUBLIC_API_URL}`));
  } catch(e) {
    console.error('[QLog] Database initialization failed:',e);
    process.exit(1);
  }
})();
