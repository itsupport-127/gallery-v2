// ==========================================================
// Riwayat transaksi & omzet.
//  - API booth (token booth): /api/photobox/ping | /transactions | /changes  — protokol yang SUDAH dipakai booth sejak era aplikasi kasir,
//    jadi booth tidak perlu diubah: cukup arahkan "alamat kasir" ke galeri ini dan pakai token platform.
//  - API admin (cookie login): daftar, ringkasan & omzet harian, ekspor CSV, tandai TEST / hapus.
// Isolasi: studio pemilik transaksi SELALU diambil dari token booth. Akun klien hanya melihat transaksi studio klien itu.
// ==========================================================
const TZ_MIN = Number.isFinite(Number(process.env.REPORT_TZ_OFFSET_MIN)) && process.env.REPORT_TZ_OFFSET_MIN !== undefined && process.env.REPORT_TZ_OFFSET_MIN !== "" ? Number(process.env.REPORT_TZ_OFFSET_MIN) : 420; // WIB
const ORDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{3,39}$/;
const STATUSES = new Set(["paid", "pending", "expired", "failed", "cancelled"]);
const METHODS = new Set(["qris", "voucher", "free"]);
const cut = (v, n) => (v == null ? null : String(v).replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, n) || null);
const ms = (v) => { if (v == null || v === "") return null; const t = typeof v === "number" ? v : Date.parse(String(v)); return Number.isFinite(t) && t > 1.4e12 && t < 4.1e12 ? Math.round(t) : null; };
const ymd = (t) => new Date(t + TZ_MIN * 60000).toISOString().slice(0, 10);
const dayStart = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || "")); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) - TZ_MIN * 60000 : null; };
const EFF_TEST = "COALESCE(t.admin_test, t.is_test)";
const WHEN = "COALESCE(t.paid_ms, t.created_ms, t.received_ms)";

