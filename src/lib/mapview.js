import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { esc, initial } from './util.js';

const TILES = {
  light: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
};
const ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/">CARTO</a>';

export class MapView {
  constructor(el, { onTap, onBg, insets }) {
    this.insets = insets; this.onTap = onTap;
    this.map = L.map(el, { zoomControl: false, attributionControl: true, center: [32.08, 34.78], zoom: 12, tap: true });
    this.map.attributionControl.setPrefix(false);
    this.tiles = null; this.theme = null;
    this.markers = new Map(); this.me = null; this.dest = null;
    this.trail = null; this.ahead = null; this.start = null;
    if (onBg) this.map.on('click', onBg);
  }
  setTheme(dark) {
    const t = dark ? 'dark' : 'light'; if (t === this.theme) return; this.theme = t;
    if (this.tiles) this.tiles.remove();
    this.tiles = L.tileLayer(TILES[t], { attribution: ATTR, subdomains: 'abcd', maxZoom: 19, detectRetina: true }).addTo(this.map);
  }
  refresh() { this.map.invalidateSize(); }

  /** people: [{uid, name, color, photo, lat, lng, label, dot, alert}] */
  setPeople(people, selUid) {
    const keep = new Set();
    for (const p of people) {
      if (p.lat == null) continue;
      keep.add(p.uid);
      const html = `<div class="pin${p.uid === selUid ? ' sel' : ''}">${p.alert ? '<span class="pin-pulse"></span>' : ''}
        <div class="pin-av" style="background:${p.color}">${p.photo ? `<img src="${esc(p.photo)}" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<b>${initial(p.name)}</b></div>
        <span class="pin-dot" style="background:${p.dot}"></span>
        <div class="pin-lbl">${esc(p.label)}</div></div>`;
      let m = this.markers.get(p.uid);
      if (!m) {
        m = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: 'pin-wrap', html, iconSize: [0, 0] }), zIndexOffset: 500 }).addTo(this.map);
        m.on('click', () => this.onTap(p.uid));
        m._html = html; this.markers.set(p.uid, m);
      } else {
        m.setLatLng([p.lat, p.lng]);
        if (m._html !== html) { m.setIcon(L.divIcon({ className: 'pin-wrap', html, iconSize: [0, 0] })); m._html = html; }
      }
      m.setZIndexOffset(p.uid === selUid ? 1000 : 500);
    }
    for (const [uid, m] of this.markers) if (!keep.has(uid)) { m.remove(); this.markers.delete(uid); }
  }
  setMe(pos) {
    if (!pos) { if (this.me) { this.me.remove(); this.me = null; } return; }
    if (!this.me) this.me = L.marker([pos.lat, pos.lng], { icon: L.divIcon({ className: 'pin-wrap', html: '<div class="me-dot"><i></i></div>', iconSize: [0, 0] }), zIndexOffset: 300, interactive: false }).addTo(this.map);
    else this.me.setLatLng([pos.lat, pos.lng]);
  }
  setRoute({ trail, ahead, color, dest, destLabel, start } = {}) {
    for (const k of ['trail', 'ahead', 'dest', 'start', 'trailBg', 'aheadBg']) if (this[k]) { this[k].remove(); this[k] = null; }
    if (!color) return;
    if (ahead && ahead.length > 1) {
      this.aheadBg = L.polyline(ahead, { color: '#fff', weight: 8, opacity: .55, interactive: false }).addTo(this.map);
      this.ahead = L.polyline(ahead, { color, weight: 5, dashArray: '2 9', lineCap: 'round', interactive: false }).addTo(this.map);
    }
    if (trail && trail.length > 1) {
      this.trailBg = L.polyline(trail, { color: '#fff', weight: 10, opacity: .7, interactive: false }).addTo(this.map);
      this.trail = L.polyline(trail, { color, weight: 6, interactive: false }).addTo(this.map);
    }
    if (start) this.start = L.circleMarker(start, { radius: 6, color, fillColor: '#fff', fillOpacity: 1, weight: 3, interactive: false }).addTo(this.map);
    if (dest) this.dest = L.marker([dest.lat, dest.lng], { icon: L.divIcon({ className: 'pin-wrap', html: `<div class="dest-pin"><span>${destLabel || '🏠'}</span></div>`, iconSize: [0, 0] }), zIndexOffset: 200, interactive: false }).addTo(this.map);
  }
  padding() {
    const { top, bottom } = this.insets();
    return { paddingTopLeft: [40, top + 20], paddingBottomRight: [40, bottom + 20] };
  }
  fit(points, maxZoom = 16) {
    const pts = points.filter(p => p && p[0] != null);
    if (!pts.length) return;
    if (pts.length === 1) return this.flyTo(pts[0], 15);
    this.map.flyToBounds(L.latLngBounds(pts), { ...this.padding(), maxZoom, duration: .6 });
  }
  flyTo(p, zoom) {
    const z = zoom || Math.max(this.map.getZoom(), 15);
    const { top, bottom } = this.insets();
    // מרכז את הנקודה באזור שלא מוסתר ע"י הכרטיסים
    const pt = this.map.project(p, z).add([0, (bottom - top) / 2]);
    this.map.flyTo(this.map.unproject(pt, z), z, { duration: .6 });
  }
  zoomIn() { this.map.zoomIn(); } zoomOut() { this.map.zoomOut(); }
}
