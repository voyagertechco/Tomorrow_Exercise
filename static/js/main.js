// static/js/main.js
// Handles auth, render, install prompt and offline-save for videos
// Added: playlist modal (auto-play within a category), big-number end-count, break with skip,
//        green saved/playing indicator on cards, per-card configurable play length (r.play_seconds).
// Assumes idb.js provides: saveVideoMeta(meta), getVideoMeta(url), listSavedVideos(), removeVideoMeta(url)

'use strict';

// --- Simple config ---
const RUNTIME_CACHE = 'tomorrow-runtime-v1';

// playlist/player config (tweakable)
const DEFAULT_PLAY_SECONDS = 20;      // fallback per-video play window (seconds)
const END_COUNT_SECONDS = 3;          // large-number countdown before pausing (seconds)
const BREAK_SECONDS = 10;             // break between videos (seconds)
const BEEP_FREQ = 900;                // beep frequency (Hz)
const AUTO_HIDE_MODAL_ON_FINISH = true;

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

const categories = ["Strength", "Cardio", "Flexibility", "Elderly", "Special", "Special Programs"]
  .map(c => c === "Special Programs" ? "Special" : c);

let currentUser = null;
let allRoutines = [];
let savedVideosIndex = {}; // url -> meta
let deferredInstallPrompt = null;
let selectedCategory = null;
let playingVideoUrl = null; // used for indicator
let _timers = [];

/* ---------------- small timer helpers ---------------- */
function setTimer(fn, ms){ const t = setTimeout(fn, ms); _timers.push(t); return t; }
function clearTimer(t){ clearTimeout(t); _timers = _timers.filter(x=>x!==t); }
function cancelTimers(){ _timers.forEach(t=>clearTimeout(t)); _timers=[]; }

/* ---------------- beep helper ---------------- */
function beep(durationMs=120, freq=BEEP_FREQ, vol=0.06) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    g.gain.value = vol;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    setTimeout(()=>{ try{ o.stop(); ctx.close(); }catch(e){} }, durationMs);
  } catch(e){ /* ignore audio errors */ }
}

/* ---------------- UI: styles injected for indicators & modal ---------------- */
(function injectStyles(){
  const css = `
/* saved / playing indicator */
.routine-thumb { position:relative; }
.te-indicator {
  position:absolute; top:8px; right:8px; width:12px; height:12px; border-radius:50%;
  background: rgba(0,0,0,0.35); box-shadow: 0 1px 2px rgba(0,0,0,0.5); border:2px solid rgba(0,0,0,0.4);
  transition: transform .15s ease, box-shadow .15s ease, background .15s ease;
}
.te-indicator.saved { background: #23b14d; box-shadow: 0 6px 18px rgba(35,177,77,0.18); }
.te-indicator.playing { box-shadow: 0 10px 28px rgba(35,177,77,0.28); transform: scale(1.4); }
/* modal/player */
.te-modal { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,0.75); z-index:9999; }
.te-player { width:min(920px,95%); background:#0f1318; border-radius:12px; padding:10px; box-sizing:border-box; box-shadow:0 30px 80px rgba(0,0,0,.7); }
.te-player video { width:100%; height:auto; border-radius:8px; background:#000; display:block; }
.te-overlay-count {
  position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
  font-size:120px; font-weight:900; color:#000; background:rgba(255,255,255,0.95);
  padding:18px 30px; border-radius:12px; box-shadow:0 6px 24px rgba(0,0,0,.6);
  display:none; z-index:10001; text-align:center;
}
.te-break { margin-top:10px; display:flex; gap:10px; align-items:center; justify-content:space-between; color:#e6edf5; font-weight:700; }
.te-break .count { font-size:36px; color:var(--accent); font-weight:900; }
.te-controls { display:flex; gap:10px; }
.te-btn { padding:8px 12px; border-radius:10px; border:0; cursor:pointer; font-weight:800; }
.te-skip { background:transparent; color:#fff; border:1px solid rgba(255,255,255,.08); }
.te-stop { background:linear-gradient(90deg,#ff5a2f,#ff8a4d); color:#120a06; }
`;
  const s = document.createElement('style');
  s.setAttribute('data-generated','te-main-js');
  s.textContent = css;
  document.head.appendChild(s);
})();

/* ---------------- UI rendering ---------------- */

