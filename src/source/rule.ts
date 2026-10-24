import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

// 规则求值上下文：html 节点（cheerio）或 json 值（API 类书源）
export type Node = { kind: "html"; $: CheerioAPI; el: AnyNode } | { kind: "json"; v: any };

export function htmlNodes(text: string): Node[] {
  const $ = cheerio.load(text);
  return [{ kind: "html", $, el: $.root().get(0)! }];
}

export function jsonNodes(v: any): Node[] {
  return [{ kind: "json", v }];
}

export function guessNodes(text: string): Node[] {
  const t = text.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return jsonNodes(JSON.parse(t));
    } catch {
      /* 按html处理 */
    }
  }
  return htmlNodes(text);
}

const isJsRule = (r: string) => r.includes("<js>") || r.startsWith("@js:") || r.startsWith("@JavaScript:");

const GETTERS = /^(text|textNodes|ownText|html|all|href|src|content|value|title|alt)$/;
const KEYWORD = /^(class|tag|id|text)\.([^@]+?)(?:\.(-?\d+))?$/;

function classSel(arg: string): string {
  return /^[A-Za-z0-9_-]+$/.test(arg) ? `.${arg}` : `[class~="${arg}"]`;
}

function ownText($: CheerioAPI, el: AnyNode): string {
  let t = "";
  $(el)
    .contents()
    .each((_, c) => {
      if (c.type === "text") t += c.data ?? "";
    });
  return t.trim();
}

function textNodes($: CheerioAPI, el: AnyNode): string {
  const parts: string[] = [];
  $(el)
    .contents()
    .each((_, c) => {
      if (c.type === "text" && (c.data ?? "").trim()) parts.push((c.data as string).trim());
    });
  return parts.join("\n");
}

function getter(g: string, $: CheerioAPI, el: AnyNode, base: string): string {
  switch (g) {
    case "text":
      return $(el).text().trim();
    case "ownText":
      return ownText($, el);
    case "textNodes":
      return textNodes($, el);
    case "html":
      return $(el).html() ?? "";
    case "all":
      return $.html(el);
    case "href":
    case "src": {
      const v = $(el).attr(g) ?? "";
      if (!v) return "";
      try {
        return new URL(v, base).toString();
      } catch {
        return v;
      }
    }
    default:
      return $(el).attr(g) ?? "";
  }
}

function safeFind($: CheerioAPI, el: AnyNode, sel: string): AnyNode[] {
  try {
    return $(el).find(sel).toArray();
  } catch {
    return [];
  }
}

// 单段求值：keyword 规则优先（class.content 的 content 是类名不是 getter）
function stepHtml(n: Extract<Node, { kind: "html" }>, raw: string, base: string, out: Node[]) {
  const { $, el } = n;
  const kw = raw.match(KEYWORD);
  if (kw) {
    const [, type, arg, nth] = kw;
    let found: AnyNode[];
    if (type === "class") found = safeFind($, el, classSel(arg));
    else if (type === "tag") found = safeFind($, el, arg);
    else if (type === "id") found = safeFind($, el, `[id="${arg}"]`);
    else found = $(el).find("*").toArray().filter((x) => $(x).text().includes(arg));
    if (nth !== undefined) {
      const k = parseInt(nth);
      found = [found[k >= 0 ? k : found.length + k]].filter(Boolean);
    }
    found.forEach((c) => out.push({ kind: "html", $, el: c }));
    return;
  }
  if (GETTERS.test(raw)) {
    out.push({ kind: "json", v: getter(raw, $, el, base) });
    return;
  }
  if (raw === "children") {
    $(el)
      .children()
      .toArray()
      .forEach((c) => out.push({ kind: "html", $, el: c }));
    return;
  }
  // 末段裸属性名（如 data-src）→ 取属性
  if (/^[a-zA-Z][\w-]*$/.test(raw)) {
    out.push({ kind: "json", v: $(el).attr(raw) ?? "" });
    return;
  }
  // 其余按 CSS 选择器处理（Legado 默认语法对未知段回退 jsoup select）
  safeFind($, el, raw).forEach((c) => out.push({ kind: "html", $, el: c }));
}

// JsonPath 子集：$.a.b[0].c / [*] / 纯数字索引
function applyJsonPath(nodes: Node[], rule: string): Node[] {
  let cur: any[] = nodes.filter((n) => n.kind === "json").map((n) => (n as any).v);
  const tokens = rule.slice(1).match(/[^.[\]]+|\[\*\]|\[\d+\]/g) ?? [];
  for (const t of tokens) {
    if (t === "[*]") cur = cur.flatMap((v) => (Array.isArray(v) ? v : [v]));
    else if (/^\d+$/.test(t)) cur = cur.map((v) => (Array.isArray(v) ? v[+t] : v)).filter((v) => v != null);
    else
      cur = cur.flatMap((v) => {
        if (v == null) return [];
        if (Array.isArray(v)) return v.map((x) => x?.[t]).filter((x) => x != null);
        return v[t] !== undefined ? [v[t]] : [];
      });
  }
  return cur.map((v) => ({ kind: "json", v }));
}

// 规则求值主入口：支持 ##regex##replace 后处理、|| 回退；JS 脚本规则不支持（返回空）
export function applyRule(input: Node[], rule: string, base = ""): Node[] {
  if (!rule || !rule.trim()) return input;
  if (isJsRule(rule)) return []; // ponytail: JS 脚本源 M2 不支持，二期沙箱补
  if (rule.includes("||")) {
    for (const part of rule.split("||")) {
      const r = applyRule(input, part.trim(), base);
      if (r.length) return r;
    }
    return [];
  }
  let main = rule.trim();
  let regex: RegExp | null = null;
  let rep = "";
  const hash = main.indexOf("##");
  if (hash > -1) {
    const parts = main.slice(hash + 2).split("##");
    main = main.slice(0, hash);
    try {
      regex = parts[0] ? new RegExp(parts[0], "g") : null;
    } catch {
      regex = null;
    }
    rep = parts[1] ?? "";
  }
  let cur: Node[] = input;
  if (main) {
    if (main.startsWith("$")) cur = applyJsonPath(cur, main);
    else {
      const segs = main.split("@");
      for (let i = 0; i < segs.length; i++) {
        const raw = segs[i].trim();
        if (!raw) continue;
        const next: Node[] = [];
        for (const n of cur) if (n.kind === "html") stepHtml(n, raw, base, next);
        cur = next;
        if (!cur.length) break;
      }
    }
  }
  if (regex) cur = cur.map((n) => ({ kind: "json", v: nodeText(n).replace(regex!, rep) }));
  return cur;
}

export function nodeText(n: Node): string {
  if (n.kind === "html") return n.$(n.el).text().trim();
  const v = n.v;
  return typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
}

// 取字符串：多结果按 Legado 习惯用 \n 连接
export function ruleStr(nodes: Node[], rule: string, base = ""): string {
  return applyRule(nodes, rule, base)
    .map(nodeText)
    .filter(Boolean)
    .join("\n");
}

// 取列表：保留元素节点（html 元素或 json 对象）
export function ruleList(nodes: Node[], rule: string, base = ""): Node[] {
  return applyRule(nodes, rule, base);
}
