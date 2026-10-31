import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { cleanChapter, normalizeText } from "../src/source/clean";
import { contentRule, htmlNodes, ruleStr, normalizeSource } from "../src/source/rule";
import { getContent } from "../src/source/engine";
import { formToCode, saveScriptFile, scriptContent } from "../src/source/script";
import { rulesToScript } from "../src/source/convert";
import { rmSync } from "node:fs";
import { db, sqlite } from "../src/db";
import { books, chapters, sources } from "../src/schema";
import { bookRoutes } from "../src/routes/books";

// 背景：正文净化不是「一串正则」，是固定顺序的几段（整行 → 行内 → 词典 → 规范化 → 质检）。
// 这些用例锁住顺序与每段的语义，顺序被改坏时应当立刻红。

describe("结构清洗：标签与隐藏节点", () => {
  const html = `<div id="c">
    <p>第一段。</p>
    <script>var ad="广告源码";</script>
    <a href="/n.html">最新章节</a>
    <div style="display:none">隐藏广告</div>
    <p>第二段<a href="/x">内联链接</a>结束。</p>
  </div>`;

  test(".text() 不再把 script 源码拼进正文", () => {
    const t = ruleStr(htmlNodes(html), "'#c'.text()");
    expect(t).not.toContain("广告源码");
    expect(t).not.toContain("var ad");
    expect(t).toContain("第一段");
  });

  test(".textBlocks() 删掉 display:none 里的隐藏广告", () => {
    const t = ruleStr(htmlNodes(html), "'#c'.textBlocks()");
    expect(t).not.toContain("隐藏广告");
    expect(t).toContain("第二段");
  });

  test(".textBlocks() 删掉「只有链接 + 短文本」的推广块", () => {
    const t = ruleStr(htmlNodes(html), "'#c'.textBlocks()");
    expect(t).not.toContain("最新章节");
    expect(t).not.toContain("<a");
  });

  test("<a> 解包：文字保留、标签不残留", () => {
    const t = ruleStr(htmlNodes(html), "'#c'.textBlocks()");
    expect(t).toContain("第二段内联链接结束");
  });

  test("含链接但像句子的块不删（避免误伤正文里的正常链接）", () => {
    const doc = `<div id="c"><p>他点开<a href="/x">那本书</a>，读了一整夜，直到天亮。</p></div>`;
    expect(ruleStr(htmlNodes(doc), "'#c'.textBlocks()")).toContain("读了一整夜");
  });

  test("stripTags=false 时不做容器清洗（正文就藏在隐藏节点里的站点）", () => {
    const doc = `<div id="c"><div style="display:none">正文在这里</div></div>`;
    expect(ruleStr(htmlNodes(doc), "'#c'.textBlocks()", "", { sanitize: false })).toContain("正文在这里");
    expect(ruleStr(htmlNodes(doc), "'#c'.textBlocks()")).not.toContain("正文在这里");
  });

  test("独占一块的短链接整块删掉（广告词不再留在正文里）", () => {
    const doc = `<div id="c"><p>正文一句。</p><p><a href="http://ad.com">www.ad.com</a></p></div>`;
    const t = ruleStr(htmlNodes(doc), "'#c'.textBlocks()");
    expect(t).toBe("正文一句。");
  });
});

// 正文规则只写选择器是「推荐写法」不是「可选写法」：忘了写 .textBlocks() 会静默退化成
// .text() 的一行文本，整章没有段落，很难看出是规则漏了尾巴。所以引擎统一补。
describe("正文规则默认取值：只写选择器 ≡ .textBlocks()", () => {
  test("选择器自动补 .textBlocks()", () => {
    expect(contentRule("'#content'")).toBe("'#content'.textBlocks()");
    expect(contentRule(".articlebody")).toBe(".articlebody.textBlocks()");
    expect(contentRule(".book-content #nr1")).toBe(".book-content #nr1.textBlocks()");
  });

  test("显式写了取值调用的不动（存量源零改动）", () => {
    expect(contentRule("'#c'.text()")).toBe("'#c'.text()");
    expect(contentRule("'#c'.textBlocks()")).toBe("'#c'.textBlocks()");
    expect(contentRule("'#c'.textNodes()")).toBe("'#c'.textNodes()");
  });

  test("导航调用之后照样补（选到子节点再分段）", () => {
    expect(contentRule("'#c'.children().eq(1)")).toBe("'#c'.children().eq(1).textBlocks()");
    expect(contentRule("'#c'.find('p')")).toBe("'#c'.find('p').textBlocks()");
  });

  test("## 后处理、|| 回退、首尾空格都不破坏", () => {
    expect(contentRule("'#c'##广告##")).toBe("'#c'.textBlocks()##广告##");
    expect(contentRule("'#a'||'#b'")).toBe("'#a'.textBlocks()||'#b'.textBlocks()");
    expect(contentRule("  '#c'  ")).toBe("'#c'.textBlocks()");
  });

  test("JsonPath / URL 模板不是 DOM 选择，不补", () => {
    expect(contentRule("$.data.content")).toBe("$.data.content");
    expect(contentRule("{{baseUrl}}##\\d+$##_1.html")).toBe("{{baseUrl}}##\\d+$##_1.html");
  });

  test("空规则还是空（缺失字段要报「未配置」，不能凭空选正文）", () => {
    expect(contentRule("")).toBe("");
    expect(contentRule("   ")).toBe("   ");
  });
});

