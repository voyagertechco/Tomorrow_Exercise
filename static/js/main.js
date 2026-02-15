// static/js/main.js
// FULL updated main.js — mobile-first, big-font, revised playlist timing and player behavior.
// Preserves offline save, idb hooks, sw registration, and registration flows.
// Changes summary:
//  - category layout arranged into rows per your request
//  - play window respects chosen setting (default 20s) and DOES NOT clamp to video duration
//  - if video ends early we WAIT until the play window expires, then move to next (no replay)
//  - break behavior respected (default 10s), configurable
//  - removed 'Download all' UI injection
//  - removed native download/picture-in-picture/fullscreen on video as much as browsers allow
//  - clicking the video attempts to lock orientation to landscape (via Screen Orientation API) when in fullscreen; otherwise rotates the element visually
//  - shows "Congrats — this activity is over" at the end

'use strict';

/* ---------------- Simple config (defaults can be updated by UI selects) ---------------- */
const RUNTIME_CACHE = 'tomorrow-runtime-v1';
let DEFAULT_PLAY_SECONDS = 20;      // fallback per-video play window (seconds)
let END_COUNT_SECONDS = 3;          // large-number countdown before pausing (seconds)
let BREAK_SECONDS = 10;             // break between videos (seconds)
const BEEP_FREQ = 900;              // beep frequency (Hz)
const AUTO_HIDE_MODAL_ON_FINISH = true;

/* ---------------- DOM helpers ---------------- */
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

const playLengthSelect = $('playLengthSelect');
const breakLengthSelect = $('breakLengthSelect');

const categories = ["Strength", "Cardio", "Flexibility", "Elderly", "Special"];

/* ---------------- state ---------------- */
let currentUser = null;
let allRoutines = [];
let savedVideosIndex = {}; // url -> meta
let deferredInstallPrompt = null;
let selectedCategory = null;
let playingVideoUrl = null; // used for indicator
let _timers = [];

/* ---------------- small timer helpers ---------------- */
function setTimer(fn, ms){ const t = setTimeout(fn, ms); _timers.push(t); return t; }
function clearTimer(t){ clearTimeout(t); _timers = _timers.filter(x=>x!==t); clearTimeout(t); }
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

/* ---------------- UI: inject some additional runtime css for player rotation fallback ---------------- */
(function injectRuntimeStyles(){
  const css = `
    .rotate-landscape { transform-origin: center center; transform: rotate(90deg) scale(1.4); }
    /* ensure modal video remains visible when rotated fallback used */
    #te_player_card { overflow: visible; }
  `;
  const s = document.createElement('style');
  s.setAttribute('data-generated','te-main-runtimestyles');
  s.textContent = css;
  document.head.appendChild(s);
})();

/* ---------------- UI rendering for categories (arranged per user request) ---------------- */

function renderCategories(){
  if(!categoryRow) return;
  categoryRow.innerHTML = '';

  // build grid as described:
  // row1: All | Strength
  // row2: Cardio | Flexibility
  // row3: Elderly | Special
  // row4: big Start All shortcut
  const makeBtn = (text, cls = '') => {
    const b = document.createElement('button');
    b.className = 'cat-pill ' + (cls||'');
    b.innerText = text;
    return b;
  };

  // row 1
  const btnAll = makeBtn('All');
  btnAll.onclick = ()=>{ selectedCategory = null; setActiveCat(null); renderRoutines(); };
  categoryRow.appendChild(btnAll);

  const btnStrength = makeBtn('Strength');
  btnStrength.onclick = ()=>{ selectedCategory = 'Strength'; setActiveCat('Strength'); renderRoutines(); };
  categoryRow.appendChild(btnStrength);

  // row 2
  const btnCardio = makeBtn('Cardio');
  btnCardio.onclick = ()=>{ selectedCategory = 'Cardio'; setActiveCat('Cardio'); renderRoutines(); };
  categoryRow.appendChild(btnCardio);

  const btnFlex = makeBtn('Flexibility');
  btnFlex.onclick = ()=>{ selectedCategory = 'Flexibility'; setActiveCat('Flexibility'); renderRoutines(); };
  categoryRow.appendChild(btnFlex);

  // row 3
  const btnElder = makeBtn('Elderly');
  btnElder.onclick = ()=>{ selectedCategory = 'Elderly'; setActiveCat('Elderly'); renderRoutines(); };
  categoryRow.appendChild(btnElder);

  const btnSpecial = makeBtn('Special');
  btnSpecial.onclick = ()=>{ selectedCategory = 'Special'; setActiveCat('Special'); renderRoutines(); };
  categoryRow.appendChild(btnSpecial);

  // row 4: Start All shortcut spanning columns
  const startAll = makeBtn('Start All Session', 'cat-all-shortcut');
  startAll.onclick = ()=>{ selectedCategory = null; setActiveCat(null); playCategoryPlaylist('', null); };
  categoryRow.appendChild(startAll);

  // initial active
  setActiveCat(selectedCategory);
}

