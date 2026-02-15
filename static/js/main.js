// static/js/main.js
// ----------------------------------------------------------------------------------
// Tomorrow Exercise — MAIN.JS (expanded, verbose, upgraded)
// ----------------------------------------------------------------------------------
// Purpose:
//  - Mobile-first playlist/player for Tomorrow Exercise PWA
//  - Large accessible UI integration and controls
//  - Playlist rules: default play window (20s), overlay countdown at end, break window (10s),
//    video plays once even if shorter, don't repeat short video, move to next when play window ends.
//  - Category layout and 'Start All' support
//  - Offline save/restore via IndexedDB helpers (idb.js) - graceful fallbacks if idb.js absent
//  - Service Worker registration & SW messaging for caching progress
//  - Robust error handling, telemetry stubs, debug logging, and multiple UX improvements
//
// Notes:
//  - This file is intentionally verbose and contains extensive comments and safety checks.
//  - It expects `saveVideoMeta(meta)`, `removeVideoMeta(url)`, `listSavedVideos()` from idb.js.
//    If those are missing, the code will provide in-memory fallbacks so the app still runs.
// ----------------------------------------------------------------------------------

'use strict';

/* ============================================================================
   CONFIGURATION / DEFAULTS
   ============================================================================ */

const RUNTIME_CACHE = 'tomorrow-runtime-v1';

// Default timings (editable in UI)
let DEFAULT_PLAY_SECONDS = 20;      // default per-item play window (sec)
let END_COUNT_SECONDS = 3;          // overlay countdown at end of play window (sec)
let BREAK_SECONDS = 10;             // break between videos (sec)

// Audible beep frequency (for UX feedback)
const BEEP_FREQ = 900;

// Whether to close the modal automatically when session ends:
const AUTO_HIDE_MODAL_ON_FINISH = true;

// Debug verbosity toggle. Set to true for extra console logs.
const DEBUG_LOG = false;

/* ============================================================================
   DOM SHORTCUTS
   ============================================================================ */
const $ = id => document.getElementById(id);

// sections & UI nodes (some may be absent in certain build states; check robustly)
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

/* ============================================================================
   APP STATE
   ============================================================================ */

const categories = ["Strength", "Cardio", "Flexibility", "Elderly", "Special"];

let currentUser = null;
let allRoutines = [];
let savedVideosIndex = {};   // url -> meta
let deferredInstallPrompt = null;
let selectedCategory = null;
let playingVideoUrl = null;  // current playing video's url for indicators
let _timers = [];            // local timers we can cancel if session stops
let swController = null;     // service worker controller (if any)

// In-memory fallback storage if idb.js is not loaded
let _inMemorySaved = {};

/* ============================================================================
   SAFE-IDB HELPERS (wraps idb.js functions with fallbacks)
   ============================================================================ */

async function safe_saveVideoMeta(meta){
  if(typeof saveVideoMeta === 'function') {
    try { return await saveVideoMeta(meta); } catch(e){ console.warn('saveVideoMeta failed', e); }
  }
  // fallback: store in-memory
  _inMemorySaved[meta.url] = meta;
  return true;
}

async function safe_removeVideoMeta(url){
  if(typeof removeVideoMeta === 'function') {
    try { return await removeVideoMeta(url); } catch(e){ console.warn('removeVideoMeta failed', e); }
  }
  // fallback: delete from memory
  delete _inMemorySaved[url];
  return true;
}

async function safe_listSavedVideos(){
  if(typeof listSavedVideos === 'function') {
    try { return await listSavedVideos(); } catch(e){ console.warn('listSavedVideos failed', e); }
  }
  // fallback: return array of in-memory saved metas
  return Object.values(_inMemorySaved || {});
}

/* ============================================================================
   TIMER HELPERS
   - track timers so we can cancel them reliably across the session
   ============================================================================ */
function setTimer(fn, ms){
  const t = setTimeout(fn, ms);
  _timers.push(t);
  return t;
}

function clearTimer(t){
  try { clearTimeout(t); } catch(e){}
  _timers = _timers.filter(x => x !== t);
}

function cancelTimers(){
  _timers.forEach(t => { try { clearTimeout(t); } catch(e){} });
  _timers = [];
}

