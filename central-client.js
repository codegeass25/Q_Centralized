/* QLog Pro Ultimate — Central SQLite/Socket.IO bridge
   The browser remains an offline-capable cache. Every relevant localStorage
   write is mirrored to the central SQLite database when the API is reachable.
*/
(function () {
  'use strict';

  var API_BASE = (localStorage.getItem('qlogApiUrl') || 'https://qlog-api.mdmsportal.uk').replace(/\/$/, '');
  var TOKEN_KEY = 'qlogCentralToken';
  var SOURCE_KEY = 'qlogCentralSourceId';
  var ACCESS_HINT_KEY = 'qlogCentralConnectedAt';
  var RECONCILE_KEY = 'qlogCentralReconcileAt';
  var SYNC_KEYS = ['people','logs','books','borrowLogs','reservations','auditLogs','equipment','equipLogs','configData','dynamicFilterData','borrowPolicies'];
  var state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    sourceId: localStorage.getItem(SOURCE_KEY) || '',
    syncing: false,
    suppress: false,
    pending: new Set(),
    timer: null,
    initialized: false,
    authInFlight: false,
    reconciling: false
  };

  function makeSourceId(){
    try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch(e) {}
    return 'QLOG-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,12);
  }
  if (!state.sourceId) { state.sourceId = makeSourceId(); localStorage.setItem(SOURCE_KEY, state.sourceId); }

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  function setStatus(text, kind){
    var el = document.getElementById('qlogCentralStatus');
    if(!el) return;
    el.textContent = text;
    el.dataset.kind = kind || 'idle';
    el.title = 'Central database: ' + text;
  }

  function injectUI(){
    if(document.getElementById('qlogCentralStatus')) return;
    var style = document.createElement('style');
    style.textContent = '.qlog-central-status{position:fixed;right:16px;bottom:16px;z-index:99999;padding:8px 12px;border-radius:999px;background:#0f172a;color:#fff;font:600 12px/1.2 Inter,Arial,sans-serif;box-shadow:0 4px 18px rgba(15,23,42,.2);opacity:.94}.qlog-central-status[data-kind="ok"]{background:#166534}.qlog-central-status[data-kind="warn"]{background:#a16207}.qlog-central-status[data-kind="err"]{background:#b91c1c}.qlog-central-modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(15,23,42,.55);z-index:100000;padding:20px}.qlog-central-card{width:min(460px,100%);background:#fff;border-radius:18px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.25);font-family:Inter,Arial,sans-serif;color:#0f172a}.qlog-central-card h3{margin:0 0 8px}.qlog-central-card p{color:#475569;font-size:13px;line-height:1.5}.qlog-central-card input{width:100%;box-sizing:border-box;margin-top:10px}.qlog-central-card .actions{display:flex;gap:10px;margin-top:14px}.qlog-central-card button{flex:1}';
    document.head.appendChild(style);
    var status = document.createElement('div'); status.id='qlogCentralStatus'; status.className='qlog-central-status'; status.textContent='Central sync: starting…'; document.body.appendChild(status);
    var modal = document.createElement('div'); modal.id='qlogCentralAuthModal'; modal.className='qlog-central-modal';
    modal.innerHTML = '<div class="qlog-central-card"><h3>🔐 Connect to Central Database</h3><p>This device needs the Office Access Code once. The code is used only to obtain a device token; it is not stored in the browser.</p><input id="qlogCentralCode" type="password" autocomplete="off" placeholder="Office Access Code"><div id="qlogCentralAuthError" style="min-height:18px;color:#b91c1c;font-size:12px;margin-top:7px"></div><div class="actions"><button type="button" style="background:#64748b" onclick="window.QLogCentral.closeAuth()">Not now</button><button type="button" onclick="window.QLogCentral.connect()">Connect</button></div></div>';
    document.body.appendChild(modal);
  }

  function openAuth(){
    injectUI();
    var m=document.getElementById('qlogCentralAuthModal'); if(m) m.style.display='flex';
    var i=document.getElementById('qlogCentralCode'); if(i){ i.value=''; setTimeout(function(){ i.focus(); },50); }
  }
  function closeAuth(){ var m=document.getElementById('qlogCentralAuthModal'); if(m) m.style.display='none'; }

  function headers(){ var h={'Content-Type':'application/json'}; if(state.token) h.Authorization='Bearer '+state.token; return h; }
  async function api(path, options){
    var opts=options||{}; opts.headers=Object.assign(headers(), opts.headers||{});
    var res = await fetch(API_BASE + path, opts);
    var data = null; try { data = await res.json(); } catch(e){}
    if(!res.ok){ var err=new Error(data && data.error ? data.error : ('HTTP '+res.status)); err.status=res.status; err.data=data; throw err; }
    return data;
  }

  async function connectWithCode(code){
    if(state.authInFlight) return;
    state.authInFlight=true; setStatus('Connecting…','warn');
    try{
      var d=await fetch(API_BASE+'/api/auth/device',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        accessCode: code,
        sourceId: state.sourceId,
        facility: (window.currentSession||{}).facility || '',
        inCharge: (window.currentSession||{}).inCharge || '',
        designation: (window.currentSession||{}).designation || '',
        role: (window.currentSession||{}).role || ''
      })});
      var j=await d.json();
      if(!d.ok) throw new Error(j.error||('HTTP '+d.status));
      state.token=j.token; localStorage.setItem(TOKEN_KEY,state.token); localStorage.setItem(ACCESS_HINT_KEY,new Date().toISOString());
      closeAuth();
      setStatus('Connected — syncing…','warn');
      await sync(true);
      setStatus('Central database synced','ok');
    }catch(e){
      var er=document.getElementById('qlogCentralAuthError'); if(er) er.textContent='Connection failed: '+e.message;
      setStatus('Central not connected','err');
    }finally{ state.authInFlight=false; }
  }

  function localInventoryFingerprint(o,name){
    o=o||{};
    function n(v){return String(v==null?'':v).trim().toLowerCase();}
    if(name==='books') return [n(o.isbn||o.ISBN),n(o.title||o.bookTitle||o.name),n(o.author),n(o.accessionNo||o.accession)].join('|');
    return [n(o.assetNo||o.asset),n(o.name||o.eqName||o.title),n(o.serialNo||o.serial),n(o.type||'')].join('|');
  }
  function dedupeLocal(name,value){
    if(name!=='books' && name!=='equipment' || !Array.isArray(value)) return value;
    var seen=new Set(), out=[];
    value.forEach(function(obj){
      var fp=localInventoryFingerprint(obj,name);
      if(seen.has(fp)) return;
      seen.add(fp); out.push(obj);
    });
    return out;
  }

  function collectDataset(name){
    if(name==='people') return Array.isArray(window.people)?window.people:[];
    if(name==='logs') return Array.isArray(window.logs)?window.logs:[];
    if(name==='books') return dedupeLocal(name, Array.isArray(window.books)?window.books:[]);
    if(name==='borrowLogs') return Array.isArray(window.borrowLogs)?window.borrowLogs:[];
    if(name==='reservations') return Array.isArray(window.reservations)?window.reservations:[];
    if(name==='auditLogs') return Array.isArray(window.auditLogs)?window.auditLogs:[];
    if(name==='equipment') return dedupeLocal(name, Array.isArray(window.equipment)?window.equipment:[]);
    if(name==='equipLogs') return Array.isArray(window.equipLogs)?window.equipLogs:[];
    if(name==='configData') return window.configData || {};
    if(name==='dynamicFilterData') return window.dynamicFilterData || {};
    if(name==='borrowPolicies') return window.borrowPolicies || {};
    return null;
  }
  function snapshot(names){
    var out={}; (names||SYNC_KEYS).forEach(function(n){ out[n]=collectDataset(n); }); return out;
  }

  function stableString(v){ try { return JSON.stringify(v); } catch(e){ return String(v); } }
  function hash(s){
    var h=2166136261;
    for(var i=0;i<s.length;i++){ h^=s.charCodeAt(i); h += (h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24); }
    return (h>>>0).toString(16);
  }

  function setDatasetLocal(name, value){
    try{
      state.suppress = true;
      if(name==='people') window.people = Array.isArray(value)?value:[];
      else if(name==='logs') window.logs = Array.isArray(value)?value:[];
      else if(name==='books') window.books = Array.isArray(value)?value:[];
      else if(name==='borrowLogs') window.borrowLogs = Array.isArray(value)?value:[];
      else if(name==='reservations') window.reservations = Array.isArray(value)?value:[];
      else if(name==='auditLogs') window.auditLogs = Array.isArray(value)?value:[];
      else if(name==='equipment') window.equipment = Array.isArray(value)?value:[];
      else if(name==='equipLogs') window.equipLogs = Array.isArray(value)?value:[];
      else if(name==='configData') window.configData = value || {};
      else if(name==='dynamicFilterData') window.dynamicFilterData = value || {};
      else if(name==='borrowPolicies') window.borrowPolicies = value || {};
      localStorage.setItem(name, JSON.stringify(value));
    }catch(e){} finally { state.suppress=false; }
  }

  function reconcileRows(resp){
    var touched = new Set();
    var grouped = {};
    (resp.records||[]).forEach(function(r){ if(SYNC_KEYS.indexOf(r.dataset)===-1) return; (grouped[r.dataset] ||= []).push(r); });
    Object.keys(grouped).forEach(function(dataset){
      var current = collectDataset(dataset);
      if(Array.isArray(current)){
        var byKey = {};
        current.forEach(function(obj, idx){
          var key = recordIdentity(dataset,obj,idx); byKey[key] = obj;
        });
        grouped[dataset].forEach(function(r){
          if(r.deletedAt){ delete byKey[r.recordKey]; return; }
          byKey[r.recordKey] = r.data;
        });
        var arr = Object.keys(byKey).map(function(k){return byKey[k];});
        setDatasetLocal(dataset, arr); touched.add(dataset);
      } else if(grouped[dataset].length){
        var latest = grouped[dataset][grouped[dataset].length-1];
        if(!latest.deletedAt) setDatasetLocal(dataset, latest.data); else setDatasetLocal(dataset, {});
        touched.add(dataset);
      }
    });
    var at = resp.serverTime || new Date().toISOString();
    localStorage.setItem(RECONCILE_KEY, at);
    return Array.from(touched);
  }

  function recordIdentity(dataset,o,index){
    o=o||{};
    if(dataset==='people'||dataset==='books'||dataset==='equipment') return String(o.id||o.isbn||o.ISBN||o.assetNo||o.asset||o.ID||dataset+':'+index);
    if(dataset==='logs') return [o.id||'',o.date||'',o.timein||'',o.category||'',o.name||''].join('|');
    if(dataset==='borrowLogs') return [o.l||'',o.b||'',o.borrowedAt||'',o.returnedAt||'',o.s||'',o.qty||''].join('|');
    if(dataset==='reservations') return [o.isbn||'',o.lId||o.learnerId||'',o.createdAt||o.reservedAt||'',o.status||''].join('|');
    if(dataset==='auditLogs') return [o.timestamp||'',o.action||'',o.details||''].join('|');
    if(dataset==='equipLogs') return String(o.ref||[o.eqId||'',o.borrowerId||'',o.borrowedMs||''].join('|'));
    return dataset;
  }

  async function reconcile(){
    if(state.reconciling || !state.token || !navigator.onLine) return;
    state.reconciling=true;
    try{
      var since=localStorage.getItem(RECONCILE_KEY)||'1970-01-01T00:00:00.000Z';
      var resp=await api('/api/reconcile?since='+encodeURIComponent(since));
      var touched=reconcileRows(resp);
      if(touched.length) setStatus('Central changes applied: '+touched.length+' data sets','ok');
    }catch(e){
      if(e.status===401){ state.token=''; localStorage.removeItem(TOKEN_KEY); setStatus('Access expired — reconnect','warn'); openAuth(); }
    }finally{ state.reconciling=false; }
  }

  async function sync(forceAll){
    if(state.syncing || !navigator.onLine) return;
    if(!state.token){ setStatus('Not connected to central','warn'); return; }
    state.syncing=true;
    try{
      var names = forceAll ? SYNC_KEYS.slice() : Array.from(state.pending);
      if(!names.length){ state.syncing=false; return; }
      var snap=snapshot(names);
      ['books','equipment'].forEach(function(n){ if(Object.prototype.hasOwnProperty.call(snap,n)){ var clean=dedupeLocal(n,snap[n]); if(clean.length !== snap[n].length) setDatasetLocal(n,clean); snap[n]=clean; }});
      var resp=await api('/api/sync',{method:'POST',body:JSON.stringify({version:'1.0.0',client:'QLog Pro Ultimate',datasets:snap,device:{facility:(window.currentSession||{}).facility||'',inCharge:(window.currentSession||{}).inCharge||'',designation:(window.currentSession||{}).designation||'',role:(window.currentSession||{}).role||''}})});
      state.pending.clear();
      await reconcile();
      setStatus('Central sync complete · deduped '+((resp.deduped||[]).length)+' record(s)','ok');
    }catch(e){
      if(e.status===401){ state.token=''; localStorage.removeItem(TOKEN_KEY); setStatus('Access expired — reconnect','warn'); openAuth(); }
      else setStatus('Central sync waiting for connection','warn');
    }finally{ state.syncing=false; }
  }
  function schedule(names){
    names=(names||SYNC_KEYS).filter(function(n){return SYNC_KEYS.indexOf(n)!==-1;});
    names.forEach(function(n){state.pending.add(n);});
    clearTimeout(state.timer); state.timer=setTimeout(function(){sync(false);},1400);
  }

  function patchStorage(){
    var ls=window.localStorage;
    if(!ls || ls.__qlogCentralPatched) return;
    var os=ls.setItem.bind(ls), or=ls.removeItem.bind(ls);
    ls.setItem=function(k,v){ os(k,v); if(!state.suppress && SYNC_KEYS.indexOf(k)!==-1) schedule([k]); };
    ls.removeItem=function(k){ or(k); if(!state.suppress && SYNC_KEYS.indexOf(k)!==-1) schedule([k]); };
    ls.__qlogCentralPatched=true;
  }

  function installSaveHooks(){
    if(typeof window.saveAll==='function' && !window.saveAll.__qlogWrapped){
      var old=window.saveAll; window.saveAll=function(){ var r=old.apply(this,arguments); schedule(['people','logs']); return r; }; window.saveAll.__qlogWrapped=true;
    }
    if(typeof window.saveEquipData==='function' && !window.saveEquipData.__qlogWrapped){
      var oldEq=window.saveEquipData; window.saveEquipData=function(){ var r=oldEq.apply(this,arguments); schedule(['equipment','equipLogs']); return r; }; window.saveEquipData.__qlogWrapped=true;
    }
  }

  async function init(){
    injectUI(); patchStorage(); installSaveHooks();
    if(!window.currentSession || !window.currentSession.facility){
      setStatus('Waiting for office session…','warn');
      setTimeout(init,1500);
      return;
    }
    if(!navigator.onLine){ setStatus('Offline — local data retained','warn'); return; }
    if(state.token){
      setStatus('Central connection ready','warn');
      await sync(true);
    } else {
      setStatus('Central access required','warn');
      openAuth();
    }
    setInterval(function(){ installSaveHooks(); if(navigator.onLine){ if(state.pending.size) sync(false); else { setStatus('Central database connected','ok'); reconcile(); } } },30000);
    window.addEventListener('online',function(){ setStatus('Online — syncing…','warn'); sync(true); reconcile(); });
    state.initialized=true;
  }

  window.QLogCentral={
    connect:function(){ var i=document.getElementById('qlogCentralCode'); if(i) connectWithCode(i.value.trim()); },
    closeAuth:closeAuth,
    sync:function(){ schedule(SYNC_KEYS); sync(true); },
    getApiBase:function(){return API_BASE;},
    getSourceId:function(){return state.sourceId;}
  };

  window.addEventListener('load',function(){
    setTimeout(init,1200);
  });
})();
