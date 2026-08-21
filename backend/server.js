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

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DB_FILE = path.resolve(process.env.DB_FILE || path.join(__dirname, 'data', 'qlog-pro.sqlite3'));
const OFFICE_ACCESS_CODE = String(process.env.OFFICE_ACCESS_CODE || '').trim();
const REPORT_ADMIN_PASSWORD = String(process.env.REPORT_ADMIN_PASSWORD || '').trim();
const CORS_ORIGIN = String(process.env.CORS_ORIGIN || 'https://qlogproult.mdmsportal.uk').trim();
const PUBLIC_API_URL = String(process.env.PUBLIC_API_URL || 'https://qlog-api.mdmsportal.uk').trim();

const DATASETS = ['people','logs','books','borrowLogs','reservations','auditLogs','equipment','equipLogs','configData','dynamicFilterData','borrowPolicies'];
const ARRAY_DATASETS = new Set(['people','logs','books','borrowLogs','reservations','auditLogs','equipment','equipLogs']);
const INVENTORY_DATASETS = new Set(['books','equipment']);

if (!OFFICE_ACCESS_CODE || OFFICE_ACCESS_CODE === 'CHANGE-ME') console.warn('[QLog] WARNING: OFFICE_ACCESS_CODE is not configured.');
if (!REPORT_ADMIN_PASSWORD || REPORT_ADMIN_PASSWORD === 'CHANGE-ME') console.warn('[QLog] WARNING: REPORT_ADMIN_PASSWORD is not configured.');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new sqlite3.Database(DB_FILE);
db.configure('busyTimeout', 10000);

