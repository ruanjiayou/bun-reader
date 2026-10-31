import { Hono } from "hono";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { and, count, eq, inArray, isNull, lt } from "drizzle-orm";
import { db, sqlite } from "../db";
import { books, chapters, chapterCache, progress, shelf, sources } from "../schema";
import { isPlaceholder, type LogLevel } from "../source/engine";
import { engineFor, type Engine } from "../source/facade";
import { limiterFor } from "../source/rate";
import { log } from "../log";
import type { AuthEnv } from "../auth";

export const bookRoutes = new Hono<AuthEnv>();

const contentKey = (bookUrl: string) => createHash("sha1").update(bookUrl).digest("hex");
const cacheDir = (key: string) => `data/cache/${key}`;

// 目录抓取状态（进程内）。import / 加书架会把目录抓取丢到后台，前端靠轮询 /category 等结果。
// 没有这个状态，前端只能无脑轮询——后台早就失败退出了，页面还在每 2 秒问一次，
// 加上每次进页面都会重新开一轮，看起来就是「一直在发请求、刷新也停不下来」。
type TocState = { status: "idle" | "fetching" | "done" | "failed"; error?: string; at: number };
const tocStates = new Map<number, TocState>();
// 没有记录时是 idle（进程重启过、或从没抓过）——不能报 fetching，否则前端又会空等 2 分钟
const tocStateOf = (bookId: number, chapterCount: number): TocState =>
  chapterCount ? { status: "done", at: 0 } : (tocStates.get(bookId) ?? { status: "idle", at: 0 });

// —— 数据模型：书籍全局共享（预览即入库）——
// 进详情页时书籍与目录就已经落库，加书架只是往 shelf 插一行关联；没人收藏的书由每日任务回收。
// 所以下面的读接口一律不按 user_id 过滤（detail/category/content/refresh/cache），
// 只有「书架列表」「进度」是用户维度的。
async function loadBook(bookId: number) {
  const [b] = await db.select().from(books).where(eq(books.id, bookId));
  return b ?? null;
}

async function isOnShelf(uid: number, bookId: number) {
  const [r] = await db
    .select({ bookId: shelf.bookId })
    .from(shelf)
    .where(and(eq(shelf.userId, uid), eq(shelf.bookId, bookId)));
  return !!r;
}

