// static/js/main.js
'use strict';

/* ---------------- configuration ---------------- */
const RUNTIME_CACHE = 'tomorrow-runtime-v1';

// defaults (user can override in modal)
let DEFAULT_PLAY_SECONDS = 20; // default play window (seconds)
let END_COUNT_SECONDS = 3;     // overlay countdown length before moving on
let BREAK_SECONDS = 10;        // break between videos (seconds)

// DOM helpers
const $ = id => document.getElementById(id);
const authForm = $('authForm');
const authSection = $('authSection');
const hubSection = $('hubSection');
const welcomeText = $('welcomeText');
const routineGrid = $('routineGrid');
const categoryRow = $('categoryRow');
const editProfile = $('editProfile');
const signOut = $('signOut');

const categories = ["All","Strength","Cardio","Flexibility","Elderly","Special","General"];

let currentUser = null;
let allRoutines = [];
let savedVideosIndex = {}; // url -> meta
let selectedCategory = null;
let playingVideoUrl = null;
let _timers = [];

/* ---------------- timer helpers ---------------- */
function setTimer(fn, ms){ const t = setTimeout(fn, ms); _timers.push(t); return t; }
function clearTimer(t){ clearTimeout(t); _timers = _timers.filter(x=>x!==t); clearTimeout(t); }
function cancelTimers(){ _timers.forEach(t=>clearTimeout(t)); _timers=[]; }

/* ---------------- beep (small) ---------------- */
function beep(durationMs=90, freq=900, vol=0.04) {
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

/* ---------------- UI rendering ---------------- */
function renderCategories(){
  if(!categoryRow) return;
  categoryRow.innerHTML = '';
  // Render in rows of two as requested (All & Strength on first row etc)
  categories.forEach(cat => {
    const b = document.createElement('button');
    b.className = 'cat-pill';
    b.innerText = cat;
    b.onclick = ()=>{ 
      selectedCategory = (cat === 'All' || cat === 'General') ? null : cat; 
      setActiveCat(cat); 
      renderRoutines();
    };
    categoryRow.appendChild(b);
  });
  setActiveCat('All');
}

function setActiveCat(catName){
  if(!categoryRow) return;
  Array.from(categoryRow.children).forEach(ch=>{
    const txt = (ch.innerText || '').trim();
    if(txt === catName) ch.classList.add('active'); else ch.classList.remove('active');
  });
}

function formatDuration(sec){
  sec = parseInt(sec) || 0;
  if(sec < 60) return `${sec}s`;
  const m = Math.floor(sec/60);
  const s = sec%60;
  return `${m}m ${s}s`;
}

/* ---------------- render routines ---------------- */
async function renderRoutines(){
  if(!routineGrid) return;
  routineGrid.innerHTML = '';

  const routines = selectedCategory ? allRoutines.filter(r => r.category === selectedCategory) : allRoutines;
  if(!routines || routines.length === 0){
    routineGrid.innerHTML = `<div class="card" style="padding:20px"><div class="tiny-note">No routines found.</div></div>`;
    return;
  }

  // refresh saved index
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

    const thumb = document.createElement('div'); thumb.className = 'routine-thumb';
    if(r.thumbnail_url){
      const img = document.createElement('img'); img.src = r.thumbnail_url; img.alt = r.title || 'thumb';
      img.style.width = '100%'; img.style.height = '100%'; img.style.objectFit = 'cover';
      thumb.appendChild(img);
    } else {
      thumb.innerHTML = `<div style="padding:12px;color:var(--muted);font-size:16px">${r.category||''}</div>`;
    }

    // indicator
    const indicator = document.createElement('span');
    indicator.className = 'te-indicator';
    indicator.setAttribute('aria-hidden','true');
    thumb.style.position = 'relative';
    thumb.appendChild(indicator);

    const info = document.createElement('div');
    info.style.flex = '1';
    const title = document.createElement('div'); title.className = 'routine-title'; title.innerText = r.title || 'Untitled';
    const meta = document.createElement('div'); meta.className = 'routine-meta';
    meta.innerText = `${r.difficulty || 'medium'} • ${formatDuration(r.duration)} • views ${r.views || 0}`;

    info.appendChild(title);
    info.appendChild(meta);

    const actions = document.createElement('div'); actions.className = 'routine-actions';
    const saveBtn = document.createElement('button');
    const isSaved = !!savedVideosIndex[r.video_url];
    saveBtn.className = isSaved ? 'remove-btn' : 'save-btn';
    saveBtn.innerText = isSaved ? 'Saved' : 'Save';
    saveBtn.onclick = async (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      try {
        const currentlySaved = !!savedVideosIndex[r.video_url];
        if(currentlySaved){ saveBtn.disabled = true; await removeSavedVideo(r.video_url); saveBtn.className='save-btn'; saveBtn.innerText='Save'; }
        else { saveBtn.disabled=true; saveBtn.innerText='Saving...'; await saveVideoForOffline(r); saveBtn.className='remove-btn'; saveBtn.innerText='Saved'; }
      } catch(err){ alert('Could not change saved state.'); }
      const list = await listSavedVideos().catch(()=>[]);
      savedVideosIndex = {}; list.forEach(m=>{ if(m && m.url) savedVideosIndex[m.url] = m; });
      saveBtn.disabled = false;
      updateIndicators();
    };

    actions.appendChild(saveBtn);

    a.appendChild(thumb);
    a.appendChild(info);
    a.appendChild(actions);

    // initial saved
    if(isSaved) indicator.classList.add('saved');

    // clicking a card should launch the category playlist starting at this routine
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      const cat = a.dataset.category || '';
      const idAttr = a.dataset.id;
      playCategoryPlaylist(cat === '' ? null : cat, idAttr);
    });

    routineGrid.appendChild(a);
  });
}