function run(sql, params = []) { return new Promise((resolve,reject)=>db.run(sql,params,function(err){err?reject(err):resolve({lastID:this.lastID,changes:this.changes});})); }
function get(sql, params = []) { return new Promise((resolve,reject)=>db.get(sql,params,(err,row)=>err?reject(err):resolve(row))); }
function all(sql, params = []) { return new Promise((resolve,reject)=>db.all(sql,params,(err,rows)=>err?reject(err):resolve(rows))); }
function exec(sql) { return new Promise((resolve,reject)=>db.exec(sql,err=>err?reject(err):resolve())); }
function nowIso(){return new Date().toISOString();}
function randomToken(bytes=32){return crypto.randomBytes(bytes).toString('hex');}
function tokenHash(token){return crypto.createHash('sha256').update(String(token)).digest('hex');}
function safeJson(value,fallback){try{return JSON.parse(value);}catch{return fallback;}}
function clampText(v,max=500){const s=v==null?'':String(v);return s.length>max?s.slice(0,max):s;}
function escapeHtml(v){return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function stableNormalize(value){
  if (Array.isArray(value)) return value.map(stableNormalize);
  if (value && typeof value === 'object') {
    const out={}; Object.keys(value).sort().forEach(k=>{ if(!['updatedAt','_qlogSync','_qlogMeta','serverRevision'].includes(k)) out[k]=stableNormalize(value[k]); }); return out;
  }
  return value;
}
function fingerprint(dataset,obj){
  const o=obj||{};
  let source;
  if(dataset==='people') source={id:o.id||'', employeeId:o.employeeId||o.learnerId||'', name:String(o.name||o.fullName||'').trim().toLowerCase(), type:o.type||''};
  else if(dataset==='books') source={isbn:String(o.isbn||o.ISBN||'').trim().toLowerCase(), title:String(o.title||o.bookTitle||o.name||'').trim().toLowerCase(), author:String(o.author||'').trim().toLowerCase(), accession:String(o.accessionNo||o.accession||'').trim().toLowerCase()};
  else if(dataset==='equipment') source={asset:String(o.assetNo||o.asset||'').trim().toLowerCase(), name:String(o.name||o.eqName||o.title||'').trim().toLowerCase(), serial:String(o.serialNo||o.serial||'').trim().toLowerCase(), type:String(o.type||'').trim().toLowerCase()};
  else if(dataset==='logs') source={id:o.id||'', date:o.date||'', timein:o.timein||'', name:String(o.name||'').trim().toLowerCase(), category:String(o.category||'').trim().toLowerCase(), reason:String(o.reason||'').trim().toLowerCase()};
  else if(dataset==='borrowLogs') source={borrower:String(o.b||'').trim().toLowerCase(), item:String(o.l||'').trim().toLowerCase(), borrowedAt:o.borrowedAt||'', qty:o.qty||'', returnedAt:o.returnedAt||''};
  else if(dataset==='reservations') source={isbn:o.isbn||'', learner:o.lId||o.learnerId||'', created:o.createdAt||o.reservedAt||'', status:o.status||''};
  else source=stableNormalize(o);
  return crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex');
}
function recordKey(dataset,obj,index){
  const o=obj||{};
  if(dataset==='people'||dataset==='books'||dataset==='equipment') return String(o.id||o.isbn||o.ISBN||o.assetNo||o.asset||o.ID||`${dataset}:${index}`);
  if(dataset==='logs') return [o.id||'',o.date||'',o.timein||'',o.category||'',o.name||''].join('|');
  if(dataset==='borrowLogs') return [o.l||'',o.b||'',o.borrowedAt||'',o.returnedAt||'',o.s||'',o.qty||''].join('|');
  if(dataset==='reservations') return [o.isbn||'',o.lId||o.learnerId||'',o.createdAt||o.reservedAt||'',o.status||''].join('|');
  if(dataset==='auditLogs') return [o.timestamp||'',o.action||'',o.details||''].join('|');
  if(dataset==='equipLogs') return String(o.ref||[o.eqId||'',o.borrowerId||'',o.borrowedMs||''].join('|'));
  return dataset;
}
function metadataFor(dataset,obj){
  const o=obj||{}; let date=o.date||o.returnDate||''; let name=o.name||o.learnerName||o.borrowerName||o.eqName||'';
  if(o.borrowedAt&&!date) date=String(o.borrowedAt).slice(0,10);
  return {date:clampText(date,80),name:clampText(name,240)};
}
function datasetToArray(value){return Array.isArray(value)?value:(value&&typeof value==='object'?[value]:[]);}

async function initDb(){
  await exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL UNIQUE,
      facility TEXT NOT NULL DEFAULT '', in_charge TEXT NOT NULL DEFAULT '', designation TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, data_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS records (
      source_id TEXT NOT NULL, dataset TEXT NOT NULL, record_key TEXT NOT NULL,
      record_json TEXT NOT NULL, record_date TEXT NOT NULL DEFAULT '', record_name TEXT NOT NULL DEFAULT '',
      fingerprint TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT DEFAULT NULL, updated_by TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(source_id,dataset,record_key), FOREIGN KEY(source_id) REFERENCES devices(source_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_records_dataset_date ON records(dataset,record_date);
    CREATE INDEX IF NOT EXISTS idx_records_dataset_fingerprint ON records(dataset,fingerprint);
    CREATE INDEX IF NOT EXISTS idx_records_source_updated ON records(source_id,updated_at);
    CREATE TABLE IF NOT EXISTS sync_aliases (
      source_id TEXT NOT NULL, dataset TEXT NOT NULL, incoming_key TEXT NOT NULL,
      canonical_source_id TEXT NOT NULL, canonical_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, PRIMARY KEY(source_id,dataset,incoming_key)
    );
    CREATE INDEX IF NOT EXISTS idx_alias_fp ON sync_aliases(dataset,source_id,fingerprint);
    CREATE TABLE IF NOT EXISTS sync_cursors (source_id TEXT PRIMARY KEY, last_pulled_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z', FOREIGN KEY(source_id) REFERENCES devices(source_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS sync_events (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, event_type TEXT NOT NULL, created_at TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}');
    CREATE INDEX IF NOT EXISTS idx_sync_events_created ON sync_events(created_at);
  `);
  // Safe additive migrations for databases created by the earlier package.
  for (const stmt of [
    "ALTER TABLE devices ADD COLUMN data_version INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE records ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE records ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE records ADD COLUMN deleted_at TEXT DEFAULT NULL",
    "ALTER TABLE records ADD COLUMN updated_by TEXT NOT NULL DEFAULT ''"
  ]) { try { await run(stmt); } catch(e) { if(!/duplicate column/i.test(e.message)) throw e; } }

  // Upgrade records made by the previous release and collapse exact duplicate inventory imports.
  const legacy = await all("SELECT source_id,dataset,record_key,record_json FROM records WHERE (fingerprint='' OR fingerprint IS NULL) AND dataset IN ('books','equipment')");
  for (const r of legacy) {
    const fp = fingerprint(r.dataset, safeJson(r.record_json, {}));
    if (fp) await run('UPDATE records SET fingerprint=? WHERE source_id=? AND dataset=? AND record_key=?',[fp,r.source_id,r.dataset,r.record_key]);
  }
  for (const dataset of INVENTORY_DATASETS) {
    const dupGroups = await all("SELECT source_id,fingerprint,COUNT(*) AS n FROM records WHERE dataset=? AND deleted_at IS NULL AND fingerprint<>'' GROUP BY source_id,fingerprint HAVING COUNT(*)>1",[dataset]);
    for (const g of dupGroups) {
      const dupRows = await all('SELECT source_id,record_key,fingerprint FROM records WHERE source_id=? AND dataset=? AND fingerprint=? AND deleted_at IS NULL ORDER BY updated_at ASC,record_key ASC',[g.source_id,dataset,g.fingerprint]);
      const canonical = dupRows[0];
      for (const d of dupRows.slice(1)) {
        await run(`INSERT INTO sync_aliases(source_id,dataset,incoming_key,canonical_source_id,canonical_key,fingerprint,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(source_id,dataset,incoming_key) DO UPDATE SET canonical_source_id=excluded.canonical_source_id,canonical_key=excluded.canonical_key,fingerprint=excluded.fingerprint,last_seen_at=excluded.last_seen_at`,[g.source_id,dataset,d.record_key,canonical.source_id,canonical.record_key,g.fingerprint,nowIso(),nowIso()]);
        await run('DELETE FROM records WHERE source_id=? AND dataset=? AND record_key=?',[g.source_id,dataset,d.record_key]);
      }
    }
  }
}

function parseBearer(req){const h=req.get('authorization')||'';return h.startsWith('Bearer ')?h.slice(7).trim():'';}
async function requireDevice(req,res,next){
  try{const token=parseBearer(req); if(!token)return res.status(401).json({ok:false,error:'DEVICE_AUTH_REQUIRED'});
    const row=await get('SELECT source_id,facility,in_charge,designation,role,data_version FROM devices WHERE token_hash=?',[tokenHash(token)]);
    if(!row)return res.status(401).json({ok:false,error:'INVALID_DEVICE_TOKEN'});
    req.device=row; await run('UPDATE devices SET last_seen_at=? WHERE source_id=?',[nowIso(),row.source_id]); next();
  }catch(e){next(e);}
}
const adminTokens=new Map();
function requireAdmin(req,res,next){const token=parseBearer(req);const item=token&&adminTokens.get(token);if(!item||item.expiresAt<Date.now()){if(token)adminTokens.delete(token);return res.status(401).json({ok:false,error:'ADMIN_AUTH_REQUIRED'});}next();}
function newAdminToken(){const token=randomToken();adminTokens.set(token,{expiresAt:Date.now()+12*60*60*1000});return token;}

const app=express(); const httpServer=http.createServer(app);
const allowedOrigins=CORS_ORIGIN==='*'?'*':CORS_ORIGIN.split(',').map(s=>s.trim());
const io=new SocketIOServer(httpServer,{cors:{origin:allowedOrigins,methods:['GET','POST']}});
app.disable('x-powered-by');
app.use(cors({origin:function(origin,cb){if(!origin||allowedOrigins==='*'||allowedOrigins.includes(origin))return cb(null,true);return cb(new Error('CORS origin not allowed'));},methods:['GET','POST','DELETE','OPTIONS']}));
app.use(express.json({limit:'60mb'})); app.use(express.urlencoded({extended:true,limit:'2mb'}));

app.get('/api/health',async(req,res)=>{try{const row=await get('SELECT COUNT(*) AS count FROM devices');res.json({ok:true,service:'QLog Pro Ultimate Central',db:'sqlite3',syncModel:'fingerprint+revision+tombstone',time:nowIso(),devices:row.count,publicApiUrl:PUBLIC_API_URL});}catch(e){res.status(500).json({ok:false,error:e.message});}});
app.post('/api/auth/device',async(req,res,next)=>{try{
  if(!OFFICE_ACCESS_CODE)return res.status(503).json({ok:false,error:'OFFICE_ACCESS_CODE_NOT_CONFIGURED'});
  const {accessCode,sourceId,facility,inCharge,designation,role}=req.body||{};
  if(String(accessCode||'')!==OFFICE_ACCESS_CODE)return res.status(403).json({ok:false,error:'INVALID_OFFICE_ACCESS_CODE'});
  if(!sourceId)return res.status(400).json({ok:false,error:'SOURCE_ID_REQUIRED'});
  let token=randomToken(); const existing=await get('SELECT id FROM devices WHERE source_id=?',[String(sourceId)]);
  const values=[tokenHash(token),clampText(facility,200),clampText(inCharge,200),clampText(designation,200),clampText(role,80),nowIso()];
  if(existing) await run('UPDATE devices SET token_hash=?,facility=?,in_charge=?,designation=?,role=?,last_seen_at=? WHERE source_id=?',[...values,String(sourceId)]);
  else await run('INSERT INTO devices(source_id,token_hash,facility,in_charge,designation,role,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?)',[String(sourceId),values[0],values[1],values[2],values[3],values[4],nowIso(),nowIso()]);
  res.json({ok:true,token,sourceId:String(sourceId)});
}catch(e){next(e);}});

async function canonicalForIncoming(sourceId,dataset,incomingKey,fp){
  const alias=await get('SELECT canonical_source_id,canonical_key FROM sync_aliases WHERE source_id=? AND dataset=? AND incoming_key=?',[sourceId,dataset,incomingKey]);
  if(alias)return {sourceId:alias.canonical_source_id,key:alias.canonical_key,alias:true};
  if(!INVENTORY_DATASETS.has(dataset))return {sourceId,key:incomingKey,alias:false};
  const row=await get('SELECT source_id,record_key FROM records WHERE dataset=? AND fingerprint=? AND deleted_at IS NULL AND source_id=? ORDER BY revision DESC LIMIT 1',[dataset,fp,sourceId]);
  if(row)return {sourceId:row.source_id,key:row.record_key,alias:true};
  return {sourceId,key:incomingKey,alias:false};
}

app.post('/api/sync',requireDevice,async(req,res,next)=>{try{
  const incoming=req.body&&req.body.datasets||{}; const changed=[]; const accepted=[]; const deduped=[]; const deleted=[]; const syncAt=nowIso();
  await run('BEGIN IMMEDIATE TRANSACTION');
  try{
    const device=req.body&&req.body.device||{};
    await run('UPDATE devices SET facility=?,in_charge=?,designation=?,role=?,last_seen_at=?,data_version=data_version+1 WHERE source_id=?',[clampText(device.facility||req.device.facility,200),clampText(device.inCharge||req.device.in_charge,200),clampText(device.designation||req.device.designation,200),clampText(device.role||req.device.role,80),syncAt,req.device.source_id]);
    for(const dataset of DATASETS){
      if(!Object.prototype.hasOwnProperty.call(incoming,dataset))continue;
      const value=incoming[dataset];
      if(!ARRAY_DATASETS.has(dataset)){
        const key=dataset, fp=fingerprint(dataset,value||{});
        const existing=await get('SELECT revision,record_json,updated_at FROM records WHERE source_id=? AND dataset=? AND record_key=?',[req.device.source_id,dataset,key]);
        const rev=(existing?existing.revision:0)+1;
        await run(`INSERT INTO records(source_id,dataset,record_key,record_json,record_date,record_name,fingerprint,updated_at,revision,deleted_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(source_id,dataset,record_key) DO UPDATE SET record_json=excluded.record_json,fingerprint=excluded.fingerprint,updated_at=excluded.updated_at,revision=records.revision+1,deleted_at=NULL,updated_by=excluded.updated_by`,
          [req.device.source_id,dataset,key,JSON.stringify(value||{}),'','',fp,syncAt,rev,null,req.device.source_id]);
        changed.push(dataset); continue;
      }
      const rows=Array.isArray(value)?value:[]; const seenKeys=new Set();
      for(let i=0;i<rows.length;i++){
        const obj=rows[i]||{}; const incomingKey=recordKey(dataset,obj,i); const fp=fingerprint(dataset,obj); seenKeys.add(incomingKey);
        const canonical=await canonicalForIncoming(req.device.source_id,dataset,incomingKey,fp);
        const meta=metadataFor(dataset,obj);
        const existing=await get('SELECT revision,record_json,fingerprint FROM records WHERE source_id=? AND dataset=? AND record_key=?',[canonical.sourceId,dataset,canonical.key]);
        if(canonical.alias){
          await run(`INSERT INTO sync_aliases(source_id,dataset,incoming_key,canonical_source_id,canonical_key,fingerprint,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?)
            ON CONFLICT(source_id,dataset,incoming_key) DO UPDATE SET canonical_source_id=excluded.canonical_source_id,canonical_key=excluded.canonical_key,fingerprint=excluded.fingerprint,last_seen_at=excluded.last_seen_at`,
            [req.device.source_id,dataset,incomingKey,canonical.sourceId,canonical.key,fp,syncAt,syncAt]);
          deduped.push({dataset,key:incomingKey,canonicalKey:canonical.key});
          continue;
        }
        // Only update the canonical record when content/version has changed. This makes retries idempotent.
        const oldFp=existing&&existing.fingerprint;
        if(oldFp===fp && existing) continue;
        const nextRev=(existing?existing.revision:0)+1;
        await run(`INSERT INTO records(source_id,dataset,record_key,record_json,record_date,record_name,fingerprint,updated_at,revision,deleted_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(source_id,dataset,record_key) DO UPDATE SET record_json=excluded.record_json,record_date=excluded.record_date,record_name=excluded.record_name,fingerprint=excluded.fingerprint,updated_at=excluded.updated_at,revision=records.revision+1,deleted_at=NULL,updated_by=excluded.updated_by`,
          [req.device.source_id,dataset,canonical.key,JSON.stringify(obj),meta.date,meta.name,fp,syncAt,nextRev,null,req.device.source_id]);
        accepted.push({dataset,key:canonical.key,revision:nextRev});
      }
      // Tombstone missing records/aliases for THIS source only. Tombstones preserve deletion knowledge for reconciliation.
      const current=await all('SELECT record_key FROM records WHERE source_id=? AND dataset=? AND deleted_at IS NULL',[req.device.source_id,dataset]);
      const protectedCanonical = new Set((await all('SELECT canonical_key FROM sync_aliases WHERE source_id=? AND dataset=?',[req.device.source_id,dataset])).map(x=>x.canonical_key));
      for(const r of current){
        if(!seenKeys.has(r.record_key) && !protectedCanonical.has(r.record_key)){
          await run('UPDATE records SET deleted_at=?,updated_at=?,revision=revision+1,updated_by=? WHERE source_id=? AND dataset=? AND record_key=?',[syncAt,syncAt,req.device.source_id,req.device.source_id,dataset,r.record_key]);
          deleted.push({dataset,key:r.record_key});
        }
      }
      // Remove aliases from the incoming snapshot that disappeared locally, but leave tombstone in canonical data if it exists.
      const aliases=await all('SELECT incoming_key FROM sync_aliases WHERE source_id=? AND dataset=?',[req.device.source_id,dataset]);
      for(const a of aliases) if(!seenKeys.has(a.incoming_key)) await run('DELETE FROM sync_aliases WHERE source_id=? AND dataset=? AND incoming_key=?',[req.device.source_id,dataset,a.incoming_key]);
      changed.push(dataset);
    }
    await run('INSERT INTO sync_events(source_id,event_type,created_at,details_json) VALUES(?,?,?,?)',[req.device.source_id,'SYNC',syncAt,JSON.stringify({changed,accepted:accepted.length,deduped:deduped.length,deleted:deleted.length})]);
    await run('INSERT INTO sync_cursors(source_id,last_pulled_at) VALUES(?,?) ON CONFLICT(source_id) DO NOTHING',[req.device.source_id]);
    await run('COMMIT');
  }catch(e){try{await run('ROLLBACK');}catch{} throw e;}
  io.emit('qlog:updated',{sourceId:req.device.source_id,changed,at:syncAt,facility:req.device.facility,counts:{accepted:accepted.length,deduped:deduped.length,deleted:deleted.length}});
  res.json({ok:true,sourceId:req.device.source_id,changed,accepted,deduped,deleted,syncedAt:syncAt});
}catch(e){next(e);}});

async function rowsForDevice(sourceId,since){
  const rows=await all(`SELECT dataset,record_key,record_json,record_date,record_name,fingerprint,updated_at,revision,deleted_at FROM records WHERE source_id=? AND updated_at>? ORDER BY updated_at ASC,revision ASC`,[sourceId,since]);
  const aliases=await all(`SELECT dataset,incoming_key,canonical_source_id,canonical_key,fingerprint,last_seen_at FROM sync_aliases WHERE source_id=? AND last_seen_at>? ORDER BY last_seen_at ASC`,[sourceId,since]);
  return {rows,aliases};
}

app.get('/api/reconcile',requireDevice,async(req,res,next)=>{try{
  const since=String(req.query.since||'1970-01-01T00:00:00.000Z');
  const payload=await rowsForDevice(req.device.source_id,since);
  res.json({ok:true,sourceId:req.device.source_id,since,serverTime:nowIso(),records:payload.rows.map(r=>({dataset:r.dataset,recordKey:r.record_key,data:safeJson(r.record_json,{}),recordDate:r.record_date,recordName:r.record_name,fingerprint:r.fingerprint,updatedAt:r.updated_at,revision:r.revision,deletedAt:r.deleted_at})),aliases:payload.aliases});
}catch(e){next(e);}});

app.get('/api/state',requireDevice,async(req,res,next)=>{try{
  const rows=await all('SELECT dataset,record_key,record_json,updated_at,revision,deleted_at FROM records WHERE source_id=? ORDER BY dataset,record_key',[req.device.source_id]);
  const aliases=await all('SELECT dataset,incoming_key,canonical_source_id,canonical_key FROM sync_aliases WHERE source_id=?',[req.device.source_id]);
  const datasets={}; for(const r of rows){if(r.deleted_at)continue;datasets[r.dataset] ||= []; const parsed=safeJson(r.record_json,null); if(r.record_key===r.dataset&&parsed&&!Array.isArray(parsed))datasets[r.dataset]=parsed;else datasets[r.dataset].push(parsed);}
  res.json({ok:true,sourceId:req.device.source_id,datasets,aliases,device:req.device,snapshotAt:nowIso()});
}catch(e){next(e);}});

async function centralRecords(dataset,limit=5000){
  const rows=await all('SELECT source_id,record_key,record_json,record_date,record_name,fingerprint,updated_at,revision,deleted_at FROM records WHERE dataset=? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?',[dataset,limit]);
  const out=[]; const seen=new Set();
  for(const r of rows){
    const key=INVENTORY_DATASETS.has(dataset)?`${dataset}|${r.fingerprint}`:`${r.source_id}|${r.record_key}`;
    if(seen.has(key))continue; seen.add(key); out.push({sourceId:r.source_id,recordKey:r.record_key,data:safeJson(r.record_json,{}),recordDate:r.record_date,recordName:r.record_name,fingerprint:r.fingerprint,updatedAt:r.updated_at,revision:r.revision});
  }
  return out;
}

app.post('/api/admin/login',async(req,res)=>{const password=String((req.body||{}).password||'');if(!REPORT_ADMIN_PASSWORD)return res.status(503).json({ok:false,error:'REPORT_ADMIN_PASSWORD_NOT_CONFIGURED'});if(password!==REPORT_ADMIN_PASSWORD)return res.status(403).json({ok:false,error:'INVALID_REPORT_ADMIN_PASSWORD'});res.json({ok:true,token:newAdminToken(),expiresInSeconds:43200});});
app.get('/api/admin/summary',requireAdmin,async(req,res,next)=>{try{
  const [devices,logs,visitors,people,books,borrowLogs,equipment,equipLogs]=await Promise.all([
    get('SELECT COUNT(*) AS n FROM devices'),get("SELECT COUNT(*) AS n FROM records WHERE dataset='logs' AND deleted_at IS NULL"),get("SELECT COUNT(*) AS n FROM records WHERE dataset='logs' AND deleted_at IS NULL AND UPPER(record_json) LIKE '%\"category\":\"VISITOR\"%'") ,get("SELECT COUNT(*) AS n FROM records WHERE dataset='people' AND deleted_at IS NULL"),get("SELECT COUNT(DISTINCT fingerprint) AS n FROM records WHERE dataset='books' AND deleted_at IS NULL AND fingerprint<>''"),get("SELECT COUNT(*) AS n FROM records WHERE dataset='borrowLogs' AND deleted_at IS NULL"),get("SELECT COUNT(DISTINCT fingerprint) AS n FROM records WHERE dataset='equipment' AND deleted_at IS NULL AND fingerprint<>''"),get("SELECT COUNT(*) AS n FROM records WHERE dataset='equipLogs' AND deleted_at IS NULL")
  ]);
  const recent=await all('SELECT source_id,event_type,created_at,details_json FROM sync_events ORDER BY id DESC LIMIT 15');
  const dupBooks=await all("SELECT fingerprint,COUNT(*) AS n FROM records WHERE dataset='books' AND deleted_at IS NULL GROUP BY fingerprint HAVING COUNT(*)>1 LIMIT 10");
  const dupEquip=await all("SELECT fingerprint,COUNT(*) AS n FROM records WHERE dataset='equipment' AND deleted_at IS NULL GROUP BY fingerprint HAVING COUNT(*)>1 LIMIT 10");
  res.json({ok:true,summary:{devices:devices.n,logs:logs.n,visitors:visitors.n,people:people.n,books:books.n,borrowLogs:borrowLogs.n,equipment:equipment.n,equipLogs:equipLogs.n},duplicateInventoryFingerprints:{books:dupBooks.length,equipment:dupEquip.length},recent});
}catch(e){next(e);}});
app.get('/api/admin/logs',requireAdmin,async(req,res,next)=>{try{const dataset=String(req.query.dataset||'logs');if(!DATASETS.includes(dataset))return res.status(400).json({ok:false,error:'INVALID_DATASET'});const limit=Math.min(Math.max(Number(req.query.limit||5000),1),20000);let rows=await centralRecords(dataset,limit);const category=String(req.query.category||'').trim().toUpperCase();const date=String(req.query.date||'').trim();if(category)rows=rows.filter(x=>String(x.data.category||'').toUpperCase()===category);if(date)rows=rows.filter(x=>String(x.data.date||x.recordDate||'')===date||String(x.recordDate||'')===date);res.json({ok:true,dataset,rows});}catch(e){next(e);}});
app.get('/api/admin/devices',requireAdmin,async(req,res,next)=>{try{res.json({ok:true,devices:await all('SELECT source_id,facility,in_charge,designation,role,created_at,last_seen_at,data_version FROM devices ORDER BY last_seen_at DESC')});}catch(e){next(e);}});
app.get('/api/admin/visitors/export.html',requireAdmin,async(req,res,next)=>{try{const rows=await centralRecords('logs',20000);const visitors=rows.filter(r=>String(r.data.category||'').toUpperCase()==='VISITOR');const body=visitors.map((r,i)=>{const d=r.data||{};const image=typeof d.face==='string'&&d.face.startsWith('data:image/')?`<img src="${escapeHtml(d.face)}" alt="Visitor image" loading="lazy">`:'<span class="noimg">No visitor image</span>';return `<tr><td>${i+1}</td><td>${escapeHtml(d.name)}</td><td>${escapeHtml(d.reason)}</td><td>${escapeHtml(d.timein)}</td><td>${escapeHtml(d.timeout||'')}</td><td>${escapeHtml(d.date)}</td><td>${escapeHtml(r.sourceId)}</td><td>${image}</td></tr>`;}).join('\n');res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>QLog Pro Ultimate — Central Visitor Logs</title><style>body{font-family:Arial,sans-serif;margin:24px;color:#0f172a}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border:1px solid #cbd5e1;padding:8px;font-size:12px;vertical-align:top}th{background:#f1f5f9}img{width:110px;height:82px;object-fit:cover;border-radius:8px;border:1px solid #cbd5e1}.noimg{color:#94a3b8}@media print{button{display:none}}</style></head><body><h1>QLog Pro Ultimate — Central Visitor Logs</h1><p>Generated ${escapeHtml(nowIso())}. Total visitor records: ${visitors.length}</p><button onclick="window.print()">Print</button><table><thead><tr><th>#</th><th>Name</th><th>Reason</th><th>Time In</th><th>Time Out</th><th>Date</th><th>Office Device</th><th>Visitor Image</th></tr></thead><tbody>${body||'<tr><td colspan="8">No visitor records.</td></tr>'}</tbody></table></body></html>`);}catch(e){next(e);}});
app.get('/api/admin/diagnostics',requireAdmin,async(req,res,next)=>{try{const size=fs.existsSync(DB_FILE)?fs.statSync(DB_FILE).size:0;res.json({ok:true,dbFile:DB_FILE,dbSizeBytes:size,publicApiUrl:PUBLIC_API_URL,corsOrigin:CORS_ORIGIN});}catch(e){next(e);}});

app.use('/central-assets',express.static(path.join(__dirname,'central-assets')));
app.get('/central.html',(req,res)=>res.sendFile(path.join(__dirname,'central.html')));
app.get('/',(req,res)=>res.redirect('/central.html'));
io.on('connection',socket=>socket.emit('qlog:connected',{ok:true,at:nowIso()}));
app.use((err,req,res,next)=>{console.error('[QLog] API error:',err);if(res.headersSent)return next(err);res.status(500).json({ok:false,error:'SERVER_ERROR',message:process.env.NODE_ENV==='production'?'Internal server error':err.message});});

(async()=>{await initDb();httpServer.listen(PORT,HOST,()=>console.log(`[QLog] Central API listening on http://${HOST}:${PORT} | public ${PUBLIC_API_URL}`));})();