/* ============================================================================
   SOUND / FEEDBACK
   - small beep to signal countdown ticks and important events
   ============================================================================ */
function beep(durationMs = 120, freq = BEEP_FREQ, vol = 0.06){
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.value = vol;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    setTimeout(()=>{ try{ o.stop(); ctx.close(); }catch(e){} }, durationMs);
  } catch(e) {
    // ignore audio errors (some browsers restrict audio without user gesture)
    if(DEBUG_LOG) console.warn('beep error', e);
  }
}

/* ============================================================================
   UTILITY: Logging wrapper
   ============================================================================ */
function log(...args){
  if(DEBUG_LOG) console.log('[TE]', ...args);
}

/* ============================================================================
   RUNTIME CSS INJECTION (rotate fallback)
   ============================================================================ */
(function injectRuntimeStyles(){
  const css = `
  /* Visual rotate fallback when Screen Orientation API isn't available */
  .rotate-landscape {
    transform-origin: center center;
    transform: rotate(90deg) scale(1.4);
    transition: transform 250ms ease;
  }
  /* Make sure the player card doesn't clip rotated element */
  #te_player_card { overflow: visible; }
  `;
  const s = document.createElement('style');
  s.setAttribute('data-generated','te-main-runtimestyles');
  s.textContent = css;
  document.head.appendChild(s);
})();

/* ============================================================================
   CATEGORIES UI RENDERING
   - arranged per your request (All + Strength / Cardio + Flex / Elderly + Special / Start All)
   ============================================================================ */
function renderCategories(){
  if(!categoryRow) return;
  categoryRow.innerHTML = '';

  function makeBtn(text, cls = ''){
    const b = document.createElement('button');
    b.className = 'cat-pill ' + (cls || '');
    b.type = 'button';
    b.innerText = text;
    b.setAttribute('aria-label', text);
    return b;
  }

  // Row 1: All | Strength
  const btnAll = makeBtn('All');
  btnAll.addEventListener('click', () => { selectedCategory = null; setActiveCat(null); renderRoutines(); });
  categoryRow.appendChild(btnAll);

  const btnStrength = makeBtn('Strength');
  btnStrength.addEventListener('click', () => { selectedCategory = 'Strength'; setActiveCat('Strength'); renderRoutines(); });
  categoryRow.appendChild(btnStrength);

  // Row 2: Cardio | Flexibility
  const btnCardio = makeBtn('Cardio');
  btnCardio.addEventListener('click', () => { selectedCategory = 'Cardio'; setActiveCat('Cardio'); renderRoutines(); });
  categoryRow.appendChild(btnCardio);

  const btnFlex = makeBtn('Flexibility');
  btnFlex.addEventListener('click', () => { selectedCategory = 'Flexibility'; setActiveCat('Flexibility'); renderRoutines(); });
  categoryRow.appendChild(btnFlex);

  // Row 3: Elderly | Special
  const btnElder = makeBtn('Elderly');
  btnElder.addEventListener('click', () => { selectedCategory = 'Elderly'; setActiveCat('Elderly'); renderRoutines(); });
  categoryRow.appendChild(btnElder);

  const btnSpecial = makeBtn('Special');
  btnSpecial.addEventListener('click', () => { selectedCategory = 'Special'; setActiveCat('Special'); renderRoutines(); });
  categoryRow.appendChild(btnSpecial);

  // Row 4: Start All (full-width)
  const startAll = makeBtn('Start All Session', 'cat-all-shortcut');
  startAll.addEventListener('click', () => { selectedCategory = null; setActiveCat(null); playCategoryPlaylist('', null); });
  categoryRow.appendChild(startAll);

  setActiveCat(selectedCategory);
}

function setActiveCat(cat){
  if(!categoryRow) return;
  Array.from(categoryRow.children).forEach(ch => {
    const txt = (ch.innerText || '').trim();
    if((cat === null && txt === 'All') || txt === cat) ch.classList.add('active'); else ch.classList.remove('active');
  });
}

/* ============================================================================
   ROUTINES RENDERING
   - keeps save/remove and playing indicator
   ============================================================================ */