function setActiveCat(cat){
  if(!categoryRow) return;
  Array.from(categoryRow.children).forEach(ch=>{
    const txt = (ch.innerText || '').trim();
    if((cat===null && txt==='All') || txt===cat) ch.classList.add('active'); else ch.classList.remove('active');
  });
}

/* ---------------- utilities ---------------- */
function formatDuration(sec){
  sec = parseInt(sec) || 0;
  if(sec < 60) return `${sec}s`;
  const m = Math.floor(sec/60);
  const s = sec%60;
  return `${m}m ${s}s`;
}

/* ---------------- render routines (preserve all original cards + save logic) ---------------- */
async function renderRoutines(){
  if(!routineGrid) return;
  routineGrid.innerHTML = '';

  const routines = selectedCategory ? allRoutines.filter(r => r.category === selectedCategory) : allRoutines;
  if(!routines || routines.length === 0){
    routineGrid.innerHTML = `<div class="card" style="padding:20px"><div class="tiny-note">No routines found.</div></div>`;
    return;
  }

  // refresh saved videos index
  const savedList = await listSavedVideos().catch(()=>[]);
  savedVideosIndex = {};
  savedList.forEach(m => { if(m && m.url) savedVideosIndex[m.url] = m; });

  routines.forEach(r=>{
    const a = document.createElement('a');
    a.className = 'routine-card';
    a.href = `/routine/${r.id}`;
    a.dataset.id = String(r.id);
    a.dataset.category = r.category || '';

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

    const indicator = document.createElement('span');
    indicator.className = 'te-indicator';
    indicator.setAttribute('aria-hidden','true');
    thumb.appendChild(indicator);

    const title = document.createElement('div'); title.className = 'routine-title'; title.innerText = r.title || 'Untitled';
    const meta = document.createElement('div'); meta.className = 'routine-meta';
    meta.innerText = `${r.difficulty || 'medium'} • ${formatDuration(r.duration)} • views ${r.views || 0}`;

    const actions = document.createElement('div'); actions.className = 'routine-actions';
    const left = document.createElement('div');
    const right = document.createElement('div');

    const saveBtn = document.createElement('button');
    const isSaved = !!savedVideosIndex[r.video_url];
    saveBtn.className = isSaved ? 'remove-btn' : 'save-btn';
    saveBtn.innerText = isSaved ? 'Saved' : 'Save offline';

    saveBtn.onclick = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const currentlySaved = !!savedVideosIndex[r.video_url];
      if(currentlySaved) {
        saveBtn.disabled = true;
        try {
          await removeSavedVideo(r.video_url);
          saveBtn.className = 'save-btn'; saveBtn.innerText = 'Save offline';
          indicator.classList.remove('saved');
        } catch(err){
          console.error('remove failed', err);
          alert('Could not remove saved video: '+ (err && err.message ? err.message : err));
        } finally { saveBtn.disabled = false; }
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
        } finally { saveBtn.disabled = false; }
      }
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

    if(isSaved) indicator.classList.add('saved');

    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      const cat = a.dataset.category || '';
      const idAttr = a.dataset.id;
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

// beforeinstallprompt UI wiring (preserve but optional)
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
  const cards = document.querySelectorAll('.routine-card');
  cards.forEach(card=>{
    const thumb = card.querySelector('.routine-thumb');
    if(!thumb) return;
    const ind = thumb.querySelector('.te-indicator');
    if(!ind) return;
    const id = card.dataset.id;
    const r = allRoutines.find(x => String(x.id) === String(id));
    const url = r ? r.video_url : null;
    if(!url) {
      ind.classList.remove('saved','playing');
      return;
    }
    ind.classList.toggle('saved', !!savedVideosIndex[url]);
    ind.classList.toggle('playing', playingVideoUrl === url);
  });
}

/* ---------------- Playlist modal & runner ---------------- */

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
          <video id="te_playlist_video" playsinline></video>
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

  // video click: toggle play + try to enter fullscreen & lock landscape
  const videoEl = document.getElementById('te_playlist_video');
  videoEl.addEventListener('click', async (ev) => {
    ev.preventDefault();
    // toggle play/pause
    if(videoEl.paused) {
      try { await videoEl.play(); }catch(e){ /* ignore autoplay restrictions */ }
    } else {
      videoEl.pause();
    }

    // request fullscreen then attempt orientation lock if available
    try {
      if(document.fullscreenElement === null && videoEl.requestFullscreen) {
        await videoEl.requestFullscreen({ navigationUI: "hide" }).catch(()=>{});
      }
      if(screen.orientation && screen.orientation.lock) {
        try { await screen.orientation.lock('landscape'); } catch (e) { /* may fail */ }
      } else {
        // fallback: visually rotate video element
        videoEl.classList.toggle('rotate-landscape');
      }
    } catch(e) {
      // ignore errors — rotation is best-effort
      videoEl.classList.toggle('rotate-landscape');
    }
  });

  // prevent context menu to avoid download options
  videoEl.addEventListener('contextmenu', (ev)=>{ ev.preventDefault(); });

  // hide native controls; we'll show very small native controls if necessary but disable download/pip if supported
  videoEl.controls = true;
  try {
    videoEl.setAttribute('controlsList', 'nodownload noremoteplayback');
    videoEl.setAttribute('disablepictureinpicture', '');
  } catch(e){ /* ignore */ }

  return container;
}

