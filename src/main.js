import { registerPlugin } from '@capacitor/core';
import { onAuthStateChanged, getRedirectResult } from 'firebase/auth';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where, orderBy, limit,
  onSnapshot, getDocs, writeBatch, arrayUnion, arrayRemove, serverTimestamp
} from 'firebase/firestore';
import { auth, db, configured, isNative, signInGoogle, logout } from './lib/fb.js';
import { startTracking, stopTracking, isTracking, openLocationSettings, resetTracker } from './lib/tracker.js';
import { resetToken } from './lib/rest.js';
import { getRoute, placeAt, cachedPlace, searchAddress } from './lib/route.js';
import { status as personStatus, analyze, derive } from './lib/analysis.js';
import { MapView } from './lib/mapview.js';
import { $, esc, initial, safeColor, COLORS, fmtDur, fmtDist, clock, clockIn, timeAgo, haversine, normPhone, prettyPhone, telHref, randomCode, store } from './lib/util.js';
import { SITE_URL } from './firebase-config.js';

const BatteryOpt = isNative ? registerPlugin('BatteryOpt') : null;
const BUILD = { code: +(import.meta.env.VITE_VERSION_CODE || 1), name: import.meta.env.VITE_VERSION_NAME || '1.0' };

/* =========================================================
   מצב
   ========================================================= */
const settings = Object.assign({ theme: 'auto', alertMin: 20, arrivalNotify: true }, store.get('settings', {}));
const saveSettings = () => store.set('settings', settings);

const S = {
  user: null, profile: null, priv: null,
  groups: new Map(), people: new Map(),
  invitesIn: [], invitesOut: [],
  activeGroup: store.get('activeGroup', null),
  selected: null, analysis: null,
  myPos: null, page: 'groups', mapFilter: 'all', mapSel: null,
  destMode: store.get('destMode', {}),
  noAnswer: store.get('noAnswer', {}),
  notes: store.get('notes', []),
  unsub: [], started: false
};
const me = () => S.user?.uid;

/* =========================================================
   עזרי ממשק
   ========================================================= */
function screen(id) { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === id)); }
function modal(html) { $('mbox').innerHTML = html; $('modal').classList.add('on'); }
function closeModal() { $('modal').classList.remove('on'); }
window.closeModal = closeModal;
$('modal').onclick = e => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal(); };
// תמונת פרופיל שלא נטענה – מסירים אותה ומשאירים את האות (בלי קוד בתוך ה-HTML, לטובת מדיניות האבטחה)
document.addEventListener('error', e => { const t = e.target; if (t && t.tagName === 'IMG' && t.closest('.av, .pin-av')) t.remove(); }, true);
let tt; function toast(t) { $('toast').textContent = t; $('toast').classList.add('on'); clearTimeout(tt); tt = setTimeout(() => $('toast').classList.remove('on'), 2600); }
function openExt(url) { if (isNative || /^(tel|sms|mailto):/.test(url)) location.href = url; else window.open(url, '_blank', 'noopener'); }
function avatar(p, cls = '', dot) {
  const name = p?.name || '?', color = safeColor(p?.color);
  return `<div class="av ${cls}" style="background:${color}">${p?.photo ? `<img src="${esc(p.photo)}" referrerpolicy="no-referrer">` : ''}${initial(name)}${dot ? `<span class="dot" style="background:${safeColor(dot)}"></span>` : ''}</div>`;
}

/* =========================================================
   ערכת צבעים
   ========================================================= */
const mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : { matches: false };
const isDark = () => settings.theme === 'dark' || (settings.theme === 'auto' && mq.matches);
function applyTheme() {
  const dark = isDark();
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('themeQuick').textContent = dark ? '☀️' : '🌙';
  document.querySelector('meta[name=theme-color]').content = dark ? '#0b0f17' : '#1d4ed8';
  gmap?.setTheme(dark); bmap?.setTheme(dark);
}
mq.addEventListener?.('change', applyTheme);
$('themeQuick').onclick = () => { settings.theme = isDark() ? 'light' : 'dark'; saveSettings(); applyTheme(); if (S.page === 'settings') renderSettings(); };

/* =========================================================
   התחברות ופרופיל
   ========================================================= */
if (!configured) { screen('s-setup'); }
else {
  if (!isNative) getRedirectResult(auth).catch(e => { $('loginErr').textContent = 'ההתחברות נכשלה: ' + (e.code || e.message); });
  onAuthStateChanged(auth, async u => {
    S.user = u;
    if (!u) { stopAll(); screen('s-login'); return; }
    // החלפת חשבון באותו טלפון – מנקים את כל מה שנשמר מהחשבון הקודם
    const prevUid = store.get('uid', null);
    if (prevUid && prevUid !== u.uid) stopAll();
    store.set('uid', u.uid);
    try {
      const snap = await getDoc(doc(db, 'users', u.uid));
      S.profile = snap.exists() ? snap.data() : null;
      const priv = await getDoc(doc(db, 'locations', u.uid)).catch(() => null);
      S.priv = priv && priv.exists() ? priv.data() : null;
      if (!S.profile || !S.priv?.phone) return showProfile();
      if (!store.get('permAsked', false)) return showPerm();
      startApp();
    } catch (e) { console.error(e); screen('s-login'); $('loginErr').textContent = 'שגיאה בטעינת הנתונים: ' + (e.code || e.message); }
  });
}
$('gLogin').onclick = async () => {
  $('loginErr').textContent = '';
  try { await signInGoogle(); } catch (e) { console.error(e); $('loginErr').textContent = 'ההתחברות לא הצליחה' + (e.code ? ` (${e.code})` : e.message ? ` (${e.message})` : ''); }
};

let pfColor = null;
function showProfile() {
  screen('s-profile');
  const u = S.user;
  $('pfName').value = S.profile?.name || u.displayName || '';
  $('pfPhone').value = S.priv?.phone ? prettyPhone(S.priv.phone) : (u.phoneNumber || '');
  pfColor = S.profile?.color || COLORS[Math.floor(Math.random() * COLORS.length)];
  $('pfColors').innerHTML = COLORS.map(c => `<button data-c="${esc(c)}" style="background:${c}" class="${c === pfColor ? 'on' : ''}"></button>`).join('');
  $('pfColors').querySelectorAll('button').forEach(b => b.onclick = () => { pfColor = b.dataset.c; $('pfColors').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); });
  $('pfErr').textContent = '';
  $('pfCancel').style.display = S.started ? '' : 'none';
}
$('pfCancel').onclick = () => { if (S.started) screen(null); };
$('pfSave').onclick = async () => {
  const name = $('pfName').value.trim().slice(0, 40), phone = normPhone($('pfPhone').value);
  if (!name) return $('pfErr').textContent = 'צריך שם';
  if (!phone) return $('pfErr').textContent = 'מספר הטלפון לא נראה תקין';
  $('pfSave').disabled = true; $('pfErr').textContent = '';
  try {
    const uid = me();
    const ph = await getDoc(doc(db, 'phones', phone));
    if (ph.exists() && ph.data().uid !== uid) throw new Error('המספר הזה כבר רשום בחשבון אחר');
    let code = S.profile?.code;
    for (let i = 0; !code && i < 6; i++) { const c = randomCode(); if (!(await getDoc(doc(db, 'codes', c))).exists()) code = c; }
    const b = writeBatch(db);
    b.set(doc(db, 'users', uid), { name, photo: S.user.photoURL || null, color: pfColor, code, updatedAt: serverTimestamp() }, { merge: true });
    b.set(doc(db, 'phones', phone), { uid });
    b.set(doc(db, 'codes', code), { uid });
    if (S.priv?.phone && S.priv.phone !== phone) b.delete(doc(db, 'phones', S.priv.phone));
    b.set(doc(db, 'locations', uid), { phone, sharing: S.priv?.sharing ?? true, viewers: S.priv?.viewers || [] }, { merge: true });
    await b.commit();
    const gs = await getDocs(query(collection(db, 'groups'), where('members', 'array-contains', uid)));
    if (gs.empty) await addDoc(collection(db, 'groups'), { name: 'משפחה', emoji: '🏠', owner: uid, members: [uid], createdAt: serverTimestamp() });
    S.profile = { ...(S.profile || {}), name, color: pfColor, code, photo: S.user.photoURL || null };
    S.priv = { ...(S.priv || {}), phone };
    if (S.started) { screen(null); toast('הפרופיל נשמר'); renderAll(); }
    else if (!store.get('permAsked', false)) showPerm(); else startApp();
  } catch (e) { console.error(e); $('pfErr').textContent = e.message?.startsWith('המספר') ? e.message : 'השמירה נכשלה: ' + (e.code || e.message); }
  finally { $('pfSave').disabled = false; }
};

function showPerm() {
  screen('s-perm');
  $('permList').innerHTML = (isNative ? [
    ['📍', 'גישה למיקום', 'כדי לשתף את המיקום שלך עם הקבוצות'],
    ['🔔', 'התראות', 'כדי להתריע כשמישהו מתעכב או מגיע, ולהציג הודעה קבועה בזמן שהמיקום משותף'],
    ['🔋', 'פועל ברקע', 'המיקום ממשיך להתעדכן גם כשהטלפון בכיס. אפשר לכבות בכל רגע בהגדרות']
  ] : [
    ['📍', 'גישה למיקום', 'כדי לשתף את המיקום שלך עם הקבוצות'],
    ['ℹ️', 'גרסת האתר', 'כאן המיקום מתעדכן רק כשהאתר פתוח. לשיתוף ברקע כדאי להוריד את אפליקציית האנדרואיד']
  ]).map(([i, t, d]) => `<div><span style="font-size:22px">${i}</span><span><b>${t}</b>${d}</span></div>`).join('');
}
$('permGo').onclick = async () => { store.set('permAsked', true); startApp(); };
$('permSkip').onclick = () => { store.set('permAsked', true); store.set('noAutoTrack', true); startApp(); };

