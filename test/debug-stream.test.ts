import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { sqlite } from "../src/db";
import { log, runWithLogSink } from "../src/log";
import { sourceRoutes } from "../src/routes/sources";

// 调试面板的 SSE：日志必须边跑边到。
// 这里用「慢搜索」fixture 复现长时间的静默步骤，断言首条日志立刻到达、静默期有 tick 心跳、结果最后才来。

const TID = 99010;
let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname.startsWith("/search")) {
        await new Promise((r) => setTimeout(r, 3200)); // 模拟慢站点（真实场景是浏览器启动 + 人机验证）
        return new Response(
          `<html><body><div class="item"><a href="/book/1">凡人修仙传</a><span class="a">忘语</span></div></body></html>`,
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      }
      return new Response("nf", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
  sqlite
    .prepare(`INSERT OR REPLACE INTO sources (id, name, book_url, enabled, "group", json, type, created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(
      TID,
      "SSE 测试源",
      base,
      1,
      "测试",
      JSON.stringify({
        bookSourceName: "SSE 测试源",
        bookSourceUrl: base,
        searchUrl: "/search?kw={{key}}",
        ruleSearch: { bookList: ".item", name: "'a'.text()", author: "'.a'.text()", bookUrl: "'a'.attr('href')" },
      }),
      "rules",
      Date.now(),
    );
});

afterAll(() => {
  server?.stop(true);
  sqlite.prepare("DELETE FROM sources WHERE id = ?").run(TID);
});

// 从 SSE 响应里按到达时间收事件
async function collect(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const t0 = Date.now();
  const evts: { at: number; evt: any }[] = [];
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop()!;
    for (const p of parts) {
      const line = p.trim();
      if (!line.startsWith("data: ")) continue;
      evts.push({ at: Date.now() - t0, evt: JSON.parse(line.slice(6)) });
    }
  }
  return evts;
}

describe("调试 SSE：日志逐步到达", () => {
  test("搜索：首条日志立即到达，静默期有 tick 心跳，books 结果最后到", async () => {
    const app = new Hono();
    app.route("/sources", sourceRoutes);
    const res = await app.request(`http://x/sources/${TID}/debug`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "search", key: "我" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-accel-buffering")).toBe("no"); // 反代别缓冲

    const evts = await collect(res);
    const first = evts[0];
    expect(first.evt.msg).toContain("/search");
    expect(first.at).toBeLessThan(1500); // 不是等搜索跑完才一起吐出来

    const ticks = evts.filter((e) => typeof e.evt.tick === "number");
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[0].evt.tick).toBeGreaterThanOrEqual(3);

    const booksIdx = evts.findIndex((e) => e.evt.step === "books");
    expect(booksIdx).toBeGreaterThan(0);
    expect(evts[booksIdx].at).toBeGreaterThan(ticks[0].at); // 结果晚于心跳：说明确实是流式
    expect(evts[booksIdx].evt.books[0]).toMatchObject({ name: "凡人修仙传", author: "忘语" });
    expect(evts[evts.length - 1].evt).toMatchObject({ step: "done", level: "ok" });
  }, 20_000);
});

describe("日志汇集（runWithLogSink）", () => {
  test("异步链路里的 log 被实时收走，作用域外不串台", async () => {
    const got: string[] = [];
    await runWithLogSink(
      (level, tag, msg) => got.push(`${level}/${tag}/${msg}`),
      async () => {
        log.info("browser", "浏览器已启动");
        await new Promise((r) => setTimeout(r, 20));
        log.warn("browser", "WAF/人机验证挑战");
      },
    );
    log.info("outside", "不该被捕获");
    expect(got).toEqual(["info/browser/浏览器已启动", "warn/browser/WAF/人机验证挑战"]);
  });
});
