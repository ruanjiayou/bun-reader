// 一次性种子：把幽香书房（id=3）从规则源切换为脚本书源，目录走 Playwright 有头浏览器
import { Database } from "bun:sqlite";
import { saveScriptFile } from "../src/source/script";
import { formToCode } from "../src/source/script";

const db = new Database("data/book.db");
const old = JSON.parse(db.query("select json from sources where id=3").get()!.json as string);
const headers = old.header ?? {};

const form = {
  name: "幽香书房",
  base: "https://www.yxshufang.com",
  headers,
  replace: [],
  methods: {
    getDetail: `async getDetail(url) {
  const res = await fetchText(url);
  if (res.status >= 400) throw new Error("HTTP " + res.status);
  const ns = nodes(res.text);
  return {
    title: ruleText(ns, "'h1'.text()", res.url),
    author: ruleText(ns, "'.novel_info_title a'.text()", res.url),
    desc: ruleText(ns, "'.intro'.text()", res.url),
    cover: abs(ruleText(ns, "'.novel_info_main img'.attr('src')", res.url), res.url),
    tocUrl: url,
  };
}`,

    getChapters: `async getChapters(url) {
  // 目录翻页是加密 AJAX：Playwright 渲染，点「下一页」让页面自己跑加密逻辑；遇验证码弹窗手动过（cookie 存持久化 profile）
  const p = await browserOpen(url);
  const list = [];
  const seen = new Set();
  try {
    for (let i = 0; i < 300; i++) {
      const $ = parse(await p.html());
      const prevCount = $("#ul_all_chapters li a").length;
      let added = 0;
      $("#ul_all_chapters li a").each((_, el) => {
        const t = $(el).text().trim();
        const u = abs($(el).attr("href"), p.url());
        if (t && u && !seen.has(u)) { seen.add(u); list.push({ title: t, url: u }); added++; }
      });
      log(\`第 \${i + 1} 屏 +\${added} 章，累计 \${list.length}\`);
      if (!added) break;
      let clicked = false;
      try { await p.click(".page2"); clicked = true; } catch { try { await p.click("text=下一页"); clicked = true; } catch {} }
      if (!clicked) break; // 没有下一页按钮 = 翻完了
      await p.waitForLoad();
      if (!(await p.waitCount("#ul_all_chapters li a", prevCount, 20000))) break; // 列表没刷新 = 到底了
    }
  } finally {
    await p.close();
  }
  return { list };
}`,

    getContent: `async getContent(url) {
  const res = await fetchText(url);
  if (res.status >= 400) throw new Error("HTTP " + res.status);
  return ruleText(nodes(res.text), "'#article'.text()", res.url);
}`,
  },
};

const code = formToCode(form as any);
const err = await (await import("../src/source/script")).validateScriptCode(code);
if (err) throw new Error("生成代码校验失败：" + err);
db.query("UPDATE sources SET type='script', json=?, code=? WHERE id=3").run(JSON.stringify(form), code);
saveScriptFile(3, code);
console.log("id=3 已切换为 script 源，代码", code.length, "字");
