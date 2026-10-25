import { AsyncLocalStorage } from "node:async_hooks";
import * as cheerio from "cheerio";
import { httpText, type FetchOpts } from "./fetcher";
import { ruleStr, ruleList, guessNodes, type Node } from "./rule";
import { log as fileLog } from "../log";

// 浏览器抓取（WAF/验证码/加密 AJAX 站点）：透传给脚本书源使用
export { browserOpen, browserText, type BrowserPage } from "./browser";

// —— 脚本书源运行时 ——
// 注入到 data/sources/{id}.js 的唯一 API 面（scaffold 的 import 行从这里解析）。
// 源内可用：fetchText / parse / abs / log / ruleText / ruleSel
// 引擎在调用源方法前用 runWithInst 绑定实例上下文（base/headers），fetchText 自动带 Cookie。

const als = new AsyncLocalStorage<{ base?: string; headers?: Record<string, string> }>();

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
  return als.run({ base: inst?.base, headers: instHeaders(inst?.headers) }, fn);
}

export async function fetchText(url: string, opts: Omit<FetchOpts, "headers"> & { headers?: Record<string, string> } = {}) {
  const ctx = als.getStore();
  const res = await httpText(url, { ...opts, headers: { ...(ctx?.headers ?? {}), ...(opts.headers ?? {}) } });
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
export function ruleText(nodes: Node[], rule: string, base?: string): string {
  return ruleStr(nodes, rule, base ?? als.getStore()?.base ?? "");
}

export function ruleSel(nodes: Node[], rule: string, base?: string): Node[] {
  return ruleList(nodes, rule, base ?? als.getStore()?.base ?? "");
}