async function renderRoutines(){
  if(!routineGrid) return;
  routineGrid.innerHTML = '';

  // pick routines by selectedCategory or show all
  const routines = selectedCategory ? allRoutines.filter(r => r.category === selectedCategory) : allRoutines;

  if(!routines || routines.length === 0) {
    routineGrid.innerHTML = `<div class="card" style="padding:20px"><div class="tiny-note">No routines found.</div></div>`;
    return;
  }

  // refresh saved index
  try {
    const savedList = await safe_listSavedVideos();
    savedVideosIndex = {};
    savedList.forEach(m => { if(m && m.url) savedVideosIndex[m.url] = m; });
  } catch(e) {
    log('safe_listSavedVideos failed', e);
  }

  // render each routine item as a card (keeps markup similar to your original)
  routines.forEach(r => {
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
      const stub = document.createElement('div');
      stub.style.padding = '12px';
      stub.style.color = 'var(--muted)';
      stub.innerText = r.category || '';
      thumb.appendChild(stub);
    }

    // indicator (small green dot)
    const indicator = document.createElement('span');
    indicator.className = 'te-indicator';
    indicator.setAttribute('aria-hidden','true');
    thumb.appendChild(indicator);

    const title = document.createElement('div');
    title.className = 'routine-title';
    title.innerText = r.title || 'Untitled';

    const meta = document.createElement('div');
    meta.className = 'routine-meta';
    meta.innerText = `${r.difficulty || 'medium'} • ${formatDuration(r.duration)} • views ${r.views || 0}`;

    const actions = document.createElement('div'); actions.className = 'routine-actions';
    const left = document.createElement('div');
    const right = document.createElement('div');

    // save / remove offline button
    const saveBtn = document.createElement('button');
    const isSaved = !!savedVideosIndex[r.video_url];
    saveBtn.className = isSaved ? 'remove-btn' : 'save-btn';
    saveBtn.innerText = isSaved ? 'Saved' : 'Save offline';

    saveBtn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const currentlySaved = !!savedVideosIndex[r.video_url];
      if(currentlySaved){
        saveBtn.disabled = true;
        try {
          await removeSavedVideo(r.video_url);
          saveBtn.className = 'save-btn';
          saveBtn.innerText = 'Save offline';
          indicator.classList.remove('saved');
        } catch(err){
          console.error('remove failed', err);
          alert('Could not remove saved video: ' + (err && err.message ? err.message : err));
        } finally {
          saveBtn.disabled = false;
        }
      } else {
        saveBtn.disabled = true;
        saveBtn.innerText = 'Saving...';
        try {
          await saveVideoForOffline(r);
          saveBtn.className = 'remove-btn';
          saveBtn.innerText = 'Saved';
          indicator.classList.add('saved');
        } catch(err){
          console.error('save failed', err);
          alert('Could not save video for offline: ' + (err && err.message ? err.message : err));
          saveBtn.className = 'save-btn';
          saveBtn.innerText = 'Save offline';
        } finally {
          saveBtn.disabled = false;
        }
      }
      // refresh saved index
      try {
        const list = await safe_listSavedVideos();
        savedVideosIndex = {};
        list.forEach(m => { if(m && m.url) savedVideosIndex[m.url] = m; });
      } catch(e){ log('refresh saved index failed', e); }
    });

    left.appendChild(saveBtn);
    actions.appendChild(left);
    actions.appendChild(right);

    a.appendChild(thumb);
    a.appendChild(title);
    a.appendChild(meta);
    a.appendChild(actions);

    // show saved indicator
    if(isSaved) indicator.classList.add('saved');

    // launch playlist starting from this item when clicked
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      const cat = a.dataset.category || '';
      const idAttr = a.dataset.id;
      playCategoryPlaylist(cat, idAttr);
    });

    routineGrid.appendChild(a);
  });
}

/* ============================================================================
   DURATION / FORMAT UTILS
   ============================================================================ */
