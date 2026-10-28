import { Hono } from "hono";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { and, count, eq, inArray } from "drizzle-orm";
import { db, sqlite } from "../db";
import { books, chapters, chapterCache, progress, sources } from "../schema";
import { isPlaceholder } from "../source/engine";
import { engineFor, type Engine } from "../source/facade";
import { limiterFor } from "../source/rate";
import { runWithBrowserMode } from "../source/browser";
import { log } from "../log";
import type { AuthEnv } from "../auth";

export const bookRoutes = new Hono<AuthEnv>();

const contentKey = (bookUrl: string) => createHash("sha1").update(bookUrl).digest("hex");
const cacheDir = (key: string) => `data/cache/${key}`;

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

// 抓正文 → 落盘 → 章节缓存索引（单章与全本缓存共用）
async function fetchAndSave(eng: Engine, url: string, key: string, idx: number) {
  const raw = await eng.content(url);
  if (!raw.trim()) throw new Error("正文抓取为空");
  await mkdir(cacheDir(key), { recursive: true });
  const filePath = `${cacheDir(key)}/${idx}.txt`;
  await writeFile(filePath, raw);
  const ph = isPlaceholder(raw);
  await db
    .insert(chapterCache)
    .values({ contentKey: key, idx, filePath, size: raw.length, isPlaceholder: ph, fetchedAt: new Date() })
    .onConflictDoUpdate({
      target: [chapterCache.contentKey, chapterCache.idx],
      set: { filePath, size: raw.length, isPlaceholder: ph, fetchedAt: new Date() },
    });
  return raw;
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
  const uid = c.get("uid");
  const bookId = Number(c.req.param("id"));
  const [book] = await db.select().from(books).where(and(eq(books.id, bookId), eq(books.userId, uid)));
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
  runWithBrowserMode("headless", () => runCacheJob(eng, key, todo, book.sourceId)); // 后台执行，不 await；真实抓取走无头浏览器
  return c.json({ queued: todo.length, cachedCount: cached.size });
});

// 缓存进度查询（前端轮询）
bookRoutes.get("/:id/cache-all", async (c) => {
  const uid = c.get("uid");
  const bookId = Number(c.req.param("id"));
  const [book] = await db.select().from(books).where(and(eq(books.id, bookId), eq(books.userId, uid)));
  if (!book) return c.json({ error: "书籍不存在" }, 404);
  const key = contentKey(book.bookUrl);
  const job = jobStmt.get.get(key) as any;
  const cachedCount = (await db.select({ idx: chapterCache.idx }).from(chapterCache).where(eq(chapterCache.contentKey, key))).length;
  const total = (await db.select({ idx: chapters.idx }).from(chapters).where(eq(chapters.bookId, bookId))).length;
  return c.json({ total, cachedCount, job: job ?? null, running: runningJobs.has(key) });
});

// 停止缓存任务（已抓的保留）
bookRoutes.post("/:id/cache-stop", async (c) => {
  const uid = c.get("uid");
  const bookId = Number(c.req.param("id"));
  const [book] = await db.select().from(books).where(and(eq(books.id, bookId), eq(books.userId, uid)));
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
  const uid = c.get("uid");
  const bookId = Number(c.req.param("id"));
  const [book] = await db.select().from(books).where(and(eq(books.id, bookId), eq(books.userId, uid)));
  if (!book) return c.json({ error: "书籍不存在" }, 404);
  const key = contentKey(book.bookUrl);
  const stopper = runningJobs.get(key);
  if (stopper) stopper.stop = true;
  const rows = await db.select({ idx: chapterCache.idx }).from(chapterCache).where(eq(chapterCache.contentKey, key));
  await db.delete(chapterCache).where(eq(chapterCache.contentKey, key));
  sqlite.query("DELETE FROM cache_jobs WHERE content_key = ?").run(key);
  await rm(cacheDir(key), { recursive: true, force: true });
  return c.json({ released: rows.length });
});

// 抓详情+目录并写入章节快照（加书架与刷新共用）；最新章节 URL 供 {page} 模板推最大页码
async function snapshotToc(eng: Engine, bookUrl: string) {
  const info = await eng.bookInfo(bookUrl);
  const toc = await eng.toc(info.tocUrl, undefined, info.latestChapterUrl || undefined);
  if (!toc.length) throw new Error("目录为空");
  return { info, toc };
}

// 目录快照后台任务（加书架异步补目录）：完成后填充缺失字段并整表替换章节
const tocJobs = new Set<number>(); // 防同书并发抓
async function fillToc(bookId: number, eng: any, bookUrl: string) {
  if (tocJobs.has(bookId)) return;
  tocJobs.add(bookId);
  try {
    // 真实抓取走无头浏览器（调试/预览才是有头）
    const { info, toc } = await runWithBrowserMode("headless", () => snapshotToc(eng, bookUrl));
    const [b] = await db.select().from(books).where(eq(books.id, bookId));
    if (!b) return; // 书已被移出书架
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
    log.info("shelf", `《${info.name || b.name}》目录就绪：${toc.length} 章`);
  } catch (e: any) {
    log.error("shelf", `目录抓取失败 bookId=${bookId}：${e?.message ?? e}`);
  } finally {
    tocJobs.delete(bookId);
  }
}

