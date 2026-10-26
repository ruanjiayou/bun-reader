import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

mkdirSync("data/cache", { recursive: true });
mkdirSync("data/logs", { recursive: true });

export const sqlite = new Database("data/book.db");
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");

// ponytail: drizzle-kit 在 Windows 下 push 需要原生驱动，改为启动时幂等建表；
// 加列时在此处补 ALTER ... IF NOT EXISTS 语义（SQLite 无 ADD COLUMN IF NOT EXISTS，用 try/catch）
sqlite.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  book_url TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  "group" TEXT NOT NULL DEFAULT '默认',
  json TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'rules',
  code TEXT,
  last_use_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_url TEXT NOT NULL,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  intro TEXT NOT NULL DEFAULT '',
  latest_chapter TEXT NOT NULL DEFAULT '',
  last_check_at INTEGER,
  updated_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS books_user_book_src ON books(user_id, book_url, source_id);
CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS chapters_book_idx ON chapters(book_id, idx);
CREATE TABLE IF NOT EXISTS chapter_cache (
  content_key TEXT NOT NULL,
  idx INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  is_placeholder INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS cache_key_idx ON chapter_cache(content_key, idx);
-- 全本缓存任务：按 content_key(sha1(bookUrl)) 共享，多用户加同一本书共用一个任务
CREATE TABLE IF NOT EXISTS cache_jobs (
  content_key TEXT PRIMARY KEY,
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS progress (
  book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  chapter_idx INTEGER NOT NULL DEFAULT 0,
  scroll_pos INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
-- 缓存自适应限速状态：按书源维度学习（失败减半、整窗无错收敛），重启后沿用
CREATE TABLE IF NOT EXISTS rate_states (
  source_id INTEGER PRIMARY KEY,
  cap INTEGER NOT NULL DEFAULT 0,      -- 窗口内允许的成功请求数；0 = 不限速
  high INTEGER NOT NULL DEFAULT 0,     -- 最近一次降频前的频率（收敛上限）
  window_ms INTEGER NOT NULL DEFAULT 60000,
  last_fail_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS settings_user_key ON settings(user_id, key);
`);
// 脚本引擎（M2 v2）：存量库补列（SQLite 无 ADD COLUMN IF NOT EXISTS，幂等靠 try/catch）
try {
  sqlite.exec("ALTER TABLE sources ADD COLUMN type TEXT NOT NULL DEFAULT 'rules'");
} catch {}
try {
  sqlite.exec("ALTER TABLE sources ADD COLUMN code TEXT");
} catch {}
// 书籍内容更新时间（书架「最近更新」排序）：存量库补列并回填一次（用 last_check_at 或 created_at 兜底）
try {
  sqlite.exec("ALTER TABLE books ADD COLUMN updated_at INTEGER");
  sqlite.exec("UPDATE books SET updated_at = COALESCE(last_check_at, created_at) WHERE updated_at IS NULL");
} catch {}

export const db = drizzle(sqlite, { schema });