function formatDuration(sec){
  sec = parseInt(sec) || 0;
  if(sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

/* ============================================================================
   DATA LOADING
   - fetch routines from server endpoint /api/routines
   ============================================================================ */
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

/* ============================================================================
   AUTH / HUB HANDLERS
   ============================================================================ */

if(authForm){
  authForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(authForm);
    const body = Object.fromEntries(fd.entries());
    if(!body.username || !body.country) return alert('username and country required');

    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body)
      });
      if(!res.ok){
        const t = await res.text();
        return alert('Register failed: ' + t);
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

// guest button fallback
const guestBtn = $('guestBtn');
if(guestBtn) guestBtn.addEventListener('click', () => {
  currentUser = { username: 'guest', country: 'Guest', id: null };
  localStorage.setItem('te_user', JSON.stringify(currentUser));
  openHub();
});

// sign out
if(signOut) signOut.addEventListener('click', () => {
  localStorage.removeItem('te_user');
  location.reload();
});

// edit profile quick handler
if(editProfile) editProfile.addEventListener('click', () => {
  const name = prompt('Enter username', currentUser && currentUser.username);
  if(!name) return;
  const country = prompt('Country', currentUser && currentUser.country);
  currentUser.username = name;
  currentUser.country = country;
  localStorage.setItem('te_user', JSON.stringify(currentUser));
  if(welcomeText) welcomeText.innerText = `Welcome, ${currentUser.username}`;
});

function openHub(){
  if(authSection) authSection.hidden = true;
  if(hubSection) hubSection.hidden = false;
  if(welcomeText) welcomeText.innerText = `Welcome, ${currentUser.username || 'Friend'}`;
  renderCategories();
  setActiveCat(null);
  loadRoutines();
}

/* ============================================================================
   SERVICE WORKER / PWA INSTALL PROMPT
   ============================================================================ */

if('serviceWorker' in navigator){
  navigator.serviceWorker.register('/static/js/sw.js')
    .then(reg => {
      log('SW registered', reg);
      // if controller exists, keep pointer for messaging
      if(navigator.serviceWorker.controller) swController = navigator.serviceWorker.controller;
      // listen for future controller change
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        swController = navigator.serviceWorker.controller;
        log('SW controller changed', swController);
      });
    })
    .catch(err => {
      console.error('SW register failed', err);
    });
}

// install prompt
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
    const choice = await deferredInstallPrompt.userChoice;
    log('install choice', choice);
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
  bannerDismiss.addEventListener('click', () => {
    if(installBanner) installBanner.style.display = 'none';
  });
}

/* ============================================================================
   OFFLINE SAVE / REMOVE (wraps caches + idb)
   ============================================================================ */

async function saveVideoForOffline(routine){
  if(!routine || !routine.video_url) throw new Error('no video url');
  const url = routine.video_url;
  const cache = await caches.open(RUNTIME_CACHE);
  // fetch the video (CORS mode)
  const resp = await fetch(url, { mode: 'cors' });
  if(!resp.ok) throw new Error('failed to fetch video: ' + resp.status);
  await cache.put(url, resp.clone());

  const meta = {
    url: url,
    title: routine.title || 'Untitled',
    category: routine.category || '',
    thumbnail_url: routine.thumbnail_url || null,
    duration: routine.duration || 0,
    saved_at: new Date().toISOString()
  };

  // store metadata via idb wrapper
  await safe_saveVideoMeta(meta);
  savedVideosIndex[url] = meta;
  updateIndicators();
  return true;
}

async function removeSavedVideo(url){
  const cache = await caches.open(RUNTIME_CACHE);
  try { await cache.delete(url); } catch(e) { console.warn('cache delete failed', e); }
  await safe_removeVideoMeta(url);
  delete savedVideosIndex[url];
  updateIndicators();
  return true;
}

/* ============================================================================
   INDICATOR REFRESH (updates .te-indicator classes across cards)
   ============================================================================ */

function updateIndicators(){
  const cards = document.querySelectorAll('.routine-card');
  cards.forEach(card => {
    const thumb = card.querySelector('.routine-thumb');
    if(!thumb) return;
    const ind = thumb.querySelector('.te-indicator');
    if(!ind) return;
    const id = card.dataset.id;
    const r = allRoutines.find(x => String(x.id) === String(id));
    const url = r ? r.video_url : null;
    if(!url){
      ind.classList.remove('saved', 'playing');
      return;
    }
    ind.classList.toggle('saved', !!savedVideosIndex[url]);
    ind.classList.toggle('playing', playingVideoUrl === url);
  });
}

