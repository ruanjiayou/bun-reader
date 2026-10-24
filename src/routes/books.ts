import { Hono } from "hono";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { books, chapters, chapterCache, progress, sources } from "../schema";
import { getBookInfo, getToc, getContent, isPlaceholder } from "../source/engine";
import { normalizeSource } from "../source/rule";
import type { AuthEnv } from "../auth";

export const bookRoutes = new Hono<AuthEnv>();

const contentKey = (bookUrl: string) => createHash("sha1").update(bookUrl).digest("hex");
const cacheDir = (key: string) => `data/cache/${key}`;

async function loadEngine(sourceId: number | null) {
  if (!sourceId) throw new Error("书籍未绑定书源");
  const [row] = await db.select().from(sources).where(eq(sources.id, sourceId));
  if (!row) throw new Error("书源已删除");
  return normalizeSource(JSON.parse(row.json));
}

// 抓详情+目录并写入章节快照（加书架与刷新共用）
async function snapshotToc(eng: any, bookUrl: string) {
  const info = await getBookInfo(eng, bookUrl);
  const toc = await getToc(eng, info.tocUrl);
  if (!toc.length) throw new Error("目录为空");
  return { info, toc };
}

// 加书架：抓详情 → 目录快照 → 落库（同 user+bookUrl+source 幂等）
bookRoutes.post("/", async (c) => {
  const uid = c.get("uid");
  const body = await c.req.json<{ bookUrl?: string; sourceId?: number }>().catch(() => ({}) as any);
  const { bookUrl, sourceId } = body;
  if (!bookUrl || !sourceId) return c.json({ error: "缺少 bookUrl/sourceId" }, 400);
  const eng = await loadEngine(sourceId);
  const { info, toc } = await snapshotToc(eng, bookUrl);

  const [existing] = await db
    .select()
    .from(books)
    .where(and(eq(books.userId, uid), eq(books.bookUrl, bookUrl), eq(books.sourceId, sourceId)));
  let bookId: number;
  if (existing) {
    bookId = existing.id;
    await db
      .update(books)
      .set({ name: info.name || existing.name, author: info.author, cover: info.cover, intro: info.intro, latestChapter: info.latestChapter, lastCheckAt: new Date() })
      .where(eq(books.id, bookId));
    await db.delete(chapters).where(eq(chapters.bookId, bookId));
  } else {
    const [row] = await db
      .insert(books)
      .values({ userId: uid, bookUrl, sourceId, name: info.name || "未知书名", author: info.author, cover: info.cover, intro: info.intro, latestChapter: info.latestChapter, lastCheckAt: new Date() })
      .returning({ id: books.id });
    bookId = row.id;
  }
  await db.insert(chapters).values(toc.map((ch, i) => ({ bookId, idx: i, title: ch.title, url: ch.url })));
  return c.json({ id: bookId, name: info.name, chapterCount: toc.length });
});

// 书架列表：书 + 进度 + 章节数
bookRoutes.get("/", async (c) => {
  const uid = c.get("uid");
  const rows = await db.select().from(books).where(eq(books.userId, uid));
  if (!rows.length) return c.json([]);
  const ids = rows.map((r) => r.id);
  const progs = await db.select().from(progress).where(inArray(progress.bookId, ids));
  const progMap = new Map(progs.map((p) => [p.bookId, p]));
  const counts = await db
    .select({ bookId: chapters.bookId, n: chapters.id })
    .from(chapters)
    .where(inArray(chapters.bookId, ids));
  const countMap = new Map<number, number>();
  for (const r of counts) countMap.set(r.bookId, (countMap.get(r.bookId) ?? 0) + 1);
  return c.json(
    rows.map((b) => ({
      ...b,
      chapterCount: countMap.get(b.id) ?? 0,
      progress: progMap.get(b.id) ? { chapterIdx: progMap.get(b.id)!.chapterIdx, updatedAt: progMap.get(b.id)!.updatedAt } : null,
    })),
  );
});

// 刷新书：重抓详情+目录，更新快照（新增章节保留章节号连续性：直接整表替换，idx 即序号）
bookRoutes.put("/:id/refresh", async (c) => {
  const uid = c.get("uid");
  const bookId = Number(c.req.param("id"));
  const [book] = await db.select().from(books).where(and(eq(books.id, bookId), eq(books.userId, uid)));
  if (!book) return c.json({ error: "书籍不存在" }, 404);
  const eng = await loadEngine(book.sourceId);
  const { info, toc } = await snapshotToc(eng, book.bookUrl);
  const oldCount = (await db.select().from(chapters).where(eq(chapters.bookId, bookId))).length;
  await db.delete(chapters).where(eq(chapters.bookId, bookId));
  await db.insert(chapters).values(toc.map((ch, i) => ({ bookId, idx: i, title: ch.title, url: ch.url })));
  await db
    .update(books)
    .set({ name: info.name || book.name, author: info.author, cover: info.cover, intro: info.intro, latestChapter: info.latestChapter || book.latestChapter, lastCheckAt: new Date() })
    .where(eq(books.id, bookId));
  return c.json({ chapterCount: toc.length, added: Math.max(0, toc.length - oldCount), oldCount });
});