/* ---------------- data loading ---------------- */
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

/* ---------------- auth / hub ---------------- */
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
if(guestBtn) guestBtn.addEventListener('click', ()=>{ currentUser={username:'guest',country:'Guest',id:null}; localStorage.setItem('te_user', JSON.stringify(currentUser)); openHub(); });

if(signOut) signOut.addEventListener('click', ()=>{ localStorage.removeItem('te_user'); location.reload(); });

if(editProfile) editProfile.addEventListener('click', ()=> {
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
  setActiveCat('All');
  loadRoutines();
}

/* ---------------- service worker (if present) ---------------- */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/static/js/sw.js').then(reg=>console.log('SW registered', reg)).catch(e=>console.warn('sw failed',e));
}

/* ---------------- indexdb & cache helpers (idb.js expected) ---------------- */
// The app expects functions from idb.js:
// saveVideoMeta(meta), getVideoMeta(url), listSavedVideos(), removeVideoMeta(url)
async function saveVideoForOffline(routine){
  if(!routine || !routine.video_url) throw new Error('no video url');
  const url = routine.video_url;
  // best-effort cache put
  try {
    const cache = await caches.open(RUNTIME_CACHE);
    const resp = await fetch(url, {mode:'cors'});
    if(resp && resp.ok) await cache.put(url, resp.clone());
  } catch(e){ console.warn('cache put failed', e); }
  const meta = { url: url, title: routine.title || 'Untitled', category: routine.category || '', thumbnail_url: routine.thumbnail_url || null, duration: routine.duration || 0, saved_at: new Date().toISOString() };
  try { await saveVideoMeta(meta); } catch(e){ console.warn('idb save failed', e); }
  savedVideosIndex[url] = meta;
  updateIndicators();
  return true;
}

async function removeSavedVideo(url){
  try { const cache = await caches.open(RUNTIME_CACHE); await cache.delete(url); } catch(e){ console.warn('cache delete failed', e); }
  try { await removeVideoMeta(url); } catch(e){ console.warn('idb remove failed', e); }
  delete savedVideosIndex[url];
  updateIndicators();
  return true;
}

/* ---------------- indicators ---------------- */
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
    ind.classList.toggle('saved', !!savedVideosIndex[url]);
    ind.classList.toggle('playing', playingVideoUrl === url);
  });
}

/* ---------------- modal / player builder ---------------- */
const modalContainerId = 'te_player_modal_container';
function ensureModalContainer(){
  let cont = document.getElementById(modalContainerId);
  if(!cont){
    cont = document.createElement('div'); cont.id = modalContainerId; cont.style.display = 'none'; document.body.appendChild(cont);
  }
  return cont;
}

