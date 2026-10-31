// 书源正则的统一编译与解析。放在这里是为了让「规则源」和「脚本源」走同一套语义，
// 避免出现「规则源能替换、脚本源不替换」这类只在其中一条链路上复现的怪问题。

export interface ReplaceRule {
  regex: string;
  replacement: string;
}

// 编译一条书源正则，抹平 Java(Legado) 与 JS 的差异：
//
// 1) 默认不区分大小写。站点常用大小写混淆规避过滤（正文里塞 www.qUAnbEn-xIaosHuo.CoM 这种），
//    而净化类规则的意图无一例外是「把这段干掉」，区分大小写只会漏删。需要严格区分时写 (?-i)。
// 2) Java 的内联标志 (?i)/(?im)/(?-i) JS 不认识，直接 new RegExp 会抛 Invalid group，
//    以前被 catch 吞掉 —— 规则看起来「配了但没生效」，且没有任何提示。这里剥成真正的 flags。
//    （只映射 i/m/s；u 不映射，JS 的 u 会收紧转义，反而让 Java 写法的正则报错）
export function compileRuleRegex(pattern: string, insensitive = true): RegExp | null {
  // 不 trim：字段规则里 ## 后面可能带首尾空格（如 "##test " 想连空格一起删）
  let src = String(pattern ?? "");
  if (!src.trim()) return null;
  const on = new Set<string>(insensitive ? ["i"] : []);
  const off = new Set<string>();
  // 只剥前导标志，允许叠几层：(?i)(?m)xxx
  for (let i = 0; i < 4; i++) {
    const m = src.match(/^\(\?([a-z]*)(?:-([a-z]+))?\)/i);
    if (!m) break;
    for (const c of (m[1] ?? "").toLowerCase()) on.add(c);
    for (const c of m[2] ?? "") off.add(c.toLowerCase());
    src = src.slice(m[0].length);
  }
  const flags = new Set<string>(["g"]);
  for (const f of ["i", "m", "s"]) if (on.has(f) && !off.has(f)) flags.add(f);
  try {
    return new RegExp(src, [...flags].join(""));
  } catch {
    return null; // 书源里正则写坏了：跳过这条，不炸整章
  }
}

// 解析替换净化规则。三种写法都要认（前端提示、Legado 导入的源、手写的源里都能见到）：
//
//   "正则##替换为"      常规
//   "##正则##"          两端 ## 包裹，等价于删除命中的内容（前端提示里教的就是这种）
//   "##正则##替换为"    两端 ## 包裹 + 带替换
//   "正则"              没有 ## 时整行按正则处理，命中即删除
//
// 多行 = 多条规则。数组形式（脚本源的 replace 成员）原样透传。
export function parseReplaceRules(input: unknown): ReplaceRule[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    const out: ReplaceRule[] = [];
    for (const item of input) {
      if (typeof item === "string") out.push(...parseReplaceRules(item));
      else if (item && typeof item === "object") {
        const regex = String((item as { regex?: unknown }).regex ?? "").trim();
        if (regex) out.push({ regex, replacement: String((item as { replacement?: unknown }).replacement ?? "") });
      }
    }
    return out;
  }
  const out: ReplaceRule[] = [];
  for (const raw of String(input).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    if (line.startsWith("##")) line = line.slice(2); // ##正则## → 正则##
    const i = line.indexOf("##");
    const regex = (i >= 0 ? line.slice(0, i) : line).trim();
    if (!regex) continue;
    out.push({ regex, replacement: i >= 0 ? line.slice(i + 2) : "" });
  }
  return out;
}

// 依次应用全部替换规则
export function applyReplaceRules(content: string, input: unknown): string {
  const rules = parseReplaceRules(input);
  if (!rules.length) return content;
  let out = content;
  for (const r of rules) {
    const re = compileRuleRegex(r.regex);
    if (re) out = out.replace(re, r.replacement);
  }
  return out;
}
