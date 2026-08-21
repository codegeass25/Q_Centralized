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
const DB_FILE = path.resolve(process.env.DB_FILE || path.join(__dirname, 'data', 'qlog-pro.sqlite3'));
const OFFICE_ACCESS_CODE = String(process.env.OFFICE_ACCESS_CODE || '').trim();
const REPORT_ADMIN_PASSWORD = String(process.env.REPORT_ADMIN_PASSWORD || '').trim();
const CORS_ORIGIN = String(process.env.CORS_ORIGIN || 'https://qlogproult.mdmsportal.uk').trim();
const PUBLIC_API_URL = String(process.env.PUBLIC_API_URL || 'https://qlog-api.mdmsportal.uk').trim();

const DATASETS = ['people','logs','books','borrowLogs','reservations','auditLogs','equipment','equipLogs','configData','dynamicFilterData','borrowPolicies'];
const ARRAY_DATASETS = new Set(['people','logs','books','borrowLogs','reservations','auditLogs','equipment','equipLogs']);
const PROFILE_DATASETS = new Set(DATASETS);
const INVENTORY_DATASETS = new Set(['books','equipment']);

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new sqlite3.Database(DB_FILE);
db.configure('busyTimeout', 10000);

function run(sql, params = []) { return new Promise((resolve,reject)=>db.run(sql,params,function(err){if(err)reject(err);else resolve({lastID:this.lastID,changes:this.changes});})); }
function get(sql, params = []) { return new Promise((resolve,reject)=>db.get(sql,params,(err,row)=>err?reject(err):resolve(row))); }
function all(sql, params = []) { return new Promise((resolve,reject)=>db.all(sql,params,(err,rows)=>err?reject(err):resolve(rows))); }
function exec(sql) { return new Promise((resolve,reject)=>db.exec(sql,err=>err?reject(err):resolve())); }
function nowIso(){return new Date().toISOString();}
function randomToken(bytes=32){return crypto.randomBytes(bytes).toString('hex');}
function tokenHash(token){return crypto.createHash('sha256').update(String(token)).digest('hex');}
function safeJson(value,fallback){try{return JSON.parse(value);}catch{return fallback;}}
function clampText(v,max=500){const s=v==null?'':String(v);return s.length>max?s.slice(0,max):s;}
function norm(v){return clampText(v,240).trim().replace(/\s+/g,' ');}
function profileKey(facility,inCharge){
  const s=`${String(facility||'').trim().toLowerCase()}|${String(inCharge||'').trim().toLowerCase()}`;
  let h=2166136261; for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h+=(h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24);} return (h>>>0).toString(16);
}
function stableNormalize(value){
  if(Array.isArray(value)) return value.map(stableNormalize);
  if(value&&typeof value==='object'){const out={};Object.keys(value).sort().forEach(k=>{if(!['_qlogCentral','_qlogServer','updatedAt','serverRevision'].includes(k))out[k]=stableNormalize(value[k]);});return out;}
  return value;
}
function fingerprint(dataset,obj){
  const o=obj||{}; let source;
  if(dataset==='people') source={id:o.id||'',employeeId:o.employeeId||o.learnerId||'',name:String(o.name||o.fullName||'').trim().toLowerCase(),type:o.type||''};
  else if(dataset==='books') source={isbn:String(o.isbn||o.ISBN||'').trim().toLowerCase(),title:String(o.title||o.bookTitle||o.name||'').trim().toLowerCase(),author:String(o.author||'').trim().toLowerCase(),accession:String(o.accessionNo||o.accession||'').trim().toLowerCase()};
  else if(dataset==='equipment') source={asset:String(o.assetNo||o.asset||'').trim().toLowerCase(),name:String(o.name||o.eqName||o.title||'').trim().toLowerCase(),serial:String(o.serialNo||o.serial||'').trim().toLowerCase(),type:String(o.type||'').trim().toLowerCase(),unit:String(o.unit||o.facility||'').trim().toLowerCase()};
  else if(dataset==='logs') source={id:o.id||'',date:o.date||'',timein:o.timein||'',name:String(o.name||'').trim().toLowerCase(),category:String(o.category||'').trim().toLowerCase(),reason:String(o.reason||'').trim().toLowerCase()};
  else if(dataset==='borrowLogs') source={borrower:String(o.b||'').trim().toLowerCase(),item:String(o.l||'').trim().toLowerCase(),borrowedAt:o.borrowedAt||'',qty:o.qty||'',returnedAt:o.returnedAt||''};
  else if(dataset==='reservations') source={isbn:o.isbn||'',learner:o.lId||o.learnerId||'',created:o.createdAt||o.reservedAt||'',status:o.status||''};
  else source=stableNormalize(o);
  return crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex');
}
function recordKey(dataset,obj,index=0){
  const o=obj||{};
  if(dataset==='people'||dataset==='books'||dataset==='equipment')return String(o.id||o.isbn||o.ISBN||o.assetNo||o.asset||o.ID||`${dataset}:${index}`);
  if(dataset==='logs')return [o.id||'',o.date||'',o.timein||'',o.category||'',o.name||''].join('|');
  if(dataset==='borrowLogs')return [o.l||'',o.b||'',o.borrowedAt||'',o.returnedAt||'',o.s||'',o.qty||''].join('|');
  if(dataset==='reservations')return [o.isbn||'',o.lId||o.learnerId||'',o.createdAt||o.reservedAt||'',o.status||''].join('|');
  if(dataset==='auditLogs')return [o.timestamp||'',o.action||'',o.details||''].join('|');
  if(dataset==='equipLogs')return String(o.ref||[o.eqId||'',o.borrowerId||'',o.borrowedMs||''].join('|'));
  return dataset;
}
function metadataFor(dataset,obj){const o=obj||{};let date=o.date||o.returnDate||'';if(o.borrowedAt&&!date)date=String(o.borrowedAt).slice(0,10);return{date:clampText(date,80),name:clampText(o.name||o.learnerName||o.borrowerName||o.eqName||'',240)};}

