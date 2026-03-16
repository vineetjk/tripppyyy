/* =============================================
   TRIPPPYYY – Trip Expense Sharing App
   ============================================= */

// --- Config ---
const STORAGE_KEY = 'tripppyyy_v1';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const ALLORIGINS = 'https://api.allorigins.win/get?url=';

// --- State ---
let state = {
  trips: [],
  currentTripId: null,
  geocodeCache: {},
};
let mapInstance = null;
let mapMarkers = [];
let routeLayer = null;
let currentSplitType = 'equal';

// =============================================
// DATA PERSISTENCE
// =============================================

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      state.trips = d.trips || [];
      state.geocodeCache = d.geocodeCache || {};
    }
  } catch (e) { console.error('Load error', e); }
}

function saveData() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      trips: state.trips,
      geocodeCache: state.geocodeCache,
    }));
  } catch (e) { console.error('Save error', e); }
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// =============================================
// GOOGLE MAPS URL PARSING
// =============================================

async function parseGoogleMapsUrl(rawUrl) {
  const url = rawUrl.trim();
  let expandedUrl = url;
  let places = [];

  // Step 1: Try to expand short URLs via CORS proxy
  const isShort = /maps\.app\.goo\.gl|goo\.gl\/maps/.test(url);
  if (isShort) {
    try {
      const proxyUrl = ALLORIGINS + encodeURIComponent(url);
      const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(12000) });
      const data = await res.json();
      const html = data.contents || '';

      // Extract the canonical / redirect URL from the HTML
      const patterns = [
        /rel="canonical"\s+href="([^"]+)"/,
        /<link[^>]+href="(https:\/\/(?:www\.google\.com\/maps|maps\.google\.com)[^"]+)"/,
        /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/,
        /INITIAL_DATA.*?"(https:\\\/\\\/www\.google\.com\\\/maps[^"]+)"/,
      ];
      for (const p of patterns) {
        const m = html.match(p);
        if (m) { expandedUrl = m[1].replace(/\\\//g, '/'); break; }
      }

      // Fallback: grab title
      if (expandedUrl === url) {
        const titleM = html.match(/<title[^>]*>([^<]+)<\/title>/);
        if (titleM) {
          const t = titleM[1].replace(/ [-–] Google Maps$/, '').trim();
          if (t && t !== 'Google Maps') places.push(t);
        }
      }
    } catch (e) {
      console.warn('URL expand failed:', e.message);
    }
  }

  if (places.length === 0) {
    places = extractPlacesFromUrl(expandedUrl);
  }

  return places;
}

function extractPlacesFromUrl(url) {
  const places = [];
  try {
    const u = new URL(url);
    const path = u.pathname;

    // /maps/dir/A/B/C pattern
    const dirM = path.match(/\/maps\/dir\/(.+)/);
    if (dirM) {
      const segs = dirM[1].split('/');
      for (const seg of segs) {
        if (!seg || seg.startsWith('@')) continue;
        const dec = decodeURIComponent(seg.replace(/\+/g, ' ')).trim();
        if (dec.length > 1 && !/^[\d.,]+$/.test(dec)) places.push(dec);
      }
    }

    // /maps/place/Name pattern
    if (!places.length) {
      const plM = path.match(/\/maps\/place\/([^/@]+)/);
      if (plM) places.push(decodeURIComponent(plM[1].replace(/\+/g, ' ')));
    }

    // Query params fallback
    if (!places.length) {
      const q = u.searchParams.get('q') || u.searchParams.get('query');
      if (q) places.push(decodeURIComponent(q));
    }

    // saddr/daddr (old format)
    const saddr = u.searchParams.get('saddr');
    const daddr = u.searchParams.get('daddr');
    if (saddr) places.unshift(saddr.replace(/\+/g, ' '));
    if (daddr) {
      const viaParts = daddr.split(/\+via:|\bvia:/i);
      viaParts.forEach(p => { const c = p.replace(/\+/g, ' ').trim(); if (c) places.push(c); });
    }
  } catch (_) {}
  return places.filter(Boolean);
}

// =============================================
// GEOCODING
// =============================================

