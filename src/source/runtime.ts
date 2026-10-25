import { AsyncLocalStorage } from "node:async_hooks";
import * as cheerio from "cheerio";
import { httpText, type FetchOpts } from "./fetcher";
import { ruleStr, ruleList, type Node } from "./rule";
import { log as fileLog } from "../log";

// —— 脚本书源运行时 ——
// 注入到 data/sources/{id}.js 的唯一 API 面（scaffold 的 import 行从这里解析）。
// 源内可用：fetchText / parse / abs / log / ruleText / ruleSel
// 引擎在调用源方法前用 runWithInst 绑定实例上下文（base/headers），fetchText 自动带 Cookie。

const als = new AsyncLocalStorage<{ base?: string; headers?: Record<string, string> }>();

export function runWithInst(inst: any, fn: () => Promise<any>): Promise<any> {
  return als.run({ base: inst?.base, headers: inst?.headers ?? {} }, fn);
}

export async function fetchText(url: string, opts: Omit<FetchOpts, "headers"> & { headers?: Record<string, string> } = {}) {
  const ctx = als.getStore();
  const res = await httpText(url, { ...opts, headers: { ...(ctx?.headers ?? {}), ...(opts.headers ?? {}) } });
  return { status: res.status, text: res.text, url: res.url };
}

export const parse = (html: string) => cheerio.load(html);

// 相对 URL → 绝对；base 缺省取实例的 base 成员
export function abs(u: string, base?: string): string {
  if (!u) return u;
  const b = base ?? als.getStore()?.base ?? "";
  try {
    return new URL(u, b || undefined).toString();
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
