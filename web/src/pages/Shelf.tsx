import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";

interface ShelfBook {
  id: number;
  name: string;
  author: string;
  cover: string;
  latestChapter: string;
  chapterCount: number;
  createdAt?: string;
  lastCheckAt?: string | null;
  updatedAt?: string | null; // 书籍内容更新时间（检查更新发现新章节 / 首次建目录）
  progress: { chapterIdx: number; updatedAt?: string } | null; // updatedAt = 上次阅读时间
}

type SortTab = "read" | "update";

const ts = (s?: string | null) => (s ? new Date(s).getTime() || 0 : 0);
const fmtDate = (s?: string | null) => {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

export default function Shelf({ username, onLogout }: { username?: string; onLogout: () => void }) {
  const [rows, setRows] = useState<ShelfBook[]>([]);
  const [msg, setMsg] = useState("");
  const [tab, setTab] = useState<SortTab>("read"); // 默认按上次阅读时间
  const nav = useNavigate();

  const load = () => api<ShelfBook[]>("/api/books").then(setRows).catch((e) => setMsg(e.message));
  useEffect(() => {
    load();
  }, []);

  // 最近阅读：按进度更新时间降序（没读过的排在后面，按加入时间）；最近更新：按书籍内容更新时间降序
  const list = useMemo(() => {
    const arr = [...rows];
    if (tab === "read") {
      arr.sort((a, b) => ts(b.progress?.updatedAt) - ts(a.progress?.updatedAt) || ts(b.createdAt) - ts(a.createdAt));
    } else {
      arr.sort(
        (a, b) =>
          ts(b.updatedAt) - ts(a.updatedAt) || ts(b.lastCheckAt) - ts(a.lastCheckAt) || ts(b.createdAt) - ts(a.createdAt),
      );
    }
    return arr;
  }, [rows, tab]);

  return (
    <div className="mx-auto min-h-dvh max-w-5xl p-4">
      <header className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-bold">书架</h1>
        <div className="flex items-center gap-3 text-sm text-neutral-400">
          <Link to="/search" className="hover:text-neutral-200">搜索</Link>
          <Link to="/sources" className="hover:text-neutral-200">书源</Link>
          <span>{username}</span>
          <button onClick={onLogout} className="hover:text-neutral-200">退出</button>
        </div>
      </header>

      {/* 排序 tab：最近阅读（默认）/ 最近更新 */}
      <div className="mb-3 flex items-center gap-1 rounded-lg bg-neutral-800/60 p-1 text-xs w-fit">
        {(
          [
            { id: "read", label: "最近阅读" },
            { id: "update", label: "最近更新" },
          ] as { id: SortTab; label: string }[]
        ).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-md px-3 py-1 transition-colors ${
              tab === t.id ? "bg-neutral-700 font-medium text-amber-400" : "text-neutral-400 hover:text-neutral-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {msg && <div className="mb-3 rounded-lg bg-neutral-800 px-3 py-2 text-sm text-amber-400">{msg}</div>}

      {list.length ? (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
          {list.map((b) => {
            const finished = b.progress && b.progress.chapterIdx >= b.chapterCount - 1;
            const reading = b.progress && !finished;
            return (
              <div
                key={b.id}
                className="group relative cursor-pointer"
                onClick={() => nav(`/book/${b.id}`)}
                onContextMenu={async (e) => {
                  e.preventDefault();
                  if (confirm(`把《${b.name}》移出书架？`)) {
                    await api(`/api/books/${b.id}`, { method: "DELETE" });
                    load();
                  }
                }}
              >
                <div className="relative">
                  {b.cover ? (
                    <img src={b.cover} alt="" className="aspect-[3/4] w-full rounded-lg object-cover" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
                  ) : (
                    <div className="flex aspect-[3/4] w-full items-center justify-center rounded-lg bg-neutral-800 text-3xl">📕</div>
                  )}
                  {reading && (
                    <span className="absolute right-1 top-1 rounded bg-amber-500 px-1 text-[10px] font-medium text-neutral-900">
                      {Math.round((b.progress!.chapterIdx / Math.max(1, b.chapterCount)) * 100)}%
                    </span>
                  )}
                </div>
                <div className="mt-1 truncate text-xs font-medium text-neutral-200">{b.name}</div>
                <div className="truncate text-[11px] text-neutral-500">
                  {tab === "update"
                    ? b.updatedAt
                      ? `${fmtDate(b.updatedAt)} 更新`
                      : b.chapterCount
                        ? `${b.chapterCount} 章`
                        : ""
                    : reading
                      ? `读到 ${b.progress!.chapterIdx + 1}/${b.chapterCount}`
                      : b.chapterCount
                        ? `${b.chapterCount} 章`
                        : ""}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-neutral-700 text-neutral-500">
          书架空空，去 <Link to="/search" className="mx-1 text-amber-400">搜索</Link> 加书吧
        </div>
      )}
      <p className="mt-4 text-center text-xs text-neutral-600">提示：右键书籍可移出书架</p>
    </div>
  );
}