/* =========================================================
   הפעלת האפליקציה + האזנה לנתונים
   ========================================================= */
let gmap = null, bmap = null, tick = null, trimTimer = null, listenersOn = false;
function stopAll() {
  S.unsub.forEach(f => f()); S.unsub = []; for (const p of S.people.values()) p.unsub?.(); S.people.clear(); S.groups.clear();
  S.started = false; clearInterval(tick); clearInterval(trimTimer); stopTracking(); wipeLocal();
}
/** ניקוי כל המידע המקומי של החשבון (בהתנתקות / החלפת חשבון) */
function wipeLocal() {
  resetToken(); resetTracker();
  Object.assign(S, { notes: [], noAnswer: {}, destMode: {}, invitesIn: [], invitesOut: [], activeGroup: null, selected: null, analysis: null, mapSel: null, myPos: null, profile: null, priv: null, bmapFitted: false });
  ['notes', 'noAnswer', 'destMode', 'activeGroup', 'trk', 'uid'].forEach(k => { try { localStorage.removeItem('mk-' + k); } catch (e) { } });
  try { $('unread').style.display = 'none'; gmap?.setRoute(); gmap?.setPeople([], null); bmap?.setPeople([], null); gmap?.setMe(null); bmap?.setMe(null); } catch (e) { }
}

function startApp() {
  screen(null);
  if (S.started) return renderAll();
  S.started = true;
  initUI();
  startSubs();
}
function initUI() {
  if (!gmap) {
    gmap = new MapView($('gmap'), { onTap: uid => openMember(uid), insets: () => ({ top: 125, bottom: $('sheet').offsetHeight }) });
    bmap = new MapView($('bmap'), { onTap: uid => selectOnMap(uid), onBg: () => { if (S.mapSel) { S.mapSel = null; renderMapPage(); } }, insets: () => ({ top: 60, bottom: ($('pcard').classList.contains('on') ? $('pcard').offsetHeight + 20 : 0) + 100 }) });
    applyTheme();
  }
}
function startSubs() {
  const uid = me();
  S.unsub.push(onSnapshot(doc(db, 'users', uid), s => { if (s.exists()) { S.profile = s.data(); if (S.page === 'settings') renderSettings(); } }));
  S.unsub.push(onSnapshot(doc(db, 'locations', uid), s => { S.priv = s.data() || {}; syncViewers(); if (S.page === 'settings') renderSettings(); }, e => console.warn(e)));
  S.unsub.push(onSnapshot(query(collection(db, 'groups'), where('members', 'array-contains', uid)), snap => {
    S.groups.clear(); snap.forEach(d => S.groups.set(d.id, { id: d.id, ...d.data() }));
    if (!S.groups.has(S.activeGroup)) S.activeGroup = [...S.groups.keys()][0] || null;
    syncPeople(); syncViewers(); renderAll();
  }, e => console.warn(e)));
  S.unsub.push(onSnapshot(query(collection(db, 'invites'), where('to', '==', uid)), snap => {
    const before = new Set(S.invitesIn.map(i => i.id));
    S.invitesIn = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    S.invitesIn.filter(i => !before.has(i.id)).forEach(i => notify(`הזמנה ל${i.groupName}`, `${i.fromName} רוצה להוסיף אותך לקבוצה`, null));
    renderBanner(); updateUnread(); if (S.page === 'alerts') renderAlerts();
  }, e => console.warn(e)));
  S.unsub.push(onSnapshot(query(collection(db, 'invites'), where('from', '==', uid)), snap => {
    S.invitesOut = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (S.page === 'groups' && !S.selected) renderList();
  }, e => console.warn(e)));

  if (!store.get('noAutoTrack', false) && S.priv?.sharing !== false) beginTracking().then(() => setTimeout(() => checkBattery(false), 2500));
  else if (!isNative && navigator.geolocation) navigator.geolocation.getCurrentPosition(p => { S.myPos = { lat: p.coords.latitude, lng: p.coords.longitude }; }, () => { });

  clearInterval(tick);
  tick = setInterval(liveTick, 15000);
  go(S.page);
  checkUpdate();
  clearInterval(trimTimer); setTimeout(trimTrail, 20000); trimTimer = setInterval(trimTrail, 6 * 3600e3);
  if (!listenersOn) {
    listenersOn = true;
    if (isNative) import('@capacitor/app').then(({ App }) => App.addListener('resume', () => { if (S.user) onResume(); })).catch(() => { });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.user) onResume(); });
  }
}

async function beginTracking() {
  const ok = await startTracking({
    uid: me(),
    onLocal: p => { S.myPos = p; gmap?.setMe(p); bmap?.setMe(p); },
    onDenied: () => toast('אין הרשאת מיקום – אפשר לאשר בהגדרות הטלפון'),
    onError: e => { S.trackErr = e ? (e.message || e.code || String(e)) : null; }
  }).catch(e => { console.error(e); toast('לא הצלחתי להפעיל שיתוף מיקום'); return false; });
  if (S.page === 'settings') renderSettings();
  return ok;
}

/** כל האנשים בכל הקבוצות שלי */
function allMemberUids() {
  const s = new Set(); for (const g of S.groups.values()) g.members.forEach(u => s.add(u));
  s.delete(me()); return [...s];
}
async function syncViewers() {
  if (!S.priv || !S.started) return;
  const want = S.priv.sharing === false ? [] : allMemberUids().sort();
  const have = [...(S.priv.viewers || [])].sort();
  if (want.join() === have.join()) return;
  S.priv.viewers = want;
  try { await updateDoc(doc(db, 'locations', me()), { viewers: want }); } catch (e) { console.warn('viewers', e); }
}
function syncPeople() {
  const want = new Set(allMemberUids());
  for (const [uid, p] of S.people) if (!want.has(uid)) { p.unsub?.(); S.people.delete(uid); }
  for (const uid of want) if (!S.people.has(uid)) subPerson(uid);
}
function subPerson(uid) {
  const p = { uid, name: '', color: '#94a3b8', photo: null, loc: null, denied: false, noAnswer: 0 };
  S.people.set(uid, p);
  let u1 = null, u2 = null, retry = null;
  const subLoc = () => {
    u2 = onSnapshot(doc(db, 'locations', uid), s => {
      const prev = p.loc; p.loc = s.data() || null; p.denied = false;
      // אם האדם התחיל לזוז – מאפסים את מונה השיחות שלא נענו
      if (prev && p.loc && prev.stillSince !== p.loc.stillSince && S.noAnswer[uid]) { delete S.noAnswer[uid]; store.set('noAnswer', S.noAnswer); }
      enrich(p).then(() => personChanged(p));
    }, () => { p.denied = true; personChanged(p); clearTimeout(retry); retry = setTimeout(() => { if (S.people.get(uid) === p) { u2?.(); subLoc(); } }, 20000); });
  };
  u1 = onSnapshot(doc(db, 'users', uid), s => { const d = s.data() || {}; p.name = d.name || 'ללא שם'; p.color = safeColor(d.color); p.photo = d.photo || null; personChanged(p); });
  subLoc();
  p.unsub = () => { u1?.(); u2?.(); clearTimeout(retry); };
}

/* מידע נוסף לכל אדם: יעד, מסלול, סוג המקום */
function destFor(p) {
  const mode = S.destMode[p.uid] || (p.loc?.home ? 'home' : 'me');
  if (mode === 'home' && p.loc?.home) return { lat: p.loc.home.lat, lng: p.loc.home.lng, kind: 'home' };
  if (S.myPos) return { lat: S.myPos.lat, lng: S.myPos.lng, kind: 'me' };
  if (S.priv?.home) return { lat: S.priv.home.lat, lng: S.priv.home.lng, kind: 'me' };
  return null;
}
function view(p) {
  const d = destFor(p);
  return { ...p, dest: d, destKind: d?.kind, noAnswer: S.noAnswer[p.uid]?.n || 0 };
}
async function enrich(p) {
  const L = p.loc; if (!L || L.lat == null || L.sharing === false) return;
  const dest = destFor(p);
  const stillMin = L.stillSince ? (Date.now() - L.stillSince) / 60000 : 0;
  const jobs = [];
  if (!p.placeAt || haversine(p.placeAt, L) > 40 && (stillMin >= 2 || Date.now() - (p.placeT || 0) > 60000)) {
    jobs.push(placeAt(L).then(r => { if (r.type !== 'unknown' || !p.place) p.place = r; p.placeAt = { lat: L.lat, lng: L.lng }; p.placeT = Date.now(); }));
  }
  if (dest) {
    jobs.push(getRoute(L, dest, p.uid + dest.kind).then(r => { p.route = r; }));
    if (L.tripStart && L.tripFrom) {
      const k = p.uid + dest.kind + L.tripStart;
      if (p.expectedKey !== k) jobs.push(getRoute(L.tripFrom, dest, 'exp' + k).then(r => { p.expected = r; p.expectedKey = k; }));
    } else p.expected = null;
  } else p.route = null;
  await Promise.all(jobs).catch(() => { });
}

