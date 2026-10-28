import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, API_BASE } from "../api";

interface SBook {
  name: string;
  author: string;
  bookUrl: string;
  cover: string;
  intro: string;
  latestChapter: string;
}
interface Group {
  key: string;
  name: string;
  author: string;
  intro: string;
  cover: string;
  latestChapter: string;
  from: { sourceId: number; sourceName: string; bookUrl: string }[];
}
interface SSEvt {
  type: "start" | "books" | "progress" | "source-error" | "end";
  total?: number;
  q?: string;
  sourceId?: number;
  sourceName?: string;
  books?: SBook[];
  done?: number;
  failed?: number;
  error?: string;
}

const norm = (s: string) => s.replace(/[\s（(].*$/, "").trim();

export default function Search() {
  const [q, setQ] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [prog, setProg] = useState<{ done: number; total: number; failed: number } | null>(null);
  const [sourceErrors, setSourceErrors] = useState<{ sourceName: string; error: string }[]>([]);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState("");
  const [adding, setAdding] = useState<string | null>(null); // 正在加书架的 key
  const abortRef = useRef<AbortController | null>(null);
  const nav = useNavigate();

  const run = async () => {
    if (!q.trim() || running) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);
    setGroups([]);
    setProg(null);
    setSourceErrors([]);
    setMsg("");
    try {
      const res = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(q.trim())}`, { signal: ac.signal });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `搜索请求失败 ${res.status}`);
      }
      if (!res.body) throw new Error("搜索响应不支持流式读取");
      const reader = res.body.getReader();
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
          if (!line.startsWith("data: ")) continue;
          const e: SSEvt = JSON.parse(line.slice(6));
          if (e.type === "progress" && e.done != null) setProg({ done: e.done, total: e.total!, failed: e.failed! });
          if (e.type === "source-error")
            setSourceErrors((errors) => [...errors, { sourceName: e.sourceName ?? `书源#${e.sourceId}`, error: e.error ?? "未知错误" }]);
          if (e.type === "books" && e.books?.length) {
            setGroups((g) => {
              const next = [...g];
              for (const b of e.books!) {
                const key = `${norm(b.name)}::${norm(b.author || "")}`;
                let grp = next.find((x) => x.key === key);
                if (!grp) {
                  grp = { key, name: b.name, author: b.author, intro: b.intro, cover: b.cover, latestChapter: b.latestChapter, from: [] };
                  next.push(grp);
                }
                grp.from.push({ sourceId: e.sourceId!, sourceName: e.sourceName!, bookUrl: b.bookUrl });
                if (!grp.cover && b.cover) grp.cover = b.cover;
                if (!grp.intro && b.intro) grp.intro = b.intro;
                if (!grp.latestChapter && b.latestChapter) grp.latestChapter = b.latestChapter;
              }
              return next;
            });
          }
          if (e.type === "end") setMsg(`完成 ${e.done}/${e.total} 个源${e.failed ? `（${e.failed} 个失败）` : ""}`);
        }
      }
    } catch (e: any) {
      if (e.name !== "AbortError") setMsg(e.message);
    } finally {
      setRunning(false);
    }
  };

  const addToShelf = async (g: Group, f: Group["from"][number]) => {
    setAdding(g.key);
    try {
      const r = await api<{ id: number }>("/api/books", { method: "POST", body: JSON.stringify({ bookUrl: f.bookUrl, sourceId: f.sourceId }) });
      setMsg(`《${g.name}》已加入书架`);
      nav(`/book/${r.id}`);
    } catch (e: any) {
      setMsg(`加书架失败：${e.message}`);
    } finally {
      setAdding(null);
    }
  };

  return (
    <div className="mx-auto min-h-dvh max-w-3xl p-4">
      <header className="mb-4 flex items-center gap-2">
        {/* 返回在左侧；输入框 16px（text-base）——iOS 聚焦字号 <16px 的输入框会强制放大页面 */}
        <Link to="/" className="flex-none text-sm text-neutral-400 hover:text-neutral-200">← 书架</Link>
        <div className="relative min-w-0 flex-1">
          <input
            autoFocus
            className="w-full rounded-lg bg-neutral-800 px-3 py-2 pr-9 text-base"
            placeholder="书名 / 作者"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
          />
          {q && (
            <button
              onClick={() => setQ("")}
              title="清空"
              className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full bg-neutral-700 text-xs text-neutral-300 hover:bg-neutral-600"
            >
              ×
            </button>
          )}
        </div>
        <button onClick={run} disabled={running || !q.trim()} className="flex-none rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-50">
          {running ? "搜索中…" : "搜索"}
        </button>
      </header>
      {prog && (
        <div className="mb-3 text-xs text-neutral-500">
          已完成 {prog.done}/{prog.total} 个源{prog.failed ? ` · ${prog.failed} 个失败` : ""}
          {running && <span className="ml-1 animate-pulse">…</span>}
        </div>
      )}
      {!!sourceErrors.length && (
        <details className="mb-3 rounded-lg bg-neutral-800 px-3 py-2 text-sm text-neutral-400">
          <summary className="cursor-pointer">失败书源详情（{sourceErrors.length}）</summary>
          <ul className="mt-2 space-y-1">
            {sourceErrors.map((failure, i) => (
              <li key={`${failure.sourceName}-${i}`}>
                <span className="text-neutral-300">{failure.sourceName}：</span>
                {failure.error}
              </li>
            ))}
          </ul>
        </details>
      )}
      {msg && <div className="mb-3 rounded-lg bg-neutral-800 px-3 py-2 text-sm text-amber-400">{msg}</div>}

      <div className="space-y-2">
        {groups.map((g) => (
          <div
            key={g.key}
            onClick={() =>
              nav(`/preview?sourceId=${g.from[0].sourceId}&bookUrl=${encodeURIComponent(g.from[0].bookUrl)}`, {
                state: { name: g.name, author: g.author, cover: g.cover, intro: g.intro, latestChapter: g.latestChapter, from: g.from },
              })
            }
            className="cursor-pointer rounded-xl bg-neutral-800 p-3 transition-colors hover:bg-neutral-700"
          >
            <div className="flex gap-3">
              {g.cover ? (
                <img src={g.cover} alt="" className="h-20 w-14 flex-none rounded object-cover" onError={(e) => (e.currentTarget.style.display = "none")} />
              ) : (
                <div className="flex h-20 w-14 flex-none items-center justify-center rounded bg-neutral-700 text-xl">📕</div>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{g.name}</div>
                <div className="truncate text-xs text-neutral-400">{g.author || "佚名"}{g.latestChapter && ` · ${g.latestChapter}`}</div>
                {g.intro && <p className="mt-1 line-clamp-2 text-xs text-neutral-500">{g.intro}</p>}
                <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px]">
                  <span className="text-neutral-500">{g.from.length} 个来源：</span>
                  {g.from.map((f, i) => (
                    <button
                      key={i}
                      onClick={(e) => {
                        e.stopPropagation();
                        addToShelf(g, f);
                      }}
                      disabled={adding === g.key}
                      className="rounded bg-neutral-700 px-1.5 py-0.5 text-neutral-300 hover:bg-amber-500 hover:text-neutral-900 disabled:opacity-50"
                      title={`${f.bookUrl}（直接加入书架）`}
                    >
                      {f.sourceName}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ))}
        {!groups.length && !running && <div className="p-8 text-center text-neutral-600">输入关键词搜索所有启用的书源</div>}
      </div>
    </div>
  );
}