// 加书架：直接落 books 表立即返回（信息来自搜索结果）；目录后台异步补，详情页轮询就绪
bookRoutes.post("/", async (c) => {
  const uid = c.get("uid");
  const body = await c.req
    .json<{
      bookUrl?: string;
      sourceId?: number;
      info?: { name?: string; author?: string; cover?: string; intro?: string; latestChapter?: string };
    }>()
    .catch(() => ({}) as any);
  const { bookUrl, sourceId, info } = body;
  if (!bookUrl || !sourceId) return c.json({ error: "缺少 bookUrl/sourceId" }, 400);
  const eng = await loadEngine(sourceId).catch((e) => {
    throw new Error(`书源不可用：${e.message}`);
  });

  const [existing] = await db
    .select()
    .from(books)
    .where(and(eq(books.userId, uid), eq(books.bookUrl, bookUrl), eq(books.sourceId, sourceId)));
  if (existing) {
    // 已在书架：不重复抓；目录缺失（上次异步抓取失败）时后台补一次
    const n = (await db.select({ idx: chapters.idx }).from(chapters).where(eq(chapters.bookId, existing.id))).length;
    if (!n) fillToc(existing.id, eng, bookUrl);
    return c.json({ id: existing.id, name: existing.name, async: false });
  }

  const [row] = await db
    .insert(books)
    .values({
      userId: uid,
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
    .returning({ id: books.id });
  fillToc(row.id, eng, bookUrl); // 不 await，后台执行
  log.info("shelf", `加书架：《${info?.name || "未知书名"}》bookId=${row.id}，目录后台抓取中`);
  return c.json({ id: row.id, name: info?.name || "未知书名", async: true });
});

// 搜索结果预览：不入库，抓详情+目录供"加入书架"前查看（放在 /:id 前注册）
bookRoutes.get("/preview", async (c) => {
  const sourceId = Number(c.req.query("sourceId"));
  const bookUrl = c.req.query("bookUrl") ?? "";
  if (!sourceId || !bookUrl) return c.json({ error: "缺少 sourceId/bookUrl" }, 400);
  const eng = await loadEngine(sourceId);
  const { info, toc } = await snapshotToc(eng, bookUrl);
  return c.json({
    name: info.name,
    author: info.author,
    cover: info.cover,
    intro: info.intro,
    latestChapter: info.latestChapter,
    chapterCount: toc.length,
    tocPreview: toc.slice(0, 30).map((ch, i) => ({ idx: i, title: ch.title })),
  });
});

// 书架列表：书 + 进度 + 章节数
bookRoutes.get("/", async (c) => {
  const uid = c.get("uid");
  const rows = await db.select().from(books).where(eq(books.userId, uid));
  if (!rows.length) return c.json([]);
  const ids = rows.map((r) => r.id);
  const progs = await db.select().from(progress).where(inArray(progress.bookId, ids));
  const progMap = new Map(progs.map((p) => [p.bookId, p]));
  const countMap = new Map<number, number>();
  const counts = await db
    .select({ bookId: chapters.bookId, count: count() })
    .from(chapters)
    .where(inArray(chapters.bookId, ids))
    .groupBy(chapters.bookId);
  for (const r of counts) countMap.set(r.bookId, r.count);
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
  const { info, toc } = await runWithBrowserMode("headless", () => snapshotToc(eng, book.bookUrl));
  const oldCount = (await db.select().from(chapters).where(eq(chapters.bookId, bookId))).length;
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
  return c.json({ chapterCount: toc.length, added, oldCount });
});

// 换源候选：并发搜索全部启用书源，只返回"拥有这本书"的源（书名精确命中优先，当前源标记 current）
bookRoutes.get("/:id/sources", async (c) => {
  const uid = c.get("uid");
  const bookId = Number(c.req.param("id"));
  const [book] = await db.select().from(books).where(and(eq(books.id, bookId), eq(books.userId, uid)));
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

// 换源：更换书源+详情地址，重抓目录快照；书架 id 与阅读进度保留
bookRoutes.put("/:id/source", async (c) => {
  const uid = c.get("uid");
  const bookId = Number(c.req.param("id"));
  const body = await c.req.json<{ sourceId?: number; bookUrl?: string }>().catch(() => ({}) as any);
  const { sourceId, bookUrl } = body;
  if (!sourceId || !bookUrl) return c.json({ error: "缺少 sourceId/bookUrl" }, 400);
  const [book] = await db.select().from(books).where(and(eq(books.id, bookId), eq(books.userId, uid)));
  if (!book) return c.json({ error: "书籍不存在" }, 404);
  const eng = await loadEngine(sourceId);
  const { info, toc } = await snapshotToc(eng, bookUrl);
  await db.delete(chapters).where(eq(chapters.bookId, bookId));
  await db.insert(chapters).values(toc.map((ch, i) => ({ bookId, idx: i, title: ch.title, url: ch.url })));
  await db
    .update(books)
    .set({ sourceId, bookUrl, name: info.name || book.name, author: info.author, cover: info.cover, intro: info.intro, latestChapter: info.latestChapter || info.latestChapterUrl || book.latestChapter, lastCheckAt: new Date() })
    .where(eq(books.id, bookId));
  log.info("source", `《${book.name}》换源 → ${info.name || "?"}（${toc.length} 章）`);
  return c.json({ chapterCount: toc.length, name: info.name });
});

bookRoutes.delete("/:id", async (c) => {
  const uid = c.get("uid");
  const bookId = Number(c.req.param("id"));
  const [book] = await db.select().from(books).where(and(eq(books.id, bookId), eq(books.userId, uid)));
  if (!book) return c.json({ error: "书籍不存在" }, 404);
  await db.delete(books).where(eq(books.id, bookId)); // chapters/progress 级联
  return c.json({ ok: true });
});

// 编辑书籍元数据：仅更新传入的字段；封面可为远程 URL 或 dataURL（前端压缩后的上传图）
// 约定：以 data: 开头的 cover 视为用户本地上传，巡检任务不会用源站封面覆盖它
const COVER_MAX = 2_000_000; // dataURL 长度上限（约 1.5MB 图），防止库被超大封面撑爆
bookRoutes.patch("/:id", async (c) => {
  const uid = c.get("uid");
  const bookId = Number(c.req.param("id"));
  const [book] = await db.select().from(books).where(and(eq(books.id, bookId), eq(books.userId, uid)));
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

// ---------- 定时巡检：周期性检查全部书籍是否有新章节 ----------
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
    const all = await db.select().from(books);
    let checked = 0;
    let updated = 0;
    let failed = 0;
    for (const b of all) {
      if (!b.sourceId) continue;
      checked++;
      try {
        const eng = await loadEngine(b.sourceId);
        const limiter = limiterFor(b.sourceId);
        if (limiter) await limiter.acquire(b.sourceId);
        const { info, toc } = await runWithBrowserMode("headless", () => snapshotToc(eng, b.bookUrl));
        if (limiter) limiter.onSuccess(b.sourceId);
        const oldCount = (await db.select({ idx: chapters.idx }).from(chapters).where(eq(chapters.bookId, b.id))).length;
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
    const { info, toc } = await runWithBrowserMode("headless", () => snapshotToc(eng, book.bookUrl));
    const old = await db.select().from(chapters).where(eq(chapters.bookId, bookId));
    await db.delete(chapters).where(eq(chapters.bookId, bookId));
    await db.insert(chapters).values(toc.map((ch, i) => ({ bookId, idx: i, title: ch.title, url: ch.url })));
    await db.update(books).set({ latestChapter: info.latestChapter || info.latestChapterUrl || book.latestChapter, lastCheckAt: new Date() }).where(eq(books.id, bookId));
  }
  const list = await db.select({ idx: chapters.idx, title: chapters.title }).from(chapters).where(eq(chapters.bookId, bookId));
  list.sort((a, b) => a.idx - b.idx);
  const key = contentKey(book.bookUrl);
  const cachedRows = await db.select({ idx: chapterCache.idx }).from(chapterCache).where(eq(chapterCache.contentKey, key));
  const cachedSet = new Set(cachedRows.map((r) => r.idx));
  const [prog] = await db.select().from(progress).where(eq(progress.bookId, bookId));
  return c.json({
    book: { id: book.id, name: book.name, author: book.author },
    chapters: list.map((ch) => ({ ...ch, cached: cachedSet.has(ch.idx) })),
    cachedCount: cachedSet.size,
    progress: prog ? { chapterIdx: prog.chapterIdx } : null,
  });
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
  if (cached) {
    try {
      const content = await readFile(cached.filePath, "utf-8");
      return c.json({ idx, title: ch.title, content, isPlaceholder: cached.isPlaceholder, cached: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  // 抓取走同源限速器（与全本缓存任务共享同一预算：阅读请求计入频率，窗口满时排队等待）
  const eng = await loadEngine(book.sourceId);
  const limiter = book.sourceId != null ? limiterFor(book.sourceId) : null;
  if (limiter) await limiter.acquire(book.sourceId!);
  let raw: string;
  try {
    raw = await runWithBrowserMode("headless", () => fetchAndSave(eng, ch.url, key, idx));
    limiter?.onSuccess(book.sourceId!);
  } catch (e) {
    limiter?.onFailure(book.sourceId!);
    throw e;
  }
  return c.json({ idx, title: ch.title, content: raw, isPlaceholder: isPlaceholder(raw), cached: false });
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
