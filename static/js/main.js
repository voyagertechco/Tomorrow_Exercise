// static/js/main.js
// Handles auth, render, install prompt and offline-save for videos
// Added debug logs + graceful fallback when beforeinstallprompt is not fired.

// --- Simple config ---
const RUNTIME_CACHE = 'tomorrow-runtime-v1';

// --- DOM helpers ---
const $ = id => document.getElementById(id);
const authForm = $('authForm');
const authSection = $('authSection');
const hubSection = $('hubSection');
const welcomeText = $('welcomeText');
const routineGrid = $('routineGrid');
const categoryRow = $('categoryRow');
const installBtn = $('installBtn');
const installBanner = $('installBanner');
const bannerInstall = $('bannerInstall');
const bannerDismiss = $('bannerDismiss');
const editProfile = $('editProfile');
const signOut = $('signOut');

const categories = ["Strength", "Cardio", "Flexibility", "Elderly", "Special", "Special Programs"].map(c => c === "Special Programs" ? "Special" : c);

let currentUser = null;
let allRoutines = [];
let savedVideosIndex = {}; // url -> meta
let deferredInstallPrompt = null;
let selectedCategory = null;

/* ---------------- IndexedDB helpers (from idb.js global functions) -----------
   saveVideoMeta, getVideoMeta, listSavedVideos, removeVideoMeta
   These are provided by static/js/idb.js loaded before this script.
   --------------------------------------------------------------------------*/

/* ---------------- UI rendering ---------------- */

function renderCategories(){
  categoryRow.innerHTML = '';
  const allBtn = document.createElement('button');
  allBtn.className = 'cat-pill active';
  allBtn.innerText = 'All';
  allBtn.onclick = ()=>{ selectedCategory = null; setActiveCat(null); renderRoutines(); };
  categoryRow.appendChild(allBtn);
  categories.forEach(cat=>{
    const b = document.createElement('button');
    b.className = 'cat-pill';
    b.innerText = cat;
    b.onclick = ()=>{ selectedCategory = cat; setActiveCat(cat); renderRoutines(); };
    categoryRow.appendChild(b);
  });
}

function setActiveCat(cat){
  Array.from(categoryRow.children).forEach(ch=>{
    const txt = ch.innerText || '';
    if((cat===null && txt==='All') || txt===cat) ch.classList.add('active'); else ch.classList.remove('active');
  });
}

function formatDuration(sec){
  sec = parseInt(sec) || 0;
  if(sec < 60) return `${sec}s`;
  const m = Math.floor(sec/60);
  const s = sec%60;
  return `${m}m ${s}s`;
}

