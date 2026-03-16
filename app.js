/* =============================================
   TRIPPPYYY — Firebase Real-Time Edition
   ============================================= */

'use strict';

// =============================================
// SECTION 1: STATE
// =============================================

const S = {
  db: null,
  currentUser: null, // Firebase Auth user
  trip: null,        // current trip doc data { id, name, inviteCode, places, ... }
  members: [],       // live from Firestore
  expenses: [],      // live from Firestore, ordered by createdAt asc
  myMemberId: null,  // for current trip
  activeListeners: [],
  currentTab: 'expenses',
  geocodeCache: {},
};

// =============================================
// SECTION 2: DEVICE IDENTITY & LOCAL REGISTRY
// =============================================

function getDeviceId() {
  let id = localStorage.getItem('tpyyy_device');
  if (!id) { id = uid(); localStorage.setItem('tpyyy_device', id); }
  return id;
}

function getRegistry() {
  try { return JSON.parse(localStorage.getItem('tpyyy_registry') || '[]'); }
  catch { return []; }
}

function getMemberId(tripId) {
  return getRegistry().find(r => r.tripId === tripId)?.memberId || null;
}

// Primary user identifier — Auth UID when signed in, device ID as fallback
function getUserId() {
  return S.currentUser?.uid || getDeviceId();
}

// Is this member "me"? Checks both userId (new) and deviceId (legacy)
function isMe(m) {
  if (!m) return false;
  if (S.currentUser && m.userId === S.currentUser.uid) return true;
  return m.deviceId === getDeviceId();
}

// Is the current user admin of the current trip?
function isAdmin() {
  if (!S.trip) return false;
  if (S.currentUser && S.trip.adminUserId === S.currentUser.uid) return true;
  return S.trip.adminDeviceId === getDeviceId();
}

// ---- Firestore-backed registry sync ----

async function saveUserDoc(data) {
  if (!S.currentUser || !S.db) return;
  try {
    await S.db.collection('users').doc(S.currentUser.uid).set(
      { phone: S.currentUser.phoneNumber || '', ...data, updatedAt: TS() },
      { merge: true }
    );
  } catch (e) { console.warn('saveUserDoc:', e); }
}

// Override saveToRegistry to also push to Firestore
function saveToRegistry({ tripId, memberId, tripName, inviteCode }) {
  const reg = getRegistry();
  const i = reg.findIndex(r => r.tripId === tripId);
  const entry = { tripId, memberId, tripName, inviteCode };
  if (i >= 0) reg[i] = entry; else reg.unshift(entry);
  localStorage.setItem('tpyyy_registry', JSON.stringify(reg));
  saveUserDoc({ registry: reg }); // async, fire-and-forget
}

// Override removeFromRegistry to also update Firestore
function removeFromRegistry(tripId) {
  const reg = getRegistry().filter(r => r.tripId !== tripId);
  localStorage.setItem('tpyyy_registry', JSON.stringify(reg));
  saveUserDoc({ registry: reg });
}

// On login: pull remote registry from Firestore and merge into local
async function syncRegistryFromFirestore() {
  if (!S.currentUser || !S.db) return;
  try {
    const doc = await S.db.collection('users').doc(S.currentUser.uid).get();
    if (doc.exists) {
      const remote = doc.data().registry || [];
      const local = getRegistry();
      // Merge: start with remote, add any local entries not already there
      const merged = [...remote];
      local.forEach(l => { if (!merged.find(r => r.tripId === l.tripId)) merged.push(l); });
      localStorage.setItem('tpyyy_registry', JSON.stringify(merged));
    } else if (getRegistry().length) {
      // First login — upload whatever is already in localStorage
      await saveUserDoc({ registry: getRegistry() });
    }
  } catch (e) { console.warn('syncRegistry:', e); }
}

// =============================================
// SECTION 3: FIREBASE DB OPERATIONS
// =============================================

function getDb() {
  if (!S.db) throw new Error('Firebase not initialized');
  return S.db;
}

const TS = () => firebase.firestore.FieldValue.serverTimestamp();

async function generateInviteCode() {
  const db = getDb();
  for (let i = 0; i < 10; i++) {
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    const snap = await db.collection('inviteCodes').doc(code).get();
    if (!snap.exists) return code;
  }
  return uid().slice(0, 6).toUpperCase();
}

async function dbCreateTrip(tripName, places, creatorName, creatorUpiId) {
  const db = getDb();
  const deviceId = getDeviceId();
  const userId = getUserId();
  const inviteCode = await generateInviteCode();

  const tripRef = db.collection('trips').doc();
  const tripId = tripRef.id;
  const memberRef = db.collection('trips').doc(tripId).collection('members').doc();

  const mappedPlaces = places.map((p, i) => ({
    id: uid(), name: p.name, lat: p.lat || null, lng: p.lng || null,
    order: i, completed: false,
  }));

  const batch = db.batch();
  batch.set(tripRef, { name: tripName, inviteCode, places: mappedPlaces, createdAt: TS(), adminUserId: userId, adminDeviceId: deviceId, currency: 'INR' });
  batch.set(memberRef, { name: creatorName, upiId: creatorUpiId || '', color: pickColor(0), userId, deviceId, isAdmin: true, joinedAt: TS() });
  batch.set(db.collection('inviteCodes').doc(inviteCode), { tripId, createdAt: TS() });
  await batch.commit();

  return { tripId, memberId: memberRef.id, inviteCode };
}

async function dbJoinTrip(code, name, upiId) {
  const db = getDb();
  const deviceId = getDeviceId();
  const userId = getUserId();
  const normCode = code.trim().toUpperCase();

  const codeDoc = await db.collection('inviteCodes').doc(normCode).get();
  if (!codeDoc.exists) throw new Error('Invalid invite code. Check and try again.');
  const tripId = codeDoc.data().tripId;

  // Already a member? Check by userId first (works across devices), then deviceId (legacy)
  const membersRef = db.collection('trips').doc(tripId).collection('members');
  let existing = S.currentUser
    ? await membersRef.where('userId', '==', userId).get()
    : null;
  if (!existing || existing.empty) {
    existing = await membersRef.where('deviceId', '==', deviceId).get();
  }
  if (existing && !existing.empty) {
    const tripDoc = await db.collection('trips').doc(tripId).get();
    return { tripId, memberId: existing.docs[0].id, tripName: tripDoc.data()?.name || '', inviteCode: normCode };
  }

  const membersSnap = await membersRef.get();
  const memberRef = membersRef.doc();
  await memberRef.set({ name, upiId: upiId || '', color: pickColor(membersSnap.size), userId, deviceId, isAdmin: false, joinedAt: TS() });

  const tripDoc = await db.collection('trips').doc(tripId).get();
  return { tripId, memberId: memberRef.id, tripName: tripDoc.data()?.name || '', inviteCode: normCode };
}

async function dbAddExpense(tripId, data) {
  const db = getDb();
  const ref = db.collection('trips').doc(tripId).collection('expenses').doc();
  await ref.set({
    description: data.description, amount: data.amount, paidBy: data.paidBy,
    splits: data.splits, category: data.category || 'general',
    date: data.date || today(), createdBy: S.myMemberId,
    createdAt: TS(), note: data.note || '',
  });
  return ref.id;
}

async function dbRemoveExpense(tripId, expenseId) {
  await getDb().collection('trips').doc(tripId).collection('expenses').doc(expenseId).delete();
}

async function dbUpdateMember(tripId, memberId, data) {
  await getDb().collection('trips').doc(tripId).collection('members').doc(memberId).update(data);
}

async function dbRemoveMember(tripId, memberId) {
  await getDb().collection('trips').doc(tripId).collection('members').doc(memberId).delete();
}

async function dbTogglePlace(tripId, placeId) {
  const db = getDb();
  const ref = db.collection('trips').doc(tripId);
  const snap = await ref.get();
  const places = (snap.data()?.places || []).map(p =>
    p.id === placeId ? { ...p, completed: !p.completed } : p
  );
  await ref.update({ places });
}

async function dbAddPlace(tripId, place) {
  const db = getDb();
  const ref = db.collection('trips').doc(tripId);
  const snap = await ref.get();
  const places = snap.data()?.places || [];
  places.push({ id: uid(), name: place.name, lat: place.lat || null, lng: place.lng || null, order: places.length, completed: false });
  await ref.update({ places });
}

async function dbRemovePlace(tripId, placeId) {
  const db = getDb();
  const ref = db.collection('trips').doc(tripId);
  const snap = await ref.get();
  const places = (snap.data()?.places || []).filter(p => p.id !== placeId).map((p, i) => ({ ...p, order: i }));
  await ref.update({ places });
}