function renderCategories(){
  if(!categoryRow) return;
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
  if(!categoryRow) return;
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
  if(!routineGrid) return;
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
    // embed dataset attributes so playlist logic can find startIndex & category reliably
    a.dataset.id = String(r.id);
    a.dataset.category = r.category || '';
    // per-card configurable play length: prefer r.play_seconds, fallback to r.duration, else undefined
    if(r.play_seconds && Number(r.play_seconds) > 0) a.dataset.playSeconds = String(r.play_seconds);
    else if(r.duration && Number(r.duration) > 0) a.dataset.playSeconds = String(r.duration);

    const thumb = document.createElement('div'); thumb.className = 'routine-thumb';
    if(r.thumbnail_url){
      const img = document.createElement('img'); img.src = r.thumbnail_url; img.alt = r.title || 'thumb';
      img.style.width = '100%'; img.style.height = '100%'; img.style.objectFit = 'cover';
      thumb.appendChild(img);
    } else {
      thumb.innerHTML = `<div style="padding:12px;color:var(--muted)">${r.category||''}</div>`;
    }

    // indicator (green dot) - shows saved and/or playing state
    const indicator = document.createElement('span');
    indicator.className = 'te-indicator';
    // set aria
    indicator.setAttribute('aria-hidden','true');
    thumb.appendChild(indicator);

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
          indicator.classList.remove('saved');
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
          indicator.classList.add('saved');
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

    // update indicator initial saved state
    if(isSaved) indicator.classList.add('saved');

    // clicking a card should launch the category playlist starting at this routine
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      const cat = a.dataset.category || '';
      const idAttr = a.dataset.id;
      // compute startIndex from server-side order by fetching routines (playCategoryPlaylist will fetch again),
      // but we can pass startId so it can compute same
      playCategoryPlaylist(cat, idAttr);
    });

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
    if(routineGrid) routineGrid.innerHTML = `<div class="card" style="padding:20px"><div class="tiny-note">Could not load routines — offline or server error.</div></div>`;
  }
}

/* ---------------- Auth / Hub ---------------- */

if(authForm){
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
}

const guestBtn = $('guestBtn');
if(guestBtn) guestBtn.addEventListener('click', ()=>{
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
  if(authSection) authSection.hidden = true;
  if(hubSection) hubSection.hidden = false;
  if(welcomeText) welcomeText.innerText = `Welcome, ${currentUser.username || 'Friend'}`;
  renderCategories();
  setActiveCat(null);
  loadRoutines();
}

/* ---------------- PWA / SW handling ---------------- */

// register service worker (if supported)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/static/js/sw.js')
    .then(reg => {
      console.log('SW registered', reg);
    })
    .catch(err => {
      console.error('SW register failed', err);
    });
}

// beforeinstallprompt UI wiring
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if(installBtn) installBtn.style.display = 'inline-block';
  if(installBanner) installBanner.style.display = 'flex';
});

