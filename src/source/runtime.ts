import { AsyncLocalStorage } from "node:async_hooks";
import * as cheerio from "cheerio";
import { httpText, type FetchOpts } from "./fetcher";
import { contentRule, ruleStr, ruleList, guessNodes, legadoToOurs, type Node } from "./rule";
import { log as fileLog } from "../log";

// 浏览器抓取（WAF/验证码/加密 AJAX 站点）：透传给脚本书源使用
import { browserCookieHeader, browserOpen, browserText, type BrowserPage } from "./browser";
export { browserCookieHeader, browserOpen, browserText, type BrowserPage };

// —— 脚本书源运行时 ——
// 注入到 data/sources/{id}.js 的唯一 API 面（scaffold 的 import 行从这里解析）。
// 源内可用：fetchText / parse / abs / log / ruleText / ruleSel
// 引擎在调用源方法前用 runWithInst 绑定实例上下文（base/headers），fetchText 自动带 Cookie。

const als = new AsyncLocalStorage<{ base?: string; headers?: Record<string, string>; dropTags?: string }>();

// 实例 headers 容错：字符串形态（规则源 header 带过来的旧数据）解析成对象，避免 spread 字符串变成字符索引
function instHeaders(h: unknown): Record<string, string> {
  if (typeof h === "string") {
    try {
      const p = JSON.parse(h);
      if (p && typeof p === "object" && !Array.isArray(p)) return p;
    } catch {
      /* 保留空对象 */
    }
    return {};
  }
  return h && typeof h === "object" && !Array.isArray(h) ? (h as Record<string, string>) : {};
}

export function runWithInst(inst: any, fn: () => Promise<any>): Promise<any> {
  return als.run({ base: inst?.base, headers: instHeaders(inst?.headers), dropTags: inst?.dropTags }, fn);
}

export async function fetchText(url: string, opts: Omit<FetchOpts, "headers"> & { headers?: Record<string, string> } = {}) {
  const ctx = als.getStore();
  const headers = { ...(ctx?.headers ?? {}), ...(opts.headers ?? {}) };
  // WAF 站点复用：浏览器（browserOpen/browserText）过完人机验证后 cookie 存在持久化 profile，
  // 这里把同域 cookie 合并进请求头（用户显式设置了 cookie 则不覆盖）；浏览器未启动时不拉起
  if (!headers.cookie && !headers.Cookie) {
    const ck = await browserCookieHeader(url);
    if (ck) headers.cookie = ck;
  }
  const res = await httpText(url, { ...opts, headers });
  return { status: res.status, text: res.text, url: res.url };
}

export const parse = (html: string) => cheerio.load(html);

// 规则求值用的节点包装（ruleText/ruleSel 入参；转换器生成的代码用）
export const nodes = (text: string): Node[] => guessNodes(text);

// 相对 URL → 绝对；base 缺省取实例的 base 成员。
// 绝对地址原样返回；含 {page} 模板的相对地址手动补 origin（new URL 会把 {} 编码成 %7B，模板展开就失效了）
export function abs(u: string, base?: string): string {
  if (!u) return u;
  if (/^(https?:)?\/\//i.test(u)) return u;
  const b = base ?? als.getStore()?.base ?? "";
  if (!b) return u;
  if (/\{\{?page\}?\}|%7[Bb]page%7[Dd]/.test(u)) {
    try {
      return new URL(b).origin + (u.startsWith("/") ? u : "/" + u);
    } catch {
      return u;
    }
  }
  try {
    return new URL(u, b).toString();
  } catch {
    return u;
  }
}

export function log(msg: string) {
  fileLog.info("script", msg);
}

// —— 规则兼容 helper：转换器生成的代码使用，复用规则引擎求值器（|| 回退 / ##正则## 原样可用）——
// 规则字符串统一先过 Legado 关键字转换（幂等，v2 语法原样返回）：与规则源的 normalizeSource 对齐，
// 也顺带修好旧版本生成/手写在脚本里的 "text.xxx.attr('href')"（老转换器不会转换 text.）
export function ruleText(nodes: Node[], rule: string, base?: string): string {
  return ruleStr(nodes, legadoToOurs(rule), base ?? als.getStore()?.base ?? "", { dropTags: als.getStore()?.dropTags });
}

export function ruleSel(nodes: Node[], rule: string, base?: string): Node[] {
  return ruleList(nodes, legadoToOurs(rule), base ?? als.getStore()?.base ?? "");
}

// 正文专用：规则只写选择器就够了，引擎补 .textBlocks()（结构清洗 + 按块分段）；
// 已经写了 .textBlocks()/.text() 等取值调用的规则原样生效，所以新旧写法可以混用。
export function ruleContent(nodes: Node[], rule: string, base?: string): string {
  return ruleStr(nodes, contentRule(legadoToOurs(rule)), base ?? als.getStore()?.base ?? "", { dropTags: als.getStore()?.dropTags });
}