function showModal(){ const c = ensureModalContainer(); c.style.display='block'; const m = c.querySelector('#te_modal'); if(m) m.style.display='flex'; }
function hideModal(){ const c = ensureModalContainer(); c.style.display='none'; const m = c.querySelector('#te_modal'); if(m) m.style.display='none'; }

function stopAndClose(){
  cancelTimers();
  const v = document.getElementById('te_playlist_video');
  if(v){ try{ v.pause(); v.src = ""; }catch(e){} }
  playingVideoUrl = null;
  updateIndicators();
  // try to unlock orientation & exit fullscreen
  try {
    if(screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
  } catch(e){}
  try { if(document.fullscreenElement) document.exitFullscreen().catch(()=>{}); } catch(e){}
  hideModal();
}

/* overlay countdown (big numbers) */
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

/* break countdown with skip / stop */
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

/* ------------------ MAIN: playlist logic ------------------ */

/*
Key behavior implemented per your spec:
- Obtain global playSeconds & breakSeconds from UI selects (or defaults).
- For each item:
  - start playback (audio/video) immediately
  - if video is shorter than playSeconds, we DO NOT repeat it; we wait until playSeconds elapses, then move on
  - overlay countdown appears END_COUNT_SECONDS before the end of the play window
  - after countdown, pause the video/media and start break countdown; after break, continue to next video
- At end: show congrats and stop
*/

async function playCategoryPlaylist(category, startId){
  try {
    // update durations from UI selects (if present)
    const ps = parseInt((playLengthSelect && playLengthSelect.value) || DEFAULT_PLAY_SECONDS);
    const bs = parseInt((breakLengthSelect && breakLengthSelect.value) || BREAK_SECONDS);
    DEFAULT_PLAY_SECONDS = isFinite(ps) && ps>0 ? ps : DEFAULT_PLAY_SECONDS;
    BREAK_SECONDS = isFinite(bs) && bs>=0 ? bs : BREAK_SECONDS;

    // fetch routines to preserve server order
    const resp = await fetch('/api/routines');
    if(!resp.ok) throw new Error('failed to fetch routines');
    const all = await resp.json();

    // build list: if category is empty string or null -> all
    const list = (category && String(category).trim() !== '') ? all.filter(r => (r.category || '').toLowerCase() === (category||'').toLowerCase()) : all.slice();

    if(list.length === 0){
      alert('No videos found in this category.');
      return;
    }

    // compute start index by id (if provided)
    let startIndex = 0;
    if(startId){
      const idx = list.findIndex(x=>String(x.id) === String(startId));
      if(idx >= 0) startIndex = idx;
    }

    // prepare modal and video element
    const container = document.getElementById(modalContainerId) || buildModal();
    showModal();
    const videoEl = document.getElementById('te_playlist_video');

    // loop through playlist
    for(let idx = startIndex; idx < list.length; idx++){
      container._skipBreak = false;
      container._stopAll = false;

      const item = list[idx];

      // determine per-item playSeconds: UI overrides per-item config
      let playSeconds = DEFAULT_PLAY_SECONDS;
      if(item.play_seconds && Number(item.play_seconds) > 0) playSeconds = Number(item.play_seconds);
      // Note: intentionally DO NOT clamp to video length — we will wait full playSeconds before moving on.
      // But we still attempt to play the video once.

      // set video src & load
      try {
        videoEl.pause();
        videoEl.src = item.video_url;
        videoEl.load();
      } catch(e) {
        console.warn('could not set video src', e);
      }

      // wait briefly for metadata or fallback
      await new Promise(res=>{
        let resolved = false;
        const onmeta = () => {
          if(resolved) return;
          resolved = true;
          videoEl.removeEventListener('loadedmetadata', onmeta);
          res();
        };
        videoEl.addEventListener('loadedmetadata', onmeta);
        setTimer(()=>{ if(!resolved){ resolved = true; try{ videoEl.removeEventListener('loadedmetadata', onmeta); }catch(e){} res(); } }, 1200);
      });

      // start playback (best-effort)
      try { videoEl.currentTime = 0; await videoEl.play(); } catch(e) { /* autoplay may be blocked — user must tap */ }

      // mark playing indicator
      playingVideoUrl = item.video_url;
      updateIndicators();

      // NOTE: If the video ends early, we set a flag but DO NOT move to next — we wait until playSeconds expires.
      let endedEarly = false;
      const onEnded = () => { endedEarly = true; };
      videoEl.addEventListener('ended', onEnded);

      // schedule the overlay countdown to start at (playSeconds - END_COUNT_SECONDS)
      const countStartAt = Math.max(0, (playSeconds - END_COUNT_SECONDS) * 1000);

      // wait until overlay countdown time or until user stops session
      await new Promise(res => {
        cancelTimers();
        const stopCheck = setInterval(()=>{
          if(container._stopAll){ clearInterval(stopCheck); cancelTimers(); res(); }
        }, 200);
        // schedule countdown
        setTimer(async () => {
          clearInterval(stopCheck);
          // before running overlay, ensure video is still on DOM (some mobile browsers require user gesture to continue playing)
          await runOverlayCountdown(END_COUNT_SECONDS);
          // pause the video when countdown finishes (if still playing)
          try{ videoEl.pause(); }catch(e){}
          res();
        }, countStartAt);
      });

      // cleanup ended event listener
      try { videoEl.removeEventListener('ended', onEnded); } catch(e){}

      // record play (best-effort)
      try {
        if(currentUser && currentUser.username){
          fetch('/api/track_play', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ username: currentUser.username, country: currentUser.country, routine_id: item.id })
          }).catch(()=>{});
        }
      } catch(e){ /* ignore */ }

      // show break countdown (unless this was last item)
      const isLast = (idx === list.length - 1);
      if(!isLast){
        const cont = await runBreakCountdown(BREAK_SECONDS);
        if(!cont || container._stopAll){
          stopAndClose();
          return;
        }
        // continue to next item
      } else {
        // session finished: show congrats big overlay then stop
        await sessionFinished();
        return;
      }
    }

    // If loop ends naturally
    if(AUTO_HIDE_MODAL_ON_FINISH) stopAndClose();

  } catch(err){
    console.error('playlist error', err);
    stopAndClose();
    alert('Could not start playlist — see console for details.');
  }
}