describe("规则语法：line / line! / re / 旧写法", () => {
  test("line: 整行删除，且不留空行", () => {
    const raw = "第一段\n请记住本站：www.a.com\n第二段";
    expect(cleanChapter(raw, "line:请记住本站").text).toBe("第一段\n第二段");
  });

  test("line! 是字面量，正则元字符不生效", () => {
    const raw = "第一段\n1+1=2 的证明\n第二段";
    expect(cleanChapter(raw, "line!:1+1=2").text).toBe("第一段\n第二段");
    // 同一个字符串当正则写就是另一回事（+ 被当量词），这里只断言字面量版可用
    expect(cleanChapter("第一段\n1+1=2", "line!:1+1=2").text).toBe("第一段");
  });

  test("line: 支持正则（| 或字符类）", () => {
    const raw = "正文\n最新网址 abc\n微信搜索 xyz\n正文2";
    expect(cleanChapter(raw, "line:最新网址|微信搜索").text).toBe("正文\n正文2");
  });

  test("re: 前缀等价于旧写法", () => {
    const raw = "正文 www.Bad.COM 结束";
    expect(cleanChapter(raw, "re:##www.*?com##").text).toBe("正文 结束");
    expect(cleanChapter(raw, "##www.*?com##").text).toBe("正文 结束");
  });

  test("// 注释行被忽略", () => {
    expect(cleanChapter("正文\n广告行", "// 这条删广告\nline:广告行").text).toBe("正文");
  });

  test("坏正则被跳过，并在 warnings 里点名", () => {
    const r = cleanChapter("正文\n广告", "line:([unclosed");
    expect(r.text).toContain("正文");
    expect(r.warnings.join()).toContain("正则非法");
  });
});

describe("顺序：整行必须早于行内", () => {
  test("行内先删会毁掉整行特征，所以 line 先跑", () => {
    const raw = "第一段\n【广告】本站域名 www.x.com\n第二段";
    // re 先把「【广告】」删掉之后，line:广告 就再也匹配不到这一行了
    const r = cleanChapter(raw, "re:【广告】##\nline:广告");
    expect(r.text).toBe("第一段\n第二段");
  });
});

describe("词典替换（人工维护，不自动猜）", () => {
  test("map: 词 → 替换", () => {
    expect(cleanChapter("他de心很乱", "map:de=的").text).toBe("他的心很乱");
  });

  test("长词优先：不会先命中短词", () => {
    const r = cleanChapter("他很不高兴地走了", "map:不高兴=开心\nmap:高兴=快乐");
    expect(r.text).toBe("他很开心地走了");
  });

  test("一次扫描：A→B 之后不会继续被 B→C 命中", () => {
    expect(cleanChapter("A", "map:A=B\nmap:B=C").text).toBe("B");
  });

  test("map? 低频保护：全章不足 2 次不换（正常用词低频，站点污染必然高频）", () => {
    expect(cleanChapter("愉快的一天", "map?:愉快=悲伤").text).toBe("愉快的一天");
    expect(cleanChapter("愉快，愉快得很", "map?:愉快=悲伤").text).toBe("悲伤，悲伤得很");
  });

  test("词里带正则元字符也安全", () => {
    expect(cleanChapter("他用C++写的", "map:C++=C加加").text).toBe("他用C加加写的");
  });

  test("词表用对象形式（脚本源 replaceMap）", () => {
    expect(cleanChapter("他de书", "", { de: "的" }).text).toBe("他的书");
  });
});