async function renderRoutines(){
  routineGrid.innerHTML = '';

  // filter by category if selected
  const routines = selectedCategory ? allRoutines.filter(r => r.category === selectedCategory) : allRoutines;
  if(!routines || routines.length === 0){
    routineGrid.innerHTML = `<div class="card" style="padding:20px"><div class="tiny-note">No routines found.</div></div>`;
    return;
  }

  // ensure savedVideosIndex is fresh
  const savedList = await listSavedVideos().catch(()=>[]);
  savedVideosIndex = {};
  savedList.forEach(m => { if(m && m.url) savedVideosIndex[m.url] = m; });

  routines.forEach(r=>{
    const a = document.createElement('a');
    a.className = 'routine-card';
    a.href = `/routine/${r.id}`;

    const thumb = document.createElement('div'); thumb.className = 'routine-thumb';
    if(r.thumbnail_url){
      const img = document.createElement('img'); img.src = r.thumbnail_url; img.alt = r.title || 'thumb';
      thumb.appendChild(img);
    } else {
      thumb.innerHTML = `<div style="padding:12px;color:var(--muted)">${r.category||''}</div>`;
    }

    const title = document.createElement('div'); title.className = 'routine-title'; title.innerText = r.title || 'Untitled';
    const meta = document.createElement('div'); meta.className = 'routine-meta';
    meta.innerText = `${r.difficulty || 'medium'} • ${formatDuration(r.duration)} • views ${r.views || 0}`;

    const actions = document.createElement('div'); actions.className = 'routine-actions';
    const left = document.createElement('div');
    const right = document.createElement('div');

    // Save/Remove button
    const saveBtn = document.createElement('button');
    const isSaved = !!savedVideosIndex[r.video_url];
    saveBtn.className = isSaved ? 'remove-btn' : 'save-btn';
    saveBtn.innerText = isSaved ? 'Saved' : 'Save offline';

    saveBtn.onclick = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      // re-evaluate saved state dynamically
      const currentlySaved = !!savedVideosIndex[r.video_url];
      if(currentlySaved) {
        // remove
        saveBtn.disabled = true;
        try {
          await removeSavedVideo(r.video_url);
          saveBtn.className = 'save-btn'; saveBtn.innerText = 'Save offline';
        } catch(err){
          console.error('remove failed', err);
          alert('Could not remove saved video: '+ (err && err.message ? err.message : err));
        } finally {
          saveBtn.disabled = false;
        }
      } else {
        saveBtn.disabled = true;
        saveBtn.innerText = 'Saving...';
        try {
          await saveVideoForOffline(r);
          saveBtn.className = 'remove-btn'; saveBtn.innerText = 'Saved';
        } catch(err){
          console.error('save failed', err);
          alert('Could not save video for offline: '+ (err && err.message ? err.message : err));
          saveBtn.className = 'save-btn'; saveBtn.innerText = 'Save offline';
        } finally {
          saveBtn.disabled = false;
        }
      }
      // refresh index
      const list = await listSavedVideos().catch(()=>[]);
      savedVideosIndex = {}; list.forEach(m=>{ if(m && m.url) savedVideosIndex[m.url] = m; });
    };

    left.appendChild(saveBtn);

    actions.appendChild(left);
    actions.appendChild(right);

    a.appendChild(thumb);
    a.appendChild(title);
    a.appendChild(meta);
    a.appendChild(actions);

    routineGrid.appendChild(a);
  });
}

/* ---------------- Data loading ---------------- */

async function loadRoutines(){
  try {
    const res = await fetch('/api/routines');
    if(!res.ok) throw new Error('failed to fetch');
    allRoutines = await res.json();
    renderRoutines();
  } catch(e) {
    console.error('loadRoutines', e);
    routineGrid.innerHTML = `<div class="card" style="padding:20px"><div class="tiny-note">Could not load routines — offline or server error.</div></div>`;
  }
}

/* ---------------- Auth / Hub ---------------- */

authForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(authForm);
  const body = Object.fromEntries(fd.entries());
  if(!body.username || !body.country) return alert('username and country required');

  try {
    const res = await fetch('/api/register', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    if(!res.ok) {
      const t = await res.text();
      return alert('Register failed: '+t);
    }
    const j = await res.json();
    currentUser = j;
    localStorage.setItem('te_user', JSON.stringify(currentUser));
    openHub();
  } catch(err){
    console.error(err);
    alert('Network error');
  }
});

$('guestBtn').addEventListener('click', ()=>{
  currentUser = {username:'guest',country:'Guest',id:null};
  localStorage.setItem('te_user', JSON.stringify(currentUser));
  openHub();
});

if(signOut) signOut.addEventListener('click', ()=>{
  localStorage.removeItem('te_user');
  location.reload();
});

if(editProfile) editProfile.addEventListener('click', ()=>{
  const name = prompt('Enter username', currentUser && currentUser.username);
  if(!name) return;
  const country = prompt('Country', currentUser && currentUser.country);
  currentUser.username = name;
  currentUser.country = country;
  localStorage.setItem('te_user', JSON.stringify(currentUser));
  welcomeText.innerText = `Welcome, ${currentUser.username}`;
});

function openHub(){
  authSection.hidden = true;
  hubSection.hidden = false;
  welcomeText.innerText = `Welcome, ${currentUser.username || 'Friend'}`;
  renderCategories();
  setActiveCat(null);
  loadRoutines();
}

/* ---------------- PWA install handling + SW registration ---------------- */


// debug helper: show more logging
console.log("PWA debug: navigator.onLine=", navigator.onLine, "serviceWorkerSupported=", 'serviceWorker' in navigator);

// register service worker (if supported)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/static/js/sw.js')
    .then(reg => {
      console.log('SW registered', reg);
      // If there's an active controller, SW controls the page
      console.log('navigator.serviceWorker.controller=', navigator.serviceWorker.controller);
    })
    .catch(err => {
      console.error('SW register failed', err);
    });
} else {
  console.warn('Service workers are not supported in this browser.');
}