module.exports = function mountTx(app, d) {
  const { db, auth, adminAuth, need, tid, studioGuard, skey, now, PUBLIC_URL } = d;

  // ---------------- API booth ----------------
  const boothAuth = async (req, res, event) => {
    try {
      const a = await auth.verify((req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
      if (!a) { res.status(401).json({ ok: false, error: "Token tidak valid." }); return null; }
      const st = studioGuard(a, req, res, event); if (!st) return null;
      return st;
    } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message }); return null; }
  };
  app.get("/api/photobox/ping", async (req, res) => { const st = await boothAuth(req, res, "ping"); if (st) res.json({ ok: true, studio: st.name }); });

  function upsert(st, x) {
    const orderNo = String(x?.order_no || "").trim().toUpperCase();
    if (!ORDER_RE.test(orderNo)) return { order_no: x?.order_no, ok: false, error: "Nomor transaksi tidak valid." };
    const status = STATUSES.has(x.status) ? x.status : null, method = METHODS.has(x.method) ? x.method : null;
    if (!status || !method) return { order_no: orderNo, ok: false, error: "Status atau metode tidak dikenal." };
    const amount = Math.round(Number(x.amount)); if (!Number.isFinite(amount) || amount < 0 || amount > 1e9) return { order_no: orderNo, ok: false, error: "Nominal tidak valid." };
    const meta = x.meta && typeof x.meta === "object" ? JSON.stringify(x.meta).slice(0, 1000) : null, t = now();
    const cur = db.prepare("SELECT skey FROM transactions WHERE order_no = ?").get(orderNo);
    if (cur && cur.skey !== st.skey) return { order_no: orderNo, ok: false, error: "Nomor transaksi milik studio lain." };
    const vals = [cut(x.template_id, 60), cut(x.template_name, 100), cut(x.category, 40), cut(x.mode, 20), method, cut(x.voucher_code, 40), amount, status, ms(x.created_at), ms(x.paid_at), cut(x.session_id, 80), meta, x.is_test ? 1 : 0, t];
    if (cur) db.prepare("UPDATE transactions SET template_id=?, template_name=?, category=?, mode=?, method=?, voucher_code=?, amount=?, status=?, created_ms=COALESCE(?, created_ms), paid_ms=COALESCE(?, paid_ms), session_id=?, meta_json=?, is_test=?, updated_ms=? WHERE order_no = ?").run(...vals, orderNo);
    else db.prepare("INSERT INTO transactions (template_id, template_name, category, mode, method, voucher_code, amount, status, created_ms, paid_ms, session_id, meta_json, is_test, updated_ms, order_no, skey, received_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(...vals, orderNo, st.skey, t);
    return { order_no: orderNo, ok: true };
  }
  app.post("/api/photobox/transactions", async (req, res) => {
    const st = await boothAuth(req, res, "tx"); if (!st) return;
    const list = Array.isArray(req.body?.transactions) ? req.body.transactions : null;
    if (!list || list.length > 100) return res.status(400).json({ ok: false, error: "Daftar transaksi tidak valid (maks. 100)." });
    res.json({ ok: true, results: list.map((x) => upsert(st, x)) });
  });
  // Perubahan dari admin (hapus / tandai TEST) ditarik booth supaya angka booth = platform. Kursor = waktu ubah (ms).
  app.get("/api/photobox/changes", async (req, res) => {
    const st = await boothAuth(req, res, "tx"); if (!st) return;
    const since = Math.max(0, Number(req.query.since) || 0);
    const rows = db.prepare("SELECT t.* FROM transactions t WHERE t.skey = ? AND t.admin_changed_ms > ? ORDER BY t.admin_changed_ms ASC LIMIT 200").all(st.skey, since);
    const changes = rows.map((r) => ({ order_no: r.order_no, deleted: !!r.deleted_at, is_test: !!(r.admin_test ?? r.is_test), template_name: r.template_name, method: r.method, amount: r.amount, status: r.status, paid_at: r.paid_ms ? new Date(r.paid_ms).toISOString() : null, changed_at: new Date(r.admin_changed_ms).toISOString() }));
    res.set("Cache-Control", "no-store").json({ ok: true, changes, cursor: rows.length ? String(rows[rows.length - 1].admin_changed_ms) : String(since || "") });
  });
  app.post("/api/photobox/discount/quote", (_req, res) => res.status(404).json({ ok: false, error: "Diskon dari platform belum tersedia." }));

  // ---------------- API admin ----------------
  /** Kondisi WHERE dari query: akses klien, rentang tanggal (zona waktu laporan), studio, status, pencarian. */
  function filters(req) {
    const w = ["t.deleted_at IS NULL"], a = [];
    const t = tid(req); if (t) { w.push("t.skey IN (SELECT skey FROM studios WHERE tenant_id = ?)"); a.push(t); }
    const q = req.query || {};
    const from = dayStart(q.from), to = dayStart(q.to);
    if (from != null) { w.push(`${WHEN} >= ?`); a.push(from); }
    if (to != null) { w.push(`${WHEN} < ?`); a.push(to + 86400000); }
    if (q.studio) { w.push("t.skey = ?"); a.push(skey(q.studio)); }
    if (q.status && STATUSES.has(String(q.status))) { w.push("t.status = ?"); a.push(String(q.status)); }
    if (q.method && METHODS.has(String(q.method))) { w.push("t.method = ?"); a.push(String(q.method)); }
    const s = String(q.q || "").trim().slice(0, 60);
    if (s) { const e = s.replace(/[\\%_]/g, (c) => "\\" + c); w.push("(t.order_no LIKE ? ESCAPE '\\' COLLATE NOCASE OR t.template_name LIKE ? ESCAPE '\\')"); a.push(`%${e}%`, `%${e}%`); }
    return { where: "WHERE " + w.join(" AND "), args: a };
  }
  const REAL = `t.status = 'paid' AND ${EFF_TEST} = 0`; // omzet nyata: lunas & bukan TEST
  const row = (r) => ({ orderNo: r.order_no, studio: r.studio_name, tenant: r.tenant_name || "", template: r.template_name || "", mode: r.mode || "", method: r.method, amount: r.amount, status: r.status, test: !!(r.admin_test ?? r.is_test), testByAdmin: r.admin_test != null, at: r.paid_ms || r.created_ms || r.received_ms,
    galleryUrl: r.gal_token && PUBLIC_URL() ? `${PUBLIC_URL()}/s/${r.gal_token}` : null });
  const SEL = `SELECT t.*, st.name studio_name, (SELECT name FROM tenants WHERE id = st.tenant_id) tenant_name, (SELECT token FROM sessions s WHERE s.tx_no = t.order_no ORDER BY s.created_at LIMIT 1) gal_token FROM transactions t JOIN studios st ON st.skey = t.skey`;

  app.get("/admin/api/transactions", adminAuth, need("tx.view"), (req, res) => {
    const { where, args } = filters(req), limit = Math.max(1, Math.min(100, Number(req.query.limit) || 30)), offset = Math.max(0, Number(req.query.offset) || 0);
    const J = "FROM transactions t JOIN studios st ON st.skey = t.skey";
    const sum = db.prepare(`SELECT COALESCE(SUM(CASE WHEN ${REAL} THEN t.amount END),0) revenue, COALESCE(SUM(${REAL}),0) paid, COALESCE(SUM(t.status = 'paid' AND ${EFF_TEST} = 1),0) tests, COUNT(*) total ${J} ${where}`).get(...args);
    const byMethod = db.prepare(`SELECT t.method, COUNT(*) n, COALESCE(SUM(t.amount),0) amount ${J} ${where} AND ${REAL} GROUP BY t.method`).all(...args);
    const rows = db.prepare(`${SEL} ${where} ORDER BY ${WHEN} DESC, t.order_no DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    res.set("Cache-Control", "no-store").json({ tzOffsetMin: TZ_MIN, total: sum.total, summary: { revenue: sum.revenue, paid: sum.paid, tests: sum.tests, avg: sum.paid ? Math.round(sum.revenue / sum.paid) : 0, byMethod }, transactions: rows.map(row) });
  });
  // Omzet per hari (+ per studio bila lebih dari satu), zona waktu laporan.
  app.get("/admin/api/reports/daily", adminAuth, need("tx.view"), (req, res) => {
    const { where, args } = filters(req);
    const rows = db.prepare(`SELECT st.name studio, ${WHEN} w, t.amount FROM transactions t JOIN studios st ON st.skey = t.skey ${where} AND ${REAL}`).all(...args);
    const days = new Map();
    for (const r of rows) { const k = ymd(r.w); const e = days.get(k) || { date: k, revenue: 0, count: 0, studios: {} }; e.revenue += r.amount; e.count++; e.studios[r.studio] = (e.studios[r.studio] || 0) + r.amount; days.set(k, e); }
    res.set("Cache-Control", "no-store").json({ tzOffsetMin: TZ_MIN, days: [...days.values()].sort((a, b) => (a.date < b.date ? 1 : -1)) });
  });
  const csvCell = (v) => { let s = v == null ? "" : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }; // awalan ' menahan rumus Excel dari data booth
  app.get("/admin/api/transactions.csv", adminAuth, need("tx.view"), (req, res) => {
    const { where, args } = filters(req);
    const rows = db.prepare(`${SEL} ${where} ORDER BY ${WHEN} ASC, t.order_no ASC LIMIT 50000`).all(...args).map(row);
    const loc = (t) => new Date(t + TZ_MIN * 60000).toISOString().slice(0, 19).replace("T", " ");
    const lines = [["Waktu", "No transaksi", "Klien", "Studio", "Template / mode", "Metode", "Nominal", "Status", "TEST", "Link galeri"].join(",")]
      .concat(rows.map((r) => [loc(r.at), r.orderNo, r.tenant, r.studio, r.template || r.mode, r.method, r.amount, r.status, r.test ? "ya" : "", r.galleryUrl || ""].map(csvCell).join(",")));
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="transaksi-${ymd(now())}.csv"`, "Cache-Control": "no-store" }).send("\ufeff" + lines.join("\r\n") + "\r\n");
  });
  // Koreksi admin (hanya yang punya tx.edit; akun klien tidak pernah): tandai TEST / hapus. Booth menarik perubahan ini lewat /changes.
  const mine = (req, orderNo) => { const t = tid(req); const r = db.prepare(`SELECT t.order_no FROM transactions t JOIN studios st ON st.skey = t.skey WHERE t.order_no = ? AND t.deleted_at IS NULL ${t ? "AND st.tenant_id = ?" : ""}`).get(String(orderNo).toUpperCase(), ...(t ? [t] : [])); return r ? r.order_no : null; };
  app.post("/admin/api/transactions/:no", adminAuth, need("tx.edit"), (req, res) => {
    const no = mine(req, req.params.no); if (!no) return res.status(404).json({ error: "Transaksi tidak ditemukan." });
    const v = req.body?.test; if (v !== true && v !== false && v !== null) return res.status(400).json({ error: "Nilai 'test' harus true, false, atau null." });
    db.prepare("UPDATE transactions SET admin_test = ?, admin_changed_ms = ? WHERE order_no = ?").run(v === null ? null : v ? 1 : 0, now(), no);
    res.json({ ok: true });
  });
  app.delete("/admin/api/transactions/:no", adminAuth, need("tx.edit"), (req, res) => {
    const no = mine(req, req.params.no); if (!no) return res.json({ ok: true, deleted: true });
    db.prepare("UPDATE transactions SET deleted_at = ?, admin_changed_ms = ? WHERE order_no = ?").run(now(), now(), no);
    res.json({ ok: true, deleted: true });
  });
};
