import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";

interface SourceRow {
  id: number;
  name: string;
  bookUrl: string;
  group: string;
  enabled: boolean;
}
interface DebugEvt {
  level: "info" | "ok" | "warn" | "err";
  step: string;
  msg: string;
}

// 表单按区块声明，字段 = [路径, 标签, 行数?]
const SECTIONS: { title: string; fields: [string, string, number?][] }[] = [
  {
    title: "基本",
    fields: [
      ["bookSourceUrl", "源域名（必填，通常为网站主页）", 1],
      ["bookSourceName", "源名称（必填）", 1],
      ["bookSourceGroup", "源分组", 1],
      ["bookSourceComment", "源注释", 1],
      ["header", "请求头（JSON 字符串）", 3],
      ["searchUrl", "搜索地址，支持 {{key}}/{{page}}，可带 ,{\"method\":\"POST\",\"body\":...}", 2],
    ],
  },
  {
    title: "搜索",
    fields: [
      ["ruleSearch.bookList", "列表规则（结果为元素列表）"],
      ["ruleSearch.name", "书名规则"],
      ["ruleSearch.author", "作者规则"],
      ["ruleSearch.lastChapter", "最新章节"],
      ["ruleSearch.intro", "简介规则"],
      ["ruleSearch.coverUrl", "封面规则"],
      ["ruleSearch.bookUrl", "详情地址"],
    ],
  },
  {
    title: "详情",
    fields: [
      ["ruleBookInfo.name", "书名规则"],
      ["ruleBookInfo.author", "作者规则"],
      ["ruleBookInfo.lastChapter", "最新章节"],
      ["ruleBookInfo.intro", "简介规则"],
      ["ruleBookInfo.coverUrl", "封面规则"],
      ["ruleBookInfo.tocUrl", "目录地址（与详情页相同可省略）"],
    ],
  },
  {
    title: "目录",
    fields: [
      ["ruleToc.chapterList", "列表规则（结果为元素列表）", 2],
      ["ruleToc.chapterName", "章节名称"],
      ["ruleToc.chapterUrl", "章节地址"],
    ],
  },
  {
    title: "正文",
    fields: [
      ["ruleContent.content", "正文规则", 2],
      ["ruleContent.replaceRegex", "替换净化规则（正则##替换为）"],
    ],
  },
];

const emptyForm = () => ({
  bookSourceUrl: "",
  bookSourceName: "",
  bookSourceGroup: "默认",
  bookSourceComment: "",
  header: "",
  searchUrl: "",
  ruleSearch: {},
  ruleBookInfo: {},
  ruleToc: {},
  ruleContent: {},
  enabled: true,
});

const getIn = (obj: any, path: string) => path.split(".").reduce((o, k) => o?.[k], obj);
const setIn = (obj: any, path: string, v: any) => {
  const keys = path.split(".");
  const last = keys.pop()!;
  let cur = obj;
  for (const k of keys) cur = (cur[k] ??= {});
  cur[last] = v;
};

const levelColor: Record<DebugEvt["level"], string> = {
  info: "text-neutral-400",
  ok: "text-emerald-400",
  warn: "text-amber-400",
  err: "text-red-400",
};

