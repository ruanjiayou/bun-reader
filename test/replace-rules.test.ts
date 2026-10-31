import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { applyReplaceRules, compileRuleRegex, parseReplaceRules } from "../src/source/regex";
import { htmlNodes, ruleStr } from "../src/source/rule";
import { normalizeSource } from "../src/source/rule";
import { rulesToScript } from "../src/source/convert";
import { getContent } from "../src/source/engine";
import { saveScriptFile, scriptContent } from "../src/source/script";
import { rmSync } from "node:fs";

describe("替换净化：规则格式解析", () => {
  test("##正则## = 删除命中的内容（前端提示教的写法）", () => {
    expect(parseReplaceRules("##广告.*?##")).toEqual([{ regex: "广告.*?", replacement: "" }]);
  });

  test("正则##替换为", () => {
    expect(parseReplaceRules("第(\\d+)章##第$1节")).toEqual([{ regex: "第(\\d+)章", replacement: "第$1节" }]);
  });

  test("##正则##替换为", () => {
    expect(parseReplaceRules("##广告.*?##（广告已屏蔽）")).toEqual([{ regex: "广告.*?", replacement: "（广告已屏蔽）" }]);
  });

  test("没有 ## 的整行按正则处理，命中即删除", () => {
    expect(parseReplaceRules("广告链接：.*")).toEqual([{ regex: "广告链接：.*", replacement: "" }]);
  });

  test("多行 = 多条规则，空行与首尾空白忽略", () => {
    const got = parseReplaceRules("  a##  \n\nb##x\n c ");
    expect(got).toEqual([
      { regex: "a", replacement: "" },
      { regex: "b", replacement: "x" },
      { regex: "c", replacement: "" },
    ]);
  });

  test("数组原样透传（脚本源的 replace 成员）", () => {
    expect(parseReplaceRules([{ regex: "x", replacement: "y" }])).toEqual([{ regex: "x", replacement: "y" }]);
  });

  test("空输入不产生规则", () => {
    expect(parseReplaceRules("")).toEqual([]);
    expect(parseReplaceRules(null)).toEqual([]);
    expect(parseReplaceRules("##")).toEqual([]);
  });
});

describe("替换净化：大小写", () => {
  test("##www.*?com## 能删掉大小写混淆的广告串", () => {
    const body = "正文开始\nwww.qUAnbEn-xIaosHuo.CoM\n正文结束";
    expect(applyReplaceRules(body, "##www.*?com##")).toBe("正文开始\n\n正文结束");
  });

  test("范围里混写的网址也能删（www 全大写）", () => {
    expect(applyReplaceRules("WWW.Bad-Site.COM 广告", "##www.*?com##")).toBe(" 广告");
  });

  test("(?-i) 可关闭默认的不区分大小写", () => {
    const re = compileRuleRegex("(?-i)abc")!;
    expect(re.test("ABC")).toBe(false);
    expect("abc ABC".replace(compileRuleRegex("(?-i)abc")!, "")).toBe(" ABC");
  });

  test("(?i) 前缀被剥掉而不是抛 Invalid group（Java 源常用写法）", () => {
    const re = compileRuleRegex("(?i)qUAnbEn")!;
    expect(re).toBeInstanceOf(RegExp);
    expect(re.source).not.toContain("(?i)");
    expect("www.quanben-xiaoshuo.com".replace(re, "")).toBe("www.-xiaoshuo.com");
  });

  test("(?im) 组合标志映射到 m", () => {
    const re = compileRuleRegex("(?im)^ad##")!;
    expect(re.flags).toContain("i");
  });

  test("坏正则返回 null 而不是抛错", () => {
    expect(compileRuleRegex("([unclosed")).toBeNull();
  });
});