/* ============================================================================
   PLAYER MODAL / BUILD
   - builds player modal on first use and wires handlers
   ============================================================================ */

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
  // detailed structure with custom controls (skip, stop, play/pause)
  container.innerHTML = `
    <div id="te_modal" class="te-modal" role="dialog" aria-modal="true" style="display:flex">
      <div class="te-player" id="te_player_card" style="position:relative">
        <div style="position:relative;">
          <video id="te_playlist_video" playsinline></video>
          <div id="te_overlay_count" class="te-overlay-count" aria-hidden="true">3</div>
        </div>

        <div style="margin-top:12px; display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
          <div class="te-controls">
            <button id="te_playpause" class="te-btn te-playpause">Play</button>
            <button id="te_skip" class="te-btn te-skip">Next</button>
            <button id="te_stop_all" class="te-btn te-stop">Stop Session</button>
          </div>
          <div id="te_play_status" style="font-weight:900; font-size:16px;">Ready</div>
        </div>

        <div class="te-break" id="te_break_row" style="display:none;">
          <div>Break — next starts in <span class="count" id="te_break_count">${BREAK_SECONDS}</span>s</div>
          <div>
            <button id="te_skip_break" class="te-btn te-skip">Start Now</button>
          </div>
        </div>

      </div>
    </div>`;

  // wire break & stop
  document.getElementById('te_skip_break').addEventListener('click', () => {
    container._skipBreak = true;
  });

  document.getElementById('te_stop_all').addEventListener('click', () => {
    container._stopAll = true;
  });

  // clicking outside modal closes it
  const modal = document.getElementById('te_modal');
  modal.addEventListener('click', (ev) => { if(ev.target === modal) { stopAndClose(); } });

  container._skipBreak = false;
  container._stopAll = false;
  container._skipNow = false;

  // custom play/pause/next wiring
  const videoEl = document.getElementById('te_playlist_video');
  const playBtn = document.getElementById('te_playpause');
  const nextBtn = document.getElementById('te_skip');
  const statusEl = document.getElementById('te_play_status');

  playBtn.addEventListener('click', async () => {
    if(videoEl.paused){
      try { await videoEl.play(); playBtn.innerText = 'Pause'; statusEl.innerText = 'Playing'; } catch(e) { statusEl.innerText = 'Tap video to allow playback'; }
    } else {
      videoEl.pause(); playBtn.innerText = 'Play'; statusEl.innerText = 'Paused';
    }
  });

  nextBtn.addEventListener('click', () => {
    // set a flag so the playlist loop will immediately move on
    container._skipNow = true;
  });

  // video click handling: attempt orientation lock & play; fallback rotate
  videoEl.addEventListener('click', async (ev) => {
    ev.preventDefault();
    try {
      if(videoEl.paused) { await videoEl.play(); playBtn.innerText = 'Pause'; statusEl.innerText = 'Playing'; }
      else { videoEl.pause(); playBtn.innerText = 'Play'; statusEl.innerText = 'Paused'; }
    } catch(e){ log('playback toggle failed', e); }

    // try lock orientation
    try {
      if(screen.orientation && screen.orientation.lock){
        await screen.orientation.lock('landscape-primary');
      } else {
        // rotate visually
        videoEl.classList.toggle('rotate-landscape');
      }
    } catch(e){
      // ignore lock errors
      if(DEBUG_LOG) console.warn('orientation lock failed', e);
      videoEl.classList.toggle('rotate-landscape');
    }
  });

  // prevent context menu to remove download action in some browsers
  videoEl.addEventListener('contextmenu', ev => ev.preventDefault());

  // remove native controls (we use custom controls)
  try { videoEl.controls = false; videoEl.setAttribute('controlsList', 'nodownload noremoteplayback'); videoEl.setAttribute('disablepictureinpicture',''); } catch(e){}

  return container;
}

function showModal(){
  const c = ensureModalContainer();
  c.style.display = 'block';
  const m = c.querySelector('#te_modal');
  if(m) m.style.display = 'flex';
}