async function initDb(){
  await exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS devices(id INTEGER PRIMARY KEY AUTOINCREMENT,source_id TEXT NOT NULL UNIQUE,token_hash TEXT NOT NULL UNIQUE,facility TEXT NOT NULL DEFAULT '',in_charge TEXT NOT NULL DEFAULT '',designation TEXT NOT NULL DEFAULT '',role TEXT NOT NULL DEFAULT '',profile_key TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,data_version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS records(source_id TEXT NOT NULL,dataset TEXT NOT NULL,record_key TEXT NOT NULL,record_json TEXT NOT NULL,record_date TEXT NOT NULL DEFAULT '',record_name TEXT NOT NULL DEFAULT '',fingerprint TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,deleted_at TEXT DEFAULT NULL,updated_by TEXT NOT NULL DEFAULT '',facility TEXT NOT NULL DEFAULT '',profile_key TEXT NOT NULL DEFAULT '',PRIMARY KEY(source_id,dataset,record_key),FOREIGN KEY(source_id) REFERENCES devices(source_id) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS idx_records_dataset_date ON records(dataset,record_date);
    CREATE INDEX IF NOT EXISTS idx_records_dataset_fingerprint ON records(dataset,fingerprint);
    CREATE INDEX IF NOT EXISTS idx_records_source_updated ON records(source_id,updated_at);
    CREATE TABLE IF NOT EXISTS sync_aliases(source_id TEXT NOT NULL,dataset TEXT NOT NULL,incoming_key TEXT NOT NULL,canonical_source_id TEXT NOT NULL,canonical_key TEXT NOT NULL,fingerprint TEXT NOT NULL,created_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,PRIMARY KEY(source_id,dataset,incoming_key));
    CREATE TABLE IF NOT EXISTS sync_cursors(source_id TEXT PRIMARY KEY,last_pulled_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',FOREIGN KEY(source_id) REFERENCES devices(source_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS sync_events(id INTEGER PRIMARY KEY AUTOINCREMENT,source_id TEXT NOT NULL,event_type TEXT NOT NULL,created_at TEXT NOT NULL,details_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS profile_assignments(profile_key TEXT PRIMARY KEY,assignment_id TEXT NOT NULL UNIQUE,in_charge TEXT NOT NULL,facility TEXT NOT NULL,designation TEXT NOT NULL DEFAULT '',role TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'ACTIVE',started_at TEXT NOT NULL,ended_at TEXT DEFAULT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,archived_at TEXT DEFAULT NULL,replaced_by_profile_key TEXT DEFAULT NULL);
    CREATE INDEX IF NOT EXISTS idx_profile_assignments_facility ON profile_assignments(facility,status);
    CREATE INDEX IF NOT EXISTS idx_profile_assignments_incharge ON profile_assignments(in_charge,status);
    CREATE TABLE IF NOT EXISTS profile_records(profile_key TEXT NOT NULL,dataset TEXT NOT NULL,record_key TEXT NOT NULL,record_json TEXT NOT NULL,record_date TEXT NOT NULL DEFAULT '',record_name TEXT NOT NULL DEFAULT '',fingerprint TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,deleted_at TEXT DEFAULT NULL,updated_by TEXT NOT NULL DEFAULT '',facility TEXT NOT NULL DEFAULT '',in_charge TEXT NOT NULL DEFAULT '',PRIMARY KEY(profile_key,dataset,record_key));
    CREATE INDEX IF NOT EXISTS idx_profile_records_dataset ON profile_records(dataset,updated_at);
    CREATE INDEX IF NOT EXISTS idx_profile_records_fingerprint ON profile_records(profile_key,dataset,fingerprint);
    CREATE INDEX IF NOT EXISTS idx_profile_records_deleted ON profile_records(profile_key,dataset,deleted_at);
    CREATE TABLE IF NOT EXISTS profile_aliases(profile_key TEXT NOT NULL,dataset TEXT NOT NULL,incoming_key TEXT NOT NULL,canonical_key TEXT NOT NULL,fingerprint TEXT NOT NULL,created_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,PRIMARY KEY(profile_key,dataset,incoming_key));
    CREATE INDEX IF NOT EXISTS idx_profile_aliases_fp ON profile_aliases(profile_key,dataset,fingerprint);
  `);

  for(const stmt of [
    "ALTER TABLE devices ADD COLUMN data_version INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE records ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE records ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE records ADD COLUMN deleted_at TEXT DEFAULT NULL",
    "ALTER TABLE records ADD COLUMN updated_by TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE records ADD COLUMN facility TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE devices ADD COLUMN profile_key TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE records ADD COLUMN profile_key TEXT NOT NULL DEFAULT ''"
  ]){try{await run(stmt);}catch(e){if(!/duplicate column/i.test(e.message))throw e;}}

  const devices=await all("SELECT source_id,facility,in_charge,designation,role,profile_key FROM devices WHERE profile_key<>''");
  for(const d of devices){
    const exists=await get('SELECT profile_key FROM profile_assignments WHERE profile_key=?',[d.profile_key]);
    if(!exists){const ts=nowIso();await run('INSERT INTO profile_assignments(profile_key,assignment_id,in_charge,facility,designation,role,status,started_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',[d.profile_key,`ASSIGN-${d.profile_key}`,d.in_charge||'',d.facility||'',d.designation||'',d.role||'','ACTIVE',ts,ts,ts]);}
  }

  // One-time migration from the legacy device-scoped records table to the new profile-scoped canonical table.
  const legacy=await all("SELECT profile_key,dataset,record_key,record_json,record_date,record_name,fingerprint,updated_at,revision,deleted_at,updated_by,facility,source_id FROM records WHERE profile_key<>''");
  for(const r of legacy){
    const existing=await get('SELECT revision,updated_at FROM profile_records WHERE profile_key=? AND dataset=? AND record_key=?',[r.profile_key,r.dataset,r.record_key]);
    if(!existing || String(r.updated_at)>String(existing.updated_at)){
      const parsed=safeJson(r.record_json,{}); const fp=r.fingerprint||fingerprint(r.dataset,parsed); const pk=r.profile_key;
      const p=await get('SELECT in_charge,facility FROM profile_assignments WHERE profile_key=?',[pk]);
      await run(`INSERT INTO profile_records(profile_key,dataset,record_key,record_json,record_date,record_name,fingerprint,updated_at,revision,deleted_at,updated_by,facility,in_charge) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(profile_key,dataset,record_key) DO UPDATE SET record_json=excluded.record_json,record_date=excluded.record_date,record_name=excluded.record_name,fingerprint=excluded.fingerprint,updated_at=excluded.updated_at,revision=excluded.revision,deleted_at=excluded.deleted_at,updated_by=excluded.updated_by,facility=excluded.facility,in_charge=excluded.in_charge`,[pk,r.dataset,r.record_key,r.record_json,r.record_date||'',r.record_name||'',fp,r.updated_at,r.revision||1,r.deleted_at||null,r.updated_by||r.source_id,p?.facility||r.facility||'',p?.in_charge||'']);
    }
  }

  // Seed profile fingerprints/aliases for legacy inventory duplicates.
  for(const dataset of INVENTORY_DATASETS){
    const groups=await all("SELECT profile_key,fingerprint,COUNT(*) n FROM profile_records WHERE dataset=? AND deleted_at IS NULL AND fingerprint<>'' GROUP BY profile_key,fingerprint HAVING COUNT(*)>1",[dataset]);
    for(const g of groups){
      const rows=await all('SELECT record_key,fingerprint,updated_at FROM profile_records WHERE profile_key=? AND dataset=? AND fingerprint=? AND deleted_at IS NULL ORDER BY updated_at DESC,record_key DESC',[g.profile_key,dataset,g.fingerprint]);
      const canonical=rows[0];
      for(const dup of rows.slice(1)){
        await run(`INSERT INTO profile_aliases(profile_key,dataset,incoming_key,canonical_key,fingerprint,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(profile_key,dataset,incoming_key) DO UPDATE SET canonical_key=excluded.canonical_key,fingerprint=excluded.fingerprint,last_seen_at=excluded.last_seen_at`,[g.profile_key,dataset,dup.record_key,canonical.record_key,g.fingerprint,nowIso(),nowIso()]);
        await run('DELETE FROM profile_records WHERE profile_key=? AND dataset=? AND record_key=?',[g.profile_key,dataset,dup.record_key]);
      }
    }
  }
}

function parseBearer(req){const h=req.get('authorization')||'';return h.startsWith('Bearer ')?h.slice(7).trim():'';}
async function requireDevice(req,res,next){try{
  const token=parseBearer(req);if(!token)return res.status(401).json({ok:false,error:'DEVICE_AUTH_REQUIRED'});
  const row=await get(`SELECT d.source_id,d.facility,d.in_charge,d.designation,d.role,d.profile_key,d.data_version,COALESCE(p.status,'ACTIVE') profile_status,p.assignment_id FROM devices d LEFT JOIN profile_assignments p ON p.profile_key=d.profile_key WHERE d.token_hash=?`,[tokenHash(token)]);
  if(!row)return res.status(401).json({ok:false,error:'INVALID_DEVICE_TOKEN'});
  if(row.profile_status!=='ACTIVE')return res.status(403).json({ok:false,error:'PROFILE_ARCHIVED',profileKey:row.profile_key,assignmentId:row.assignment_id||''});
  req.device=row;await run('UPDATE devices SET last_seen_at=? WHERE source_id=?',[nowIso(),row.source_id]);next();
}catch(e){next(e);}}
const adminTokens=new Map();
function requireAdmin(req,res,next){const token=parseBearer(req);const item=token&&adminTokens.get(token);if(!item||item.expiresAt<Date.now()){if(token)adminTokens.delete(token);return res.status(401).json({ok:false,error:'ADMIN_AUTH_REQUIRED'});}next();}
function newAdminToken(){const token=randomToken();adminTokens.set(token,{expiresAt:Date.now()+12*60*60*1000});return token;}

const app=express();const httpServer=http.createServer(app);
function normalizeOrigin(value){const raw=String(value||'').trim();if(!raw)return '';try{const u=new URL(raw);return `${u.protocol}//${u.host}`.toLowerCase().replace(/\/$/,'');}catch{return raw.toLowerCase().replace(/\/$/,'');}}
const configuredOrigins=CORS_ORIGIN==='*'?'*':CORS_ORIGIN.split(',').map(normalizeOrigin).filter(Boolean);
const allowedOrigins=configuredOrigins==='*'?'*':Array.from(new Set([...(configuredOrigins||[]),normalizeOrigin('https://qlogproult.mdmsportal.uk')]));
function isAllowedOrigin(origin){if(!origin)return true;if(allowedOrigins==='*')return true;return allowedOrigins.includes(normalizeOrigin(origin));}
const io=new SocketIOServer(httpServer,{cors:{origin:(origin,cb)=>{if(isAllowedOrigin(origin))return cb(null,true);console.warn(`[QLog] Socket.IO CORS blocked origin: ${origin}`);return cb(new Error('CORS origin not allowed'));},methods:['GET','POST']}});
app.disable('x-powered-by');
app.use(cors({origin:(origin,cb)=>{if(isAllowedOrigin(origin))return cb(null,true);console.warn(`[QLog] HTTP CORS blocked origin: ${origin}`);return cb(new Error('CORS origin not allowed'));},methods:['GET','POST','DELETE','OPTIONS']}));
app.use(express.json({limit:'60mb'}));app.use(express.urlencoded({extended:true,limit:'2mb'}));

app.get('/api/health',async(req,res)=>{try{const row=await get("SELECT COUNT(*) n FROM devices");const profiles=await get("SELECT COUNT(*) n FROM profile_assignments WHERE status='ACTIVE'");res.json({ok:true,service:'QLog Pro Ultimate Central',db:'sqlite3',syncModel:'profile+fingerprint+revision+tombstone',time:nowIso(),devices:row.n,activeProfiles:profiles.n,publicApiUrl:PUBLIC_API_URL});}catch(e){res.status(500).json({ok:false,error:e.message});}});

app.post('/api/auth/device',async(req,res,next)=>{try{
  if(!OFFICE_ACCESS_CODE)return res.status(503).json({ok:false,error:'OFFICE_ACCESS_CODE_NOT_CONFIGURED'});
  const {accessCode,sourceId,facility,inCharge,designation,role}=req.body||{};
  if(String(accessCode||'')!==OFFICE_ACCESS_CODE)return res.status(403).json({ok:false,error:'INVALID_OFFICE_ACCESS_CODE'});
  if(!sourceId)return res.status(400).json({ok:false,error:'SOURCE_ID_REQUIRED'});
  const f=norm(facility),ic=norm(inCharge),dg=norm(designation),rl=norm(role);
  if(!f||!ic)return res.status(400).json({ok:false,error:'PROFILE_REQUIRED'});
  const pk=profileKey(f,ic),ts=nowIso(),token=randomToken();
  const assignment=await get('SELECT * FROM profile_assignments WHERE profile_key=?',[pk]);
  if(assignment&&assignment.status!=='ACTIVE')return res.status(403).json({ok:false,error:'PROFILE_ARCHIVED',profileKey:pk});
  if(!assignment)await run('INSERT INTO profile_assignments(profile_key,assignment_id,in_charge,facility,designation,role,status,started_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',[pk,`ASSIGN-${pk}`,ic,f,dg,rl,'ACTIVE',ts,ts,ts]);
  else await run('UPDATE profile_assignments SET designation=?,role=?,updated_at=? WHERE profile_key=?',[dg,rl,ts,pk]);
  const existing=await get('SELECT id FROM devices WHERE source_id=?',[String(sourceId)]);
  if(existing)await run('UPDATE devices SET token_hash=?,facility=?,in_charge=?,designation=?,role=?,profile_key=?,last_seen_at=? WHERE source_id=?',[tokenHash(token),f,ic,dg,rl,pk,ts,String(sourceId)]);
  else await run('INSERT INTO devices(source_id,token_hash,facility,in_charge,designation,role,profile_key,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?)',[String(sourceId),tokenHash(token),f,ic,dg,rl,pk,ts,ts]);
  res.json({ok:true,token,sourceId:String(sourceId),profileKey:pk,assignmentId:`ASSIGN-${pk}`,profile:{facility:f,inCharge:ic,designation:dg,role:rl,status:'ACTIVE'}});
}catch(e){next(e);}});

function datasetArrayFromInput(value){return Array.isArray(value)?value:[];}
async function canonicalKeyFor(profile,dataset,incomingKey,fp){
  const alias=await get('SELECT canonical_key FROM profile_aliases WHERE profile_key=? AND dataset=? AND incoming_key=?',[profile,dataset,incomingKey]);
  if(alias)return {key:alias.canonical_key,alias:true};
  if(!INVENTORY_DATASETS.has(dataset))return {key:incomingKey,alias:false};
  const row=await get('SELECT record_key FROM profile_records WHERE profile_key=? AND dataset=? AND fingerprint=? AND deleted_at IS NULL ORDER BY revision DESC,updated_at DESC LIMIT 1',[profile,dataset,fp]);
  if(row)return {key:row.record_key,alias:true};
  return {key:incomingKey,alias:false};
}
async function upsertProfileRecord(profile,device,dataset,key,obj,ts){
  const meta=metadataFor(dataset,obj);const fp=fingerprint(dataset,obj);const existing=await get('SELECT revision,fingerprint FROM profile_records WHERE profile_key=? AND dataset=? AND record_key=?',[profile,dataset,key]);
  const revision=(existing?existing.revision:0)+1;
  await run(`INSERT INTO profile_records(profile_key,dataset,record_key,record_json,record_date,record_name,fingerprint,updated_at,revision,deleted_at,updated_by,facility,in_charge) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(profile_key,dataset,record_key) DO UPDATE SET record_json=excluded.record_json,record_date=excluded.record_date,record_name=excluded.record_name,fingerprint=excluded.fingerprint,updated_at=excluded.updated_at,revision=profile_records.revision+1,deleted_at=NULL,updated_by=excluded.updated_by,facility=excluded.facility,in_charge=excluded.in_charge`,[profile,dataset,key,JSON.stringify(obj),meta.date,meta.name,fp,ts,revision,null,device.source_id,device.facility,device.in_charge]);
  return {key,revision,fingerprint:fp};
}

app.post('/api/sync',requireDevice,async(req,res,next)=>{try{
  const body=req.body||{};const incoming=body.datasets||{};const deletions=body.deletions||{};const changed=new Set();const accepted=[];const deduped=[];const deleted=[];const ts=nowIso();
  const requestedFacility=norm(body.device&&body.device.facility||'');const requestedInCharge=norm(body.device&&body.device.inCharge||'');
  if((requestedFacility||requestedInCharge)&&profileKey(requestedFacility||req.device.facility,requestedInCharge||req.device.in_charge)!==req.device.profile_key)return res.status(409).json({ok:false,error:'PROFILE_SCOPE_MISMATCH'});
  await run('BEGIN IMMEDIATE TRANSACTION');
  try{
    await run('UPDATE devices SET last_seen_at=?,data_version=data_version+1 WHERE source_id=?',[ts,req.device.source_id]);
    for(const dataset of DATASETS){
      if(!Object.prototype.hasOwnProperty.call(incoming,dataset))continue;
      const value=incoming[dataset];
      if(!ARRAY_DATASETS.has(dataset)){
        const key=dataset;const result=await upsertProfileRecord(req.device.profile_key,req.device,dataset,key,value||{},ts);accepted.push({dataset,key,revision:result.revision});changed.add(dataset);continue;
      }
      const rows=datasetArrayFromInput(value);
      for(let i=0;i<rows.length;i++){
        const obj=rows[i]||{};const incomingKey=recordKey(dataset,obj,i);const fp=fingerprint(dataset,obj);const canonical=await canonicalKeyFor(req.device.profile_key,dataset,incomingKey,fp);
        if(canonical.alias){
          await run(`INSERT INTO profile_aliases(profile_key,dataset,incoming_key,canonical_key,fingerprint,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(profile_key,dataset,incoming_key) DO UPDATE SET canonical_key=excluded.canonical_key,fingerprint=excluded.fingerprint,last_seen_at=excluded.last_seen_at`,[req.device.profile_key,dataset,incomingKey,canonical.key,fp,ts,ts]);
          deduped.push({dataset,key:incomingKey,canonicalKey:canonical.key});
          continue;
        }
        const existing=await get('SELECT revision,fingerprint FROM profile_records WHERE profile_key=? AND dataset=? AND record_key=?',[req.device.profile_key,dataset,canonical.key]);
        if(existing&&existing.fingerprint===fp)continue;
        const result=await upsertProfileRecord(req.device.profile_key,req.device,dataset,canonical.key,obj,ts);accepted.push({dataset,key:canonical.key,revision:result.revision});changed.add(dataset);
      }
    }
    // Explicit tombstones only. Never infer deletion from a device's missing local records.
    for(const dataset of DATASETS){
      const keys=Array.isArray(deletions[dataset])?deletions[dataset]:[];
      for(const key of keys){
        const k=String(key||'');if(!k)continue;
        const row=await get('SELECT revision FROM profile_records WHERE profile_key=? AND dataset=? AND record_key=?',[req.device.profile_key,dataset,k]);
        if(row){await run('UPDATE profile_records SET deleted_at=?,updated_at=?,revision=revision+1,updated_by=? WHERE profile_key=? AND dataset=? AND record_key=?',[ts,ts,req.device.source_id,req.device.profile_key,dataset,k]);deleted.push({dataset,key:k});changed.add(dataset);}
      }
    }
    await run('INSERT INTO sync_events(source_id,event_type,created_at,details_json) VALUES(?,?,?,?)',[req.device.source_id,'SYNC',ts,JSON.stringify({profileKey:req.device.profile_key,changed:Array.from(changed),accepted:accepted.length,deduped:deduped.length,deleted:deleted.length})]);
    await run('INSERT INTO sync_cursors(source_id,last_pulled_at) VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET last_pulled_at=excluded.last_pulled_at',[req.device.source_id,ts]);
    await run('COMMIT');
  }catch(e){try{await run('ROLLBACK');}catch{}throw e;}
  const evt={sourceId:req.device.source_id,profileKey:req.device.profile_key,facility:req.device.facility,inCharge:req.device.in_charge,changed:Array.from(changed),at:ts,counts:{accepted:accepted.length,deduped:deduped.length,deleted:deleted.length}};
  io.emit('qlog:updated',evt);
  res.json({ok:true,profileKey:req.device.profile_key,changed:Array.from(changed),accepted,deduped,deleted,syncedAt:ts});
}catch(e){next(e);}});

async function profileRows(profile,since){return await all(`SELECT profile_key,dataset,record_key,record_json,record_date,record_name,fingerprint,updated_at,revision,deleted_at,facility,in_charge FROM profile_records WHERE profile_key=? AND updated_at>? ORDER BY updated_at ASC,revision ASC`,[profile,since]);}
async function fullProfileRows(profile){return await all(`SELECT profile_key,dataset,record_key,record_json,record_date,record_name,fingerprint,updated_at,revision,deleted_at,facility,in_charge FROM profile_records WHERE profile_key=? ORDER BY dataset,updated_at ASC,revision ASC`,[profile]);}
function stateFromRows(rows){const datasets={};for(const r of rows){if(r.deleted_at)continue;datasets[r.dataset] ||= [];const parsed=safeJson(r.record_json,{});if(r.record_key===r.dataset&&parsed&&!Array.isArray(parsed))datasets[r.dataset]=parsed;else datasets[r.dataset].push(parsed);}return datasets;}

app.get('/api/reconcile',requireDevice,async(req,res,next)=>{try{
  const since=String(req.query.since||'1970-01-01T00:00:00.000Z');const rows=await profileRows(req.device.profile_key,since);res.json({ok:true,sourceId:req.device.source_id,facility:req.device.facility,inCharge:req.device.in_charge,profileKey:req.device.profile_key,since,serverTime:nowIso(),records:rows.map(r=>({dataset:r.dataset,recordKey:r.record_key,data:safeJson(r.record_json,{}),recordDate:r.record_date,recordName:r.record_name,fingerprint:r.fingerprint,updatedAt:r.updated_at,revision:r.revision,deletedAt:r.deleted_at,facility:r.facility,inCharge:r.in_charge,profileKey:r.profile_key}))});
}catch(e){next(e);}});

app.get('/api/state',requireDevice,async(req,res,next)=>{try{const rows=await fullProfileRows(req.device.profile_key);res.json({ok:true,sourceId:req.device.source_id,assignmentId:req.device.assignment_id||`ASSIGN-${req.device.profile_key}`,facility:req.device.facility,inCharge:req.device.in_charge,profileKey:req.device.profile_key,datasets:stateFromRows(rows),snapshotAt:nowIso()});}catch(e){next(e);}});
app.post('/api/profile/rebuild',requireDevice,async(req,res,next)=>{try{const rows=await fullProfileRows(req.device.profile_key);const ts=nowIso();await run('INSERT INTO sync_events(source_id,event_type,created_at,details_json) VALUES(?,?,?,?)',[req.device.source_id,'PROFILE_REBUILD',ts,JSON.stringify({profileKey:req.device.profile_key,recordCount:rows.length})]);res.json({ok:true,sourceId:req.device.source_id,assignmentId:req.device.assignment_id||`ASSIGN-${req.device.profile_key}`,facility:req.device.facility,inCharge:req.device.in_charge,profileKey:req.device.profile_key,datasets:stateFromRows(rows),snapshotAt:ts});}catch(e){next(e);}});

app.post('/api/admin/login',async(req,res)=>{const password=String((req.body||{}).password||'');if(!REPORT_ADMIN_PASSWORD)return res.status(503).json({ok:false,error:'REPORT_ADMIN_PASSWORD_NOT_CONFIGURED'});if(password!==REPORT_ADMIN_PASSWORD)return res.status(403).json({ok:false,error:'INVALID_REPORT_ADMIN_PASSWORD'});res.json({ok:true,token:newAdminToken(),expiresInSeconds:43200});});

app.get('/api/admin/profiles',requireAdmin,async(req,res,next)=>{try{res.json({ok:true,profiles:await all('SELECT profile_key,assignment_id,in_charge,facility,designation,role,status,started_at,ended_at,created_at,updated_at,archived_at,replaced_by_profile_key FROM profile_assignments ORDER BY status ASC,facility ASC,in_charge ASC')});}catch(e){next(e);}});
app.post('/api/admin/profiles/archive',requireAdmin,async(req,res,next)=>{try{const pk=norm((req.body||{}).profileKey);if(!pk)return res.status(400).json({ok:false,error:'PROFILE_KEY_REQUIRED'});const row=await get('SELECT profile_key,status FROM profile_assignments WHERE profile_key=?',[pk]);if(!row)return res.status(404).json({ok:false,error:'PROFILE_NOT_FOUND'});if(row.status==='ARCHIVED')return res.json({ok:true,alreadyArchived:true});const ts=nowIso();await run("UPDATE profile_assignments SET status='ARCHIVED',ended_at=?,archived_at=?,updated_at=? WHERE profile_key=?",[ts,ts,ts,pk]);for(const d of await all('SELECT source_id FROM devices WHERE profile_key=?',[pk]))await run('UPDATE devices SET token_hash=?,last_seen_at=? WHERE source_id=?',[tokenHash(randomToken()),ts,d.source_id]);await run('INSERT INTO sync_events(source_id,event_type,created_at,details_json) VALUES(?,?,?,?)',['CENTRAL_ADMIN','PROFILE_ARCHIVE',ts,JSON.stringify({profileKey:pk})]);io.emit('qlog:profile_changed',{profileKey:pk,action:'ARCHIVED'});res.json({ok:true,profileKey:pk,status:'ARCHIVED'});}catch(e){next(e);}});
app.post('/api/admin/profiles/restore',requireAdmin,async(req,res,next)=>{try{const pk=norm((req.body||{}).profileKey);if(!pk)return res.status(400).json({ok:false,error:'PROFILE_KEY_REQUIRED'});const row=await get('SELECT profile_key FROM profile_assignments WHERE profile_key=?',[pk]);if(!row)return res.status(404).json({ok:false,error:'PROFILE_NOT_FOUND'});const ts=nowIso();await run("UPDATE profile_assignments SET status='ACTIVE',ended_at=NULL,archived_at=NULL,updated_at=? WHERE profile_key=?",[ts,pk]);await run('INSERT INTO sync_events(source_id,event_type,created_at,details_json) VALUES(?,?,?,?)',['CENTRAL_ADMIN','PROFILE_RESTORE',ts,JSON.stringify({profileKey:pk})]);io.emit('qlog:profile_changed',{profileKey:pk,action:'RESTORED'});res.json({ok:true,profileKey:pk,status:'ACTIVE'});}catch(e){next(e);}});
app.post('/api/admin/profiles/transfer',requireAdmin,async(req,res,next)=>{try{const b=req.body||{};const fromPk=norm(b.fromProfileKey);const f=norm(b.facility);const ic=norm(b.inCharge);const dg=norm(b.designation||'In-Charge');const rl=norm(b.role||'incharge');if(!fromPk||!f||!ic)return res.status(400).json({ok:false,error:'TRANSFER_FIELDS_REQUIRED'});const source=await get('SELECT * FROM profile_assignments WHERE profile_key=?',[fromPk]);if(!source)return res.status(404).json({ok:false,error:'SOURCE_PROFILE_NOT_FOUND'});const newPk=profileKey(f,ic);const ts=nowIso();const existing=await get('SELECT * FROM profile_assignments WHERE profile_key=?',[newPk]);if(existing&&existing.status==='ARCHIVED')await run("UPDATE profile_assignments SET status='ACTIVE',ended_at=NULL,archived_at=NULL,replaced_by_profile_key=NULL,designation=?,role=?,updated_at=? WHERE profile_key=?",[dg,rl,ts,newPk]);else if(!existing)await run('INSERT INTO profile_assignments(profile_key,assignment_id,in_charge,facility,designation,role,status,started_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',[newPk,`ASSIGN-${newPk}`,ic,f,dg,rl,'ACTIVE',ts,ts,ts]);if(source.status!=='ARCHIVED'){await run("UPDATE profile_assignments SET status='ARCHIVED',ended_at=?,archived_at=?,updated_at=?,replaced_by_profile_key=? WHERE profile_key=?",[ts,ts,ts,newPk,fromPk]);for(const d of await all('SELECT source_id FROM devices WHERE profile_key=?',[fromPk]))await run('UPDATE devices SET token_hash=?,last_seen_at=? WHERE source_id=?',[tokenHash(randomToken()),ts,d.source_id]);}await run('INSERT INTO sync_events(source_id,event_type,created_at,details_json) VALUES(?,?,?,?)',['CENTRAL_ADMIN','PROFILE_TRANSFER',ts,JSON.stringify({fromProfileKey:fromPk,toProfileKey:newPk})]);io.emit('qlog:profile_changed',{profileKey:fromPk,action:'TRANSFERRED',replacedBy:newPk});io.emit('qlog:profile_changed',{profileKey:newPk,action:'CREATED'});res.json({ok:true,fromProfileKey:fromPk,toProfileKey:newPk,assignmentId:`ASSIGN-${newPk}`});}catch(e){next(e);}});

async function centralRecords(dataset,limit=5000){const rows=await all('SELECT profile_key,dataset,record_key,record_json,record_date,record_name,fingerprint,updated_at,revision,deleted_at,facility,in_charge FROM profile_records WHERE dataset=? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?',[dataset,limit]);const seen=new Set();const out=[];for(const r of rows){const key=INVENTORY_DATASETS.has(dataset)?`${dataset}|${r.profile_key}|${r.fingerprint}`:`${r.profile_key}|${r.record_key}`;if(seen.has(key))continue;seen.add(key);out.push({profileKey:r.profile_key,sourceId:'',recordKey:r.record_key,data:safeJson(r.record_json,{}),recordDate:r.record_date,recordName:r.record_name,fingerprint:r.fingerprint,updatedAt:r.updated_at,revision:r.revision,facility:r.facility,inCharge:r.in_charge});}return out;}

app.get('/api/admin/summary',requireAdmin,async(req,res,next)=>{try{const [devices,profiles,logs,visitors,people,books,borrowLogs,equipment,equipLogs]=await Promise.all([get('SELECT COUNT(*) n FROM devices'),get("SELECT COUNT(*) n FROM profile_assignments WHERE status='ACTIVE'"),get("SELECT COUNT(*) n FROM profile_records WHERE dataset='logs' AND deleted_at IS NULL"),get("SELECT COUNT(*) n FROM profile_records WHERE dataset='logs' AND deleted_at IS NULL AND UPPER(record_json) LIKE '%\"category\":\"VISITOR\"%'"),get("SELECT COUNT(*) n FROM profile_records WHERE dataset='people' AND deleted_at IS NULL"),get("SELECT COUNT(DISTINCT profile_key||'|'||fingerprint) n FROM profile_records WHERE dataset='books' AND deleted_at IS NULL AND fingerprint<>''"),get("SELECT COUNT(*) n FROM profile_records WHERE dataset='borrowLogs' AND deleted_at IS NULL"),get("SELECT COUNT(DISTINCT profile_key||'|'||fingerprint) n FROM profile_records WHERE dataset='equipment' AND deleted_at IS NULL AND fingerprint<>''"),get("SELECT COUNT(*) n FROM profile_records WHERE dataset='equipLogs' AND deleted_at IS NULL")]);const recent=await all('SELECT source_id,event_type,created_at,details_json FROM sync_events ORDER BY id DESC LIMIT 20');res.json({ok:true,summary:{devices:devices.n,activeProfiles:profiles.n,logs:logs.n,visitors:visitors.n,people:people.n,books:books.n,borrowLogs:borrowLogs.n,equipment:equipment.n,equipLogs:equipLogs.n},recent});}catch(e){next(e);}});
app.get('/api/admin/logs',requireAdmin,async(req,res,next)=>{try{const dataset=String(req.query.dataset||'logs');if(!DATASETS.includes(dataset))return res.status(400).json({ok:false,error:'INVALID_DATASET'});const limit=Math.min(Math.max(Number(req.query.limit||5000),1),20000);let rows=await centralRecords(dataset,limit);const category=String(req.query.category||'').trim().toUpperCase();const date=String(req.query.date||'').trim();if(category)rows=rows.filter(x=>String(x.data.category||'').toUpperCase()===category);if(date)rows=rows.filter(x=>String(x.data.date||x.recordDate||'')===date||String(x.recordDate||'')===date);res.json({ok:true,dataset,rows});}catch(e){next(e);}});
app.get('/api/admin/devices',requireAdmin,async(req,res,next)=>{try{res.json({ok:true,devices:await all(`SELECT d.source_id,d.facility,d.in_charge,d.designation,d.role,d.profile_key,d.created_at,d.last_seen_at,d.data_version,COALESCE(p.status,'ACTIVE') profile_status,p.assignment_id FROM devices d LEFT JOIN profile_assignments p ON p.profile_key=d.profile_key ORDER BY d.last_seen_at DESC`)});}catch(e){next(e);}});
app.get('/api/admin/visitors/export.html',requireAdmin,async(req,res,next)=>{try{const rows=await centralRecords('logs',20000);const visitors=rows.filter(r=>String(r.data.category||'').toUpperCase()==='VISITOR');const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const body=visitors.map((r,i)=>{const d=r.data||{};const image=typeof d.face==='string'&&d.face.startsWith('data:image/')?`<img src="${esc(d.face)}" alt="Visitor image" loading="lazy">`:'<span>No visitor image</span>';return `<tr><td>${i+1}</td><td>${esc(d.name)}</td><td>${esc(d.reason)}</td><td>${esc(d.timein)}</td><td>${esc(d.timeout||'')}</td><td>${esc(d.date)}</td><td>${esc(r.inCharge)}<br>${esc(r.facility)}</td><td>${image}</td></tr>`;}).join('');res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>QLog Pro Ultimate — Central Visitor Logs</title><style>body{font-family:Arial,sans-serif;margin:24px;color:#0f172a}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border:1px solid #cbd5e1;padding:8px;font-size:12px;vertical-align:top}th{background:#f1f5f9}img{width:110px;height:82px;object-fit:cover;border-radius:8px;border:1px solid #cbd5e1}@media print{button{display:none}}</style></head><body><h1>QLog Pro Ultimate — Central Visitor Logs</h1><p>Generated ${esc(nowIso())}. Total visitor records: ${visitors.length}</p><button onclick="window.print()">Print</button><table><thead><tr><th>#</th><th>Name</th><th>Reason</th><th>Time In</th><th>Time Out</th><th>Date</th><th>In-Charge / Office</th><th>Visitor Image</th></tr></thead><tbody>${body||'<tr><td colspan="8">No visitor records.</td></tr>'}</tbody></table></body></html>`);}catch(e){next(e);}});
app.get('/api/admin/diagnostics',requireAdmin,async(req,res,next)=>{try{const size=fs.existsSync(DB_FILE)?fs.statSync(DB_FILE).size:0;res.json({ok:true,dbFile:DB_FILE,dbSizeBytes:size,publicApiUrl:PUBLIC_API_URL,corsOrigin:CORS_ORIGIN});}catch(e){next(e);}});

app.use('/central-assets',express.static(path.join(__dirname,'central-assets')));
app.get('/central.html',(req,res)=>res.sendFile(path.join(__dirname,'central.html')));
app.get('/',(req,res)=>res.redirect('/central.html'));
app.use((err,req,res,next)=>{console.error('[QLog] API error:',err);if(res.headersSent)return next(err);res.status(err.status||500).json({ok:false,error:err.code||'SERVER_ERROR',message:process.env.NODE_ENV==='production'?'Internal server error':err.message});});
io.on('connection',socket=>socket.emit('qlog:connected',{ok:true,at:nowIso()}));

(async()=>{try{await initDb();httpServer.listen(PORT,HOST,()=>console.log(`[QLog] Central API listening on http://${HOST}:${PORT} | public ${PUBLIC_API_URL}`));}catch(e){console.error('[QLog] Database initialization failed:',e);process.exit(1);}})();
