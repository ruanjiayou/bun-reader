import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { httpText } from "../src/source/fetcher";

// 模拟「站点换域名 + 301 Location 不带查询串」：请求 GET /redir?key=x → 跳到另一个 host 的 /i/sor（无参数）
let server: ReturnType<typeof Bun.serve>;
let port = 0;
let hits = 0; // /i/sor 被请求次数

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/i/sor") {
        hits++;
        return new Response(u.searchParams.has("key") ? "<html>有结果</html>" : "<html>参数缺失</html>", {
          status: u.searchParams.has("key") ? 200 : 500,
        });
      }
      if (u.pathname === "/redir") return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${port}/i/sor` } });
      if (u.pathname === "/redir-same") return new Response(null, { status: 302, headers: { location: `http://localhost:${port}/i/sor` } });
      if (u.pathname === "/ok") return new Response("<html>ok</html>", { status: 200 });
      return new Response("nf", { status: 404 });
    },
  });
  port = server.port;
});

afterAll(() => server.stop(true));

describe("httpText 重定向丢查询串兜底", () => {
  test("跨域名跳转丢了 ?key 且落到 500：用最终域名 + 原查询串重试", async () => {
    hits = 0;
    const r = await httpText(`http://localhost:${port}/redir?key=%E5%87%A1%E4%BA%BA`, {}, 5000);
    expect(r.status).toBe(200);
    expect(r.text).toContain("有结果");
    expect(new URL(r.url).search).toContain("key=");
    expect(hits).toBe(2); // 原请求 + 兜底重试
  });

  test("同域名重定向丢了参数：不重试，保留原始 500", async () => {
    hits = 0;
    const r = await httpText(`http://localhost:${port}/redir-same?key=%E5%87%A1%E4%BA%BA`, {}, 5000);
    expect(r.status).toBe(500);
    expect(hits).toBe(1);
  });

  test("正常 200 不触发任何重试", async () => {
    hits = 0;
    const r = await httpText(`http://localhost:${port}/ok?key=1`, {}, 5000);
    expect(r.status).toBe(200);
    expect(hits).toBe(0);
  });

  test("POST 不触发兜底（重定向丢 body，猜参数无意义）", async () => {
    hits = 0;
    const r = await httpText(`http://localhost:${port}/redir?key=1`, { method: "POST", body: "a=1" }, 5000);
    expect(r.status).toBe(500);
    expect(hits).toBe(1);
  });
});
