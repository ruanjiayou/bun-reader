import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";

interface SourceRow {
  id: number;
  name: string;
  bookUrl: string;
  group: string;
  enabled: boolean;
  type: string; // rules = 规则表单源；script = class 脚本源
}
interface DebugEvt {
  level: "info" | "ok" | "warn" | "err";
  step: string;
  msg: string;
  info?: DebugBookInfo;
}
interface DebugBookInfo {
  bookUrl: string;
  name: string;
  author: string;
  cover: string;
  intro: string;
  latestChapter: string;
}
interface SearchBook {
  name: string;
  author: string;
  bookUrl: string;
  cover: string;
  intro: string;
  latestChapter: string;
}

// 表单按区块声明，字段 = { path, label, ph 示例提示, rows 行数 }；规则一律 v2 链式调用语法
const SECTIONS: { title: string; fields: { path: string; label: string; ph?: string; rows?: number }[] }[] = [
  {
    title: "基本",
    fields: [
      { path: "bookSourceUrl", label: "源域名（必填，通常为网站主页）", ph: "https://www.example.com/" },
      { path: "bookSourceName", label: "源名称（必填）", ph: "示例源" },
      { path: "bookSourceGroup", label: "源分组", ph: "默认" },
      { path: "bookSourceComment", label: "源注释", ph: "作者 / 备注" },
      { path: "header", label: "请求头（JSON 字符串）", rows: 3, ph: '{"User-Agent":"Mozilla/5.0","Referer":"https://www.example.com/"}' },
      {
        path: "searchUrl",
        label: "搜索地址，支持 {{key}}/{{page}}，可带 ,{\"method\":\"POST\",\"body\":...}",
        rows: 2,
        ph: "/search/{{key}}.html\n或 /search.php,{\"method\":\"POST\",\"body\":\"kw={{key}}\"}",
      },
    ],
  },
  {
    title: "搜索",
    fields: [
      { path: "ruleSearch.bookList", label: "列表规则（选元素，不是取文本！）", rows: 2, ph: "'.bookbox'\n或 '.bookbox > div' / 'li.book'" },
      { path: "ruleSearch.name", label: "书名（文本）", ph: "'.bookname a'.text()" },
      { path: "ruleSearch.author", label: "作者（文本）", ph: "'.author'.text()##作者：|字数：.+" },
      { path: "ruleSearch.lastChapter", label: "最新章节（文本）", ph: "'.cat a'.text()" },
      { path: "ruleSearch.intro", label: "简介（文本）", ph: "'.update'.text()" },
      { path: "ruleSearch.coverUrl", label: "封面（图片，用 attr('src')）", ph: "'img'.attr('src') 或 '.thumbnail img'.attr('src')" },
      { path: "ruleSearch.bookUrl", label: "详情地址（链接 attr('href')，必填）", ph: "'.bookname a'.attr('href')" },
    ],
  },
  {
    title: "详情",
    fields: [
      { path: "ruleBookInfo.name", label: "书名（文本）", ph: "'h1'.text()" },
      { path: "ruleBookInfo.author", label: "作者（文本）", ph: "'.booktag a:eq(0)'.text()" },
      { path: "ruleBookInfo.lastChapter", label: "最新章节（文本）", ph: "'.bookchapter'.text()" },
      { path: "ruleBookInfo.intro", label: "简介（文本）", ph: "'.bookintro'.text()" },
      { path: "ruleBookInfo.coverUrl", label: "封面（图片，用 attr('src')）", ph: "'.thumbnail img'.attr('src')" },
      { path: "ruleBookInfo.tocUrl", label: "目录地址（链接 attr('href')，与详情页相同可留空）", ph: "'#allchapter a:eq(-1)'.attr('href')" },
    ],
  },
  {
    title: "目录",
    fields: [
      { path: "ruleToc.chapterList", label: "列表规则（选元素，不是取文本！）", rows: 2, ph: "'dd'\n或 '.chapter-list li' / '#all > dl dd'" },
      { path: "ruleToc.chapterName", label: "章节名称（相对列表项：.text() 取文本）", ph: "'a'.text()\n或 .text()（列表项本身是 a 时）\n或 .find('a').attr('title')（名称在属性里）" },
      { path: "ruleToc.chapterUrl", label: "章节地址（相对列表项取链接）", ph: "'a'.attr('href')\n或 .attr('href')（列表项本身是 a 时）" },
      { path: "ruleToc.nextTocUrl", label: "翻页规则（下一页链接，取到空即结束）", ph: "'.pagelink a:eq(-1)'.attr('href')\n或 '.next-page'.attr('href')" },
    ],
  },
  {
    title: "正文",
    fields: [
      { path: "ruleContent.content", label: "正文规则（多行文本用 .textNodes()）", rows: 2, ph: "'#content'.textNodes()\n或 '.readcontent'.text()" },
      { path: "ruleContent.replaceRegex", label: "替换净化（正则##替换为，替换为留空=删除）", ph: "广告.*?<br>##\n（##广告.*?##  删除匹配内容）" },
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

// 脚本源按表单编辑：每个方法一个表单项，内容是基础模板（留空 = 未实现），保存时合并拼接为 class 文件
const METHOD_DEFS: { key: "search" | "getDetail" | "getChapters" | "getContent"; label: string; tpl: string }[] = [
  {
    key: "search",
    label: "搜索 search(name, page) → [{title, author, desc, cover, detailUrl}]",
    tpl: `async search(name, page = 1) {
  // 此处添加逻辑
  // const res = await fetchText(\`\${this.base}/search?kw=\${encodeURIComponent(name)}\`)
  // const $ = parse(res.text)
}`,
  },
  {
    key: "getDetail",
    label: "获取详情 getDetail(url) → { title, author, desc, cover, tocUrl }",
    tpl: `async getDetail(url) {
  // 此处添加逻辑
}`,
  },
  {
    key: "getChapters",
    label: "获取目录 getChapters(url) → { list: [{title, url}], next? }（翻页由引擎按 next 循环）",
    tpl: `async getChapters(url) {
  // 此处添加逻辑
}`,
  },
  {
    key: "getContent",
    label: "获取正文 getContent(url) → string 或 { text, next? }（翻页引擎拼接）",
    tpl: `async getContent(url) {
  // 此处添加逻辑
}`,
  },
];

const emptyScriptForm = () => ({
  name: "",
  base: "",
  headersText: "", // headers 成员（JSON 文本）
  replaceText: "", // replace 成员（每行 正则##替换为）
  enabled: true,
  methods: { search: "", getDetail: "", getChapters: "", getContent: "" } as Record<string, string>,
});

export default function Sources() {
  const [rows, setRows] = useState<SourceRow[]>([]);
  const [filter, setFilter] = useState("");
  const [editId, setEditId] = useState<number | null>(null); // null = 新建未保存
  const [form, setForm] = useState<any>(emptyForm());
  const [jsonText, setJsonText] = useState("");
  const [rightTab, setRightTab] = useState<"json" | "debug" | "js">("json");
  const [msg, setMsg] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [debugKey, setDebugKey] = useState("我的");
  const [dbgMode, setDbgMode] = useState<"search" | "book">("search");
  const [debugBookUrl, setDebugBookUrl] = useState("");
  const [searchResults, setSearchResults] = useState<SearchBook[]>([]);
  const [logs, setLogs] = useState<DebugEvt[]>([]);
  const [debugging, setDebugging] = useState(false);
  const [dirty, setDirty] = useState(false); // 表单/JSON 有未保存改动 → 保存按钮高亮
  const [dbgBook, setDbgBook] = useState<DebugBookInfo | null>(null); // 调试全链路成功后的书籍信息，可加书架
  const [addingBook, setAddingBook] = useState(false);
  const [srcType, setSrcType] = useState<"rules" | "script">("rules"); // 当前编辑上下文的源类型
  const [scriptForm, setScriptForm] = useState(emptyScriptForm()); // 脚本源表单（保存时合并生成 class 脚本）
  const [scriptCode, setScriptCode] = useState(""); // 右侧「生成的 JS」只读预览（rules/script 都是生成产物）
  const nav = useNavigate();
  const logBox = useRef<HTMLDivElement>(null);

  const load = () => api<SourceRow[]>("/api/sources").then(setRows).catch((e) => setMsg(e.message));
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    logBox.current?.scrollTo({ top: logBox.current.scrollHeight });
  }, [logs]);
  // 提示信息 4 秒自动消失
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(""), 4000);
    return () => clearTimeout(t);
  }, [msg]);
  const shown = rows.filter(
    (r) => !filter || r.name.includes(filter) || r.group.includes(filter) || r.bookUrl.includes(filter),
  );

  // —— 编辑 ——
  const setField = (path: string, v: string) => {
    setDirty(true);
    setForm((f: any) => {
      const next = structuredClone(f);
      setIn(next, path, v);
      return next;
    });
  };
  // 表单 → JSON 文本（去掉空规则对象）
  const formJson = (f: any) => {
    const clean = structuredClone(f);
    for (const k of ["ruleSearch", "ruleBookInfo", "ruleToc", "ruleContent"])
      if (!Object.keys(clean[k] ?? {}).length) delete clean[k];
    return JSON.stringify(clean, null, 2);
  };
  const selectSource = async (id: number | null | "new-script") => {
    setLogs([]);
    setDirty(false);
    setDbgBook(null);
    if (id === null) {
      setEditId(null);
      setForm(emptyForm());
      setJsonText("");
      setSrcType("rules");
      setScriptForm(emptyScriptForm());
      setScriptCode("");
      setMsg("");
      return;
    }
    if (id === "new-script") {
      setEditId(null);
      setForm(emptyForm());
      setJsonText("");
      setSrcType("script");
      setScriptForm(emptyScriptForm());
      setScriptCode("");
      setRightTab("debug");
      setMsg("新建脚本源：填好方法后点「保存源」，保存时自动合并生成 class 脚本");
      return;
    }
    try {
      const row = await api<{ id: number; json: string; type: string; enabled: boolean }>(`/api/sources/${id}`);
      setEditId(id);
      setSrcType(row.type === "script" ? "script" : "rules");
      if (row.type === "script") {
        // script 源的 json 存的是表单数据（保存时的真相），code 是生成产物（只读）
        const f = JSON.parse(row.json || "{}");
        // headers 兼容字符串形态（规则源 header 带过来的旧数据）：先解析成对象再展示，避免 textarea 里出现二次编码
        let h = f.headers;
        if (typeof h === "string") {
          try {
            h = JSON.parse(h);
          } catch {
            h = null;
          }
        }
        setScriptForm({
          name: f.name ?? row.name ?? "",
          base: f.base ?? "",
          headersText: h && Object.keys(h).length ? JSON.stringify(h, null, 2) : "",
          replaceText: (f.replace ?? []).map((r: any) => `${r.regex}##${r.replacement ?? ""}`).join("\n"),
          enabled: row.enabled !== false,
          methods: {
            search: f.methods?.search ?? "",
            getDetail: f.methods?.getDetail ?? "",
            getChapters: f.methods?.getChapters ?? "",
            getContent: f.methods?.getContent ?? "",
          },
        });
        setForm(emptyForm());
        setJsonText("");
        setRightTab((t) => (t === "json" ? "debug" : t));
        const { code } = await api<{ code: string }>(`/api/sources/${id}/code`);
        setScriptCode(code);
      } else {
        setForm(JSON.parse(row.json));
        setJsonText(JSON.stringify(JSON.parse(row.json), null, 2));
        setScriptCode("");
      }
      setMsg("");
    } catch (e: any) {
      setMsg(e.message);
    }
  };
  // JSON → 表单（失焦时静默同步），非法 JSON 不覆盖表单并给出提示，避免后续表单失焦把 JSON 改动悄悄冲掉
  const syncJsonToForm = (): boolean => {
    try {
      const parsed = JSON.parse(jsonText);
      setForm({ ...emptyForm(), ...parsed });
      return true;
    } catch {
      if (jsonText.trim()) setMsg("JSON 格式有误，未同步到左侧表单（修正后再失焦即可）");
      return false;
    }
  };
  // 保存当前源（upsert），返回源 id。rules 走 import 接口；script 走专用接口（新建/更新代码）
  const saveSource = async (): Promise<number | null> => {
    try {
      if (srcType === "script") {
        if (!scriptForm.name.trim()) {
          setMsg("缺少源名称");
          return null;
        }
        let headers: Record<string, string> = {};
        if (scriptForm.headersText.trim()) {
          try {
            headers = JSON.parse(scriptForm.headersText);
            if (typeof headers !== "object" || headers === null || Array.isArray(headers)) throw new Error("not object");
          } catch {
            setMsg("请求头 headers 不是合法的 JSON 对象");
            return null;
          }
        }
        const replace = scriptForm.replaceText
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const i = l.indexOf("##");
            return i === -1 ? { regex: l, replacement: "" } : { regex: l.slice(0, i), replacement: l.slice(i + 2) };
          });
        const methods: Record<string, string> = {};
        for (const k of ["search", "getDetail", "getChapters", "getContent"]) if (scriptForm.methods[k]?.trim()) methods[k] = scriptForm.methods[k];
        const body = { name: scriptForm.name.trim(), base: scriptForm.base.trim(), headers, replace, methods };
        if (editId === null) {
          const r = await api<{ id: number }>("/api/sources/script", { method: "POST", body: JSON.stringify(body) });
          setEditId(r.id);
          await load();
          const { code } = await api<{ code: string }>(`/api/sources/${r.id}/code`);
          setScriptCode(code);
          setMsg("脚本源已创建（已合并生成 class 脚本）");
          setDirty(false);
          return r.id;
        }
        await api(`/api/sources/script/${editId}`, { method: "PUT", body: JSON.stringify(body) });
        await load();
        const { code } = await api<{ code: string }>(`/api/sources/${editId}/code`);
        setScriptCode(code);
        setMsg("已保存，class 脚本已重新生成");
        setDirty(false);
        return editId;
      }
      const text = jsonText.trim().startsWith("{") ? jsonText : JSON.stringify(form);
      await api("/api/sources/import", { method: "POST", body: JSON.stringify({ text }) });
      await load();
      const url = JSON.parse(text).bookSourceUrl;
      const row = rows.find((r) => r.bookUrl === url) ?? (await api<SourceRow[]>("/api/sources")).find((r) => r.bookUrl === url);
      if (row) setEditId(row.id);
      setMsg("已保存");
      setDirty(false);
      return row?.id ?? null;
    } catch (e: any) {
      setMsg(e.message);
      return null;
    }
  };
  const del = async () => {
    if (editId === null) return setMsg("当前是未保存的新源");
    const name = srcType === "script" ? scriptForm.name : form.bookSourceName;
    if (!confirm(`删除书源「${name}」？`)) return;
    await api(`/api/sources/${editId}`, { method: "DELETE" });
    await selectSource(null);
    load();
  };
  const toggleEnabled = async () => {
    if (editId === null) return setMsg("先保存后再启停");
    const cur = srcType === "script" ? scriptForm.enabled : !!form.enabled;
    await api(`/api/sources/${editId}`, { method: "PUT", body: JSON.stringify({ enabled: !cur }) });
    if (srcType === "script") setScriptForm((f) => ({ ...f, enabled: !f.enabled }));
    else setForm((f: any) => ({ ...f, enabled: !f.enabled }));
    load();
  };
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
  const doExport = async () => {
    const data = await api<any[]>("/api/sources/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "legado-sources.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // —— 调试：调已保存的源（不自动保存）——
  const runDebugSearch = async () => {
    if (editId === null) return setMsg("先保存源再调试");
    setDebugging(true);
    setSearchResults([]);
    setLogs([]);
    setDbgBook(null);
    try {
      const r = await api<{ books: SearchBook[]; logs: DebugEvt[]; error?: string }>(
        `/api/sources/${editId}/debug-search`,
        { method: "POST", body: JSON.stringify({ key: debugKey }) },
      );
      setSearchResults(r.books);
      setLogs(r.logs);
      if (r.error) setLogs((l) => [...l, { level: "err", step: "done", msg: r.error! }]);
      setMsg(r.books.length ? `搜索到 ${r.books.length} 条` : r.error ?? "搜索无结果");
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setDebugging(false);
    }
  };
  const runDebugBook = async () => {
    if (editId === null) return setMsg("先保存源再调试");
    if (!debugBookUrl.trim()) return setMsg("输入书籍详情页 URL");
    setLogs([]);
    setDbgBook(null);
    setDebugging(true);
    try {
      const res = await fetch(`/api/sources/${editId}/debug`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookUrl: debugBookUrl.trim() }),
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
          if (line.startsWith("data: ")) {
            const evt = JSON.parse(line.slice(6)) as DebugEvt;
            if (evt.step === "bookinfo" && evt.info) setDbgBook(evt.info);
            else setLogs((l) => [...l, evt]);
          }
        }
      }
    } catch (e: any) {
      setLogs((l) => [...l, { level: "err", step: "client", msg: e.message }]);
    } finally {
      setDebugging(false);
    }
  };

  // 调试全链路成功后一键加书架（无搜索的源靠这个入库）：books 表立即落库，目录后台异步补
  const addBookFromDebug = async () => {
    if (!dbgBook || editId === null) return;
    setAddingBook(true);
    try {
      const r = await api<{ id: number }>("/api/books", {
        method: "POST",
        body: JSON.stringify({
          bookUrl: dbgBook.bookUrl,
          sourceId: editId,
          info: { name: dbgBook.name, author: dbgBook.author, cover: dbgBook.cover, intro: dbgBook.intro, latestChapter: dbgBook.latestChapter },
        }),
      });
      setMsg(`已加入书架：《${dbgBook.name}》`);
      nav(`/book/${r.id}`);
    } catch (e: any) {
      setMsg(`加书架失败：${e.message}`);
      setAddingBook(false);
    }
  };

  const cur = rows.find((r) => r.id === editId);
  const btn = "w-full rounded-lg bg-neutral-600 px-3 py-1.5 text-sm hover:bg-neutral-500";
  const btnPrimary = "w-full rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-amber-400";
  const inpMono = "w-full rounded-lg bg-neutral-700 px-2 py-1.5 font-mono text-xs placeholder:text-neutral-500";

  return (
    <div className="mx-auto min-h-dvh max-w-7xl p-4">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-bold">书源</h1>
        <input
          className="w-40 rounded-lg bg-neutral-800 px-3 py-1.5 text-sm"
          placeholder="筛选（名称/URL/分组）"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <input
          className="w-64 rounded-lg bg-neutral-800 px-3 py-1.5 text-sm"
          placeholder="书源 JSON 地址批量导入"
          value={importUrl}
          onChange={(e) => setImportUrl(e.target.value)}
        />
        <button onClick={doImportUrl} className="rounded-lg bg-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-600">导入</button>
        <button onClick={doExport} className="rounded-lg bg-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-600">导出</button>
        <span className="text-xs text-neutral-500">共 {rows.length} 个源</span>
        <Link to="/" className="ml-auto text-sm text-neutral-400 hover:text-neutral-200">← 书架</Link>
      </header>
      {msg && (
        <div className="fixed left-1/2 top-3 z-50 -translate-x-1/2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-neutral-900 shadow-lg">
          {msg}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-[minmax(0,5fr)_9rem_minmax(0,6fr)]">
        {/* 左：源下拉 + 编辑表单（吸附，独立滚动） */}
        <div className="space-y-3 md:sticky md:top-4 md:max-h-[calc(100dvh-2rem)] md:overflow-y-auto md:pr-1">
          <select
            className="w-full rounded-lg bg-neutral-800 px-3 py-2 text-sm"
            value={editId ?? (srcType === "script" ? "new-script" : "")}
            onChange={(e) =>
              selectSource(e.target.value === "" ? null : e.target.value === "new-script" ? "new-script" : Number(e.target.value))
            }
          >
            <option value="">＋ 新建源（规则）</option>
            <option value="new-script">＋ 新建脚本源（表单方法）</option>
            {shown.map((r) => (
              <option key={r.id} value={r.id}>
                {r.type === "script" ? "⚙ " : ""}
                {r.name}（{r.enabled ? "启用" : "停用"}）
              </option>
            ))}
          </select>
          {srcType === "script" ? (
            <>
              <div className="rounded-xl bg-neutral-800 p-3 text-xs leading-5 text-neutral-400">
                脚本源按表单编辑：每个方法留空即未实现；保存时把各方法合并拼接成 class 脚本文件供程序执行（右侧「生成的 JS」只读预览）。
              </div>
              <fieldset className="rounded-xl bg-neutral-800 p-4">
                <legend className="px-1 text-sm font-bold text-amber-400">基本</legend>
                <div className="space-y-2">
                  <label className="block">
                    <span className="mb-0.5 block text-xs text-neutral-400">源名称（必填）</span>
                    <input
                      className={inpMono}
                      placeholder="示例脚本源"
                      value={scriptForm.name}
                      onChange={(e) => {
                        const v = e.target.value;
                        setScriptForm((f) => ({ ...f, name: v }));
                        setDirty(true);
                      }}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-0.5 block text-xs text-neutral-400">源域名 base（相对地址补全，等价类成员 base）</span>
                    <input
                      className={inpMono}
                      placeholder="https://www.example.com"
                      value={scriptForm.base}
                      onChange={(e) => {
                        const v = e.target.value;
                        setScriptForm((f) => ({ ...f, base: v }));
                        setDirty(true);
                      }}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-0.5 block text-xs text-neutral-400">请求头 headers（JSON 对象，注入每次 fetchText）</span>
                    <textarea
                      rows={3}
                      className={inpMono}
                      placeholder={'{"Cookie":"...","Referer":"https://www.example.com/"}'}
                      value={scriptForm.headersText}
                      onChange={(e) => {
                        const v = e.target.value;
                        setScriptForm((f) => ({ ...f, headersText: v }));
                        setDirty(true);
                      }}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-0.5 block text-xs text-neutral-400">替换净化 replace（每行：正则##替换为，替换为留空=删除）</span>
                    <textarea
                      rows={2}
                      className={inpMono}
                      placeholder={"广告.*?##\n（本章完）##"}
                      value={scriptForm.replaceText}
                      onChange={(e) => {
                        const v = e.target.value;
                        setScriptForm((f) => ({ ...f, replaceText: v }));
                        setDirty(true);
                      }}
                    />
                  </label>
                </div>
              </fieldset>
              <fieldset className="rounded-xl bg-neutral-800 p-4">
                <legend className="px-1 text-sm font-bold text-amber-400">方法（全可选，○ 未实现 ● 已填写）</legend>
                <div className="space-y-2">
                  {METHOD_DEFS.map((m) => (
                    <details key={m.key} className="rounded-lg bg-neutral-900">
                      <summary className="cursor-pointer select-none px-3 py-2 text-xs text-neutral-300">
                        {scriptForm.methods[m.key]?.trim() ? "●" : "○"} {m.label}
                      </summary>
                      <textarea
                        rows={10}
                        spellCheck={false}
                        className="w-full border-t border-neutral-700 bg-neutral-900 p-3 font-mono text-xs leading-5 text-neutral-200 placeholder:text-neutral-600"
                        placeholder={m.tpl}
                        value={scriptForm.methods[m.key] ?? ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          setScriptForm((f) => ({ ...f, methods: { ...f.methods, [m.key]: v } }));
                          setDirty(true);
                        }}
                      />
                    </details>
                  ))}
                  <div className="pt-1 text-xs leading-5 text-neutral-500">
                    可用 API：fetchText(url, opts?) → {"{status, text, url}"}；parse(html) → cheerio $；abs(u, base?) 相对转绝对；log(msg)；
                    nodes(html) / ruleText(ns, 规则) / ruleSel(ns, 规则)（规则语法兼容）。this.base / this.headers / this.replace 为类成员。
                  </div>
                </div>
              </fieldset>
            </>
          ) : (
            SECTIONS.map((sec) => (
            <fieldset key={sec.title} className="rounded-xl bg-neutral-800 p-4">
              <legend className="px-1 text-sm font-bold text-amber-400">{sec.title}</legend>
              <div className="space-y-2">
                {sec.fields.map(({ path, label, ph, rows: rowsN = 1 }) => (
                  <label key={path} className="block">
                    <span className="mb-0.5 block text-xs text-neutral-400">{label}</span>
                    {rowsN > 1 ? (
                      <textarea
                        rows={rowsN}
                        className="w-full rounded-lg bg-neutral-700 px-2 py-1.5 font-mono text-xs placeholder:text-neutral-500"
                        placeholder={ph}
                        value={getIn(form, path) ?? ""}
                        onChange={(e) => setField(path, e.target.value)}
                        onBlur={() => setJsonText(formJson(form))}
                      />
                    ) : (
                      <input
                        className="w-full rounded-lg bg-neutral-700 px-2 py-1.5 font-mono text-xs placeholder:text-neutral-500"
                        placeholder={ph}
                        value={getIn(form, path) ?? ""}
                        onChange={(e) => setField(path, e.target.value)}
                        onBlur={() => setJsonText(formJson(form))}
                      />
                    )}
                  </label>
                ))}
              </div>
            </fieldset>
            ))
          )}
        </div>

        {/* 中：操作列 */}
        <div className="flex flex-row flex-wrap gap-2 md:sticky md:top-4 md:flex-col">
          <button
            onClick={saveSource}
            className={dirty ? `${btnPrimary} ring-2 ring-amber-300/60` : btn}
            title={dirty ? "有未保存的改动" : "无改动"}
          >
            {dirty ? "● 保存源" : "保存源"}
          </button>
          <button onClick={() => selectSource(null)} className={btn}>✗ 清空新建</button>
          <label className="flex items-center gap-2 px-1 text-sm text-neutral-400">
            <input
              type="checkbox"
              checked={srcType === "script" ? scriptForm.enabled : !!form.enabled}
              onChange={toggleEnabled}
              className="accent-amber-500"
              disabled={editId === null}
            />
            启用搜索
          </label>
          <button onClick={del} className="w-full rounded-lg px-3 py-1.5 text-sm text-red-400 hover:bg-red-950">删除此源</button>
        </div>

        {/* 右：JSON / 调试 */}
        <div className="flex flex-col rounded-xl bg-neutral-800 p-3 md:sticky md:top-4 md:max-h-[calc(100dvh-2rem)]">
          <div className="mb-2 flex flex-wrap items-center gap-1">
            {(["json", "js", "debug"] as const).map((t) =>
              (t === "js" && editId === null) || (t === "json" && srcType === "script") ? null : (
                <button
                  key={t}
                  onClick={() => {
                    setRightTab(t);
                    if (t === "js" && editId !== null)
                      api<{ code: string; generated: boolean }>(`/api/sources/${editId}/code`)
                        .then((r) => setScriptCode(r.code))
                        .catch((e) => setMsg(e.message));
                  }}
                  className={`rounded-lg px-3 py-1.5 text-sm ${rightTab === t ? "bg-amber-500 font-medium text-neutral-900" : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"}`}
                >
                  {t === "json" ? "JSON" : t === "js" ? "生成的 JS" : "调试"}
                </button>
              ),
            )}
          </div>
          {rightTab === "json" ? (
            <textarea
              className="h-96 w-full flex-1 rounded-lg bg-neutral-900 p-3 font-mono text-xs leading-5 md:h-auto"
              placeholder="表单→JSON 生成；或粘贴 JSON 后失焦自动同步到表单"
              value={jsonText}
              onChange={(e) => {
                setJsonText(e.target.value);
                setDirty(true);
              }}
              onBlur={() => syncJsonToForm()}
            />
          ) : rightTab === "js" ? (
            <pre className="h-96 w-full flex-1 overflow-auto rounded-lg bg-neutral-900 p-3 font-mono text-xs leading-5 whitespace-pre text-neutral-300 md:h-auto">
              {scriptCode}
            </pre>
          ) : (
            <div className="flex flex-1 flex-col gap-2 overflow-hidden">
              {/* 子模式切换 + 输入 */}
              <div className="flex flex-wrap items-center gap-1">
                {(["search", "book"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setDbgMode(m)}
                    className={`rounded-lg px-3 py-1 text-xs ${dbgMode === m ? "bg-neutral-600 font-medium text-neutral-100" : "bg-neutral-700 text-neutral-400 hover:bg-neutral-600"}`}
                  >
                    {m === "search" ? "调搜索" : "调书籍"}
                  </button>
                ))}
                {dbgMode === "search" ? (
                  <>
                    <input
                      className="ml-auto w-36 rounded-lg bg-neutral-700 px-2 py-1 text-xs"
                      placeholder="搜索关键词"
                      value={debugKey}
                      onChange={(e) => setDebugKey(e.target.value)}
                    />
                    <button onClick={runDebugSearch} disabled={debugging} className="rounded-lg bg-amber-500 px-3 py-1 text-xs font-medium text-neutral-900 disabled:opacity-50">
                      运行
                    </button>
                  </>
                ) : (
                  <>
                    <input
                      className="ml-auto w-56 flex-1 rounded-lg bg-neutral-700 px-2 py-1 font-mono text-xs"
                      placeholder="书籍详情页 URL"
                      value={debugBookUrl}
                      onChange={(e) => setDebugBookUrl(e.target.value)}
                    />
                    <button onClick={runDebugBook} disabled={debugging} className="rounded-lg bg-amber-500 px-3 py-1 text-xs font-medium text-neutral-900 disabled:opacity-50">
                      运行
                    </button>
                  </>
                )}
              </div>
              {/* 调搜索：结果列表 */}
              {dbgMode === "search" && (
                <div className="flex-1 overflow-y-auto rounded-lg bg-neutral-900 p-2">
                  {searchResults.map((b, i) => (
                    <div key={i} className="mb-2 rounded-lg bg-neutral-800 p-2 text-xs">
                      <div className="flex items-center gap-2">
                        {b.cover && <img src={b.cover} alt="" className="h-12 w-9 flex-none rounded object-cover" onError={(e) => (e.currentTarget.style.display = "none")} />}
                        <div className="min-w-0">
                          <div className="truncate font-medium text-neutral-100">{b.name}</div>
                          <div className="truncate text-neutral-400">
                            {b.author || "佚名"}
                            {b.latestChapter && ` · ${b.latestChapter}`}
                          </div>
                        </div>
                      </div>
                      {b.intro && <div className="mt-1 line-clamp-2 text-neutral-500">{b.intro}</div>}
                      <button
                        onClick={() => {
                          setDebugBookUrl(b.bookUrl);
                          setDbgMode("book");
                          setRightTab("debug");
                          setLogs([]);
                          setMsg(`已填入调书籍：${b.name}`);
                        }}
                        className="mt-1 max-w-full truncate rounded bg-neutral-700 px-1.5 py-0.5 text-left font-mono text-[11px] text-sky-400 hover:bg-neutral-600 hover:text-sky-300"
                        title="点击填入「调书籍」继续测试"
                      >
                        {b.bookUrl}
                      </button>
                    </div>
                  ))}
                  {!searchResults.length && <div className="p-2 text-neutral-600">输入关键词点运行，结果里的书籍 URL 可点击，直接填入「调书籍」继续测试</div>}
                  {logs.map((l, i) => (
                    <div key={`lg${i}`} className={levelColor[l.level]}>
                      <span className="text-neutral-600">[{l.step}]</span> {l.msg}
                    </div>
                  ))}
                </div>
              )}
              {/* 调书籍：SSE 日志 */}
              {dbgMode === "book" && (
                <>
                  <div ref={logBox} className="h-96 flex-1 overflow-y-auto rounded-lg bg-neutral-900 p-3 font-mono text-xs leading-5 md:h-auto">
                    {logs.map((l, i) => (
                      <div key={i} className={levelColor[l.level]}>
                        <span className="text-neutral-600">[{l.step}]</span> {l.msg}
                      </div>
                    ))}
                    {!logs.length && <div className="text-neutral-600">粘贴书籍详情页 URL 点运行：详情 → 目录 → 首章正文</div>}
                  </div>
                  {dbgBook && !debugging && (
                    <button
                      onClick={addBookFromDebug}
                      disabled={addingBook}
                      className="w-full rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-amber-400 disabled:opacity-50"
                    >
                      {addingBook ? "加入中…" : `＋ 加入书架《${dbgBook.name}》`}
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
