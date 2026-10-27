import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import type { Me } from "../App";

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

// 头像圆钮：有头像显示图，没有显示昵称/用户名首字（类名写死，Tailwind 不编译动态拼接类）
const Avatar = ({ me }: { me: Me }) => (
  <span className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-neutral-700 text-xs text-neutral-200">
    {me.avatar ? <img src={me.avatar} alt="" className="h-full w-full object-cover" /> : (me.nickname || me.username)[0]}
  </span>
);

export default function Shelf({ me, onLogout }: { me: Me | null; onLogout: () => void }) {
  const [rows, setRows] = useState<ShelfBook[]>([]);
  const [loading, setLoading] = useState(true); // 书架列表加载中（避免「空书架」误显）
  const [msg, setMsg] = useState("");
  const [tab, setTab] = useState<SortTab>("read"); // 默认按上次阅读时间
  const [menuOpen, setMenuOpen] = useState(false); // 头像下拉
  const nav = useNavigate();

  const load = () =>
    api<ShelfBook[]>("/api/books")
      .then(setRows)
      .catch((e) => setMsg(e.message))
      .finally(() => setLoading(false));
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

  // 移出书架（右键 / 长按共用）；长按后要吞掉随之而来的 click，避免又跳详情页
  const removeBook = async (b: ShelfBook) => {
    if (!confirm(`把《${b.name}》移出书架？`)) return;
    await api(`/api/books/${b.id}`, { method: "DELETE" });
    load();
  };
  const longPressRef = useRef(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTouchStart = (b: ShelfBook) => () => {
    longPressRef.current = false;
    pressTimer.current = setTimeout(() => {
      longPressRef.current = true;
      removeBook(b);
    }, 500);
  };
  const clearPress = () => () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  return (
    <div className="mx-auto min-h-dvh max-w-5xl p-4">
      <header className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-bold">书架</h1>
        <div className="flex items-center gap-3 text-sm text-neutral-400">
          <Link to="/search" className="hover:text-neutral-200">搜索</Link>
          <Link to="/sources" className="hover:text-neutral-200">书源</Link>
          {/* 未登录：登录按钮；已登录：头像 + 下拉（昵称/设置/退出）。下拉打开时盖一层全屏透明层接收点外关闭 */}
          {!me ? (
            <Link to="/auth" className="rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-medium text-neutral-900">登录</Link>
          ) : (
            <div className="relative">
              <button onClick={() => setMenuOpen((v) => !v)} className="flex items-center gap-1.5" title="账号菜单">
                <Avatar me={me} />
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                  <div className="absolute right-0 z-50 mt-2 w-44 overflow-hidden rounded-xl bg-neutral-800 py-1 shadow-xl ring-1 ring-neutral-700">
                    <div className="truncate px-3 py-2 text-sm text-neutral-300">{me.nickname || me.username}</div>
                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        nav("/settings");
                      }}
                      className="block w-full px-3 py-2 text-left text-sm text-neutral-300 hover:bg-neutral-700"
                    >
                      设置
                    </button>
                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        onLogout();
                      }}
                      className="block w-full px-3 py-2 text-left text-sm text-red-400 hover:bg-neutral-700"
                    >
                      退出登录
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
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

      {loading ? (
        // 加载中状态：请求没回来前不能显示「空书架」
        <div className="flex h-64 items-center justify-center text-sm text-neutral-500">
          <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-neutral-600 border-t-amber-500" />
          书架加载中…
        </div>
      ) : list.length ? (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
          {list.map((b) => {
            const finished = b.progress && b.progress.chapterIdx >= b.chapterCount - 1;
            const reading = b.progress && !finished;
            return (
              <div
                key={b.id}
                className="group relative cursor-pointer"
                onClick={() => {
                  if (longPressRef.current) return; // 长按触发的移出后，吞掉本次 click
                  nav(`/book/${b.id}`);
                }}
                onContextMenu={async (e) => {
                  e.preventDefault();
                  await removeBook(b);
                }}
                onTouchStart={onTouchStart(b)}
                onTouchEnd={clearPress()}
                onTouchMove={clearPress()}
                onTouchCancel={clearPress()}
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
      <p className="mt-4 text-center text-xs text-neutral-600">提示：右键（手机长按）书籍可移出书架</p>
    </div>
  );
}
