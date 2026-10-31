// —— 正文净化管线 ——
//
// 为什么单独一个模块：净化不是「一串正则」，而是固定顺序的几段，顺序错了结果就错。
//   ① 整行删除  → ② 行内替换/删除 → ③ 词典还原 → ④ 规范化 → ⑤ 质检
// （DOM 段「删 script/隐藏节点/短链接块」在 rule.ts 的 textBlocks 里，因为那时标签还在）
//
// 顺序的三条硬约束：
//   · 整行必须早于行内：行内删掉「本章未完，」之后，整行的特征就没了，`line:` 再也匹配不上
//   · 词典必须晚于删除：否则广告里的拼音也会被还原，白白制造垃圾
//   · 规范化必须最后：前几步都会制造空行与多余空格
//
// 拼音 / 反义词不做自动猜测：那两个问题是信息丢失，`de` 可能是的/得/地/德，
// 「高兴↔难过」无法判定原文。引擎只提供 map: 显式映射（由人维护词表）+ 检测告警。

import { compileRuleRegex, parseReplaceRules } from "./regex";

export type CleanRuleKind = "line" | "re" | "map";

export interface CleanHit {
  kind: CleanRuleKind;
  rule: string; // 规则原文，日志/预览里直接展示
  count: number; // 本章命中次数（0 = 没命中，便于发现写错的规则）
}

export interface CleanResult {
  text: string;
  hits: CleanHit[];
  warnings: string[];
}

interface MapEntry {
  from: string;
  to: string;
  min: number; // 全章出现次数下限，0 = 必换
  raw: string;
}

interface Compiled {
  lines: { re: RegExp; raw: string }[]; // 已去掉 g（.test 有状态会漏判）
  res: { re: RegExp | null; rep: string; raw: string }[];
  maps: MapEntry[];
  mapRe: RegExp | null;
  bad: string[]; // 正则写坏被跳过的规则
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 规则/词表都是用户手写的长文本，每章重复解析+编译纯属浪费（全本缓存 2000 章会放大 2000 倍）
const CACHE_MAX = 128;
const compiled = new Map<string, Compiled>();

export function compilePipeline(rules: unknown, words: unknown): Compiled {
  const key = JSON.stringify([rules ?? null, words ?? null]);
  const hit = compiled.get(key);
  if (hit) return hit;
  const c = buildPipeline(rules, words);
  if (compiled.size >= CACHE_MAX) compiled.clear();
  compiled.set(key, c);
  return c;
}

// 规则清单归一：字符串按行拆；数组里既可能是字符串也可能是 {regex,replacement}
function ruleLines(input: unknown): string[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    const out: string[] = [];
    for (const it of input) {
      if (typeof it === "string") out.push(...it.split(/\r?\n/));
      else if (it && typeof it === "object") {
        const o = it as { regex?: unknown; replacement?: unknown };
        const re = String(o.regex ?? "").trim();
        if (re) out.push(`${re}##${String(o.replacement ?? "")}`);
      }
    }
    return out;
  }
  return String(input).split(/\r?\n/);
}

// 词表归一：`词=替换` 多行 / {词: 替换} / ["词=替换"]
function wordPairs(input: unknown): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  const push = (line: string) => {
    const s = line.trim().replace(/^map\??:/, "");
    if (!s || s.startsWith("//")) return;
    const i = s.indexOf("=");
    if (i <= 0) return;
    const from = s.slice(0, i).trim();
    if (from) out.push({ from, to: s.slice(i + 1) });
  };
  if (!input) return out;
  if (Array.isArray(input)) {
    for (const it of input) {
      if (typeof it === "string") it.split(/\r?\n/).forEach(push);
      else if (it && typeof it === "object") {
        const o = it as { from?: unknown; to?: unknown; word?: unknown };
        const from = String(o.from ?? o.word ?? "").trim();
        if (from) out.push({ from, to: String(o.to ?? "") });
      }
    }
    return out;
  }
  if (typeof input === "object") {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const from = String(k).trim();
      if (from) out.push({ from, to: String(v ?? "") });
    }
    return out;
  }
  String(input).split(/\r?\n/).forEach(push);
  return out;
}

function buildMapRe(keys: string[]): RegExp | null {
  const ordered = [...new Set(keys.filter(Boolean))].sort((a, b) => b.length - a.length); // 长词优先
  if (!ordered.length) return null;
  return new RegExp(ordered.map(escapeRe).join("|"), "g");
}