function buildModal(){
  const container = ensureModalContainer();
  container.innerHTML = `
    <div id="te_modal" class="te-modal" role="dialog" aria-modal="true" style="display:flex">
      <div class="te-player" id="te_player_card" style="position:relative">
        <div style="position:relative;">
          <video id="te_playlist_video" playsinline webkit-playsinline controls controlsList="nodownload nofullscreen noremoteplayback" preload="auto" ></video>
          <div id="te_overlay_count" class="te-overlay-count" aria-hidden="true">3</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap;">
          <div style="display:flex;gap:8px;align-items:center;">
            <label style="font-weight:900;margin-right:6px">Play (s)</label>
            <select id="te_play_length" aria-label="Play length">
              <option value="15">15s</option>
              <option value="20" selected>20s (default)</option>
              <option value="30">30s</option>
              <option value="60">60s</option>
              <option value="custom">custom</option>
            </select>
            <input id="te_play_custom" type="number" placeholder="seconds" style="width:86px;display:none;padding:8px;border-radius:8px;border:1px solid #222;margin-left:6px;">
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <label style="font-weight:900;margin-right:6px">Break (s)</label>
            <select id="te_break_length" aria-label="Break length">
              <option value="5">5s</option>
              <option value="10" selected>10s (default)</option>
              <option value="15">15s</option>
              <option value="30">30s</option>
            </select>
          </div>
          <div style="margin-left:auto;display:flex;gap:8px;">
            <button id="te_skip_break" class="te-btn te-skip">Start Now</button>
            <button id="te_stop_all" class="te-btn te-stop">Stop Session</button>
          </div>
        </div>
        <div class="te-break" id="te_break_row" style="display:none;">
          <div>Break — next starts in <span class="count" id="te_break_count">${BREAK_SECONDS}</span>s</div>
        </div>
      </div>
    </div>`;
  // handlers
  const skipBtn = container.querySelector('#te_skip_break');
  const stopBtn = container.querySelector('#te_stop_all');
  const playSelect = container.querySelector('#te_play_length');
  const customInput = container.querySelector('#te_play_custom');
  const breakSelect = container.querySelector('#te_break_length');

  container._skipBreak = false; container._stopAll = false;

  skipBtn.addEventListener('click', ()=>{ container._skipBreak = true; });
  stopBtn.addEventListener('click', ()=>{ container._stopAll = true; });

  playSelect.addEventListener('change', ()=>{
    if(playSelect.value === 'custom'){ customInput.style.display='inline-block'; customInput.focus(); }
    else { customInput.style.display='none'; }
  });

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
  // exit fullscreen & unlock orientation if possible
  try { if(document.fullscreenElement) document.exitFullscreen().catch(()=>{}); } catch(e){}
  try { if(screen && screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch(e){}
  hideModal();
}

/* ---------------- overlay and break countdowns ---------------- */
async function runOverlayCountdown(seconds){
  const overlay = document.getElementById('te_overlay_count');
  if(!overlay) return;
  overlay.style.display = 'block';
  for(let s=seconds; s>=1; s--){
    overlay.textContent = String(s);
    beep(120, 900, 0.06);
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
      beep(80, 700, 0.04);
      await new Promise(res => setTimer(res, 1000));
    }
    breakRow.style.display = 'none';
    resolve(!container._stopAll);
  });
}

