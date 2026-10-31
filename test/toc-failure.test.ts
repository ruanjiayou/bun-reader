import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db, sqlite } from "../src/db";
import { books, chapters, sources } from "../src/schema";
import { bookRoutes } from "../src/routes/books";
import { httpText } from "../src/source/fetcher";
import { getBookInfo } from "../src/source/engine";
import { normalizeSource } from "../src/source/rule";

// 这一组锁的是「抓不到目录时到底发生了什么」：
// ① 站点用「200 + 0 字节」限流时，不能当成正常空页面一路解析下去（会变成「目录为空」，看着像规则写错）
// ② 后台抓目录失败后，前端必须能从 /category 看到 failed + 原因，从而停止轮询
// ③ 手工重试失败要返回可读文案（502 + error），不是 500 Internal Server Error

const tag = `test://toc-fail-${Date.now()}`;
let uid = 0;
let server: ReturnType<typeof Bun.serve>;
let base = "";
let srcId = 0;
const bookIds: number[] = [];

const app = () => {
  const a = new Hono();
  a.use("*", async (c, next) => {
    (c as any).set("uid", uid);
    await next();
  });
  a.route("/books", bookRoutes);
  return a;
};

const HTML_OK = `<!doctype html><html><body>
  <h1 class="name">测试书名</h1>
  <div class="author">某作者</div>
  <div class="intro">简介</div>
</body></html>`;

beforeAll(async () => {
  let emptyHits = 0;
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      const html = (s: string) => new Response(s, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      // /flaky：前两次 200 + 0 字节（模拟限流），第三次才正常
      if (path === "/flaky") {
        emptyHits++;
        return emptyHits <= 2 ? new Response("", { status: 200, headers: { "Content-Type": "text/html" } }) : html(HTML_OK);
      }
      // /empty：永远 200 + 0 字节
      if (path === "/empty") return new Response("", { status: 200, headers: { "Content-Type": "text/html" } });
      // /book1：详情正常，但没有目录链接页（ruleToc 选择器必然 0 命中）
      if (path === "/book1") return html(HTML_OK);
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
  uid = (sqlite.query("SELECT id FROM users ORDER BY id LIMIT 1").get() as { id: number }).id;

  const [s] = await db
    .insert(sources)
    .values({
      name: "目录失败测试源",
      bookUrl: base,
      group: "测试",
      type: "rules",
      json: JSON.stringify({
        bookSourceUrl: base,
        bookSourceName: "目录失败测试源",
        ruleBookInfo: { name: ".name", author: ".author", intro: ".intro" },
        // 选择器永远命中不到 → 目录 0 章 → 上层抛「目录为空」
        ruleToc: { chapterList: ".no-such-list a" },
      }),
    })
    .returning({ id: sources.id });
  srcId = s.id;
});

afterAll(async () => {
  server.stop(true);
  for (const id of bookIds) {
    sqlite.query("DELETE FROM chapters WHERE book_id = ?").run(id);
    sqlite.query("DELETE FROM shelf WHERE book_id = ?").run(id);
    sqlite.query("DELETE FROM books WHERE id = ?").run(id);
  }
  await db.delete(sources).where(eq(sources.id, srcId));
});

describe("200 + 0 字节：当失败重试，不当空页面", () => {
  test("空响应会重试，第三次拿到内容就算成功", async () => {
    const r = await httpText(`${base}/flaky`);
    expect(r.status).toBe(200);
    expect(r.text).toContain("测试书名");
  });

  test("重试后仍为空：详情页给出明确原因，而不是继续解析成「目录为空」", async () => {
    const src = normalizeSource({ bookSourceUrl: base, bookSourceName: "空响应站", ruleBookInfo: { name: ".name" } });
    await expect(getBookInfo(src, `${base}/empty`)).rejects.toThrow(/详情页内容为空/);
  });
});

describe("目录抓取失败可观测：前端据此停止轮询", () => {
  test("入库后目录抓取失败 → /category 返回 failed + 原因", async () => {
    const res = await app().request("/books/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookUrl: `${base}/book1`, sourceId: srcId, info: { name: "测试书名" } }),
    });
    const created = await res.json<any>();
    bookIds.push(created.id);
    // 刚入库时后台任务已启动（不 await），状态应是 fetching，而不是 idle
    expect(created.toc?.status).toBe("fetching");

    // 等后台任务跑完（本地站，很快）
    let toc: any = null;
    for (let i = 0; i < 40; i++) {
      const cat = await (await app().request(`/books/${created.id}/category`)).json<any>();
      toc = cat.toc;
      if (toc?.status === "failed" || toc?.status === "done") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(toc?.status).toBe("failed");
    expect(toc?.error).toContain("目录为空");
  });

  test("手工重试失败返回 502 + 可读原因（不是 500）", async () => {
    const bookId = bookIds[bookIds.length - 1];
    const res = await app().request(`/books/${bookId}/refresh`, { method: "PUT" });
    expect(res.status).toBe(502);
    const body = await res.json<any>();
    expect(body.error).toContain("目录为空");
  });
});