describe("规范化与质检", () => {
  test("零宽字符、字面量 \\n、连续空行都被收干净", () => {
    expect(normalizeText("第一段\\n\\n\\n第二\u200b段")).toBe("第一段\n\n第二段");
  });

  test("删过头要告警，而不是静默返回残段", () => {
    const raw = ["第一段。", ...Array(100).fill("他走了很久。")].join("\n");
    const r = cleanChapter(raw, "line:他走了很久");
    expect(r.warnings.join()).toContain("删过头");
  });

  test("拼音化正文（中文占比过低）要告警", () => {
    const raw = `ta men zou le hen jiu ${"de shi jian ".repeat(40)}`;
    const r = cleanChapter(raw, "");
    expect(r.warnings.join()).toContain("拼音化");
  });

  test("script 没清干净（残留 JS）要告警", () => {
    const r = cleanChapter("正文 var ad = 1; 结束", "");
    expect(r.warnings.join()).toContain("JS");
  });

  test("汉字夹拼音要点名「用 map: 人工维护词表」", () => {
    const raw = "他de心很luan，想bu明白这件事。".repeat(6);
    const r = cleanChapter(raw, "");
    expect(r.warnings.join()).toContain("map:");
  });
});

describe("命中统计：规则配了没生效要能看见", () => {
  test("每条规则都带命中次数，0 命中的也在（便于发现写错的规则）", () => {
    const r = cleanChapter("正文\n广告行\n广告2", "line:广告\nline:不存在的词");
    const hit = Object.fromEntries(r.hits.map((h) => [h.rule, h.count]));
    expect(hit["line:广告"]).toBe(2);
    expect(hit["line:不存在的词"]).toBe(0);
  });
});

describe("端到端：跨页广告只有整章合并后才删得掉", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base = "";

  beforeAll(() => {
    // 第 1 页尾是「本章未完，点击下一页」，第 2 页头是「接上页」——分页边界上的广告
    const pages: Record<string, string> = {
      "/c/1.html": `<div id="content"><p>第一页正文。</p><p>本章未完，请点击下一页继续阅读全文
        <a href="/c/2.html">下一页</a></p></div>`,
      "/c/2.html": `<div id="content"><p>接上页。</p><p>第二页正文。</p></div>`,
    };
    server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        const body = pages[path];
        return body
          ? new Response(`<!doctype html><html><body>${body}</body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } })
          : new Response("not found", { status: 404 });
      },
    });
    base = `http://localhost:${server.port}`;
  });

  afterAll(() => server.stop(true));

  const src = (ruleContent: Record<string, unknown>) =>
    normalizeSource({
      bookSourceUrl: base,
      bookSourceName: "跨页净化测试站",
      ruleContent: { content: "'#content'.textBlocks()", ...ruleContent },
    });

  test("line: 规则跨页生效（每页各净化一次的旧行为删不掉）", async () => {
    const c = await getContent(
      src({ nextContentUrl: "'a'.attr('href')", replaceRegex: "line:本章未完\nline:接上页" }),
      `${base}/c/1.html`,
    );
    expect(c).toContain("第一页正文");
    expect(c).toContain("第二页正文");
    expect(c).not.toContain("本章未完");
    expect(c).not.toContain("接上页");
  });

  test("规则源的 replaceMap（词表）生效", async () => {
    const c = await getContent(src({ replaceMap: { 第一页: "第一章" } }), `${base}/c/1.html`);
    expect(c).toContain("第一章正文");
  });
});

describe("脚本源：replaceMap 成员与转换器", () => {
  const ID = 94101;
  let server: ReturnType<typeof Bun.serve>;
  let base = "";

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: () => new Response(`<div id="c"><p>他de心很乱。</p></div>`, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    });
    base = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
    rmSync(`data/sources/${ID}.js`, { force: true });
  });

  test("formToCode 生成 replaceMap 成员", () => {
    const code = formToCode({ replaceMap: { de: "的" } });
    expect(code).toContain('replaceMap = {"de":"的"}');
  });

  test("脚本源 replaceMap 生效（与规则源同一条管线）", async () => {
    saveScriptFile(
      ID,
      `export default class Source {\n  replaceMap = { de: "的" };\n  async getContent(url) {\n    const res = await fetchText(url);\n    const $ = parse(res.text);\n    return $("#c").text();\n  }\n}\n`,
    );
    const text = await scriptContent({ id: ID }, `${base}/c.html`);
    expect(text).toContain("他的心很乱");
  });

  test("转换器：带 line:/map: 的规则不被塞进 {regex} 数组（那样会当字面量正则）", () => {
    const rules = normalizeSource({
      bookSourceUrl: "https://x.test/",
      bookSourceName: "x",
      ruleContent: { content: "#c.text()", replaceRegex: "line:本章未完\nmap:de=的" },
    });
    const code = rulesToScript(rules);
    expect(code).toContain("replace = ");
    expect(code).not.toContain('"regex"'); // 新语法走字符串原文，不拆成 {regex, replacement}
  });
});