/* התראות על שינויים */
function personChanged(p) {
  const v = view(p), st = personStatus(v, settings.alertMin), d = derive(v, settings.alertMin);
  const prev = p.level;
  p.level = st.level;
  if (prev !== undefined) {
    if (st.level === 'bad' && prev !== 'bad') { addNote('⚠️', `${p.name}: ${st.txt}`, p.uid, 'bad'); notify(`⚠ ${p.name} – עיכוב חריג`, st.txt, p.uid); }
    else if (d.roadLong && !p.roadNotified) { p.roadNotified = true; addNote('🚧', `${p.name} עומד/ת זמן רב על כביש – כדאי להתקשר`, p.uid); notify(`${p.name} עומד/ת זמן רב`, 'כדאי להתקשר ולבדוק שהכול בסדר', p.uid); }
    if (d.atDest && p.wasAway && settings.arrivalNotify) { addNote('🏠', `${p.name} ${v.destKind === 'me' ? 'הגיע/ה אליך' : 'הגיע/ה הביתה'}`, p.uid); notify(`${p.name} הגיע/ה ✓`, v.destKind === 'me' ? 'הגיע/ה אליך' : 'הגיע/ה הביתה', p.uid); }
  }
  if (!d.roadLong) p.roadNotified = false;
  p.wasAway = d.kind === 'ok' && !d.atDest && (d.moving || d.startedTrip);
  scheduleRender();
}
let notifId = store.get('nid', 0) || 0;
async function notify(title, body, uid) {
  if (document.visibilityState === 'visible' && !isNative) return;
  try {
    if (isNative) {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      await LocalNotifications.schedule({ notifications: [{ id: (notifId = (notifId % 2e9) + 1, store.set('nid', notifId), notifId), title, body, extra: { uid } }] });
    } else if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, icon: 'icon-192.png' });
  } catch (e) { }
}
function addNote(ic, tx, uid, kind) {
  S.notes.unshift({ ic, tx, uid, kind, t: Date.now(), unread: true });
  S.notes = S.notes.slice(0, 60); store.set('notes', S.notes);
  updateUnread(); if (S.page === 'alerts') renderAlerts();
}
function updateUnread() { const n = S.notes.filter(x => x.unread).length + S.invitesIn.length; const p = $('unread'); p.style.display = n ? 'grid' : 'none'; p.textContent = n; }

let renderQ = false;
function scheduleRender() { if (renderQ) return; renderQ = true; requestAnimationFrame(() => { renderQ = false; refreshLive(); }); }
async function liveTick() {
  await Promise.all([...S.people.values()].map(p => enrich(p).then(() => personChanged(p))));
  if (S.selected) loadTrail(S.selected);
}

/* =========================================================
   ניווט
   ========================================================= */
function go(p) {
  S.page = p; renderBanner();
  document.querySelectorAll('.page').forEach(s => s.classList.toggle('on', s.id === 'p-' + p));
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.p === p));
  if (p === 'groups') { renderGroups(); requestAnimationFrame(() => { gmap.refresh(); S.selected ? fitSelected() : fitGroup(); }); }
  if (p === 'map') { renderMapPage(); requestAnimationFrame(() => { bmap.refresh(); if (!S.bmapFitted) { S.bmapFitted = true; fitAll(); } }); }
  if (p === 'alerts') renderAlerts();
  if (p === 'settings') renderSettings();
}
document.querySelectorAll('#nav button').forEach(b => b.onclick = () => go(b.dataset.p));
function renderAll() { updateUnread(); renderBanner(); go(S.page); }
function refreshLive() {
  updateSub();
  if (S.page === 'groups') { gmap.setPeople(pins(groupPeople()), S.selected); if (S.selected) updateDetailLive(); else renderList(); renderChips(); }
  if (S.page === 'map') { bmap.setPeople(pins(mapPeople()), S.mapSel); renderStrip(); updatePcard(); }
}
function pins(list) {
  return list.map(p => { const v = view(p), st = personStatus(v, settings.alertMin); const L = p.loc;
    return { uid: p.uid, name: p.name, color: p.color, photo: p.photo, lat: L && L.sharing !== false && !p.denied ? L.lat : null, lng: L?.lng, dot: st.dot, alert: st.level === 'bad', label: p.name + (/דק׳$/.test(st.badge) ? ' · ' + st.badge.replace(' דק׳', '′') : '') }; });
}

/* =========================================================
   דף קבוצות
   ========================================================= */
const group = () => S.groups.get(S.activeGroup);
const groupPeople = () => (group()?.members || []).filter(u => u !== me()).map(u => S.people.get(u)).filter(Boolean);
function setGroup(id) { S.activeGroup = id; store.set('activeGroup', id); }

function updateSub() {
  const n = [...S.people.values()].filter(p => p.level === 'bad').length;
  $('sub').textContent = n ? `⚠ ${n} עיכוב חריג` : (isTracking() ? 'המיקום שלך משותף' : 'שיתוף המיקום שלך כבוי');
  $('sub').style.color = n ? 'var(--badInk)' : '';
}
function renderChips() {
  const html = [...S.groups.values()].map(g => `<button class="chip ${g.id === S.activeGroup ? 'on' : ''}" data-g="${esc(g.id)}">${esc(g.emoji || '👥')} ${esc(g.name)}</button>`).join('') + `<button class="chip add" id="addGroup">＋ קבוצה חדשה</button>`;
  if ($('chips')._h === html) return; $('chips')._h = html; $('chips').innerHTML = html;
  $('chips').querySelectorAll('[data-g]').forEach(b => b.onclick = () => { setGroup(b.dataset.g); S.selected = null; S.analysis = null; renderGroups(); fitGroup(); });
  $('addGroup').onclick = openAddGroup;
}
function fitGroup() {
  const pts = groupPeople().filter(p => p.loc?.lat != null && !p.denied).map(p => [p.loc.lat, p.loc.lng]);
  if (S.myPos) pts.push([S.myPos.lat, S.myPos.lng]);
  gmap.setRoute(); gmap.fit(pts, 14);
}
function fitSelected() {
  const p = S.people.get(S.selected); if (!p?.loc) return;
  const pts = [[p.loc.lat, p.loc.lng]]; const d = destFor(p); if (d) pts.push([d.lat, d.lng]);
  (p.trail || []).forEach(t => pts.push(t));
  gmap.fit(pts);
}
function renderGroups() {
  renderChips(); updateSub();
  gmap.setPeople(pins(groupPeople()), S.selected); gmap.setMe(S.myPos);
  if (S.selected && S.people.has(S.selected)) renderDetail(); else { S.selected = null; gmap.setRoute(); renderList(); }
  $('recenter').style.bottom = ($('sheet').offsetHeight + 12) + 'px';
}
function renderList() {
  const g = group();
  if (!g) { $('sheetBody').innerHTML = `<div class="empty">אין לך עדיין קבוצות.</div><button class="dashed" id="ng">＋ יצירת קבוצה</button>`; $('ng').onclick = openAddGroup; return; }
  const people = groupPeople();
  const pend = S.invitesOut.filter(i => i.gid === g.id);
  const html = `<h2 class="sh">${esc(g.emoji || '👥')} ${esc(g.name)} <span class="count">${people.length + 1} אנשים</span><span style="flex:1"></span><button class="iconbtn" id="gSet" title="הגדרות קבוצה">⋯</button></h2>` +
    people.map(p => { const st = personStatus(view(p), settings.alertMin); return `<button class="mem" data-id="${esc(p.uid)}">
      ${avatar(p, '', st.dot)}<div class="info"><div class="nm">${esc(p.name)}</div><div class="st">${esc(st.txt)}</div></div>
      <div class="badge ${st.cls}">${esc(st.badge)}</div></button>`; }).join('') +
    pend.map(i => `<div class="mem" style="opacity:.8">${avatar({ name: i.toName, photo: i.toPhoto })}
      <div class="info"><div class="nm">${esc(i.toName)}</div><div class="st">נשלחה בקשה – ממתין/ה לאישור</div></div>
      <button class="btn btn-g btn-sm" data-cancel="${esc(i.id)}">ביטול</button></div>`).join('') +
    `<div class="mem" style="background:transparent;padding:6px 10px">${avatar({ ...S.profile }, '', isTracking() ? '#16a34a' : '#94a3b8')}<div class="info"><div class="nm">את/ה</div><div class="st">${isTracking() ? 'המיקום שלך משותף עם הקבוצה' : 'שיתוף המיקום שלך כבוי'}</div></div></div>` +
    (people.length || pend.length ? '' : '<div class="empty">אין עדיין אנשים בקבוצה. הוסיפו מישהו מאנשי הקשר 👇</div>') +
    `<button class="dashed" id="addMem">＋ הוספת אדם לקבוצה</button>`;
  if ($('sheetBody')._h === html) return; $('sheetBody')._h = html;
  $('sheetBody').innerHTML = html;
  $('sheetBody').querySelectorAll('.mem[data-id]').forEach(b => b.onclick = () => openMember(b.dataset.id));
  $('sheetBody').querySelectorAll('[data-cancel]').forEach(b => b.onclick = async e => { e.stopPropagation(); await deleteDoc(doc(db, 'invites', b.dataset.cancel)).catch(() => { }); toast('הבקשה בוטלה'); });
  $('addMem').onclick = openAddPeople;
  $('gSet').onclick = openGroupSettings;
}

function openMember(uid) {
  const p = S.people.get(uid); if (!p) return;
  if (!(group()?.members || []).includes(uid)) { const g = [...S.groups.values()].find(g => g.members.includes(uid)); if (g) setGroup(g.id); }
  S.selected = uid; S.analysis = null; p.trail = null;
  if (S.page !== 'groups') go('groups'); else renderGroups();
  loadTrail(uid).then(() => requestAnimationFrame(fitSelected));
  requestAnimationFrame(fitSelected);
}
async function loadTrail(uid) {
  const p = S.people.get(uid); if (!p?.loc || p.denied) return;
  const from = p.loc.tripStart && (Date.now() - p.loc.tripStart < 6 * 3600e3) ? p.loc.tripStart : Date.now() - 2 * 3600e3;
  try {
    const snap = await getDocs(query(collection(db, 'locations', uid, 'trail'), where('ts', '>=', from), orderBy('ts', 'desc'), limit(800)));
    p.trail = snap.docs.reverse().map(d => [d.data().lat, d.data().lng]);
    p.trail.push([p.loc.lat, p.loc.lng]);
  } catch (e) { console.warn('trail', e); p.trail = [[p.loc.lat, p.loc.lng]]; }
  if (S.selected === uid) drawSelectedRoute();
}
function drawSelectedRoute() {
  const p = S.people.get(S.selected); if (!p) return;
  const d = destFor(p);
  gmap.setRoute({ color: p.color, trail: p.trail, ahead: p.route?.coords, dest: d, destLabel: d?.kind === 'me' ? '📍' : '🏠', start: p.trail?.length > 1 ? p.trail[0] : null });
}
function trailDist(t) { let s = 0; for (let i = 1; i < (t?.length || 0); i++) s += haversine({ lat: t[i - 1][0], lng: t[i - 1][1] }, { lat: t[i][0], lng: t[i][1] }); return s; }

