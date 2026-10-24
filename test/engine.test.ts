import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { searchSource, getBookInfo, getToc, getContent, isPlaceholder } from "../src/source/engine";

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

// source 在 beforeAll 之后才能拿到 base，用工厂函数
const source = () => ({
  bookSourceUrl: base,
  bookSourceName: "测试站",
  searchUrl: `${base}/search?keyword={{key}}`,
  ruleSearch: {
    bookList: "class.bookbox",
    name: "tag.h4@tag.a@text",
    author: "class.author@text",
    bookUrl: "tag.h4@tag.a@href",
    coverUrl: "tag.img@data-src",
    intro: "class.intro@text",
    lastChapter: "class.last@text",
  },
  ruleBookInfo: {
    name: "id.info@tag.h1@text",
    author: "id.info@tag.p@text##作者：",
    intro: "class.intro@text",
    tocUrl: "id.info@tag.a.0@href",
  },
  ruleToc: {
    chapterList: "class.chapterlist@tag.li",
    chapterName: "tag.a@text",
    chapterUrl: "tag.a@href",
  },
  ruleContent: {
    content: "id.content@textNodes",
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

  test("占位判定：短内容 + 关键词", () => {
    expect(isPlaceholder("更新中")).toBe(true);
    expect(isPlaceholder("a".repeat(100))).toBe(false);
    expect(isPlaceholder("真内容不多但超过了五十字的阈值，然后出现稍后更新字样")).toBe(true);
  });
});