// 缓存层存「原文」、读的时候才净化：改规则后历史章节立即生效，不用整本重抓。
// 这是「规则明明改了却没反应」的根因，必须有测试盯着。
describe("缓存回炉：改规则后已缓存章节立即生效", () => {
  const tag = `test://clean-cache-${Date.now()}`;
  const key = createHash("sha1").update(`${tag}/book`).digest("hex");
  let server: ReturnType<typeof Bun.serve>;
  let base = "";
  let uid = 0;
  let srcId = 0;
  let bookId = 0;

  const app = () => {
    const a = new Hono();
    a.use("*", async (c, next) => {
      (c as any).set("uid", uid);
      await next();
    });
    a.route("/books", bookRoutes);
    return a;
  };

  const sourceJson = (replaceRegex: string) =>
    JSON.stringify({
      bookSourceUrl: base,
      bookSourceName: "净化缓存测试站",
      ruleContent: { content: "'#content'.textBlocks()", replaceRegex },
    });

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          `<!doctype html><html><body><div id="content"><p>正文第一段。</p><p>广告行：本站域名 www.ad.com</p><p>正文第二段。</p></div></body></html>`,
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        ),
    });
    base = `http://localhost:${server.port}`;
    uid = (sqlite.query("SELECT id FROM users ORDER BY id LIMIT 1").get() as { id: number }).id;

    const [s] = await db
      .insert(sources)
      .values({ name: "净化缓存测试源", bookUrl: tag, group: "测试", json: sourceJson(""), type: "rules" })
      .returning({ id: sources.id });
    srcId = s.id;
    const [b] = await db
      .insert(books)
      .values({ bookUrl: `${tag}/book`, sourceId: srcId, name: "净化缓存测试书" })
      .returning({ id: books.id });
    bookId = b.id;
    await db.insert(chapters).values({ bookId, idx: 0, title: "第一章", url: `${base}/c/1.html` });
  });

  afterAll(async () => {
    server.stop(true);
    sqlite.query("DELETE FROM chapter_cache WHERE content_key = ?").run(key);
    await db.delete(chapters).where(eq(chapters.bookId, bookId));
    await db.delete(books).where(eq(books.id, bookId));
    await db.delete(sources).where(eq(sources.id, srcId));
    rmSync(`data/cache/${key}`, { recursive: true, force: true });
  });

  test("第一次抓取落盘原文；改规则后再读（命缓存）就已是新结果", async () => {
    const first = await (await app().request(`/books/${bookId}/content/0`)).json<any>();
    expect(first.cached).toBe(false);
    expect(first.content).toContain("广告行");

    // 只改书源规则，不重新抓取
    await db.update(sources).set({ json: sourceJson("line:广告行") }).where(eq(sources.id, srcId));

    const second = await (await app().request(`/books/${bookId}/content/0`)).json<any>();
    expect(second.cached).toBe(true);
    expect(second.content).toContain("正文第一段");
    expect(second.content).not.toContain("广告行");
  });
});

// 端到端：源里只写 '#content' 时，引擎要完成「选节点 → 删 script/a/隐藏节点 → 按块分段」。
// 这条锁住的是「规则别逼用户记 .textBlocks()」这个决定本身。
describe("端到端：正文规则只写选择器", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base = "";

  beforeAll(() => {
    const body = `<div id="content" class="readcontent">
      <p>第一段正文。</p>
      <script>var ad="广告源码";</script>
      <a href="/next.html">下一章</a>
      <div style="display:none">隐藏广告</div>
      <p>第二段<a href="http://ad.example.com">点这里</a>结束。</p>
      <p>第三段正文。</p>
    </div>`;
    server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(`<!doctype html><html><body>${body}</body></html>`, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
    });
    base = `http://localhost:${server.port}`;
  });

  afterAll(() => server.stop(true));

  const src = (content: string) =>
    normalizeSource({ bookSourceUrl: base, bookSourceName: "选择器正文测试站", ruleContent: { content } });

  test("只写选择器：分段正常，script / 隐藏节点 / 独立链接都被清掉", async () => {
    const c = await getContent(src("'#content'"), `${base}/c/1.html`);
    expect(c.split("\n")).toEqual(["第一段正文。", "第二段点这里结束。", "第三段正文。"]);
    expect(c).not.toContain("广告源码");
    expect(c).not.toContain("隐藏广告");
    expect(c).not.toContain("下一章");
  });

  test("显式 .text() 仍是旧行为：不分段、不做容器清洗（存量源不为新默认背锅）", async () => {
    const c = await getContent(src("'#content'.text()"), `${base}/c/1.html`);
    // 广告链接/隐藏节点/下一章全都还在，段落之间也没有「一块一行」的分隔
    expect(c).toContain("隐藏广告");
    expect(c.replace(/\s+/g, " ")).toContain("第一段正文。 下一章 隐藏广告 第二段点这里结束。 第三段正文。");
  });
});