async function chapterCount(bookId: number) {
  const [r] = await db.select({ c: count() }).from(chapters).where(eq(chapters.bookId, bookId));
  return r?.c ?? 0;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

async function loadEngine(sourceId: number | null): Promise<Engine> {
  if (!sourceId) throw new Error("书籍未绑定书源");
  const [row] = await db.select().from(sources).where(eq(sources.id, sourceId));
  if (!row) throw new Error("书源已删除");
  return engineFor(row);
}

// 抓正文 → 落盘（存**未净化**原文）→ 章节缓存索引（单章与全本缓存共用）
// 净化放到读取时做：改书源规则后历史章节立即生效，不用整本重抓。
async function fetchAndSave(eng: Engine, url: string, key: string, idx: number) {
  const raw = await eng.contentRaw(url);
  if (!raw.trim()) throw new Error("正文抓取为空");
  await mkdir(cacheDir(key), { recursive: true });
  const filePath = `${cacheDir(key)}/${idx}.txt`;
  await writeFile(filePath, raw);
  const text = await eng.cleanText(raw);
  if (!text.trim()) log.warn("cache", `第 ${idx + 1} 章净化后为空（规则可能删过头），原文已缓存`);
  const ph = isPlaceholder(text);
  await db
    .insert(chapterCache)
    .values({ contentKey: key, idx, filePath, size: raw.length, isPlaceholder: ph, fetchedAt: new Date() })
    .onConflictDoUpdate({
      target: [chapterCache.contentKey, chapterCache.idx],
      set: { filePath, size: raw.length, isPlaceholder: ph, fetchedAt: new Date() },
    });
  return text;
}

// ---------- 全本缓存（后台任务，按 contentKey 共享，多用户同书共用） ----------
interface CacheJobState {
  total: number;
  done: number;
  failed: number;
  status: "running" | "done" | "stopped" | "error";
}
const runningJobs = new Map<string, { stop: boolean }>();
// 缓存章节日志：只打后端日志（控制台 + data/logs/日期.log），前端不展示
const cacheLog = (level: "info" | "warn" | "error", msg: string) => log[level]("cache", msg);
const jobStmt = {
  upsert: sqlite.query("INSERT OR REPLACE INTO cache_jobs (content_key, total, done, failed, status, updated_at) VALUES (?, ?, 0, 0, 'running', ?)"),
  update: sqlite.query("UPDATE cache_jobs SET done = ?, failed = ?, status = ?, updated_at = ? WHERE content_key = ?"),
  get: sqlite.query("SELECT total, done, failed, status, updated_at FROM cache_jobs WHERE content_key = ?"),
};

async function runCacheJob(eng: any, key: string, list: { idx: number; url: string; title: string }[], sourceId: number | null) {
  const stopper = { stop: false };
  runningJobs.set(key, stopper);
  jobStmt.upsert.run(key, list.length, Date.now());
  const limiter = sourceId != null ? limiterFor(sourceId) : null;
  log.info("cache", `任务启动：${key.slice(0, 8)}… 共 ${list.length} 章待抓`);
  cacheLog("info", `任务启动：共 ${list.length} 章待抓${limiter && limiter.cap > 0 ? `（沿用频率 ${limiter.cap} 次/${limiter.windowMs / 1000}s）` : "（起步不限速）"}`);
  try {
    for (const ch of list) {
      if (stopper.stop) {
        const cur = (jobStmt.get.get(key) ?? {}) as any;
        jobStmt.update.run(cur.done ?? 0, cur.failed ?? 0, "stopped", Date.now(), key);
        log.info("cache", `任务停止：${key.slice(0, 8)}… 已完成 ${cur.done ?? 0}/${list.length}`);
        cacheLog("info", `任务停止：已完成 ${cur.done ?? 0}/${list.length}`);
        return;
      }
      // 阅读时可能已把该章抓取落盘（内容接口共用 fetchAndSave）→ 跳过不重复请求
      const [exists] = await db
        .select({ filePath: chapterCache.filePath })
        .from(chapterCache)
        .where(and(eq(chapterCache.contentKey, key), eq(chapterCache.idx, ch.idx)));
      if (exists && (await fileExists(exists.filePath))) {
        const cur = jobStmt.get.get(key) as any;
        jobStmt.update.run((cur?.done ?? 0) + 1, cur?.failed ?? 0, "running", Date.now(), key);
        cacheLog("info", `第 ${ch.idx + 1} 章《${ch.title}》阅读时已缓存，跳过`);
        continue;
      }
      // 抓取 + 失败重试：正式请求过限速器计频；重试等待指数退避（2s 起翻倍封顶 60s）且不计入频率
      let ok = true;
      for (let attempt = 0; ; attempt++) {
        try {
          if (limiter) await limiter.acquire(sourceId!);
          await fetchAndSave(eng, ch.url, key, ch.idx);
          limiter?.onSuccess(sourceId!);
          cacheLog("info", `第 ${ch.idx + 1} 章《${ch.title}》缓存成功`);
          break;
        } catch (e: any) {
          limiter?.onFailure(sourceId!);
          if (attempt >= 4) {
            ok = false;
            log.warn("cache", `第 ${ch.idx + 1} 章重试 ${attempt + 1} 次仍失败，放弃：${e?.message ?? e}`);
            cacheLog("warn", `第 ${ch.idx + 1} 章《${ch.title}》失败：${e?.message ?? e}`);
            break;
          }
          const wait = Math.min(2000 * 2 ** attempt, 60000);
          log.warn("cache", `第 ${ch.idx + 1} 章失败，${wait / 1000}s 后重试（${attempt + 2}/5）：${e?.message ?? e}`);
          cacheLog("warn", `第 ${ch.idx + 1} 章《${ch.title}》失败，${wait / 1000}s 后重试（${attempt + 2}/5）`);
          await new Promise((r) => setTimeout(r, wait));
        }
      }
      const cur = jobStmt.get.get(key) as any;
      jobStmt.update.run((cur?.done ?? 0) + (ok ? 1 : 0), (cur?.failed ?? 0) + (ok ? 0 : 1), "running", Date.now(), key);
    }
    const cur = jobStmt.get.get(key) as any;
    jobStmt.update.run(cur.done, cur.failed, "done", Date.now(), key);
    log.info("cache", `任务完成：${key.slice(0, 8)}… 成功 ${cur.done}，失败 ${cur.failed}`);
    cacheLog("info", `任务完成：成功 ${cur.done}，失败 ${cur.failed}${limiter ? `，学习频率 ${limiter.cap === 0 ? "不限" : `${limiter.cap} 次/${limiter.windowMs / 1000}s`}` : ""}`);
  } catch (e: any) {
    const cur = jobStmt.get.get(key) as any;
    jobStmt.update.run(cur?.done ?? 0, cur?.failed ?? 0, "error", Date.now(), key);
    log.error("cache", `任务异常终止：${key.slice(0, 8)}… ${e?.message ?? e}`);
    cacheLog("warn", `任务异常终止：${e?.message ?? e}`);
  } finally {
    runningJobs.delete(key);
  }
}

// 启动全本缓存（只抓未缓存的章节；已在跑则直接返回进度）
bookRoutes.post("/:id/cache-all", async (c) => {
  const bookId = Number(c.req.param("id"));
  const book = await loadBook(bookId);
  if (!book) return c.json({ error: "书籍不存在" }, 404);
  const key = contentKey(book.bookUrl);
  if (runningJobs.has(key)) return c.json({ already: true, ...(jobStmt.get.get(key) as any) });
  const eng = await loadEngine(book.sourceId);
  const list = await db.select({ idx: chapters.idx, url: chapters.url, title: chapters.title }).from(chapters).where(eq(chapters.bookId, bookId));
  if (!list.length) return c.json({ error: "目录为空" }, 400);
  const cachedRows = await db.select({ idx: chapterCache.idx }).from(chapterCache).where(eq(chapterCache.contentKey, key));
  const cached = new Set(cachedRows.map((r) => r.idx));
  const todo = list.filter((ch) => !cached.has(ch.idx)).sort((a, b) => a.idx - b.idx);
  if (!todo.length) return c.json({ nothing: true, cachedCount: cached.size });
  runCacheJob(eng, key, todo, book.sourceId); // 后台执行，不 await
  return c.json({ queued: todo.length, cachedCount: cached.size });
});

// 缓存进度查询（前端轮询）
bookRoutes.get("/:id/cache-all", async (c) => {
  const bookId = Number(c.req.param("id"));
  const book = await loadBook(bookId);
  if (!book) return c.json({ error: "书籍不存在" }, 404);
  const key = contentKey(book.bookUrl);
  const job = jobStmt.get.get(key) as any;
  const cachedCount = (await db.select({ idx: chapterCache.idx }).from(chapterCache).where(eq(chapterCache.contentKey, key))).length;
  const total = await chapterCount(bookId);
  return c.json({ total, cachedCount, job: job ?? null, running: runningJobs.has(key) });
});

// 停止缓存任务（已抓的保留）
bookRoutes.post("/:id/cache-stop", async (c) => {
  const bookId = Number(c.req.param("id"));
  const book = await loadBook(bookId);
  if (!book) return c.json({ error: "书籍不存在" }, 404);
  const key = contentKey(book.bookUrl);
  const stopper = runningJobs.get(key);
  if (stopper) stopper.stop = true;
  else {
    const cur = (jobStmt.get.get(key) ?? {}) as any;
    jobStmt.update.run(cur.done ?? 0, cur.failed ?? 0, "stopped", Date.now(), key);
  }
  return c.json({ ok: true });
});

// 释放缓存：删除该书全部已缓存正文文件 + 索引（多用户共享，任何人释放对所有人生效——文件随时可重抓）
bookRoutes.post("/:id/cache-release", async (c) => {
  const bookId = Number(c.req.param("id"));
  const book = await loadBook(bookId);
  if (!book) return c.json({ error: "书籍不存在" }, 404);
  const released = await dropCache(book.bookUrl);
  return c.json({ released });
});

// 按 contentKey 删缓存索引 + 任务记录 + 目录（释放缓存 / 孤儿回收共用）
async function dropCache(bookUrl: string) {
  const key = contentKey(bookUrl);
  const stopper = runningJobs.get(key);
  if (stopper) stopper.stop = true;
  const rows = await db.select({ idx: chapterCache.idx }).from(chapterCache).where(eq(chapterCache.contentKey, key));
  await db.delete(chapterCache).where(eq(chapterCache.contentKey, key));
  sqlite.query("DELETE FROM cache_jobs WHERE content_key = ?").run(key);
  await rm(cacheDir(key), { recursive: true, force: true });
  return rows.length;
}

// 抓详情+目录并写入章节快照（入库/刷新/换源共用）；最新章节 URL 供 {page} 模板推最大页码
// onLog 可选：后台任务（fillToc）把引擎日志转进服务日志，否则「第 2 页超时、重试 1/2」这类
// 关键过程只活在调用栈里，日志里只剩一句「目录抓取失败：请求超时」
async function snapshotToc(eng: Engine, bookUrl: string, onLog?: (level: LogLevel, step: string, msg: string) => void) {
  const info = await eng.bookInfo(bookUrl, onLog);
  const toc = await eng.toc(info.tocUrl, onLog, info.latestChapterUrl || undefined);
  if (!toc.length) throw new Error("目录为空");
  return { info, toc };
}

// 目录快照后台任务（入库异步补目录）：完成后填充缺失字段并整表替换章节
const tocJobs = new Set<number>(); // 防同书并发抓
// 引擎日志 → 服务日志（后台任务没人接 SSE，只能落盘）
const tocLogger = (level: LogLevel, step: string, msg: string) => {
  const line = step === "toc" ? msg : `[${step}] ${msg}`; // tag 已经是 toc，别输出 [toc] [toc]
  if (level === "err") log.error("toc", line);
  else if (level === "warn") log.warn("toc", line);
  else log.info("toc", line);
};

async function fillToc(bookId: number, eng: any, bookUrl: string) {
  if (tocJobs.has(bookId)) return;
  tocJobs.add(bookId);
  tocStates.set(bookId, { status: "fetching", at: Date.now() });
  try {
    const { info, toc } = await snapshotToc(eng, bookUrl, tocLogger);
    const b = await loadBook(bookId);
    if (!b) return; // 书已被清理（没人收藏，或已被换源合并）
    await db.delete(chapters).where(eq(chapters.bookId, bookId));
    await db.insert(chapters).values(toc.map((ch, i) => ({ bookId, idx: i, title: ch.title, url: ch.url })));
    await db
      .update(books)
      .set({
        name: info.name || b.name,
        author: info.author || b.author,
        cover: info.cover || b.cover,
        intro: info.intro || b.intro,
        latestChapter: info.latestChapter || info.latestChapterUrl || b.latestChapter, // 标题优先入库；取不到标题存 URL（前端兜底显示页码）
        lastCheckAt: new Date(),
        updatedAt: new Date(), // 首次建目录视为书籍更新
      })
      .where(eq(books.id, bookId));
    log.info("book", `《${info.name || b.name}》目录就绪：${toc.length} 章`);
    tocStates.set(bookId, { status: "done", at: Date.now() });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    tocStates.set(bookId, { status: "failed", error: msg, at: Date.now() });
    log.error("book", `目录抓取失败 bookId=${bookId}：${msg}`);
  } finally {
    // 中途 return（书籍已被清理）时状态还停在 fetching，这里兜底收尾，别让前端永远等下去
    if (tocStates.get(bookId)?.status === "fetching")
      tocStates.set(bookId, { status: "failed", error: "目录抓取中断（书籍已不在库里）", at: Date.now() });
    tocJobs.delete(bookId);
  }
}

// ---------- 入库 / 书架 ----------

// 预览即入库：进详情页就写 books（幂等），目录后台异步补；onShelf=true 时顺带加书架
// （搜索页「直接加书架」按钮走这个）。返回 id 后前端直接跳 /book/:id，不再有独立的预览接口。
bookRoutes.post("/import", async (c) => {
  const uid = c.get("uid");
  const body = await c.req
    .json<{
      bookUrl?: string;
      sourceId?: number;
      onShelf?: boolean;
      info?: { name?: string; author?: string; cover?: string; intro?: string; latestChapter?: string };
    }>()
    .catch(() => ({}) as any);
  const { bookUrl, sourceId, info, onShelf } = body;
  if (!bookUrl || !sourceId) return c.json({ error: "缺少 bookUrl/sourceId" }, 400);
  const eng = await loadEngine(sourceId).catch((e) => {
    throw new Error(`书源不可用：${e.message}`);
  });

  let [book] = await db
    .select()
    .from(books)
    .where(and(eq(books.bookUrl, bookUrl), eq(books.sourceId, sourceId)));

  if (!book) {
    const [row] = await db
      .insert(books)
      .values({
        bookUrl,
        sourceId,
        name: info?.name || "未知书名",
        author: info?.author ?? "",
        cover: info?.cover ?? "",
        intro: info?.intro ?? "",
        latestChapter: info?.latestChapter ?? "",
        lastCheckAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    book = row;
    log.info("book", `入库：《${book.name}》bookId=${book.id}（source#${sourceId}）`);
  } else if (info?.name && book.name === "未知书名") {
    // 早期入库时没有书名（只有 URL），这次带信息了就补上
    await db.update(books).set({ name: info.name, author: info.author ?? book.author, cover: info.cover ?? book.cover }).where(eq(books.id, book.id));
    book = { ...book, name: info.name };
  }

  const n = await chapterCount(book.id);
  if (!n) fillToc(book.id, eng, bookUrl); // 不 await：详情页轮询目录

  let onShelfNow = await isOnShelf(uid, book.id);
  if (onShelf && !onShelfNow) {
    await db.insert(shelf).values({ userId: uid, bookId: book.id }).onConflictDoNothing();
    onShelfNow = true;
  }
  return c.json({ id: book.id, name: book.name, author: book.author, chapterCount: n, ready: n > 0, onShelf: onShelfNow, toc: tocStateOf(book.id, n) });
});

// 加书架：只建关联（书与目录在入库时已经有了）
bookRoutes.post("/:id/shelf", async (c) => {
  const uid = c.get("uid");
  const bookId = Number(c.req.param("id"));
  const book = await loadBook(bookId);
  if (!book) return c.json({ error: "书籍不存在" }, 404);
  await db.insert(shelf).values({ userId: uid, bookId }).onConflictDoNothing();
  // 目录还空着（上次后台抓取失败/书源临时不可用）就再补一次
  if (!(await chapterCount(bookId)) && book.sourceId) {
    const eng = await loadEngine(book.sourceId).catch(() => null);
    if (eng) fillToc(bookId, eng, book.bookUrl);
  }
  return c.json({ ok: true, onShelf: true });
});

// 移出书架：只删关联，书与缓存留着（没人再收藏就由每日清理回收）
bookRoutes.delete("/:id/shelf", async (c) => {
  const uid = c.get("uid");
  const bookId = Number(c.req.param("id"));
  await db.delete(shelf).where(and(eq(shelf.userId, uid), eq(shelf.bookId, bookId)));
  log.info("shelf", `移出书架：bookId=${bookId}（uid=${uid}）`);
  return c.json({ ok: true, onShelf: false });
});

// 兼容旧前端：DELETE /api/books/:id 等价于移出书架
bookRoutes.delete("/:id", async (c) => {
  const uid = c.get("uid");
  const bookId = Number(c.req.param("id"));
  await db.delete(shelf).where(and(eq(shelf.userId, uid), eq(shelf.bookId, bookId)));
  return c.json({ ok: true, onShelf: false });
});

// 书架列表：shelf 关联 + 书籍 + 我的进度 + 章节数（没有的书不出现）
bookRoutes.get("/", async (c) => {
  const uid = c.get("uid");
  const rows = await db
    .select({ book: books, addedAt: shelf.createdAt })
    .from(shelf)
    .innerJoin(books, eq(books.id, shelf.bookId))
    .where(eq(shelf.userId, uid));
  if (!rows.length) return c.json([]);
  const ids = rows.map((r) => r.book.id);
  const progs = await db.select().from(progress).where(and(eq(progress.userId, uid), inArray(progress.bookId, ids)));
  const progMap = new Map(progs.map((p) => [p.bookId, p]));
  const countMap = new Map<number, number>();
  const counts = await db
    .select({ bookId: chapters.bookId, count: count() })
    .from(chapters)
    .where(inArray(chapters.bookId, ids))
    .groupBy(chapters.bookId);
  for (const r of counts) countMap.set(r.bookId, r.count);
  return c.json(
    rows.map(({ book: b, addedAt }) => ({
      ...b,
      createdAt: addedAt, // 书架排序用「加入书架时间」，不是全站首次入库时间
      chapterCount: countMap.get(b.id) ?? 0,
      progress: progMap.get(b.id) ? { chapterIdx: progMap.get(b.id)!.chapterIdx, updatedAt: progMap.get(b.id)!.updatedAt } : null,
    })),
  );
});

// 刷新书：重抓详情+目录，更新快照（新增章节保留章节号连续性：直接整表替换，idx 即序号）
bookRoutes.put("/:id/refresh", async (c) => {
  const bookId = Number(c.req.param("id"));
  const book = await loadBook(bookId);
  if (!book) return c.json({ error: "书籍不存在" }, 404);
  const eng = await loadEngine(book.sourceId);
  let snap: Awaited<ReturnType<typeof snapshotToc>>;
  try {
    snap = await snapshotToc(eng, book.bookUrl, tocLogger);
  } catch (e: any) {
    // 手工重试也失败：先把原因落进状态（前端据此停止轮询并显示），再以 502 返回可读文案，
    // 而不是让 Hono 抛 500 只剩一句 Internal Server Error
    const msg = e?.message ?? String(e);
    tocStates.set(bookId, { status: "failed", error: msg, at: Date.now() });
    log.error("refresh", `《${book.name}》检查更新失败：${msg}`);
    return c.json({ error: msg }, 502);
  }
  const { info, toc } = snap;
  const oldCount = await chapterCount(bookId);
  await db.delete(chapters).where(eq(chapters.bookId, bookId));
  await db.insert(chapters).values(toc.map((ch, i) => ({ bookId, idx: i, title: ch.title, url: ch.url })));
  const added = Math.max(0, toc.length - oldCount);
  await db
    .update(books)
    .set({
      name: info.name || book.name,
      author: info.author,
      cover: info.cover,
      intro: info.intro,
      latestChapter: info.latestChapter || info.latestChapterUrl || book.latestChapter,
      lastCheckAt: new Date(),
      // 只有真的新增章节才算「书籍更新」，单纯检查不动排序时间
      ...(added > 0 ? { updatedAt: new Date() } : {}),
    })
    .where(eq(books.id, bookId));
  log.info("refresh", `《${book.name}》检查更新：${oldCount} → ${toc.length} 章`);
  tocStates.set(bookId, { status: "done", at: Date.now() });
  return c.json({ chapterCount: toc.length, added, oldCount });
});

// 换源候选：并发搜索全部启用书源，只返回"拥有这本书"的源（书名精确命中优先，当前源标记 current）
bookRoutes.get("/:id/sources", async (c) => {
  const bookId = Number(c.req.param("id"));
  const book = await loadBook(bookId);
  if (!book) return c.json({ error: "书籍不存在" }, 404);
  const rows = await db.select().from(sources).where(eq(sources.enabled, true));
  const engines = rows.map((r) => ({ id: r.id, eng: engineFor(r) }));
  const results: {
    sourceId: number; sourceName: string; name: string; author: string; bookUrl: string; latestChapter: string; current: boolean;
  }[] = [];
  let cursor = 0; // 4 路并发 worker 共享游标
  const worker = async () => {
    while (cursor < engines.length) {
      const { id, eng } = engines[cursor++];
      try {
        const found = await eng.search(book.name);
        const hit = found.find((b) => b.name === book.name) ?? found[0];
        if (hit)
          results.push({
            sourceId: id,
            sourceName: eng.sourceName || `源#${id}`,
            name: hit.name,
            author: hit.author,
            bookUrl: hit.bookUrl,
            latestChapter: hit.latestChapter,
            current: id === book.sourceId && hit.bookUrl === book.bookUrl,
          });
      } catch {} // 单源失败/超时直接跳过
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, engines.length || 1) }, worker));
  results.sort((a, b) => Number(b.name === book.name) - Number(a.name === book.name) || Number(a.current ? 0 : 1) - Number(b.current ? 0 : 1));
  log.info("source", `《${book.name}》换源候选：${engines.length} 个启用源中 ${results.length} 个拥有此书`);
  return c.json(results);
});

// 换源：原地改这一行的 sourceId/bookUrl，重抓目录；书架、进度、id 全部保留（阅读器不用跳转）。
// 目标 (bookUrl, sourceId) 若已经被别人预览过（books 全局唯一），就把那本书的 shelf/progress 合并过来再删掉，
// 否则会撞 books_url_src 唯一索引。
bookRoutes.put("/:id/source", async (c) => {
  const bookId = Number(c.req.param("id"));
  const body = await c.req.json<{ sourceId?: number; bookUrl?: string }>().catch(() => ({}) as any);
  const { sourceId, bookUrl } = body;
  if (!sourceId || !bookUrl) return c.json({ error: "缺少 sourceId/bookUrl" }, 400);
  const book = await loadBook(bookId);
  if (!book) return c.json({ error: "书籍不存在" }, 404);
  const eng = await loadEngine(sourceId);
  const { info, toc } = await snapshotToc(eng, bookUrl, tocLogger);

  const [target] = await db
    .select()
    .from(books)
    .where(and(eq(books.bookUrl, bookUrl), eq(books.sourceId, sourceId)));
  if (target && target.id !== bookId) {
    // 目标书已存在：把它的书架与进度挪到当前书上（当前书保留原 id，阅读器无感）
    const targetShelf = await db.select().from(shelf).where(eq(shelf.bookId, target.id));
    for (const s of targetShelf) {
      await db.insert(shelf).values({ userId: s.userId, bookId, createdAt: s.createdAt }).onConflictDoNothing();
    }
    await db.delete(shelf).where(eq(shelf.bookId, target.id));
    sqlite.query("UPDATE OR REPLACE progress SET book_id = ? WHERE book_id = ?").run(bookId, target.id);
    await db.delete(chapters).where(eq(chapters.bookId, target.id));
    await db.delete(books).where(eq(books.id, target.id));
    log.info("source", `换源合并：bookId=${target.id} 并入 bookId=${bookId}`);
  }

  await db.delete(chapters).where(eq(chapters.bookId, bookId));
  await db.insert(chapters).values(toc.map((ch, i) => ({ bookId, idx: i, title: ch.title, url: ch.url })));
  await db
    .update(books)
    .set({
      sourceId,
      bookUrl,
      name: info.name || book.name,
      author: info.author,
      cover: info.cover,
      intro: info.intro,
      latestChapter: info.latestChapter || info.latestChapterUrl || book.latestChapter,
      lastCheckAt: new Date(),
    })
    .where(eq(books.id, bookId));
  log.info("source", `《${book.name}》换源 → ${info.name || "?"}（${toc.length} 章）`);
  return c.json({ chapterCount: toc.length, name: info.name });
});

// 编辑书籍元数据：仅更新传入的字段；封面可为远程 URL 或 dataURL（前端压缩后的上传图）
// 约定：以 data: 开头的 cover 视为用户本地上传，巡检任务不会用源站封面覆盖它
const COVER_MAX = 2_000_000; // dataURL 长度上限（约 1.5MB 图），防止库被超大封面撑爆
bookRoutes.patch("/:id", async (c) => {
  const bookId = Number(c.req.param("id"));
  const book = await loadBook(bookId);
  if (!book) return c.json({ error: "书籍不存在" }, 404);
  const body = await c.req
    .json<{ name?: string; author?: string; intro?: string; latestChapter?: string; cover?: string }>()
    .catch(() => ({}) as any);
  const patch: Partial<typeof book> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 200);
  if (typeof body.author === "string") patch.author = body.author.slice(0, 100);
  if (typeof body.intro === "string") patch.intro = body.intro.slice(0, 4000);
  if (typeof body.latestChapter === "string") patch.latestChapter = body.latestChapter.slice(0, 300);
  if (typeof body.cover === "string") {
    const cv = body.cover.trim();
    if (cv.startsWith("data:")) {
      if (!/^data:image\//.test(cv)) return c.json({ error: "封面必须是图片" }, 400);
      if (cv.length > COVER_MAX) return c.json({ error: "封面图片过大，请压缩后重试" }, 400);
    } else if (cv && !/^(https?:)?\/\//i.test(cv)) {
      return c.json({ error: "封面 URL 不合法" }, 400);
    }
    patch.cover = cv;
  }
  if (!Object.keys(patch).length) return c.json({ ok: true, changed: 0 });
  await db.update(books).set(patch).where(eq(books.id, bookId));
  log.info("edit", `《${book.name}》编辑元数据：${Object.keys(patch).join(", ")}`);
  return c.json({ ok: true, changed: Object.keys(patch).length });
});

// ---------- 定时巡检：周期性检查书架里的书是否有新章节 ----------
// 复用「检查更新」逻辑逐本重抓目录比对章节数；仅新增章节时才置 updatedAt（影响书架「最近更新」排序）。
// 用户本地上传的封面（cover 以 data: 开头）不会被源站封面覆盖。
let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let schedulerRunning = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function startBookUpdateScheduler() {
  const interval = Number(process.env.UPDATE_INTERVAL_MS ?? 6 * 3600_000);
  if (interval <= 0) return; // 显式置 0 关闭巡检
  if (schedulerTimer) return;
  schedulerTimer = setInterval(runScheduledUpdate, interval);
  // 启动后先跑一次（错峰：等 30s 让服务其他初始化完成）
  setTimeout(runScheduledUpdate, 30_000);
  log.info("scheduler", `书籍更新巡检已启用，间隔 ${Math.round(interval / 60000)} 分钟`);
}

async function runScheduledUpdate() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  const startedAt = Date.now();
  log.info("scheduler", "开始巡检全部书籍更新…");
  try {
    // 只巡检有人收藏的书：预览过但没人加书架的会在每日清理里回收，没必要花请求去更新
    const all = await db
      .select({ b: books })
      .from(books)
      .innerJoin(shelf, eq(shelf.bookId, books.id))
      .groupBy(books.id);
    let checked = 0;
    let updated = 0;
    let failed = 0;
    for (const { b } of all) {
      if (!b.sourceId) continue;
      checked++;
      try {
        const eng = await loadEngine(b.sourceId);
        const limiter = limiterFor(b.sourceId);
        if (limiter) await limiter.acquire(b.sourceId);
        const { info, toc } = await snapshotToc(eng, b.bookUrl, tocLogger);
        if (limiter) limiter.onSuccess(b.sourceId);
        const oldCount = await chapterCount(b.id);
        const added = Math.max(0, toc.length - oldCount);
        await db.delete(chapters).where(eq(chapters.bookId, b.id));
        await db.insert(chapters).values(toc.map((ch, i) => ({ bookId: b.id, idx: i, title: ch.title, url: ch.url })));
        // 用户上传的封面（data:）不动；其余以源站封面覆盖
        const cover = b.cover.startsWith("data:") ? b.cover : info.cover || b.cover;
        await db
          .update(books)
          .set({
            name: info.name || b.name,
            author: info.author || b.author,
            intro: info.intro || b.intro,
            cover,
            latestChapter: info.latestChapter || info.latestChapterUrl || b.latestChapter,
            lastCheckAt: new Date(),
            ...(added > 0 ? { updatedAt: new Date() } : {}),
          })
          .where(eq(books.id, b.id));
        if (added > 0) {
          updated++;
          log.info("scheduler", `《${b.name}》新增 ${added} 章（${oldCount} → ${toc.length}）`);
        }
      } catch (e: any) {
        failed++;
        log.warn("scheduler", `《${b.name}》巡检失败：${e?.message ?? e}`);
      }
      await sleep(800); // 两本书之间留间隔，避免无头浏览器抢占
    }
    log.info("scheduler", `巡检完成：检查 ${checked} 本，新增更新 ${updated} 本，失败 ${failed} 本（耗时 ${Math.round((Date.now() - startedAt) / 1000)}s）`);
  } catch (e: any) {
    log.error("scheduler", `巡检异常：${e?.message ?? e}`);
  } finally {
    schedulerRunning = false;
  }
}

