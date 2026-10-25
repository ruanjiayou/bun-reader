import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { searchSource, getBookInfo, getToc, getContent, isPlaceholder } from "../src/source/engine";
import { applyRule, htmlNodes, nodeText, legadoToOurs, normalizeSource } from "../src/source/rule";

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
        // 无目录链接的详情页，目录地址靠 {{bookUrl}} 模板推出；.last-link 是"最新章节"链接（URL+标题同一节点）
        return new Response(
          html(`<div id="info"><h1>斗破苍穹</h1><p>作者：天蚕土豆</p><a class="last-link" href="/book/2-2.html">第四章</a></div>`),
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

// source 在 beforeAll 之后才能拿到 base，用工厂函数；规则一律 v2 链式调用语法
const source = () => ({
  bookSourceUrl: base,
  bookSourceName: "测试站",
  searchUrl: `${base}/search?keyword={{key}}`,
  ruleSearch: {
    bookList: ".bookbox",
    name: "h4 a.text()",
    author: ".author.text()",
    bookUrl: "h4 a.attr('href')",
    coverUrl: "img.attr('data-src')",
    intro: ".intro.text()",
    lastChapter: ".last.text()",
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
  },
  ruleContent: {
    content: "#content.textNodes()",
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
    src.ruleToc.nextTocUrl = ".pager a.eq(-1).attr('href')";
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
    const bad = { bookSourceUrl: base, searchUrl: `${base}/search?keyword={{key}}`, ruleSearch: { bookList: ".bookbox", name: "h4.text()" } };
    const books = await searchSource(bad, "x");
    expect(books.length).toBe(0);
    const noBookList = { bookSourceUrl: base, searchUrl: `${base}/search?keyword={{key}}` };
    await expect(searchSource(noBookList, "x")).rejects.toThrow("缺少 ruleSearch.bookList");
  });

  test("tocUrl 规则：|| 回退到 {{bookUrl}} 模板跳转", async () => {
    const src2 = {
      bookSourceUrl: base,
      ruleBookInfo: {
        tocUrl: "#allchapter a.eq(-1).attr('href')||{{bookUrl}}##/book/(\\d+)##/chapter/$1.html",
      },
      ruleToc: { chapterList: ".chapterlist li", chapterName: "a.text()", chapterUrl: "a.attr('href')" },
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
      ruleToc: { chapterList: ".chapterlist li", chapterName: "a.text()", chapterUrl: "a.attr('href')" },
    };
    const info = await getBookInfo(src3, `${base}/book/2`);
    expect(info.tocUrl).toBe(`${base}/book/2-{page}.html`);
    const toc = await getToc(src3, info.tocUrl);
    // 3 页共 6 条但 c4 重复 → 5 章；第 4 页 404 → 模板模式返回已抓到的部分
    expect(toc.length).toBe(5);
    expect(toc.map((c) => c.title)).toEqual(["第一章", "第二章", "第三章", "第四章", "第五章"]);
    expect(toc[3].url).toBe(`${base}/book/2/c4`);
  });

  test("目录 {page} 模板 + 最新章节链接反推最大页码：精确抓 1..max 不盲试", async () => {
    const src3 = {
      bookSourceUrl: base,
      ruleBookInfo: { tocUrl: "{{bookUrl}}##$##-{page}.html", lastChapter: "'.last-link'.attr('href')" },
      ruleToc: { chapterList: ".chapterlist li", chapterName: "a.text()", chapterUrl: "a.attr('href')" },
    };
    const info = await getBookInfo(src3, `${base}/book/2`);
    // 规则取 URL：URL 供翻页推算，同节点换 .text() 拿到标题（入库展示用）
    expect(info.latestChapterUrl).toBe(`${base}/book/2-2.html`);
    expect(info.latestChapter).toBe("第四章");
    // 最新章节链接指向第 2 页 → 只抓 1..2 页（4 条去重后 4 章），不会去试第 3/4 页
    const toc = await getToc(src3, info.tocUrl, undefined, info.latestChapterUrl);
    expect(toc.length).toBe(4);
    expect(toc.map((c) => c.title)).toEqual(["第一章", "第二章", "第三章", "第四章"]);
    // 反向配置：规则取文本（.text()）→ 标题入库展示，换 .attr('href') 反推 URL 供翻页推算
    const src4 = { ...src3, ruleBookInfo: { tocUrl: "{{bookUrl}}##$##-{page}.html", lastChapter: "'.last-link'.text()" } };
    const info2 = await getBookInfo(src4, `${base}/book/2`);
    expect(info2.latestChapter).toBe("第四章");
    expect(info2.latestChapterUrl).toBe(`${base}/book/2-2.html`);
    // 传文本（推不出页码）→ 退回盲试展开（全量 5 章）
    const toc2 = await getToc(src3, info.tocUrl, undefined, "第四章");
    expect(toc2.length).toBe(5);
  });

  test("占位判定：短内容 + 关键词", () => {
    expect(isPlaceholder("更新中")).toBe(true);
    expect(isPlaceholder("a".repeat(100))).toBe(false);
    expect(isPlaceholder("真内容不多但超过了五十字的阈值，然后出现稍后更新字样")).toBe(true);
  });
});