describe("字段规则的 ## 后处理", () => {
  test("规则源能用 ##正则## 删除前后缀", () => {
    const nodes = htmlNodes(`<p class="t">作者：忘语</p>`);
    expect(ruleStr(nodes, "p.t.text()##作者：")).toBe("忘语");
  });

  test("规则源的后处理也支持 (?i)", () => {
    const nodes = htmlNodes(`<p class="t">AD：某广告 正文</p>`);
    expect(ruleStr(nodes, "p.t.text()##(?i)^ad：")).toBe("某广告 正文");
  });

  test("规则源的替换默认不区分大小写", () => {
    const nodes = htmlNodes(`<h1 class="n">Test BOOK</h1>`);
    // 规则整条会先 trim，所以断言里不留尾随空格
    expect(ruleStr(nodes, "h1.n.text()##Test")).toBe(" BOOK");
  });
});

describe("规则源 → 脚本源：替换规则不丢", () => {
  test("多行替换规则全部转换（原来只取第一条）", () => {
    const rules = normalizeSource({
      bookSourceUrl: "https://x.test/",
      bookSourceName: "x",
      ruleContent: { content: "#c.text()", replaceRegex: "广告.*?##\nwww.*?com##" },
    });
    const code = rulesToScript(rules);
    expect(code).toContain('"广告.*?"');
    expect(code).toContain('"www.*?com"');
    const m = code.match(/replace = (\[[\s\S]*?\]);/);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1]).length).toBe(2);
  });

  test("##正则## 写法转成删除（替换为空）", () => {
    const rules = normalizeSource({
      bookSourceUrl: "https://x.test/",
      bookSourceName: "x",
      ruleContent: { content: "#c.text()", replaceRegex: "##www.*?com##" },
    });
    const code = rulesToScript(rules);
    const m = code.match(/replace = (\[[\s\S]*?\]);/);
    expect(JSON.parse(m![1])).toEqual([{ regex: "www.*?com", replacement: "" }]);
  });
});

// 端到端：正文里混着大小写混淆的广告网址（真实站点常见写法），规则源和脚本源都要删干净
describe("端到端：正文净化", () => {
  const ID = 94001;
  let server: ReturnType<typeof Bun.serve>;
  let base = "";

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          `<!doctype html><html><body><div id="content">山路很长。<br>www.qUAnbEn-xIaosHuo.CoM<br>他停下歇脚。<br>WWW.Bad-Site.COM</div></body></html>`,
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        ),
    });
    base = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
    try {
      rmSync(`data/sources/${ID}.js`, { force: true });
    } catch {
      /* 忽略 */
    }
  });

  const src = (replaceRegex: string) =>
    normalizeSource({
      bookSourceUrl: base,
      bookSourceName: "净化测试站",
      ruleContent: { content: "'#content'.textNodes()", replaceRegex },
    });

  test("规则源：##www.*?com## 把两处广告都删掉", async () => {
    const c = await getContent(src("##www.*?com##"), `${base}/c/1.html`);
    expect(c).not.toContain("qUAnbEn");
    expect(c).not.toContain("Bad-Site");
    expect(c).toContain("山路很长");
    expect(c).toContain("他停下歇脚");
  });

  test("规则源：多行规则各删一条", async () => {
    const c = await getContent(src("##www.qUAnbEn.*?##\n##WWW.Bad-Site.COM##"), `${base}/c/1.html`);
    expect(c).not.toContain("qUAnbEn");
    expect(c).not.toContain("Bad-Site");
    expect(c).toContain("他停下歇脚");
  });

  test("脚本源：转换器产出的 replace 成员同样生效", async () => {
    const rules = src("##www.*?com##");
    saveScriptFile(ID, rulesToScript(rules));
    const fromRules = await getContent(rules, `${base}/c/1.html`);
    const fromScript = await scriptContent({ id: ID }, `${base}/c/1.html`);
    expect(fromScript).toBe(fromRules);
    expect(fromScript).not.toContain("qUAnbEn");
    expect(fromScript).not.toContain("Bad-Site");
  });
});
