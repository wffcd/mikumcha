// כתיבה ל-Firestore דרך REST עם CapacitorHttp (בקשות נייטיב).
// כך המיקום ממשיך להישלח גם כשהאפליקציה ברקע – אנדרואיד מאט בקשות של ה-WebView אחרי כמה דקות ברקע.
import { CapacitorHttp } from '@capacitor/core';
import { auth } from './fb.js';
import { firebaseConfig } from '../firebase-config.js';

let tok = { token: null, exp: 0 };

async function idToken() {
  if (tok.token && tok.exp - Date.now() > 5 * 60 * 1000) return tok.token;
  const u = auth.currentUser;
  if (!u) throw new Error('not signed in');
  const res = await CapacitorHttp.post({
    url: `https://securetoken.googleapis.com/v1/token?key=${firebaseConfig.apiKey}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: `grant_type=refresh_token&refresh_token=${encodeURIComponent(u.refreshToken)}`
  });
  const d = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  if (!d || !d.id_token) throw new Error('token refresh failed ' + res.status);
  tok = { token: d.id_token, exp: Date.now() + (+d.expires_in || 3600) * 1000 };
  return tok.token;
}

function val(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(val) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, val(x)])) } };
}
const base = () => `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents`;

/** עדכון שדות במסמך (יוצר אותו אם לא קיים) */
export async function restPatch(path, fields) {
  const t = await idToken();
  const mask = Object.keys(fields).map(f => 'updateMask.fieldPaths=' + encodeURIComponent(f)).join('&');
  const res = await CapacitorHttp.request({
    method: 'PATCH', url: `${base()}/${path}?${mask}`,
    headers: { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' },
    data: { fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, val(v)])) }
  });
  if (res.status >= 300) throw new Error('patch ' + res.status);
}

/** הוספת מסמך חדש לאוסף */
export async function restAdd(collPath, fields) {
  const t = await idToken();
  const res = await CapacitorHttp.request({
    method: 'POST', url: `${base()}/${collPath}`,
    headers: { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' },
    data: { fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, val(v)])) }
  });
  if (res.status >= 300) throw new Error('add ' + res.status);
}
