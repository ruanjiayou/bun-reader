import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { books, sources } from "../schema";
import { httpText } from "../source/fetcher";
import { engineFor } from "../source/facade";
import type { LogLevel } from "../source/engine";
import { normalizeSource } from "../source/rule";
import { exploreSource, parseExploreGroups } from "../source/engine";
import { rulesToScript } from "../source/convert";
import { saveScriptFile, formToCode, validateScriptCode, type ScriptForm } from "../source/script";
import type { AuthEnv } from "../auth";
import { log, runWithLogSink } from "../log";

export const sourceRoutes = new Hono<AuthEnv>();

const readBody = async <T>(c: any): Promise<T> => c.req.json().catch(() => ({}));

// 扁平列表（不含完整 json，避免几百个源时响应爆炸）
// bookCount = 这个源下已有几本书（含各用户各存一份的副本，去重按 bookUrl 数）
sourceRoutes.get("/", async (c) => {
  const rows = await db
    .select({
      id: sources.id,
      name: sources.name,
      bookUrl: sources.bookUrl,
      group: sources.group,
      enabled: sources.enabled,
      type: sources.type,
      lastUseAt: sources.lastUseAt,
    })
    .from(sources);
  const counts = await db
    .select({ sourceId: books.sourceId, n: sql<number>`count(distinct ${books.bookUrl})` })
    .from(books)
    .groupBy(books.sourceId);
  const countMap = new Map(counts.map((r) => [r.sourceId, Number(r.n)]));
  return c.json(rows.map((r) => ({ ...r, bookCount: countMap.get(r.id) ?? 0 })));
});

// 导出：全部书源的原始 JSON 数组（与 Legado 导出格式一致）
sourceRoutes.get("/export", async (c) => {
  const rows = await db.select({ json: sources.json }).from(sources);
  return c.json(rows.map((r) => JSON.parse(r.json)));
});

// 探索源列表：启用且 exploreUrl 能解析出分类的规则源（脚本源暂不支持探索）。
// 注意必须注册在 /:id 之前，否则会被当成 id=explore 吃掉
sourceRoutes.get("/explore", async (c) => {
  const rows = await db
    .select({ id: sources.id, name: sources.name, json: sources.json, type: sources.type })
    .from(sources)
    .where(eq(sources.enabled, true));
  const list = rows
    .filter((r) => r.type === "rules")
    .map((r) => {
      let categories: { title: string; tpl: string }[] = [];
      try {
        categories = parseExploreGroups(normalizeSource(JSON.parse(r.json)));
      } catch {
        /* 坏 json 的源没有探索 */
      }
      return { id: r.id, name: r.name, categories };
    })
    .filter((r) => r.categories.length);
  return c.json(list);
});

// 抓一个探索分类页：url = 分类模板（原样透传给 buildReq 替换 {{page}}），page 从 1 起
sourceRoutes.get("/:id/explore", async (c) => {
  const [row] = await db.select().from(sources).where(eq(sources.id, Number(c.req.param("id"))));
  if (!row) return c.json({ error: "书源不存在" }, 404);
  if (row.type !== "rules") return c.json({ error: "脚本源暂不支持探索" }, 400);
  const tpl = c.req.query("url") ?? "";
  if (!tpl) return c.json({ error: "缺少分类模板 url" }, 400);
  let src: any;
  try {
    src = normalizeSource(JSON.parse(row.json));
  } catch {
    return c.json({ error: "书源 JSON 解析失败" }, 500);
  }
  const page = Math.min(Math.max(1, Number(c.req.query("page")) || 1), 200);
  try {
    const books = await exploreSource(src, tpl, page);
    return c.json({ page, books });
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 502);
  }
});

sourceRoutes.get("/:id", async (c) => {
  const [row] = await db.select().from(sources).where(eq(sources.id, Number(c.req.param("id"))));
  if (!row) return c.json({ error: "书源不存在" }, 404);
  return c.json(row);
});

