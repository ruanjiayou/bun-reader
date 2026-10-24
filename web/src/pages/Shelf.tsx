import { Link } from "react-router-dom";

export default function Shelf({ username, onLogout }: { username?: string; onLogout: () => void }) {
  return (
    <div className="min-h-dvh p-4">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-bold">书架</h1>
        <div className="flex items-center gap-3 text-sm text-neutral-400">
          <Link to="/search" className="hover:text-neutral-200">搜索</Link>
          <Link to="/sources" className="hover:text-neutral-200">书源</Link>
          <span>{username}</span>
          <button onClick={onLogout} className="hover:text-neutral-200">退出</button>
        </div>
      </header>
      <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-neutral-700 text-neutral-500">
        书架空空，等 M3 接上搜索就可以加书了
      </div>
    </div>
  );
}
