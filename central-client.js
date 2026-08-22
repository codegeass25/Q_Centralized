/* QLog Pro Ultimate — Profile-Scoped Central Sync
   Authority: authenticated In-Charge profile = assigned office/lab scope.
   Same profile on multiple devices => shared central state.
   Different profile => no central fetch until re-authenticated.
*/
(function () {
  'use strict';

  var API_BASE = (localStorage.getItem('qlogApiUrl') || 'https://qlog-api.mdmsportal.uk').replace(/\/$/, '');
  var TOKEN_KEY = 'qlogCentralToken';
  var SOURCE_KEY = 'qlogCentralSourceId';
  var ACCESS_HINT_KEY = 'qlogCentralConnectedAt';
  var ACTIVE_FACILITY_KEY = 'qlogCentralActiveFacility';
  var ACTIVE_PROFILE_KEY = 'qlogCentralActiveProfile';
  var RECONCILE_PREFIX = 'qlogCentralReconcileAt::';
  var CACHE_PREFIX = 'qlogProfileCache::';
  var RESET_KEY = 'qlogCentralResetRequested';
  var CENTRAL_RESET_GENERATION_KEY = 'qlogCentralResetGeneration';
  var RESET_HOLD_KEY = 'qlogCentralResetHold::';
  var DELETE_QUEUE_PREFIX = 'qlogCentralDeleteQueue::';

  var SYNC_KEYS = ['people','logs','books','borrowLogs','reservations','auditLogs','equipment','equipLogs','configData','dynamicFilterData','borrowPolicies'];
  var PROFILE_DATASETS = ['people','logs','books','borrowLogs','reservations','auditLogs','equipment','equipLogs'];
  var GLOBAL_DATASETS = ['configData','dynamicFilterData','borrowPolicies'];

  var statusTimer = null;

  var state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    sourceId: localStorage.getItem(SOURCE_KEY) || '',
    activeFacility: localStorage.getItem(ACTIVE_FACILITY_KEY) || '',
    activeProfileKey: localStorage.getItem(ACTIVE_PROFILE_KEY) || '',
    syncing: false,
    suppress: false,
    pending: new Set(),
    timer: null,
    authInFlight: false,
    reconciling: false,
    switchingProfile: false,
    socket: null
  };

  function makeSourceId(){
    try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch(e) {}
    return 'QLOG-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,12);
  }
  if (!state.sourceId) {
    state.sourceId = makeSourceId();
    localStorage.setItem(SOURCE_KEY, state.sourceId);
  }

  function normalize(v){ return String(v == null ? '' : v).trim().replace(/\s+/g,' '); }
  function currentFacility(){ return normalize((window.currentSession||{}).facility || ''); }
  function currentInCharge(){ return normalize((window.currentSession||{}).inCharge || ''); }
  function currentDesignation(){ return normalize((window.currentSession||{}).designation || ''); }
  function currentRole(){ return normalize((window.currentSession||{}).role || ''); }
  function currentScope(){ return currentFacility().toLowerCase() + '|' + currentInCharge().toLowerCase(); }
  function scopeLabel(){ return currentInCharge() + ' — ' + currentFacility(); }
  function hashScope(scope){
    var s = String(scope || '').toLowerCase();
    var h = 2166136261;
    for(var i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h += (h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24); }
    return (h>>>0).toString(16);
  }
  function scopeId(){ return hashScope(currentScope()); }
  function cacheKey(scope,dataset){ return CACHE_PREFIX + hashScope(scope) + '::' + dataset; }
  function reconcileKey(scope){ return RECONCILE_PREFIX + hashScope(scope); }

  function setStatus(text,kind){
    var el=document.getElementById('qlogCentralStatus');
    if(!el)return;
    if(statusTimer) clearTimeout(statusTimer);
    el.textContent=text;
    el.dataset.kind=kind||'idle';
    el.title='Central database: '+text;
    el.classList.add('show');
    statusTimer=setTimeout(function(){
      el.classList.remove('show');
    },2600);
  }

  function injectUI(){
    if(document.getElementById('qlogCentralStatus')) return;
    var style=document.createElement('style');
    style.textContent='.qlog-central-status{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(14px);z-index:99999;padding:9px 14px;border-radius:999px;background:#0f172a;color:#fff;font:600 12px/1.2 Inter,Arial,sans-serif;box-shadow:0 4px 18px rgba(15,23,42,.2);opacity:0;pointer-events:none;transition:opacity .2s ease,transform .2s ease}.qlog-central-status.show{opacity:.96;transform:translateX(-50%) translateY(0)}.qlog-central-status[data-kind="ok"]{background:#166534}.qlog-central-status[data-kind="warn"]{background:#a16207}.qlog-central-status[data-kind="err"]{background:#b91c1c}.qlog-central-modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(15,23,42,.55);z-index:100000;padding:20px}.qlog-central-card{width:min(460px,100%);background:#fff;border-radius:18px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.25);font-family:Inter,Arial,sans-serif;color:#0f172a}.qlog-central-card h3{margin:0 0 8px}.qlog-central-card p{color:#475569;font-size:13px;line-height:1.5}.qlog-central-card input{width:100%;box-sizing:border-box;margin-top:10px}.qlog-central-card .actions{display:flex;gap:10px;margin-top:14px}.qlog-central-card button{flex:1}';
    document.head.appendChild(style);
    var status=document.createElement('div');
    status.id='qlogCentralStatus';
    status.className='qlog-central-status';
    status.textContent='Central sync: starting…';
    document.body.appendChild(status);
    var modal=document.createElement('div');
    modal.id='qlogCentralAuthModal';
    modal.className='qlog-central-modal';
    modal.innerHTML='<div class="qlog-central-card"><h3>🔐 Connect to Central Database</h3><p>Central data is anchored to the authenticated In-Charge profile and assigned office/laboratory. This device can only fetch records for the profile shown below.</p><div id="qlogCentralProfile" style="margin:10px 0;padding:10px;background:#f1f5f9;border-radius:10px;font-size:13px;font-weight:700;"></div><input id="qlogCentralCode" type="password" autocomplete="off" placeholder="Office Access Code"><div id="qlogCentralAuthError" style="min-height:18px;color:#b91c1c;font-size:12px;margin-top:7px"></div><div class="actions"><button type="button" style="background:#64748b" onclick="window.QLogCentral.closeAuth()">Not now</button><button type="button" onclick="window.QLogCentral.connect()">Connect</button></div></div>';
    document.body.appendChild(modal);
  }
  function openAuth(){
    injectUI();
    var p=document.getElementById('qlogCentralProfile'); if(p)p.textContent=scopeLabel();
    var m=document.getElementById('qlogCentralAuthModal'); if(m)m.style.display='flex';
    var i=document.getElementById('qlogCentralCode'); if(i){i.value='';setTimeout(function(){i.focus();},50);}
  }
  function closeAuth(){ var m=document.getElementById('qlogCentralAuthModal'); if(m)m.style.display='none'; }
  function headers(){ var h={'Content-Type':'application/json'}; if(state.token)h.Authorization='Bearer '+state.token; return h; }
  async function api(path,options){
    var opts=options||{};
    opts.headers=Object.assign(headers(),opts.headers||{});
    var res=await fetch(API_BASE+path,opts);
    var data=null; try{data=await res.json();}catch(e){}
    if(!res.ok){var err=new Error(data&&data.error?data.error:('HTTP '+res.status));err.status=res.status;err.data=data;throw err;}
    return data;
  }

  function localInventoryFingerprint(o,name){
    o=o||{}; function n(v){return String(v==null?'':v).trim().toLowerCase();}
    if(name==='books') return [n(o.isbn||o.ISBN),n(o.title||o.bookTitle||o.name),n(o.author),n(o.accessionNo||o.accession)].join('|');
    return [n(o.assetNo||o.asset),n(o.name||o.eqName||o.title),n(o.serialNo||o.serial),n(o.type||''),n(o.unit||o.facility||'')].join('|');
  }
  function dedupeLocal(name,value){
    if((name!=='books'&&name!=='equipment')||!Array.isArray(value))return value;
    var seen=new Set(),out=[];
    value.forEach(function(obj){var fp=localInventoryFingerprint(obj,name);if(seen.has(fp))return;seen.add(fp);out.push(obj);});
    return out;
  }
  function collectDataset(name){
    if(name==='people')return Array.isArray(window.people)?window.people:[];
    if(name==='logs')return Array.isArray(window.logs)?window.logs:[];
    if(name==='books')return dedupeLocal(name,Array.isArray(window.books)?window.books:[]);
    if(name==='borrowLogs')return Array.isArray(window.borrowLogs)?window.borrowLogs:[];
    if(name==='reservations')return Array.isArray(window.reservations)?window.reservations:[];
    if(name==='auditLogs')return Array.isArray(window.auditLogs)?window.auditLogs:[];
    if(name==='equipment')return dedupeLocal(name,Array.isArray(window.equipment)?window.equipment:[]);
    if(name==='equipLogs')return Array.isArray(window.equipLogs)?window.equipLogs:[];
    if(name==='configData')return window.configData||{};
    if(name==='dynamicFilterData')return window.dynamicFilterData||{};
    if(name==='borrowPolicies')return window.borrowPolicies||{};
    return null;
  }
  function snapshot(names){var out={};(names||SYNC_KEYS).forEach(function(n){out[n]=collectDataset(n);});return out;}

  function setDatasetLocal(name,value,cacheIt){
    try{
      state.suppress=true;
      if(name==='people')window.people=Array.isArray(value)?value:[];
      else if(name==='logs')window.logs=Array.isArray(value)?value:[];
      else if(name==='books')window.books=Array.isArray(value)?value:[];
      else if(name==='borrowLogs')window.borrowLogs=Array.isArray(value)?value:[];
      else if(name==='reservations')window.reservations=Array.isArray(value)?value:[];
      else if(name==='auditLogs')window.auditLogs=Array.isArray(value)?value:[];
      else if(name==='equipment')window.equipment=Array.isArray(value)?value:[];
      else if(name==='equipLogs')window.equipLogs=Array.isArray(value)?value:[];
      else if(name==='configData')window.configData=value||{};
      else if(name==='dynamicFilterData')window.dynamicFilterData=value||{};
      else if(name==='borrowPolicies')window.borrowPolicies=value||{};
      localStorage.setItem(name,JSON.stringify(value));
      if(cacheIt!==false && state.activeProfileKey && PROFILE_DATASETS.indexOf(name)!==-1){
        localStorage.setItem(cacheKey(currentScope(),name),JSON.stringify(value));
      }
    }catch(e){}finally{state.suppress=false;}
  }
  function saveProfileCache(scope){
    if(!scope)return;
    PROFILE_DATASETS.forEach(function(name){try{localStorage.setItem(cacheKey(scope,name),JSON.stringify(collectDataset(name)));}catch(e){}});
  }
  function hasProfileCache(scope){
    return PROFILE_DATASETS.some(function(name){return localStorage.getItem(cacheKey(scope,name))!==null;});
  }
  function loadProfileCache(scope){
    PROFILE_DATASETS.forEach(function(name){
      var raw=localStorage.getItem(cacheKey(scope,name));
      if(raw!==null){try{setDatasetLocal(name,JSON.parse(raw),false);}catch(e){setDatasetLocal(name,[],false);}}
      else setDatasetLocal(name,[],false);
    });
  }

  function recordIdentity(dataset,o,index){
    o=o||{};
    if(dataset==='people'||dataset==='books'||dataset==='equipment')return String(o.id||o.isbn||o.ISBN||o.assetNo||o.asset||o.ID||dataset+':'+index);
    if(dataset==='logs')return [o.id||'',o.date||'',o.timein||'',o.category||'',o.name||''].join('|');
    if(dataset==='borrowLogs')return [o.l||'',o.b||'',o.borrowedAt||'',o.returnedAt||'',o.s||'',o.qty||''].join('|');
    if(dataset==='reservations')return [o.isbn||'',o.lId||o.learnerId||'',o.createdAt||o.reservedAt||'',o.status||''].join('|');
    if(dataset==='auditLogs')return [o.timestamp||'',o.action||'',o.details||''].join('|');
    if(dataset==='equipLogs')return String(o.ref||[o.eqId||'',o.borrowerId||'',o.borrowedMs||''].join('|'));
    return dataset;
  }
  function mergeProfileDatasets(dataset,rows){
    var map={},inventorySeen={};
    (rows||[]).forEach(function(r){
      if(r.deletedAt)return;
      var d=r.data||{},key=recordIdentity(dataset,d,0);
      if(dataset==='books'||dataset==='equipment'){
        var fp=String(r.fingerprint||localInventoryFingerprint(d,dataset));
        var logical=dataset+'|'+fp;
        if(inventorySeen[logical]){
          if((inventorySeen[logical].updatedAt||'') < (r.updatedAt||'')) inventorySeen[logical]=r;
          return;
        }
        inventorySeen[logical]=r; key=logical;
      }
      map[key]=r;
    });
    var out=Object.keys(map).sort(function(a,b){return String(map[a].updatedAt||'').localeCompare(String(map[b].updatedAt||''));}).map(function(k){return map[k].data;});
    return (dataset==='books'||dataset==='equipment')?dedupeLocal(dataset,out):out;
  }
  function applyFullState(resp){
    var datasets=resp&&resp.datasets||{};
    PROFILE_DATASETS.forEach(function(name){
      var rows=[],value=datasets[name];
      if(Array.isArray(value))rows=value.map(function(data){return {data:data,updatedAt:''};});
      else if(value&&typeof value==='object')rows=[{data:value,updatedAt:''}];
      setDatasetLocal(name,mergeProfileDatasets(name,rows),true);
    });
    localStorage.setItem(reconcileKey(currentScope()),resp.snapshotAt||new Date().toISOString());
    clearDeleteQueue(currentScope());
    refreshUi();
  }
  function applyDelta(resp){
    var grouped={};
    (resp.records||[]).forEach(function(r){if(SYNC_KEYS.indexOf(r.dataset)!==-1)(grouped[r.dataset] ||= []).push(r);});
    Object.keys(grouped).forEach(function(dataset){
      var current=collectDataset(dataset);
      if(!Array.isArray(current))return;
      var rows=current.map(function(data){return {data:data,updatedAt:''};});
      grouped[dataset].forEach(function(r){
        var key=recordIdentity(dataset,r.data,0);
        rows=rows.filter(function(x){return recordIdentity(dataset,x.data,0)!==key;});
        if(!r.deletedAt)rows.push({data:r.data,updatedAt:r.updatedAt||''});
      });
      setDatasetLocal(dataset,mergeProfileDatasets(dataset,rows),true);
    });
    localStorage.setItem(reconcileKey(currentScope()),resp.serverTime||new Date().toISOString());
    refreshUi();
  }
  function refreshUi(){
    try{if(typeof renderPeople==='function')renderPeople();}catch(e){}
    try{if(typeof renderLogs==='function')renderLogs();}catch(e){}
    try{if(typeof renderBookInventory==='function')renderBookInventory();}catch(e){}
    try{if(typeof refreshEquipmentUI==='function')refreshEquipmentUI();}catch(e){}
    try{if(typeof renderBorrow==='function')renderBorrow();}catch(e){}
  }

  function deleteQueueKey(scope){ return DELETE_QUEUE_PREFIX + hashScope(scope); }
  function readDeleteQueue(scope){
    try{return JSON.parse(localStorage.getItem(deleteQueueKey(scope))||'{}')||{};}catch(e){return {};}
  }
  function writeDeleteQueue(scope,q){ try{localStorage.setItem(deleteQueueKey(scope),JSON.stringify(q||{}));}catch(e){} }
  function clearDeleteQueue(scope){ try{localStorage.removeItem(deleteQueueKey(scope));}catch(e){} }
  function queueDeletedDifference(name,oldValue,newValue){
    if(PROFILE_DATASETS.indexOf(name)===-1 || !Array.isArray(oldValue) || !Array.isArray(newValue)) return;
    var now={},q=readDeleteQueue(currentScope());
    oldValue.forEach(function(item,i){now[recordIdentity(name,item,i)]=true;});
    newValue.forEach(function(item,i){delete now[recordIdentity(name,item,i)];});
    Object.keys(now).forEach(function(k){q[name] ||= [];if(q[name].indexOf(k)===-1)q[name].push(k);});
    writeDeleteQueue(currentScope(),q);
  }

  function clearLocalProfileData(){
    state.suppress=true;
    try{
      PROFILE_DATASETS.forEach(function(name){
        localStorage.removeItem(name);
        if(state.activeProfileKey) localStorage.removeItem(cacheKey(currentScope(),name));
      });
      localStorage.removeItem(RECONCILE_PREFIX+hashScope(currentScope()));
      state.pending.clear();
      window.people=[]; window.logs=[]; window.books=[]; window.borrowLogs=[]; window.reservations=[]; window.auditLogs=[]; window.equipment=[]; window.equipLogs=[];
      ['people','logs','books','borrowLogs','reservations','auditLogs','equipment','equipLogs'].forEach(function(name){try{localStorage.setItem(name,'[]');}catch(e){}});
      clearDeleteQueue(currentScope());
      /* Reset is LOCAL ONLY. It intentionally does not rebuild and does not send tombstones. */
      localStorage.setItem(RESET_HOLD_KEY+hashScope(currentScope()),new Date().toISOString());
      localStorage.removeItem(RESET_KEY);
    }finally{state.suppress=false;}
    refreshUi();
    try{ if(typeof renderEquipRegistry==='function') renderEquipRegistry(); }catch(e){}
    try{ if(typeof renderEquipLogs==='function') renderEquipLogs(); }catch(e){}
    try{ if(typeof refreshEquipmentUI==='function') refreshEquipmentUI(); }catch(e){}
  }

  function localResetHeld(scope){
    return !!localStorage.getItem(RESET_HOLD_KEY+hashScope(scope));
  }

  function clearLocalResetHold(scope){
    localStorage.removeItem(RESET_HOLD_KEY+hashScope(scope));
  }

  function clearAllCentralClientCaches(){
    if(state.socket){
      try{state.socket.disconnect();}catch(e){}
      state.socket=null;
    }
    state.syncing=false;
    state.reconciling=false;
    state.pending.clear();
    clearTimeout(state.timer);
    state.timer=null;
    var prefixes=[CACHE_PREFIX,RECONCILE_PREFIX,DELETE_QUEUE_PREFIX,RESET_HOLD_KEY];
    var exact=[RESET_KEY,TOKEN_KEY,ACTIVE_PROFILE_KEY,ACTIVE_FACILITY_KEY,ACCESS_HINT_KEY];
    var keys=[];
    for(var i=0;i<localStorage.length;i++){
      var key=localStorage.key(i);
      if(!key)continue;
      for(var p=0;p<prefixes.length;p++){
        if(key.indexOf(prefixes[p])===0){keys.push(key);break;}
      }
    }
    keys.forEach(function(key){localStorage.removeItem(key);});
    exact.forEach(function(key){localStorage.removeItem(key);});
    ['people','logs','books','borrowLogs','reservations','auditLogs','equipment','equipLogs'].forEach(function(name){
      localStorage.removeItem(name);
      try{localStorage.setItem(name,'[]');}catch(e){}
    });
    state.token='';
    state.activeProfileKey='';
    state.activeFacility='';
    state.pending.clear();
    window.people=[];window.logs=[];window.books=[];window.borrowLogs=[];window.reservations=[];window.auditLogs=[];window.equipment=[];window.equipLogs=[];
    refreshUi();
  }

  async function activateSync(mode){
    if(!state.token || !navigator.onLine) throw new Error('PROFILE_AUTH_REQUIRED');
    var generation=Number(localStorage.getItem(CENTRAL_RESET_GENERATION_KEY)||0);
    return await api('/api/device/activate-sync',{method:'POST',body:JSON.stringify({mode:mode||'existing',centralResetGeneration:generation})});
  }

  async function requestProfileRebuild(){
    if(!state.token||!navigator.onLine||!currentFacility()||!currentInCharge()) throw new Error('PROFILE_AUTH_REQUIRED');
    try{
      return await api('/api/profile/rebuild');
    }catch(e){
      if(e.status===404||e.status===405){
        return await api('/api/profile/rebuild',{method:'POST',body:JSON.stringify({reason:'USER_REQUESTED_REBUILD'})});
      }
      throw e;
    }
  }

  async function rebuildMyOffice(){
    if(!state.token||!navigator.onLine||!currentFacility()||!currentInCharge()){
      openAuth();
      throw new Error('PROFILE_AUTH_REQUIRED');
    }
    try{
      setStatus('Rebuilding '+scopeLabel()+' from Central…','warn');
      var resp=await requestProfileRebuild();
      if(resp.profileKey&&state.activeProfileKey&&resp.profileKey!==state.activeProfileKey)throw Object.assign(new Error('PROFILE_SCOPE_MISMATCH'),{status:409});
      applyFullState(resp);
      clearLocalResetHold(currentScope());
      localStorage.removeItem(RESET_KEY);
      saveProfileCache(currentScope());
      setStatus('Office data rebuilt from Central','ok');
      return resp;
    }catch(e){
      if(e.status===401||e.status===403||e.status===409){
        state.token='';state.activeProfileKey='';localStorage.removeItem(TOKEN_KEY);localStorage.removeItem(ACTIVE_PROFILE_KEY);
        setStatus(e.data&&e.data.error==='PROFILE_ARCHIVED'?'Profile is archived — contact Central Admin':'Profile authentication required','warn');
        openAuth();
      }else{
        setStatus('Office rebuild failed — '+(e.data&&e.data.error||e.message||'Central unavailable'),'err');
      }
      throw e;
    }
  }

  async function resetThisDevice(){
    var label=scopeLabel();
    if(!state.token||state.activeProfileKey!==scopeId()){
      openAuth();
      return;
    }
    if(!confirm('Reset THIS DEVICE only for '+label+'?\n\nThis clears the data shown in all office tabs on this device.\n\nCENTRAL RECORDS WILL NOT BE DELETED.\n\nNo automatic rebuild will happen. Use "Rebuild My Office Data" when you are ready to restore the office copy.')) return;
    try{
      clearLocalProfileData();
      setStatus('This device was reset. Central records are untouched. Click Rebuild My Office Data to restore.','ok');
      alert('This device has been reset.\n\nCentral records were NOT deleted.\n\nNo automatic rebuild was performed.\nUse "Rebuild My Office Data" when you are ready to restore the office data.');
    }catch(e){
      setStatus('Device reset failed — '+(e.message||'Unknown error'),'err');
      throw e;
    }
  }

  async function fullProfileReconcile(){
    if(localResetHeld(currentScope())) return;
    if(!state.token||!navigator.onLine||!currentFacility()||!currentInCharge())return;
    try{
      var resp=await api('/api/state');
      if(resp.profileKey && state.activeProfileKey && resp.profileKey!==state.activeProfileKey)throw Object.assign(new Error('PROFILE_SCOPE_MISMATCH'),{status:409});
      applyFullState(resp); state.activeProfileKey=resp.profileKey||state.activeProfileKey;
      if(state.activeProfileKey)localStorage.setItem(ACTIVE_PROFILE_KEY,state.activeProfileKey);
      setStatus('Central '+scopeLabel()+' synced','ok');
    }catch(e){
      if(e.status===401||e.status===403||e.status===409){state.token='';state.activeProfileKey='';localStorage.removeItem(TOKEN_KEY);localStorage.removeItem(ACTIVE_PROFILE_KEY);setStatus(e.status===403 && e.data && e.data.error==='PROFILE_ARCHIVED'?'Profile is archived — contact Central Admin':(e.status===409?'Profile scope changed — reconnect':'Access expired — reconnect'),'warn');openAuth();}
      else setStatus('Central reconcile waiting for connection','warn');
    }
  }
  async function reconcile(){
    if(localResetHeld(currentScope())) return;
    if(state.reconciling||!state.token||!navigator.onLine||!currentFacility()||!currentInCharge())return;
    state.reconciling=true;
    try{
      var since=localStorage.getItem(reconcileKey(currentScope()))||'1970-01-01T00:00:00.000Z';
      var resp=await api('/api/reconcile?since='+encodeURIComponent(since));
      if(resp.profileKey && state.activeProfileKey && resp.profileKey!==state.activeProfileKey)throw Object.assign(new Error('PROFILE_SCOPE_MISMATCH'),{status:409});
      applyDelta(resp);
    }catch(e){
      if(e.status===401||e.status===403||e.status===409){state.token='';state.activeProfileKey='';localStorage.removeItem(TOKEN_KEY);localStorage.removeItem(ACTIVE_PROFILE_KEY);setStatus('Profile authentication required','warn');openAuth();}
    }finally{state.reconciling=false;}
  }

  async function connectWithCode(code){
    if(state.authInFlight)return;
    state.authInFlight=true; setStatus('Authenticating '+scopeLabel()+'…','warn');
    try{
      var facility=currentFacility(),inCharge=currentInCharge();
      if(!facility||!inCharge)throw new Error('PROFILE_REQUIRED');
      var d=await fetch(API_BASE+'/api/auth/device',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accessCode:code,sourceId:state.sourceId,facility:facility,inCharge:inCharge,designation:currentDesignation(),role:currentRole()})});
      var j=await d.json().catch(function(){return{};}); if(!d.ok)throw new Error(j.error||('HTTP '+d.status));
      state.token=j.token; state.activeFacility=facility; state.activeProfileKey=j.profileKey||scopeId();
      var serverGeneration=Number(j.centralResetGeneration||0);
      var storedGenerationRaw=localStorage.getItem(CENTRAL_RESET_GENERATION_KEY);
      var storedGeneration=storedGenerationRaw===null?null:Number(storedGenerationRaw);
      var resetGenerationMismatch=(serverGeneration>0 && storedGeneration!==serverGeneration);

      if(resetGenerationMismatch){
        clearAllCentralClientCaches();
        state.token=j.token;
        state.activeFacility=facility;
        state.activeProfileKey=j.profileKey||scopeId();
      }

      localStorage.setItem(CENTRAL_RESET_GENERATION_KEY,String(serverGeneration));
      localStorage.setItem(TOKEN_KEY,state.token);
      localStorage.setItem(ACTIVE_FACILITY_KEY,facility);
      localStorage.setItem(ACTIVE_PROFILE_KEY,state.activeProfileKey);
      localStorage.setItem(ACCESS_HINT_KEY,new Date().toISOString());

      var resetRequested=!!localStorage.getItem(RESET_KEY);
      var held=localResetHeld(currentScope());
      var cached=hasProfileCache(currentScope());

      if(resetGenerationMismatch){
        PROFILE_DATASETS.forEach(function(name){setDatasetLocal(name,[],false);});
        localStorage.removeItem(RESET_KEY);
        clearLocalResetHold(currentScope());
        await activateSync('empty');
        setStatus('Central database was reset. '+scopeLabel()+' is EMPTY. Click Rebuild My Office Data only if you intentionally want to restore Central data.','warn');
      }else if(held){
        PROFILE_DATASETS.forEach(function(name){setDatasetLocal(name,[],false);});
        await activateSync('empty');
        setStatus('Connected to Central. Local device is reset; use Rebuild My Office Data to restore.','warn');
      }else if(resetRequested || !cached){
        await activateSync('existing');
        await fullProfileReconcile();
        saveProfileCache(currentScope());
        localStorage.removeItem(RESET_KEY);
      }else{
        loadProfileCache(currentScope());
        await activateSync('existing');
        await sync(true);
        await fullProfileReconcile();
      }
      closeAuth(); connectSocket();
      if(!held) setStatus('Central '+scopeLabel()+' connected','ok');
    }catch(e){
      var er=document.getElementById('qlogCentralAuthError'); if(er)er.textContent='Connection failed: '+e.message;
      setStatus('Central not connected','err');
    }finally{state.authInFlight=false;}
  }

  async function switchProfile(){
    var scope=currentScope(); if(!scope||state.switchingProfile)return;
    state.switchingProfile=true;
    try{
      var active=state.activeProfileKey;
      if(active && active!==scopeId()){
        if(state.activeFacility)saveProfileCache(active);
        state.token=''; state.activeProfileKey='';
        localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(ACTIVE_PROFILE_KEY);
        state.activeFacility=currentFacility(); localStorage.setItem(ACTIVE_FACILITY_KEY,state.activeFacility);
        if(hasProfileCache(scope))loadProfileCache(scope); else {PROFILE_DATASETS.forEach(function(n){setDatasetLocal(n,[],false);});}
        refreshUi(); openAuth(); setStatus('Profile changed — authenticate '+scopeLabel(),'warn');
        return;
      }
      state.activeFacility=currentFacility(); localStorage.setItem(ACTIVE_FACILITY_KEY,state.activeFacility);
      if(state.token){
        if(hasProfileCache(scope)){loadProfileCache(scope);await sync(true);await fullProfileReconcile();}
        else{await fullProfileReconcile();saveProfileCache(scope);}
      }
    }finally{state.switchingProfile=false;}
  }

  async function sync(forceAll){
    if(state.syncing||!navigator.onLine||!state.token||!state.activeProfileKey)return;
    if(state.activeProfileKey!==scopeId())return;
    state.syncing=true;
    try{
      var names=forceAll?SYNC_KEYS.slice():Array.from(state.pending);
      var deleteQueue=readDeleteQueue(currentScope());
      var hasDeletes=Object.keys(deleteQueue).some(function(k){return Array.isArray(deleteQueue[k])&&deleteQueue[k].length;});
      if(!names.length && !hasDeletes)return;
      var snap=snapshot(names);
      ['books','equipment'].forEach(function(n){
        if(Object.prototype.hasOwnProperty.call(snap,n)){
          var clean=dedupeLocal(n,snap[n]); if(clean.length!==snap[n].length)setDatasetLocal(n,clean); snap[n]=clean;
        }
      });
      var resp=await api('/api/sync',{method:'POST',body:JSON.stringify({version:'5.0.0',client:'QLog Pro Ultimate',datasets:snap,deletions:deleteQueue,device:{facility:currentFacility(),inCharge:currentInCharge(),designation:currentDesignation(),role:currentRole()}})});
      state.pending.clear(); clearDeleteQueue(currentScope()); await reconcile();
      setStatus('Central sync complete · '+scopeLabel()+' · deduped '+((resp.deduped||[]).length),'ok');
    }catch(e){
      if(e.status===401||e.status===403){state.token='';state.activeProfileKey='';localStorage.removeItem(TOKEN_KEY);localStorage.removeItem(ACTIVE_PROFILE_KEY);setStatus('Profile authentication required','warn');openAuth();}
      else if(e.status===409 && e.data && (e.data.error==='SYNC_NOT_ACTIVATED'||e.data.error==='CENTRAL_RESET_REQUIRED')){setStatus('Central reset state detected. Reconnect before syncing.','warn');openAuth();}
      else setStatus('Central sync waiting for connection','warn');
    }finally{state.syncing=false;}
  }
  function schedule(names){
    names=(names||SYNC_KEYS).filter(function(n){return SYNC_KEYS.indexOf(n)!==-1;});
    names.forEach(function(n){state.pending.add(n);});
    clearTimeout(state.timer); state.timer=setTimeout(function(){sync(false);},900);
  }
  function patchStorage(){
    var ls=window.localStorage; if(!ls||ls.__qlogCentralPatched)return;
    var os=ls.setItem.bind(ls),or=ls.removeItem.bind(ls);
    ls.setItem=function(k,v){
      var before=null;
      if(!state.suppress&&SYNC_KEYS.indexOf(k)!==-1){try{before=JSON.parse(ls.getItem(k)||'null');}catch(e){}}
      os(k,v);
      if(!state.suppress&&SYNC_KEYS.indexOf(k)!==-1){
        try{queueDeletedDifference(k,before,JSON.parse(v));}catch(e){}
        schedule([k]);
      }
    };
    ls.removeItem=function(k){
      var before=null;
      if(!state.suppress&&SYNC_KEYS.indexOf(k)!==-1){try{before=JSON.parse(ls.getItem(k)||'null');}catch(e){}}
      or(k);
      if(!state.suppress&&SYNC_KEYS.indexOf(k)!==-1){
        if(Array.isArray(before)){var q=readDeleteQueue(currentScope());q[k]=(q[k]||[]).concat(before.map(function(item,i){return recordIdentity(k,item,i);}).filter(function(x){return q[k].indexOf(x)===-1;}));writeDeleteQueue(currentScope(),q);}
        schedule([k]);
      }
    };
    ls.__qlogCentralPatched=true;
  }
  function installSaveHooks(){
    if(typeof window.saveAll==='function'&&!window.saveAll.__qlogWrapped){var old=window.saveAll;window.saveAll=function(){var r=old.apply(this,arguments);schedule(['people','logs']);return r;};window.saveAll.__qlogWrapped=true;}
    if(typeof window.saveEquipData==='function'&&!window.saveEquipData.__qlogWrapped){var oldEq=window.saveEquipData;window.saveEquipData=function(){var r=oldEq.apply(this,arguments);schedule(['equipment','equipLogs']);return r;};window.saveEquipData.__qlogWrapped=true;}
  }
  function connectSocket(){
    if(state.socket||!state.token||!navigator.onLine)return;
    try{
      var s=document.createElement('script'); s.src=API_BASE+'/socket.io/socket.io.js';
      s.onload=function(){
        try{
          if(typeof window.io!=='function')return;
          state.socket=window.io(API_BASE,{auth:{token:state.token},transports:['websocket','polling']});
          state.socket.on('qlog:updated',function(evt){
            if(!evt)return;
            if(evt.profileKey && state.activeProfileKey && evt.profileKey!==state.activeProfileKey)return;
            reconcile();
          });
          state.socket.on('qlog:central_reset',function(evt){
            try{
              state.suppress=true;
              if(state.socket){
                try{state.socket.disconnect();}catch(e){}
                state.socket=null;
              }
              clearAllCentralClientCaches();
              localStorage.setItem(CENTRAL_RESET_GENERATION_KEY,String((evt&&evt.centralResetGeneration)||0));
            }finally{state.suppress=false;}
            setStatus('Central database was reset. All local office caches were cleared. Sign in again.','warn');
            openAuth();
          });
          state.socket.on('connect_error',function(){/* polling fallback */});
        }catch(e){}
      };
      document.head.appendChild(s);
    }catch(e){}
  }
  function watchProfile(){
    var scope=currentScope();
    if(!scope)return;
    if(state.activeProfileKey && state.activeProfileKey!==scopeId()&&!state.switchingProfile) switchProfile();
  }

  async function init(){
    injectUI(); patchStorage(); installSaveHooks();
    var facility=currentFacility(),inCharge=currentInCharge(),scope=currentScope();
    if(!facility||!inCharge){setStatus('Waiting for In-Charge profile…','warn');setTimeout(init,1200);return;}
    state.activeFacility=facility;
    if(state.activeProfileKey && state.activeProfileKey!==scopeId()){
      state.token=''; state.activeProfileKey=''; localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(ACTIVE_PROFILE_KEY);
    }
    var resetRequested=!!localStorage.getItem(RESET_KEY);
    var held=localResetHeld(scope);
    var cached=hasProfileCache(scope);
    if(held){
      PROFILE_DATASETS.forEach(function(n){setDatasetLocal(n,[],false);});
    }else if(cached && !resetRequested) loadProfileCache(scope);
    else {PROFILE_DATASETS.forEach(function(n){setDatasetLocal(n,[],false);});}
    if(!navigator.onLine){setStatus(held?'Offline — device reset is held; use Rebuild when online':'Offline — '+scopeLabel()+' local data retained','warn');return;}
    if(state.token && state.activeProfileKey===scopeId()){
      setStatus('Central '+scopeLabel()+' connection ready','warn');
      if(held){
        setStatus('Connected to Central. Local device is reset; click Rebuild My Office Data to restore.','warn');
      }else if(resetRequested || !cached){ await fullProfileReconcile(); saveProfileCache(scope); localStorage.removeItem(RESET_KEY); }
      else { await sync(true); await fullProfileReconcile(); }
      connectSocket();
    }else{
      setStatus('Central profile authentication required','warn'); openAuth();
    }
    setInterval(function(){installSaveHooks();watchProfile();if(navigator.onLine){if(state.pending.size)sync(false);else reconcile();connectSocket();}},10000);
    window.addEventListener('online',function(){watchProfile();setStatus('Online — syncing '+scopeLabel()+'…','warn');sync(true);fullProfileReconcile();connectSocket();});
  }

  async function checkInventoryBatch(dataset,items){
    if(!state.token||!navigator.onLine) throw new Error('PROFILE_AUTH_REQUIRED');
    return await api('/api/inventory/check-batch',{method:'POST',body:JSON.stringify({dataset:dataset,items:Array.isArray(items)?items:[]})});
  }

  window.QLogCentral={
    connect:function(){var i=document.getElementById('qlogCentralCode');if(i)connectWithCode(i.value.trim());},
    closeAuth:closeAuth,
    sync:function(){schedule(SYNC_KEYS);sync(true);},
    syncDatasets:function(names){schedule(names||SYNC_KEYS);sync(false);},
    resetDevice:resetThisDevice,
    rebuildMyOffice:rebuildMyOffice,
    getDeleteQueue:function(){return readDeleteQueue(currentScope());},
    getApiBase:function(){return API_BASE;},
    getSourceId:function(){return state.sourceId;},
    getFacility:function(){return state.activeFacility;},
    getProfileKey:function(){return state.activeProfileKey;},
    getProfile:function(){return {facility:currentFacility(),inCharge:currentInCharge(),profileKey:state.activeProfileKey};},
    checkInventoryBatch:checkInventoryBatch
  };

  window.addEventListener('load',function(){setTimeout(init,1200);});
})();