/* ---------------- playlist runner ---------------- */
async function playCategoryPlaylist(category, startId){
  try {
    const resp = await fetch('/api/routines');
    if(!resp.ok) throw new Error('failed to fetch routines');
    const all = await resp.json();
    let list = all;
    if(category) list = all.filter(r => (r.category||'').toLowerCase() === (category||'').toLowerCase());
    // "All" should play everything
    if(!list || list.length === 0){ alert('No videos found in this category.'); return; }

    // compute start index
    let startIndex = 0;
    if(startId){
      const idx = list.findIndex(x=>String(x.id) === String(startId));
      if(idx >= 0) startIndex = idx;
    }

    const container = document.getElementById(modalContainerId) || buildModal();
    showModal();
    const videoEl = document.getElementById('te_playlist_video');

    // disable picture-in-picture where possible and remove native download UI
    try { videoEl.disablePictureInPicture = true; } catch(e){}

    // intercept click: request fullscreen + orientation lock and play if available
    videoEl.onclick = async (ev) => {
      try {
        // request fullscreen on wrapper for orientation lock on many mobile browsers
        const playerCard = document.getElementById('te_player_card');
        if(playerCard && playerCard.requestFullscreen && !document.fullscreenElement){
          await playerCard.requestFullscreen().catch(()=>{});
        }
        // try to lock to landscape
        if(screen && screen.orientation && screen.orientation.lock){
          try { await screen.orientation.lock('landscape'); } catch(e){ /* may fail */ }
        }
        // try play
        try { await videoEl.play(); } catch(e){}
      } catch(e){ /* ignore */ }
    };

    // iterate playlist
    for(let idx = startIndex; idx < list.length; idx++){
      container._skipBreak = false; container._stopAll = false;
      const item = list[idx];

      // Determine playSeconds: modal selection > dataset > global default
      let modalCont = ensureModalContainer();
      const playSelect = modalCont.querySelector('#te_play_length');
      const customInput = modalCont.querySelector('#te_play_custom');
      const breakSelect = modalCont.querySelector('#te_break_length');

      let playSeconds = DEFAULT_PLAY_SECONDS;
      if(item.play_seconds && Number(item.play_seconds) > 0) playSeconds = Number(item.play_seconds);
      // if user changed modal selection, prefer it
      if(playSelect && playSelect.value){
        if(playSelect.value === 'custom' && customInput && Number(customInput.value) > 0) playSeconds = Number(customInput.value);
        else if(playSelect.value !== 'custom') playSeconds = Number(playSelect.value);
      }

      // break seconds selection
      let breakSeconds = BREAK_SECONDS;
      if(breakSelect && breakSelect.value) breakSeconds = Number(breakSelect.value);

      // set source and load
      videoEl.pause();
      videoEl.src = item.video_url;
      videoEl.load();

      // attempt to load metadata but DO NOT change timing based on duration.
      try {
        await new Promise(res=>{
          let resolved = false;
          const onmeta = () => { if(resolved) return; resolved = true; videoEl.removeEventListener('loadedmetadata', onmeta); res(); };
          videoEl.addEventListener('loadedmetadata', onmeta);
          setTimer(()=>{ if(!resolved){ resolved = true; try{ videoEl.removeEventListener('loadedmetadata', onmeta); }catch(e){} res(); } }, 1200);
        });
      } catch(e){ /* ignore */ }

      // start playback (autoplay may be blocked — video will wait for user if so)
      try { videoEl.currentTime = 0; await videoEl.play(); } catch(e){ /* rely on user to press play */ }

      // set playing indicator
      playingVideoUrl = item.video_url;
      updateIndicators();

      // schedule overlay countdown at playSeconds - END_COUNT_SECONDS (always based on playSeconds)
      const countStartAt = Math.max(0, (playSeconds - END_COUNT_SECONDS) * 1000);
      await new Promise(res => {
        // clear previous timers
        cancelTimers();
        // small stop-check interval to handle stopAll
        const stopCheck = setInterval(()=>{ if(container._stopAll){ clearInterval(stopCheck); cancelTimers(); res(); } }, 200);
        setTimer(async ()=>{
          clearInterval(stopCheck);
          // overlay countdown
          await runOverlayCountdown(END_COUNT_SECONDS);
          // pause the video when overlay finishes
          try{ videoEl.pause(); } catch(e){}
          res();
        }, countStartAt);
      });

      // record play (best effort)
      try {
        if(currentUser && currentUser.username){
          fetch('/api/track_play', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username: currentUser.username, country: currentUser.country, routine_id: item.id }) }).catch(()=>{});
        }
      } catch(e){}

      // run break countdown (skipable)
      const cont = await runBreakCountdown(breakSeconds);
      if(!cont || container._stopAll){ stopAndClose(); return; }
      // then loop to next item
    }

    // finished
    alert('Congrats — this activity is over.');
    stopAndClose();

  } catch(err){
    console.error('playlist error', err);
    stopAndClose();
    alert('Could not start playlist — see console for details.');
  }
}

/* ---------------- misc UI glue ---------------- */
function startIndicatorRefresh(){ setInterval(updateIndicators, 800); }

/* ---------------- boot ---------------- */
window.addEventListener('load', async ()=>{
  // restore user
  const u = localStorage.getItem('te_user');
  if(u){ try{ currentUser = JSON.parse(u); } catch(e){ currentUser = null; } }
  if(currentUser && currentUser.username) openHub();
  else { if(authSection) authSection.hidden = false; if(hubSection) hubSection.hidden = true; }

  // warm saved index
  const list = await listSavedVideos().catch(()=>[]);
  list.forEach(m => { if(m && m.url) savedVideosIndex[m.url] = m; });

  // start indicator refresh
  startIndicatorRefresh();
});
