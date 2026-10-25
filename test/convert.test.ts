import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { searchSource, getToc, getContent } from "../src/source/engine";
import { normalizeSource } from "../src/source/rule";
import { rulesToScript } from "../src/source/convert";
import { saveScriptFile, scriptSearch, scriptToc, scriptContent } from "../src/source/script";

// 转换器验收：规则书源生成的 JS 脚本，在同一 fixture 站点上产出与规则引擎完全一致

let server: ReturnType<typeof Bun.serve>;
let base = "";
const CID = 99011;
const CID2 = 99012; // {page} 模板分页变体

const html = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/search")
        return new Response(
          html(`
          <div class="bookbox"><h4><a href="/book/1" title="凡人修仙">凡人修仙传</a></h4><span class="author">忘语</span><img data-src="/img/1.jpg"><p class="intro">一个凡人的修仙故事</p></div>`),
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      if (u.pathname === "/book/1")
        return new Response(
          html(`<div id="info"><h1>凡人修仙传</h1><p>作者：忘语</p><div class="intro">一个凡人的修仙故事</div><a href="/book/1/toc">开始阅读</a></div>`),
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      if (u.pathname === "/book/1/toc")
        return new Response(
          html(`<ul class="chapterlist"><li><a href="/book/1/c1">第1章 测试</a></li><li><a href="/book/1/c2">第2章 测试</a></li></ul><div class="pager"><a href="/book/1/toc2">下一页</a></div>`),
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      if (u.pathname === "/book/1/toc2")
        return new Response(
          html(`<ul class="chapterlist"><li><a href="/book/1/c3">第3章 测试</a></li></ul>`),
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      if (u.pathname === "/book/1/c1") {
        const paras = Array.from({ length: 6 }, (_, i) => `第${i + 1}段：山间小路上，韩立背着破旧的包裹缓缓上山。`).join("<br><br>");
        return new Response(html(`<div id="content">${paras}<br><br>广告链接： advertisement here。</div>`), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      // {page} 变体：/book/2-1.html、-2.html 有章节，-3.html 404
      const paged: Record<string, [string, string][]> = {
        "/book/2-1.html": [["/book/2/p1", "第一章"], ["/book/2/p2", "第二章"]],
        "/book/2-2.html": [["/book/2/p3", "第三章"]],
      };
      if (paged[u.pathname])
        return new Response(
          html(`<ul class="chapterlist">${paged[u.pathname].map(([h, t]) => `<li><a href="${h}">${t}</a></li>`).join("")}</ul>`),
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  for (const id of [CID, CID2]) {
    const f = `data/sources/${id}.js`;
    if (existsSync(f)) rmSync(f);
  }
});

const rulesSource = () => ({
  bookSourceUrl: base,
  bookSourceName: "转换测试站",
  searchUrl: `${base}/search?keyword={{key}}`,
  ruleSearch: {
    bookList: ".bookbox",
    name: "h4 a.text()",
    author: ".author.text()",
    bookUrl: "h4 a.attr('href')",
    coverUrl: "img.attr('data-src')",
    intro: ".intro.text()",
  },
  ruleBookInfo: {
    name: "#info h1.text()",
    author: "#info p.text()##作者：",
    intro: ".intro.text()",
    tocUrl: "#info a.eq(0).attr('href')",
  },
  ruleToc: {
    chapterList: ".chapterlist li",
    chapterName: "a.text()",
    chapterUrl: "a.attr('href')",
    nextTocUrl: ".pager a.eq(-1).attr('href')",
  },
  ruleContent: {
    content: "#content.textNodes()",
    replaceRegex: "广告链接：.*",
  },
});

const pagedSource = () => ({
  bookSourceUrl: base,
  bookSourceName: "分页转换站",
  ruleBookInfo: { tocUrl: "{{bookUrl}}##$##-{page}.html" },
  ruleToc: { chapterList: ".chapterlist li", chapterName: "a.text()", chapterUrl: "a.attr('href')" },
  ruleContent: { content: "#content.textNodes()" },
});

describe("规则书源 → JS 脚本转换器", () => {
  test("生成代码包含 class 与四个方法", () => {
    const code = rulesToScript(rulesSource());
    expect(code).toContain("export default class Source");
    expect(code).toContain("async search(");
    expect(code).toContain("async getDetail(");
    expect(code).toContain("async getChapters(");
    expect(code).toContain("async getContent(");
    expect(code).toContain(`base = "${base}"`);
    expect(code).toContain("广告链接：.*"); // replaceRegex → replace 成员
  });

  test("转换脚本与规则引擎产出一致：搜索", async () => {
    const rules = normalizeSource(rulesSource());
    const fromRules = await searchSource(rules, "凡人");
    saveScriptFile(CID, rulesToScript(rulesSource()));
    const fromScript = await scriptSearch({ id: CID }, "凡人");
    expect(fromScript).toEqual(fromRules);
  });

  test("转换脚本与规则引擎产出一致：目录（含 nextTocUrl 翻页）", async () => {
    const rules = normalizeSource(rulesSource());
    const fromRules = await getToc(rules, `${base}/book/1/toc`);
    const fromScript = await scriptToc({ id: CID }, `${base}/book/1/toc`);
    expect(fromScript).toEqual(fromRules);
  });

  test("转换脚本与规则引擎产出一致：正文 + replaceRegex 净化", async () => {
    const rules = normalizeSource(rulesSource());
    const fromRules = await getContent(rules, `${base}/book/1/c1`);
    const fromScript = await scriptContent({ id: CID }, `${base}/book/1/c1`);
    expect(fromScript).toBe(fromRules);
    expect(fromScript).not.toContain("advertisement");
  });

  test("{page} 模板分页：转换脚本内部展开，产出与规则引擎盲试模式一致", async () => {
    const rules = normalizeSource(pagedSource());
    const fromRules = await getToc(rules, `${base}/book/2-{page}.html`);
    saveScriptFile(CID2, rulesToScript(pagedSource()));
    const fromScript = await scriptToc({ id: CID2 }, `${base}/book/2-{page}.html`);
    expect(fromScript.map((c) => c.title)).toEqual(fromRules.map((c) => c.title));
    expect(fromScript.map((c) => c.url)).toEqual(fromRules.map((c) => c.url));
  });
});
