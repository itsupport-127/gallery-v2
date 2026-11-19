// Uji: multi-klien (tenant) — isolasi data antar klien, hak akun klien, token booth dari platform (terbit / pakai / cabut), klien nonaktif.
//   node test/tenant.js
process.env.DATA_DIR = require("fs").mkdtempSync(require("os").tmpdir() + "/gal-ten-");
process.env.ADMIN_PASSWORD = "rahasia"; process.env.PUBLIC_URL = "https://foto.example.com";
const assert = require("assert");

(async () => {
  const { app } = require("../src/server"); const { db } = require("../src/db");
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  const JS = { "Content-Type": "application/json" };
  const call = async (p, o = {}, cookie) => { const r = await fetch(base + p, { ...o, headers: { ...JS, ...(cookie ? { Cookie: cookie } : {}), ...(o.headers || {}) } }); return { status: r.status, body: await r.json().catch(() => null), r }; };
  const login = async (username, password) => { const r = await fetch(base + "/admin/api/login", { method: "POST", headers: JS, body: JSON.stringify({ username, password }) }); return r.status === 200 ? r.headers.get("set-cookie").split(";")[0] : null; };
  const post = (p, body, c) => call(p, { method: "POST", body: JSON.stringify(body) }, c);
  const root = await login("admin", "rahasia"); assert(root, "login super admin gagal");

  // --- siapkan: 2 klien, studio masing-masing + 1 studio belum dibagikan, 1 akun per klien ---
  const tA = (await post("/admin/api/tenants", { name: "Klien A" }, root)).body.id, tB = (await post("/admin/api/tenants", { name: "Klien B" }, root)).body.id;
  assert((await post("/admin/api/tenants", { name: "klien a" }, root)).status === 409, "nama klien kembar (tak peka huruf) harus ditolak");
  for (const [name, t] of [["Studio A1", tA], ["Studio B1", tB], ["Studio Yatim", null]]) assert((await post("/admin/api/studios", { name, tenantId: t }, root)).status === 200);
  const mk = async (username, tenantId) => assert((await post("/admin/api/users", { username, password: "password-panjang", role: "admin", tenantId, perms: ["studio.view", "link.view", "link.edit", "upload", "storage.edit", "settings.edit", "studio.edit"] }, root)).status === 200);
  await mk("akun-a", tA); await mk("akun-b", tB);
  const t0 = Date.now();
  for (const [tok, st] of [["SESIAAAAAA", "Studio A1"], ["SESIBBBBBB", "Studio B1"], ["SESIYATIMM", "Studio Yatim"]]) db.prepare("INSERT INTO sessions (token, studio, studio_code, mode, created_at, expires_at) VALUES (?,?,?,?,?,?)").run(tok, st, "x", "photo", t0, t0 + 86400000);
  const A = await login("akun-a", "password-panjang"); assert(A);

  // --- akun klien A: hanya melihat miliknya, walau diberi hak "admin"/storage/settings ---
  const me = (await call("/admin/api/me", {}, A)).body;
  assert(me.tenantName === "Klien A" && me.admin === false && !me.perms.includes("storage.edit") && !me.perms.includes("settings.edit") && !me.perms.includes("studio.edit"), "hak akun klien harus dipangkas: " + JSON.stringify(me));
  const studios = (await call("/admin/api/studios", {}, A)).body.studios.map((x) => x.name);
  assert.deepStrictEqual(studios, ["Studio A1"], "klien A hanya boleh melihat studionya: " + studios);
  const links = (await call("/admin/api/sessions?limit=100", {}, A)).body;
  assert.deepStrictEqual(links.sessions.map((x) => x.token), ["SESIAAAAAA"], "klien A hanya boleh melihat link studionya");
  assert((await call("/admin/api/sessions?q=SESIBBBBBB", {}, A)).body.total === 0, "pencarian tidak boleh menembus klien lain");
  assert((await call("/admin/api/sessions?studio=Studio%20B1", {}, A)).body.total === 0, "filter studio klien lain harus kosong");
  const st = (await call("/admin/api/state", {}, A)).body;
  assert(st.buckets.length === 0 && st.stats.sessions === 1 && st.studios.length === 1, "ringkasan klien harus terbatas: " + JSON.stringify(st.stats));

  // --- tidak boleh mengubah / menghapus milik klien lain ---
  assert((await post("/admin/api/sessions/SESIBBBBBB", { expiresAt: Date.now() + 5 * 86400000 }, A)).status === 404);
  assert((await call("/admin/api/sessions/SESIBBBBBB", { method: "DELETE" }, A)).status === 200);
  assert(db.prepare("SELECT 1 FROM sessions WHERE token = 'SESIBBBBBB'").get(), "sesi klien B tidak boleh terhapus oleh klien A");
  const bulk = await post("/admin/api/sessions-bulk", { action: "delete", tokens: ["SESIBBBBBB", "SESIYATIMM"] }, A);
  assert(bulk.status === 400 && !bulk.body.done, "hapus massal untuk milik lain / yatim harus ditolak: " + JSON.stringify(bulk.body));
  assert(db.prepare("SELECT COUNT(*) n FROM sessions WHERE token IN ('SESIBBBBBB','SESIYATIMM')").get().n === 2, "sesi lain tidak boleh terhapus");
  assert((await post("/admin/api/sessions/SESIAAAAAA", { studio: "Studio B1" }, A)).status === 403, "tidak boleh memindahkan sesi ke studio klien lain");
  assert((await post("/admin/api/upload/prepare", { studio: "Studio B1", token: "ZZZZZZZZZ2", files: [] }, A)).status === 403, "unggah manual ke studio klien lain");
  assert((await post("/admin/api/upload/prepare", { studio: "Studio Baru Liar", token: "ZZZZZZZZZ2", files: [] }, A)).status === 403, "klien tidak boleh membuat studio baru lewat unggah manual");
  assert((await post("/admin/api/studios/studio%20b1", { note: "x" }, A)).status === 403 || (await post("/admin/api/studios/studio%20b1", { note: "x" }, A)).status === 404);
  assert((await post("/admin/api/studios/studio%20a1", { tenantId: tB }, A)).status === 403, "klien tidak boleh memindahkan studio ke klien lain");

  // --- area super admin tertutup untuk akun klien ---
  for (const [m, p, b] of [["GET", "/admin/api/users"], ["GET", "/admin/api/tenants"], ["POST", "/admin/api/tenants", { name: "Z" }], ["POST", "/admin/api/studios/studio%20a1/tokens", {}], ["POST", "/admin/api/settings", { retentionDays: 1 }], ["POST", "/admin/api/buckets", { endpoint: "https://x.y", bucket: "b", accessKey: "k" }], ["POST", "/admin/api/diagnostics"]])
    assert((await call(p, { method: m, body: b ? JSON.stringify(b) : undefined }, A)).status === 403, `${m} ${p} harus 403 untuk akun klien`);

  // --- super admin tetap melihat semuanya ---
  assert((await call("/admin/api/studios", {}, root)).body.studios.length === 3);
  assert((await call("/admin/api/sessions?limit=100", {}, root)).body.total === 3);

  // --- tidak boleh menggabung studio lintas klien ---
  assert((await post("/admin/api/studios/studio%20a1", { name: "Studio B1" }, root)).status === 409, "gabung studio lintas klien harus ditolak");

  // --- token booth platform ---
  const tk = await post("/admin/api/studios/studio%20a1/tokens", { label: "Booth lobi" }, root);
  assert(tk.status === 200 && /^pst_[A-Za-z0-9_-]{40,}$/.test(tk.body.token), "token harus berformat pst_...");
  const token = tk.body.token, H = { Authorization: "Bearer " + token };
  const ping = await call("/api/v1/ping", { headers: H });
  assert(ping.status === 200 && ping.body.studio === "Studio A1", "token platform harus lolos: " + JSON.stringify(ping.body));
  assert((await call("/api/v1/heartbeat", { method: "POST", headers: H, body: JSON.stringify({ pendingSessions: 0 }) })).status === 200);
  const list = (await call("/admin/api/studios/studio%20a1/tokens", {}, root)).body.tokens;
  assert(list.length === 1 && list[0].label === "Booth lobi" && list[0].lastUsedAt && !JSON.stringify(list).includes(token), "daftar token tidak boleh memuat token asli");
  const dump = JSON.stringify(db.prepare("SELECT * FROM booth_tokens").all()); assert(!dump.includes(token), "token asli tidak boleh tersimpan di database (hanya hash)");
  assert((await call("/api/v1/sessions/SESIBBBBBB/done", { method: "POST", headers: H, body: JSON.stringify({ fid: "x" }) })).status === 404, "token studio A tidak boleh menyentuh sesi studio B");
  assert((await call("/api/v1/ping", { headers: { Authorization: "Bearer pst_tokenasalasalan0000000000000000000000000" } })).status === 401, "token palsu 'pst_' harus ditolak");

  // klien dinonaktifkan: booth ditolak & akun keluar
  assert((await post(`/admin/api/tenants/${tA}`, { active: false }, root)).status === 200);
  assert((await call("/api/v1/ping", { headers: H })).status === 403, "booth milik klien nonaktif harus ditolak");
  assert((await call("/admin/api/state", {}, A)).status === 401, "akun klien nonaktif harus terputus");
  assert((await post(`/admin/api/tenants/${tA}`, { active: true }, root)).status === 200);
  assert((await call("/api/v1/ping", { headers: H })).status === 200, "aktif lagi = pulih");

  // cabut token = langsung mati
  assert((await call(`/admin/api/studios/studio%20a1/tokens/${list[0].id}`, { method: "DELETE" }, root)).body.revoked === true);
  assert((await call("/api/v1/ping", { headers: H })).status === 401, "token yang dicabut harus langsung mati");

  // hapus klien yang masih punya studio ditolak
  assert((await call(`/admin/api/tenants/${tA}`, { method: "DELETE" }, root)).status === 409);
  console.log("ok  multi-klien: isolasi studio/link/unggah antar klien, hak akun klien dipangkas, area super admin tertutup, token booth (terbit/pakai/hash/cabut), klien nonaktif");
  srv.close(); process.exit(0);
})().catch((e) => { console.error("GAGAL:", e.stack || e.message); process.exit(1); });
