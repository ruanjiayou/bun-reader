import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";

interface FromSource {
  sourceId: number;
  sourceName: string;
  bookUrl: string;
}
interface PreviewData {
  name: string;
  author: string;
  cover: string;
  intro: string;
  latestChapter: string;
  chapterCount: number;
  tocPreview: { idx: number; title: string }[];
}

// 搜索结果 → 详情预览：不落库，可切换来源，确认后加入书架
export default function Preview() {
  const [sp] = useSearchParams();
  const loc = useLocation();
  const nav = useNavigate();
  // 搜索卡片传来的即时信息与来源列表（state），接口返回后覆盖
  const hint = (loc.state ?? {}) as Partial<PreviewData> & { from?: FromSource[] };
  const fromList = hint.from ?? [];

  const [sid, setSid] = useState(Number(sp.get("sourceId")) || fromList[0]?.sourceId || 0);
  const [url, setUrl] = useState(sp.get("bookUrl") || fromList[0]?.bookUrl || "");
  const [data, setData] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState("");

  const load = async (sourceId: number, bookUrl: string) => {
    if (!sourceId || !bookUrl) return;
    setLoading(true);
    setErr("");
    try {
      const d = await api<PreviewData>(`/api/books/preview?sourceId=${sourceId}&bookUrl=${encodeURIComponent(bookUrl)}`);
      setData(d);
      // 记住这次切换，刷新/回退时保留
      nav(`/preview?sourceId=${sourceId}&bookUrl=${encodeURIComponent(bookUrl)}`, { replace: true, state: loc.state });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (sid && url) load(sid, url);
  }, []);

  const cur = data ?? {
    name: hint.name ?? "",
    author: hint.author ?? "",
    cover: hint.cover ?? "",
    intro: hint.intro ?? "",
    latestChapter: hint.latestChapter ?? "",
    chapterCount: 0,
    tocPreview: [],
  };

  const addToShelf = async () => {
    setAdding(true);
    try {
      const r = await api<{ id: number }>("/api/books", { method: "POST", body: JSON.stringify({ bookUrl: url, sourceId: sid }) });
      nav(`/book/${r.id}`);
    } catch (e: any) {
      setMsg(`加书架失败：${e.message}`);
      setAdding(false);
    }
  };

  return (
    <div className="mx-auto min-h-dvh max-w-3xl p-4">
      <header className="mb-4 flex items-center gap-2">
        <Link to="/search" className="text-sm text-neutral-400 hover:text-neutral-200">← 搜索</Link>
        {msg && <span className="text-sm text-red-400">{msg}</span>}
      </header>

      <div className="mb-4 flex gap-4 rounded-xl bg-neutral-800 p-4">
        {cur.cover ? (
          <img src={cur.cover} alt="" className="h-32 w-24 flex-none rounded-lg object-cover" onError={(e) => (e.currentTarget.style.display = "none")} />
        ) : (
          <div className="flex h-32 w-24 flex-none items-center justify-center rounded-lg bg-neutral-700 text-3xl">📕</div>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-bold">{cur.name || (loading ? "加载中…" : "未知书名")}</h1>
          <div className="mt-0.5 text-sm text-neutral-400">{cur.author || "佚名"}</div>
          {cur.latestChapter && <div className="mt-0.5 truncate text-xs text-neutral-500">最新：{cur.latestChapter}</div>}
          {cur.intro && <p className="mt-2 line-clamp-4 text-xs text-neutral-500">{cur.intro}</p>}
          <div className="mt-3 flex gap-2">
            <button
              onClick={addToShelf}
              disabled={adding || loading || !!err}
              className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-amber-400 disabled:opacity-50"
            >
              {adding ? "加入中…" : "＋ 加入书架"}
            </button>
          </div>
        </div>
      </div>

      {fromList.length > 0 && (
        <div className="mb-4">
          <div className="mb-1.5 text-xs text-neutral-500">切换来源（{fromList.length} 个）</div>
          <div className="flex flex-wrap gap-1">
            {fromList.map((f, i) => (
              <button
                key={i}
                onClick={() => {
                  setSid(f.sourceId);
                  setUrl(f.bookUrl);
                  load(f.sourceId, f.bookUrl);
                }}
                disabled={loading}
                title={f.bookUrl}
                className={`rounded px-2 py-1 text-xs disabled:opacity-50 ${
                  f.sourceId === sid && f.bookUrl === url ? "bg-amber-500 font-medium text-neutral-900" : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"
                }`}
              >
                {f.sourceName}
              </button>
            ))}
          </div>
        </div>
      )}

      <section>
        <h2 className="mb-2 text-sm font-bold text-neutral-300">目录{data ? `（共 ${data.chapterCount} 章）` : ""}</h2>
        {err && <div className="rounded-lg bg-red-950 px-3 py-2 text-sm text-red-400">{err}</div>}
        <div className="divide-y divide-neutral-800 rounded-xl bg-neutral-800/50">
          {cur.tocPreview.map((ch) => (
            <div key={ch.idx} className="block truncate px-4 py-2.5 text-sm text-neutral-300">
              {ch.title}
            </div>
          ))}
          {data && data.chapterCount > data.tocPreview.length && (
            <div className="px-4 py-2.5 text-center text-xs text-neutral-500">…加入书架后查看全部 {data.chapterCount} 章</div>
          )}
          {!loading && !err && !cur.tocPreview.length && <div className="p-6 text-center text-neutral-600">{data ? "目录为空" : "目录加载中…"}</div>}
        </div>
      </section>
    </div>
  );
}