describe("v2 链式调用语法求值", () => {
  test("选择器.text() ≡ $('sel').text()", () => {
    const nodes = htmlNodes(`<div><h1>书名</h1></div>`);
    expect(nodeText(applyRule(nodes, "h1.text()")[0])).toBe("书名");
    expect(nodeText(applyRule(nodes, "div.main h1.text()".replace(".main", ""))[0])).toBe("书名");
    expect(nodeText(applyRule(nodes, "#xx h1.text()".replace("#xx ", ""))[0])).toBe("书名");
  });

  test("无选择器 = 相对当前节点：.text()/.attr('href')/.find('a').attr('href')", () => {
    const nodes = htmlNodes(`<ul><li><a href="/c1" title="第1章">一</a></li></ul>`);
    // 真实章节列表形态：chapterList 直接选中 <a> 元素数组，每项相对求值
    const a = applyRule(nodes, "li a");
    expect(nodeText(applyRule(a, ".text()")[0])).toBe("一");
    expect(nodeText(applyRule(a, ".attr('href')")[0])).toBe("/c1");
    expect(nodeText(applyRule(a, ".attr('title')")[0])).toBe("第1章");
    // 列表项是容器时用 .find() 深入一层
    const li = applyRule(nodes, "li");
    expect(nodeText(applyRule(li, ".find('a').attr('href')")[0])).toBe("/c1");
    expect(nodeText(applyRule(li, ".find('a').attr('title')")[0])).toBe("第1章");
  });

  test("选择器 :eq(N) 原生透传，与链式 .eq(N) 同为全局索引（含负数）", () => {
    const nodes = htmlNodes(`<div><i>1</i><i>2</i><i>3</i></div>`);
    expect(nodeText(applyRule(nodes, "i:eq(2).text()")[0])).toBe("3");
    expect(nodeText(applyRule(nodes, "i.eq(2).text()")[0])).toBe("3");
    expect(nodeText(applyRule(nodes, "i.eq(-1).text()")[0])).toBe("3");
    expect(nodeText(applyRule(nodes, "i.first().text()")[0])).toBe("1");
    expect(nodeText(applyRule(nodes, "i.last().text()")[0])).toBe("3");
    const two = htmlNodes(
      `<div><div class="bb"><a>1</a><a>2</a><a>3</a></div><div class="bb"><a>4</a><a>5</a><a>6</a></div></div>`,
    );
    // 根节点一次 find 的全局上下文里，:eq(N) 与 .eq(N) 都是整个结果集的第 N 条
    expect(applyRule(two, ".bb a:eq(2)").map(nodeText).join(",")).toBe("3");
    expect(applyRule(two, ".bb a.eq(2)").map(nodeText).join(",")).toBe("3");
  });

  test("选择器可用引号包裹：'h1'.text() / '.bb a:eq(1)'.attr('href')", () => {
    const nodes = htmlNodes(`<div><h1>书名</h1></div>`);
    expect(nodeText(applyRule(nodes, "'h1'.text()")[0])).toBe("书名");
    expect(nodeText(applyRule(nodes, `"h1".text()`)[0])).toBe("书名");
    expect(nodeText(applyRule(nodes, "'div h1'.text()")[0])).toBe("书名");
    const two = htmlNodes(
      `<div><div class="bb"><a href="/1">1</a></div><div class="bb"><a href="/2">2</a></div></div>`,
    );
    expect(nodeText(applyRule(two, "'.bb a:eq(1)'.attr('href')")[0])).toBe("/2");
    // 引号选择器规则经 normalizeSource 幂等不变形
    expect(legadoToOurs("'h1'.text()")).toBe("'h1'.text()");
  });

  test("带数字类名 .item-2 是类名不是索引", () => {
    const nodes = htmlNodes(`<div><b class="item-2">甲</b></div>`);
    expect(nodeText(applyRule(nodes, ".item-2.text()")[0])).toBe("甲");
  });

  test("children/parent 导航 + attr 原样返回（不补绝对地址）", () => {
    const nodes = htmlNodes(`<div class="wrap"><p>A</p><p>B</p></div>`);
    expect(applyRule(nodes, "div.wrap.children()").length).toBe(2);
    expect(nodeText(applyRule(applyRule(nodes, "p"), ".parent().attr('class')")[0])).toBe("wrap");
    expect(nodeText(applyRule(htmlNodes(`<a href="/x">y</a>`), "a.attr('href')")[0])).toBe("/x"); // 不补域名
  });

  test("## 正则/变换段照常工作", () => {
    const nodes = htmlNodes(`<div><p>作者：忘语</p><a data-u="%E4%B8%AD%E6%96%87" data-b="!!!!">x</a></div>`);
    expect(nodeText(applyRule(nodes, "p.text()##作者：")[0])).toBe("忘语");
    expect(nodeText(applyRule(nodes, "a.attr('data-u')####urlDecode")[0])).toBe("中文");
    expect(nodeText(applyRule(nodes, "a.attr('data-b')####base64Decode")[0])).toBe("");
    // onclick base64 跳转参数解出真实 URL（幽香书房场景）
    const b64 = encodeURIComponent(Buffer.from("https://www.yxshufang.com/book/51RA9.html").toString("base64"));
    const n2 = htmlNodes(`<div><a onclick="window.open('?action=go&t=${b64}&s=S%2FIQ6m2aXMA%3D&e=1', '_blank')">书名</a></div>`);
    expect(nodeText(applyRule(n2, `a.attr('onclick')##.*?t=([^&]*).*##$1##urlDecode,base64Decode`)[0])).toBe(
      "https://www.yxshufang.com/book/51RA9.html",
    );
  });

  test("空规则返回空；JSON 字符串值经 nodeText 原样输出", () => {
    expect(applyRule(htmlNodes("<div>x</div>"), "")).toEqual([]);
  });

  test("textBlocks：段落级换行提取（嵌套 p 去重、br 转行、跳过裸文本）", () => {
    // 嵌套 <p><p>…</p></p>（htmlparser2 不自动闭合 p）：只取最内层，不重复
    const nested = applyRule(htmlNodes(`<div id="c"><p><p>第一段</p><p>第二段</p></p><p>第三段</p></div>`), "'#c'.textBlocks()");
    expect(nested.map(nodeText).join("\n")).toBe("第一段\n第二段\n第三段");
    // <br> 视为换行；容器 div 里的裸文本（广告行）不进结果
    const br = applyRule(htmlNodes(`<div id="c">广告文字<p>一行一<br>一行二</p><p>一行三</p></div>`), "'#c'.textBlocks()");
    expect(br.map(nodeText).join("\n")).toBe("一行一\n一行二\n一行三");
  });
});