if(installBtn){
  installBtn.addEventListener('click', async () => {
    if(!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installBtn.style.display = 'none';
    if(installBanner) installBanner.style.display = 'none';
  });
}
if(bannerInstall){
  bannerInstall.addEventListener('click', async () => {
    if(!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    if(installBanner) installBanner.style.display = 'none';
  });
}
if(bannerDismiss){
  bannerDismiss.addEventListener('click', ()=> {
    if(installBanner) installBanner.style.display = 'none';
  });
}

/* ---------------- Offline save / remove operations ---------------- */

async function saveVideoForOffline(routine){
  if(!routine || !routine.video_url) throw new Error('no video url');
  const url = routine.video_url;
  const cache = await caches.open(RUNTIME_CACHE);
  const resp = await fetch(url, {mode:'cors'});
  if(!resp.ok) throw new Error('failed to fetch video: '+resp.status);
  await cache.put(url, resp.clone());

  const meta = {
    url: url,
    title: routine.title || 'Untitled',
    category: routine.category || '',
    thumbnail_url: routine.thumbnail_url || null,
    duration: routine.duration || 0,
    saved_at: new Date().toISOString()
  };
  await saveVideoMeta(meta); // idb.js provided
  savedVideosIndex[url] = meta;
  updateIndicators(); // reflect saved state visually
  return true;
}

async function removeSavedVideo(url){
  const cache = await caches.open(RUNTIME_CACHE);
  try { await cache.delete(url); } catch(e){ console.warn('cache delete failed', e); }
  await removeVideoMeta(url); // idb.js provided
  delete savedVideosIndex[url];
  updateIndicators();
  return true;
}

/* ---------------- Indicator updates ---------------- */
function updateIndicators(){
  // update .te-indicator classes across cards
  const cards = document.querySelectorAll('.routine-card');
  cards.forEach(card=>{
    const thumb = card.querySelector('.routine-thumb');
    if(!thumb) return;
    const ind = thumb.querySelector('.te-indicator');
    if(!ind) return;
    const url = (function(){
      // find matching routine by id (if available)
      const id = card.dataset.id;
      const r = allRoutines.find(x => String(x.id) === String(id));
      return r ? r.video_url : null;
    })();
    if(!url) {
      ind.classList.remove('saved','playing');
      return;
    }
    ind.classList.toggle('saved', !!savedVideosIndex[url]);
    ind.classList.toggle('playing', playingVideoUrl === url);
  });
}

/* ---------------- Playlist modal & runner ---------------- */
// container for modal (created on first use)
const modalContainerId = 'te_player_modal_container';
function ensureModalContainer(){
  let cont = document.getElementById(modalContainerId);
  if(!cont){
    cont = document.createElement('div');
    cont.id = modalContainerId;
    cont.style.display = 'none';
    document.body.appendChild(cont);
  }
  return cont;
}

function buildModal(){
  const container = ensureModalContainer();
  container.innerHTML = `
    <div id="te_modal" class="te-modal" role="dialog" aria-modal="true" style="display:flex">
      <div class="te-player" id="te_player_card" style="position:relative">
        <div style="position:relative;">
          <video id="te_playlist_video" controls playsinline></video>
          <div id="te_overlay_count" class="te-overlay-count" aria-hidden="true">3</div>
        </div>
        <div class="te-break" id="te_break_row" style="display:none;">
          <div>Break — next starts in <span class="count" id="te_break_count">${BREAK_SECONDS}</span>s</div>
          <div class="te-controls">
            <button id="te_skip_break" class="te-btn te-skip">Start Now</button>
            <button id="te_stop_all" class="te-btn te-stop">Stop Session</button>
          </div>
        </div>
      </div>
    </div>`;
  // handlers
  document.getElementById('te_skip_break').addEventListener('click', ()=>{
    container._skipBreak = true;
  });
  document.getElementById('te_stop_all').addEventListener('click', ()=>{
    container._stopAll = true;
  });
  const modal = document.getElementById('te_modal');
  modal.addEventListener('click', (ev)=>{ if(ev.target === modal){ stopAndClose(); } });
  container._skipBreak = false;
  container._stopAll = false;
  return container;
}

function showModal(){ const c = ensureModalContainer(); c.style.display='block'; const m = c.querySelector('#te_modal'); if(m) m.style.display='flex'; }
function hideModal(){ const c = ensureModalContainer(); c.style.display='none'; const m = c.querySelector('#te_modal'); if(m) m.style.display='none'; }

function stopAndClose(){
  // stop timers & video
  cancelTimers();
  const v = document.getElementById('te_playlist_video');
  if(v){ try{ v.pause(); v.src = ""; }catch(e){} }
  playingVideoUrl = null;
  updateIndicators();
  hideModal();
}

async function runOverlayCountdown(seconds){
  const overlay = document.getElementById('te_overlay_count');
  if(!overlay) return;
  overlay.style.display = 'block';
  for(let s=seconds; s>=1; s--){
    overlay.textContent = String(s);
    beep(120, BEEP_FREQ, 0.07);
    await new Promise(res => setTimer(res, 950));
  }
  overlay.style.display = 'none';
}

function runBreakCountdown(seconds){
  return new Promise(async (resolve) => {
    const container = ensureModalContainer();
    const breakRow = document.getElementById('te_break_row');
    const breakCountEl = document.getElementById('te_break_count');
    container._skipBreak = false;
    container._stopAll = false;
    breakRow.style.display = 'flex';
    for(let s=seconds; s>=1; s--){
      if(container._skipBreak || container._stopAll){ breakCountEl.textContent = '0'; break; }
      breakCountEl.textContent = String(s);
      beep(80, BEEP_FREQ, 0.05);
      await new Promise(res => setTimer(res, 1000));
    }
    breakRow.style.display = 'none';
    resolve(!container._stopAll);
  });
}

async function playCategoryPlaylist(category, startId){
  try {
    // fetch routines and build list in server order
    const resp = await fetch('/api/routines');
    if(!resp.ok) throw new Error('failed to fetch routines');
    const all = await resp.json();
    const list = all.filter(r => (r.category || '').toLowerCase() === (category||'').toLowerCase());
    if(list.length === 0){
      alert('No videos found in this category.');
      return;
    }

    // compute start index (by id)
    let startIndex = 0;
    if(startId){
      const idx = list.findIndex(x=>String(x.id) === String(startId));
      if(idx >= 0) startIndex = idx;
    }

    // prepare modal
    const container = document.getElementById(modalContainerId) || buildModal();
    showModal();

    const videoEl = document.getElementById('te_playlist_video');

    // iterate playlist
    for(let idx = startIndex; idx < list.length; idx++){
      container._skipBreak = false;
      container._stopAll = false;

      const item = list[idx];
      // determine play seconds: prefer data property (play_seconds) else item.play_seconds else item.duration else DEFAULT
      let playSeconds = DEFAULT_PLAY_SECONDS;
      if(item.play_seconds && Number(item.play_seconds) > 0) playSeconds = Number(item.play_seconds);
      else if(item.duration && Number(item.duration) > 0) playSeconds = Number(item.duration);

      // set video src and await minimal metadata (with fallback)
      videoEl.pause();
      videoEl.src = item.video_url;
      videoEl.load();

      await new Promise(res=>{
        let resolved = false;
        const onmeta = () => {
          if(resolved) return;
          resolved = true;
          videoEl.removeEventListener('loadedmetadata', onmeta);
          res();
        };
        videoEl.addEventListener('loadedmetadata', onmeta);
        // fallback after 1500ms if metadata doesn't arrive
        setTimer(()=>{ if(!resolved){ resolved = true; try{ videoEl.removeEventListener('loadedmetadata', onmeta); }catch(e){} res(); } }, 1500);
      });

      // prefer shorter of video duration and playSeconds if reasonable
      try {
        if(videoEl.duration && isFinite(videoEl.duration) && videoEl.duration > 0) {
          // if video is longer than playSeconds, keep playSeconds; if shorter, use video duration
          playSeconds = Math.min(playSeconds, Math.floor(videoEl.duration));
          if(playSeconds <= 0) playSeconds = DEFAULT_PLAY_SECONDS;
        }
      } catch(e){ /* ignore */ }

      // start playback
      try { videoEl.currentTime = 0; await videoEl.play(); } catch(e){ /* autoplay may be blocked, rely on user to press play */ }

      // set the playing indicator
      playingVideoUrl = item.video_url;
      updateIndicators();

      // schedule overlay countdown at (playSeconds - END_COUNT_SECONDS)
      const countStartAt = Math.max(0, (playSeconds - END_COUNT_SECONDS) * 1000);

      // wait until the overlay countdown time
      await new Promise(res => {
        // clear any previous timers
        cancelTimers();
        // if user stops (via modal stop button), container._stopAll will be true and we should abort
        const stopCheck = setInterval(()=>{
          if(container._stopAll){ clearInterval(stopCheck); cancelTimers(); res(); }
        }, 200);
        setTimer(async () => {
          clearInterval(stopCheck);
          // run overlay countdown
          await runOverlayCountdown(END_COUNT_SECONDS);
          // pause video when countdown finishes
          try{ videoEl.pause(); }catch(e){}
          res();
        }, countStartAt);
      });

      // record play via tracking endpoint (best-effort)
      try {
        if(currentUser && currentUser.username){
          fetch('/api/track_play', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ username: currentUser.username, country: currentUser.country, routine_id: item.id })
          }).catch(()=>{});
        }
      } catch(e){ /* ignore */ }

      // show break countdown with skip option
      const cont = await runBreakCountdown(BREAK_SECONDS);
      if(!cont || container._stopAll){
        stopAndClose();
        return;
      }
      // continue to next item
    }

    // playlist finished
    if(AUTO_HIDE_MODAL_ON_FINISH) stopAndClose();
    else { try{ videoEl.pause(); }catch(e){} playingVideoUrl = null; updateIndicators(); }

  } catch(err){
    console.error('playlist error', err);
    stopAndClose();
    alert('Could not start playlist — see console for details.');
  }
}

