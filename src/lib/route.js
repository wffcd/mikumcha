// מסלולים וזמני הגעה (OSRM) + זיהוי סוג המקום (OpenStreetMap / Nominatim)
import { haversine } from './util.js';

const routeCache = new Map();   // key -> {at, from, data}
const placeCache = new Map();   // "lat,lng" מעוגל -> {type, name}

/** מסלול נסיעה מנקודה לנקודה. מחזיר {distance (מ'), duration (שנ'), coords:[[lat,lng]...]} */
export async function getRoute(from, to, key) {
  const c = routeCache.get(key);
  if (c && haversine(c.to, to) < 150 && haversine(c.from, from) < 150 && Date.now() - c.at < 90000) return c.data;
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
    const r = await fetch(url); const j = await r.json();
    if (!j.routes || !j.routes[0]) throw 0;
    const rt = j.routes[0];
    const data = { distance: rt.distance, duration: rt.duration, coords: rt.geometry.coordinates.map(([lng, lat]) => [lat, lng]) };
    routeCache.set(key, { at: Date.now(), from, to, data });
    return data;
  } catch (e) {
    // בלי חיבור לשרת המסלולים – הערכה לפי קו אווירי
    const d = haversine(from, to) * 1.3;
    return { distance: d, duration: d / 11, coords: [[from.lat, from.lng], [to.lat, to.lng]], rough: true };
  }
}

// Nominatim מבקש לכל היותר בקשה אחת לשנייה
let q = Promise.resolve();
function throttled(fn) { const p = q.then(fn); q = p.then(() => new Promise(r => setTimeout(r, 1100)), () => new Promise(r => setTimeout(r, 1100))); return p; }

const ROAD_TYPES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'unclassified', 'residential', 'service', 'road'];

/** מה יש בנקודה: כביש או מקום (חנות, משרד, בית קפה...) */
export function placeAt(p) {
  const k = p.lat.toFixed(4) + ',' + p.lng.toFixed(4);
  if (placeCache.has(k)) return Promise.resolve(placeCache.get(k));
  return throttled(async () => {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${p.lat}&lon=${p.lng}&zoom=18&accept-language=he`);
      const j = await r.json();
      const a = j.address || {};
      const street = a.road || a.pedestrian || '';
      let res;
      if (j.category === 'highway' || (j.addresstype === 'road' && ROAD_TYPES.includes(j.type))) {
        const major = ['motorway', 'trunk', 'primary', 'motorway_link', 'trunk_link'].includes(j.type);
        res = { type: 'road', major, name: j.name || street || 'כביש', area: a.city || a.town || a.village || '' };
      } else {
        const name = j.name || (street ? `${street}${a.house_number ? ' ' + a.house_number : ''}` : (a.suburb || a.city || 'מקום'));
        res = { type: 'place', name, kind: j.type || '', area: a.city || a.town || '' };
      }
      placeCache.set(k, res);
      return res;
    } catch (e) { return { type: 'unknown', name: '' }; }
  });
}
export const cachedPlace = p => p ? placeCache.get(p.lat.toFixed(4) + ',' + p.lng.toFixed(4)) : null;

/** חיפוש כתובת (להגדרת הבית) */
export async function searchAddress(text) {
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(text)}&countrycodes=il&limit=5&accept-language=he`);
  const j = await r.json();
  return j.map(x => ({ lat: +x.lat, lng: +x.lon, label: x.display_name.split(',').slice(0, 3).join(',') }));
}