function hideModal(){
  const c = ensureModalContainer();
  c.style.display = 'none';
  const m = c.querySelector('#te_modal');
  if(m) m.style.display = 'none';
}

/* ============================================================================
   STOP & CLEANUP
   ============================================================================ */
function stopAndClose(){
  cancelTimers();
  const v = document.getElementById('te_playlist_video');
  if(v){ try{ v.pause(); v.src = ''; }catch(e){} }
  playingVideoUrl = null;
  updateIndicators();
  // attempt to unlock orientation if possible
  try { if(screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch(e){}
  // try exit fullscreen (best-effort)
  try { if(document.fullscreenElement) document.exitFullscreen().catch(()=>{}); } catch(e){}
  hideModal();
}

/* ============================================================================
   COUNTS & BREAKS
   - overlay countdown (large number) and break countdown with skip
   ============================================================================ */
async function runOverlayCountdown(seconds){
  const overlay = document.getElementById('te_overlay_count');
  if(!overlay) return;
  overlay.style.display = 'block';
  for(let s = seconds; s >= 1; s--){
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
    for(let s = seconds; s >= 1; s--){
      if(container._skipBreak || container._stopAll) { breakCountEl.textContent = '0'; break; }
      breakCountEl.textContent = String(s);
      beep(80, BEEP_FREQ, 0.05);
      await new Promise(res => setTimer(res, 1000));
    }
    breakRow.style.display = 'none';
    resolve(!container._stopAll);
  });
}

/* ============================================================================
   PLAYLIST CORE LOGIC (meets spec exactly)
   - plays each video once, even if shorter than play window
   - overlay countdown begins END_COUNT_SECONDS before window ends
   - no repeat of short videos; wait until play window completes
   - break between videos (BREAK_SECONDS)
   ============================================================================ */

async function playCategoryPlaylist(category, startId){
  try {
    // read UI overrides if present
    const ps = parseInt((playLengthSelect && playLengthSelect.value) || DEFAULT_PLAY_SECONDS, 10);
    const bs = parseInt((breakLengthSelect && breakLengthSelect.value) || BREAK_SECONDS, 10);
    DEFAULT_PLAY_SECONDS = isFinite(ps) && ps > 0 ? ps : DEFAULT_PLAY_SECONDS;
    BREAK_SECONDS = isFinite(bs) && bs >= 0 ? bs : BREAK_SECONDS;

    // fetch routines each time to maintain server order
    const resp = await fetch('/api/routines');
    if(!resp.ok) throw new Error('failed to fetch routines');
    const all = await resp.json();

    // build playlist list
    const list = (category && String(category).trim() !== '') ? all.filter(r => (r.category || '').toLowerCase() === (category || '').toLowerCase()) : all.slice();

    if(list.length === 0){
      alert('No videos found in this category.');
      return;
    }

    // compute start index
    let startIndex = 0;
    if(startId){
      const idx = list.findIndex(x => String(x.id) === String(startId));
      if(idx >= 0) startIndex = idx;
    }

    // prepare modal player
    const container = document.getElementById(modalContainerId) || buildModal();
    showModal();
    const videoEl = document.getElementById('te_playlist_video');
    const playBtn = document.getElementById('te_playpause');
    const statusEl = document.getElementById('te_play_status');

    // playlist iteration
    for(let idx = startIndex; idx < list.length; idx++){
      container._skipBreak = false;
      container._stopAll = false;
      container._skipNow = false;

      const item = list[idx];

      // decide per-item playSeconds: prefer item.play_seconds, else DEFAULT
      let playSeconds = DEFAULT_PLAY_SECONDS;
      if(item.play_seconds && Number(item.play_seconds) > 0) playSeconds = Number(item.play_seconds);

      // set video src and load (best-effort)
      try { videoEl.pause(); videoEl.src = item.video_url; videoEl.load(); } catch(e){ console.warn('video set error', e); }

      // small wait for metadata with fallback
      await new Promise(res => {
        let resolved = false;
        const onmeta = () => { if(resolved) return; resolved = true; videoEl.removeEventListener('loadedmetadata', onmeta); res(); };
        videoEl.addEventListener('loadedmetadata', onmeta);
        setTimer(() => { if(!resolved) { resolved = true; try{ videoEl.removeEventListener('loadedmetadata', onmeta); }catch(e){} res(); } }, 1200);
      });

      // start playback (may require user gesture)
      try {
        await videoEl.play();
        if(playBtn) playBtn.innerText = 'Pause';
        if(statusEl) statusEl.innerText = 'Playing';
      } catch(e){
        if(playBtn) playBtn.innerText = 'Play';
        if(statusEl) statusEl.innerText = 'Paused (tap to play)';
      }

      // set playing indicator
      playingVideoUrl = item.video_url;
      updateIndicators();

      // If video ends early, record it but do NOT repeat; we wait remainder of playSeconds
      let endedEarly = false;
      const onEnded = () => { endedEarly = true; };
      videoEl.addEventListener('ended', onEnded);

      // schedule overlay countdown to start at playSeconds - END_COUNT_SECONDS
      const countStartAt = Math.max(0, (playSeconds - END_COUNT_SECONDS) * 1000);

      // wait until overlay countdown time or until user stops session or skip now
      await new Promise(res => {
        cancelTimers();
        const stopCheck = setInterval(() => {
          if(container._stopAll || container._skipNow) { clearInterval(stopCheck); cancelTimers(); res(); }
        }, 200);
        setTimer(async () => {
          clearInterval(stopCheck);
          // run overlay countdown
          await runOverlayCountdown(END_COUNT_SECONDS);
          // pause the video at countdown end (if playing)
          try { videoEl.pause(); if(playBtn) playBtn.innerText = 'Play'; if(statusEl) statusEl.innerText = 'Paused'; } catch(e){}
          res();
        }, countStartAt);
      });

      // cleanup ended listener
      try { videoEl.removeEventListener('ended', onEnded); } catch(e){}

      // track play (best-effort)
      try {
        if(currentUser && currentUser.username){
          fetch('/api/track_play', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ username: currentUser.username, country: currentUser.country, routine_id: item.id })
          }).catch(()=>{});
        }
      } catch(e){}

      // if last item, finish session
      const isLast = (idx === list.length - 1);
      if(isLast){
        await sessionFinished();
        return;
      }

      // run break countdown and check user actions
      const cont = await runBreakCountdown(BREAK_SECONDS);
      if(!cont || container._stopAll) { stopAndClose(); return; }
      // otherwise continue to next item
    }

    // if loop exits naturally keep behavior consistent
    if(AUTO_HIDE_MODAL_ON_FINISH) stopAndClose();

  } catch(err){
    console.error('playlist error', err);
    stopAndClose();
    alert('Could not start playlist — see console for details.');
  }
}

