// Taksi — server (Node 18+, hech qanday paket kerak emas)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';   // Render'da albatta o'zgartiring!
const DATA_DIR = process.env.DATA_DIR || __dirname;        // Render Disk ulansa: /var/data
const FILE = path.join(DATA_DIR, 'data.json');
const PUB = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname;
const STATIC = new Set(['index.html', 'driver.html', 'admin.html', 'app.css', 'common.js']);   // faqat shu fayllar ochiq

// ---------- Ma'lumotlar ----------
const seedZones = [
  ['Toshkent', 41.2995, 69.2401, 30, 5000, 2500, 8000, "so'm"],
  ['Samarqand', 39.6542, 66.9597, 20, 4000, 2200, 7000, "so'm"],
  ['Buxoro', 39.7747, 64.4286, 15, 4000, 2000, 6000, "so'm"],
  ['Andijon', 40.7821, 72.3442, 15, 4000, 2000, 6000, "so'm"],
  ['Namangan', 40.9983, 71.6726, 15, 4000, 2000, 6000, "so'm"],
  ['Farg‘ona', 40.3842, 71.7843, 15, 4000, 2000, 6000, "so'm"],
  ['Nukus', 42.4531, 59.6103, 15, 4000, 2000, 6000, "so'm"],
  ['Qarshi', 38.8606, 65.7891, 12, 4000, 2000, 6000, "so'm"],
  ['Moskva', 55.7558, 37.6173, 40, 150, 28, 300, 'RUB'],
  ['Istanbul', 41.0082, 28.9784, 40, 60, 15, 120, 'TRY'],
  ['Dubay', 25.2048, 55.2708, 35, 12, 2.5, 15, 'AED'],
  ['Olmaota', 43.2389, 76.8897, 25, 600, 150, 1000, 'KZT'],
].map((z, i) => ({ id: i + 1, name: z[0], lat: z[1], lng: z[2], r: z[3], base: z[4], perKm: z[5], min: z[6], cur: z[7], active: true }));

let db = { zones: seedZones, users: [], rides: [], sessions: {}, seq: { zone: 100, ride: 1000, user: 1 } };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch {}
let saveT = null;
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(db)); } catch (e) { console.error('saqlash xatosi', e.message); } }, 200); };

