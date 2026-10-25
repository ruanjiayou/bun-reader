// 一次性种子：把 69书吧（id=4）从规则源切换为脚本书源
// 全站 Cloudflare Turnstile + TLS 指纹校验：普通 fetch 恒 403（仅 cookie 不够），
// 搜索/详情/目录/正文全部走 Playwright 浏览器（Turnstile 自动通过，cookie 存持久化 profile）
import { Database } from "bun:sqlite";
import { formToCode, saveScriptFile, validateScriptCode } from "../src/source/script";

const db = new Database("data/book.db");
const old = JSON.parse(db.query("select json from sources where id=4").get()!.json as string);
const headers = typeof old.header === "string" ? JSON.parse(old.header) : (old.header ?? {});
delete headers.cookie; // WAF 拒绝普通 fetch，浏览器上下文自带 cookie，不需要硬编码

const form = {
  name: "69书吧",
  base: "https://69shuba.tw",
  headers,
  replace: [],
  methods: {
    search: `async search(name, page = 1) {
  // 搜索是 POST：browserOpen 过完 Turnstile 后用页内 fetch 发请求（自动带 cookie / 真实 TLS 指纹）
  const p = await browserOpen(this.base);
  try {
    const res = await p.fetch("/search/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "searchkey=" + encodeURIComponent(name) + "&searchtype=all&t_btnsearch=",
    });
    if (res.status >= 400) throw new Error("HTTP " + res.status);
    const ns = nodes(res.text);
    return ruleSel(ns, "'table.list-item'").map((el) => ({
      title: ruleText([el], "'.highlight:eq(0)'.text()"),
      author: ruleText([el], "'.mr15'.text()"),
      bookUrl: abs(ruleText([el], "'a:eq(0)'.attr('href')"), this.base),
      cover: abs(ruleText([el], "'img'.attr('src')"), this.base),
      desc: ruleText([el], "'.gray'.text()"),
      detailUrl: "",
    }))
      .map((b) => ({ ...b, detailUrl: b.bookUrl }))
      .filter((b) => b.title && b.detailUrl);
  } finally {
    await p.close();
  }
}`,

    getDetail: `async getDetail(url) {
  const res = await browserText(url);
  if (res.status >= 400) throw new Error("HTTP " + res.status);
  const ns = nodes(res.text);
  return {
    title: ruleText(ns, "'h1'.text()"),
    author: ruleText(ns, "'.info a:eq(0)'.text()"),
    desc: ruleText(ns, "'.intro'.text()"),
    cover: abs((ruleText(ns, "'.bookinfo img:eq(0)'.attr('src')").split(/\\s+/)[0] || ""), res.url),
    tocUrl: abs(ruleText(ns, "'.book-op a[href*=indexlist]'.attr('href')") || url, res.url),
  };
}`,

    getChapters: `async getChapters(url) {
  const res = await browserText(url);
  if (res.status >= 400) throw new Error("HTTP " + res.status);
  const ns = nodes(res.text);
  const list = ruleSel(ns, "'ul > li:not(:first-child)'").map((el) => ({
    title: ruleText([el], "'a'.text()"),
    url: abs(ruleText([el], "'a'.attr('href')"), res.url),
  })).filter((c) => c.title && c.url);
  // 每页 100 章，下一页 #index-next-top；引擎拿到 next 自动翻页
  const next = abs(ruleText(ns, "'#index-next-top'.attr('href')"), res.url);
  return { list, next: next || undefined };
}`,

    getContent: `async getContent(url) {
  const res = await browserText(url);
  if (res.status >= 400) throw new Error("HTTP " + res.status);
  const text = ruleText(nodes(res.text), "'#nr1'.textBlocks()");
  if (!text) throw new Error("正文规则未命中");
  return text;
}`,
  },
};

const code = formToCode(form as any);
const err = await validateScriptCode(code);
if (err) throw new Error("生成代码校验失败：" + err);
db.query("UPDATE sources SET type='script', json=?, code=? WHERE id=4").run(JSON.stringify(form), code);
saveScriptFile(4, code);
console.log("id=4 已切换为 script 源，代码", code.length, "字");
