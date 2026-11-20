const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "gallery.db"));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS buckets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'auto',
  bucket TEXT NOT NULL,
  access_key TEXT NOT NULL,
  secret_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 10,
  quota_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  studio TEXT NOT NULL,
  studio_code TEXT,
  mode TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_file_at INTEGER
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  fid TEXT NOT NULL,
  kind TEXT NOT NULL,
  idx INTEGER NOT NULL DEFAULT 0,
  ext TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  bucket_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  uploaded_at INTEGER,
  UNIQUE(token, fid)
);
CREATE INDEX IF NOT EXISTS idx_files_token ON files(token);
-- Objek di cloud yang sudah tidak dipakai (mis. file dipindah ke bucket lain saat retry): dihapus berkala, dicoba ulang kalau bucket sedang bermasalah.
CREATE TABLE IF NOT EXISTS trash (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  UNIQUE(bucket_id, key)
);

CREATE INDEX IF NOT EXISTS idx_files_bucket ON files(bucket_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);
`);

try { db.exec("ALTER TABLE sessions ADD COLUMN manual INTEGER NOT NULL DEFAULT 0"); } catch { /* sudah ada */ }
// Izin foto dari tamu: bit 1 = boleh di sosmed, bit 2 = boleh dipajang di mading (3 = keduanya, 0 = tidak, NULL = belum dijawab)
try { db.exec("ALTER TABLE sessions ADD COLUMN social INTEGER"); } catch { /* sudah ada */ }
// Nomor transaksi photobox/kasir (PB-<studio>-<tanggal>-<urut>): supaya satu sesi bisa dilacak dengan DUA kode: kode link (token) dan nomor transaksi.
// Tidak unik di tingkat tabel (unggah manual bisa terlanjur membuat link kembar); kembar ditandai di daftar link.
try { db.exec("ALTER TABLE sessions ADD COLUMN tx_no TEXT"); } catch { /* sudah ada */ }
try { db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_tx ON sessions(tx_no)"); } catch { /* abaikan */ }

// Daftar studio yang dikenal galeri. Sumber nama & token tetap KASIR; di sini hanya status pantauan + pengaturan sisi galeri.
db.exec(`CREATE TABLE IF NOT EXISTS studios (
  skey TEXT PRIMARY KEY,            -- nama huruf kecil (Emma = emma)
  name TEXT NOT NULL,               -- nama tampilan
  note TEXT NOT NULL DEFAULT '',
  blocked INTEGER NOT NULL DEFAULT 0,
  retention_days INTEGER,           -- NULL = ikut pengaturan umum
  name_locked INTEGER NOT NULL DEFAULT 0, -- 1 = nama diubah admin, jangan ikut berubah otomatis dari kasir
  token_hash TEXT,
  first_seen_at INTEGER, last_seen_at INTEGER, last_ip TEXT, last_event TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_studios_token ON studios(token_hash);`);
// Isi dari sesi yang sudah ada (aman diulang): nama terbaru jadi nama tampilan
db.exec(`INSERT OR IGNORE INTO studios (skey, name, created_at, first_seen_at, last_seen_at)
  SELECT lower(trim(studio)), studio, MIN(created_at), MIN(created_at), NULL FROM sessions WHERE trim(studio) <> '' GROUP BY lower(trim(studio))`);

for (const ddl of [
  "ALTER TABLE buckets ADD COLUMN health TEXT NOT NULL DEFAULT ''",      // '' belum dites | ok | bad
  "ALTER TABLE buckets ADD COLUMN health_msg TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE buckets ADD COLUMN health_at INTEGER",
  "ALTER TABLE buckets ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE studios ADD COLUMN sync_json TEXT",                       // laporan sinkron dari booth (denyut)
  "ALTER TABLE studios ADD COLUMN sync_at INTEGER",
  "ALTER TABLE studios ADD COLUMN tenant_id INTEGER",                    // klien pemilik studio (NULL = belum dibagikan; hanya terlihat super admin)
]) { try { db.exec(ddl); } catch { /* sudah ada */ } }

const getSetting = (k, def) => { const r = db.prepare("SELECT v FROM settings WHERE k = ?").get(k); return r ? r.v : def; };
const setSetting = (k, v) => db.prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, String(v));
const retentionDays = () => Math.max(1, Math.min(365, Number(getSetting("retention_days", process.env.RETENTION_DAYS || 7)) || 7));

// Akun pengguna admin (selain akun ADMIN_USER di .env yang selalu admin penuh). role: 'admin' = akses penuh, 'staff' = sesuai perms.
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '',
  pass_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff', perms TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_login_at INTEGER)`);

// ---- Platform multi-klien ----
// Klien (tenant) = pelanggan Anda; punya banyak studio. Akun dengan tenant_id hanya bisa melihat & mengelola studio klien itu.
db.exec(`CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, note TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
-- Token booth diterbitkan platform: satu per booth, hanya hash yang disimpan, bisa dicabut satu per satu.
CREATE TABLE IF NOT EXISTS booth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT, skey TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_booth_tokens_skey ON booth_tokens(skey);`);
try { db.exec("ALTER TABLE users ADD COLUMN tenant_id INTEGER"); } catch { /* sudah ada */ }
try { db.exec("CREATE INDEX IF NOT EXISTS idx_studios_tenant ON studios(tenant_id)"); } catch { /* abaikan */ }

// ---- Riwayat transaksi (dikirim booth lewat protokol /api/photobox/*; menggantikan aplikasi kasir) ----
db.exec(`CREATE TABLE IF NOT EXISTS transactions (
  order_no TEXT PRIMARY KEY,                 -- PB-<KODE>-<YYMMDD>-<URUT> (dibuat booth)
  skey TEXT NOT NULL,                        -- studio pemilik (dari token booth, bukan dari isi kiriman)
  template_id TEXT, template_name TEXT, category TEXT, mode TEXT, method TEXT, voucher_code TEXT,
  amount INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'paid',
  created_ms INTEGER, paid_ms INTEGER, session_id TEXT, meta_json TEXT,
  is_test INTEGER NOT NULL DEFAULT 0,        -- tanda dari booth (uang simulasi / sandbox)
  admin_test INTEGER,                        -- koreksi admin: NULL = ikut booth, 1 = TEST, 0 = bukan TEST
  deleted_at INTEGER,                        -- dihapus admin (baris tetap ada supaya nomor tidak dipakai ulang)
  admin_changed_ms INTEGER,                  -- kapan admin terakhir mengubah (booth menarik perubahan lewat /changes)
  received_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tx_skey_paid ON transactions(skey, paid_ms);
CREATE INDEX IF NOT EXISTS idx_tx_changed ON transactions(skey, admin_changed_ms);`);

module.exports = { db, getSetting, setSetting, retentionDays, DATA_DIR };
