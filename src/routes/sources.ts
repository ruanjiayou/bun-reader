import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { sources } from "../schema";
import { httpText } from "../source/fetcher";
import { searchSource, getBookInfo, getToc, getContent, type LogLevel } from "../source/engine";
import { normalizeSource } from "../source/rule";
import type { AuthEnv } from "../auth";

export const sourceRoutes = new Hono<AuthEnv>();

const readBody = async <T>(c: any): Promise<T> => c.req.json().catch(() => ({}));

// 扁平列表（不含完整 json，避免几百个源时响应爆炸）
sourceRoutes.get("/", async (c) => {
  const rows = await db
    .select({
      id: sources.id,
      name: sources.name,
      bookUrl: sources.bookUrl,
      group: sources.group,
      enabled: sources.enabled,
      lastUseAt: sources.lastUseAt,
    })
    .from(sources);
  return c.json(rows);
});

// 导出：全部书源的原始 JSON 数组（与 Legado 导出格式一致）
sourceRoutes.get("/export", async (c) => {
  const rows = await db.select({ json: sources.json }).from(sources);
  return c.json(rows.map((r) => JSON.parse(r.json)));
});

sourceRoutes.get("/:id", async (c) => {
  const [row] = await db.select().from(sources).where(eq(sources.id, Number(c.req.param("id"))));
  if (!row) return c.json({ error: "书源不存在" }, 404);
  return c.json(row);
});

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
      await db.update(sources).set({ name, group: s.bookSourceGroup ?? "默认", json: JSON.stringify(s) }).where(eq(sources.id, exist.id));
      updated++;
    } else {
      await db.insert(sources).values({
        name,
        bookUrl: url,
        group: s.bookSourceGroup ?? "默认",
        enabled: s.enabled !== false,
        json: JSON.stringify(s),
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
  const src = normalizeSource(JSON.parse(row.json)); // 兼容入库时尚未转换的旧关键字规则
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
  let chapterUrl = "";
  const ok =
    (await run("search", async () => {
      const books = await searchSource(src, key);
      if (!books.length) throw new Error("搜索无结果");
      bookUrl = books[0].bookUrl;
      return `${books.length} 条，首条 ${books[0].name}`;
    })) &&
    (await run("book", async () => {
      const info = await getBookInfo(src, bookUrl);
      tocUrl = info.tocUrl;
      return info.name || "（未取到书名，继续）";
    })) &&
    (await run("toc", async () => {
      const toc = await getToc(src, tocUrl);
      if (!toc.length) throw new Error("目录为空");
      chapterUrl = toc[0].url;
      return `${toc.length} 章`;
    })) &&
    (await run("content", async () => {
      const content = await getContent(src, chapterUrl);
      return `${content.length} 字`;
    }));
  return c.json({ ok, steps });
});

// 调试搜索：返回结果列表（含每条的书名/作者/最新章节等），便于检查规则提取效果
sourceRoutes.post("/:id/debug-search", async (c) => {
  const { key = "我的" } = await readBody<{ key?: string }>(c);
  const [row] = await db.select().from(sources).where(eq(sources.id, Number(c.req.param("id"))));
  if (!row) return c.json({ error: "书源不存在" }, 404);
  const src = normalizeSource(JSON.parse(row.json));
  const logs: { level: LogLevel; step: string; msg: string }[] = [];
  try {
    const books = await searchSource(src, key, (level, step, msg) => logs.push({ level, step, msg }));
    return c.json({ books, logs });
  } catch (e: any) {
    return c.json({ books: [], logs, error: e?.message ?? String(e) });
  }
});

// 调试：SSE 流式推送每步日志。带 bookUrl 时从详情开始（调书籍），否则从搜索开始（调源）
sourceRoutes.post("/:id/debug", async (c) => {
  const { key = "我的", bookUrl } = await readBody<{ key?: string; bookUrl?: string }>(c);
  const [row] = await db.select().from(sources).where(eq(sources.id, Number(c.req.param("id"))));
  if (!row) return c.json({ error: "书源不存在" }, 404);
  const src = normalizeSource(JSON.parse(row.json));
  const id = Number(c.req.param("id"));

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (level: LogLevel, step: string, msg: string) =>
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ level, step, msg })}\n\n`));
      try {
        let name = "";
        let tocUrl = "";
        if (bookUrl) {
          const info = await getBookInfo(src, bookUrl, send);
          name = info.name || "（未取到书名）";
          tocUrl = info.tocUrl;
        } else {
          const books = await searchSource(src, key, send);
          if (!books.length) throw new Error("搜索无结果");
          name = books[0].name;
          const info = await getBookInfo(src, books[0].bookUrl, send);
          tocUrl = info.tocUrl;
        }
        const toc = await getToc(src, tocUrl, send);
        if (!toc.length) throw new Error("目录为空");
        const content = await getContent(src, toc[0].url, send);
        send("ok", "done", `调试完成：${name} → ${toc.length} 章 → 首章正文 ${content.length} 字`);
      } catch (e: any) {
        send("err", "done", e?.message ?? String(e));
      } finally {
        await db.update(sources).set({ lastUseAt: new Date() }).where(eq(sources.id, id));
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
});
