import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { saveScriptFile, loadInst, scriptSearch, scriptBookInfo, scriptToc, scriptContent } from "../src/source/script";
import type { BookItem, ChapterItem } from "../src/source/engine";

// 本地 fixture 站点：验证 class 书源的全链路（headers 注入 / 翻页 / 正文合并 / replace / 超时 / 缓存失效）
let server: ReturnType<typeof Bun.serve>;
let base = "";
const TID = 99001; // 测试专用源 id，避免污染真实 data/sources
const TID2 = 99002;
const TID3 = 99003;

const html = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      // headers 注入验证：脚本源声明的 Cookie 没带上就 403
      if (u.pathname === "/search") {
        if (req.headers.get("cookie") !== "tok=good") return new Response("forbidden", { status: 403 });
        return new Response(
          html(`
          <div class="item"><a href="/book/1"></a><span class="t">凡人修仙传</span><span class="a">忘语</span><span class="d">修仙</span><img src="/img/1.jpg"></div>
          <div class="item"><a href="/book/2"></a><span class="t">斗破苍穹</span><span class="a">天蚕土豆</span><span class="d">斗气</span></div>`),
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      }
      if (u.pathname === "/book/1")
        return new Response(html(`<div id="t">凡人修仙传</div><div id="a">忘语</div><a id="toc" href="/toc/1">目录</a>`), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      if (u.pathname === "/toc/1")
        return new Response(
          html(`<ul><li><a href="/c/1">第一章</a></li><li><a href="/c/2">第二章</a></li></ul><a class="next" href="/toc/1_2">下一页</a>`),
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      if (u.pathname === "/toc/1_2")
        // next 指回 /toc/1 形成环 → 引擎的 visited 防护要兜住，不能死循环
        return new Response(
          html(`<ul><li><a href="/c/3">第三章</a></li><li><a href="/c/4">第四章</a></li></ul><a class="next" href="/toc/1">下一页</a>`),
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      if (u.pathname === "/c/1")
        return new Response(html(`<div id="c">第一页正文，广告链接：多余内容。</div><a class="n" href="/c/1_2">下一页</a>`), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      if (u.pathname === "/c/1_2") return new Response(html(`<div id="c">第二页正文。</div>`), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  for (const id of [TID, TID2, TID3]) {
    const f = `data/sources/${id}.js`;
    if (existsSync(f)) rmSync(f);
  }
});

// TID：全功能源；TID2：无 search；TID3：getContent 永不返回（测超时）
const sourceCode = () => `
export default class Source {
  base = "${base}";
  headers = { Cookie: "tok=good" };
  replace = [{ regex: "广告链接：.*", replacement: "" }];
  async search(name, page) {
    const res = await fetchText(\`\${this.base}/search?name=\${encodeURIComponent(name)}\`);
    if (res.status >= 400) throw new Error("搜索请求失败 " + res.status);
    const $ = parse(res.text);
    return $(".item").map((_, el) => ({
      title: $(el).find(".t").text().trim(),
      author: $(el).find(".a").text().trim(),
      desc: $(el).find(".d").text().trim(),
      cover: $(el).find("img").attr("src") || "",
      detailUrl: abs($(el).find("a").attr("href"), res.url),
    })).get();
  }
  async getDetail(url) {
    const res = await fetchText(url);
    const $ = parse(res.text);
    return { title: $("#t").text().trim(), author: $("#a").text().trim(), desc: "", cover: "", tocUrl: abs($("#toc").attr("href"), res.url) };
  }
  async getChapters(url) {
    const res = await fetchText(url);
    const $ = parse(res.text);
    const list = $("ul li a").map((_, el) => ({ title: $(el).text().trim(), url: abs($(el).attr("href"), res.url) })).get();
    const next = $(".next").attr("href") ? abs($(".next").attr("href"), res.url) : "";
    return { list, next: next || undefined };
  }
  async getContent(url) {
    const res = await fetchText(url);
    const $ = parse(res.text);
    const text = $("#c").text();
    const next = $(".n").attr("href") ? abs($(".n").attr("href"), res.url) : "";
    return next ? { text, next } : text;
  }
}`;

const noSearchCode = () => `
export default class Source {
  base = "${base}";
  async getChapters(url) { return { list: [] }; }
  async getContent(url) { return "x"; }
}`;

const hangCode = () => `
export default class Source {
  base = "${base}";
  async getContent(url) { await new Promise(() => {}); return "永不返回"; }
}`;

describe("书源脚本引擎", () => {
  test("saveScriptFile 落盘 + loadInst 加载（runtime 注入可用）", async () => {
    saveScriptFile(TID, sourceCode());
    expect(existsSync(`data/sources/${TID}.js`)).toBe(true);
    const inst = await loadInst(TID);
    expect(inst).toBeTruthy();
    expect(typeof inst.search).toBe("function");
    expect(inst.base).toBe(base);
    expect(inst.headers).toEqual({ Cookie: "tok=good" });
  });

  test("search：headers 注入 + abs 补全 + 字段归一", async () => {
    const books = await scriptSearch({ id: TID }, "凡人");
    expect(books.length).toBe(2);
    expect(books[0].name).toBe("凡人修仙传");
    expect(books[0].bookUrl).toBe(`${base}/book/1`);
    expect(books[0].cover).toBe(`${base}/img/1.jpg`);
    expect(books[1].intro).toBe("斗气");
  });

  test("getDetail：tocUrl 补全为绝对地址", async () => {
    const info = await scriptBookInfo({ id: TID }, `${base}/book/1`);
    expect(info.name).toBe("凡人修仙传");
    expect(info.tocUrl).toBe(`${base}/toc/1`);
  });

  test("getChapters：next 翻页由引擎循环 + visited 防环 + URL 去重", async () => {
    const toc = await scriptToc({ id: TID }, `${base}/toc/1`);
    expect(toc.map((c: ChapterItem) => c.title)).toEqual(["第一章", "第二章", "第三章", "第四章"]);
    expect(toc.every((c: ChapterItem) => c.url.startsWith(base))).toBe(true);
  });

  test("getContent：{text,next} 引擎拼接 + replace 成员净化", async () => {
    const text = await scriptContent({ id: TID }, `${base}/c/1`);
    expect(text).toContain("第一页正文");
    expect(text).toContain("第二页正文");
    expect(text).not.toContain("广告");
  });

  test("缺 search 方法：搜索降级为空列表，不报错", async () => {
    saveScriptFile(TID2, noSearchCode());
    const books = await scriptSearch({ id: TID2 }, "x");
    expect(books).toEqual([]);
  });

  test("getContent 卡死：超时报错而不是挂起进程", async () => {
    saveScriptFile(TID3, hangCode());
    await expect(scriptContent({ id: TID3 }, `${base}/c/1`, undefined, 100)).rejects.toThrow(/超时/);
  });

  test("同 id 重新保存：mtime 失效后加载到新代码", async () => {
    saveScriptFile(TID2, sourceCode()); // 覆盖无 search 的版本 → 变成全功能源
    await new Promise((r) => setTimeout(r, 20)); // 保证 mtime 变化
    const books = await scriptSearch({ id: TID2 }, "凡人");
    expect(books.length).toBe(2);
  });

  test("BookItem 类型兼容：search 产出可直接喂给书架快照流程", async () => {
    const books: BookItem[] = await scriptSearch({ id: TID }, "凡人");
    expect(Object.keys(books[0]).sort()).toEqual(["author", "bookUrl", "cover", "intro", "latestChapter", "name"]);
  });
});