// 当前生效的脚本代码：script 源 = 用户代码；rules 源 = 转换器生成的只读代码
sourceRoutes.get("/:id/code", async (c) => {
  const [row] = await db.select().from(sources).where(eq(sources.id, Number(c.req.param("id"))));
  if (!row) return c.json({ error: "书源不存在" }, 404);
  if (row.type === "script") return c.json({ code: row.code ?? "", generated: false });
  return c.json({ code: row.code || rulesToScript(JSON.parse(row.json)), generated: true });
});

// 新建/更新脚本源：表单数据（name/base/headers/replace/methods）→ 合并生成 class 代码
// 表单给人看和编辑，生成的 js 脚本是给程序执行的产物（json 存表单、code 存生成结果）
async function saveScriptSource(c: any, existId: number | null) {
  const form = await readBody<ScriptForm>(c);
  const name = (form.name ?? "").trim();
  if (!name) return c.json({ error: "缺少源名称" }, 400);
  const code = formToCode(form);
  const err = await validateScriptCode(code);
  if (err) return c.json({ error: `脚本校验失败：${err}` }, 400);
  if (existId === null) {
    const [row] = await db
      .insert(sources)
      .values({ name, bookUrl: (form.base ?? "").trim(), group: "脚本", json: JSON.stringify(form), type: "script", code })
      .returning({ id: sources.id });
    saveScriptFile(row.id, code);
    log.info("source", `新建脚本源「${name}」id=${row.id}`);
    return c.json({ id: row.id, name });
  }
  const [row] = await db.select().from(sources).where(eq(sources.id, existId));
  if (!row) return c.json({ error: "书源不存在" }, 404);
  if (row.type !== "script") return c.json({ error: "规则源请编辑规则表单，保存时会自动重新生成脚本" }, 400);
  await db.update(sources).set({ name, bookUrl: (form.base ?? "").trim(), json: JSON.stringify(form), code }).where(eq(sources.id, existId));
  saveScriptFile(existId, code);
  log.info("source", `更新脚本源「${name}」id=${existId}`);
  return c.json({ ok: true, id: existId });
}

sourceRoutes.post("/script", (c) => saveScriptSource(c, null));
sourceRoutes.put("/script/:id", (c) => saveScriptSource(c, Number(c.req.param("id"))));

sourceRoutes.put("/:id", async (c) => {
  const body = await readBody<{ enabled?: boolean; name?: string }>(c);
  const patch: Record<string, any> = {};
  if (body.enabled !== undefined) patch.enabled = body.enabled;
  if (body.name !== undefined) patch.name = body.name;
  if (!Object.keys(patch).length) return c.json({ error: "无可更新字段" }, 400);
  await db.update(sources).set(patch).where(eq(sources.id, Number(c.req.param("id"))));
  return c.json({ ok: true });
});

sourceRoutes.delete("/:id", async (c) => {
  await db.delete(sources).where(eq(sources.id, Number(c.req.param("id"))));
  return c.json({ ok: true });
});