async function dbLeaveOrDeleteTrip(tripId) {
  const db = getDb();
  const admin = isAdmin();
  if (admin) {
    // Delete entire trip (admin only)
    const batch = db.batch();
    const [members, expenses] = await Promise.all([
      db.collection('trips').doc(tripId).collection('members').get(),
      db.collection('trips').doc(tripId).collection('expenses').get(),
    ]);
    members.forEach(d => batch.delete(d.ref));
    expenses.forEach(d => batch.delete(d.ref));
    batch.delete(db.collection('trips').doc(tripId));
    const inviteCode = S.trip?.inviteCode;
    if (inviteCode) batch.delete(db.collection('inviteCodes').doc(inviteCode));
    await batch.commit();
  } else {
    // Just remove self as member
    if (S.myMemberId) await dbRemoveMember(tripId, S.myMemberId);
  }
  removeFromRegistry(tripId);
}

// =============================================
// SECTION 4: REAL-TIME LISTENERS
// =============================================

function detachListeners() {
  S.activeListeners.forEach(fn => { try { fn(); } catch (_) {} });
  S.activeListeners = [];
}

function attachListeners(tripId) {
  detachListeners();
  const db = getDb();

  // Trip document (name, places, inviteCode)
  const u1 = db.collection('trips').doc(tripId).onSnapshot(snap => {
    if (!snap.exists) return;
    S.trip = { id: snap.id, ...snap.data() };
    updateTripHeader();
    if (S.currentTab === 'map' || S.currentTab === 'itinerary') rerenderTab();
  });

  // Members subcollection
  const u2 = db.collection('trips').doc(tripId).collection('members').onSnapshot(snap => {
    S.members = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (S.currentTab === 'members' || S.currentTab === 'settle') rerenderTab();
    // Update tab meta text
    updateTripHeader();
  });

  // Expenses subcollection ordered by createdAt
  const u3 = db.collection('trips').doc(tripId).collection('expenses')
    .orderBy('createdAt', 'asc')
    .onSnapshot(snap => {
      const prev = S.expenses;
      S.expenses = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (S.currentTab === 'expenses') {
        if (S.expenses.length > prev.length && isOnlyAppended(prev, S.expenses)) {
          appendNewBubbles(S.expenses.slice(prev.length));
        } else {
          rerenderTab();
        }
      }
      if (S.currentTab === 'settle') rerenderTab();
    });

  S.activeListeners = [u1, u2, u3];
}

function isOnlyAppended(prev, next) {
  for (let i = 0; i < prev.length; i++) if (prev[i].id !== next[i]?.id) return false;
  return true;
}

function updateTripHeader() {
  const h1 = document.querySelector('.trip-title h1');
  const meta = document.querySelector('.trip-meta');
  if (h1 && S.trip) h1.textContent = S.trip.name;
  if (meta && S.trip) meta.textContent = `${(S.trip.places || []).length} places · ${S.members.length} members`;
}

function rerenderTab() {
  const body = document.getElementById('tab-body');
  if (!body || !S.trip) return;
  const tab = S.currentTab;
  if (tab === 'map') renderMapTab(body);
  else if (tab === 'itinerary') renderItineraryTab(body);
  else if (tab === 'expenses') renderExpensesTab(body);
  else if (tab === 'members') renderMembersTab(body);
  else if (tab === 'settle') renderSettleTab(body);
}

// =============================================
// SECTION 5: GEOCODING & MAPS URL PARSING
// =============================================

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const ALLORIGINS = 'https://api.allorigins.win/get?url=';

async function geocodePlace(name) {
  const key = name.toLowerCase().trim();
  if (S.geocodeCache[key]) return S.geocodeCache[key];
  try {
    const p = new URLSearchParams({ q: name, format: 'json', limit: '1' });
    const res = await fetch(`${NOMINATIM}?${p}`, {
      headers: { 'Accept-Language': 'en', 'User-Agent': 'Tripppyyy/2.0' },
      signal: AbortSignal.timeout(8000),
    });
    const json = await res.json();
    if (json.length) {
      const r = { lat: parseFloat(json[0].lat), lng: parseFloat(json[0].lon) };
      S.geocodeCache[key] = r;
      localStorage.setItem('tpyyy_geo', JSON.stringify(S.geocodeCache));
      return r;
    }
  } catch (e) { console.warn('Geocode:', e.message); }
  return null;
}

async function geocodePlaces(names, onProgress) {
  const results = [];
  for (let i = 0; i < names.length; i++) {
    if (i > 0) await sleep(1100);
    onProgress?.(i, names.length, names[i]);
    const r = await geocodePlace(names[i]);
    results.push({ name: names[i], ...(r || {}), found: !!r });
  }
  return results;
}

const CORS_PROXIES = [
  url => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
];

