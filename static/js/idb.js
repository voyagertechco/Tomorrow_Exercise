// static/js/idb.js
// small idb wrapper for profile, progress & saved videos
const IDB_NAME = 'tomorrow-db';
const IDB_VER = 1;
let dbp = null;
function openDB(){
  if(dbp) return dbp;
  dbp = new Promise((resolve, reject)=>{
    const r = indexedDB.open(IDB_NAME, IDB_VER);
    r.onupgradeneeded = ()=>{
      const db = r.result;
      if(!db.objectStoreNames.contains('profile')) db.createObjectStore('profile', {keyPath:'id'});
      if(!db.objectStoreNames.contains('progress')) db.createObjectStore('progress', {keyPath:'id'});
      if(!db.objectStoreNames.contains('videos')) db.createObjectStore('videos', {keyPath:'url'});
    };
    r.onsuccess = ()=>resolve(r.result);
    r.onerror = ()=>reject(r.error);
  });
  return dbp;
}

async function saveProfile(obj){
  const db = await openDB();
  const tx = db.transaction('profile','readwrite');
  tx.objectStore('profile').put(Object.assign({id:1}, obj));
  return tx.complete;
}

async function getProfile(){
  const db = await openDB();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction('profile','readonly');
    const req = tx.objectStore('profile').get(1);
    req.onsuccess = ()=>resolve(req.result);
    req.onerror = ()=>reject(req.error);
  });
}

/* ----------------- videos store helpers ----------------- */

async function saveVideoMeta(meta){
  // meta must include at least { url, title, category, thumbnail_url, duration, saved_at }
  const db = await openDB();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction('videos','readwrite');
    const store = tx.objectStore('videos');
    store.put(meta);
    tx.oncomplete = ()=>resolve(true);
    tx.onerror = ()=>reject(tx.error);
  });
}

async function getVideoMeta(url){
  const db = await openDB();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction('videos','readonly');
    const req = tx.objectStore('videos').get(url);
    req.onsuccess = ()=>resolve(req.result);
    req.onerror = ()=>reject(req.error);
  });
}

async function listSavedVideos(){
  const db = await openDB();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction('videos','readonly');
    const store = tx.objectStore('videos');
    const req = store.getAll();
    req.onsuccess = ()=>resolve(req.result || []);
    req.onerror = ()=>reject(req.error);
  });
}

async function removeVideoMeta(url){
  const db = await openDB();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction('videos','readwrite');
    const store = tx.objectStore('videos');
    store.delete(url);
    tx.oncomplete = ()=>resolve(true);
    tx.onerror = ()=>reject(tx.error);
  });
}