// ---------- 每日清理：回收「没有任何人加入书架」的书籍 ----------
// 预览即入库的代价就是库里会有大量只看过一次的书：books + chapters + 正文缓存 + 进度。
// 每天扫一次，删掉没人收藏且入库超过宽限期（默认 24h，避免「刚预览还没决定」就被删）的书。
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let cleanupRunning = false;

export function startOrphanCleanup() {
  const interval = Number(process.env.CLEANUP_INTERVAL_MS ?? 24 * 3600_000);
  if (interval <= 0) return; // 显式置 0 关闭清理
  if (cleanupTimer) return;
  cleanupTimer = setInterval(runOrphanCleanup, interval);
  setTimeout(runOrphanCleanup, 120_000); // 启动 2 分钟后先跑一次
  log.info("cleanup", `孤儿书籍清理已启用，间隔 ${Math.round(interval / 3600_000)} 小时`);
}

export async function runOrphanCleanup() {
  if (cleanupRunning) return;
  cleanupRunning = true;
  const startedAt = Date.now();
  try {
    const graceMs = Number(process.env.CLEANUP_GRACE_MS ?? 24 * 3600_000);
    const cutoff = new Date(Date.now() - graceMs);
    const orphans = await db
      .select({ id: books.id, name: books.name, bookUrl: books.bookUrl })
      .from(books)
      .leftJoin(shelf, eq(shelf.bookId, books.id))
      .where(and(isNull(shelf.bookId), lt(books.createdAt, cutoff)));

    for (const o of orphans) {
      await db.delete(chapters).where(eq(chapters.bookId, o.id));
      await db.delete(progress).where(eq(progress.bookId, o.id));
      await db.delete(books).where(eq(books.id, o.id));
      // 缓存按 contentKey(bookUrl) 共享：还有别的书在用同一个地址就留着
      const [still] = await db.select({ id: books.id }).from(books).where(eq(books.bookUrl, o.bookUrl)).limit(1);
      if (!still) await dropCache(o.bookUrl);
    }

    // 顺手扫掉「没有任何书引用」的缓存（换源后旧地址的残留）
    const liveUrls = new Set((await db.select({ u: books.bookUrl }).from(books)).map((r) => contentKey(r.u)));
    const cachedKeys = sqlite.query("SELECT DISTINCT content_key AS k FROM chapter_cache").all() as { k: string }[];
    let droppedKeys = 0;
    for (const { k } of cachedKeys) {
      if (liveUrls.has(k)) continue;
      await db.delete(chapterCache).where(eq(chapterCache.contentKey, k));
      sqlite.query("DELETE FROM cache_jobs WHERE content_key = ?").run(k);
      await rm(cacheDir(k), { recursive: true, force: true });
      droppedKeys++;
    }

    if (orphans.length || droppedKeys) {
      log.info(
        "cleanup",
        `清理完成：回收书籍 ${orphans.length} 本${orphans.length ? `（${orphans.map((o) => o.name).slice(0, 5).join("、")}${orphans.length > 5 ? "…" : ""}）` : ""}，孤儿缓存 ${droppedKeys} 份（耗时 ${Math.round((Date.now() - startedAt) / 1000)}s）`,
      );
    } else {
      log.info("cleanup", `清理完成：没有需要回收的书籍（耗时 ${Math.round((Date.now() - startedAt) / 1000)}s）`);
    }
  } catch (e: any) {
    log.error("cleanup", `清理异常：${e?.message ?? e}`);
  } finally {
    cleanupRunning = false;
  }
}