function liveHTML(p) {
  const v = view(p), d = derive(v, settings.alertMin), st = personStatus(v, settings.alertMin);
  if (d.kind !== 'ok') return `<div class="eta"><div class="big">${d.kind === 'off' ? 'לא משתף/ת מיקום' : 'אין עדיין מיקום'}</div><div class="sub">${d.kind === 'off' ? 'אי אפשר לראות איפה ' + esc(p.name) + ' כרגע' : 'המיקום יופיע כשהאפליקציה תיפתח אצלו/ה'}</div></div>`;
  const total = (d.remain || 0) + trailDist(p.trail), pct = total ? Math.min(100, trailDist(p.trail) / total * 100) : 0;
  const destTxt = v.destKind === 'me' ? '📍 אליך' : '🏠 הבית';
  let big, sub;
  const stale = d.ageMin > 20 && !d.alert;
  if (stale) { big = '⚠ לא מעודכן'; sub = `העדכון האחרון ${timeAgo(p.loc.ts)}${d.atDest ? (v.destKind === 'me' ? ' – אז היה/תה לידך' : ' – אז היה/תה בבית') : ''}. ייתכן שהאפליקציה נסגרה אצלו/ה.`; }
  else if (d.atDest) { big = v.destKind === 'me' ? 'הגיע/ה אליך ✓' : 'בבית 🏠'; sub = `עדכון אחרון ${timeAgo(p.loc.ts)}`; }
  else if (st.level === 'bad') { big = '⚠ ללא תזוזה'; sub = `${fmtDur(d.stillMin)} באותה נקודה${d.remain != null ? ' · נשארו ' + fmtDist(d.remain) : ''}`; }
  else if (d.etaMin != null && (d.moving || d.startedTrip)) { big = `${d.etaMin} דק׳`; sub = `הגעה משוערת ${clockIn(d.etaMin)} · נשארו ${fmtDist(d.remain)}${d.delayMin > 4 ? ` · איחור של כ-${Math.round(d.delayMin)} דק׳` : ''}`; }
  else if (d.etaMin != null) { big = 'עוד לא בדרך'; sub = `אם יצא/ה עכשיו: הגעה בערך ב-${clockIn(d.etaMin)} (${fmtDist(d.remain)})`; }
  else { big = st.badge; sub = v.dest ? '' : 'אין יעד – הגדירו בית או אפשרו מיקום'; }
  return `<div class="eta ${st.level === 'bad' ? 'alert' : stale ? 'stale' : ''}"><div class="big">${esc(big)}</div><div class="sub">${esc(sub)}</div>
      ${v.dest && !d.atDest && !stale ? `<div class="prog"><i style="width:${pct}%"></i><b style="right:${pct}%"></b></div>
      <div class="prog-l"><span>${p.loc.tripStart && d.startedTrip ? 'יצא/ה ' + clock(p.loc.tripStart) : esc(d.place?.name || '')}</span><span>${destTxt}</span></div>` : ''}
    </div>
    <div class="stats">
      <div class="stat"><div class="v">${d.kmh != null && d.moving ? Math.round(d.kmh) : 0}</div><div class="k">קמ״ש</div></div>
      <div class="stat"><div class="v">${fmtDist(trailDist(p.trail))}</div><div class="k">עבר/ה</div></div>
      <div class="stat"><div class="v">${d.battery != null ? d.battery + '%' : '—'}</div><div class="k">סוללה${d.charging ? ' ⚡' : ''}${d.ageMin > 20 ? ' (ישן)' : ''}</div></div>
    </div>
    <div style="font-size:12px;color:var(--muted);margin:-4px 0 10px">עודכן ${timeAgo(p.loc.ts)}${d.place?.name ? ' · ' + esc(d.place.name) : ''}</div>`;
}
function renderDetail() {
  const p = S.people.get(S.selected); const st = personStatus(view(p), settings.alertMin);
  const mode = S.destMode[p.uid] || (p.loc?.home ? 'home' : 'me');
  $('sheetBody')._h = null;
  $('sheetBody').innerHTML = `
    <button class="back" id="back">→ חזרה לקבוצה</button>
    <div class="dhead">${avatar(p, '', st.dot).replace('class="av ', 'id="dAv" class="av ')}
      <div style="flex:1"><div class="nm">${esc(p.name)}</div><div class="ph">${esc(prettyPhone(p.loc?.phone))}</div></div>
      <div class="badge ${st.cls}" id="dBadge">${esc(st.badge)}</div></div>
    <div class="destseg"><button data-m="home" class="${mode === 'home' ? 'on' : ''}" ${p.loc?.home ? '' : 'disabled style="opacity:.5"'}>🏠 בדרך הביתה</button><button data-m="me" class="${mode === 'me' ? 'on' : ''}">📍 בדרך אליי</button></div>
    <div id="live">${liveHTML(p)}</div>
    <div class="actions">
      <button class="btn btn-w" id="why">🤔 למה מתעכב/ת?</button>
      <button class="btn btn-p" id="call">📞 להתקשר</button>
      <button class="btn btn-s" id="msg">💬 "מתי מגיע/ה?"</button>
    </div>
    <div id="anaWrap"></div>`;
  $('back').onclick = () => { S.selected = null; S.analysis = null; renderGroups(); fitGroup(); };
  $('call').onclick = () => callPerson(p);
  $('msg').onclick = () => askEta(p);
  $('why').onclick = () => runAnalysis(p);
  document.querySelectorAll('.destseg [data-m]').forEach(b => b.onclick = () => {
    if (b.disabled) return; S.destMode[p.uid] = b.dataset.m; store.set('destMode', S.destMode);
    p.route = null; p.expected = null; p.expectedKey = null;
    enrich(p).then(() => { renderDetail(); drawSelectedRoute(); fitSelected(); });
  });
  if (S.analysis?.uid === p.uid) renderAnalysis(false);
  drawSelectedRoute();
}
function updateDetailLive() {
  const p = S.people.get(S.selected); if (!p || !$('live')) return;
  const st = personStatus(view(p), settings.alertMin);
  const html = liveHTML(p); if ($('live')._h !== html) { $('live')._h = html; $('live').innerHTML = html; }
  const b = $('dBadge'); b.className = 'badge ' + st.cls; b.textContent = st.badge;
  const dot = document.querySelector('#dAv .dot'); if (dot) dot.style.background = st.dot;
  drawSelectedRoute();
}
async function runAnalysis(p) {
  S.analysis = { uid: p.uid, ready: false };
  renderAnalysis(true);
  const t0 = Date.now();
  if (p.loc) { p.placeAt = null; await enrich(p); }
  await new Promise(r => setTimeout(r, Math.max(0, 900 - (Date.now() - t0))));
  if (S.analysis?.uid !== p.uid) return;
  S.analysis = { uid: p.uid, ready: true, at: clock(Date.now()), data: analyze(view(p), settings.alertMin) };
  renderAnalysis(true); personChanged(p);
}
function renderAnalysis(animate) {
  const wrap = $('anaWrap'); if (!wrap || !S.analysis) return;
  const p = S.people.get(S.analysis.uid);
  if (!S.analysis.ready) { wrap.innerHTML = `<div class="ana ${animate ? 'enter' : ''}"><div class="thinking"><div class="spin"></div>בודק מיקום, מהירות, זמן עצירה וסוג המקום…</div></div>`; return; }
  const a = S.analysis.data;
  const col = { ok: '#16a34a', info: '#64748b', warn: '#f59e0b', alert: '#dc2626' }[a.sev];
  wrap.innerHTML = `<div class="ana ${animate ? 'enter' : ''}" style="border-color:${col}66">
    <h3 style="color:${col}">${esc(a.title)}</h3><p class="lead">${esc(a.lead)}</p>
    <div class="facts">${a.facts.map(f => `<span class="fact">${esc(f)}</span>`).join('')}</div>
    ${a.hyp.length ? '<div style="font-size:13px;font-weight:700;margin-bottom:8px">השערות לפי הנתונים:</div>' : ''}
    ${a.hyp.map((h, i) => `<div class="hyp"><div class="row"><span>${esc(h.l)}</span><span>${h.p}%</span></div>
      <div class="meter"><i style="width:${h.p}%;background:${i === 0 ? col : '#94a3b8'}"></i></div><div class="why">${esc(h.why)}</div></div>`).join('')}
    ${a.sev === 'alert' ? `<div class="alertbox"><h4>🚨 לפנות לעזרה?</h4>
      <p>מומלץ לנסות להתקשר שוב, ואם אין מענה – לפנות לגורמי חירום עם המיקום המדויק.</p>
      <div class="actions"><button class="btn btn-p" id="retry">📞 לנסות שוב</button><button class="btn btn-d" id="police">🚓 משטרה 100</button>
        <button class="btn btn-d" id="mda" style="background:#b91c1c">🚑 מד״א 101</button><button class="btn btn-g" id="fine">הכול בסדר</button></div></div>` : ''}
    ${a.suggestCall ? `<button class="btn btn-p" style="width:100%;margin-top:8px" id="retry">📞 להתקשר ל${esc(p.name)}</button>` : ''}
    <div class="anaFoot"><span>נבדק ב-${S.analysis.at}</span><button class="btn btn-g btn-sm" id="reana">↻ בדיקה מחדש</button></div></div>`;
  $('reana').onclick = () => runAnalysis(p);
  if ($('retry')) $('retry').onclick = () => callPerson(p);
  if (a.sev === 'alert') {
    $('police').onclick = () => emergency('משטרה', '100', p);
    $('mda').onclick = () => emergency('מד״א', '101', p);
    $('fine').onclick = () => { delete S.noAnswer[p.uid]; store.set('noAnswer', S.noAnswer); S.analysis = null; renderDetail(); personChanged(p); toast('סומן כתקין ✓'); };
  }
}
$('recenter').onclick = () => { S.selected = null; S.analysis = null; renderGroups(); fitGroup(); };