bookRoutes.delete("/:id", async (c) => {
  const uid = c.get("uid");
  const bookId = Number(c.req.param("id"));
  const [book] = await db.select().from(books).where(and(eq(books.id, bookId), eq(books.userId, uid)));
  if (!book) return c.json({ error: "书籍不存在" }, 404);
  await db.delete(books).where(eq(books.id, bookId)); // chapters/progress 级联
  return c.json({ ok: true });
});

// 书籍详情 + 进度
bookRoutes.get("/:id", async (c) => {
  const uid = c.get("uid");
  const bookId = Number(c.req.param("id"));
  const [book] = await db.select().from(books).where(and(eq(books.id, bookId), eq(books.userId, uid)));
  if (!book) return c.json({ error: "书籍不存在" }, 404);
  const [prog] = await db.select().from(progress).where(eq(progress.bookId, bookId));
  return c.json({
    ...book,
    progress: prog ? { chapterIdx: prog.chapterIdx, scrollPos: prog.scrollPos, updatedAt: prog.updatedAt } : null,
  });
});

// 目录（章节快照），?refresh=1 强制重抓
bookRoutes.get("/:id/category", async (c) => {
  const uid = c.get("uid");
  const bookId = Number(c.req.param("id"));
  const [book] = await db.select().from(books).where(and(eq(books.id, bookId), eq(books.userId, uid)));
  if (!book) return c.json({ error: "书籍不存在" }, 404);
  if (c.req.query("refresh")) {
    const eng = await loadEngine(book.sourceId);
    const { info, toc } = await snapshotToc(eng, book.bookUrl);
    const old = await db.select().from(chapters).where(eq(chapters.bookId, bookId));
    await db.delete(chapters).where(eq(chapters.bookId, bookId));
    await db.insert(chapters).values(toc.map((ch, i) => ({ bookId, idx: i, title: ch.title, url: ch.url })));
    await db.update(books).set({ latestChapter: info.latestChapter || book.latestChapter, lastCheckAt: new Date() }).where(eq(books.id, bookId));
  }
  const list = await db.select({ idx: chapters.idx, title: chapters.title }).from(chapters).where(eq(chapters.bookId, bookId));
  list.sort((a, b) => a.idx - b.idx);
  const [prog] = await db.select().from(progress).where(eq(progress.bookId, bookId));
  return c.json({ book: { id: book.id, name: book.name, author: book.author }, chapters: list, progress: prog ? { chapterIdx: prog.chapterIdx } : null });
});

// 正文：磁盘缓存优先，未命中抓取→落盘→入库索引；?refresh=1 绕过缓存
bookRoutes.get("/:id/content/:idx", async (c) => {
  const uid = c.get("uid");
  const bookId = Number(c.req.param("id"));
  const idx = Number(c.req.param("idx"));
  const refresh = !!c.req.query("refresh");
  const [book] = await db.select().from(books).where(and(eq(books.id, bookId), eq(books.userId, uid)));
  if (!book) return c.json({ error: "书籍不存在" }, 404);
  const [ch] = await db.select().from(chapters).where(and(eq(chapters.bookId, bookId), eq(chapters.idx, idx)));
  if (!ch) return c.json({ error: "章节不存在" }, 404);

  const key = contentKey(book.bookUrl);
  const [cached] = refresh
    ? []
    : await db.select().from(chapterCache).where(and(eq(chapterCache.contentKey, key), eq(chapterCache.idx, idx)));
  if (cached && existsSync(cached.filePath)) {
    const content = readFileSync(cached.filePath, "utf-8");
    return c.json({ idx, title: ch.title, content, isPlaceholder: cached.isPlaceholder, cached: true });
  }

  const eng = await loadEngine(book.sourceId);
  const raw = await getContent(eng, ch.url);
  if (!raw.trim()) return c.json({ error: "正文抓取为空" }, 502);
  mkdirSync(cacheDir(key), { recursive: true });
  const filePath = `${cacheDir(key)}/${idx}.txt`;
  writeFileSync(filePath, raw);
  const ph = isPlaceholder(raw);
  await db
    .insert(chapterCache)
    .values({ contentKey: key, idx, filePath, size: raw.length, isPlaceholder: ph, fetchedAt: new Date() })
    .onConflictDoUpdate({
      target: [chapterCache.contentKey, chapterCache.idx],
      set: { filePath, size: raw.length, isPlaceholder: ph, fetchedAt: new Date() },
    });
  return c.json({ idx, title: ch.title, content: raw, isPlaceholder: ph, cached: false });
});

// 进度上报
bookRoutes.put("/:id/progress", async (c) => {
  const uid = c.get("uid");
  const bookId = Number(c.req.param("id"));
  const [book] = await db.select().from(books).where(and(eq(books.id, bookId), eq(books.userId, uid)));
  if (!book) return c.json({ error: "书籍不存在" }, 404);
  const { chapterIdx = 0, scrollPos = 0 } = await c.req.json<{ chapterIdx?: number; scrollPos?: number }>().catch(() => ({}) as any);
  await db
    .insert(progress)
    .values({ bookId, chapterIdx, scrollPos, updatedAt: new Date() })
    .onConflictDoUpdate({ target: progress.bookId, set: { chapterIdx, scrollPos, updatedAt: new Date() } });
  return c.json({ ok: true });
});
