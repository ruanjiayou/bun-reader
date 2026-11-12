import { useEffect, useState } from "react";
import { Routes, Route, useNavigate } from "react-router-dom";
import { api } from "./api";
import { ActiveRedirect, PageLayers } from "./layers";
import Auth from "./pages/Auth";
import Shelf from "./pages/Shelf";
import SourceList from "./pages/SourceList";
import Sources from "./pages/Sources";
import Search from "./pages/Search";
import Explore from "./pages/Explore";
import Preview from "./pages/Preview";
import Book from "./pages/Book";
import Reader from "./pages/Reader";
import Settings from "./pages/Settings";

export interface Me {
  uid: number;
  username: string;
  nickname?: string | null;
  avatar?: string | null;
}

export function useAuth() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = () =>
    api<Me>("/auth/me")
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
  useEffect(() => {
    refresh();
  }, []);
  return { me, loading, refresh };
}

function Guard({ children, me, loading }: any) {
  if (loading) return <div className="p-8 text-center text-neutral-500">加载中…</div>;
  if (me) return children;
  // 隐藏层不重定向：多个 <Navigate> 同时触发会搅乱 history；等它重新变成顶层再跳
  return <ActiveRedirect to="/auth" />;
}

/** 同一份路由表会被 PageLayers 渲染到每一层；各层有独立的 location context 与组件实例 */
function PageRoutes({
  me,
  loading,
  refresh,
  logout,
}: {
  me: Me | null;
  loading: boolean;
  refresh: () => void;
  logout: () => void;
}) {
  return (
    <Routes>
      <Route path="/auth" element={me ? <ActiveRedirect to="/" /> : <Auth onOk={refresh} />} />
      <Route path="/" element={<Guard me={me} loading={loading}><Shelf me={me} onLogout={logout} /></Guard>} />
      <Route path="/settings" element={<Guard me={me} loading={loading}><Settings me={me!} onSaved={refresh} /></Guard>} />
      <Route path="/search" element={<Guard me={me} loading={loading}><Search /></Guard>} />
      <Route path="/explore" element={<Guard me={me} loading={loading}><Explore /></Guard>} />
      <Route path="/preview" element={<Guard me={me} loading={loading}><Preview /></Guard>} />
      <Route path="/book/:id" element={<Guard me={me} loading={loading}><Book /></Guard>} />
      <Route path="/book/:id/category" element={<Guard me={me} loading={loading}><Book /></Guard>} />
      <Route path="/book/:id/read/:idx" element={<Guard me={me} loading={loading}><Reader /></Guard>} />
      {/* 书源：列表页（书架点「书源」进来的落地页）→ 编辑/调试页按 URL 的 id 区分 */}
      <Route path="/sources" element={<Guard me={me} loading={loading}><SourceList /></Guard>} />
      <Route path="/sources/new" element={<Guard me={me} loading={loading}><Sources /></Guard>} />
      <Route path="/sources/:id" element={<Guard me={me} loading={loading}><Sources /></Guard>} />
      <Route path="*" element={<ActiveRedirect to="/" />} />
    </Routes>
  );
}

export default function App() {
  const { me, loading, refresh } = useAuth();
  const nav = useNavigate();
  const logout = async () => {
    await api("/auth/logout", { method: "POST" });
    refresh();
    nav("/auth");
  };
  return (
    <PageLayers>
      <PageRoutes me={me} loading={loading} refresh={refresh} logout={logout} />
    </PageLayers>
  );
}