/* show congrats / big finish message then stop */
async function sessionFinished(){
  try {
    const container = ensureModalContainer();
    const overlay = document.getElementById('te_overlay_count');
    if(overlay){
      overlay.style.display = 'block';
      overlay.textContent = '🎉';
      // enlarge message
      overlay.style.fontSize = 'calc(34px * var(--scale))';
      await new Promise(res => setTimer(res, 1200));
      overlay.textContent = 'Congrats — this activity is over';
      overlay.style.fontSize = 'calc(16px * var(--scale))';
      await new Promise(res => setTimer(res, 2000));
      overlay.style.display = 'none';
    } else {
      alert('Congrats — this activity is over');
    }
  } catch(e){ /* ignore */ } finally {
    stopAndClose();
  }
}

/* ---------------- Indicator refresh ---------------- */
function startIndicatorRefresh(){
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

  // start indicator refresher
  startIndicatorRefresh();

  // wire up selects to ensure updated settings are used
  if(playLengthSelect){
    playLengthSelect.addEventListener('change', ()=> {
      const v = parseInt(playLengthSelect.value) || DEFAULT_PLAY_SECONDS;
      DEFAULT_PLAY_SECONDS = v;
    });
  }
  if(breakLengthSelect){
    breakLengthSelect.addEventListener('change', ()=> {
      const v = parseInt(breakLengthSelect.value) || BREAK_SECONDS;
      BREAK_SECONDS = v;
    });
  }
});

/* ---------------- Optional helpers: estimateStorageNeeded / cache progress (kept but not injected UI) ---------------- */

async function estimateStorageNeeded(totalBytesApprox) {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota, free: quota - (usage || 0), needed: totalBytesApprox };
  } catch (e) {
    return null;
  }
}

/* ---------------- expose API for debugging/manual triggers ---------------- */
window.TE = window.TE || {};
window.TE.playCategoryPlaylist = playCategoryPlaylist;
window.TE.stopSession = stopAndClose;