describe("header 统一对象化（normalizeSource）", () => {
  test("legado 字符串 header 解析为对象；解析失败保留原样", () => {
    expect(normalizeSource({ header: '{"User-Agent":"Mozilla/5.0"}' }).header).toEqual({ "User-Agent": "Mozilla/5.0" });
    expect(normalizeSource({ header: { a: "b" } }).header).toEqual({ a: "b" });
    expect(normalizeSource({ header: "不是json" }).header).toBe("不是json");
  });

  test("devtools Copy as fetch 片段（平衡对象后跟垃圾）宽松截取", () => {
    const broken = '{\n  "accept": "text/html",\n  "cookie": "a=1"\n},\n  "referrer": "https://x.com/",\n  "method": "GET"}';
    expect(normalizeSource({ header: broken }).header).toEqual({ accept: "text/html", cookie: "a=1" });
  });
});

describe("旧语法 → v2 迁移转换（normalizeSource，幂等）", () => {
  test("Legado 关键字与 @ 分节 → 链式调用", () => {
    expect(legadoToOurs("class.bookbox")).toBe(".bookbox");
    expect(legadoToOurs("text")).toBe(".text()");
    expect(legadoToOurs("href")).toBe(".attr('href')");
    expect(legadoToOurs("a@text")).toBe("a.text()");
    expect(legadoToOurs("@text")).toBe(".text()");
    expect(legadoToOurs("a@href")).toBe("a.attr('href')");
    expect(legadoToOurs("id.info@tag.h1@text")).toBe("#info.find('h1').text()");
    expect(legadoToOurs("class.bookname@tag.a.0@href")).toBe(".bookname.find('a').eq(0).attr('href')");
    expect(legadoToOurs("id.allchapter@tag.a.-1@href")).toBe("#allchapter.find('a').eq(-1).attr('href')");
    expect(legadoToOurs("h4 a@text")).toBe("h4 a.text()");
    expect(legadoToOurs("a.0@text")).toBe("a.eq(0).text()");
    expect(legadoToOurs("attr(data-src)")).toBe(".attr('data-src')");
    expect(legadoToOurs("data-src")).toBe(".attr('data-src')");
    expect(legadoToOurs("children")).toBe(".children()");
    expect(legadoToOurs("tag(title).text()".replace(".text()", ""))).toBe("title");
  });

  test("|| 回退与 ## 段不参与转换、JsonPath/模板原样保留", () => {
    expect(legadoToOurs("id.x@tag.a@href||{{bookUrl}}##/a/(\\d+)##/b/$1.html")).toBe(
      "#x.find('a').attr('href')||{{bookUrl}}##/a/(\\d+)##/b/$1.html",
    );
    expect(legadoToOurs("a@onclick##.*?t=([^&]*).*##$1##urlDecode,base64Decode")).toBe(
      "a.attr('onclick')##.*?t=([^&]*).*##$1##urlDecode,base64Decode",
    );
    expect(legadoToOurs("$.data.books[*].name")).toBe("$.data.books[*].name");
    expect(legadoToOurs("{{bookUrl}}##\\.html$##-{page}.html")).toBe("{{bookUrl}}##\\.html$##-{page}.html");
  });

  test("幂等：转一次和转两次结果一致", () => {
    for (const r of ["a@text", "id.info@tag.h1@text", "class.pager@tag.a.-1@href", "text", "h4 a@text"]) {
      const once = legadoToOurs(r);
      expect(legadoToOurs(once)).toBe(once);
    }
  });

  test("旧语法源经 normalizeSource 后全链路可用（库内存量源兼容）", async () => {
    const legacy = normalizeSource({
      bookSourceUrl: base,
      bookSourceName: "旧语法站",
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
      ruleToc: { chapterList: "class.chapterlist@tag.li", chapterName: "tag.a@text", chapterUrl: "tag.a@href" },
      ruleContent: { content: "id.content@textNodes", replaceRegex: "广告链接：.*" },
    });
    const books = await searchSource(legacy, "凡人");
    expect(books.length).toBe(2);
    expect(books[0].name).toBe("凡人修仙传");
    expect(books[0].bookUrl).toBe(`${base}/book/1`);
    const toc = await getToc(legacy, `${base}/book/1/toc`);
    expect(toc.length).toBe(3);
    expect(toc[0].title).toBe("第1章 测试");
    const content = await getContent(legacy, `${base}/book/1/c1`);
    expect(content).toContain("第1段：山间小路");
  });

  test("转换后的 v2 规则可求值", () => {
    const nodes = htmlNodes(`<div class="box"><a href="/x">名字</a></div>`);
    expect(nodeText(applyRule(nodes, legadoToOurs("class.box@tag.a@text"))[0])).toBe("名字");
    expect(nodeText(applyRule(nodes, legadoToOurs("class.box@tag.a@href"))[0])).toBe("/x");
  });
});