// beforeinstallprompt debug + UI wiring
window.addEventListener('beforeinstallprompt', (e) => {
  console.log('beforeinstallprompt fired', e);
  e.preventDefault(); // prevent automatic prompt
  deferredInstallPrompt = e;

  // show install button + banner
  if(installBtn) installBtn.style.display = 'inline-block';
  if(installBanner) {
    installBanner.style.display = 'flex';
    // restore default banner message if needed
    const msg = installBanner.querySelector('.msg');
    if(msg) msg.innerText = 'Install Tomorrow Exercise for an app-like experience.';
    if(bannerInstall) bannerInstall.style.display = 'inline-block';
  }
});

// install button (header)
if(installBtn){
  installBtn.addEventListener('click', async () => {
    if(!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    console.log('PWA install choice', choice);
    deferredInstallPrompt = null;
    installBtn.style.display = 'none';
    if(installBanner) installBanner.style.display = 'none';
  });
}

// banner buttons
if(bannerInstall){
  bannerInstall.addEventListener('click', async () => {
    if(!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installBtn.style.display = 'none';
    if(installBanner) installBanner.style.display = 'none';
  });
}
if(bannerDismiss){
  bannerDismiss.addEventListener('click', ()=> {
    if(installBanner) installBanner.style.display = 'none';
  });
}
window.addEventListener('appinstalled', ()=> {
  console.log('App installed');
  if(installBtn) installBtn.style.display = 'none';
  if(installBanner) installBanner.style.display = 'none';
});

/* ---------------- Offline save / remove operations ---------------- */

async function saveVideoForOffline(routine){
  // routine must contain video_url, title, category, thumbnail_url, duration
  if(!routine || !routine.video_url) throw new Error('no video url');

  const url = routine.video_url;
  const cache = await caches.open(RUNTIME_CACHE);

  // fetch video (use credentials default)
  const resp = await fetch(url, {mode:'cors'});
  if(!resp.ok) throw new Error('failed to fetch video: '+resp.status);

  // store in cache
  await cache.put(url, resp.clone());

  // persist metadata in IDB
  const meta = {
    url: url,
    title: routine.title || 'Untitled',
    category: routine.category || '',
    thumbnail_url: routine.thumbnail_url || null,
    duration: routine.duration || 0,
    saved_at: new Date().toISOString()
  };
  await saveVideoMeta(meta);
  savedVideosIndex[url] = meta;
  return true;
}

async function removeSavedVideo(url){
  const cache = await caches.open(RUNTIME_CACHE);
  try { await cache.delete(url); } catch(e){ console.warn('cache delete failed', e); }
  await removeVideoMeta(url);
  delete savedVideosIndex[url];
  return true;
}

/* ---------------- Boot ---------------- */

window.addEventListener('load', async ()=>{
  // restore user
  const u = localStorage.getItem('te_user');
  if(u) {
    try { currentUser = JSON.parse(u); } catch(e){ currentUser = null; }
  }
  if(currentUser && currentUser.username){
    openHub();
  } else {
    authSection.hidden = false;
    hubSection.hidden = true;
  }

  // warm saved index
  const list = await listSavedVideos().catch(()=>[]);
  list.forEach(m => { if(m && m.url) savedVideosIndex[m.url] = m; });

  // fallback: show a manual install hint after a short delay if no prompt event
  setTimeout(async () => {
    if(!deferredInstallPrompt) {
      const hintAlready = localStorage.getItem('pwa_install_hint_shown');
      if(!hintAlready) {
        if(installBanner) {
          installBanner.style.display = 'flex';
          const msg = installBanner.querySelector('.msg');
          if(msg) msg.innerText = 'To install the app: open your browser menu and choose "Install app" or "Add to Home screen".';
          if(bannerInstall) bannerInstall.style.display = 'none';
        }
        localStorage.setItem('pwa_install_hint_shown', '1');
      }
    }
  }, 1500);

  // If service worker registered but not controlling page, suggest reload (only logs)
  if('serviceWorker' in navigator) {
    console.log('SW controller after load:', navigator.serviceWorker.controller);
    if(!navigator.serviceWorker.controller) {
      console.log('Service worker registered but not controlling this page yet. Reload to let it control the page after activation.');
    }
  }
});