// 书籍详情 + 我的进度 + 是否已在书架
bookRoutes.get("/:id", async (c) => {
  const uid = c.get("uid");
  const bookId = Number(c.req.param("id"));
  const book = await loadBook(bookId);
  if (!book) return c.json({ error: "书籍不存在" }, 404);
  const [prog] = await db.select().from(progress).where(and(eq(progress.userId, uid), eq(progress.bookId, bookId)));
  // 带上书源名：详情页要显示这本书来自哪个源（源被删则 sourceId 为 null，前端显示「未知」）
  let sourceName = "";
  if (book.sourceId != null) {
    const [src] = await db.select({ name: sources.name }).from(sources).where(eq(sources.id, book.sourceId));
    sourceName = src?.name ?? "";
  }
  return c.json({
    ...book,
    sourceName,
    onShelf: await isOnShelf(uid, bookId),
    progress: prog ? { chapterIdx: prog.chapterIdx, scrollPos: prog.scrollPos, updatedAt: prog.updatedAt } : null,
  });
});

// 目录（章节快照），?refresh=1 强制重抓
bookRoutes.get("/:id/category", async (c) => {
  const uid = c.get("uid");
  const bookId = Number(c.req.param("id"));
  const book = await loadBook(bookId);
  if (!book) return c.json({ error: "书籍不存在" }, 404);
  if (c.req.query("refresh")) {
    const eng = await loadEngine(book.sourceId);
    const { info, toc } = await snapshotToc(eng, book.bookUrl, tocLogger);
    await db.delete(chapters).where(eq(chapters.bookId, bookId));
    await db.insert(chapters).values(toc.map((ch, i) => ({ bookId, idx: i, title: ch.title, url: ch.url })));
    await db.update(books).set({ latestChapter: info.latestChapter || info.latestChapterUrl || book.latestChapter, lastCheckAt: new Date() }).where(eq(books.id, bookId));
  }
  const list = await db.select({ idx: chapters.idx, title: chapters.title }).from(chapters).where(eq(chapters.bookId, bookId));
  list.sort((a, b) => a.idx - b.idx);
  const key = contentKey(book.bookUrl);
  const cachedRows = await db.select({ idx: chapterCache.idx }).from(chapterCache).where(eq(chapterCache.contentKey, key));
  const cachedSet = new Set(cachedRows.map((r) => r.idx));
  const [prog] = await db.select().from(progress).where(and(eq(progress.userId, uid), eq(progress.bookId, bookId)));
  return c.json({
    book: { id: book.id, name: book.name, author: book.author },
    chapters: list.map((ch) => ({ ...ch, cached: cachedSet.has(ch.idx) })),
    cachedCount: cachedSet.size,
    progress: prog ? { chapterIdx: prog.chapterIdx } : null,
    // 目录为空时告诉前端后台抓取的真实进展：还在抓 → 继续等；失败 → 立刻停，把原因显示出来
    toc: tocStateOf(bookId, list.length),
  });
});