/* ---------------- Indicator refresh loop ---------------- */
function startIndicatorRefresh(){
  // ensure indicators updated occasionally (after saves or play)
  setInterval(updateIndicators, 800);
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
    if(authSection) authSection.hidden = false;
    if(hubSection) hubSection.hidden = true;
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
  }

  // start indicator refresher
  startIndicatorRefresh();
});
// --- Download all / pre-cache videos (main thread) ---

async function estimateStorageNeeded(totalBytesApprox) {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota, free: quota - (usage || 0), needed: totalBytesApprox };
  } catch (e) {
    return null;
  }
}

// create a simple progress overlay (very small)
function createCacheProgressOverlay(){
  let el = document.getElementById('te_cache_overlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'te_cache_overlay';
  el.style = 'position:fixed;inset:12px;background:rgba(0,0,0,.75);z-index:10010;padding:16px;border-radius:12px;color:#fff;display:flex;flex-direction:column;gap:8px;max-width:420px;right:12px;top:12px;';
  el.innerHTML = `<div id="te_cache_msg">Preparing to cache videos…</div>
    <progress id="te_cache_progress" value="0" max="100" style="width:100%"></progress>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button id="te_cache_cancel" class="te-btn te-skip">Cancel</button>
    </div>`;
  document.body.appendChild(el);
  document.getElementById('te_cache_cancel').addEventListener('click', () => {
    // simple cancel: reload page to stop workers or just hide UI
    el._cancel = true;
    el.remove();
  });
  return el;
}

// Call this to start caching (wired to a "Download all" button)
async function downloadAllVideos() {
  // gather list of video & thumbnail urls (unique)
  const urls = [];
  allRoutines.forEach(r => {
    if (r.video_url) urls.push(r.video_url);
    if (r.thumbnail_url) urls.push(r.thumbnail_url);
  });
  const uniq = Array.from(new Set(urls)).filter(Boolean);

  if (!uniq.length) return alert('No videos found to download.');

  // Estimate (rough): use duration * avg bitrate if you want — here we ask user to confirm
  const est = await estimateStorageNeeded(); // null if not supported
  // quick user confirmation for large lists
  if (uniq.length > 20) {
    const ok = confirm(`You're about to download ${uniq.length} media items for offline use. This may use a lot of device storage and bandwidth. Continue?`);
    if (!ok) return;
  }

  // ensure service worker is ready and has a controller
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
    alert('Service worker not active — reload the page or try again after a moment.');
    return;
  }

  // show progress UI
  const overlay = createCacheProgressOverlay();
  const msg = document.getElementById('te_cache_msg');
  const progress = document.getElementById('te_cache_progress');
  overlay._cancel = false;

  // message handler for progress events from SW
  function onSWMessage(ev) {
    const data = ev.data || {};
    if (!data || !data.type) return;
    if (overlay._cancel) {
      navigator.serviceWorker.controller.postMessage({ cmd: 'cancel-cache' });
      cleanup();
      return;
    }
    if (data.type === 'cache-start') {
      msg.textContent = `Caching ${data.total} items…`;
      progress.max = data.total;
      progress.value = 0;
    } else if (data.type === 'cache-progress') {
      msg.textContent = `Caching ${data.index}/${data.total}: ${data.url}`;
      progress.value = data.index;
    } else if (data.type === 'cache-error') {
      console.warn('cache error', data);
      // optionally show small notice
    } else if (data.type === 'cache-complete') {
      msg.textContent = `Caching complete (${data.total}).`;
      progress.value = progress.max;
      setTimeout(() => cleanup(), 1000);
    }
  }

  function cleanup() {
    navigator.serviceWorker.removeEventListener('message', onSWMessage);
    const el = document.getElementById('te_cache_overlay');
    if (el) el.remove();
  }

  navigator.serviceWorker.addEventListener('message', onSWMessage);

  // send the list to the service worker
  navigator.serviceWorker.controller.postMessage({ cmd: 'cacheVideos', urls: uniq });
}

// add small "Download" button to the hub header (if not already present)
(function addDownloadAllButton() {
  try {
    const headerActions = document.querySelector('.hub-actions');
    if (!headerActions) return;
    if (document.getElementById('downloadAllBtn')) return;
    const btn = document.createElement('button');
    btn.id = 'downloadAllBtn';
    btn.className = 'btn ghost';
    btn.innerText = 'Download all';
    btn.title = 'Download all videos & thumbnails for offline use';
    btn.addEventListener('click', downloadAllVideos);
    headerActions.insertBefore(btn, headerActions.firstChild);
  } catch(e){ console.warn(e); }
})();

// expose the API
window.TE = window.TE || {};
window.TE.downloadAllVideos = downloadAllVideos;

// expose playlist API for manual triggers
window.TE = window.TE || {};
window.TE.playCategoryPlaylist = playCategoryPlaylist;
window.TE.stopSession = stopAndClose;