export default function Sources() {
  const [tab, setTab] = useState<"edit" | "debug" | "list" | "help">("list");
  const [rows, setRows] = useState<SourceRow[]>([]);
  const [filter, setFilter] = useState("");
  const [form, setForm] = useState<any>(emptyForm());
  const [jsonText, setJsonText] = useState("");
  const [msg, setMsg] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [debugSrcId, setDebugSrcId] = useState<number | null>(null);
  const [debugKey, setDebugKey] = useState("我的");
  const [logs, setLogs] = useState<DebugEvt[]>([]);
  const [debugging, setDebugging] = useState(false);
  const logBox = useRef<HTMLDivElement>(null);

  const load = () => api<SourceRow[]>("/api/sources").then(setRows).catch((e) => setMsg(e.message));
  useEffect(() => {
    load();
  }, []);
  const shown = rows.filter(
    (r) => !filter || r.name.includes(filter) || r.group.includes(filter) || r.bookUrl.includes(filter),
  );

  // —— 编辑源 ——
  const setField = (path: string, v: string) =>
    setForm((f: any) => {
      const next = structuredClone(f);
      setIn(next, path, v);
      return next;
    });
  const loadForEdit = async (r: SourceRow) => {
    const row = await api<{ json: string }>(`/api/sources/${r.id}`);
    setForm(JSON.parse(row.json));
    setJsonText(JSON.stringify(JSON.parse(row.json), null, 2));
    setMsg(`已载入「${r.name}」到编辑器`);
    setTab("edit");
  };
  const newSource = () => {
    setForm(emptyForm());
    setJsonText("");
    setMsg("");
  };
  const formToJson = () => {
    const clean = structuredClone(form);
    for (const k of ["ruleSearch", "ruleBookInfo", "ruleToc", "ruleContent"])
      if (!Object.keys(clean[k]).length) delete clean[k];
    setJsonText(JSON.stringify(clean, null, 2));
    setMsg("已生成 JSON，可直接保存或复制到阅读 APP");
  };
  const jsonToForm = () => {
    try {
      const parsed = JSON.parse(jsonText);
      setForm({ ...emptyForm(), ...parsed });
      setMsg("已解析 JSON 到表单");
    } catch {
      setMsg("JSON 解析失败");
    }
  };
  const saveForm = async () => {
    formToJson();
    try {
      const r = await api<{ added: number; updated: number }>("/api/sources/import", {
        method: "POST",
        body: JSON.stringify({ text: jsonText || JSON.stringify(form) }),
      });
      setMsg(r.updated ? "已更新书源" : "已新增书源");
      load();
    } catch (e: any) {
      setMsg(e.message);
    }
  };

  // —— 源列表 ——
  const doImportUrl = async () => {
    setMsg("");
    try {
      const r = await api<{ added: number; updated: number }>("/api/sources/import", {
        method: "POST",
        body: JSON.stringify({ url: importUrl }),
      });
      setMsg(`导入完成：新增 ${r.added}，更新 ${r.updated}`);
      setImportUrl("");
      load();
    } catch (e: any) {
      setMsg(e.message);
    }
  };
  const toggle = async (r: SourceRow) => {
    await api(`/api/sources/${r.id}`, { method: "PUT", body: JSON.stringify({ enabled: !r.enabled }) });
    load();
  };
  const del = async (r: SourceRow) => {
    if (!confirm(`删除书源「${r.name}」？`)) return;
    await api(`/api/sources/${r.id}`, { method: "DELETE" });
    load();
  };
  const doExport = async () => {
    const data = await api<any[]>("/api/sources/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "legado-sources.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // —— 调试源 ——
  const runDebug = async () => {
    if (!debugSrcId) return setMsg("先选择要调试的书源");
    setLogs([]);
    setDebugging(true);
    try {
      const res = await fetch(`/api/sources/${debugSrcId}/debug`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: debugKey }),
      });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop()!;
        for (const p of parts) {
          const line = p.trim();
          if (line.startsWith("data: ")) setLogs((l) => [...l, JSON.parse(line.slice(6))]);
        }
      }
    } catch (e: any) {
      setLogs((l) => [...l, { level: "err", step: "client", msg: e.message }]);
    } finally {
      setDebugging(false);
    }
  };
  useEffect(() => {
    logBox.current?.scrollTo({ top: logBox.current.scrollHeight });
  }, [logs]);

  const tabs: [typeof tab, string][] = [
    ["edit", "编辑源"],
    ["debug", "调试源"],
    ["list", `源列表（${rows.length}）`],
    ["help", "帮助"],
  ];

  return (
    <div className="mx-auto min-h-dvh max-w-6xl p-4">
      <header className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-bold">书源</h1>
        <Link to="/" className="text-sm text-neutral-400 hover:text-neutral-200">← 书架</Link>
      </header>
      {msg && <div className="mb-3 rounded-lg bg-neutral-800 px-3 py-2 text-sm text-amber-400">{msg}</div>}

      <nav className="mb-4 flex gap-1 border-b border-neutral-700">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-4 py-2 text-sm ${tab === id ? "border-b-2 border-amber-500 font-medium text-amber-400" : "text-neutral-400 hover:text-neutral-200"}`}
          >
            {label}
          </button>
        ))}
      </nav>

      {/* 编辑源 */}
      {tab === "edit" && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-4">
            {SECTIONS.map((sec) => (
              <fieldset key={sec.title} className="rounded-xl bg-neutral-800 p-4">
                <legend className="px-1 text-sm font-bold text-amber-400">{sec.title}</legend>
                <div className="space-y-2">
                  {sec.fields.map(([path, label, rowsN = 1]) => (
                    <label key={path} className="block">
                      <span className="mb-0.5 block text-xs text-neutral-400">{label}</span>
                      {rowsN > 1 ? (
                        <textarea
                          rows={rowsN}
                          className="w-full rounded-lg bg-neutral-700 px-2 py-1.5 font-mono text-xs"
                          value={getIn(form, path) ?? ""}
                          onChange={(e) => setField(path, e.target.value)}
                        />
                      ) : (
                        <input
                          className="w-full rounded-lg bg-neutral-700 px-2 py-1.5 font-mono text-xs"
                          value={getIn(form, path) ?? ""}
                          onChange={(e) => setField(path, e.target.value)}
                        />
                      )}
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
          <div className="flex h-fit flex-col rounded-xl bg-neutral-800 p-4 md:sticky md:top-4">
            <div className="mb-2 flex flex-wrap gap-2">
              <button onClick={formToJson} className="rounded-lg bg-neutral-600 px-3 py-1.5 text-sm">表单 → JSON</button>
              <button onClick={jsonToForm} className="rounded-lg bg-neutral-600 px-3 py-1.5 text-sm">JSON → 表单</button>
              <button onClick={saveForm} className="rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-medium text-neutral-900">保存源</button>
              <button onClick={newSource} className="rounded-lg bg-neutral-700 px-3 py-1.5 text-sm">✗ 清空新建</button>
            </div>
            <textarea
              className="h-96 w-full rounded-lg bg-neutral-900 p-3 font-mono text-xs leading-5"
              placeholder="序列化的书源 JSON，可直接复制到 Legado 导入"
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
            />
          </div>
        </div>
      )}

      {/* 调试源 */}
      {tab === "debug" && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <select
              className="rounded-lg bg-neutral-800 px-3 py-1.5 text-sm"
              value={debugSrcId ?? ""}
              onChange={(e) => setDebugSrcId(Number(e.target.value) || null)}
            >
              <option value="">选择书源…</option>
              {rows.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
            <input
              className="flex-1 rounded-lg bg-neutral-800 px-3 py-1.5 text-sm"
              placeholder="搜索关键词，默认「我的」"
              value={debugKey}
              onChange={(e) => setDebugKey(e.target.value)}
            />
            <button onClick={runDebug} disabled={debugging}
              className="rounded-lg bg-amber-500 px-4 py-1.5 text-sm font-medium text-neutral-900 disabled:opacity-50">
              {debugging ? "调试中…" : "⇏ 调试"}
            </button>
          </div>
          <div ref={logBox} className="h-[28rem] overflow-y-auto rounded-xl bg-neutral-900 p-3 font-mono text-xs leading-5">
            {logs.map((l, i) => (
              <div key={i} className={levelColor[l.level]}>
                <span className="text-neutral-600">[{l.step}]</span> {l.msg}
              </div>
            ))}
            {!logs.length && <div className="text-neutral-600">选源 → 输关键词 → 点调试，流程：搜索 → 详情 → 目录 → 正文</div>}
          </div>
        </div>
      )}

      {/* 源列表 */}
      {tab === "list" && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <input
              className="flex-1 rounded-lg bg-neutral-800 px-3 py-1.5 text-sm"
              placeholder="输入筛选关键词（源名称、源 URL 或源分组）"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <input
              className="w-72 rounded-lg bg-neutral-800 px-3 py-1.5 text-sm"
              placeholder="或输入书源 JSON 地址批量导入"
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
            />
            <button onClick={doImportUrl} className="rounded-lg bg-neutral-600 px-3 py-1.5 text-sm">导入</button>
            <button onClick={doExport} className="rounded-lg bg-neutral-600 px-3 py-1.5 text-sm">导出</button>
          </div>
          <ul className="space-y-1">
            {shown.map((r) => (
              <li key={r.id} className="flex items-center gap-2 rounded-lg bg-neutral-800 px-3 py-2 text-sm">
                <input type="checkbox" checked={r.enabled} onChange={() => toggle(r)} className="accent-amber-500" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{r.name}</div>
                  <div className="truncate text-xs text-neutral-500">{r.group} · {r.bookUrl}</div>
                </div>
                <button onClick={() => loadForEdit(r)} className="rounded bg-neutral-600 px-2 py-0.5 text-xs hover:bg-neutral-500">编辑</button>
                <button onClick={() => { setDebugSrcId(r.id); setTab("debug"); }} className="rounded bg-neutral-600 px-2 py-0.5 text-xs hover:bg-neutral-500">调试</button>
                <button onClick={() => del(r)} className="text-xs text-red-400 hover:text-red-300">删除</button>
              </li>
            ))}
            {!shown.length && <li className="py-8 text-center text-neutral-500">暂无书源</li>}
          </ul>
        </div>
      )}

      {/* 帮助 */}
      {tab === "help" && (
        <div className="space-y-4 rounded-xl bg-neutral-800 p-4 text-sm leading-6 text-neutral-300">
          <p><b className="text-amber-400">规则语法（首版支持）</b></p>
          <ul className="list-disc space-y-1 pl-5">
            <li><code>class.bookname@tag.a@text</code> — class/tag/id/text 关键字规则，@ 分段</li>
            <li><code>id.content@textNodes</code> — 取全部文本节点（按行分隔，适合正文）</li>
            <li><code>tag.a@href</code> / <code>tag.img@data-src</code> — 属性取值，href/src 自动补全绝对地址</li>
            <li><code>id.content@text##广告.*</code> — ## 正则后处理（净化）</li>
            <li><code>规则A||规则B</code> — A 无结果时用 B</li>
            <li><code>$.data.books[*].name</code> — JsonPath（API 类书源）</li>
          </ul>
          <p><b className="text-amber-400">暂不支持</b>：&lt;js&gt; 脚本规则、&amp;&amp; 合并、! 排除、目录/正文翻页规则、发现页。</p>
          <p><b className="text-amber-400">参考链接</b></p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-neutral-400">
            <a className="hover:text-amber-400" href="https://alanskycn.gitee.io/teachme" target="_blank">源制作教程</a>
            <a className="hover:text-amber-400" href="https://zhuanlan.zhihu.com/p/29436838" target="_blank">XPath 基础</a>
            <a className="hover:text-amber-400" href="https://www.w3cschool.cn/regex_rmjc" target="_blank">正则表达式教程</a>
            <a className="hover:text-amber-400" href="https://regexr.com" target="_blank">正则在线验证</a>
          </div>
          <p className="text-xs text-neutral-500">Java 正则前缀：(?s) 跨行 · (?m) 逐行 · (?i) 忽略大小写</p>
        </div>
      )}
    </div>
  );
}
