// Uji: riwayat transaksi — protokol booth (/api/photobox/*), omzet (TEST & belum lunas tidak dihitung), zona waktu WIB, isolasi antar klien,
// koreksi admin (TEST / hapus) yang ditarik balik oleh booth, ekspor CSV aman, hak akun klien.
//   node test/transaksi.js
process.env.DATA_DIR = require("fs").mkdtempSync(require("os").tmpdir() + "/gal-tx-");
process.env.ADMIN_PASSWORD = "rahasia"; process.env.PUBLIC_URL = "https://foto.example.com";
const assert = require("assert");

(async () => {
  const { app } = require("../src/server"); const { db } = require("../src/db");
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  const JS = { "Content-Type": "application/json" };
  const call = async (p, o = {}, cookie) => { const r = await fetch(base + p, { ...o, headers: { ...JS, ...(cookie ? { Cookie: cookie } : {}), ...(o.headers || {}) } }); return { status: r.status, body: await r.json().catch(() => null), r }; };
  const login = async (u, pw) => { const r = await fetch(base + "/admin/api/login", { method: "POST", headers: JS, body: JSON.stringify({ username: u, password: pw }) }); return r.status === 200 ? r.headers.get("set-cookie").split(";")[0] : null; };
  const post = (p, body, c) => call(p, { method: "POST", body: JSON.stringify(body) }, c);
  const root = await login("admin", "rahasia");
  const tA = (await post("/admin/api/tenants", { name: "Klien A" }, root)).body.id, tB = (await post("/admin/api/tenants", { name: "Klien B" }, root)).body.id;
  for (const [n, t] of [["Studio A1", tA], ["Studio B1", tB]]) await post("/admin/api/studios", { name: n, tenantId: t }, root);
  const tokA = (await post("/admin/api/studios/studio%20a1/tokens", { label: "a" }, root)).body.token, tokB = (await post("/admin/api/studios/studio%20b1/tokens", { label: "b" }, root)).body.token;
  const HA = { Authorization: "Bearer " + tokA }, HB = { Authorization: "Bearer " + tokB };
  await post("/admin/api/users", { username: "akun-a", password: "password-panjang", tenantId: tA, perms: ["studio.view", "tx.view", "tx.edit"] }, root);
  const A = await login("akun-a", "password-panjang");
  const bpost = (H, rows) => call("/api/photobox/transactions", { method: "POST", headers: H, body: JSON.stringify({ transactions: rows }) });
  const tx = (no, o = {}) => ({ order_no: no, template_name: "Strip 2x6", mode: "photo", method: "qris", amount: 25000, status: "paid", paid_at: "2026-11-19T03:00:00.000Z", created_at: "2026-11-19T02:58:00.000Z", is_test: false, ...o });

  // --- protokol booth ---
  assert((await call("/api/photobox/ping", { headers: HA })).body.studio === "Studio A1");
  assert((await call("/api/photobox/ping")).status === 401, "tanpa token harus 401");
  assert((await call("/api/photobox/transactions", { method: "POST", body: JSON.stringify({ transactions: [] }) })).status === 401);
  const r1 = await bpost(HA, [
    tx("PB-AAAA-261119-0001", { gallery_url: "https://evil.example/phish" }),                              // lunas, nyata (+ URL jahat yang harus diabaikan)
    tx("PB-AAAA-261119-0002", { amount: 10000, is_test: true }),                                           // TEST
    tx("PB-AAAA-261119-0003", { status: "pending", amount: 30000 }),                                       // belum lunas
    tx("PB-AAAA-261119-0004", { method: "voucher", amount: 0, template_name: "=HYPERLINK(\"http://x\",\"klik\")" }), // rumus Excel di nama
    tx("???", {}), tx("PB-AAAA-261119-0005", { amount: -5 }), tx("PB-AAAA-261119-0006", { method: "bitcoin" }),
  ]);
  const res = r1.body.results; assert(res.slice(0, 4).every((x) => x.ok) && res.slice(4).every((x) => !x.ok), "hasil per baris salah: " + JSON.stringify(res));
  assert((await bpost(HA, [tx("PB-AAAA-261119-0001")])).body.results[0].ok, "kirim ulang harus idempoten");
  assert(db.prepare("SELECT COUNT(*) n FROM transactions").get().n === 4, "kirim ulang tidak boleh menggandakan baris");

  // --- isolasi: nomor milik studio lain tidak bisa ditimpa ---
  assert((await bpost(HB, [tx("PB-BBBB-261119-0001", { amount: 50000 })])).body.results[0].ok);
  const steal = await bpost(HA, [tx("PB-BBBB-261119-0001", { amount: 1 })]);
  assert(steal.body.results[0].ok === false && /studio lain/i.test(steal.body.results[0].error), "studio A tidak boleh menimpa transaksi studio B");
  assert(db.prepare("SELECT amount FROM transactions WHERE order_no = 'PB-BBBB-261119-0001'").get().amount === 50000);

  // --- omzet: hanya lunas & bukan TEST ---
  const all = (await call("/admin/api/transactions?from=2026-11-19&to=2026-11-19", {}, root)).body;
  assert.strictEqual(all.summary.revenue, 75000, "omzet = 25000 (A) + 50000 (B), tanpa TEST/pending: " + JSON.stringify(all.summary));
  assert(all.summary.paid === 3 && all.summary.tests === 1 && all.total === 5, JSON.stringify(all.summary) + " total=" + all.total);
  const evil = all.transactions.find((x) => x.orderNo === "PB-AAAA-261119-0001"); assert(evil.galleryUrl === null, "URL dari booth tidak boleh dipakai sebagai link galeri");
  const t0 = Date.now(); db.prepare("INSERT INTO sessions (token, studio, studio_code, mode, created_at, expires_at, tx_no) VALUES ('TOKGALERI9','Studio A1','x','photo',?,?,?)").run(t0, t0 + 86400000, "PB-AAAA-261119-0001");
  assert((await call("/admin/api/transactions?q=0001&studio=studio%20a1", {}, root)).body.transactions[0].galleryUrl === "https://foto.example.com/s/TOKGALERI9", "link galeri dari sesi dengan tx_no sama");

  // --- zona waktu WIB: 17:30Z = 00:30 WIB hari berikutnya ---
  await bpost(HA, [tx("PB-AAAA-261118-0009", { paid_at: "2026-11-18T16:59:00.000Z", amount: 1000 }), tx("PB-AAAA-261119-0010", { paid_at: "2026-11-18T17:30:00.000Z", amount: 2000 })]);
  const daily = (await call("/admin/api/reports/daily?studio=studio%20a1", {}, root)).body.days;
  const byDay = Object.fromEntries(daily.map((d) => [d.date, d.revenue]));
  assert(byDay["2026-11-18"] === 1000 && byDay["2026-11-19"] === 27000, "pengelompokan harian WIB salah: " + JSON.stringify(byDay));
  assert((await call("/admin/api/transactions?from=2026-11-19&to=2026-11-19&studio=studio%20a1", {}, root)).body.summary.revenue === 27000, "rentang tanggal memakai hari WIB");

  // --- akun klien A: hanya miliknya; tidak boleh mengubah catatan keuangan ---
  const me = (await call("/admin/api/me", {}, A)).body; assert(me.perms.includes("tx.view") && !me.perms.includes("tx.edit"), "tx.edit harus dipangkas untuk klien: " + me.perms);
  const mineA = (await call("/admin/api/transactions?limit=100", {}, A)).body;
  assert(mineA.transactions.every((x) => x.studio === "Studio A1") && mineA.summary.revenue === 28000 && !mineA.transactions.some((x) => x.orderNo.startsWith("PB-BBBB")), "klien A tidak boleh melihat transaksi B: " + JSON.stringify(mineA.summary));
  assert((await call("/admin/api/transactions?studio=studio%20b1", {}, A)).body.total === 0, "filter studio klien lain harus kosong");
  assert((await call("/admin/api/reports/daily", {}, A)).body.days.every((d) => !("Studio B1" in d.studios)));
  assert((await post("/admin/api/transactions/PB-BBBB-261119-0001", { test: true }, A)).status === 403, "klien tidak boleh menandai TEST");
  assert((await call("/admin/api/transactions/PB-AAAA-261119-0001", { method: "DELETE" }, A)).status === 403, "klien tidak boleh menghapus transaksi");
  const csv = await fetch(base + "/admin/api/transactions.csv", { headers: { Cookie: A } }); const raw = Buffer.from(await csv.arrayBuffer()); const txt = raw.toString("utf8");
  assert(csv.status === 200 && /text\/csv/.test(csv.headers.get("content-type")) && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf && txt.includes("Waktu,"), "CSV harus ber-BOM (agar Excel membaca UTF-8) & text/csv");
  assert(!txt.includes("PB-BBBB"), "CSV klien A tidak boleh memuat transaksi B");
  assert(txt.includes("\"'=HYPERLINK") || txt.includes("'=HYPERLINK"), "rumus Excel di nama template harus dinetralkan");
  assert(!/(^|,)=HYPERLINK/m.test(txt), "tidak boleh ada sel CSV yang diawali '='");

  // --- koreksi admin ditarik booth ---
  assert((await post("/admin/api/transactions/PB-AAAA-261119-0001", { test: true }, root)).status === 200);
  assert((await call("/admin/api/transactions/PB-AAAA-261119-0002", { method: "DELETE" }, root)).body.deleted === true);
  const after = (await call("/admin/api/transactions?from=2026-11-19&to=2026-11-19&studio=studio%20a1", {}, root)).body;
  assert(after.summary.revenue === 2000 && after.transactions.every((x) => x.orderNo !== "PB-AAAA-261119-0002"), "TEST & hapus harus mengubah omzet: " + JSON.stringify(after.summary));
  const ch = (await call("/api/photobox/changes", { headers: HA })).body;
  const c1 = ch.changes.find((c) => c.order_no === "PB-AAAA-261119-0001"), c2 = ch.changes.find((c) => c.order_no === "PB-AAAA-261119-0002");
  assert(c1 && c1.is_test === true && c1.deleted === false && c1.amount === 25000 && c1.method === "qris", "perubahan TEST harus lengkap (booth menimpa semua kolom): " + JSON.stringify(c1));
  assert(c2 && c2.deleted === true, "hapus harus sampai ke booth");
  assert(!ch.changes.some((c) => c.order_no.startsWith("PB-BBBB")), "booth A tidak boleh menerima perubahan studio B");
  assert((await call(`/api/photobox/changes?since=${ch.cursor}`, { headers: HA })).body.changes.length === 0, "dengan kursor terbaru tidak ada perubahan baru");
  assert((await bpost(HA, [tx("PB-AAAA-261119-0002")])).body.results[0].ok);
  assert(!(await call("/admin/api/transactions?studio=studio%20a1", {}, root)).body.transactions.some((x) => x.orderNo === "PB-AAAA-261119-0002"), "kirim ulang dari booth tidak boleh menghidupkan transaksi yang dihapus");

  // --- klien nonaktif: booth ditolak ---
  await post(`/admin/api/tenants/${tA}`, { active: false }, root);
  assert((await bpost(HA, [tx("PB-AAAA-261119-0050")])).status === 403, "klien nonaktif tidak boleh mengirim transaksi");
  console.log("ok  transaksi: protokol booth idempoten, omzet (TEST/pending dikecualikan), zona WIB, isolasi klien, link galeri aman, CSV aman, koreksi admin ditarik booth, hak klien");
  srv.close(); process.exit(0);
})().catch((e) => { console.error("GAGAL:", e.stack || e.message); process.exit(1); });