// Patterns to find the real Google Maps URL inside proxy HTML responses.
// maps.app.goo.gl pages embed the destination in several different ways.
const MAPS_URL_PATS = [
  // Standard canonical link
  /rel="canonical"\s+href="([^"]+)"/,
  // og:url meta tag (common in Google's mobile share pages)
  /<meta[^>]+property="og:url"[^>]+content="([^"]+)"/,
  /<meta[^>]+content="([^"]+)"[^>]+property="og:url"/,
  // meta http-equiv refresh redirect
  /<meta[^>]+http-equiv="refresh"[^>]+content="[^"]*url=(https?:\/\/[^"&]+)"/i,
  // <link> tag pointing to a maps URL
  /<link[^>]+href="(https:\/\/(?:www\.)?google\.com\/maps[^"]+)"/,
  // JSON-embedded maps URLs (Google embeds state as JS strings)
  /"(https:\\\/\\\/www\.google\.com\\\/maps\\\/dir\\\/[^"]{10,})"/,
  /"(https:\/\/www\.google\.com\/maps\/dir\/[^"\\]{10,})"/,
  // Any google.com/maps URL at least 40 chars (catches place + dir URLs)
  /(https:\/\/(?:www\.)?google\.com\/maps\/(?:dir|place)\/[^\s"'<>]{15,})/,
];

async function expandShortenedUrl(url) {
  for (const proxy of CORS_PROXIES) {
    try {
      const res = await fetch(proxy(url), { signal: AbortSignal.timeout(9000) });
      const text = await res.text();
      // allorigins wraps in JSON {contents, status}, corsproxy returns raw HTML
      let html = text;
      if (text.trimStart().startsWith('{')) {
        try { html = JSON.parse(text).contents || text; } catch (_) {}
      }
      for (const p of MAPS_URL_PATS) {
        const m = html.match(p);
        if (m) {
          // Unescape JSON-encoded forward slashes if needed
          const found = m[1].replace(/\\\//g, '/');
          if (found.includes('google.com/maps')) return found;
        }
      }
    } catch (e) { console.warn('URL expand via proxy:', e.message); }
  }
  return null;
}

async function parseGoogleMapsUrl(rawUrl) {
  const url = rawUrl.trim();
  let expandedUrl = url;

  if (/maps\.app\.goo\.gl|goo\.gl\/maps/.test(url)) {
    const resolved = await expandShortenedUrl(url);
    if (resolved) expandedUrl = resolved;
  }

  return extractPlacesFromUrl(expandedUrl);
}

function extractPlacesFromUrl(url) {
  const places = [];
  try {
    const u = new URL(url);

    // /maps/dir/Place1/Place2/Place3/data=!4m56!... (data= segment must be excluded)
    const dirM = u.pathname.match(/\/maps\/dir\/(.+)/);
    if (dirM) {
      dirM[1].split('/').forEach(seg => {
        if (!seg || seg.startsWith('@') || seg.startsWith('data=') || seg.includes('!')) return;
        const dec = decodeURIComponent(seg.replace(/\+/g, ' ')).trim();
        if (dec.length > 1 && !/^[\d.,\s-]+$/.test(dec)) places.push(dec);
      });
    }

    // waypoints= query param (e.g. ?origin=A&waypoints=B|C&destination=D)
    if (!places.length) {
      const origin = u.searchParams.get('origin');
      const dest = u.searchParams.get('destination');
      const waypoints = u.searchParams.get('waypoints');
      if (origin) places.push(decodeURIComponent(origin));
      if (waypoints) waypoints.split('|').forEach(w => places.push(decodeURIComponent(w.trim())));
      if (dest) places.push(decodeURIComponent(dest));
    }

    // /maps/place/PlaceName/
    if (!places.length) {
      const plM = u.pathname.match(/\/maps\/place\/([^/@]+)/);
      if (plM) places.push(decodeURIComponent(plM[1].replace(/\+/g, ' ')));
    }

    // ?q= or ?query=
    if (!places.length) {
      const q = u.searchParams.get('q') || u.searchParams.get('query');
      if (q) places.push(decodeURIComponent(q));
    }
  } catch (_) {}
  return places.filter(Boolean);
}

// =============================================
// SECTION 6: FINANCIAL CALCULATIONS
// =============================================

function calcBalances() {
  const bal = {};
  S.members.forEach(m => { bal[m.id] = 0; });
  S.expenses.forEach(e => {
    if (!e.paidBy || bal[e.paidBy] === undefined) return;
    bal[e.paidBy] += e.amount;
    e.splits?.forEach(s => { if (bal[s.memberId] !== undefined) bal[s.memberId] -= s.amount; });
  });
  return bal;
}

function simplifyDebts() {
  const bal = calcBalances();
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

function getTotalExpenses() { return S.expenses.reduce((s, e) => s + e.amount, 0); }
function getMemberPaid(id) { return S.expenses.filter(e => e.paidBy === id).reduce((s, e) => s + e.amount, 0); }
function getMemberShare(id) { return S.expenses.reduce((s, e) => { const sp = e.splits?.find(s => s.memberId === id); return s + (sp ? sp.amount : 0); }, 0); }

// =============================================
// SECTION 7: UPI PAYMENTS
// =============================================

function buildPayButtons(toMember, amount, tripName) {
  if (!toMember?.upiId) {
    return `<span class="no-upi">No UPI ID · <button class="btn-link" onclick="showEditMemberModal('${toMember?.id}')">Add UPI ID</button></span>`;
  }
  const note = `${tripName} settlement`;
  const enc = encodeURIComponent;
  const base = `pa=${enc(toMember.upiId)}&pn=${enc(toMember.name)}&am=${amount.toFixed(2)}&cu=INR&tn=${enc(note)}`;
  return `
    <div class="upi-options">
      <a href="upi://pay?${base}" class="btn-pay" onclick="toast('Opening UPI app…','success')">
        💳 Pay ₹${fmt(amount)}
      </a>
      <a href="gpay://upi/pay?${base}" class="upi-option">
        <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/f/f2/Google_Pay_Logo.svg/512px-Google_Pay_Logo.svg.png" width="14" height="14" alt=""> GPay
      </a>
      <a href="phonepe://pay?${base}" class="upi-option">📱 PhonePe</a>
      <a href="paytmmp://pay?${base}" class="upi-option">💰 Paytm</a>
    </div>`;
}

// =============================================
// SECTION 8: MAP
// =============================================

let mapInstance = null;

function initMap(containerId) {
  if (typeof L === 'undefined') {
    const el = document.getElementById(containerId);
    if (el) el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#94a3b8;font-size:14px;text-align:center;padding:24px">Map unavailable.<br>Check your internet connection and reload.</div>';
    return null;
  }
  if (mapInstance) { try { mapInstance.remove(); } catch (_) {} mapInstance = null; }
  mapInstance = L.map(containerId);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(mapInstance);
  return mapInstance;
}

function renderMap(places) {
  if (!mapInstance) return;
  const valid = (places || []).filter(p => p.lat && p.lng);
  if (!valid.length) { mapInstance.setView([20.5937, 78.9629], 5); return; }

  valid.forEach((p, i) => {
    L.marker([p.lat, p.lng], { icon: makeMarkerIcon(i + 1, p.completed) })
      .bindPopup(`<div class="map-popup"><strong>${escHtml(p.name)}</strong>${p.completed ? '<br><span class="popup-done">✓ Visited</span>' : ''}</div>`)
      .addTo(mapInstance);
  });

  if (valid.length > 1) {
    const coords = valid.map(p => [p.lat, p.lng]);
    L.polyline(coords, { color: '#6366f1', weight: 4, opacity: 0.65 }).addTo(mapInstance);
    L.polyline(coords, { color: '#a5b4fc', weight: 2, opacity: 0.6, dashArray: '8 6' }).addTo(mapInstance);
  }

  mapInstance.fitBounds(L.latLngBounds(valid.map(p => [p.lat, p.lng])), { padding: [48, 48] });
}

function makeMarkerIcon(num, completed) {
  const bg = completed ? '#10b981' : '#6366f1';
  const label = completed ? '✓' : num;
  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="background:${bg};color:white;width:34px;height:34px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:3px solid white;box-shadow:0 4px 10px rgba(0,0,0,0.25);display:flex;align-items:center;justify-content:center"><span style="transform:rotate(45deg);font-weight:800;font-size:${completed ? '14px' : '12px'}">${label}</span></div>`,
    iconSize: [34, 34], iconAnchor: [17, 34], popupAnchor: [0, -36],
  });
}

// =============================================
// SECTION 9: UTILITIES
// =============================================

function toast(msg, type = 'info') {
  document.getElementById('toast')?.remove();
  const el = document.createElement('div');
  el.id = 'toast'; el.className = `toast toast-${type}`; el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => {
    el.classList.add('show');
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 350); }, 3200);
  });
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function today() { return new Date().toISOString().split('T')[0]; }
function round2(n) { return Math.round(n * 100) / 100; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmt(n) {
  if (isNaN(n) || n == null) return '0.00';
  return new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}
function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function initials(name) { return (name || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2); }
const COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#f97316', '#06b6d4', '#ec4899', '#84cc16', '#14b8a6'];
function pickColor(i) { return COLORS[i % COLORS.length]; }
const CAT_ICONS = { food: '🍽️', transport: '🚗', hotel: '🏨', activity: '🎯', fuel: '⛽', shopping: '🛍️', medical: '💊', general: '💰' };

function formatTime(ts) {
  if (!ts) return 'just now';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
}

// =============================================
// SECTION 10: SETUP SCREEN (no firebase-config.js)
// =============================================

function renderSetup() {
  document.getElementById('app').innerHTML = `
    <div class="setup-screen">
      <div class="setup-card">
        <span class="setup-icon">🔥</span>
        <h1>Firebase Setup Required</h1>
        <p>Tripppyyy needs Firebase for real-time data sharing. Follow these steps:</p>
        <ol class="setup-steps">
          <li>Go to <a href="https://console.firebase.google.com" target="_blank">console.firebase.google.com</a></li>
          <li>Create a new project (or use an existing one)</li>
          <li>Click <strong>Add app → Web (⟨/⟩)</strong></li>
          <li>Copy your Firebase config object</li>
          <li>Create a file named <code>firebase-config.js</code> in this project folder</li>
          <li>Paste this content into it:</li>
        </ol>
        <pre class="setup-code">const FIREBASE_CONFIG = {
  apiKey: "your-api-key",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123:web:abc"
};</pre>
        <p>Then in Firebase Console → Firestore Database → Create database → Start in <strong>test mode</strong></p>
        <p>Finally, reload this page.</p>
        <button class="btn-primary large" onclick="location.reload()">↺ Reload after setup</button>
      </div>
    </div>`;
}

// =============================================
// SECTION 11: HOME VIEW
// =============================================

function buildAuthStatusBar() {
  const user = S.currentUser;
  if (!user) return '';
  const providers = user.providerData.map(p => p.providerId);
  const hasPhone = providers.includes('phone');
  const hasGoogle = providers.includes('google.com');
  const label = user.phoneNumber || user.displayName || user.email || 'Account';
  const googleAvatar = user.photoURL
    ? `<img src="${user.photoURL}" class="auth-avatar" alt="">`
    : '';

  const linkHints = [
    !hasGoogle ? `<button class="link-btn" onclick="linkGoogleAccount()"><svg width="14" height="14" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg> Link Google</button>` : '',
    !hasPhone ? `<button class="link-btn" onclick="linkPhoneAccount()">📱 Link Phone</button>` : '',
  ].filter(Boolean).join('');

  return `<div class="auth-status-bar">
    ${googleAvatar}
    <span class="auth-phone-pill">${escHtml(label)}</span>
    ${linkHints}
    <button class="signout-btn" onclick="handleSignOut()">Sign out</button>
  </div>`;
}

function renderHome() {
  const reg = getRegistry();
  const phone = S.currentUser?.phoneNumber || '';
  document.getElementById('app').innerHTML = `
    <div class="home-view">
      <header class="app-header">
        <div class="header-bg"></div>
        <div class="header-content">
          <div class="logo"><span class="logo-icon">✈️</span><h1>Tripppyyy</h1></div>
          <p class="tagline">Plan trips. Split expenses. Explore together.</p>
          ${S.currentUser ? buildAuthStatusBar() : ''}
        </div>
      </header>
      <main class="home-main">
        <div class="section-header">
          <h2>Your Trips</h2>
          <div class="btn-group">
            <button class="btn-secondary" onclick="showJoinModal()">🔗 Join Trip</button>
            <button class="btn-primary" onclick="showNewTripModal()">+ New Trip</button>
          </div>
        </div>
        ${reg.length === 0 ? `
          <div class="empty-state">
            <span class="empty-icon">🗺️</span>
            <h3>No trips yet</h3>
            <p>Create a new trip or join one with an invite code</p>
            <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
              <button class="btn-secondary large" onclick="showJoinModal()">🔗 Join with Code</button>
              <button class="btn-primary large" onclick="showNewTripModal()">+ Create Trip</button>
            </div>
          </div>
        ` : `<div class="trips-grid">${reg.map(tripCard).join('')}</div>`}
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
            <input type="text" id="trip-name" placeholder="e.g., Goa Weekend 2025" class="form-input">
          </div>
          <div class="form-row">
            <div class="form-group flex-1">
              <label>Your Name *</label>
              <input type="text" id="creator-name" placeholder="How others see you" class="form-input" value="${escHtml(localStorage.getItem('tpyyy_myname') || '')}">
            </div>
            <div class="form-group flex-1">
              <label>Your UPI ID</label>
              <input type="text" id="creator-upi" placeholder="you@paytm" class="form-input" value="${escHtml(localStorage.getItem('tpyyy_myupi') || '')}">
            </div>
          </div>
          <div class="form-group">
            <label>Google Maps Link (optional)</label>
            <div class="input-with-btn">
              <input type="text" id="maps-url" placeholder="Paste Google Maps URL to auto-import stops..." class="form-input">
              <button class="btn-secondary" onclick="fetchFromUrl()" id="fetch-btn">Import</button>
            </div>
          </div>
          <div class="form-group">
            <label>Destinations</label>
            <div id="places-input-list"></div>
            <button class="btn-ghost small" onclick="addPlaceInput()" style="margin-top:6px">+ Add Stop</button>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-ghost" onclick="hideNewTripModal()">Cancel</button>
          <button class="btn-primary" onclick="doCreateTrip()" id="create-trip-btn">Create Trip</button>
        </div>
      </div>
    </div>
    <div id="modals"></div>
  `;
  addPlaceInput();
  // Load cached geocode
  try { S.geocodeCache = JSON.parse(localStorage.getItem('tpyyy_geo') || '{}'); } catch (_) {}
}

function tripCard(entry) {
  return `
    <div class="trip-card" onclick="openTrip('${entry.tripId}')">
      <div class="trip-card-header">
        <h3>${escHtml(entry.tripName || 'Trip')}</h3>
        <span class="invite-badge" title="Invite code">🔑 ${entry.inviteCode || '——'}</span>
      </div>
      <div class="trip-card-footer">
        <span class="tap-hint">Tap to open →</span>
      </div>
    </div>`;
}

// =============================================
// SECTION 12: TRIP VIEW
// =============================================

function renderTrip(tripId) {
  S.myMemberId = getMemberId(tripId);
  if (!S.myMemberId) { toast('Membership not found. Try joining again.', 'error'); renderHome(); return; }

  document.getElementById('app').innerHTML = `
    <div class="trip-view">
      <header class="trip-header">
        <button class="btn-back" onclick="goHome()">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        </button>
        <div class="trip-title">
          <h1>${escHtml(getRegistry().find(r => r.tripId === tripId)?.tripName || 'Trip')}</h1>
          <span class="trip-meta" id="trip-meta-text">Loading…</span>
        </div>
        <button class="btn-icon header-action" onclick="showTripInfo()" title="Invite code">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        </button>
      </header>
      <div id="tab-body" class="tab-body"></div>
      <nav class="bottom-nav">
        <button class="nav-tab" onclick="switchTab('map')" id="tab-map">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/></svg>
          <span class="nav-label">Map</span>
        </button>
        <button class="nav-tab" onclick="switchTab('itinerary')" id="tab-itinerary">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
          <span class="nav-label">Stops</span>
        </button>
        <button class="nav-tab active" onclick="switchTab('expenses')" id="tab-expenses">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <span class="nav-label">Expenses</span>
        </button>
        <button class="nav-tab" onclick="switchTab('members')" id="tab-members">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          <span class="nav-label">People</span>
        </button>
        <button class="nav-tab" onclick="switchTab('settle')" id="tab-settle">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          <span class="nav-label">Settle</span>
        </button>
      </nav>
    </div>
    <div id="modals"></div>
  `;

  S.currentTab = 'expenses';
  attachListeners(tripId);
  rerenderTab();
}

function switchTab(name) {
  S.currentTab = name;
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + name)?.classList.add('active');
  rerenderTab();
}

function switchTab(name) {
  S.currentTab = name;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + name)?.classList.add('active');
  rerenderTab();
}

// =============================================
// SECTION 13: MAP TAB
// =============================================

function renderMapTab(el) {
  const places = S.trip?.places || [];
  el.innerHTML = `
    <div class="map-tab">
      <div id="map" class="map-container"></div>
      <div class="map-legend">
        ${places.length ? places.map((p, i) => `
          <div class="legend-item ${p.completed ? 'completed' : ''}">
            <span class="legend-number" style="background:${p.completed ? '#10b981' : '#6366f1'}">${i+1}</span>
            <span class="legend-name">${escHtml(p.name)}</span>
            ${p.completed ? '<span class="legend-check">✓</span>' : ''}
          </div>`).join('') : '<span style="color:var(--text-muted);font-size:13px">No destinations yet — add them in Stops tab.</span>'}
      </div>
    </div>`;
  requestAnimationFrame(() => { initMap('map'); renderMap(places); });
}

// =============================================
// SECTION 14: ITINERARY TAB
// =============================================

function renderItineraryTab(el) {
  const places = S.trip?.places || [];
  el.innerHTML = `
    <div class="itinerary-tab">
      <div class="section-header">
        <h2>Itinerary</h2>
        <button class="btn-primary small" onclick="showAddPlaceModal()">+ Add Stop</button>
      </div>
      <div class="places-list">
        ${!places.length ? '<div class="empty-state small"><p>No stops yet. Add your first destination!</p></div>' :
          places.map((p, i) => `
            <div class="place-item ${p.completed ? 'completed' : ''}">
              <div class="place-number">${i+1}</div>
              <div class="place-checkbox" onclick="handleTogglePlace('${p.id}')">
                <div class="checkbox ${p.completed ? 'checked' : ''}">${p.completed ? '✓' : ''}</div>
              </div>
              <div class="place-info">
                <span class="place-name">${escHtml(p.name)}</span>
                ${p.completed ? '<span class="place-tag visited">Visited</span>' : ''}
                ${!p.lat ? '<span class="place-tag" style="background:#fef3c7;color:#b45309;font-size:10px">📍 no coords</span>' : ''}
              </div>
              <button class="btn-icon small danger" onclick="handleRemovePlace('${p.id}')">×</button>
            </div>`).join('')}
      </div>
    </div>`;
}

// =============================================
// SECTION 15: EXPENSES (CHAT FEED)
// =============================================

function renderExpensesTab(el) {
  const total = getTotalExpenses();
  el.innerHTML = `
    <div class="expenses-chat-view">
      <div class="chat-summary-bar">
        <span class="chat-total">Total: <strong>₹${fmt(total)}</strong></span>
        <span class="chat-count">${S.expenses.length} expense${S.expenses.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="chat-feed" id="chat-feed">
        ${!S.expenses.length ? `
          <div class="chat-empty">
            <span>💬</span>
            <p>No expenses yet.</p>
            <p>Add the first one below!</p>
          </div>` :
          S.expenses.map(exp => buildBubble(exp)).join('')}
      </div>
      <button class="fab-add-expense" onclick="showAddExpenseModal()" ${S.members.length === 0 ? 'disabled title="Add members first"' : ''} title="Add expense">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
    </div>`;
  // Scroll to bottom
  requestAnimationFrame(() => {
    const feed = document.getElementById('chat-feed');
    if (feed) feed.scrollTop = feed.scrollHeight;
  });
}

function buildBubble(exp) {
  const isMe = exp.createdBy === S.myMemberId;
  const payer = S.members.find(m => m.id === exp.paidBy);
  const creator = S.members.find(m => m.id === exp.createdBy);
  const amAdmin = isAdmin();
  const canDelete = isMe || amAdmin;

  const payerLabel = exp.paidBy === S.myMemberId ? 'You paid' : `${escHtml(payer?.name || 'Someone')} paid`;
  const creatorLabel = isMe ? 'You' : escHtml(creator?.name || '?');

  const splitPills = (exp.splits || []).map(s => {
    const m = S.members.find(m => m.id === s.memberId);
    const highlight = s.memberId === S.myMemberId;
    return m ? `<span class="chat-split-pill ${highlight ? 'is-me' : ''}">${s.memberId === S.myMemberId ? 'You' : escHtml(m.name)}: ₹${fmt(s.amount)}</span>` : '';
  }).join('');

  if (isMe) {
    return `
      <div class="chat-row chat-right" data-expense-id="${exp.id}">
        <div class="chat-bubble chat-bubble-right">
          <div class="chat-amount">${CAT_ICONS[exp.category] || '💰'} ₹${fmt(exp.amount)}</div>
          <div class="chat-desc">${escHtml(exp.description)}</div>
          <div class="chat-splits">${splitPills}</div>
          <div class="chat-time">${payerLabel} · ${formatTime(exp.createdAt)}</div>
        </div>
        ${canDelete ? `<button class="chat-delete btn-icon small danger" onclick="handleRemoveExpense('${exp.id}')">×</button>` : ''}
      </div>`;
  }

  return `
    <div class="chat-row chat-left" data-expense-id="${exp.id}">
      <div class="chat-avatar" style="background:${creator?.color || payer?.color || '#6366f1'}" title="${escHtml(creator?.name || '')}">${initials(creator?.name || payer?.name)}</div>
      <div class="chat-bubble chat-bubble-left">
        <div class="chat-sender">${creatorLabel} added · ${payerLabel}</div>
        <div class="chat-amount">${CAT_ICONS[exp.category] || '💰'} ₹${fmt(exp.amount)}</div>
        <div class="chat-desc">${escHtml(exp.description)}</div>
        <div class="chat-splits">${splitPills}</div>
        <div class="chat-time">${formatTime(exp.createdAt)}</div>
      </div>
      ${canDelete ? `<button class="chat-delete btn-icon small danger" onclick="handleRemoveExpense('${exp.id}')">×</button>` : ''}
    </div>`;
}

function appendNewBubbles(newExpenses) {
  const feed = document.getElementById('chat-feed');
  if (!feed) { rerenderTab(); return; }
  // Remove empty state if present
  feed.querySelector('.chat-empty')?.remove();
  newExpenses.forEach(exp => {
    const html = buildBubble(exp);
    const div = document.createElement('div');
    div.innerHTML = html.trim();
    if (div.firstElementChild) feed.appendChild(div.firstElementChild);
  });
  feed.scrollTop = feed.scrollHeight;
}

// =============================================
// SECTION 16: MEMBERS TAB
// =============================================

function renderMembersTab(el) {
  const inviteCode = S.trip?.inviteCode;
  el.innerHTML = `
    <div class="members-tab">
      <div class="invite-card">
        <div class="invite-label">Trip Invite Code</div>
        <div class="invite-code">${inviteCode || '——'}</div>
        <button class="btn-secondary small" onclick="copyInviteCode('${inviteCode}')">📋 Copy Code</button>
        <button class="btn-secondary small" onclick="shareInviteLink('${inviteCode}')">🔗 Share Link</button>
      </div>
      <div class="section-header" style="margin-top:20px">
        <h2>Members (${S.members.length})</h2>
      </div>
      ${!S.members.length ? '<div class="empty-state small"><p>No members yet.</p></div>' : `
      <div class="members-list">
        ${S.members.map(m => {
          const bal = calcBalances()[m.id] || 0;
          const iAmMe = isMe(m);
          return `<div class="member-card">
            <div class="member-avatar large" style="background:${m.color}">${initials(m.name)}</div>
            <div class="member-info">
              <h3 class="member-name">${escHtml(m.name)} ${iAmMe ? '<span class="you-badge">You</span>' : ''} ${m.isAdmin ? '<span class="admin-badge">Admin</span>' : ''}</h3>
              <p class="member-upi">${m.upiId ? '📱 ' + escHtml(m.upiId) : '⚠️ No UPI ID'}</p>
              <div class="member-stats">
                <span class="stat-item"><span class="stat-label">Paid</span><span class="stat-val">₹${fmt(getMemberPaid(m.id))}</span></span>
                <span class="stat-divider">·</span>
                <span class="stat-item"><span class="stat-label">Share</span><span class="stat-val">₹${fmt(getMemberShare(m.id))}</span></span>
                <span class="stat-divider">·</span>
                <span class="stat-item"><span class="stat-label">Balance</span>
                  <span class="stat-val ${bal > 0.01 ? 'positive' : bal < -0.01 ? 'negative' : ''}">${bal >= 0 ? '+' : ''}₹${fmt(Math.abs(bal))}</span>
                </span>
              </div>
            </div>
            <div style="display:flex;flex-direction:column;gap:6px">
              ${iAmMe ? `<button class="btn-secondary small" onclick="showEditMemberModal('${m.id}')">Edit</button>` : ''}
              ${(isAdmin() && !iAmMe) ? `<button class="btn-icon small danger" onclick="handleRemoveMember('${m.id}')">🗑️</button>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>`}
    </div>`;
}

function copyInviteCode(code) {
  if (!code) return;
  navigator.clipboard.writeText(code).then(() => toast('Invite code copied!', 'success')).catch(() => {
    prompt('Copy this invite code:', code);
  });
}

function shareInviteLink(code) {
  if (!code) return;
  const url = `${location.origin}${location.pathname}?join=${code}`;
  if (navigator.share) {
    navigator.share({ title: 'Join my Tripppyyy trip!', text: `Use code ${code} or open this link:`, url });
  } else {
    navigator.clipboard.writeText(url).then(() => toast('Link copied!', 'success')).catch(() => prompt('Share this link:', url));
  }
}

// =============================================
// SECTION 17: SETTLE UP TAB
// =============================================

function renderSettleTab(el) {
  const debts = simplifyDebts();
  const bal = calcBalances();
  const total = getTotalExpenses();

  el.innerHTML = `
    <div class="settlement-tab">
      <div class="settlement-summary">
        <h2>Settlement</h2>
        <p class="summary-total">Trip total: <strong>₹${fmt(total)}</strong> · ${S.members.length} members</p>
      </div>

      <div class="balances-section">
        <h3>Individual Balances</h3>
        <div class="balances-grid">
          ${S.members.map(m => {
            const b = bal[m.id] || 0;
            const cls = b > 0.01 ? 'creditor' : b < -0.01 ? 'debtor' : 'settled';
            const iAmMe = isMe(m);
            return `<div class="balance-card ${cls}">
              <div class="member-avatar" style="background:${m.color}">${initials(m.name)}</div>
              <div class="balance-info">
                <span class="balance-name">${escHtml(m.name)}${iAmMe ? ' <span class="you-badge">You</span>' : ''}</span>
                <span class="balance-amount ${b > 0.01 ? 'positive' : b < -0.01 ? 'negative' : ''}">
                  ${b > 0.01 ? `gets back ₹${fmt(b)}` : b < -0.01 ? `owes ₹${fmt(Math.abs(b))}` : 'all settled!'}
                </span>
              </div>
              <div class="balance-indicator ${b > 0.01 ? 'up' : b < -0.01 ? 'down' : 'neutral'}">${b > 0.01 ? '↑' : b < -0.01 ? '↓' : '✓'}</div>
            </div>`;
          }).join('')}
        </div>
      </div>

      <div class="settlements-section">
        <h3>Payments Needed</h3>
        ${!debts.length ? `
          <div class="all-settled">
            <span class="settled-icon">🎉</span>
            <p>${!S.members.length ? 'Add members and expenses first.' : 'All settled! No payments needed.'}</p>
          </div>` : `
        <div class="debts-list">
          ${debts.map(d => {
            const from = S.members.find(m => m.id === d.from);
            const to = S.members.find(m => m.id === d.to);
            const isMyDebt = isMe(from);
            return `<div class="debt-card ${isMyDebt ? 'my-debt' : ''}">
              ${isMyDebt ? '<div class="debt-highlight-bar">You need to pay</div>' : ''}
              <div class="debt-flow">
                <div class="debt-member">
                  <div class="member-avatar" style="background:${from?.color}">${initials(from?.name)}</div>
                  <span>${isMyDebt ? 'You' : escHtml(from?.name)}</span>
                </div>
                <div class="debt-arrow">
                  <span class="debt-amount">₹${fmt(d.amount)}</span>
                  <span class="arrow">→</span>
                </div>
                <div class="debt-member">
                  <div class="member-avatar" style="background:${to?.color}">${initials(to?.name)}</div>
                  <span>${escHtml(to?.name)}</span>
                </div>
              </div>
              <div class="debt-actions">${buildPayButtons(to, d.amount, S.trip?.name || 'Trip')}</div>
            </div>`;
          }).join('')}
        </div>`}
      </div>

      ${isAdmin() ? `
        <div class="danger-zone">
          <h3>Danger Zone</h3>
          <button class="btn-danger" onclick="confirmDeleteTrip('${S.trip?.id}')">🗑️ Delete This Trip</button>
        </div>` : `
        <div class="danger-zone">
          <button class="btn-danger secondary" onclick="confirmLeaveTrip('${S.trip?.id}')">🚪 Leave This Trip</button>
        </div>`}
    </div>`;
}

// =============================================
// SECTION 18: MODALS
// =============================================

function showNewTripModal() {
  document.getElementById('new-trip-modal').classList.remove('hidden');
  document.getElementById('places-input-list').innerHTML = '';
  addPlaceInput();
  requestAnimationFrame(() => document.getElementById('trip-name')?.focus());
}
function hideNewTripModal() { document.getElementById('new-trip-modal').classList.add('hidden'); }

function modal(id, title, body, footer) {
  closeModal(id);
  const el = document.createElement('div');
  el.id = id; el.className = 'modal';
  el.innerHTML = `
    <div class="modal-overlay" onclick="closeModal('${id}')"></div>
    <div class="modal-content">
      <div class="modal-header"><h2>${title}</h2><button class="btn-close" onclick="closeModal('${id}')">×</button></div>
      <div class="modal-body">${body}</div>
      <div class="modal-footer">${footer}</div>
    </div>`;
  (document.getElementById('modals') || document.body).appendChild(el);
}

function closeModal(id) { document.getElementById(id)?.remove(); }

function showJoinModal() {
  modal('join-modal', '🔗 Join a Trip',
    `<div class="form-group">
      <label>Invite Code *</label>
      <input type="text" id="j-code" placeholder="e.g., GOA123" class="form-input" style="text-transform:uppercase;letter-spacing:4px;font-size:20px;text-align:center" oninput="this.value=this.value.toUpperCase()">
    </div>
    <div class="form-row">
      <div class="form-group flex-1">
        <label>Your Name *</label>
        <input type="text" id="j-name" placeholder="How others see you" class="form-input" value="${escHtml(localStorage.getItem('tpyyy_myname') || '')}">
      </div>
      <div class="form-group flex-1">
        <label>Your UPI ID</label>
        <input type="text" id="j-upi" placeholder="you@upi" class="form-input" value="${escHtml(localStorage.getItem('tpyyy_myupi') || '')}">
      </div>
    </div>`,
    `<button class="btn-ghost" onclick="closeModal('join-modal')">Cancel</button>
     <button class="btn-primary" id="join-ok" onclick="doJoinTrip()">Join Trip</button>`
  );
  requestAnimationFrame(() => document.getElementById('j-code')?.focus());
}

function showAddPlaceModal() {
  modal('add-place-modal', '📍 Add Stop',
    `<div class="form-group">
      <label>Place Name *</label>
      <input type="text" id="p-name" placeholder="e.g., Anjuna Beach, Goa" class="form-input">
      <p class="input-hint">We'll automatically locate this on the map</p>
    </div>`,
    `<button class="btn-ghost" onclick="closeModal('add-place-modal')">Cancel</button>
     <button class="btn-primary" id="add-place-ok" onclick="doAddPlace()">Add Stop</button>`
  );
  requestAnimationFrame(() => document.getElementById('p-name')?.focus());
}

function showEditMemberModal(memberId) {
  const m = S.members.find(m => m.id === memberId);
  if (!m) return;
  const iAmMe = isMe(m);
  modal('edit-member-modal', `✏️ Edit ${escHtml(m.name)}`,
    `<div class="form-group">
      <label>Name</label>
      <input type="text" id="em-name" value="${escHtml(m.name)}" class="form-input" ${iAmMe ? '' : 'disabled'}>
    </div>
    <div class="form-group">
      <label>UPI ID</label>
      <input type="text" id="em-upi" value="${escHtml(m.upiId || '')}" placeholder="e.g., name@paytm" class="form-input">
      <p class="input-hint">Used for Pay Now buttons in Settle Up</p>
    </div>`,
    `<button class="btn-ghost" onclick="closeModal('edit-member-modal')">Cancel</button>
     <button class="btn-primary" onclick="doUpdateMember('${memberId}', ${iAmMe})">Save</button>`
  );
}

function showAddExpenseModal() {
  if (!S.members.length) { toast('Add members first', 'warning'); return; }
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
        <input type="number" id="e-amt" placeholder="0" class="form-input" min="0" step="0.01" oninput="updateSplits()">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group flex-1">
        <label>Paid by *</label>
        <select id="e-paidby" class="form-input">
          ${S.members.map(m => `<option value="${m.id}" ${m.id === S.myMemberId ? 'selected' : ''}>${escHtml(m.name)}${m.id === S.myMemberId ? ' (You)' : ''}</option>`).join('')}
        </select>
      </div>
      <div class="form-group flex-1">
        <label>Category</label>
        <select id="e-cat" class="form-input">${cats.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
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
        <button class="split-type-btn" id="stype-custom" onclick="setSplitType('custom')">✏️ Custom</button>
        <button class="split-type-btn" id="stype-percentage" onclick="setSplitType('percentage')">% By %</button>
      </div>
    </div>
    <div class="form-group">
      <label>Split Among</label>
      <div id="split-rows">${buildSplitRows('equal', 0)}</div>
    </div>`;

  modal('add-expense-modal', '💰 Add Expense', body,
    `<button class="btn-ghost" onclick="closeModal('add-expense-modal')">Cancel</button>
     <button class="btn-primary" onclick="doAddExpense()">Add Expense</button>`
  );
  requestAnimationFrame(() => {
    document.querySelector('#add-expense-modal .modal-content')?.classList.add('large-modal');
    document.getElementById('e-desc')?.focus();
  });
}

let currentSplitType = 'equal';

function buildSplitRows(type, total) {
  const n = S.members.length;
  const eq = n > 0 ? total / n : 0;
  return S.members.map(m => `
    <div class="split-row" data-mid="${m.id}">
      <label class="split-member-label">
        <input type="checkbox" class="split-cb" data-mid="${m.id}" checked onchange="updateSplits()">
        <div class="member-avatar tiny" style="background:${m.color}">${initials(m.name)}</div>
        <span>${escHtml(m.name)}${m.id === S.myMemberId ? ' <span class="you-badge">You</span>' : ''}</span>
      </label>
      ${type === 'equal'
        ? `<span class="split-amount-display" id="sd-${m.id}">₹${fmt(eq)}</span>`
        : type === 'custom'
        ? `<input type="number" class="split-custom form-input small" id="sc-${m.id}" value="${fmt(eq)}" min="0" step="0.01" oninput="checkSplitTotal()">`
        : `<div class="split-percentage"><input type="number" class="split-pct form-input small" id="sc-${m.id}" value="${Math.round(100/n)}" min="0" max="100" oninput="updateSplits()"><span>%</span></div>`}
    </div>`).join('');
}

function setSplitType(type) {
  currentSplitType = type;
  ['equal', 'custom', 'percentage'].forEach(t => document.getElementById('stype-' + t)?.classList.toggle('active', t === type));
  const amt = parseFloat(document.getElementById('e-amt')?.value || 0);
  const el = document.getElementById('split-rows');
  if (el) el.innerHTML = buildSplitRows(type, amt);
}

function updateSplits() {
  const amt = parseFloat(document.getElementById('e-amt')?.value || 0);
  if (currentSplitType === 'equal') {
    const checked = Array.from(document.querySelectorAll('.split-cb:checked'));
    const share = checked.length > 0 ? amt / checked.length : 0;
    S.members.forEach(m => {
      const el = document.getElementById('sd-' + m.id);
      const cb = document.querySelector(`.split-cb[data-mid="${m.id}"]`);
      if (el) el.textContent = `₹${fmt(cb?.checked ? share : 0)}`;
    });
  }
}

function checkSplitTotal() {
  const amt = parseFloat(document.getElementById('e-amt')?.value || 0);
  let total = 0;
  S.members.forEach(m => { total += parseFloat(document.getElementById('sc-' + m.id)?.value || 0); });
  document.querySelectorAll('.split-custom').forEach(el => {
    el.style.borderColor = Math.abs(total - amt) < 0.02 ? 'var(--success)' : 'var(--warning)';
  });
}

function showTripInfo() {
  const code = S.trip?.inviteCode;
  modal('trip-info-modal', '🔗 Trip Info',
    `<div class="trip-info-content">
      <p>Share this code with friends so they can join:</p>
      <div class="big-invite-code">${code || '——'}</div>
      <p class="input-hint">Or share the link:</p>
      <p class="input-hint" style="word-break:break-all">${location.origin}${location.pathname}?join=${code}</p>
    </div>`,
    `<button class="btn-ghost" onclick="closeModal('trip-info-modal')">Close</button>
     <button class="btn-primary" onclick="copyInviteCode('${code}');closeModal('trip-info-modal')">📋 Copy Code</button>
     <button class="btn-secondary" onclick="shareInviteLink('${code}')">🔗 Share Link</button>`
  );
}

// =============================================
// SECTION 19: NEW TRIP HELPERS
// =============================================

function addPlaceInput() {
  const list = document.getElementById('places-input-list');
  if (!list) return;
  const i = list.children.length;
  const div = document.createElement('div');
  div.className = 'place-input-row';
  div.innerHTML = `<span class="place-index">${i + 1}</span>
    <input type="text" placeholder="Enter place name…" class="form-input place-name-input" onkeydown="if(event.key==='Enter')addPlaceInput()">
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
  if (!url) { toast('Paste a Google Maps URL first', 'warning'); return; }
  btn.textContent = '⏳…'; btn.disabled = true;
  try {
    const places = await parseGoogleMapsUrl(url);
    if (!places.length) { toast('No places found — add manually', 'warning'); }
    else {
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
      toast(`Imported ${places.length} destinations!`, 'success');
    }
  } catch (e) { toast('Could not import — add manually', 'error'); }
  btn.textContent = 'Import'; btn.disabled = false;
}

// =============================================
// SECTION 20: EVENT HANDLERS
// =============================================

function goHome() {
  detachListeners();
  S.trip = null; S.members = []; S.expenses = []; S.myMemberId = null;
  if (mapInstance) { try { mapInstance.remove(); } catch (_) {} mapInstance = null; }
  renderHome();
}

function openTrip(tripId) { renderTrip(tripId); }

async function doCreateTrip() {
  const name = document.getElementById('trip-name')?.value?.trim();
  const creatorName = document.getElementById('creator-name')?.value?.trim();
  const creatorUpi = document.getElementById('creator-upi')?.value?.trim();
  if (!name) { toast('Enter a trip name', 'warning'); return; }
  if (!creatorName) { toast('Enter your name', 'warning'); document.getElementById('creator-name')?.focus(); return; }

  const placeNames = Array.from(document.querySelectorAll('.place-name-input'))
    .map(i => i.value.trim()).filter(Boolean);

  const btn = document.getElementById('create-trip-btn');
  btn.textContent = '⏳ Creating…'; btn.disabled = true;
  hideNewTripModal();

  localStorage.setItem('tpyyy_myname', creatorName);
  if (creatorUpi) localStorage.setItem('tpyyy_myupi', creatorUpi);

  let geocoded = [];
  if (placeNames.length) {
    toast('Finding locations on map…', 'info');
    geocoded = await geocodePlaces(placeNames, (i, total, n) => toast(`Locating "${n}" (${i+1}/${total})…`, 'info'));
  }

  try {
    const { tripId, memberId, inviteCode } = await dbCreateTrip(name, geocoded, creatorName, creatorUpi);
    saveToRegistry({ tripId, memberId, tripName: name, inviteCode });
    toast(`Trip created! Invite code: ${inviteCode}`, 'success');
    renderTrip(tripId);
  } catch (e) {
    toast('Error creating trip: ' + e.message, 'error');
    btn.textContent = 'Create Trip'; btn.disabled = false;
  }
}

async function doJoinTrip() {
  const code = document.getElementById('j-code')?.value?.trim();
  const name = document.getElementById('j-name')?.value?.trim();
  const upi = document.getElementById('j-upi')?.value?.trim();
  if (!code) { toast('Enter an invite code', 'warning'); return; }
  if (!name) { toast('Enter your name', 'warning'); return; }

  const btn = document.getElementById('join-ok');
  btn.textContent = '⏳ Joining…'; btn.disabled = true;

  localStorage.setItem('tpyyy_myname', name);
  if (upi) localStorage.setItem('tpyyy_myupi', upi);

  try {
    const { tripId, memberId, tripName, inviteCode } = await dbJoinTrip(code, name, upi);
    saveToRegistry({ tripId, memberId, tripName: tripName || 'Trip', inviteCode: inviteCode || code });
    closeModal('join-modal');
    toast('Joined trip!', 'success');
    renderTrip(tripId);
  } catch (e) {
    toast(e.message || 'Could not join trip', 'error');
    btn.textContent = 'Join Trip'; btn.disabled = false;
  }
}

async function doAddPlace() {
  const name = document.getElementById('p-name')?.value?.trim();
  if (!name) { toast('Enter a place name', 'warning'); return; }
  const btn = document.getElementById('add-place-ok');
  if (btn) { btn.textContent = '⏳ Locating…'; btn.disabled = true; }
  const coords = await geocodePlace(name);
  await dbAddPlace(S.trip.id, { name, lat: coords?.lat, lng: coords?.lng });
  closeModal('add-place-modal');
  toast(coords ? 'Stop added!' : 'Stop added (not found on map)', coords ? 'success' : 'warning');
}

async function doUpdateMember(memberId, isMe) {
  const name = document.getElementById('em-name')?.value?.trim();
  const upi = document.getElementById('em-upi')?.value?.trim();
  const update = { upiId: upi || '' };
  if (isMe && name) update.name = name;
  await dbUpdateMember(S.trip.id, memberId, update);
  if (isMe && name) localStorage.setItem('tpyyy_myname', name);
  if (upi) localStorage.setItem('tpyyy_myupi', upi);
  closeModal('edit-member-modal');
  toast('Updated!', 'success');
}

async function doAddExpense() {
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
    const share = amt / checked.length;
    let rem = amt;
    checked.forEach((cb, i) => {
      const s = i === checked.length - 1 ? round2(rem) : round2(share);
      rem = round2(rem - round2(share));
      splits.push({ memberId: cb.dataset.mid, amount: s });
    });
  } else if (currentSplitType === 'custom') {
    let total = 0;
    S.members.forEach(m => {
      const v = parseFloat(document.getElementById('sc-' + m.id)?.value || 0);
      if (v > 0) { splits.push({ memberId: m.id, amount: v }); total += v; }
    });
    if (!splits.length) { toast('Add split amounts', 'warning'); return; }
    if (Math.abs(total - amt) > 0.05) { toast(`Splits (₹${fmt(total)}) don't match total (₹${fmt(amt)})`, 'warning'); return; }
  } else {
    let pctTotal = 0;
    S.members.forEach(m => {
      const pct = parseFloat(document.getElementById('sc-' + m.id)?.value || 0);
      if (pct > 0) { splits.push({ memberId: m.id, amount: round2(amt * pct / 100) }); pctTotal += pct; }
    });
    if (!splits.length) { toast('Add percentages', 'warning'); return; }
    if (Math.abs(pctTotal - 100) > 1) { toast(`Percentages total ${pctTotal}%, need 100%`, 'warning'); return; }
  }

  const btn = document.querySelector('#add-expense-modal .btn-primary');
  if (btn) { btn.textContent = '⏳ Adding…'; btn.disabled = true; }

  await dbAddExpense(S.trip.id, { description: desc, amount: amt, paidBy, splits, date, category: cat });
  closeModal('add-expense-modal');
  toast('Expense added!', 'success');
}

async function handleTogglePlace(placeId) {
  await dbTogglePlace(S.trip.id, placeId);
}

async function handleRemovePlace(placeId) {
  await dbRemovePlace(S.trip.id, placeId);
}

async function handleRemoveMember(memberId) {
  const m = S.members.find(m => m.id === memberId);
  if (confirm(`Remove ${m?.name} from this trip?`)) {
    await dbRemoveMember(S.trip.id, memberId);
    toast(`${m?.name} removed`, 'info');
  }
}

async function handleRemoveExpense(expenseId) {
  if (confirm('Delete this expense?')) {
    await dbRemoveExpense(S.trip.id, expenseId);
    toast('Expense deleted', 'info');
  }
}

async function confirmDeleteTrip(tripId) {
  if (confirm(`Delete "${S.trip?.name}" for ALL members? This cannot be undone.`)) {
    await dbLeaveOrDeleteTrip(tripId);
    goHome();
    toast('Trip deleted', 'info');
  }
}

async function confirmLeaveTrip(tripId) {
  if (confirm('Leave this trip? You can rejoin with the invite code.')) {
    await dbLeaveOrDeleteTrip(tripId);
    goHome();
    toast('Left trip', 'info');
  }
}

// =============================================
// SECTION 21: PHONE AUTH
// =============================================

let recaptchaVerifier = null;
let confirmationResult = null;

function renderPhoneAuth() {
  document.getElementById('app').innerHTML = `
    <div class="auth-screen">
      <div class="auth-card">
        <div class="auth-logo">
          <span class="auth-icon">✈️</span>
          <h1>Tripppyyy</h1>
          <p>Sign in to sync your trips across all your devices</p>
        </div>

        <div id="auth-step-phone">
          <button class="btn-google" onclick="handleGoogleSignIn()">
            <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
            Continue with Google
          </button>

          <div class="auth-divider"><span>or</span></div>

          <div class="form-group">
            <label>Mobile Number</label>
            <div class="phone-input-row">
              <span class="country-code">+91</span>
              <input type="tel" id="auth-phone" placeholder="9876543210"
                class="form-input" maxlength="10" inputmode="numeric"
                onkeydown="if(event.key==='Enter')handleSendOTP()">
            </div>
            <p class="input-hint">You'll receive a one-time SMS verification code</p>
          </div>
          <div id="recaptcha-container"></div>
          <button class="btn-primary auth-btn" id="send-otp-btn" onclick="handleSendOTP()">
            Send OTP via SMS
          </button>
        </div>

        <div id="auth-step-otp" class="hidden">
          <p class="otp-sent-msg">OTP sent to <strong>+91 <span id="otp-phone-display"></span></strong></p>
          <div class="form-group">
            <label>Enter OTP</label>
            <input type="text" id="auth-otp" placeholder="6-digit code"
              class="form-input otp-input" maxlength="6" inputmode="numeric"
              onkeydown="if(event.key==='Enter')handleVerifyOTP()">
          </div>
          <button class="btn-primary auth-btn" id="verify-otp-btn" onclick="handleVerifyOTP()">
            Verify &amp; Continue
          </button>
          <button class="btn-ghost auth-btn" onclick="backToPhone()">← Change number</button>
        </div>
      </div>
    </div>`;
  requestAnimationFrame(() => document.getElementById('auth-phone')?.focus());
}

async function handleGoogleSignIn() {
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    // On mobile use redirect (no popup blocked), on desktop use popup
    if (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
      await firebase.auth().signInWithRedirect(provider);
    } else {
      await firebase.auth().signInWithPopup(provider);
    }
    // onAuthStateChanged handles the rest
  } catch (e) {
    console.error('Google sign-in error:', e);
    if (e.code !== 'auth/popup-closed-by-user') {
      toast(e.message || 'Google sign-in failed', 'error');
    }
  }
}

async function linkGoogleAccount() {
  if (!S.currentUser) return;
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    if (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
      await S.currentUser.linkWithRedirect(provider);
    } else {
      await S.currentUser.linkWithPopup(provider);
      toast('Google account linked!', 'success');
      renderHome();
    }
  } catch (e) {
    if (e.code === 'auth/credential-already-in-use') {
      toast('That Google account belongs to a different user', 'warning');
    } else if (e.code !== 'auth/popup-closed-by-user') {
      toast(e.message || 'Linking failed', 'error');
    }
  }
}

async function linkPhoneAccount() {
  const phoneInput = prompt('Enter your mobile number (10 digits):');
  if (!phoneInput || !/^\d{10}$/.test(phoneInput.trim())) {
    toast('Enter a valid 10-digit number', 'warning');
    return;
  }
  // We need a recaptcha container — create one temporarily
  const container = document.createElement('div');
  container.id = 'link-recaptcha';
  document.body.appendChild(container);
  try {
    const rv = new firebase.auth.RecaptchaVerifier('link-recaptcha', { size: 'invisible', callback: () => {} });
    const result = await firebase.auth().signInWithPhoneNumber('+91' + phoneInput.trim(), rv);
    const code = prompt('Enter the OTP sent to +91' + phoneInput.trim() + ':');
    if (!code) return;
    const cred = firebase.auth.PhoneAuthProvider.credential(result.verificationId, code);
    await S.currentUser.linkWithCredential(cred);
    toast('Mobile number linked!', 'success');
    renderHome();
    rv.clear();
  } catch (e) {
    if (e.code === 'auth/credential-already-in-use') {
      toast('That number is linked to a different account', 'warning');
    } else {
      toast(e.message || 'Linking failed', 'error');
    }
  } finally {
    document.getElementById('link-recaptcha')?.remove();
  }
}

async function handleSendOTP() {
  const phoneInput = document.getElementById('auth-phone')?.value.trim() || '';
  if (!/^\d{10}$/.test(phoneInput)) {
    toast('Enter a valid 10-digit mobile number', 'warning');
    return;
  }
  const btn = document.getElementById('send-otp-btn');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    if (!recaptchaVerifier) {
      recaptchaVerifier = new firebase.auth.RecaptchaVerifier('recaptcha-container', {
        size: 'invisible',
        callback: () => {},
      });
    }
    const phoneNumber = '+91' + phoneInput;
    confirmationResult = await firebase.auth().signInWithPhoneNumber(phoneNumber, recaptchaVerifier);
    document.getElementById('otp-phone-display').textContent = phoneInput;
    document.getElementById('auth-step-phone').classList.add('hidden');
    document.getElementById('auth-step-otp').classList.remove('hidden');
    requestAnimationFrame(() => document.getElementById('auth-otp')?.focus());
    toast('OTP sent!', 'success');
  } catch (e) {
    console.error('Send OTP error:', e);
    toast(e.message || 'Failed to send OTP. Try again.', 'error');
    btn.disabled = false;
    btn.textContent = 'Send OTP';
    if (recaptchaVerifier) { recaptchaVerifier.clear(); recaptchaVerifier = null; }
  }
}

async function handleVerifyOTP() {
  const code = document.getElementById('auth-otp')?.value.trim() || '';
  if (!/^\d{6}$/.test(code)) {
    toast('Enter the 6-digit OTP', 'warning');
    return;
  }
  const btn = document.getElementById('verify-otp-btn');
  btn.disabled = true;
  btn.textContent = 'Verifying…';
  try {
    await confirmationResult.confirm(code);
    // onAuthStateChanged fires and renders home
  } catch (e) {
    console.error('Verify OTP error:', e);
    toast(e.message || 'Invalid OTP. Try again.', 'error');
    btn.disabled = false;
    btn.textContent = 'Verify & Continue';
  }
}

function backToPhone() {
  confirmationResult = null;
  if (recaptchaVerifier) { recaptchaVerifier.clear(); recaptchaVerifier = null; }
  document.getElementById('auth-step-otp').classList.add('hidden');
  document.getElementById('auth-step-phone').classList.remove('hidden');
  document.getElementById('auth-phone').value = '';
}

async function handleSignOut() {
  if (!confirm('Sign out of Tripppyyy?')) return;
  await firebase.auth().signOut();
  localStorage.removeItem('tpyyy_registry');
  toast('Signed out', 'info');
}

// =============================================
// SECTION 22: APP INITIALIZATION
// =============================================

function init() {
  // Load geocode cache
  try { S.geocodeCache = JSON.parse(localStorage.getItem('tpyyy_geo') || '{}'); } catch (_) {}

  // Check for ?join=CODE in URL
  const urlParams = new URLSearchParams(location.search);
  const joinCode = urlParams.get('join');

  // Initialize Firebase
  if (typeof FIREBASE_CONFIG === 'undefined') {
    renderSetup();
    return;
  }

  try {
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    S.db = firebase.firestore();
    // Enable offline persistence
    S.db.enablePersistence({ synchronizeTabs: true })
      .catch(e => console.warn('Offline persistence:', e.code));
  } catch (e) {
    console.error('Firebase init failed:', e);
    renderSetup();
    return;
  }

  // Handle Google redirect result (mobile sign-in redirect flow)
  firebase.auth().getRedirectResult().catch(e => {
    if (e.code && e.code !== 'auth/null-user') {
      console.error('Redirect result error:', e);
      toast(e.message || 'Sign-in failed', 'error');
    }
  });

  // Auth state — single source of truth for rendering
  firebase.auth().onAuthStateChanged(async user => {
    S.currentUser = user;
    if (user) {
      // Sync cloud registry → local before rendering home
      await syncRegistryFromFirestore();
      const pendingJoin = sessionStorage.getItem('pendingJoinCode') || joinCode;
      if (pendingJoin) {
        sessionStorage.removeItem('pendingJoinCode');
        history.replaceState({}, '', location.pathname);
        renderHome();
        requestAnimationFrame(() => {
          showJoinModal();
          requestAnimationFrame(() => {
            const input = document.getElementById('j-code');
            if (input) input.value = pendingJoin.toUpperCase();
          });
        });
      } else {
        renderHome();
      }
    } else {
      // Not signed in — stash any pending join code and show auth
      if (joinCode) {
        sessionStorage.setItem('pendingJoinCode', joinCode);
        history.replaceState({}, '', location.pathname);
      }
      renderPhoneAuth();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