// 额外删标签：span 这类行内元素默认必须保留（删了整段字都没了），只有源上明确写 dropTags 才删。
// 这是「某些站用 span 包广告 / 包水印」的唯一出口，属于源级开关，不进正文规则语法。
describe("dropTags：源级额外删标签", () => {
  const doc = `<div id="c">
    <p>正文第一段。</p>
    <p><span class="ad">广告水印：www.ad.com</span></p>
    <p>正文<span>第二</span>段，中间有 span 包裹。</p>
    <p><font color="red">字体标签里的字</font></p>
  </div>`;

  // 正文链路等价写法：contentRule 把纯选择器补成 .textBlocks()（engine 里就是这么调的）
  const body = (extra: { dropTags?: string; sanitize?: boolean } = {}) =>
    ruleStr(htmlNodes(doc), contentRule("'#c'"), "", extra);

  test("默认不动 span：行内标签里的字必须保留", () => {
    const t = body();
    expect(t).toContain("正文第二段");
    expect(t).toContain("正文第一段");
    expect(t).toContain("广告水印"); // 默认不删 span，广告只能靠规则去掉
  });

  test("dropTags=span：span 连同内容一起删", () => {
    const t = body({ dropTags: "span" });
    expect(t).not.toContain("广告水印");
    expect(t).toContain("正文第一段");
    // 注意语义：删标签 = 连内容一起删，正文里的「第二」也没了（要留字就别删这个标签）
    expect(t).toBe("正文第一段。\n正文段，中间有 span 包裹。\n字体标签里的字");
  });

  test("多个标签用逗号/空格分开都认", () => {
    const t = body({ dropTags: "span, font" });
    expect(t).not.toContain("字体标签里的字");
    expect(t).not.toContain("广告水印");
  });

  test("非法标签名忽略，不会把选择器拼坏导致整个清洗失效", () => {
    const t = body({ dropTags: "</div>,#c,p:first" });
    expect(t).toContain("正文第一段");
    expect(t).toContain("广告水印"); // 都没有合法标签可删
  });

  test("只作用于正文取值：标题/简介等字段照常取到 span 里的字", () => {
    const nodes = htmlNodes(`<div id="t">第<span>1</span>章 起点</div>`);
    expect(ruleStr(nodes, contentRule("'#t'"), "", { dropTags: "span" })).toBe("第章 起点");
    // 标题用 .text() 取（不进 textBlocks 的清洗路径），字完整
    expect(ruleStr(htmlNodes(`<div id="t">第<span>1</span>章 起点</div>`), "'#t'.text()", "", { dropTags: "span" })).toBe("第1章 起点");
  });

  test("stripTags=false 时 dropTags 也不生效（总开关优先）", () => {
    const t = body({ sanitize: false, dropTags: "span" });
    expect(t).toContain("广告水印");
  });
});

// engine 接线：源上写 ruleContent.dropTags，正文链路要真的删掉（单元测试只覆盖 rule.ts 的参数，
// 这里保证 engine 把 dropTags 传下去了；字段名写错这类问题只有端到端能抓）
describe("端到端：源级 dropTags 生效", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base = "";

  beforeAll(() => {
    const body = `<div id="content">
      <p>正文第一段。</p>
      <p><span class="ad">广告：www.ad.com</span></p>
      <p>正文第二段。</p>
    </div>`;
    server = Bun.serve({
      port: 0,
      fetch: () => new Response(`<!doctype html><html><body>${body}</body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    });
    base = `http://localhost:${server.port}`;
  });

  afterAll(() => server.stop(true));

  const src = (dropTags?: string) =>
    normalizeSource({ bookSourceUrl: base, bookSourceName: "dropTags 测试站", ruleContent: { content: "'#content'", dropTags } });

  test("不配 dropTags：span 里的广告词会留在正文", async () => {
    const c = await getContent(src(), `${base}/c/1.html`);
    expect(c).toContain("广告：www.ad.com");
  });

  test("配 dropTags=span：广告随标签一起消失，正文完好", async () => {
    const c = await getContent(src("span"), `${base}/c/1.html`);
    expect(c.split("\n")).toEqual(["正文第一段。", "正文第二段。"]);
  });
});
