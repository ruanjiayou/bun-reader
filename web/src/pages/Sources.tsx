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

const levelColor: Record<DebugEvt["level"], string> = {
  info: "text-neutral-400",
  ok: "text-emerald-400",
  warn: "text-amber-400",
  err: "text-red-400",
};

export default function Sources() {
  const [rows, setRows] = useState<SourceRow[]>([]);
  const [filter, setFilter] = useState("");
  const [importText, setImportText] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [msg, setMsg] = useState("");
  const [debugId, setDebugId] = useState<number | null>(null);
  const [debugKey, setDebugKey] = useState("我的");
  const [logs, setLogs] = useState<DebugEvt[]>([]);
  const [debugging, setDebugging] = useState(false);
  const logBox = useRef<HTMLDivElement>(null);

  const load = () => api<SourceRow[]>("/api/sources").then(setRows).catch((e) => setMsg(e.message));
  useEffect(load, []);

  const shown = rows.filter(
    (r) => !filter || r.name.includes(filter) || r.group.includes(filter) || r.bookUrl.includes(filter),
  );

  const doImport = async () => {
    setMsg("");
    try {
      const body = importText ? { text: importText } : importUrl ? { url: importUrl } : null;
      if (!body) return setMsg("粘贴 JSON 或填 URL");
      const file = document.getElementById("import-file") as HTMLInputElement | null;
      const r = await api<{ added: number; updated: number }>("/api/sources/import", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setMsg(`导入完成：新增 ${r.added}，更新 ${r.updated}`);
      setImportText("");
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

  const runDebug = async () => {
    if (!debugId) return;
    setLogs([]);
    setDebugging(true);
    try {
      const res = await fetch(`/api/sources/${debugId}/debug`, {
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

  return (
    <div className="mx-auto min-h-dvh max-w-5xl p-4">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-bold">书源管理（{rows.length}）</h1>
        <Link to="/" className="text-sm text-neutral-400 hover:text-neutral-200">返回书架</Link>
      </header>

      {/* 导入 */}
      <section className="mb-4 space-y-2 rounded-xl bg-neutral-800 p-4">
        <h2 className="text-sm font-medium text-neutral-300">导入书源（Legado JSON，支持数组）</h2>
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-lg bg-neutral-700 px-3 py-1.5 text-sm"
            placeholder="书源 JSON 的 URL（批量导入）"
            value={importUrl}
            onChange={(e) => setImportUrl(e.target.value)}
          />
          <input id="import-file" type="file" accept=".json,.txt" className="text-sm text-neutral-400"
            onChange={async (e) => setImportText(await e.target.files?.[0]?.text() ?? "")} />
        </div>
        <textarea
          className="h-24 w-full rounded-lg bg-neutral-700 px-3 py-2 font-mono text-xs"
          placeholder='或直接粘贴书源 JSON…'
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
        />
        <div className="flex items-center gap-3">
          <button onClick={doImport} className="rounded-lg bg-amber-500 px-4 py-1.5 text-sm font-medium text-neutral-900">
            导入
          </button>
          {msg && <span className="text-sm text-neutral-400">{msg}</span>}
        </div>
      </section>

      <input
        className="mb-3 w-full rounded-lg bg-neutral-800 px-3 py-1.5 text-sm"
        placeholder="筛选：名称 / 分组 / URL"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      {/* 列表 + 调试 */}
      <div className={`grid gap-4 ${debugId ? "md:grid-cols-2" : ""}`}>
        <ul className="space-y-1">
          {shown.map((r) => (
            <li
              key={r.id}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${debugId === r.id ? "bg-neutral-700" : "bg-neutral-800"}`}
            >
              <input type="checkbox" checked={r.enabled} onChange={() => toggle(r)} className="accent-amber-500" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{r.name}</div>
                <div className="truncate text-xs text-neutral-500">{r.group} · {r.bookUrl}</div>
              </div>
              <button onClick={() => setDebugId(debugId === r.id ? null : r.id)}
                className="rounded bg-neutral-600 px-2 py-0.5 text-xs hover:bg-neutral-500">
                调试
              </button>
              <button onClick={() => del(r)} className="text-xs text-red-400 hover:text-red-300">删除</button>
            </li>
          ))}
          {!shown.length && <li className="py-8 text-center text-neutral-500">暂无书源，先导入</li>}
        </ul>

        {debugId && (
          <section className="flex h-fit flex-col rounded-xl bg-neutral-800 p-4">
            <h2 className="mb-2 text-sm font-medium text-neutral-300">
              调试 · 源 #{debugId}
              <button onClick={() => setDebugId(null)} className="ml-2 text-xs text-neutral-500 hover:text-neutral-300">收起</button>
            </h2>
            <div className="mb-2 flex gap-2">
              <input className="flex-1 rounded-lg bg-neutral-700 px-3 py-1.5 text-sm" placeholder="搜索关键词"
                value={debugKey} onChange={(e) => setDebugKey(e.target.value)} />
              <button onClick={runDebug} disabled={debugging}
                className="rounded-lg bg-amber-500 px-4 py-1.5 text-sm font-medium text-neutral-900 disabled:opacity-50">
                {debugging ? "运行中…" : "运行"}
              </button>
            </div>
            <div ref={logBox} className="h-72 overflow-y-auto rounded-lg bg-neutral-900 p-3 font-mono text-xs leading-5">
              {logs.map((l, i) => (
                <div key={i} className={levelColor[l.level]}>
                  <span className="text-neutral-600">[{l.step}]</span> {l.msg}
                </div>
              ))}
              {!logs.length && <div className="text-neutral-600">点「运行」开始调试，日志实时滚动</div>}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
