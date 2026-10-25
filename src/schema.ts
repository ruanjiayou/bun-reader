import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const sources = sqliteTable("sources", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  bookUrl: text("book_url").notNull().default(""),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  group: text("group").notNull().default("默认"),
  json: text("json").notNull(),
  // script 引擎（M2 v2）：rules=规则表单（保存时生成 js 代码），script=直接编辑 class
  type: text("type").notNull().default("rules"),
  code: text("code"), // type=script 时的用户代码；type=rules 时存转换器生成的只读代码
  lastUseAt: integer("last_use_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const books = sqliteTable(
  "books",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookUrl: text("book_url").notNull(),
    sourceId: integer("source_id").references(() => sources.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    author: text("author").notNull().default(""),
    cover: text("cover").notNull().default(""),
    intro: text("intro").notNull().default(""),
    latestChapter: text("latest_chapter").notNull().default(""),
    lastCheckAt: integer("last_check_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("books_user_book_src").on(t.userId, t.bookUrl, t.sourceId)],
);

export const chapters = sqliteTable(
  "chapters",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bookId: integer("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
  },
  (t) => [uniqueIndex("chapters_book_idx").on(t.bookId, t.idx)],
);

// ponytail: 全局共享正文索引，文件在 data/cache/{contentKey}/{idx}.txt；LRU 清理加缓存体积明显膨胀后
export const chapterCache = sqliteTable(
  "chapter_cache",
  {
    contentKey: text("content_key").notNull(),
    idx: integer("idx").notNull(),
    filePath: text("file_path").notNull(),
    size: integer("size").notNull().default(0),
    isPlaceholder: integer("is_placeholder", { mode: "boolean" }).notNull().default(false),
    fetchedAt: integer("fetched_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("cache_key_idx").on(t.contentKey, t.idx)],
);

export const progress = sqliteTable(
  "progress",
  {
    bookId: integer("book_id")
      .primaryKey()
      .references(() => books.id, { onDelete: "cascade" }),
    chapterIdx: integer("chapter_idx").notNull().default(0),
    scrollPos: integer("scroll_pos").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
);

export const settings = sqliteTable(
  "settings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull().default(""),
  },
  (t) => [uniqueIndex("settings_user_key").on(t.userId, t.key)],
);