async function geocodePlace(name) {
  const key = name.toLowerCase().trim();
  if (state.geocodeCache[key]) return state.geocodeCache[key];

  try {
    const p = new URLSearchParams({ q: name, format: 'json', limit: '1', addressdetails: '0' });
    const res = await fetch(`${NOMINATIM}?${p}`, {
      headers: { 'Accept-Language': 'en', 'User-Agent': 'Tripppyyy/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (json.length > 0) {
      const r = { lat: parseFloat(json[0].lat), lng: parseFloat(json[0].lon), displayName: json[0].display_name };
      state.geocodeCache[key] = r;
      saveData();
      return r;
    }
  } catch (e) {
    console.warn('Geocode error for', name, e.message);
  }
  return null;
}

async function geocodePlaces(names, onProgress) {
  const results = [];
  for (let i = 0; i < names.length; i++) {
    if (i > 0) await sleep(1100); // Nominatim rate limit: 1 req/sec
    onProgress && onProgress(i, names.length, names[i]);
    const r = await geocodePlace(names[i]);
    results.push({ name: names[i], ...(r || {}), found: !!r });
  }
  return results;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// =============================================
// TRIP / DATA OPERATIONS
// =============================================

function createTrip(name, places) {
  const trip = {
    id: uid(), name,
    places: places.map((p, i) => ({
      id: uid(), name: p.name, lat: p.lat || null, lng: p.lng || null,
      order: i, completed: false,
    })),
    members: [], expenses: [],
    createdAt: new Date().toISOString(),
  };
  state.trips.unshift(trip);
  saveData();
  return trip;
}

function deleteTrip(id) {
  state.trips = state.trips.filter(t => t.id !== id);
  saveData();
}

function getCurrentTrip() {
  return state.trips.find(t => t.id === state.currentTripId) || null;
}

function addMember(tripId, { name, upiId }) {
  const trip = state.trips.find(t => t.id === tripId);
  if (!trip) return null;
  const member = { id: uid(), name, upiId: upiId || '', color: pickColor(trip.members.length) };
  trip.members.push(member);
  saveData();
  return member;
}

function removeMember(tripId, memberId) {
  const trip = state.trips.find(t => t.id === tripId);
  if (!trip) return;
  trip.members = trip.members.filter(m => m.id !== memberId);
  trip.expenses.forEach(e => {
    e.splits = e.splits.filter(s => s.memberId !== memberId);
    if (e.paidBy === memberId) e.paidBy = null;
  });
  saveData();
}

function addExpense(tripId, data) {
  const trip = state.trips.find(t => t.id === tripId);
  if (!trip) return null;
  const expense = {
    id: uid(),
    description: data.description,
    amount: parseFloat(data.amount),
    paidBy: data.paidBy,
    splits: data.splits,
    date: data.date || today(),
    category: data.category || 'general',
    createdAt: new Date().toISOString(),
  };
  trip.expenses.push(expense);
  saveData();
  return expense;
}

function removeExpense(tripId, expenseId) {
  const trip = state.trips.find(t => t.id === tripId);
  if (!trip) return;
  trip.expenses = trip.expenses.filter(e => e.id !== expenseId);
  saveData();
}

function togglePlace(tripId, placeId) {
  const trip = state.trips.find(t => t.id === tripId);
  const place = trip?.places.find(p => p.id === placeId);
  if (place) { place.completed = !place.completed; saveData(); }
}

function addPlace(tripId, place) {
  const trip = state.trips.find(t => t.id === tripId);
  if (!trip) return;
  trip.places.push({ id: uid(), name: place.name, lat: place.lat || null, lng: place.lng || null, order: trip.places.length, completed: false });
  saveData();
}

function removePlace(tripId, placeId) {
  const trip = state.trips.find(t => t.id === tripId);
  if (!trip) return;
  trip.places = trip.places.filter(p => p.id !== placeId);
  trip.places.forEach((p, i) => p.order = i);
  saveData();
}

function today() { return new Date().toISOString().split('T')[0]; }

// =============================================
// FINANCIAL CALCULATIONS
// =============================================

function calcBalances(trip) {
  const bal = {};
  trip.members.forEach(m => { bal[m.id] = 0; });
  trip.expenses.forEach(e => {
    if (!e.paidBy || bal[e.paidBy] === undefined) return;
    bal[e.paidBy] += e.amount;
    e.splits.forEach(s => { if (bal[s.memberId] !== undefined) bal[s.memberId] -= s.amount; });
  });
  return bal;
}

function simplifyDebts(trip) {
  const bal = calcBalances(trip);
  const creditors = [], debtors = [];
  Object.entries(bal).forEach(([id, b]) => {
    if (b > 0.01) creditors.push({ id, amount: b });
    else if (b < -0.01) debtors.push({ id, amount: -b });
  });
  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);

  const debts = [];
  let i = 0, j = 0;
  while (i < creditors.length && j < debtors.length) {
    const cr = creditors[i], db = debtors[j];
    const amt = Math.min(cr.amount, db.amount);
    if (amt > 0.01) debts.push({ from: db.id, to: cr.id, amount: round2(amt) });
    cr.amount -= amt; db.amount -= amt;
    if (cr.amount < 0.01) i++;
    if (db.amount < 0.01) j++;
  }
  return debts;
}

function getTotalExpenses(trip) { return trip.expenses.reduce((s, e) => s + e.amount, 0); }
function getMemberPaid(trip, id) { return trip.expenses.filter(e => e.paidBy === id).reduce((s, e) => s + e.amount, 0); }
function getMemberShare(trip, id) { return trip.expenses.reduce((s, e) => { const sp = e.splits.find(s => s.memberId === id); return s + (sp ? sp.amount : 0); }, 0); }
function round2(n) { return Math.round(n * 100) / 100; }

// =============================================
// UPI PAYMENT
// =============================================

function upiLink(upiId, name, amount, note) {
  const p = new URLSearchParams({ pa: upiId, pn: name, am: amount.toFixed(2), cu: 'INR', tn: note || 'Trip Settlement' });
  return `upi://pay?${p.toString()}`;
}

function buildPayButtons(toMember, amount, tripName) {
  if (!toMember.upiId) {
    return `<span class="no-upi">No UPI ID · <button class="btn-link" onclick="switchTab('members')">Add UPI ID</button></span>`;
  }
  const note = encodeURIComponent(`${tripName} settlement`);
  const upiHref = upiLink(toMember.upiId, toMember.name, amount, `${tripName} settlement`);
  const gpayHref = `gpay://upi/pay?pa=${encodeURIComponent(toMember.upiId)}&pn=${encodeURIComponent(toMember.name)}&am=${amount.toFixed(2)}&cu=INR&tn=${note}`;
  const phonepeHref = `phonepe://pay?pa=${encodeURIComponent(toMember.upiId)}&pn=${encodeURIComponent(toMember.name)}&am=${amount.toFixed(2)}&cu=INR&tn=${note}`;
  const paytmHref = `paytmmp://pay?pa=${encodeURIComponent(toMember.upiId)}&pn=${encodeURIComponent(toMember.name)}&am=${amount.toFixed(2)}&cu=INR&tn=${note}`;

  return `
    <div class="upi-options">
      <a href="${upiHref}" class="btn-pay" onclick="toast('Opening UPI app...','success')">💳 Pay ₹${fmt(amount)}</a>
      <a href="${gpayHref}" class="upi-option" onclick="toast('Opening GPay...','success')">
        <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/f/f2/Google_Pay_Logo.svg/512px-Google_Pay_Logo.svg.png" width="16" height="16" alt="GPay"> GPay
      </a>
      <a href="${phonepeHref}" class="upi-option" onclick="toast('Opening PhonePe...','success')">📱 PhonePe</a>
      <a href="${paytmHref}" class="upi-option" onclick="toast('Opening Paytm...','success')">💰 Paytm</a>
    </div>
  `;
}

// =============================================
// UTILITIES
// =============================================

const COLORS = ['#6366f1','#f59e0b','#10b981','#ef4444','#8b5cf6','#f97316','#06b6d4','#ec4899','#84cc16','#14b8a6'];
function pickColor(i) { return COLORS[i % COLORS.length]; }
function initials(name) { return (name || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2); }
function fmt(n) {
  if (isNaN(n) || n == null) return '0.00';
  return new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const CAT_ICONS = { food:'🍽️', transport:'🚗', hotel:'🏨', activity:'🎯', fuel:'⛽', shopping:'🛍️', medical:'💊', general:'💰' };

// =============================================
// MAP
// =============================================

function initMap(containerId) {
  if (mapInstance) { try { mapInstance.remove(); } catch(_){} mapInstance = null; }
  mapMarkers = []; routeLayer = null;

  mapInstance = L.map(containerId, { zoomControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(mapInstance);
  return mapInstance;
}

function renderMap(trip) {
  if (!mapInstance) return;
  mapMarkers.forEach(m => { try { mapInstance.removeLayer(m); } catch(_){} });
  mapMarkers = [];
  if (routeLayer) { try { mapInstance.removeLayer(routeLayer); } catch(_){} routeLayer = null; }

  const places = trip.places.filter(p => p.lat && p.lng);
  if (!places.length) {
    mapInstance.setView([20.5937, 78.9629], 5); // India center
    return;
  }

  places.forEach((p, i) => {
    const icon = makeMarkerIcon(i + 1, p.completed);
    const m = L.marker([p.lat, p.lng], { icon })
      .bindPopup(`<div class="map-popup"><strong>${escHtml(p.name)}</strong>${p.completed ? '<br><span class="popup-done">✓ Visited</span>' : ''}</div>`)
      .addTo(mapInstance);
    mapMarkers.push(m);
  });

  if (places.length > 1) {
    const coords = places.map(p => [p.lat, p.lng]);
    L.polyline(coords, { color: '#6366f1', weight: 4, opacity: 0.65 }).addTo(mapInstance);
    routeLayer = L.polyline(coords, { color: '#a5b4fc', weight: 2, opacity: 0.6, dashArray: '8 6' }).addTo(mapInstance);
  }

  const bounds = L.latLngBounds(places.map(p => [p.lat, p.lng]));
  mapInstance.fitBounds(bounds, { padding: [48, 48] });
}

function makeMarkerIcon(num, completed) {
  const bg = completed ? '#10b981' : '#6366f1';
  const label = completed ? '✓' : num;
  const fs = completed ? '15px' : '12px';
  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="background:${bg};color:white;width:34px;height:34px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:3px solid white;box-shadow:0 4px 10px rgba(0,0,0,0.25);display:flex;align-items:center;justify-content:center"><span style="transform:rotate(45deg);font-weight:800;font-size:${fs}">${label}</span></div>`,
    iconSize: [34, 34], iconAnchor: [17, 34], popupAnchor: [0, -36],
  });
}

// =============================================
// TOAST
// =============================================

function toast(msg, type = 'info') {
  const prev = document.getElementById('toast');
  if (prev) prev.remove();
  const el = document.createElement('div');
  el.id = 'toast';
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => {
    el.classList.add('show');
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 350); }, 3000);
  });
}

// =============================================
// RENDER: HOME VIEW
// =============================================

function renderHome() {
  document.getElementById('app').innerHTML = `
    <div class="home-view">
      <header class="app-header">
        <div class="header-bg"></div>
        <div class="header-content">
          <div class="logo"><span class="logo-icon">✈️</span><h1>Tripppyyy</h1></div>
          <p class="tagline">Plan trips. Split expenses. Explore together.</p>
        </div>
      </header>
      <main class="home-main">
        <div class="section-header">
          <h2>Your Trips</h2>
          <button class="btn-primary" onclick="showNewTripModal()">+ New Trip</button>
        </div>
        ${state.trips.length === 0 ? `
          <div class="empty-state">
            <span class="empty-icon">🗺️</span>
            <h3>No trips yet</h3>
            <p>Create your first trip by pasting a Google Maps link or entering destinations manually</p>
            <button class="btn-primary large" onclick="showNewTripModal()">Create Trip</button>
          </div>
        ` : `<div class="trips-grid">${state.trips.map(tripCard).join('')}</div>`}
      </main>
    </div>

    <!-- New Trip Modal -->
    <div id="new-trip-modal" class="modal hidden">
      <div class="modal-overlay" onclick="hideNewTripModal()"></div>
      <div class="modal-content large-modal">
        <div class="modal-header">
          <h2>✈️ Create New Trip</h2>
          <button class="btn-close" onclick="hideNewTripModal()">×</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>Trip Name *</label>
            <input type="text" id="trip-name" placeholder="e.g., Goa Weekend, Ladakh Road Trip" class="form-input">
          </div>
          <div class="form-group">
            <label>Google Maps Link (optional)</label>
            <div class="input-with-btn">
              <input type="text" id="maps-url" placeholder="Paste Google Maps URL..." class="form-input">
              <button class="btn-secondary" onclick="fetchFromUrl()" id="fetch-btn">Fetch Places</button>
            </div>
            <p class="input-hint">Paste any Google Maps directions or place URL to auto-extract destinations</p>
          </div>
          <div class="form-group">
            <label>Destinations</label>
            <div id="places-input-list"></div>
            <button class="btn-ghost small" onclick="addPlaceInput()" style="margin-top:6px">+ Add Destination</button>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-ghost" onclick="hideNewTripModal()">Cancel</button>
          <button class="btn-primary" onclick="doCreateTrip()" id="create-trip-btn">Create Trip</button>
        </div>
      </div>
    </div>
  `;
  addPlaceInput();
}

function tripCard(trip) {
  const total = getTotalExpenses(trip);
  const done = trip.places.filter(p => p.completed).length;
  const pct = trip.places.length ? (done / trip.places.length * 100) : 0;
  return `
    <div class="trip-card" onclick="openTrip('${trip.id}')">
      <div class="trip-card-header">
        <h3>${escHtml(trip.name)}</h3>
        <span class="trip-date">${new Date(trip.createdAt).toLocaleDateString('en-IN',{month:'short',day:'numeric',year:'numeric'})}</span>
      </div>
      <div class="trip-progress">
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
        <span class="progress-text">${done}/${trip.places.length} places visited</span>
      </div>
      <div class="trip-stats">
        <div class="stat"><span class="stat-icon">📍</span><span>${trip.places.length} stops</span></div>
        <div class="stat"><span class="stat-icon">👥</span><span>${trip.members.length} members</span></div>
        <div class="stat"><span class="stat-icon">💰</span><span>₹${fmt(total)}</span></div>
      </div>
    </div>`;
}

// =============================================
// RENDER: TRIP VIEW
// =============================================

function renderTrip(tripId) {
  const trip = state.trips.find(t => t.id === tripId);
  if (!trip) { renderHome(); return; }
  state.currentTripId = tripId;

  document.getElementById('app').innerHTML = `
    <div class="trip-view">
      <header class="trip-header">
        <button class="btn-back" onclick="goHome()">← Back</button>
        <div class="trip-title">
          <h1>${escHtml(trip.name)}</h1>
          <span class="trip-meta">${trip.places.length} places · ${trip.members.length} members</span>
        </div>
        <button class="btn-icon danger" onclick="confirmDelete('${trip.id}')" title="Delete trip">🗑️</button>
      </header>
      <div class="tabs">
        <button class="tab active" onclick="switchTab('map')" id="tab-map">🗺️ Map</button>
        <button class="tab" onclick="switchTab('itinerary')" id="tab-itinerary">📍 Itinerary</button>
        <button class="tab" onclick="switchTab('expenses')" id="tab-expenses">💰 Expenses</button>
        <button class="tab" onclick="switchTab('members')" id="tab-members">👥 Members</button>
        <button class="tab" onclick="switchTab('settle')" id="tab-settle">🧾 Settle Up</button>
      </div>
      <div id="tab-body"></div>
    </div>
    <div id="modals"></div>
  `;
  switchTab('map');
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const btn = document.getElementById('tab-' + name);
  if (btn) btn.classList.add('active');
  const body = document.getElementById('tab-body');
  const trip = getCurrentTrip();
  if (!trip || !body) return;
  if (name === 'map') renderMapTab(trip, body);
  else if (name === 'itinerary') renderItineraryTab(trip, body);
  else if (name === 'expenses') renderExpensesTab(trip, body);
  else if (name === 'members') renderMembersTab(trip, body);
  else if (name === 'settle') renderSettleTab(trip, body);
}

// --- MAP TAB ---
function renderMapTab(trip, el) {
  const places = trip.places;
  el.innerHTML = `
    <div class="map-tab">
      <div id="map" class="map-container"></div>
      <div class="map-legend">
        ${places.length ? places.map((p, i) => `
          <div class="legend-item ${p.completed ? 'completed' : ''}">
            <span class="legend-number" style="background:${p.completed ? '#10b981' : '#6366f1'}">${i+1}</span>
            <span class="legend-name">${escHtml(p.name)}</span>
            ${p.completed ? '<span class="legend-check">✓</span>' : ''}
          </div>`).join('') : '<span style="color:var(--text-muted);font-size:13px">No destinations yet. Add them in the Itinerary tab.</span>'}
      </div>
    </div>`;
  requestAnimationFrame(() => { initMap('map'); renderMap(trip); });
}

// --- ITINERARY TAB ---
function renderItineraryTab(trip, el) {
  el.innerHTML = `
    <div class="itinerary-tab">
      <div class="section-header">
        <h2>Itinerary</h2>
        <button class="btn-primary small" onclick="showAddPlaceModal()">+ Add Stop</button>
      </div>
      <div class="places-list">
        ${!trip.places.length ? `<div class="empty-state small"><p>No destinations yet. Add your first stop!</p></div>` :
          trip.places.map((p, i) => `
            <div class="place-item ${p.completed ? 'completed' : ''}">
              <div class="place-number">${i+1}</div>
              <div class="place-checkbox" onclick="handleTogglePlace('${trip.id}','${p.id}')">
                <div class="checkbox ${p.completed ? 'checked' : ''}">${p.completed ? '✓' : ''}</div>
              </div>
              <div class="place-info">
                <span class="place-name">${escHtml(p.name)}</span>
                ${p.completed ? '<span class="place-tag visited">Visited</span>' : ''}
                ${!p.lat ? '<span class="place-tag" style="background:#fef3c7;color:#b45309">No coords</span>' : ''}
              </div>
              <button class="btn-icon small danger" onclick="handleRemovePlace('${trip.id}','${p.id}')">×</button>
            </div>`).join('')}
      </div>
    </div>`;
}

// --- EXPENSES TAB ---
function renderExpensesTab(trip, el) {
  const total = getTotalExpenses(trip);
  el.innerHTML = `
    <div class="expenses-tab">
      <div class="expenses-summary">
        <div class="summary-card">
          <span class="summary-label">Total</span>
          <span class="summary-amount">₹${fmt(total)}</span>
        </div>
        ${trip.members.map(m => {
          const paid = getMemberPaid(trip, m.id);
          const share = getMemberShare(trip, m.id);
          return `<div class="summary-card member-summary" style="border-left:4px solid ${m.color}">
            <div class="member-avatar small" style="background:${m.color}">${initials(m.name)}</div>
            <div class="summary-details">
              <span class="summary-name">${escHtml(m.name)}</span>
              <span class="summary-stats">Paid ₹${fmt(paid)} · Share ₹${fmt(share)}</span>
            </div>
          </div>`;
        }).join('')}
      </div>
      <div class="section-header">
        <h2>Expenses</h2>
        <button class="btn-primary small" onclick="showAddExpenseModal()" ${trip.members.length === 0 ? 'disabled title="Add members first"' : ''}>+ Add Expense</button>
      </div>
      ${!trip.expenses.length ? `<div class="empty-state small"><p>${trip.members.length === 0 ? 'Add members first, then add expenses.' : 'No expenses yet. Add your first one!'}</p></div>` : `
      <div class="expenses-list">
        ${[...trip.expenses].reverse().map(exp => {
          const payer = trip.members.find(m => m.id === exp.paidBy);
          return `<div class="expense-item">
            <div class="expense-icon">${CAT_ICONS[exp.category] || '💰'}</div>
            <div class="expense-info">
              <span class="expense-name">${escHtml(exp.description)}</span>
              <span class="expense-meta">${exp.date} · Paid by ${escHtml(payer?.name || 'Unknown')}</span>
              <div class="expense-splits">
                ${exp.splits.map(s => {
                  const m = trip.members.find(m => m.id === s.memberId);
                  return m ? `<span class="split-tag" style="background:${m.color}20;border:1px solid ${m.color}40;color:${m.color}">${escHtml(m.name)}: ₹${fmt(s.amount)}</span>` : '';
                }).join('')}
              </div>
            </div>
            <div class="expense-amount">₹${fmt(exp.amount)}</div>
            <button class="btn-icon small danger" onclick="handleRemoveExpense('${trip.id}','${exp.id}')">×</button>
          </div>`;
        }).join('')}
      </div>`}
    </div>`;
}

// --- MEMBERS TAB ---
function renderMembersTab(trip, el) {
  el.innerHTML = `
    <div class="members-tab">
      <div class="section-header">
        <h2>Members</h2>
        <button class="btn-primary small" onclick="showAddMemberModal()">+ Add Member</button>
      </div>
      ${!trip.members.length ? `<div class="empty-state small"><p>No members yet. Add people to split expenses!</p></div>` : `
      <div class="members-list">
        ${trip.members.map(m => {
          const paid = getMemberPaid(trip, m.id);
          const share = getMemberShare(trip, m.id);
          const bal = calcBalances(trip)[m.id] || 0;
          return `<div class="member-card">
            <div class="member-avatar large" style="background:${m.color}">${initials(m.name)}</div>
            <div class="member-info">
              <h3 class="member-name">${escHtml(m.name)}</h3>
              <p class="member-upi">${m.upiId ? '📱 ' + escHtml(m.upiId) : '⚠️ No UPI ID'}</p>
              <div class="member-stats">
                <span class="stat-item"><span class="stat-label">Paid</span><span class="stat-val">₹${fmt(paid)}</span></span>
                <span class="stat-divider">·</span>
                <span class="stat-item"><span class="stat-label">Share</span><span class="stat-val">₹${fmt(share)}</span></span>
                <span class="stat-divider">·</span>
                <span class="stat-item"><span class="stat-label">Balance</span>
                  <span class="stat-val ${bal > 0.01 ? 'positive' : bal < -0.01 ? 'negative' : ''}">${bal >= 0 ? '+' : ''}₹${fmt(Math.abs(bal))}</span>
                </span>
              </div>
            </div>
            <button class="btn-icon danger" onclick="handleRemoveMember('${trip.id}','${m.id}')">🗑️</button>
          </div>`;
        }).join('')}
      </div>`}
    </div>`;
}

// --- SETTLE TAB ---
function renderSettleTab(trip, el) {
  const debts = simplifyDebts(trip);
  const total = getTotalExpenses(trip);
  const bal = calcBalances(trip);

  el.innerHTML = `
    <div class="settlement-tab">
      <div class="settlement-summary">
        <h2>Settlement Summary</h2>
        <p class="summary-total">Total trip cost: <strong>₹${fmt(total)}</strong> · ${trip.members.length} members</p>
      </div>

      <div class="balances-section">
        <h3>Individual Balances</h3>
        <div class="balances-grid">
          ${trip.members.map(m => {
            const b = bal[m.id] || 0;
            const cls = b > 0.01 ? 'creditor' : b < -0.01 ? 'debtor' : 'settled';
            const ind = b > 0.01 ? 'up' : b < -0.01 ? 'down' : 'neutral';
            return `<div class="balance-card ${cls}">
              <div class="member-avatar" style="background:${m.color}">${initials(m.name)}</div>
              <div class="balance-info">
                <span class="balance-name">${escHtml(m.name)}</span>
                <span class="balance-amount ${b > 0.01 ? 'positive' : b < -0.01 ? 'negative' : ''}">
                  ${b > 0.01 ? `gets back ₹${fmt(b)}` : b < -0.01 ? `owes ₹${fmt(Math.abs(b))}` : 'all settled!'}
                </span>
              </div>
              <div class="balance-indicator ${ind}">${ind === 'up' ? '↑' : ind === 'down' ? '↓' : '✓'}</div>
            </div>`;
          }).join('')}
        </div>
      </div>

      <div class="settlements-section">
        <h3>Payments to Settle</h3>
        ${!debts.length ? `
          <div class="all-settled">
            <span class="settled-icon">🎉</span>
            <p>${!trip.members.length ? 'Add members and expenses to see settlements.' : 'All settled! No payments needed.'}</p>
          </div>` : `
        <div class="debts-list">
          ${debts.map(d => {
            const from = trip.members.find(m => m.id === d.from);
            const to = trip.members.find(m => m.id === d.to);
            return `<div class="debt-card">
              <div class="debt-flow">
                <div class="debt-member">
                  <div class="member-avatar" style="background:${from?.color || '#ccc'}">${initials(from?.name)}</div>
                  <span>${escHtml(from?.name || '?')}</span>
                </div>
                <div class="debt-arrow">
                  <span class="debt-amount">₹${fmt(d.amount)}</span>
                  <span class="arrow">→</span>
                </div>
                <div class="debt-member">
                  <div class="member-avatar" style="background:${to?.color || '#ccc'}">${initials(to?.name)}</div>
                  <span>${escHtml(to?.name || '?')}</span>
                </div>
              </div>
              <div class="debt-actions">${buildPayButtons(to, d.amount, trip.name)}</div>
            </div>`;
          }).join('')}
        </div>`}
      </div>
    </div>`;
}

// =============================================
// MODALS
// =============================================

function showNewTripModal() {
  document.getElementById('new-trip-modal').classList.remove('hidden');
  document.getElementById('places-input-list').innerHTML = '';
  addPlaceInput();
  requestAnimationFrame(() => document.getElementById('trip-name')?.focus());
}
function hideNewTripModal() { document.getElementById('new-trip-modal').classList.add('hidden'); }

function modal(id, title, bodyHtml, footerHtml) {
  closeModal(id);
  const el = document.createElement('div');
  el.id = id; el.className = 'modal';
  el.innerHTML = `
    <div class="modal-overlay" onclick="closeModal('${id}')"></div>
    <div class="modal-content">
      <div class="modal-header">
        <h2>${title}</h2>
        <button class="btn-close" onclick="closeModal('${id}')">×</button>
      </div>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-footer">${footerHtml}</div>
    </div>`;
  (document.getElementById('modals') || document.body).appendChild(el);
}

function closeModal(id) { document.getElementById(id)?.remove(); }

function showAddMemberModal() {
  modal('add-member-modal', '👤 Add Member',
    `<div class="form-group">
      <label>Name *</label>
      <input type="text" id="m-name" placeholder="e.g., Rahul Sharma" class="form-input">
    </div>
    <div class="form-group">
      <label>UPI ID (for payments)</label>
      <input type="text" id="m-upi" placeholder="e.g., rahul@paytm or 9876543210@upi" class="form-input">
      <p class="input-hint">Used for Pay Now buttons in settlements</p>
    </div>`,
    `<button class="btn-ghost" onclick="closeModal('add-member-modal')">Cancel</button>
     <button class="btn-primary" onclick="doAddMember()">Add Member</button>`
  );
  requestAnimationFrame(() => document.getElementById('m-name')?.focus());
}

function showAddPlaceModal() {
  modal('add-place-modal', '📍 Add Stop',
    `<div class="form-group">
      <label>Place Name *</label>
      <input type="text" id="p-name" placeholder="e.g., Anjuna Beach, Goa" class="form-input">
      <p class="input-hint">We'll automatically find the location on the map</p>
    </div>`,
    `<button class="btn-ghost" onclick="closeModal('add-place-modal')">Cancel</button>
     <button class="btn-primary" id="add-place-ok" onclick="doAddPlace()">Add Stop</button>`
  );
  requestAnimationFrame(() => document.getElementById('p-name')?.focus());
}

function showAddExpenseModal() {
  const trip = getCurrentTrip();
  if (!trip || !trip.members.length) { toast('Add members first', 'warning'); return; }
  currentSplitType = 'equal';

  const cats = [['food','🍽️ Food'],['transport','🚗 Transport'],['hotel','🏨 Hotel'],['activity','🎯 Activity'],['fuel','⛽ Fuel'],['shopping','🛍️ Shopping'],['medical','💊 Medical'],['general','💰 General']];

  const body = `
    <div class="form-row">
      <div class="form-group flex-1">
        <label>Description *</label>
        <input type="text" id="e-desc" placeholder="e.g., Dinner at beach shack" class="form-input">
      </div>
      <div class="form-group" style="min-width:130px">
        <label>Amount (₹) *</label>
        <input type="number" id="e-amt" placeholder="0.00" class="form-input" min="0" step="0.01" oninput="updateSplits()">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group flex-1">
        <label>Paid by *</label>
        <select id="e-paidby" class="form-input">
          ${trip.members.map(m => `<option value="${m.id}">${escHtml(m.name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group flex-1">
        <label>Category</label>
        <select id="e-cat" class="form-input">
          ${cats.map(([v,l]) => `<option value="${v}">${l}</option>`).join('')}
        </select>
      </div>
      <div class="form-group" style="min-width:130px">
        <label>Date</label>
        <input type="date" id="e-date" value="${today()}" class="form-input">
      </div>
    </div>
    <div class="form-group">
      <label>Split Type</label>
      <div class="split-type-selector">
        <button class="split-type-btn active" id="stype-equal" onclick="setSplitType('equal')">⚖️ Equal</button>
        <button class="split-type-btn" id="stype-custom" onclick="setSplitType('custom')">✏️ Custom Amount</button>
        <button class="split-type-btn" id="stype-percentage" onclick="setSplitType('percentage')">% By %</button>
      </div>
    </div>
    <div class="form-group">
      <label>Split Among</label>
      <div id="split-rows">${buildSplitRows(trip, 'equal', 0)}</div>
    </div>`;

  modal('add-expense-modal', '💰 Add Expense', body,
    `<button class="btn-ghost" onclick="closeModal('add-expense-modal')">Cancel</button>
     <button class="btn-primary" onclick="doAddExpense()">Add Expense</button>`
  );

  // Need large modal
  requestAnimationFrame(() => {
    document.querySelector('#add-expense-modal .modal-content')?.classList.add('large-modal');
    document.getElementById('e-desc')?.focus();
  });
}

function buildSplitRows(trip, type, total) {
  const n = trip.members.length;
  const eq = n > 0 ? total / n : 0;
  return trip.members.map(m => `
    <div class="split-row" data-mid="${m.id}">
      <label class="split-member-label">
        <input type="checkbox" class="split-cb" data-mid="${m.id}" checked onchange="updateSplits()">
        <div class="member-avatar tiny" style="background:${m.color}">${initials(m.name)}</div>
        <span>${escHtml(m.name)}</span>
      </label>
      ${type === 'equal' ? `<span class="split-amount-display" id="sd-${m.id}">₹${fmt(eq)}</span>`
        : type === 'custom' ? `<input type="number" class="split-custom form-input small" id="sc-${m.id}" value="${fmt(eq)}" min="0" step="0.01" oninput="checkSplitTotal()">`
        : `<div class="split-percentage"><input type="number" class="split-pct form-input small" id="sc-${m.id}" value="${Math.round(100/n)}" min="0" max="100" oninput="updateSplits()"><span>%</span></div>`}
    </div>`).join('');
}

function setSplitType(type) {
  currentSplitType = type;
  ['equal','custom','percentage'].forEach(t => document.getElementById('stype-' + t)?.classList.toggle('active', t === type));
  const trip = getCurrentTrip();
  const amt = parseFloat(document.getElementById('e-amt')?.value || 0);
  const el = document.getElementById('split-rows');
  if (el && trip) el.innerHTML = buildSplitRows(trip, type, amt);
}

function updateSplits() {
  const trip = getCurrentTrip();
  if (!trip) return;
  const amt = parseFloat(document.getElementById('e-amt')?.value || 0);
  if (currentSplitType === 'equal') {
    const checked = Array.from(document.querySelectorAll('.split-cb:checked'));
    const share = checked.length > 0 ? amt / checked.length : 0;
    trip.members.forEach(m => {
      const el = document.getElementById('sd-' + m.id);
      const cb = document.querySelector(`.split-cb[data-mid="${m.id}"]`);
      if (el) el.textContent = `₹${fmt(cb?.checked ? share : 0)}`;
    });
  } else if (currentSplitType === 'percentage') {
    trip.members.forEach(m => {
      const input = document.getElementById('sc-' + m.id);
      const pct = parseFloat(input?.value || 0);
      const display = document.getElementById('sd-' + m.id);
      if (display) display.textContent = `₹${fmt(amt * pct / 100)}`;
    });
  }
}

function checkSplitTotal() {
  // Visual validation for custom split
  const trip = getCurrentTrip();
  if (!trip) return;
  const amt = parseFloat(document.getElementById('e-amt')?.value || 0);
  let total = 0;
  trip.members.forEach(m => { total += parseFloat(document.getElementById('sc-' + m.id)?.value || 0); });
  const diff = Math.abs(total - amt);
  document.querySelectorAll('.split-custom').forEach(el => {
    el.style.borderColor = diff < 0.02 ? 'var(--success)' : 'var(--warning)';
  });
}

// =============================================
// NEW TRIP MODAL HELPERS
// =============================================

function addPlaceInput() {
  const list = document.getElementById('places-input-list');
  if (!list) return;
  const i = list.children.length;
  const div = document.createElement('div');
  div.className = 'place-input-row';
  div.innerHTML = `<span class="place-index">${i + 1}</span>
    <input type="text" placeholder="Enter place name..." class="form-input place-name-input" onkeydown="if(event.key==='Enter')addPlaceInput()">
    <button class="btn-icon small danger" onclick="removePlaceRow(this)">×</button>`;
  list.appendChild(div);
  div.querySelector('input').focus();
}

function removePlaceRow(btn) {
  btn.closest('.place-input-row').remove();
  document.querySelectorAll('.place-index').forEach((el, i) => el.textContent = i + 1);
}

async function fetchFromUrl() {
  const urlEl = document.getElementById('maps-url');
  const btn = document.getElementById('fetch-btn');
  const url = urlEl?.value?.trim();
  if (!url) { toast('Please paste a Google Maps URL', 'warning'); return; }

  btn.textContent = '⏳ Fetching...';
  btn.disabled = true;

  try {
    const places = await parseGoogleMapsUrl(url);
    if (!places.length) {
      toast('Could not extract places — please add manually', 'warning');
    } else {
      const list = document.getElementById('places-input-list');
      list.innerHTML = '';
      places.forEach(p => {
        const div = document.createElement('div');
        div.className = 'place-input-row';
        const i = list.children.length;
        div.innerHTML = `<span class="place-index">${i + 1}</span>
          <input type="text" value="${escHtml(p)}" class="form-input place-name-input">
          <button class="btn-icon small danger" onclick="removePlaceRow(this)">×</button>`;
        list.appendChild(div);
      });
      const nameEl = document.getElementById('trip-name');
      if (nameEl && !nameEl.value.trim()) nameEl.value = places.slice(0, 3).join(' → ').slice(0, 55);
      toast(`Found ${places.length} destinations!`, 'success');
    }
  } catch (e) {
    toast('Error fetching places', 'error');
  }

  btn.textContent = 'Fetch Places';
  btn.disabled = false;
}

async function doCreateTrip() {
  const name = document.getElementById('trip-name')?.value?.trim();
  if (!name) { toast('Please enter a trip name', 'warning'); document.getElementById('trip-name')?.focus(); return; }

  const inputs = Array.from(document.querySelectorAll('.place-name-input'));
  const placeNames = inputs.map(i => i.value.trim()).filter(Boolean);
  if (!placeNames.length) { toast('Add at least one destination', 'warning'); return; }

  const btn = document.getElementById('create-trip-btn');
  btn.textContent = '⏳ Geocoding...';
  btn.disabled = true;
  hideNewTripModal();

  toast('Creating trip and finding locations...', 'info');

  const geocoded = await geocodePlaces(placeNames, (i, total, name) => {
    toast(`Finding "${name}" (${i+1}/${total})...`, 'info');
  });

  const trip = createTrip(name, geocoded);
  const notFound = geocoded.filter(p => !p.found);
  if (notFound.length) toast(`Created! ${notFound.length} place(s) not found on map.`, 'warning');
  else toast('Trip created successfully!', 'success');

  renderTrip(trip.id);
}

// =============================================
// EVENT HANDLERS
// =============================================

function goHome() {
  state.currentTripId = null;
  if (mapInstance) { try { mapInstance.remove(); } catch(_){} mapInstance = null; }
  renderHome();
}

function openTrip(id) { renderTrip(id); }

function confirmDelete(id) {
  const trip = state.trips.find(t => t.id === id);
  if (confirm(`Delete "${trip?.name}"? This cannot be undone.`)) {
    deleteTrip(id); goHome(); toast('Trip deleted', 'info');
  }
}

function handleTogglePlace(tripId, placeId) {
  togglePlace(tripId, placeId);
  switchTab('itinerary');
}

function handleRemovePlace(tripId, placeId) {
  removePlace(tripId, placeId);
  switchTab('itinerary');
}

function handleRemoveMember(tripId, memberId) {
  const trip = state.trips.find(t => t.id === tripId);
  const m = trip?.members.find(m => m.id === memberId);
  if (confirm(`Remove ${m?.name} from this trip?`)) {
    removeMember(tripId, memberId);
    switchTab('members');
    toast(`${m?.name} removed`, 'info');
  }
}

function handleRemoveExpense(tripId, expId) {
  if (confirm('Remove this expense?')) {
    removeExpense(tripId, expId);
    switchTab('expenses');
    toast('Expense removed', 'info');
  }
}

async function doAddPlace() {
  const name = document.getElementById('p-name')?.value?.trim();
  if (!name) { toast('Enter a place name', 'warning'); return; }
  const btn = document.getElementById('add-place-ok');
  if (btn) { btn.textContent = '⏳ Finding...'; btn.disabled = true; }
  const coords = await geocodePlace(name);
  addPlace(state.currentTripId, { name, lat: coords?.lat, lng: coords?.lng });
  closeModal('add-place-modal');
  switchTab('itinerary');
  toast(coords ? 'Stop added!' : 'Stop added (location not found on map)', coords ? 'success' : 'warning');
}

function doAddMember() {
  const name = document.getElementById('m-name')?.value?.trim();
  const upiId = document.getElementById('m-upi')?.value?.trim();
  if (!name) { toast('Enter a name', 'warning'); return; }
  addMember(state.currentTripId, { name, upiId });
  closeModal('add-member-modal');
  switchTab('members');
  toast(`${name} added!`, 'success');
}

function doAddExpense() {
  const trip = getCurrentTrip();
  if (!trip) return;
  const desc = document.getElementById('e-desc')?.value?.trim();
  const amt = parseFloat(document.getElementById('e-amt')?.value || 0);
  const paidBy = document.getElementById('e-paidby')?.value;
  const cat = document.getElementById('e-cat')?.value;
  const date = document.getElementById('e-date')?.value;

  if (!desc) { toast('Enter a description', 'warning'); return; }
  if (!amt || amt <= 0) { toast('Enter a valid amount', 'warning'); return; }

  const splits = [];

  if (currentSplitType === 'equal') {
    const checked = Array.from(document.querySelectorAll('.split-cb:checked'));
    if (!checked.length) { toast('Select at least one person', 'warning'); return; }
    const share = round2(amt / checked.length);
    let remaining = amt;
    checked.forEach((cb, i) => {
      const s = i === checked.length - 1 ? round2(remaining) : share;
      remaining = round2(remaining - share);
      splits.push({ memberId: cb.dataset.mid, amount: s });
    });
  } else if (currentSplitType === 'custom') {
    let total = 0;
    trip.members.forEach(m => {
      const v = parseFloat(document.getElementById('sc-' + m.id)?.value || 0);
      if (v > 0) { splits.push({ memberId: m.id, amount: v }); total += v; }
    });
    if (!splits.length) { toast('Add split amounts', 'warning'); return; }
    if (Math.abs(total - amt) > 0.05) { toast(`Splits (₹${fmt(total)}) don't match total (₹${fmt(amt)})`, 'warning'); return; }
  } else {
    let pctTotal = 0;
    trip.members.forEach(m => {
      const pct = parseFloat(document.getElementById('sc-' + m.id)?.value || 0);
      if (pct > 0) { splits.push({ memberId: m.id, amount: round2(amt * pct / 100) }); pctTotal += pct; }
    });
    if (!splits.length) { toast('Add percentages', 'warning'); return; }
    if (Math.abs(pctTotal - 100) > 1) { toast(`Percentages add up to ${pctTotal}%, need 100%`, 'warning'); return; }
  }

  addExpense(trip.id, { description: desc, amount: amt, paidBy, splits, date, category: cat });
  closeModal('add-expense-modal');
  switchTab('expenses');
  toast('Expense added!', 'success');
}

// =============================================
// APP INIT
// =============================================

function init() {
  loadData();
  renderHome();
}

document.addEventListener('DOMContentLoaded', init);
