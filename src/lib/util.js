export const $ = id => document.getElementById(id);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const initial = n => esc((String(n || '?').trim()[0]) || '?');
/** מאפשר רק ערכי צבע תקינים (מונע הזרקת קוד דרך שדה הצבע) */
export const safeColor = (c, def = '#94a3b8') => typeof c === 'string' && /^(#[0-9a-fA-F]{3,8}|(rgb|hsl)a?\([0-9.,%\s]+\))$/.test(c.trim()) ? c.trim() : def;
export const COLORS = ['#ec4899', '#8b5cf6', '#0ea5e9', '#f97316', '#14b8a6', '#22c55e', '#eab308', '#6366f1', '#e11d48', '#06b6d4'];

export function fmtDur(min) {
  min = Math.max(0, Math.round(min));
  if (min < 60) return min + ' דק׳';
  const h = Math.floor(min / 60), m = min % 60;
  return h + ' ש׳' + (m ? ' ' + m + ' דק׳' : '');
}
export const fmtDist = m => m < 1000 ? Math.round(m / 10) * 10 + ' מ׳' : (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' ק״מ';
export const clock = ts => new Date(ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
export const clockIn = min => clock(Date.now() + min * 60000);
export function timeAgo(ts) {
  const m = (Date.now() - ts) / 60000;
  if (m < 1) return 'עכשיו';
  if (m < 60) return `לפני ${Math.round(m)} דק׳`;
  if (m < 60 * 24) return `לפני ${Math.round(m / 60)} ש׳`;
  return new Date(ts).toLocaleDateString('he-IL');
}

export function haversine(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/** מנרמל מספר טלפון ישראלי לפורמט 9725XXXXXXXX */
export function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '972' + d.slice(1);
  if (d.length === 9 && d.startsWith('5')) d = '972' + d;
  return d.length >= 11 ? d : '';
}
export function prettyPhone(n) {
  if (!n) return '';
  if (n.startsWith('972')) { const l = '0' + n.slice(3); return l.length === 10 ? `${l.slice(0, 3)}-${l.slice(3, 6)}-${l.slice(6)}` : l; }
  return '+' + n;
}
export const telHref = n => 'tel:' + (n.startsWith('972') ? '0' + n.slice(3) : '+' + n);

export function randomCode() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

export const store = {
  get(k, def) { try { const v = localStorage.getItem('mk-' + k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
  set(k, v) { try { localStorage.setItem('mk-' + k, JSON.stringify(v)); } catch (e) { } }
};
