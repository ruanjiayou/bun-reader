import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { getBookInfo, getContent, getToc } from "../src/source/engine";
import { rulesToScript } from "../src/source/convert";
import { normalizeSource } from "../src/source/rule";
import { existsSync, rmSync } from "node:fs";
import { saveScriptFile, scriptContent } from "../src/source/script";

// 章节正文分页：很多站点的正文一页放不下，正文末尾带「下一页」。
// 这里覆盖三种真实形态：href 翻页 / {page} 模板翻页 / 站点对任意页码返回同一页（必须收口）。
let server: ReturnType<typeof Bun.serve>;
let base = "";

const html = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
const page = (text: string, next?: string) =>
  new Response(
    html(`<div id="content">${text}</div>${next ? `<div class="pager"><a class="next" href="${next}">下一页</a></div>` : ""}`),
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

beforeAll(() => {
  const pages: Record<string, Response> = {
    // ① href 翻页：1 → 2 → 3，末页的「下一页」指回自己（很常见的坑）
    "/c/1.html": page("第一页内容：山路很长。", "/c/1_2.html"),
    "/c/1_2.html": page("第二页内容：他停下歇脚。", "/c/1_3.html"),
    "/c/1_3.html": page("第三页内容：天亮了。", "/c/1_3.html"),
    // ② {page} 模板翻页：页内没有可跟的链接，地址是 1_{page}.html，第 4 页 404
    "/t/1.html": page("模板第一页。"),
    "/t/1_2.html": page("模板第二页。"),
    "/t/1_3.html": page("模板第三页。"),
    // ③ 任意页码返回同一页（模板盲试必须靠「内容相同」收口，否则同一段拼满上限）
    "/s/1.html": page("同一页内容：只此一段。", "/s/1_2.html"),
    "/s/1_2.html": page("同一页内容：只此一段。", "/s/1_3.html"),
    // ④ 环形翻页：A → B → A
    "/loop/a.html": page("A 段。", "/loop/b.html"),
    "/loop/b.html": page("B 段。", "/loop/a.html"),
    // ⑤ 单页目录 + 详情页（调试日志用）
    "/toc/1.html": new Response(html(`<div class="ch"><a href="/c/1.html">第一章</a><a href="/c/1_2.html">第二章</a></div>`), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }),
    "/book/1.html": new Response(html(`<h1 id="t">测试书名</h1><span class="au">测试作者</span><a class="toc" href="/toc/1.html">目录</a>`), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }),
  };
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      if (pages[u.pathname]) return pages[u.pathname].clone();
      if (u.pathname === "/e/1.html") return page("错误页的第一页。", "/e/1_2.html");
      if (u.pathname === "/e/1_2.html") return new Response("boom", { status: 500 });
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

// 规则源：正文规则 + 章节内翻页规则
const src = (nextContentUrl: string) => ({
  bookSourceUrl: base,
  bookSourceName: "正文分页测试站",
  ruleContent: { content: "'#content'.textNodes()", nextContentUrl },
});

const blocks = (s: string) => s.split("\n").filter(Boolean);

describe("章节内翻页：href 翻页", () => {
  test("逐页抓取并按顺序拼接", async () => {
    const c = await getContent(src("'.next'.attr('href')"), `${base}/c/1.html`);
    expect(c).toContain("第一页内容");
    expect(c).toContain("第二页内容");
    expect(c).toContain("第三页内容");
    expect(c.indexOf("第一页")).toBeLessThan(c.indexOf("第二页"));
    expect(c.indexOf("第二页")).toBeLessThan(c.indexOf("第三页"));
    expect(blocks(c).length).toBe(3);
  });

  test("末页「下一页」指回自己：不重复抓、不死循环", async () => {
    const logs: string[] = [];
    const c = await getContent(src("'.next'.attr('href')"), `${base}/c/1.html`, (_l, _s, m) => logs.push(m));
    expect(blocks(c).length).toBe(3);
    expect(logs.some((m) => m.includes("分页合并完成：3 页"))).toBe(true);
  });

  test("环形翻页：地址抓过即停", async () => {
    const c = await getContent(src("'.next'.attr('href')"), `${base}/loop/a.html`);
    expect(blocks(c).length).toBe(2);
    expect(c).toContain("A 段");
    expect(c).toContain("B 段");
  });

  test("第 2 页 5xx：返回已抓到的部分而不是整章失败", async () => {
    const c = await getContent(src("'.next'.attr('href')"), `${base}/e/1.html`);
    expect(c).toBe("错误页的第一页。");
  });

  test("没配 nextContentUrl：只抓一页，并明确说明「无翻页」", async () => {
    const logs: string[] = [];
    const c = await getContent({ bookSourceUrl: base, ruleContent: { content: "'#content'.textNodes()" } }, `${base}/c/1.html`, (_l, _s, m) =>
      logs.push(m),
    );
    expect(c).toBe("第一页内容：山路很长。");
    expect(logs.some((m) => m.includes("正文无翻页：未配置 nextContentUrl"))).toBe(true);
  });
});

describe("章节内翻页：{page} 模板", () => {
  test("规则改写成分页模板后按页码展开，直到 404", async () => {
    // {{bookUrl}} 在正文里的语义 = 当前章地址：/t/1.html → /t/1_{page}.html
    const c = await getContent(src("{{bookUrl}}##\\.html$##_{page}.html"), `${base}/t/1.html`);
    expect(blocks(c)).toEqual(["模板第一页。", "模板第二页。", "模板第三页。"]);
  });

  test("页内链接不可用（取不到 href）时同样能靠模板翻页", async () => {
    // .next 不存在 → href 模式拿不到地址；模板模式不依赖页内链接
    const c = await getContent(src("'.next'.attr('href')||{{bookUrl}}##\\.html$##_{page}.html"), `${base}/t/1.html`);
    expect(blocks(c).length).toBe(3);
  });

  test("站点对任意页码返回同一页：内容相同即停，不重复拼接", async () => {
    const logs: string[] = [];
    const c = await getContent(src("{{bookUrl}}##\\.html$##_{page}.html"), `${base}/s/1.html`, (_l, _s, m) => logs.push(m));
    expect(blocks(c)).toEqual(["同一页内容：只此一段。"]);
    expect(logs.some((m) => m.includes("与上一页相同"))).toBe(true);
  });
});

describe("调试日志：单页也要有明确说明，字段一行一条", () => {
  test("目录没有翻页（未配规则）时打日志", async () => {
    const logs: string[] = [];
    const toc = await getToc(
      { bookSourceUrl: base, ruleToc: { chapterList: "'.ch a'", chapterName: ".text()", chapterUrl: ".attr('href')" } },
      `${base}/toc/1.html`,
      (_l, _s, m) => logs.push(m),
    );
    expect(toc.length).toBe(2);
    expect(logs.some((m) => m.includes("目录无翻页：未配置 nextTocUrl"))).toBe(true);
  });

  test("目录有翻页规则但没命中下一页时也打日志", async () => {
    const logs: string[] = [];
    await getToc(
      { bookSourceUrl: base, ruleToc: { chapterList: "'.ch a'", chapterName: ".text()", chapterUrl: ".attr('href')", nextTocUrl: "'.none'.attr('href')" } },
      `${base}/toc/1.html`,
      (_l, _s, m) => logs.push(m),
    );
    expect(logs.some((m) => m.includes("目录无翻页：下一页规则未命中链接"))).toBe(true);
  });

  test("详情字段不再挤在一行", async () => {
    const logs: string[] = [];
    const info = await getBookInfo(
      { bookSourceUrl: base, ruleBookInfo: { name: "'#t'.text()", author: "'.au'.text()", tocUrl: "'.toc'.attr('href')" } },
      `${base}/book/1.html`,
      (_l, _s, m) => logs.push(m),
    );
    expect(info.name).toBe("测试书名");
    expect(info.author).toBe("测试作者");
    expect(logs.some((m) => m === "书名: 测试书名")).toBe(true);
    expect(logs.some((m) => m === "作者: 测试作者")).toBe(true);
    expect(logs.some((m) => m.startsWith("封面: "))).toBe(true);
    expect(logs.some((m) => m.startsWith("目录地址: "))).toBe(true);
    // 旧写法把书名/最新章/tocUrl 拼在一行，肉眼分不清哪项没取到
    expect(logs.some((m) => m.includes("详情解析:"))).toBe(false);
  });
});

describe("转换器：正文分页规则 → 脚本源一致", () => {
  const ID = 99013;
  afterAll(() => {
    const f = `data/sources/${ID}.js`;
    if (existsSync(f)) rmSync(f);
  });

  test("href 翻页：脚本引擎产出与规则引擎一致", async () => {
    const rules = normalizeSource(src("'.next'.attr('href')"));
    saveScriptFile(ID, rulesToScript(rules));
    const fromRules = await getContent(rules, `${base}/c/1.html`);
    const fromScript = await scriptContent({ id: ID }, `${base}/c/1.html`);
    expect(fromScript).toBe(fromRules);
  });

  test("{page} 模板翻页：脚本引擎识别模板并按页码展开", async () => {
    const rules = normalizeSource(src("{{bookUrl}}##\\.html$##_{page}.html"));
    saveScriptFile(ID, rulesToScript(rules));
    const fromRules = await getContent(rules, `${base}/t/1.html`);
    const fromScript = await scriptContent({ id: ID }, `${base}/t/1.html`);
    expect(fromScript).toBe(fromRules);
    expect(blocks(fromScript).length).toBe(3);
  });
});

// Legado 的 text.xxx（按文字找元素）：很多站点的「下一页」没有 class，只能按文本定位。
// 以前转换器原样保留 text.xxx，选择器无效 → 翻页静默失效（next 取到空）。
describe("Legado text.xxx：按文字定位下一页", () => {
  const ID = 99014;
  afterAll(() => {
    const f = `data/sources/${ID}.js`;
    if (existsSync(f)) rmSync(f);
  });

  test("规则源：text.下一页@href 能翻页并拼全三页", async () => {
    // 原始 Legado 规则要先过 normalize（导入/运行前都会做），引擎只吃 v2 语法
    const c = await getContent(normalizeSource(src("text.下一页@href")), `${base}/c/1.html`);
    expect(blocks(c).length).toBe(3);
  });

  test("转换器 + 脚本源：与规则源产出一致", async () => {
    const rules = normalizeSource(src("text.下一页@href"));
    saveScriptFile(ID, rulesToScript(rules));
    const fromRules = await getContent(rules, `${base}/c/1.html`);
    const fromScript = await scriptContent({ id: ID }, `${base}/c/1.html`);
    expect(fromScript).toBe(fromRules);
    expect(blocks(fromScript).length).toBe(3);
  });

  test("存量脚本源：代码里还是旧的 text.下一页.attr('href') 也能翻页", async () => {
    const LEGACY_ID = 99015;
    const code = `export default class Source {
  async getContent(url) {
    const res = await fetchText(url);
    const ns = nodes(res.text);
    const text = ruleText(ns, "'#content'.textNodes()", res.url);
    if (!text) throw new Error("正文为空");
    const next = abs((ruleText(ns, "text.下一页.attr('href')", res.url).split(/\\s+/).pop() || ""), res.url);
    return next ? { text, next } : text;
  }
}`;
    saveScriptFile(LEGACY_ID, code);
    try {
      // runtime 的 ruleText/ruleSel 会先过 Legado 转换，旧代码不用重新生成
      const c = await scriptContent({ id: LEGACY_ID }, `${base}/c/1.html`);
      expect(blocks(c).length).toBe(3);
    } finally {
      const f = `data/sources/${LEGACY_ID}.js`;
      if (existsSync(f)) rmSync(f);
    }
  });
});
