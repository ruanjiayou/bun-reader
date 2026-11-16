import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { BookStatus, parseExploreGroups, exploreSource, parseStatus, statusFromValue } from "../src/source/engine";
import { normalizeSource } from "../src/source/rule";

describe("parseStatus / statusFromValue", () => {
  test("完结关键词 → 1", () => {
    expect(parseStatus("已完结")).toBe(BookStatus.Completed);
    expect(parseStatus("完本")).toBe(BookStatus.Completed);
    expect(parseStatus("已完結玄幻")).toBe(BookStatus.Completed);
    expect(parseStatus("大结局")).toBe(BookStatus.Completed);
  });
  test("连载关键词 → 0（优先于完结，防「未完结」误判）", () => {
    expect(parseStatus("连载中")).toBe(BookStatus.Ongoing);
    expect(parseStatus("未完结")).toBe(BookStatus.Ongoing);
    expect(parseStatus("更新中")).toBe(BookStatus.Ongoing);
  });
  test("太监断更 → 2 / 下架 → 3", () => {
    expect(parseStatus("太监")).toBe(BookStatus.Dropped);
    expect(parseStatus("断更")).toBe(BookStatus.Dropped);
    expect(parseStatus("已下架")).toBe(BookStatus.Removed);
  });
  test("空/匹配不上 → undefined（入库时不动已有状态）", () => {
    expect(parseStatus("")).toBeUndefined();
    expect(parseStatus("玄幻")).toBeUndefined();
  });
  test("statusFromValue 兼容数字/旧 finished 布尔/文案/非法值", () => {
    expect(statusFromValue(2)).toBe(BookStatus.Dropped);
    expect(statusFromValue(true)).toBe(BookStatus.Completed);
    expect(statusFromValue(false)).toBe(BookStatus.Ongoing);
    expect(statusFromValue("完本")).toBe(BookStatus.Completed);
    expect(statusFromValue(9)).toBeUndefined();
    expect(statusFromValue(undefined)).toBeUndefined();
  });
});

describe("normalizeSource 旧字段兼容", () => {
  test("ruleBookInfo.finished 自动改名为 status，且规则照常转换", () => {
    const out = normalizeSource({ ruleBookInfo: { finished: "@css:.tag span@text" } });
    expect(out.ruleBookInfo.finished).toBeUndefined();
    expect(typeof out.ruleBookInfo.status).toBe("string");
    expect(out.ruleBookInfo.status.length).toBeGreaterThan(0);
  });
  test("已有 status 时不被旧 finished 覆盖，且二次 normalize 幂等", () => {
    const once = normalizeSource({ ruleSearch: { status: "'.tag'.text()", finished: "'.old'.text()" } });
    expect(once.ruleSearch.finished).toBeUndefined();
    expect(normalizeSource(once).ruleSearch).toEqual(once.ruleSearch);
  });
});

describe("parseExploreGroups", () => {
  test("标准「标题::模板」按行解析，{{page}} 原样保留", () => {
    const g = parseExploreGroups({ exploreUrl: "玄幻::/xuanhuan/{{page}}.html\n奇幻::/qihuan/{{page}}.html" });
    expect(g).toEqual([
      { title: "玄幻", tpl: "/xuanhuan/{{page}}.html" },
      { title: "奇幻", tpl: "/qihuan/{{page}}.html" },
    ]);
  });

  test("旧式「标题,http…」与裸 url 行（自动编号）", () => {
    const g = parseExploreGroups({ exploreUrl: "都市,https://x.com/dushi/{{page}}.html\n/xuanhuan/{{page}}.html" });
    expect(g).toEqual([
      { title: "都市", tpl: "https://x.com/dushi/{{page}}.html" },
      { title: "分类2", tpl: "/xuanhuan/{{page}}.html" },
    ]);
  });

  test("模板自带 ,{json 请求选项} 不被误切", () => {
    const g = parseExploreGroups({ exploreUrl: `玄幻::/xuanhuan/{{page}}.html,{"method":"POST","body":"a=1"}` });
    expect(g).toEqual([{ title: "玄幻", tpl: `/xuanhuan/{{page}}.html,{"method":"POST","body":"a=1"}` }]);
  });

  test("JS 生成的 exploreUrl 返回空（静态解析不了）", () => {
    expect(parseExploreGroups({ exploreUrl: "<js>java.get('x')</js>" })).toEqual([]);
    expect(parseExploreGroups({ exploreUrl: "@js:[]" })).toEqual([]);
  });

  test("无 exploreUrl 返回空", () => {
    expect(parseExploreGroups({})).toEqual([]);
  });
});

describe("exploreSource", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base = "";
  const item = (name: string) =>
    `<div class="item"><a href="/b/${name}"><img src="/c/${name}.jpg"/></a><h3><a href="/b/${name}">${name}</a></h3><p><a href="/a/x">作者：甲</a></p></div>`;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const u = new URL(req.url);
        if (u.pathname === "/xuanhuan/1.html") return new Response(`<html>${item("一")}${item("二")}</html>`);
        if (u.pathname === "/xuanhuan/2.html") return new Response(`<html>${item("三")}</html>`);
        return new Response("nf", { status: 404 });
      },
    });
    base = `http://localhost:${server.port}`;
  });

  afterAll(() => server.stop(true));

  const src = {
    bookSourceUrl: "", // 运行时由测试赋值
    searchUrl: "/s",
    exploreUrl: "玄幻::/xuanhuan/{{page}}.html",
    ruleExplore: { bookList: "'.item'", name: "'h3 a'.text()", bookUrl: "'a:eq(0)'.attr('href')", author: "'p a'.text()", coverUrl: "'img'.attr('src')" },
  };

  test("按页抓取 + ruleExplore 解析 + 相对地址补全", async () => {
    const books = await exploreSource({ ...src, bookSourceUrl: base }, "/xuanhuan/{{page}}.html", 1);
    expect(books.map((b) => b.name)).toEqual(["一", "二"]);
    expect(books[0].bookUrl).toBe(`${base}/b/${encodeURIComponent("一")}`);
    expect(books[0].cover).toBe(`${base}/c/${encodeURIComponent("一")}.jpg`);
    expect(books[0].author).toBe("作者：甲");
    const p2 = await exploreSource({ ...src, bookSourceUrl: base }, "/xuanhuan/{{page}}.html", 2);
    expect(p2.map((b) => b.name)).toEqual(["三"]);
  });

  test("ruleExplore 缺省回退 ruleSearch", async () => {
    const s = { ...src, bookSourceUrl: base, ruleExplore: undefined, ruleSearch: src.ruleExplore } as any;
    const books = await exploreSource(s, "/xuanhuan/{{page}}.html", 1);
    expect(books.length).toBe(2);
  });

  test("页码收敛到 1..200：0/负数按第 1 页抓", async () => {
    const books = await exploreSource({ ...src, bookSourceUrl: base }, "/xuanhuan/{{page}}.html", 0);
    expect(books.map((b) => b.name)).toEqual(["一", "二"]);
  });
});