function buildPipeline(rules: unknown, words: unknown): Compiled {
  const lines: Compiled["lines"] = [];
  const res: Compiled["res"] = [];
  const maps: MapEntry[] = [];
  const bad: string[] = [];

  for (const rawLine of ruleLines(rules)) {
    const t = rawLine.trim();
    if (!t || t.startsWith("//")) continue; // // 注释，方便在规则里写「为什么删这条」

    if (t.startsWith("line!:")) {
      const lit = t.slice(6).trim();
      if (lit) lines.push({ re: new RegExp(escapeRe(lit)), raw: t });
      continue;
    }
    if (t.startsWith("line:")) {
      const re = compileRuleRegex(t.slice(5));
      if (!re) bad.push(t);
      else lines.push({ re: new RegExp(re.source, re.flags.replace("g", "")), raw: t });
      continue;
    }
    if (t.startsWith("map?:") || t.startsWith("map:")) {
      const min = t.startsWith("map?:") ? 2 : 0; // map? = 低频保护：全章不足 2 次不换
      const body = t.slice(t.indexOf(":") + 1);
      const i = body.indexOf("=");
      if (i <= 0) continue;
      const from = body.slice(0, i).trim();
      if (from) maps.push({ from, to: body.slice(i + 1), min, raw: t });
      continue;
    }

    // 无前缀 / re: → 旧写法（正则##替换 / ##正则##删除 / 裸正则删除），语义与 regex.ts 完全一致
    const body = t.startsWith("re:") ? t.slice(3) : t;
    const [one] = parseReplaceRules(body);
    if (!one) continue;
    const re = compileRuleRegex(one.regex);
    if (!re) bad.push(t);
    else res.push({ re, rep: one.replacement, raw: t });
  }

  for (const w of wordPairs(words)) {
    if (!maps.some((m) => m.from === w.from)) maps.push({ from: w.from, to: w.to, min: 0, raw: `map:${w.from}=${w.to}` });
  }

  return { lines, res, maps, mapRe: buildMapRe(maps.map((m) => m.from)), bad };
}

// 规范化：不可见字符、字面量 \n、全角空格、行内多余空白、连续空行、首尾
export function normalizeText(t: string): string {
  return String(t ?? "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff\u00ad]/g, "") // 零宽/方向控制符：反爬常用来打断关键词匹配
    .replace(/\r\n?/g, "\n")
    .replace(/[\u00a0\u3000\t]/g, " ")
    .split("\n")
    .map((l) => l.replace(/ {2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 质检：净化不等于「删干净就好」，删过头/没删干净都要能看出来，而不是让用户读到乱码
function inspect(text: string, before: number, bad: string[]): string[] {
  const w: string[] = [];
  if (bad.length) w.push(`${bad.length} 条规则正则非法已跳过：${bad.slice(0, 3).join(" | ")}`);
  if (before > 500 && text.length < before * 0.4)
    w.push(`净化后仅剩 ${Math.round((text.length / before) * 100)}%（${before}→${text.length} 字），规则可能删过头`);
  if (text.length > 300) {
    const cn = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
    if (cn / text.length < 0.35) w.push(`中文占比 ${Math.round((cn / text.length) * 100)}%，疑似拼音化/编码混淆`);
  }
  if (/\b(?:var|let|const|function)\s+[\w$]+\s*[=(]|\bwindow\.|\bdocument\./.test(text))
    w.push("正文残留 JS 代码（script 标签没清干净）");
  const py = (text.match(/[\u4e00-\u9fa5][a-z]{1,6}[\u4e00-\u9fa5]/g) ?? []).length;
  if (py >= 8) w.push(`发现 ${py} 处「汉字夹拼音」，引擎不自动还原（会改错字），请用 map: 人工维护词表`);
  return w;
}

// 主入口：rules = ruleContent.replaceRegex / class replace（新语法多行文本或数组）
//         words = ruleContent.replaceMap / class replaceMap（词表，人工维护）
export function cleanChapter(raw: string, rules: unknown, words?: unknown): CleanResult {
  const p = compilePipeline(rules, words);
  let text = String(raw ?? "");
  const before = text.length;
  const hits: CleanHit[] = [];

  // ① 整行删除（删行不留空行，否则正文里会多出空洞）
  if (p.lines.length && text) {
    const count = new Map<string, number>();
    const keep: string[] = [];
    for (const line of text.split("\n")) {
      const hit = p.lines.find((r) => r.re.test(line));
      if (hit) count.set(hit.raw, (count.get(hit.raw) ?? 0) + 1);
      else keep.push(line);
    }
    text = keep.join("\n");
    for (const r of p.lines) hits.push({ kind: "line", rule: r.raw, count: count.get(r.raw) ?? 0 });
  }

  // ② 行内替换 / 删除
  for (const r of p.res) {
    if (!r.re) {
      hits.push({ kind: "re", rule: r.raw, count: 0 });
      continue;
    }
    const count = (text.match(r.re) ?? []).length;
    if (count) text = text.replace(r.re, r.rep);
    hits.push({ kind: "re", rule: r.raw, count });
  }

  // ③ 词典还原：一次扫描 + 长词优先，避免 A→B 之后 B 再被 C 命中（链式污染）
  if (p.mapRe) {
    const seen = new Map<string, number>();
    for (const m of text.matchAll(p.mapRe)) seen.set(m[0], (seen.get(m[0]) ?? 0) + 1);
    const active = p.maps.filter((k) => !k.min || (seen.get(k.from) ?? 0) >= k.min);
    for (const k of p.maps) {
      const on = active.includes(k);
      hits.push({ kind: "map", rule: k.raw, count: on ? (seen.get(k.from) ?? 0) : 0 });
    }
    if (active.length) {
      const re = active.length === p.maps.length ? p.mapRe : buildMapRe(active.map((k) => k.from));
      const table = new Map(active.map((k) => [k.from, k.to]));
      if (re) text = text.replace(re, (m) => table.get(m) ?? m);
    }
  }

  // ④ 规范化
  text = normalizeText(text);

  // ⑤ 质检
  return { text, hits, warnings: inspect(text, before, p.bad) };
}
