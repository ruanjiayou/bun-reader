import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { log } from "./log";
import * as schema from "./schema";

mkdirSync("data/cache", { recursive: true });
mkdirSync("data/logs", { recursive: true });

export const sqlite = new Database("data/book.db");
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");

const tableExists = (name: string) =>
  !!sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const hasColumn = (table: string, col: string) =>
  (sqlite.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);

// —— 迁移 v1：书籍从「按用户存」改为「全局 + 书架关联」（预览即入库）——
// 旧模型：books 有 user_id，同一本书被多个用户收藏就有多行；progress 只有 book_id。
// 新模型：books 全局唯一 (book_url, source_id)，收藏关系进 shelf，进度按 (user_id, book_id)。
// 存量数据按 (book_url, source_id) 合并：保留章节最多的一行，其余行的书架/进度都迁过去。
function migrateToSharedBooks() {
  if (!tableExists("books") || !hasColumn("books", "user_id")) return false;
  log.info("db", "迁移数据模型 v1：书籍全局化 + shelf 关联 + 进度按用户…");
  sqlite.exec("PRAGMA foreign_keys = OFF");
  try {
    sqlite.exec("BEGIN");
    sqlite.exec(`
      CREATE TABLE books_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      -- 同一本书（同源同地址）只留一行：优先章节多的，其次 id 小的
      INSERT INTO books_new (id, book_url, source_id, name, author, cover, intro, latest_chapter, last_check_at, updated_at, created_at)
      SELECT id, book_url, source_id, name, author, cover, intro, latest_chapter, last_check_at, updated_at, created_at
      FROM books b
      WHERE b.id = (
        SELECT b2.id FROM books b2
        LEFT JOIN (SELECT book_id, COUNT(*) c FROM chapters GROUP BY book_id) ch ON ch.book_id = b2.id
        WHERE IFNULL(b2.book_url, '') = IFNULL(b.book_url, '')
          AND IFNULL(b2.source_id, -1) = IFNULL(b.source_id, -1)
        ORDER BY IFNULL(ch.c, 0) DESC, b2.id ASC LIMIT 1
      );
      -- 书架关联：原来挂在谁名下就进谁的 shelf
      CREATE TABLE IF NOT EXISTS shelf (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, book_id)
      );
      INSERT OR IGNORE INTO shelf (user_id, book_id, created_at)
      SELECT o.user_id, n.id, o.created_at
      FROM books o
      JOIN books_new n ON n.book_url = o.book_url AND IFNULL(n.source_id, -1) = IFNULL(o.source_id, -1);
      -- 进度：补上 user_id
      CREATE TABLE progress_new (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        chapter_idx INTEGER NOT NULL DEFAULT 0,
        scroll_pos INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, book_id)
      );
      INSERT OR REPLACE INTO progress_new (user_id, book_id, chapter_idx, scroll_pos, updated_at)
      SELECT o.user_id, n.id, p.chapter_idx, p.scroll_pos, p.updated_at
      FROM progress p
      JOIN books o ON o.id = p.book_id
      JOIN books_new n ON n.book_url = o.book_url AND IFNULL(n.source_id, -1) = IFNULL(o.source_id, -1);
      -- 被合并掉的重复书籍，其章节一起丢掉（winner 的整表替换时会重抓）
      DELETE FROM chapters WHERE book_id NOT IN (SELECT id FROM books_new);
      DROP TABLE books;
      ALTER TABLE books_new RENAME TO books;
      DROP TABLE progress;
      ALTER TABLE progress_new RENAME TO progress;
      CREATE UNIQUE INDEX IF NOT EXISTS books_url_src ON books(book_url, source_id);
      PRAGMA user_version = 1;
    `);
    sqlite.exec("COMMIT");
    const bad = sqlite.query("PRAGMA foreign_key_check").all();
    if (bad.length) log.warn("db", `迁移后外键检查有 ${bad.length} 条异常（已尽量修复，如遇 404 请重建对应书籍）`);
    log.info("db", "迁移完成");
  } catch (e: any) {
    sqlite.exec("ROLLBACK");
    log.error("db", `迁移失败，已回滚：${e?.message ?? e}`);
    throw e;
  } finally {
    sqlite.exec("PRAGMA foreign_keys = ON");
  }
  return true;
}
migrateToSharedBooks();

// —— 迁移 v2→v3：books.finished（布尔）→ status（整数枚举，0 连载/1 完结/2 太监断更/3 下架）——
// finished=1 平移成 status=1，finished=0 平移成 0，语义不丢；以后加状态只扩常量、不动表结构。
// RENAME COLUMN 要求 SQLite ≥3.25（Bun 内置版本满足）；幂等：hasColumn 判存在，新库走下面的 CREATE 已有列。
if (tableExists("books")) {
  if (hasColumn("books", "finished") && !hasColumn("books", "status")) {
    sqlite.exec("ALTER TABLE books RENAME COLUMN finished TO status");
    log.info("db", "迁移：books.finished → status（值平移 0/1）");
  } else if (!hasColumn("books", "status")) {
    sqlite.exec("ALTER TABLE books ADD COLUMN status INTEGER NOT NULL DEFAULT 0");
    log.info("db", "迁移：books 加 status 列");
  }
}

// —— 迁移 v4：shelf.group（书架分组，用户级）——
// 书源分组只作默认值；分组是「我的书架」的属性（books 全局共享，一个用户改不能影响别人）。
// 存量行回填成各自书源的分组，源已删/未绑定则归「默认」；只在首次加列时执行，不会覆盖之后用户手改的值。
if (tableExists("shelf") && !hasColumn("shelf", "group")) {
  sqlite.exec(`ALTER TABLE shelf ADD COLUMN "group" TEXT NOT NULL DEFAULT '默认'`);
  sqlite.exec(`
    UPDATE shelf SET "group" = COALESCE(
      (SELECT s."group" FROM books b JOIN sources s ON s.id = b.source_id WHERE b.id = shelf.book_id),
      '默认'
    )
  `);
  log.info("db", "迁移：shelf 加 group 列，并按书源分组回填存量书架");
}

// ponytail: drizzle-kit 在 Windows 下 push 需要原生驱动，改为启动时幂等建表；
// 表结构为唯一事实来源——加列直接改下面的 CREATE TABLE（存量库靠上面的迁移推进版本）。
sqlite.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nickname TEXT,
  avatar TEXT,
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
  book_url TEXT NOT NULL,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  intro TEXT NOT NULL DEFAULT '',
  latest_chapter TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0,
  last_check_at INTEGER,
  updated_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS books_url_src ON books(book_url, source_id);
CREATE TABLE IF NOT EXISTS shelf (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  "group" TEXT NOT NULL DEFAULT '默认',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, book_id)
);
CREATE INDEX IF NOT EXISTS shelf_book ON shelf(book_id);
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
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chapter_idx INTEGER NOT NULL DEFAULT 0,
  scroll_pos INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, book_id)
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
// 后台任务仅存在于当前进程内；服务重启后将残留的 running 状态标记为已停止。
sqlite.query("UPDATE cache_jobs SET status = 'stopped', updated_at = ? WHERE status = 'running'").run(Date.now());

export const db = drizzle(sqlite, { schema });
