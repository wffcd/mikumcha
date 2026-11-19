// שליחת המיקום של המשתמש עצמו – בחזית וגם ברקע (באפליקציית אנדרואיד)
import { registerPlugin } from '@capacitor/core';
import { doc, setDoc, collection, addDoc } from 'firebase/firestore';
import { db, isNative } from './fb.js';
import { restPatch, restAdd } from './rest.js';
import { haversine, store } from './util.js';

const BackgroundGeolocation = isNative ? registerPlugin('BackgroundGeolocation') : null;

const MOVE_M = 80;           // תזוזה מעל 80 מ' = התחיל לזוז
const TRIP_GAP_MIN = 5;      // עצירה של 5 דק' ומעלה ואז תזוזה = נסיעה חדשה

let uid = null, watchId = null, hb = null, onLocal = () => {}, onError = () => {};
let st = store.get('trk', { anchor: null, lastMoveT: 0, tripStart: null, tripFrom: null });
let lastFix = null, lastWrite = null, lastTrail = null, writing = false;

export const isTracking = () => watchId !== null;

async function battery() {
  try {
    if (isNative) { const { Device } = await import('@capacitor/device'); const b = await Device.getBatteryInfo(); return { battery: Math.round((b.batteryLevel ?? 0) * 100), charging: !!b.isCharging }; }
    if (navigator.getBattery) { const b = await navigator.getBattery(); return { battery: Math.round(b.level * 100), charging: b.charging }; }
  } catch (e) { }
  return { battery: null, charging: null };
}

async function write(fields) {
  if (isNative) return restPatch(`locations/${uid}`, fields);
  return setDoc(doc(db, 'locations', uid), fields, { merge: true });
}
async function addTrail(p) {
  if (isNative) return restAdd(`locations/${uid}/trail`, p);
  return addDoc(collection(db, 'locations', uid, 'trail'), p);
}

async function handle(lat, lng, acc, speed, heading, t) {
  const p = { lat, lng, t };
  // מהירות – מה-GPS, ואם אין, מחושבת מהנקודה הקודמת
  if ((speed == null || speed < 0) && lastFix && t > lastFix.t) speed = haversine(lastFix, p) / ((t - lastFix.t) / 1000);
  if (speed > 70) speed = null;  // קפיצת GPS
  p.s = speed;
  lastFix = p;

  if (!st.anchor || haversine(st.anchor, p) > MOVE_M) {
    const stillFor = st.lastMoveT ? (t - st.lastMoveT) / 60000 : 999;
    if (st.anchor && (stillFor >= TRIP_GAP_MIN || !st.tripStart)) { st.tripStart = t; st.tripFrom = { lat: st.anchor.lat, lng: st.anchor.lng }; }
    st.anchor = p; st.lastMoveT = t;
    store.set('trk', st);
  } else if (st.lastMoveT === 0) { st.lastMoveT = t; }

  onLocal({ lat, lng, acc, speed, t });

  const due = !lastWrite || haversine(lastWrite, p) > 30 || t - lastWrite.t > 60000;
  if (!due || writing) return;
  writing = true;
  try {
    const b = await battery();
    await write({
      lat, lng, acc: Math.round(acc || 0), speed: speed == null ? null : +speed.toFixed(2), heading: heading ?? null,
      ts: Date.now(), stillSince: st.anchor.t, tripStart: st.tripStart || null, tripFrom: st.tripFrom || null, ...b
    });
    lastWrite = p;
    if (!lastTrail || haversine(lastTrail, p) > 60) {
      await addTrail({ lat, lng, ts: t, speed: speed == null ? null : +speed.toFixed(2) });
      lastTrail = p;
    }
    onError(null);
  } catch (e) { onError(e); }
  finally { writing = false; }
}

let starting = null;
/** מונע הפעלה כפולה כשקוראים לפונקציה פעמיים במקביל */
export async function startTracking(opts) {
  if (starting) { uid = opts.uid; onLocal = opts.onLocal || onLocal; onError = opts.onError || onError; return starting; }
  starting = startTracking0(opts);
  try { return await starting; } finally { starting = null; }
}
async function startTracking0(opts) {
  uid = opts.uid; onLocal = opts.onLocal || onLocal; onError = opts.onError || onError;
  if (watchId !== null) return true;
  if (isNative) {
    try { const { LocalNotifications } = await import('@capacitor/local-notifications'); await LocalNotifications.requestPermissions(); } catch (e) { }
    watchId = await BackgroundGeolocation.addWatcher({
      backgroundTitle: 'מיקומך פעיל',
      backgroundMessage: 'המיקום שלך משותף עם הקבוצות שלך',
      requestPermissions: true, stale: false, distanceFilter: 15
    }, (loc, err) => {
      if (err) { onError(err); if (err.code === 'NOT_AUTHORIZED') opts.onDenied?.(); return; }
      if (loc) handle(loc.latitude, loc.longitude, loc.accuracy, loc.speed, loc.bearing, loc.time || Date.now());
    });
  } else {
    if (!navigator.geolocation) return false;
    watchId = navigator.geolocation.watchPosition(
      pos => handle(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, pos.coords.speed, pos.coords.heading, pos.timestamp),
      err => { onError(err); if (err.code === 1) opts.onDenied?.(); },
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 60000 });
  }
  // דופק: גם כשעומדים במקום, מעדכנים שהטלפון עדיין חי
  clearInterval(hb);
  hb = setInterval(async () => {
    if (!lastFix || writing) return;
    // אם היה בנסיעה מהירה ולא הגיע מיקום כבר 2 דק' – לא מסמנים "עדכני" (כדי שלא יוצג מיקום ישן כאילו הוא חדש)
    const driving = lastFix.s != null && lastFix.s > 12 && Date.now() - lastFix.t > 120000;
    try { await write(driving ? { ...(await battery()) } : { ts: Date.now(), stillSince: st.anchor?.t ?? null, ...(await battery()) }); } catch (e) { }
  }, 3 * 60 * 1000);
  return true;
}

export async function stopTracking() {
  clearInterval(hb);
  if (watchId === null) return;
  if (isNative) await BackgroundGeolocation.removeWatcher({ id: watchId });
  else navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

/** איפוס מלא בהתנתקות (שלא יעברו נתונים בין חשבונות) */
export function resetTracker() {
  st = { anchor: null, lastMoveT: 0, tripStart: null, tripFrom: null };
  lastFix = null; lastWrite = null; lastTrail = null;
}

export function openLocationSettings() { if (isNative) BackgroundGeolocation.openSettings(); }