/* שיחות */
let pendingCall = null;
function callPerson(p) {
  const ph = p.loc?.phone; if (!ph) return toast('אין מספר טלפון');
  pendingCall = { uid: p.uid, t: Date.now() };
  openExt(telHref(ph));
}
function onResume() {
  if (S.started && !isTracking() && !store.get('noAutoTrack', false) && S.priv?.sharing !== false) beginTracking();
  if (isNative && S.started) checkBattery(false, true);
  if (!pendingCall || Date.now() - pendingCall.t > 30 * 60000 || Date.now() - pendingCall.t < 1500) return;
  const p = S.people.get(pendingCall.uid); pendingCall = null; if (!p) return;
  modal(`<div class="callscreen">${avatar(p)}<h3>${esc(p.name)} ענה/תה?</h3><p>זה עוזר לאפליקציה להבין אם משהו לא בסדר.</p>
    <div class="actions"><button class="btn btn-p" id="ansY">כן, הכול טוב</button><button class="btn btn-d" id="ansN">לא ענה/תה</button></div></div>`);
  $('ansY').onclick = () => { delete S.noAnswer[p.uid]; store.set('noAnswer', S.noAnswer); closeModal(); personChanged(p); if (S.analysis?.uid === p.uid) runAnalysis(p); };
  $('ansN').onclick = () => { S.noAnswer[p.uid] = { n: (S.noAnswer[p.uid]?.n || 0) + 1, t: Date.now() }; store.set('noAnswer', S.noAnswer); closeModal(); personChanged(p); if (S.selected === p.uid) runAnalysis(p); };
}
function askEta(p) {
  const ph = p.loc?.phone; if (!ph) return toast('אין מספר טלפון');
  const msg = 'היי, מתי את/ה מגיע/ה? 🙂';
  modal(`<h3>לשאול את ${esc(p.name)}</h3><div class="invite">${esc(msg)}</div>
    <div class="actions"><button class="btn btn-p" id="viaWa">וואטסאפ</button><button class="btn btn-s" id="viaSms">SMS</button></div>
    <button class="btn btn-g" style="width:100%;margin-top:8px" data-close="1">ביטול</button>`);
  $('viaWa').onclick = () => { closeModal(); openExt(`https://wa.me/${ph}?text=${encodeURIComponent(msg)}`); };
  $('viaSms').onclick = () => { closeModal(); openExt(`sms:${telHref(ph).slice(4)}?body=${encodeURIComponent(msg)}`); };
}
function emergency(org, num, p) {
  const L = p.loc, d = derive(view(p), settings.alertMin);
  modal(`<div class="callscreen"><h3>חיוג ל${org}</h3><div class="num">${num}</div><p>פרטים להקראה למוקדן:</p>
    <div class="note" style="text-align:right;user-select:text">👤 ${esc(p.name)}, ${esc(prettyPhone(L.phone))}<br>📍 ${esc(d.place?.name || '')}${d.place?.area ? ', ' + esc(d.place.area) : ''}<br>🌐 נ.צ. ${L.lat.toFixed(5)}, ${L.lng.toFixed(5)}<br>⏱ ללא תזוזה ${fmtDur(d.stillMin)}${S.noAnswer[p.uid] ? ', לא עונה לטלפון' : ''}<br>🔋 סוללה ${L.battery ?? '?'}%</div>
    <div class="actions"><button class="btn btn-g" data-close="1">ביטול</button><button class="btn btn-d" id="dial">📞 חייג ${num}</button></div></div>`);
  $('dial').onclick = () => { closeModal(); openExt('tel:' + num); };
}

/* =========================================================
   קבוצות: יצירה, הגדרות
   ========================================================= */
function openAddGroup() {
  modal(`<h3>קבוצה חדשה</h3><p>תנו שם לקבוצה ובחרו סמל. אחר כך תוכלו להוסיף אליה אנשים.</p>
    <label class="field"><span>שם הקבוצה</span><input id="gName" maxlength="40" placeholder="למשל: חברים מהעבודה"></label>
    <label class="field"><span>סמל</span><select id="gEmoji"><option>👥</option><option>🏠</option><option>🎉</option><option>💼</option><option>⚽</option><option>🎓</option><option>❤️</option></select></label>
    <div class="actions"><button class="btn btn-g" data-close="1">ביטול</button><button class="btn btn-p" id="gSave">יצירה</button></div>`);
  $('gName').focus();
  $('gSave').onclick = async () => {
    const n = $('gName').value.trim(); if (!n) return $('gName').focus();
    $('gSave').disabled = true;
    try { const r = await addDoc(collection(db, 'groups'), { name: n, emoji: $('gEmoji').value, owner: me(), members: [me()], createdAt: serverTimestamp() }); setGroup(r.id); S.selected = null; closeModal(); toast(`הקבוצה "${n}" נוצרה`); }
    catch (e) { toast('היצירה נכשלה'); $('gSave').disabled = false; }
  };
}
function openGroupSettings() {
  const g = group(); if (!g) return; const owner = g.owner === me();
  modal(`<h3>${esc(g.emoji || '👥')} ${esc(g.name)}</h3>
    <label class="field"><span>שם הקבוצה</span><input id="grName" maxlength="40" value="${esc(g.name)}"></label>
    <div class="mscroll">${g.members.map(u => { const p = u === me() ? { ...S.profile, name: (S.profile?.name || '') + ' (את/ה)' } : S.people.get(u) || { name: '...' };
      return `<div class="crow">${avatar(p)}<div class="info"><div class="nm">${esc(p.name)}</div>${u === g.owner ? '<span class="tag tag-y">מנהל/ת</span>' : ''}</div>
      ${owner && u !== me() ? `<button class="btn btn-g btn-sm" data-rm="${esc(u)}">הסרה</button>` : ''}</div>`; }).join('')}</div>
    <div class="actions" style="margin-top:12px"><button class="btn btn-p" id="grSave">שמירה</button><button class="btn btn-g" data-close="1">סגירה</button>
      <button class="btn btn-d" id="grLeave" style="grid-column:1/-1">${owner && g.members.length === 1 ? 'מחיקת הקבוצה' : 'יציאה מהקבוצה'}</button></div>`);
  $('grSave').onclick = async () => { const n = $('grName').value.trim(); if (!n) return; await updateDoc(doc(db, 'groups', g.id), { name: n }).catch(() => toast('השמירה נכשלה')); closeModal(); };
  document.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => { await updateDoc(doc(db, 'groups', g.id), { members: arrayRemove(b.dataset.rm) }).catch(() => toast('ההסרה נכשלה')); closeModal(); toast('הוסר/ה מהקבוצה'); });
  $('grLeave').onclick = async () => {
    try {
      if (owner && g.members.length === 1) await deleteDoc(doc(db, 'groups', g.id));
      else if (owner) { const next = g.members.find(u => u !== me()); await updateDoc(doc(db, 'groups', g.id), { members: arrayRemove(me()), owner: next }); }
      else await updateDoc(doc(db, 'groups', g.id), { members: arrayRemove(me()) });
      closeModal(); toast('יצאת מהקבוצה');
    } catch (e) { toast('הפעולה נכשלה'); }
  };
}

/* =========================================================
   הוספת אנשים
   ========================================================= */
let addTab = 'contacts', contactList = null;
const phoneUid = new Map();
async function lookupPhones(phones) {
  const todo = phones.filter(p => !phoneUid.has(p));
  for (let i = 0; i < todo.length; i += 10) {
    await Promise.all(todo.slice(i, i + 10).map(async ph => {
      try { const s = await getDoc(doc(db, 'phones', ph)); phoneUid.set(ph, s.exists() ? s.data().uid : null); } catch (e) { phoneUid.set(ph, null); }
    }));
  }
}
const inGroupOrPending = uid => group()?.members.includes(uid) || S.invitesOut.some(i => i.gid === S.activeGroup && i.to === uid);

async function loadContacts() {
  let raw = [];
  if (isNative) {
    const { Contacts } = await import('@capacitor-community/contacts');
    const perm = await Contacts.requestPermissions();
    if (perm.contacts !== 'granted') throw new Error('denied');
    const r = await Contacts.getContacts({ projection: { name: true, phones: true } });
    r.contacts.forEach(c => (c.phones || []).forEach(ph => raw.push({ name: c.name?.display || ph.number, phone: normPhone(ph.number) })));
  } else if ('contacts' in navigator && 'select' in navigator.contacts) {
    const r = await navigator.contacts.select(['name', 'tel'], { multiple: true });
    r.forEach(c => (c.tel || []).forEach(t => raw.push({ name: (c.name || [])[0] || t, phone: normPhone(t) })));
  } else throw new Error('unsupported');
  const seen = new Set(), list = [];
  for (const c of raw) if (c.phone && c.phone !== S.priv?.phone && !seen.has(c.phone)) { seen.add(c.phone); list.push(c); }
  list.sort((a, b) => a.name.localeCompare(b.name, 'he'));
  await lookupPhones(list.map(c => c.phone));
  return list;
}

