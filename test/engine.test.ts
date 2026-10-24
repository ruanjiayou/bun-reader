import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { searchSource, getBookInfo, getToc, getContent, isPlaceholder } from "../src/source/engine";
import { applyRule, htmlNodes, nodeText, legadoToOurs } from "../src/source/rule";

// 本地 fixture 站点：模拟一本假书的 搜索/详情/目录/正文
let server: ReturnType<typeof Bun.serve>;
let base = "";

const html = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/search") {
        return new Response(
          html(`
          <div class="bookbox">
            <h4><a href="/book/1" title="凡人修仙">凡人修仙传</a></h4>
            <span class="author">忘语</span>
            <img data-src="/img/1.jpg">
            <p class="intro">一个凡人的修仙故事</p>
            <span class="last">第2000章 大结局</span>
          </div>
          <div class="bookbox">
            <h4><a href="/book/2">斗破苍穹</a></h4>
            <span class="author">天蚕土豆</span>
            <img data-src="/img/2.jpg">
            <p class="intro">斗气大陆</p>
            <span class="last">第1600章 结束</span>
          </div>`),
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      }
      if (u.pathname === "/book/1") {
        return new Response(
          html(`<div id="info"><h1>凡人修仙传</h1><p>作者：忘语</p><div class="intro">一个凡人的修仙故事</div><a href="/book/1/toc">开始阅读</a></div>`),
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      }
      if (u.pathname === "/book/2") {
        // 无目录链接的详情页，目录地址靠 {{bookUrl}} 模板推出
        return new Response(
          html(`<div id="info"><h1>斗破苍穹</h1><p>作者：天蚕土豆</p></div>`),
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      }
      if (u.pathname === "/chapter/2.html") {
        return new Response(html(`<ul class="chapterlist"><li><a href="/chapter/2_1.html">第一章</a></li><li><a href="/chapter/2_2.html">第二章</a></li></ul>`), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (u.pathname === "/book/1/toc") {
        const items = Array.from({ length: 3 }, (_, i) => `<li><a href="/book/1/c${i + 1}">第${i + 1}章 测试</a></li>`).join("");
        return new Response(html(`<ul class="chapterlist">${items}</ul>`), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (u.pathname === "/book/1/c1") {
        const paras = Array.from(
          { length: 12 },
          (_, i) => `第${i + 1}段：山间小路上，韩立背着一个破旧的包裹，缓缓地朝着山上走去，心中想着家中年迈的双亲。`,
        ).join("<br><br>");
        return new Response(
          html(`<div id="content">${paras}<br><br>广告链接： advertisement here。</div>`),
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

// source 在 beforeAll 之后才能拿到 base，用工厂函数；规则一律用本项目 CSS 语法
const source = () => ({
  bookSourceUrl: base,
  bookSourceName: "测试站",
  searchUrl: `${base}/search?keyword={{key}}`,
  ruleSearch: {
    bookList: ".bookbox",
    name: "h4 a@text",
    author: ".author@text",
    bookUrl: "h4 a@href",
    coverUrl: "img@data-src",
    intro: ".intro@text",
    lastChapter: ".last@text",
  },
  ruleBookInfo: {
    name: "#info h1@text",
    author: "#info p@text##作者：",
    intro: ".intro@text",
    tocUrl: "#info a.0@href",
  },
  ruleToc: {
    chapterList: ".chapterlist li",
    chapterName: "a@text",
    chapterUrl: "a@href",
  },
  ruleContent: {
    content: "#content@textNodes",
    replaceRegex: "广告链接：.*",
  },
});

describe("书源引擎全链路", () => {
  test("搜索：列表 + 字段提取 + URL 补全", async () => {
    const books = await searchSource(source(), "凡人");
    expect(books.length).toBe(2);
    expect(books[0].name).toBe("凡人修仙传");
    expect(books[0].author).toBe("忘语");
    expect(books[0].bookUrl).toBe(`${base}/book/1`);
    expect(books[1].name).toBe("斗破苍穹");
  });

  test("详情：tocUrl 回退 + 正则净化", async () => {
    const info = await getBookInfo(source(), `${base}/book/1`);
    expect(info.name).toBe("凡人修仙传");
    expect(info.author).toBe("忘语"); // "作者：忘语" 经 ##作者： 去前缀
    expect(info.tocUrl).toBe(`${base}/book/1/toc`);
  });

  test("目录：列表 + 章节补全", async () => {
    const toc = await getToc(source(), `${base}/book/1/toc`);
    expect(toc.length).toBe(3);
    expect(toc[0].title).toBe("第1章 测试");
    expect(toc[0].url).toBe(`${base}/book/1/c1`);
  });

  test("正文：textNodes + replaceRegex 净化", async () => {
    const content = await getContent(source(), `${base}/book/1/c1`);
    expect(content).toContain("第1段：山间小路");
    expect(content).toContain("\n第2段："); // textNodes 按 <br> 分行
    expect(content).not.toContain("advertisement");
    expect(isPlaceholder(content)).toBe(false);
  });

  test("空规则防御：缺 bookUrl 规则的书被丢弃而非拼出垃圾 URL", async () => {
    const bad = { bookSourceUrl: base, searchUrl: `${base}/search?keyword={{key}}`, ruleSearch: { bookList: ".bookbox", name: "h4@text" } };
    const books = await searchSource(bad, "x");
    expect(books.length).toBe(0);
    const noBookList = { bookSourceUrl: base, searchUrl: `${base}/search?keyword={{key}}` };
    await expect(searchSource(noBookList, "x")).rejects.toThrow("缺少 ruleSearch.bookList");
  });

  test("Legado 关键字 → CSS 语法转换", () => {
    expect(legadoToOurs("class.bookbox")).toBe(".bookbox");
    expect(legadoToOurs("id.info@tag.h1@text")).toBe("#info@h1@text");
    expect(legadoToOurs("class.bookname@tag.a.0@href")).toBe(".bookname@a.0@href");
    expect(legadoToOurs("id.allchapter@tag.a.-1@href")).toBe("#allchapter@a.-1@href");
    // || 回退与 {{bookUrl}} 模板段原样保留
    expect(legadoToOurs("id.x@tag.a@href||{{bookUrl}}##/a/(\\d+)##/b/$1.html")).toBe(
      "#x@a@href||{{bookUrl}}##/a/(\\d+)##/b/$1.html",
    );
    // JsonPath 不动
    expect(legadoToOurs("$.data.books[*].name")).toBe("$.data.books[*].name");
    // 转换后的规则可求值
    const nodes = htmlNodes(`<div class="box"><a href="/x">名字</a></div>`);
    expect(nodeText(applyRule(nodes, legadoToOurs("class.box@tag.a@text"))[0])).toBe("名字");
  });

  test("CSS 语法求值：组合/层级/索引/属性", () => {
    const nodes = htmlNodes(`<ul id="all"><li><a href="/1">一</a></li><li><a href="/2">二</a></li></ul>`);
    expect(applyRule(nodes, "#all li").length).toBe(2); // id + 层级
    expect(nodeText(applyRule(nodes, "li a.-1@text")[0])).toBe("二"); // 索引 -1
    expect(applyRule(nodes, "#all li a")[0].kind).toBe("html"); // 多层组合
  });

  test("tocUrl 规则：|| 回退到 {{bookUrl}} 模板跳转", async () => {
    const src2 = {
      bookSourceUrl: base,
      ruleBookInfo: {
        tocUrl: "#allchapter a.-1@href||{{bookUrl}}##/book/(\\d+)##/chapter/$1.html",
      },
      ruleToc: { chapterList: ".chapterlist li", chapterName: "a@text", chapterUrl: "a@href" },
    };
    const info = await getBookInfo(src2, `${base}/book/2`);
    expect(info.tocUrl).toBe(`${base}/chapter/2.html`);
    const toc = await getToc(src2, info.tocUrl);
    expect(toc.length).toBe(2);
    expect(toc[0].title).toBe("第一章");
  });

  test("占位判定：短内容 + 关键词", () => {
    expect(isPlaceholder("更新中")).toBe(true);
    expect(isPlaceholder("a".repeat(100))).toBe(false);
    expect(isPlaceholder("真内容不多但超过了五十字的阈值，然后出现稍后更新字样")).toBe(true);
  });

  test("裸单词段：HTML 标签名按标签选择，其余按属性取", () => {
    const nodes = htmlNodes(`<div><a href="/x">链接文字</a><span data-src="abc">x</span></div>`);
    expect(nodeText(applyRule(nodes, "a@text")[0])).toBe("链接文字"); // a ≡ tag.a
    expect(applyRule(nodes, "span@data-src")[0]).toMatchObject({ kind: "json", v: "abc" }); // data-src 是属性
    expect(applyRule(nodes, "a@href")[0]).toMatchObject({ kind: "json" }); // href 走取值器
  });
});