// 导入：text 为 Legado 书源 JSON（单个对象或数组），url 则先抓取再解析；按 bookSourceUrl 去重 upsert
sourceRoutes.post("/import", async (c) => {
  const body = await readBody<{ text?: string; url?: string }>(c);
  let text = body.text ?? "";
  if (!text && body.url) {
    const res = await httpText(body.url, {}, 15000);
    if (res.status >= 400) return c.json({ error: `导入地址 HTTP ${res.status}` }, 400);
    text = res.text;
  }
  if (!text) return c.json({ error: "缺少 text 或 url" }, 400);
  let parsed: any;
  try {
    parsed = JSON.parse(text.trim().replace(/^\[/, "[").replace(/^\{/, "{"));
  } catch {
    return c.json({ error: "JSON 解析失败，请检查格式" }, 400);
  }
  const list: any[] = Array.isArray(parsed) ? parsed : [parsed];
  let added = 0;
  let updated = 0;
  for (const raw of list) {
    const s = normalizeSource(raw); // Legado 关键字规则 → 本项目 CSS 语法后入库
    const url = s.bookSourceUrl;
    const name = s.bookSourceName;
    if (!url || !name) continue; // ponytail: 跳过非法条目而不是整体失败
    const [exist] = await db.select({ id: sources.id }).from(sources).where(eq(sources.bookUrl, url));
    if (exist) {
      await db.update(sources).set({ name, group: s.bookSourceGroup ?? "默认", json: JSON.stringify(s), code: rulesToScript(s), type: "rules" }).where(eq(sources.id, exist.id));
      updated++;
    } else {
      await db.insert(sources).values({
        name,
        bookUrl: url,
        group: s.bookSourceGroup ?? "默认",
        enabled: s.enabled !== false,
        json: JSON.stringify(s),
        type: "rules",
        code: rulesToScript(s),
      });
      added++;
    }
  }
  if (!added && !updated) return c.json({ error: "未找到有效书源（需含 bookSourceUrl/bookSourceName）" }, 400);
  return c.json({ added, updated, total: list.length });
});

// 体检：搜索→详情→目录→正文 四步全过才算可用
sourceRoutes.post("/:id/test", async (c) => {
  const { key = "我的" } = await readBody<{ key?: string }>(c);
  const [row] = await db.select().from(sources).where(eq(sources.id, Number(c.req.param("id"))));
  if (!row) return c.json({ error: "书源不存在" }, 404);
  const eng = engineFor(row); // 兼容入库时尚未转换的旧关键字规则（normalize 在规则引擎内做）
  const steps: { step: string; ok: boolean; msg: string }[] = [];
  const run = async (step: string, fn: () => Promise<string>) => {
    try {
      const msg = await fn();
      steps.push({ step, ok: true, msg });
      return true;
    } catch (e: any) {
      steps.push({ step, ok: false, msg: e?.message ?? String(e) });
      return false;
    }
  };
  let bookUrl = "";
  let tocUrl = "";
  let lastChapterUrl = "";
  let chapterUrl = "";
  const ok =
    (await run("search", async () => {
      const books = await eng.search(key);
      if (!books.length) throw new Error("搜索无结果");
      bookUrl = books[0].bookUrl;
      return `${books.length} 条，首条 ${books[0].name}`;
    })) &&
    (await run("book", async () => {
      const info = await eng.bookInfo(bookUrl);
      tocUrl = info.tocUrl;
      lastChapterUrl = info.latestChapterUrl || info.latestChapter; // URL 供 {page} 推最大页码
      return info.name || "（未取到书名，继续）";
    })) &&
    (await run("toc", async () => {
      const toc = await eng.toc(tocUrl, undefined, lastChapterUrl);
      if (!toc.length) throw new Error("目录为空");
      chapterUrl = toc[0].url;
      return `${toc.length} 章`;
    })) &&
    (await run("content", async () => {
      const content = await eng.content(chapterUrl);
      return `${content.length} 字`;
    }));
  return c.json({ ok, steps });
});

// 调试搜索：返回结果列表（含每条的书名/作者/最新章节等），便于检查规则提取效果
sourceRoutes.post("/:id/debug-search", async (c) => {
  const { key = "我的" } = await readBody<{ key?: string }>(c);
  const [row] = await db.select().from(sources).where(eq(sources.id, Number(c.req.param("id"))));
  if (!row) return c.json({ error: "书源不存在" }, 404);
  const eng = engineFor(row);
  const logs: { level: LogLevel; step: string; msg: string }[] = [];
  try {
    const books = await eng.search(key, (level, step, msg) => logs.push({ level, step, msg }));
    return c.json({ books, logs });
  } catch (e: any) {
    return c.json({ books: [], logs, error: e?.message ?? String(e) });
  }
});

// 调试：SSE 流式推送每步日志。带 bookUrl 时从详情开始（调书籍），否则从搜索开始（调源）。
// mode=search → 只跑搜索，末尾推 books 事件（前端「调搜索」也走这条流，跟书籍调试一样逐步可见）。
// 三件事保证「不会等很久再一次性刷出来」：
//   ① 引擎的 log 回调逐步 push；② 底层日志（浏览器启动/人机验证/抓取）经 runWithLogSink 实时并入同一条流；
//   ③ 3s 无事件时推一条 tick 心跳，前端显示「仍在运行 Ns」，也顺带防代理掐空闲连接。
sourceRoutes.post("/:id/debug", async (c) => {
  const { key = "我的", bookUrl, mode } = await readBody<{ key?: string; bookUrl?: string; mode?: "search" | "full" }>(c);
  const [row] = await db.select().from(sources).where(eq(sources.id, Number(c.req.param("id"))));
  if (!row) return c.json({ error: "书源不存在" }, 404);
  const eng = engineFor(row);
  const id = Number(c.req.param("id"));

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      let lastAt = Date.now();
      const started = Date.now();
      const push = (obj: unknown) => {
        if (closed) return;
        lastAt = Date.now();
        controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      const send = (level: LogLevel, step: string, msg: string) => push({ level, step, msg });
      const hb = setInterval(() => {
        if (Date.now() - lastAt < 3000) return;
        push({ tick: Math.round((Date.now() - started) / 1000) });
      }, 1000);
      try {
        // 请求级日志汇集：browser/runtime/engine 里的 log.info/warn 全部实时转成前端日志行
        await runWithLogSink(
          (level, tag, msg) => send(level === "error" ? "err" : level === "warn" ? "warn" : "info", tag, msg),
          async () => {
            if (mode === "search") {
              const books = await eng.search(key, send);
              push({ level: books.length ? "ok" : "warn", step: "books", msg: `搜索到 ${books.length} 条`, books });
              send(books.length ? "ok" : "warn", "done", books.length ? `搜索完成：${books.length} 条` : "搜索无结果");
              return;
            }
            let name = "";
            let tocUrl = "";
            let lastChUrl = "";
            if (bookUrl) {
              const info = await eng.bookInfo(bookUrl, send);
              name = info.name || "（未取到书名）";
              tocUrl = info.tocUrl;
              lastChUrl = info.latestChapterUrl;
              // 详情一解析完就把书籍信息推给前端：封面/作者立刻可见，不必等目录正文跑完
              push({
                level: "ok",
                step: "bookinfo",
                msg: "书籍信息（可用于加书架）",
                info: { bookUrl, name: info.name, author: info.author, cover: info.cover, intro: info.intro, latestChapter: info.latestChapter || info.latestChapterUrl },
              });
            } else {
              const books = await eng.search(key, send);
              if (!books.length) throw new Error("搜索无结果");
              name = books[0].name;
              const info = await eng.bookInfo(books[0].bookUrl, send);
              tocUrl = info.tocUrl;
              lastChUrl = info.latestChapterUrl;
              push({
                level: "ok",
                step: "bookinfo",
                msg: "书籍信息（可用于加书架）",
                info: {
                  bookUrl: books[0].bookUrl,
                  name: info.name || books[0].name,
                  author: info.author || books[0].author,
                  cover: info.cover || books[0].cover,
                  intro: info.intro || books[0].intro,
                  latestChapter: info.latestChapter || info.latestChapterUrl || books[0].latestChapter,
                },
              });
            }
            const toc = await eng.toc(tocUrl, send, lastChUrl || undefined);
            if (!toc.length) throw new Error("目录为空");
            const content = await eng.content(toc[0].url, send);
            send("ok", "done", `调试完成：${name} → ${toc.length} 章 → 首章正文 ${content.length} 字`);
          },
        );
      } catch (e: any) {
        send("err", "done", e?.message ?? String(e));
      } finally {
        clearInterval(hb);
        await db.update(sources).set({ lastUseAt: new Date() }).where(eq(sources.id, id));
        closed = true;
        try {
          controller.close();
        } catch {
          /* 前端已断开 */
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // nginx 等反代默认会缓冲响应体，SSE 必须显式关闭缓冲，否则日志会攒到结束才一起吐出来
      "X-Accel-Buffering": "no",
    },
  });
});