// ---------- Yordamchilar ----------
const adminTokens = new Set(), tries = {};
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(ok => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } }); });
const rad = d => d * Math.PI / 180;
const km = (a, b) => { const R = 6371, dLa = rad(b.lat - a.lat), dLn = rad(b.lng - a.lng); const x = Math.sin(dLa / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
const num = (v, lo, hi) => { v = Number(v); return Number.isFinite(v) && v >= lo && v <= hi ? v : null; };
const pt = o => { if (!o) return null; const lat = num(o.lat, -90, 90), lng = num(o.lng, -180, 180); return lat === null || lng === null ? null : { lat, lng, addr: String(o.addr || '').slice(0, 200) }; };
const zoneAt = p => { let best = null, bs = 1e9; for (const z of db.zones) { if (!z.active) continue; const s = km(p, z) / z.r; if (s <= 1 && s < bs) { best = z; bs = s; } } return best; };
const priceOf = (z, d) => { const raw = z.base + z.perKm * d; const p = Math.max(z.min, raw); return z.cur === "so'm" ? Math.round(p / 500) * 500 : Math.round(p * 100) / 100; };
const pub = u => ({ id: u.id, role: u.role, name: u.name, phone: u.phone, car: u.car, plate: u.plate, approved: u.approved, blocked: u.blocked, online: u.online, lat: u.lat, lng: u.lng, seen: u.seen, created: u.created });
const userOf = req => { const t = (req.headers.authorization || '').slice(7); const id = db.sessions[t]; const u = id && db.users.find(x => x.id === id); return u && !u.blocked ? u : null; };
const ACTIVE = ['searching', 'accepted', 'arrived', 'ontrip'];
const rideView = r => {
  const d = r.driverId && db.users.find(u => u.id === r.driverId);
  const p = db.users.find(u => u.id === r.passengerId);
  return Object.assign({}, r, {
    driver: d ? { name: d.name, phone: d.phone, car: d.car, plate: d.plate, lat: d.lat, lng: d.lng } : null,
    passenger: p ? { name: p.name, phone: p.phone } : null,
  });
};
// Eski, javobsiz qolgan buyurtmalarni 15 daqiqadan keyin bekor qilish
setInterval(() => { const now = Date.now(); let ch = false; for (const r of db.rides) if (r.status === 'searching' && now - r.t > 15 * 60e3) { r.status = 'cancelled'; r.why = 'Haydovchi topilmadi'; ch = true; } if (ch) save(); }, 60e3);

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const pages = { '/': 'index.html', '/driver': 'driver.html', '/admin': 'admin.html' };

// ---------- Server ----------
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'), p = url.pathname.replace(/\/+$/, '') || '/', m = req.method;
    if (!p.startsWith('/api/')) {
      const f = pages[p] || p.slice(1);
      const fp = path.normalize(path.join(PUB, f));
      if (!STATIC.has(path.basename(fp)) || !fp.startsWith(PUB) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end('404'); }
      res.writeHead(200, { 'Content-Type': mime[path.extname(fp)] || 'application/octet-stream' });
      return fs.createReadStream(fp).pipe(res);
    }
    const b = m === 'GET' || m === 'DELETE' ? {} : await readBody(req);

    // ----- Ochiq -----
    if (p === '/api/zones' && m === 'GET') return send(res, 200, db.zones.filter(z => z.active));

    if (p === '/api/signup' && m === 'POST') {
      const role = b.role === 'driver' ? 'driver' : 'passenger';
      const name = String(b.name || '').trim().slice(0, 40), phone = String(b.phone || '').replace(/[^\d+]/g, '').slice(0, 16), pw = String(b.pw || '');
      if (!name || phone.length < 7 || pw.length < 4) return send(res, 400, { error: 'Ism, telefon va parol (kamida 4 belgi) kerak' });
      if (db.users.some(u => u.phone === phone)) return send(res, 409, { error: 'Bu telefon raqam ro‘yxatdan o‘tgan' });
      const salt = crypto.randomBytes(8).toString('hex');
      const u = { id: db.seq.user++, role, name, phone, salt, h: hash(pw, salt), created: Date.now(), blocked: false };
      if (role === 'driver') { u.car = String(b.car || '').trim().slice(0, 40); u.plate = String(b.plate || '').trim().toUpperCase().slice(0, 12); u.approved = false; u.online = false; if (!u.car || !u.plate) return send(res, 400, { error: 'Mashina va davlat raqamini kiriting' }); }
      db.users.push(u);
      const token = crypto.randomBytes(24).toString('hex'); db.sessions[token] = u.id; save();
      return send(res, 200, { token, user: pub(u) });
    }
    if (p === '/api/login' && m === 'POST') {
      const phone = String(b.phone || '').replace(/[^\d+]/g, ''), u = db.users.find(x => x.phone === phone);
      if (!u || hash(String(b.pw || ''), u.salt) !== u.h) return send(res, 401, { error: 'Telefon yoki parol xato' });
      if (u.blocked) return send(res, 403, { error: 'Akkaunt bloklangan' });
      const token = crypto.randomBytes(24).toString('hex'); db.sessions[token] = u.id; save();
      return send(res, 200, { token, user: pub(u) });
    }

    // ----- Admin kirish -----
    if (p === '/api/admin/login' && m === 'POST') {
      const ip = req.socket.remoteAddress, t = tries[ip] = (tries[ip] || []).filter(x => Date.now() - x < 9e5);
      if (t.length >= 10) return send(res, 429, { error: 'Ko‘p urinish. 15 daqiqadan keyin urining' });
      const ok = (a, c) => a.length === c.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(c));
      if (!ok(String(b.u || ''), ADMIN_USER) || !ok(String(b.p || ''), ADMIN_PASS)) { t.push(Date.now()); return send(res, 401, { error: 'Login yoki parol xato' }); }
      const token = crypto.randomBytes(24).toString('hex'); adminTokens.add(token); return send(res, 200, { token });
    }

    // ----- Admin -----
    if (p.startsWith('/api/admin/')) {
      if (!adminTokens.has(req.headers['x-admin'])) return send(res, 401, { error: 'Ruxsat yo‘q' });
      if (p === '/api/admin/overview') {
        const done = db.rides.filter(r => r.status === 'done'), today = new Date().setHours(0, 0, 0, 0);
        const sum = a => a.reduce((s, r) => s + r.price, 0);
        return send(res, 200, {
          rides: db.rides.length, active: db.rides.filter(r => ACTIVE.includes(r.status)).length, done: done.length,
          cancelled: db.rides.filter(r => r.status === 'cancelled').length, todayDone: done.filter(r => r.t >= today).length,
          passengers: db.users.filter(u => u.role === 'passenger').length,
          drivers: db.users.filter(u => u.role === 'driver').length, online: db.users.filter(u => u.role === 'driver' && u.online && Date.now() - (u.seen || 0) < 60e3).length,
          pending: db.users.filter(u => u.role === 'driver' && !u.approved && !u.blocked).length,
          zones: db.zones.length, revenue: sum(done),
        });
      }
      if (p === '/api/admin/zones' && m === 'GET') return send(res, 200, db.zones);
      if (p === '/api/admin/zones' && m === 'POST') {
        const z = cleanZone(b, db.seq.zone++); if (!z) return send(res, 400, { error: 'Nom, joylashuv, radius va narxlarni to‘g‘ri kiriting' });
        db.zones.push(z); save(); return send(res, 200, db.zones);
      }
      let mt = p.match(/^\/api\/admin\/zones\/(\d+)$/);
      if (mt) {
        const id = +mt[1], i = db.zones.findIndex(z => z.id === id); if (i < 0) return send(res, 404, { error: 'Hudud topilmadi' });
        if (m === 'DELETE') db.zones.splice(i, 1);
        else { const z = cleanZone(b, id); if (!z) return send(res, 400, { error: 'Maydonlarni tekshiring' }); db.zones[i] = z; }
        save(); return send(res, 200, db.zones);
      }
      if (p === '/api/admin/rides') return send(res, 200, db.rides.slice(-200).reverse().map(rideView));
      if ((mt = p.match(/^\/api\/admin\/rides\/(\d+)\/cancel$/)) && m === 'POST') {
        const r = db.rides.find(x => x.id === +mt[1]); if (!r || !ACTIVE.includes(r.status)) return send(res, 400, { error: 'Bekor qilib bo‘lmaydi' });
        r.status = 'cancelled'; r.why = 'Admin bekor qildi'; save(); return send(res, 200, { ok: 1 });
      }
      if (p === '/api/admin/users') return send(res, 200, db.users.map(pub).reverse());
      if ((mt = p.match(/^\/api\/admin\/users\/(\d+)$/)) && m === 'POST') {
        const u = db.users.find(x => x.id === +mt[1]); if (!u) return send(res, 404, { error: 'Topilmadi' });
        if (typeof b.approved === 'boolean' && u.role === 'driver') u.approved = b.approved;
        if (typeof b.blocked === 'boolean') { u.blocked = b.blocked; if (b.blocked) u.online = false; }
        save(); return send(res, 200, pub(u));
      }
      return send(res, 404, { error: 'Topilmadi' });
    }

    // ----- Foydalanuvchi (yo'lovchi / haydovchi) -----
    const u = userOf(req); if (!u) return send(res, 401, { error: 'Avval kiring' });
    if (p === '/api/me') return send(res, 200, pub(u));

    // Yo'lovchi
    if (p === '/api/ride' && m === 'POST') {
      if (u.role !== 'passenger') return send(res, 403, { error: 'Faqat yo‘lovchi buyurtma bera oladi' });
      if (db.rides.some(r => r.passengerId === u.id && ACTIVE.includes(r.status))) return send(res, 409, { error: 'Sizda faol buyurtma bor' });
      const from = pt(b.from), to = pt(b.to); if (!from || !to) return send(res, 400, { error: 'Qayerdan va qayerga nuqtalarini tanlang' });
      const z = zoneAt(from); if (!z) return send(res, 400, { error: 'Bu hududda xizmat hali yo‘q' });
      const air = km(from, to); if (air < 0.1) return send(res, 400, { error: 'Manzillar juda yaqin' });
      let d = Number(b.distKm); if (!(d >= air * 0.95 && d <= air * 3 + 2)) d = air * 1.3;
      d = Math.round(d * 10) / 10;
      const r = { id: db.seq.ride++, passengerId: u.id, from, to, distKm: d, price: priceOf(z, d), cur: z.cur, zoneId: z.id, zone: z.name, status: 'searching', driverId: null, t: Date.now() };
      db.rides.push(r); save(); return send(res, 200, rideView(r));
    }
    if (p === '/api/ride/active' && m === 'GET') {
      const r = db.rides.filter(x => x.passengerId === u.id).slice(-1)[0];
      if (!r) return send(res, 200, { ride: null });
      const recent = !ACTIVE.includes(r.status) && Date.now() - (r.end || r.t) > 3 * 60e3;
      return send(res, 200, { ride: recent || (r.status === 'cancelled' && r.seenByP) ? null : rideView(r) });
    }
    if (p === '/api/ride/close' && m === 'POST') { const r = db.rides.filter(x => x.passengerId === u.id).slice(-1)[0]; if (r && !ACTIVE.includes(r.status)) { r.seenByP = true; save(); } return send(res, 200, { ok: 1 }); }
    if (p === '/api/ride/cancel' && m === 'POST') {
      const r = db.rides.find(x => x.passengerId === u.id && ACTIVE.includes(x.status));
      if (!r) return send(res, 400, { error: 'Faol buyurtma yo‘q' });
      if (r.status === 'ontrip') return send(res, 400, { error: 'Safar boshlangan, bekor qilib bo‘lmaydi' });
      r.status = 'cancelled'; r.why = 'Yo‘lovchi bekor qildi'; r.end = Date.now(); save(); return send(res, 200, { ok: 1 });
    }
    if (p === '/api/rides/mine') return send(res, 200, db.rides.filter(r => r.passengerId === u.id || r.driverId === u.id).slice(-30).reverse().map(rideView));

    // Haydovchi
    if (p.startsWith('/api/driver/')) {
      if (u.role !== 'driver') return send(res, 403, { error: 'Faqat haydovchilar uchun' });
      if (p === '/api/driver/online' && m === 'POST') { if (!u.approved) return send(res, 403, { error: 'Admin tasdiqlashini kuting' }); u.online = !!b.online; u.seen = Date.now(); save(); return send(res, 200, pub(u)); }
      if (p === '/api/driver/loc' && m === 'POST') { const l = pt(b); if (!l) return send(res, 400, { error: 'Joylashuv xato' }); u.lat = l.lat; u.lng = l.lng; u.seen = Date.now(); return send(res, 200, { ok: 1 }); }
      if (p === '/api/driver/jobs' && m === 'GET') {
        u.seen = Date.now();
        const mine = db.rides.find(r => r.driverId === u.id && ['accepted', 'arrived', 'ontrip'].includes(r.status));
        let avail = [];
        if (u.approved && u.online && !mine && u.lat != null) {
          avail = db.rides.filter(r => r.status === 'searching').filter(r => { const z = db.zones.find(z => z.id === r.zoneId); return z && km(u, z) <= z.r; })
            .map(r => Object.assign(rideView(r), { pickupKm: Math.round(km(u, r.from) * 10) / 10 })).sort((a, b) => a.pickupKm - b.pickupKm).slice(0, 20);
        }
        const mineDone = db.rides.filter(r => r.driverId === u.id && r.status === 'done'), today = new Date().setHours(0, 0, 0, 0);
        return send(res, 200, { user: pub(u), active: mine ? rideView(mine) : null, available: avail, stats: { trips: mineDone.length, todayTrips: mineDone.filter(r => r.end >= today).length, today: mineDone.filter(r => r.end >= today).reduce((s, r) => s + r.price, 0) } });
      }
      if (p === '/api/driver/accept' && m === 'POST') {
        if (!u.approved || !u.online) return send(res, 403, { error: 'Avval onlayn bo‘ling' });
        if (db.rides.some(r => r.driverId === u.id && ['accepted', 'arrived', 'ontrip'].includes(r.status))) return send(res, 409, { error: 'Sizda faol safar bor' });
        const r = db.rides.find(x => x.id === +b.id);
        if (!r || r.status !== 'searching') return send(res, 409, { error: 'Buyurtmani boshqa haydovchi oldi' });
        r.status = 'accepted'; r.driverId = u.id; r.acceptedAt = Date.now(); save(); return send(res, 200, rideView(r));
      }
      if (p === '/api/driver/status' && m === 'POST') {
        const r = db.rides.find(x => x.id === +b.id && x.driverId === u.id), next = { accepted: 'arrived', arrived: 'ontrip', ontrip: 'done' };
        if (!r || !next[r.status]) return send(res, 400, { error: 'Holatni o‘zgartirib bo‘lmaydi' });
        r.status = next[r.status]; if (r.status === 'done') r.end = Date.now(); save(); return send(res, 200, rideView(r));
      }
      if (p === '/api/driver/cancel' && m === 'POST') {
        const r = db.rides.find(x => x.id === +b.id && x.driverId === u.id && ['accepted', 'arrived'].includes(x.status));
        if (!r) return send(res, 400, { error: 'Bekor qilib bo‘lmaydi' });
        r.status = 'searching'; r.driverId = null; save(); return send(res, 200, { ok: 1 });   // buyurtma boshqa haydovchiga qaytadi
      }
    }
    send(res, 404, { error: 'Topilmadi' });
  } catch (e) { console.error(e); send(res, 500, { error: 'Server xatosi' }); }
}).listen(PORT, () => console.log('Taksi: http://localhost:' + PORT));

function cleanZone(b, id) {
  const name = String(b.name || '').trim().slice(0, 50), lat = num(b.lat, -90, 90), lng = num(b.lng, -180, 180), r = num(b.r, 1, 500);
  const base = num(b.base, 0, 1e7), perKm = num(b.perKm, 0, 1e6), min = num(b.min, 0, 1e7);
  if (!name || lat === null || lng === null || r === null || base === null || perKm === null || min === null) return null;
  return { id, name, lat, lng, r, base, perKm, min, cur: String(b.cur || "so'm").slice(0, 8), active: b.active !== false };
}
