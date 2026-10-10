/* Umumiy yordamchilar: API, xarita, geokodlash */
const TK = 'tk_token';
const getTok = () => { try { return localStorage.getItem(TK) || ''; } catch { return ''; } };
const setTok = v => { try { v ? localStorage.setItem(TK, v) : localStorage.removeItem(TK); } catch {} };
const ADK = 'tk_admin';
const getAd = () => { try { return sessionStorage.getItem(ADK) || ''; } catch { return ''; } };
const setAd = v => { try { v ? sessionStorage.setItem(ADK, v) : sessionStorage.removeItem(ADK); } catch {} };

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, method, body, admin) {
  const h = { 'Content-Type': 'application/json' };
  if (admin) h['x-admin'] = getAd(); else if (getTok()) h.Authorization = 'Bearer ' + getTok();
  let r, j = {};
  try {
    r = await fetch('/api/' + path, { method: method || 'GET', headers: h, body: body ? JSON.stringify(body) : undefined });
    j = await r.json().catch(() => ({}));
  } catch { return { ok: false, status: 0, error: 'Tarmoq xatosi' }; }
  if (!r.ok) return { ok: false, status: r.status, error: j.error || 'Xato' };
  return { ok: true, data: j };
}

let toastT;
function toast(msg, err) {
  let el = $('toast'); if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.className = 'toast' + (err ? ' err' : ''); el.textContent = msg; el.style.display = 'block';
  clearTimeout(toastT); toastT = setTimeout(() => el.style.display = 'none', 2600);
}

function fmt(n, cur) {
  cur = cur || "so'm";
  if (cur === "so'm") return String(Math.round(n)).replace(/\B(?=(\d{3})+$)/g, ' ') + " so'm";
  return (Math.round(n * 100) / 100).toLocaleString('ru-RU') + ' ' + cur;
}
const hm = t => new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const short = a => String(a || '').split(',').slice(0, 3).join(',').trim();

const STATUS = { searching: 'Haydovchi qidirilmoqda', accepted: 'Haydovchi yo‘lda', arrived: 'Haydovchi yetib keldi', ontrip: 'Safar davom etmoqda', done: 'Safar yakunlandi', cancelled: 'Bekor qilindi' };

/* ---- Xarita ---- */
function makeMap(el) {
  const map = L.map(el, { zoomControl: false, worldCopyJump: true, minZoom: 2 }).setView([30, 50], 3);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  return map;
}
function drawZones(map, zones, onClick) {
  const g = L.layerGroup().addTo(map);
  zones.forEach(z => {
    const c = L.circle([z.lat, z.lng], { radius: z.r * 1000, color: '#ffc400', weight: 1.5, dashArray: '6 6', fillColor: '#ffc400', fillOpacity: z.active === false ? .02 : .08, opacity: z.active === false ? .3 : 1 }).addTo(g);
    c.bindTooltip(z.name, { permanent: true, direction: 'center', className: 'zlabel' });
    if (onClick) c.on('click', e => { L.DomEvent.stopPropagation(e); onClick(z); });
  });
  return g;
}
const pinIcon = (cls, txt) => L.divIcon({ className: '', html: `<div class="pin ${cls}"><i>${txt}</i></div>`, iconSize: [26, 26], iconAnchor: [13, 26] });
const carIcon = () => L.divIcon({ className: '', html: '<div class="car">🚕</div>', iconSize: [30, 30], iconAnchor: [15, 15] });

/* ---- Masofa va hudud ---- */
function kmBetween(a, b) {
  const r = x => x * Math.PI / 180, R = 6371, dLa = r(b.lat - a.lat), dLn = r(b.lng - a.lng);
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function zoneAt(zones, p) {
  let best = null, bs = 1e9;
  zones.forEach(z => { if (z.active === false) return; const s = kmBetween(p, z) / z.r; if (s <= 1 && s < bs) { best = z; bs = s; } });
  return best;
}
function priceOf(z, d) {
  const p = Math.max(z.min, z.base + z.perKm * d);
  return z.cur === "so'm" ? Math.round(p / 500) * 500 : Math.round(p * 100) / 100;
}

/* ---- OSRM yo'l va Nominatim qidiruv ---- */
async function route(a, b) {
  try {
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`);
    const j = await r.json();
    if (j.code === 'Ok' && j.routes[0]) return { km: j.routes[0].distance / 1000, line: j.routes[0].geometry.coordinates.map(c => [c[1], c[0]]) };
  } catch {}
  return { km: kmBetween(a, b) * 1.3, line: [[a.lat, a.lng], [b.lat, b.lng]], approx: true };
}
async function geoSearch(q) {
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=uz,ru,en&q=' + encodeURIComponent(q));
    return (await r.json()).map(x => ({ lat: +x.lat, lng: +x.lon, addr: short(x.display_name) }));
  } catch { return []; }
}
async function geoReverse(p) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=uz,ru,en&lat=${p.lat}&lon=${p.lng}`);
    const j = await r.json(); return j.display_name ? short(j.display_name) : '';
  } catch { return ''; }
}
const navLink = p => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