function openAddPeople() { addTab = 'contacts'; renderAddPeople(); }
async function renderAddPeople(q = '') {
  const g = group(); if (!g) return;
  const tabs = `<div class="tabs"><button data-t="contacts" class="${addTab === 'contacts' ? 'on' : ''}">📇 מאנשי הקשר</button><button data-t="search" class="${addTab === 'search' ? 'on' : ''}">🔎 לפי מספר או קוד</button></div>`;
  const foot = `<button class="btn btn-g" style="width:100%;margin-top:10px" data-close="1">סגירה</button>
    <div class="note" style="margin:10px 0 0">🔒 המיקום של אדם יופיע רק אחרי שהוא יאשר את הבקשה, ואז גם הוא יראה את המיקום שלך.</div>`;
  let body = '';
  if (addTab === 'contacts') {
    if (!contactList) {
      const canWeb = !isNative && 'contacts' in navigator && 'select' in navigator.contacts;
      body = (isNative || canWeb) ? `<div style="text-align:center;padding:12px 4px"><div style="font-size:44px">📇</div>
        <p style="margin:8px 0 14px">נבדוק מי מאנשי הקשר שלך כבר משתמש ב"מיקומך". המספרים נבדקים מול רשימת המשתמשים ולא נשמרים.</p>
        <button class="btn btn-p" style="width:100%" id="allowC">${isNative ? 'אפשר גישה לאנשי הקשר' : 'בחירת אנשי קשר'}</button></div>`
        : `<div class="empty">הדפדפן הזה לא מאפשר גישה לאנשי הקשר. אפשר להוסיף לפי מספר טלפון או קוד בלשונית השנייה, או להוריד את אפליקציית האנדרואיד.</div>`;
    } else {
      const qq = q.trim(), qd = qq.replace(/\D/g, '');
      const list = contactList.filter(c => !qq || c.name.includes(qq) || (qd && c.phone.includes(qd)))
        .sort((a, b) => (!!phoneUid.get(b.phone)) - (!!phoneUid.get(a.phone)));
      body = `<input class="search" id="q" placeholder="חיפוש באנשי הקשר" value="${esc(q)}" style="margin-bottom:8px">
        <div class="mscroll">${list.slice(0, 300).map((c, i) => { const uid = phoneUid.get(c.phone); const already = uid && (inGroupOrPending(uid) || uid === me());
          return `<div class="crow">${avatar({ name: c.name, color: uid ? COLORS[i % COLORS.length] : '#94a3b8' })}
            <div class="info"><div class="nm">${esc(c.name)}</div><div class="ph">${esc(prettyPhone(c.phone))}</div>
            <span class="tag ${uid ? 'tag-y' : 'tag-n'}">${uid ? '✓ יש מיקומך' : 'אין את האפליקציה'}</span></div>
            ${already ? '<span class="badge b-idle">כבר בקבוצה</span>' : uid ? `<button class="btn btn-p btn-sm" data-add="${esc(uid)}" data-name="${esc(c.name)}">הוספה</button>`
              : `<button class="btn btn-s btn-sm" data-inv="${esc(c.phone)}" data-name="${esc(c.name)}">הזמנה</button>`}</div>`; }).join('') || '<div class="empty">לא נמצאו אנשי קשר</div>'}</div>`;
    }
  } else {
    body = `<input class="search" id="q" placeholder="מספר טלפון או קוד משתמש (6 תווים)" value="${esc(q)}" style="margin-bottom:8px;direction:ltr;text-align:right">
      <button class="btn btn-p" style="width:100%" id="doSearch">חיפוש</button><div id="sres" style="margin-top:10px"></div>
      <div class="empty">את הקוד של כל משתמש אפשר למצוא אצלו בהגדרות. הקוד שלך: <b class="codebox" style="font-size:15px">${esc(S.profile?.code || '')}</b></div>`;
  }
  modal(`<h3>הוספה ל${esc(g.name)}</h3>${tabs}${body}${foot}`);
  document.querySelectorAll('.tabs [data-t]').forEach(b => b.onclick = () => { addTab = b.dataset.t; renderAddPeople(); });
  if ($('allowC')) $('allowC').onclick = async () => {
    $('allowC').disabled = true; $('allowC').textContent = 'טוען אנשי קשר…';
    try { contactList = await loadContacts(); renderAddPeople(); }
    catch (e) { $('allowC').disabled = false; $('allowC').textContent = isNative ? 'אפשר גישה לאנשי הקשר' : 'בחירת אנשי קשר'; toast(e.message === 'denied' ? 'לא ניתנה גישה לאנשי הקשר' : 'לא הצלחתי לקרוא את אנשי הקשר'); }
  };
  const qi = $('q');
  if (qi && addTab === 'contacts') qi.oninput = () => { const v = qi.value, pos = qi.selectionStart; renderAddPeople(v).then(() => { const n = $('q'); n.focus(); n.setSelectionRange(pos, pos); }); };
  if ($('doSearch')) { $('doSearch').onclick = () => doSearch($('q').value); qi.onkeydown = e => { if (e.key === 'Enter') doSearch(qi.value); }; }
  bindAddButtons();
}
function bindAddButtons() {
  document.querySelectorAll('[data-add]').forEach(b => b.onclick = () => sendInvite(b.dataset.add, b.dataset.name, b));
  document.querySelectorAll('[data-inv]').forEach(b => b.onclick = () => showInviteMsg(b.dataset.name, b.dataset.inv));
}
async function doSearch(v) {
  const out = $('sres'); v = v.trim(); if (!v) return;
  out.innerHTML = '<div class="thinking"><div class="spin"></div>מחפש…</div>';
  let uid = null, phone = null;
  try {
    if (/^[A-Za-z0-9]{6}$/.test(v) && /[A-Za-z]/.test(v)) { const s = await getDoc(doc(db, 'codes', v.toUpperCase())); uid = s.exists() ? s.data().uid : null; }
    else { phone = normPhone(v); if (!phone) { out.innerHTML = '<div class="empty">צריך מספר טלפון מלא או קוד בן 6 תווים</div>'; return; } await lookupPhones([phone]); uid = phoneUid.get(phone); }
    if (!uid) { out.innerHTML = `<div class="empty">לא נמצא משתמש.${phone ? '' : ' בדקו שהקוד נכון.'}</div>${phone ? `<button class="btn btn-s" style="width:100%" data-inv="${esc(phone)}" data-name="${esc(prettyPhone(phone))}">שליחת הזמנה להוריד את האפליקציה</button>` : ''}`; bindAddButtons(); return; }
    if (uid === me()) { out.innerHTML = '<div class="empty">זה את/ה 🙂</div>'; return; }
    const u = (await getDoc(doc(db, 'users', uid))).data() || {};
    out.innerHTML = `<div class="crow">${avatar(u)}<div class="info"><div class="nm">${esc(u.name)}</div><div class="ph">משתמש/ת במיקומך</div></div>
      ${inGroupOrPending(uid) ? '<span class="badge b-idle">כבר בקבוצה</span>' : `<button class="btn btn-p btn-sm" data-add="${esc(uid)}" data-name="${esc(u.name)}">הוספה</button>`}</div>`;
    bindAddButtons();
  } catch (e) { out.innerHTML = '<div class="empty">החיפוש נכשל, נסו שוב</div>'; }
}
async function sendInvite(toUid, toName, btn) {
  const g = group(); if (!g) return;
  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  try {
    const u = (await getDoc(doc(db, 'users', toUid))).data() || {};
    await setDoc(doc(db, 'invites', g.id + '_' + toUid), {
      gid: g.id, groupName: g.name, groupEmoji: g.emoji || '👥', from: me(), fromName: S.profile?.name || '', fromPhoto: S.profile?.photo || null,
      to: toUid, toName: String(u.name || toName || '').slice(0, 40), toPhoto: u.photo || null, createdAt: serverTimestamp()
    });
    toast(`נשלחה בקשה ל${u.name || toName}`);
    if (btn) { btn.outerHTML = '<span class="badge b-idle">נשלח ✓</span>'; }
  } catch (e) { console.error(e); toast('השליחה נכשלה'); if (btn) { btn.disabled = false; btn.textContent = 'הוספה'; } }
}
function showInviteMsg(name, phone) {
  const msg = `היי ${name}! אני משתמש/ת ב"מיקומך" – אפליקציה שמראה למשפחה ולחברים איפה כל אחד בדרך הביתה (רק באישור שלך). רוצה להצטרף? הורדה כאן: ${SITE_URL}`;
  modal(`<h3>ל${esc(name)} אין את האפליקציה</h3>
    <p>${esc(prettyPhone(phone))} עדיין לא רשום/ה ב"מיקומך". שלחו הזמנה עם קישור להורדה – אחרי שיתקין/תתקין, אפשר יהיה להוסיף אותו/ה.</p>
    <div class="invite">${esc(msg)}</div>
    <div class="actions"><button class="btn btn-p" id="invWa">וואטסאפ</button><button class="btn btn-s" id="invSms">SMS</button>
      <button class="btn btn-g" id="invCopy">📋 העתקה</button><button class="btn btn-g" id="invBack">חזרה</button></div>`);
  $('invWa').onclick = () => openExt(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`);
  $('invSms').onclick = () => openExt(`sms:${telHref(phone).slice(4)}?body=${encodeURIComponent(msg)}`);
  $('invCopy').onclick = async () => { try { await navigator.clipboard.writeText(msg); toast('ההודעה הועתקה'); } catch (e) { toast('לא הצלחתי להעתיק'); } };
  $('invBack').onclick = () => renderAddPeople();
}

/* הזמנות שקיבלתי */
async function acceptInvite(i) {
  try { await updateDoc(doc(db, 'groups', i.gid), { members: arrayUnion(me()) }); await deleteDoc(doc(db, 'invites', i.id)); setGroup(i.gid); toast(`הצטרפת ל${i.groupName} ✓`); }
  catch (e) { console.error(e); toast('ההצטרפות נכשלה'); }
}
async function declineInvite(i) { await deleteDoc(doc(db, 'invites', i.id)).catch(() => { }); toast('ההזמנה נדחתה'); }
function renderBanner() {
  const i = S.invitesIn[0], b = $('banner');
  if (!i || S.page !== 'groups') { b.classList.remove('on'); return; }
  b.innerHTML = `${avatar({ name: i.fromName, photo: i.fromPhoto, color: '#2563eb' })}<div class="tx"><b>${esc(i.fromName)}</b> מזמין/ה אותך ל${esc(i.groupEmoji)} ${esc(i.groupName)}</div>
    <button class="btn btn-p btn-sm" id="bnY">אישור</button><button class="btn btn-g btn-sm" id="bnN">✕</button>`;
  b.classList.add('on');
  $('bnY').onclick = () => confirmInvite(i);
  $('bnN').onclick = () => declineInvite(i);
}
function confirmInvite(i) {
  modal(`<div class="callscreen">${avatar({ name: i.fromName, photo: i.fromPhoto, color: '#2563eb' })}<h3>הצטרפות ל${esc(i.groupEmoji)} ${esc(i.groupName)}</h3>
    <p><b>${esc(i.fromName)}</b> מזמין/ה אותך. אחרי האישור, האנשים בקבוצה יראו את המיקום שלך ואת/ה תראה/י את שלהם. אפשר לצאת מהקבוצה בכל רגע.</p>
    <div class="actions"><button class="btn btn-p" id="ciY">אישור והצטרפות</button><button class="btn btn-g" id="ciN">דחייה</button></div></div>`);
  $('ciY').onclick = () => { closeModal(); acceptInvite(i); };
  $('ciN').onclick = () => { closeModal(); declineInvite(i); };
}

/* =========================================================
   דף מפה גדולה
   ========================================================= */
const mapPeople = () => (S.mapFilter === 'all' ? [...S.people.values()] : (S.groups.get(S.mapFilter)?.members || []).filter(u => u !== me()).map(u => S.people.get(u)).filter(Boolean));
function fitAll() {
  const pts = mapPeople().filter(p => p.loc?.lat != null && !p.denied).map(p => [p.loc.lat, p.loc.lng]);
  if (S.myPos) pts.push([S.myPos.lat, S.myPos.lng]);
  bmap.fit(pts, 14);
}
function renderMapPage() {
  $('mapFilter').innerHTML = [{ id: 'all', name: 'כולם', emoji: '🌍' }, ...S.groups.values()].map(g => `<button class="chip ${g.id === S.mapFilter ? 'on' : ''}" data-f="${esc(g.id)}">${esc(g.emoji || '👥')} ${esc(g.name)}</button>`).join('');
  $('mapFilter').querySelectorAll('[data-f]').forEach(b => b.onclick = () => { S.mapFilter = b.dataset.f; S.mapSel = null; renderMapPage(); fitAll(); });
  renderStrip(); updatePcard();
  bmap.setPeople(pins(mapPeople()), S.mapSel); bmap.setMe(S.myPos);
}
function renderStrip() {
  const html = (S.myPos ? `<button data-me="1"><div class="av" style="background:#2563eb">📍</div><span>אני</span><small>${isTracking() ? 'משותף' : 'כבוי'}</small></button>` : '') +
    mapPeople().map(p => { const st = personStatus(view(p), settings.alertMin); return `<button data-id="${esc(p.uid)}" class="${p.uid === S.mapSel ? 'on' : ''}">${avatar(p, '', st.dot)}<span>${esc(p.name)}</span><small>${esc(st.badge)}</small></button>`; }).join('');
  if ($('strip')._h === html) return; $('strip')._h = html; $('strip').innerHTML = html;
  $('strip').querySelectorAll('[data-id]').forEach(b => b.onclick = () => selectOnMap(b.dataset.id));
  const mb = $('strip').querySelector('[data-me]'); if (mb) mb.onclick = () => { S.mapSel = null; renderMapPage(); bmap.flyTo([S.myPos.lat, S.myPos.lng], 16); };
}
function updatePcard() {
  const pc = $('pcard'), p = S.people.get(S.mapSel);
  if (!p) { pc.classList.remove('on'); pc._h = null; return; }
  const st = personStatus(view(p), settings.alertMin);
  const html = `<div class="row">${avatar(p, '', st.dot)}<div style="flex:1;min-width:0"><div class="nm">${esc(p.name)}</div><div class="st">${esc(st.txt)}</div></div><div class="badge ${st.cls}">${esc(st.badge)}</div></div>
    <div class="actions" style="margin-top:10px"><button class="btn btn-p btn-sm" id="pcDetails">פרטים ולמה מתעכב</button><button class="btn btn-s btn-sm" id="pcCall">📞 להתקשר</button></div>`;
  if (pc._h !== html) { pc._h = html; pc.innerHTML = html; $('pcDetails').onclick = () => openMember(p.uid); $('pcCall').onclick = () => callPerson(p); }
  pc.classList.add('on');
}
function selectOnMap(uid) {
  S.mapSel = uid; renderMapPage();
  const p = S.people.get(uid);
  if (p?.loc?.lat != null && !p.denied) requestAnimationFrame(() => bmap.flyTo([p.loc.lat, p.loc.lng], 16));
  else toast(`אין מיקום זמין ל${p?.name || ''}`);
}
$('zin').onclick = () => bmap.zoomIn();
$('zout').onclick = () => bmap.zoomOut();
$('zall').onclick = () => { S.mapSel = null; renderMapPage(); fitAll(); };

/* =========================================================
   התראות
   ========================================================= */
function renderAlerts() {
  renderBanner();
  $('alertsBody').innerHTML = `<h1>התראות</h1>
    ${S.invitesIn.length ? `<div class="sec-t">הזמנות לקבוצות</div><div class="sec">${S.invitesIn.map((i, k) => `<div class="note-row">${avatar({ name: i.fromName, photo: i.fromPhoto, color: '#2563eb' })}
      <div class="tx"><b>${esc(i.fromName)}</b> מזמין/ה אותך ל${esc(i.groupEmoji)} ${esc(i.groupName)}<div style="display:flex;gap:6px;margin-top:6px"><button class="btn btn-p btn-sm" data-acc="${esc(k)}">אישור</button><button class="btn btn-g btn-sm" data-dec="${esc(k)}">דחייה</button></div></div></div>`).join('')}</div>` : ''}
    <div class="sec">${S.notes.map((n, i) => `<div class="note-row ${n.unread ? 'unread' : ''}" data-i="${esc(i)}" style="cursor:pointer">
      <div class="note-ic" style="${n.kind === 'bad' ? 'background:var(--badBg)' : ''}">${n.ic}</div><div class="tx">${esc(n.tx)}<div class="tm">${timeAgo(n.t)}</div></div></div>`).join('') || '<div class="empty" style="padding:14px 0">אין התראות עדיין</div>'}</div>
    <p style="font-size:12px;color:var(--muted);padding:0 4px">התראה על עיכוב חריג נשלחת כשמישהו עומד יותר מ-${settings.alertMin} דק׳ על כביש ולא עונה לטלפון. אפשר לשנות בהגדרות.</p>`;
  document.querySelectorAll('[data-acc]').forEach(b => b.onclick = () => confirmInvite(S.invitesIn[+b.dataset.acc]));
  document.querySelectorAll('[data-dec]').forEach(b => b.onclick = () => declineInvite(S.invitesIn[+b.dataset.dec]));
  document.querySelectorAll('[data-i]').forEach(r => r.onclick = () => { const n = S.notes[+r.dataset.i]; if (n.uid && S.people.has(n.uid)) openMember(n.uid); });
  setTimeout(() => { S.notes.forEach(n => n.unread = false); store.set('notes', S.notes); updateUnread(); }, 2000);
}

/* =========================================================
   הגדרות
   ========================================================= */
function renderSettings() {
  const P = S.profile || {}, priv = S.priv || {};
  const sharing = priv.sharing !== false && isTracking();
  $('settingsBody').innerHTML = `<h1>הגדרות</h1>
    <div class="sec"><div class="srow">${avatar(P, '', sharing ? '#16a34a' : '#94a3b8')}<div class="lbl"><b>${esc(P.name)}</b><small style="direction:ltr;text-align:right">${esc(prettyPhone(priv.phone))}</small></div><button class="btn btn-g btn-sm" id="editProf">עריכה</button></div>
      <div class="srow"><div class="lbl">הקוד שלי<small>חברים יכולים להוסיף אותך גם לפי הקוד</small></div><span class="codebox">${esc(P.code || '')}</span><button class="iconbtn" id="copyCode">📋</button></div></div>
    <div class="sec-t">שיתוף מיקום</div>
    <div class="sec">
      <div class="srow"><div class="lbl">שיתוף המיקום שלי<small>${sharing ? 'הקבוצות שלך רואות איפה את/ה' : 'המיקום שלך מוסתר מכולם'}</small></div><button class="tog ${sharing ? 'on' : ''}" id="tShare"></button></div>
      <div class="srow"><div class="lbl">הבית שלי<small>${priv.home ? esc(priv.home.label || 'מוגדר') : 'לא מוגדר – בלי בית אי אפשר לחשב "בדרך הביתה"'}</small></div><button class="btn btn-s btn-sm" id="setHome">${priv.home ? 'שינוי' : 'הגדרה'}</button></div>
      ${S.trackErr ? `<div class="srow"><div class="lbl" style="color:var(--badInk)">בעיה בשליחת המיקום<small>${esc(S.trackErr)}</small></div></div>` : ''}
      ${isNative ? `<div class="srow"><div class="lbl">פועל ברקע<small>${S.battIgnoring ? '✓ האפליקציה לא תיעצר ע״י חיסכון בסוללה' : '⚠ חיסכון בסוללה עלול לעצור את שיתוף המיקום'}</small></div>${S.battIgnoring ? '' : '<button class="btn btn-p btn-sm" id="battFix">תיקון</button>'}</div>
      <div class="srow"><div class="lbl">הרשאות מיקום<small>מומלץ: מיקום ← "לאפשר כל הזמן"</small></div><button class="btn btn-g btn-sm" id="openSet">הגדרות</button></div>` : ''}
    </div>
    <div class="sec-t">תצוגה</div>
    <div class="sec"><div class="srow"><div class="lbl">ערכת צבעים<small>אוטומטי = לפי הטלפון</small></div>
      <div class="seg" id="themeSeg">${[['light', 'בהיר'], ['dark', 'כהה'], ['auto', 'אוטומטי']].map(([k, l]) => `<button data-v="${esc(k)}" class="${settings.theme === k ? 'on' : ''}">${l}</button>`).join('')}</div></div></div>
    <div class="sec-t">התראות</div>
    <div class="sec">
      <div class="srow"><div class="lbl">התראת עיכוב חריג<small>כשמישהו עומד על כביש יותר מ-</small></div>
        <select id="sAlert" class="search" style="width:auto;padding:8px 10px;font-size:14px">${[10, 15, 20, 30, 45].map(v => `<option value="${v}" ${settings.alertMin === v ? 'selected' : ''}>${v} דק׳</option>`).join('')}</select></div>
      <div class="srow"><div class="lbl">הודעה כשמישהו מגיע</div><button class="tog ${settings.arrivalNotify ? 'on' : ''}" id="tArr"></button></div>
      ${!isNative && 'Notification' in window && Notification.permission !== 'granted' ? `<div class="srow"><div class="lbl">התראות בדפדפן</div><button class="btn btn-s btn-sm" id="webNotif">הפעלה</button></div>` : ''}
    </div>
    <div class="sec-t">אודות</div>
    <div class="sec">
      <div class="srow"><div class="lbl">מיקומך · גרסה ${esc(BUILD.name)}<small>${isNative ? 'אפליקציית אנדרואיד' : 'גרסת אתר'}</small></div><button class="btn btn-g btn-sm" id="chkUpd">${isNative ? 'בדיקת עדכון' : 'הורדת האפליקציה'}</button></div>
      <div class="srow"><div class="lbl">התנתקות</div><button class="btn btn-g btn-sm" id="logout">התנתקות</button></div>
    </div>`;
  $('editProf').onclick = () => showProfile();
  $('copyCode').onclick = async () => { try { await navigator.clipboard.writeText(P.code); toast('הקוד הועתק'); } catch (e) { toast(P.code); } };
  $('tShare').onclick = toggleSharing;
  $('setHome').onclick = openHome;
  if ($('openSet')) $('openSet').onclick = () => openLocationSettings();
  if ($('battFix')) $('battFix').onclick = () => checkBattery(true);
  document.querySelectorAll('#themeSeg button').forEach(b => b.onclick = () => { settings.theme = b.dataset.v; saveSettings(); applyTheme(); renderSettings(); });
  $('sAlert').onchange = e => { settings.alertMin = +e.target.value; saveSettings(); toast('נשמר'); };
  $('tArr').onclick = () => { settings.arrivalNotify = !settings.arrivalNotify; saveSettings(); renderSettings(); };
  if ($('webNotif')) $('webNotif').onclick = async () => { await Notification.requestPermission(); renderSettings(); };
  $('chkUpd').onclick = () => isNative ? checkUpdate(true) : openExt(SITE_URL);
  $('logout').onclick = async () => { stopAll(); await logout(); };
}
async function toggleSharing() {
  const on = !(S.priv?.sharing !== false && isTracking());
  try {
    if (on) { store.set('noAutoTrack', false); await updateDoc(doc(db, 'locations', me()), { sharing: true }); S.priv.sharing = true; await syncViewers(); await beginTracking(); toast('שיתוף המיקום הופעל'); }
    else { store.set('noAutoTrack', true); await stopTracking(); await updateDoc(doc(db, 'locations', me()), { sharing: false, viewers: [] }); S.priv.sharing = false; S.priv.viewers = []; toast('שיתוף המיקום הופסק'); }
  } catch (e) { toast('הפעולה נכשלה'); }
  renderSettings();
}
function openHome() {
  modal(`<h3>הבית שלי</h3><p>הבית משמש לחישוב "כמה זמן עד שמגיע/ה הביתה". רק האנשים בקבוצות שלך רואים אותו.</p>
    <button class="btn btn-p" style="width:100%;margin-bottom:10px" id="hHere">📍 אני בבית עכשיו – להשתמש במיקום הנוכחי</button>
    <label class="field"><span>או חיפוש כתובת</span><input id="hQ" placeholder="רחוב, מספר, עיר"></label>
    <div id="hRes"></div>
    <div class="actions" style="margin-top:8px">${S.priv?.home ? '<button class="btn btn-g" id="hDel">מחיקת הבית</button>' : ''}<button class="btn btn-g" data-close="1" ${S.priv?.home ? '' : 'style="grid-column:1/-1"'}>סגירה</button></div>`);
  const save = async (h) => { try { await updateDoc(doc(db, 'locations', me()), { home: h }); closeModal(); toast('הבית נשמר ✓'); } catch (e) { toast('השמירה נכשלה'); } };
  $('hHere').onclick = () => {
    const use = p => placeAt(p).then(pl => save({ lat: p.lat, lng: p.lng, label: pl?.name || 'המיקום הנוכחי' }));
    if (S.myPos) return use(S.myPos);
    if (!navigator.geolocation) return toast('אין גישה למיקום');
    navigator.geolocation.getCurrentPosition(p => use({ lat: p.coords.latitude, lng: p.coords.longitude }), () => toast('אין גישה למיקום'), { enableHighAccuracy: true, timeout: 20000 });
  };
  let t; $('hQ').oninput = () => { clearTimeout(t); t = setTimeout(async () => {
    const v = $('hQ').value.trim(); if (v.length < 3) return;
    const r = await searchAddress(v).catch(() => []);
    $('hRes').innerHTML = r.map((x, i) => `<button class="mem" data-h="${esc(i)}" style="padding:10px"><div class="info"><div class="st" style="white-space:normal;color:var(--ink)">${esc(x.label)}</div></div></button>`).join('') || '<div class="empty">לא נמצאו תוצאות</div>';
    $('hRes').querySelectorAll('[data-h]').forEach(b => b.onclick = () => save(r[+b.dataset.h]));
  }, 500); };
  if ($('hDel')) $('hDel').onclick = () => save(null);
}

/* =========================================================
   חיסכון בסוללה (אנדרואיד) – שלא יעצור את שיתוף המיקום
   ========================================================= */
async function checkBattery(force, silent) {
  if (!BatteryOpt) return;
  let st; try { st = await BatteryOpt.status(); } catch (e) { return; }
  const was = S.battIgnoring; S.battIgnoring = st.ignoring;
  if (S.page === 'settings' && was !== st.ignoring) renderSettings();
  if (st.ignoring || silent || !isTracking()) return;
  if (!force && Date.now() - store.get('battAsk', 0) < 2 * 86400e3) return;
  store.set('battAsk', Date.now());
  const samsung = /samsung/i.test(st.manufacturer || '');
  modal(`<div style="text-align:center;font-size:44px">🔋</div><h3 style="text-align:center">שהמיקום לא ייעצר</h3>
    <p>אנדרואיד עוצר אפליקציות ברקע כדי לחסוך בסוללה – ואז הקבוצה רואה מיקום ישן. בחלון שייפתח לחצו <b>"אישור"</b> / <b>"לאפשר"</b>.</p>
    ${samsung ? `<div class="note">בסמסונג כדאי גם: הגדרות ← סוללה ← הגבלות שימוש ברקע ← לוודא ש"מיקומך" <b>לא</b> ברשימת "אפליקציות במצב שינה".</div>` : ''}
    <div class="actions"><button class="btn btn-p" id="battGo">המשך</button><button class="btn btn-g" data-close="1">אחר כך</button></div>`);
  $('battGo').onclick = async () => { closeModal(); try { await BatteryOpt.request(); } catch (e) { openLocationSettings(); } };
}

/* =========================================================
   בדיקת עדכונים (לאפליקציית האנדרואיד)
   ========================================================= */
async function checkUpdate(manual) {
  if (!isNative) return;
  try {
    const r = await fetch(SITE_URL + 'version.json?t=' + Date.now()); const v = await r.json();
    if (v.versionCode > BUILD.code) {
      modal(`<h3>🎉 גרסה חדשה זמינה</h3><p>גרסה ${esc(v.versionName)} מוכנה להורדה (יש לך ${esc(BUILD.name)}).</p>
        <div class="actions"><button class="btn btn-p" id="upd">הורדה</button><button class="btn btn-g" data-close="1">אחר כך</button></div>`);
      $('upd').onclick = () => { closeModal(); openExt(SITE_URL + 'mikumcha.apk'); };
    } else if (manual) toast('יש לך את הגרסה האחרונה ✓');
  } catch (e) { if (manual) toast('לא הצלחתי לבדוק עדכונים'); }
}

/* PWA: רישום service worker */
if (!isNative && 'serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
window.addEventListener('resize', () => { gmap?.refresh(); bmap?.refresh(); });

applyTheme();
if (import.meta.env.DEV) window.__mk = { S, initUI, go, personChanged, screen, enrich, renderAll };

/* מחיקת נקודות שביל ישנות מיומיים (פרטיות + מקום) */
async function trimTrail() {
  try {
    const uid = me(); if (!uid) return;
    const snap = await getDocs(query(collection(db, 'locations', uid, 'trail'), where('ts', '<', Date.now() - 2 * 86400e3), limit(400)));
    if (snap.empty) return;
    const b = writeBatch(db); snap.docs.forEach(d => b.delete(d.ref)); await b.commit();
    if (snap.size >= 400) setTimeout(trimTrail, 3000);
  } catch (e) { console.warn('trim', e); }
}

/* כפתור "חזרה" של אנדרואיד */
function handleBack() {
  if ($('modal').classList.contains('on')) { closeModal(); return true; }
  const scr = document.querySelector('.screen.on');
  if (scr) { if (scr.id === 's-profile' && S.started) { screen(null); return true; } return false; }
  if (S.page === 'groups' && S.selected) { S.selected = null; S.analysis = null; renderGroups(); fitGroup(); return true; }
  if (S.page === 'map' && S.mapSel) { S.mapSel = null; renderMapPage(); return true; }
  if (S.page !== 'groups') { go('groups'); return true; }
  return false;
}
if (isNative) import('@capacitor/app').then(({ App }) => App.addListener('backButton', () => {
  let handled = false; try { handled = handleBack(); } catch (e) { console.warn(e); }
  if (!handled) App.minimizeApp();
})).catch(() => { });
