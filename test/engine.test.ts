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
      // {page} 模板分页目录：2-3.html 故意重复 c4 以验证去重，2-4.html 不存在（404 → 模板模式部分返回）
      const pagedToc: Record<string, [string, string][]> = {
        "/book/2-1.html": [
          ["/book/2/c1", "第一章"],
          ["/book/2/c2", "第二章"],
        ],
        "/book/2-2.html": [
          ["/book/2/c3", "第三章"],
          ["/book/2/c4", "第四章"],
        ],
        "/book/2-3.html": [
          ["/book/2/c4", "第四章"],
          ["/book/2/c5", "第五章"],
        ],
      };
      if (pagedToc[u.pathname]) {
        const items = pagedToc[u.pathname].map(([h, t]) => `<li><a href="${h}">${t}</a></li>`).join("");
        return new Response(html(`<ul class="chapterlist">${items}</ul>`), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (u.pathname === "/chapter/2.html") {
        return new Response(html(`<ul class="chapterlist"><li><a href="/chapter/2_1.html">第一章</a></li><li><a href="/chapter/2_2.html">第二章</a></li></ul>`), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (u.pathname === "/book/1/toc") {
        // 分页 fixture：第 1 页 3 章 + 下一页链接
        const items = Array.from({ length: 3 }, (_, i) => `<li><a href="/book/1/c${i + 1}">第${i + 1}章 测试</a></li>`).join("");
        return new Response(html(`<ul class="chapterlist">${items}</ul><div class="pager"><a href="/book/1/toc2">下一页</a></div>`), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (u.pathname === "/book/1/toc2") {
        // 第 2 页 3 章，无下一页链接（href 为空 = 结束）
        const items = Array.from({ length: 3 }, (_, i) => `<li><a href="/book/1/c${i + 4}">第${i + 4}章 测试</a></li>`).join("");
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
    expect(toc.length).toBe(3); // 无 nextTocUrl 规则 → 只抓第一页
    expect(toc[0].title).toBe("第1章 测试");
    expect(toc[0].url).toBe(`${base}/book/1/c1`);
  });

  test("目录分页：nextTocUrl 翻页拼接，取到空链接即结束", async () => {
    const src = source();
    src.ruleToc.nextTocUrl = ".pager a.-1@href";
    const toc = await getToc(src, `${base}/book/1/toc`);
    expect(toc.length).toBe(6); // 两页各 3 章拼起来
    expect(toc[3].title).toBe("第4章 测试");
    expect(toc[5].url).toBe(`${base}/book/1/c6`);
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

  test("目录 {page} 模板翻页：按页码展开 + URL 去重 + 404 部分返回", async () => {
    const src3 = {
      bookSourceUrl: base,
      ruleBookInfo: {
        // 详情页无目录链接：用 {{bookUrl}} 改写成分页模板（模拟幽香书房 /book/51RA9-{page}.html 场景）
        tocUrl: "{{bookUrl}}##$##-{page}.html",
      },
      ruleToc: { chapterList: ".chapterlist li", chapterName: "a@text", chapterUrl: "a@href" },
    };
    const info = await getBookInfo(src3, `${base}/book/2`);
    expect(info.tocUrl).toBe(`${base}/book/2-{page}.html`);
    const toc = await getToc(src3, info.tocUrl);
    // 3 页共 6 条但 c4 重复 → 5 章；第 4 页 404 → 模板模式返回已抓到的部分
    expect(toc.length).toBe(5);
    expect(toc.map((c) => c.title)).toEqual(["第一章", "第二章", "第三章", "第四章", "第五章"]);
    expect(toc[3].url).toBe(`${base}/book/2/c4`);
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

  test("带数字类名不误拆为索引：.item-2 是类名，a.2 才是索引", () => {
    const nodes = htmlNodes(`<div><b class="item-2">甲</b><i>1</i><i>2</i><i>3</i></div>`);
    expect(nodeText(applyRule(nodes, ".item-2@text")[0])).toBe("甲");
    expect(nodeText(applyRule(nodes, "i.2@text")[0])).toBe("3"); // 索引语义不变
  });

  test("nextTocUrl 参与导入转换", () => {
    expect(legadoToOurs("class.pager@tag.a.0@href")).toBe(".pager@a.0@href");
    const out = legadoToOurs("tag.a.-1@href");
    expect(out).toBe("a.-1@href");
  });

  test("## 第三段变换：onclick base64 跳转参数解出真实 URL", () => {
    // 模拟幽香书房网关：window.open('?action=go&t=aHR0cHM6...%3D&s=..&e=..')
    const nodes = htmlNodes(
      `<div><a onclick="window.open('?action=go&t=${encodeURIComponent(Buffer.from("https://www.yxshufang.com/book/51RA9.html").toString("base64"))}&s=S%2FIQ6m2aXMA%3D&e=1792847961', '_blank')">书名</a></div>`,
    );
    const rule = `a@onclick##.*?t=([^&]*).*##$1##urlDecode,base64Decode`;
    expect(nodeText(applyRule(nodes, rule)[0])).toBe("https://www.yxshufang.com/book/51RA9.html");
  });

  test("## 第三段变换：无正则时 ####urlDecode 形式 + 非法输入返回空", () => {
    const nodes = htmlNodes(`<div><a data-u="%E4%B8%AD%E6%96%87" data-b="!!!!">x</a></div>`);
    expect(nodeText(applyRule(nodes, "a@data-u####urlDecode")[0])).toBe("中文");
    // 完全不含合法 base64 字符的输入过滤后为空串，由引擎的空值过滤兜底
    expect(nodeText(applyRule(nodes, "a@data-b####base64Decode")[0])).toBe("");
  });

  test("元素 vs 属性的三级分派与显式形式：attr(name)/tag(name)", () => {
    // 裸单词分派：取值器关键字 > 标签名 > 属性名兜底
    const nodes = htmlNodes(`<div><a href="/c1" title="第1章" data-url="/r/1">文本A</a><title>页面标题</title></div>`);
    const a = applyRule(nodes, "a");
    // 章节名称在 title 属性里 → attr(title) 显式取属性
    expect(nodeText(applyRule(a, "attr(title)")[0])).toBe("第1章");
    // 章节名称是文本节点 → text
    expect(nodeText(applyRule(a, "text")[0])).toBe("文本A");
    // 章节地址在自定义属性 → attr(data-url)
    expect(nodeText(applyRule(a, "attr(data-url)")[0])).toBe("/r/1");
    // 裸单词 title 命中取值器 → 等价 attr(title)
    expect(nodeText(applyRule(a, "title")[0])).toBe("第1章");
    // 裸单词 a 命中标签名 → 选元素（nodeText 取其文本）
    expect(nodeText(applyRule(nodes, "a")[0])).toBe("文本A");
    // 裸单词 data-url 不是标签 → 属性名兜底（作用于 <a> 元素）
    expect(nodeText(applyRule(a, "data-url")[0])).toBe("/r/1");
    // tag(title) 显式按标签选 <title> 元素（绕过取值器关键字冲突）
    expect(nodeText(applyRule(nodes, "div@tag(title)")[0])).toBe("页面标题");
  });
});