// 正文：磁盘缓存优先，未命中抓取→落盘→入库索引；?refresh=1 绕过缓存
bookRoutes.get("/:id/content/:idx", async (c) => {
  const bookId = Number(c.req.param("id"));
  const idx = Number(c.req.param("idx"));
  const refresh = !!c.req.query("refresh");
  const book = await loadBook(bookId);
  if (!book) return c.json({ error: "书籍不存在" }, 404);
  const [ch] = await db.select().from(chapters).where(and(eq(chapters.bookId, bookId), eq(chapters.idx, idx)));
  if (!ch) return c.json({ error: "章节不存在" }, 404);

  const key = contentKey(book.bookUrl);
  // 引擎要提前取：缓存里是原文，命中缓存也要用当前源的规则净化一次。
  // 书源被删（source_id 置空）时引擎拿不到，退回「把缓存原文直接返回」——不能因为没了源就读不了已缓存章节
  const eng = book.sourceId == null ? null : await loadEngine(book.sourceId);
  const [cached] = refresh
    ? []
    : await db.select().from(chapterCache).where(and(eq(chapterCache.contentKey, key), eq(chapterCache.idx, idx)));
  if (cached) {
    try {
      const raw = await readFile(cached.filePath, "utf-8");
      const content = eng ? await eng.cleanText(raw) : raw;
      return c.json({ idx, title: ch.title, content, isPlaceholder: isPlaceholder(content), cached: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  if (!eng) throw new Error("书籍未绑定书源（源已删除），且该章没有缓存");

  // 抓取走同源限速器（与全本缓存任务共享同一预算：阅读请求计入频率，窗口满时排队等待）
  const limiter = book.sourceId != null ? limiterFor(book.sourceId) : null;
  if (limiter) await limiter.acquire(book.sourceId!);
  let text: string;
  try {
    text = await fetchAndSave(eng, ch.url, key, idx);
    limiter?.onSuccess(book.sourceId!);
  } catch (e) {
    limiter?.onFailure(book.sourceId!);
    throw e;
  }
  return c.json({ idx, title: ch.title, content: text, isPlaceholder: isPlaceholder(text), cached: false });
});

// 进度上报（按用户 + 书）
bookRoutes.put("/:id/progress", async (c) => {
  const uid = c.get("uid");
  const bookId = Number(c.req.param("id"));
  const book = await loadBook(bookId);
  if (!book) return c.json({ error: "书籍不存在" }, 404);
  const { chapterIdx = 0, scrollPos = 0 } = await c.req.json<{ chapterIdx?: number; scrollPos?: number }>().catch(() => ({}) as any);
  await db
    .insert(progress)
    .values({ userId: uid, bookId, chapterIdx, scrollPos, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [progress.userId, progress.bookId], set: { chapterIdx, scrollPos, updatedAt: new Date() } });
  return c.json({ ok: true });
});