/* ============================================================================
   SESSION FINISHED HANDLER
   - shows large congrats overlay then stops
   ============================================================================ */
async function sessionFinished(){
  try {
    const overlay = document.getElementById('te_overlay_count');
    if(overlay){
      overlay.style.display = 'block';
      overlay.textContent = '🎉';
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

/* ============================================================================
   INDICATOR REFRESH LOOP (keeps indicators synced)
   ============================================================================ */
function startIndicatorRefresh(){
  setInterval(updateIndicators, 800);
}

/* ============================================================================
   BOOTSTRAP ON LOAD
   ============================================================================ */
window.addEventListener('load', async () => {

  // restore user
  const u = localStorage.getItem('te_user');
  if(u){
    try { currentUser = JSON.parse(u); } catch(e){ currentUser = null; }
  }

  if(currentUser && currentUser.username){
    openHub();
  } else {
    if(authSection) authSection.hidden = false;
    if(hubSection) hubSection.hidden = true;
  }

  // warm saved index from idb or fallback
  try {
    const list = await safe_listSavedVideos();
    list.forEach(m => { if(m && m.url) savedVideosIndex[m.url] = m; });
  } catch(e){ log('warm saved index error', e); }

  // show install hint if needed
  setTimeout(async () => {
    if(!deferredInstallPrompt){
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

  // start indicator updates
  startIndicatorRefresh();

  // wire play/break selectors (UI driven)
  if(playLengthSelect){
    playLengthSelect.addEventListener('change', () => {
      const v = parseInt(playLengthSelect.value, 10) || DEFAULT_PLAY_SECONDS;
      DEFAULT_PLAY_SECONDS = v;
    });
  }
  if(breakLengthSelect){
    breakLengthSelect.addEventListener('change', () => {
      const v = parseInt(breakLengthSelect.value, 10) || BREAK_SECONDS;
      BREAK_SECONDS = v;
    });
  }

  // handle page visibility: when user switches tab, pause active playback to be polite
  document.addEventListener('visibilitychange', () => {
    try {
      const v = document.getElementById('te_playlist_video');
      if(!v) return;
      if(document.visibilityState === 'hidden'){
        v.pause();
        const playBtn = document.getElementById('te_playpause'); if(playBtn) playBtn.innerText = 'Play';
      } else {
        // do not auto-resume — let user press play
      }
    } catch(e){}
  });

});

/* ============================================================================
   STORAGE ESTIMATION & CACHING HELPERS
   - estimateStorageNeeded, downloadAllVideos (kept but optional; does not auto-inject UI)
   ============================================================================ */

async function estimateStorageNeeded(totalBytesApprox) {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota, free: quota - (usage || 0), needed: totalBytesApprox };
  } catch (e) {
    return null;
  }
}

// Optional download-all functionality (kept but not automatically shown)
async function downloadAllVideos(progressCallback){
  // gather list of unique urls
  const urls = [];
  allRoutines.forEach(r => {
    if(r.video_url) urls.push(r.video_url);
    if(r.thumbnail_url) urls.push(r.thumbnail_url);
  });
  const uniq = Array.from(new Set(urls)).filter(Boolean);
  if(!uniq.length) return alert('No videos found to download.');

  // estimate & consent
  if(uniq.length > 20){
    if(!confirm(`You're about to download ${uniq.length} media items for offline use. This may use a lot of device storage and bandwidth. Continue?`)) return;
  }

  // service worker controller required for SW-based caching (if you prefer)
  if(!('serviceWorker' in navigator) || !navigator.serviceWorker.controller){
    // fallback: cache directly via Cache API
    const cache = await caches.open(RUNTIME_CACHE);
    for(let i=0;i<uniq.length;i++){
      try {
        const url = uniq[i];
        const r = await fetch(url, { mode: 'cors' });
        if(r.ok) await cache.put(url, r.clone());
      } catch(e){
        console.warn('cache error for', uniq[i], e);
      }
      if(progressCallback) progressCallback({ index: i+1, total: uniq.length, url: uniq[i] });
    }
    if(progressCallback) progressCallback({ type: 'complete', total: uniq.length });
    return;
  }

  // if we have SW controller, send message to SW to cache
  try {
    navigator.serviceWorker.controller.postMessage({ cmd: 'cacheVideos', urls: uniq });
    // hook a one-time message response if the page needs it - SW side must postMessage back
  } catch(e){
    console.warn('send to SW failed', e);
    // fallback to direct caching approach above
    const cache = await caches.open(RUNTIME_CACHE);
    for(let i=0;i<uniq.length;i++){
      try {
        const url = uniq[i];
        const r = await fetch(url, { mode: 'cors' });
        if(r.ok) await cache.put(url, r.clone());
      } catch(err){ console.warn('cache fallback error', err); }
      if(progressCallback) progressCallback({ index: i+1, total: uniq.length, url: uniq[i] });
    }
    if(progressCallback) progressCallback({ type: 'complete', total: uniq.length });
  }
}

/* ============================================================================
   EXPORTS FOR DEBUGGING / MANUAL TRIGGERS
   ============================================================================ */
window.TE = window.TE || {};
window.TE.playCategoryPlaylist = playCategoryPlaylist;
window.TE.stopSession = stopAndClose;
window.TE.saveVideoForOffline = saveVideoForOffline;
window.TE.removeSavedVideo = removeSavedVideo;
window.TE.downloadAllVideos = downloadAllVideos;

/* ============================================================================
   END OF FILE — verbose, feature rich, upgraded main.js
   ============================================================================ */

