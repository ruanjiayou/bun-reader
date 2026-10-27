import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { Me } from "../App";

// 头像压缩：任意图片 → 居中方裁 128×128 JPEG dataURL（省流量省存储，头像够用）
const fileToAvatar = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const S = 128;
      const canvas = document.createElement("canvas");
      canvas.width = S;
      canvas.height = S;
      const ctx = canvas.getContext("2d")!;
      const side = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error("图片读取失败"));
    img.src = URL.createObjectURL(file);
  });

export default function Settings({ me, onSaved }: { me: Me; onSaved: () => void }) {
  const [nickname, setNickname] = useState(me.nickname ?? "");
  const [avatar, setAvatar] = useState(me.avatar ?? "");
  const [savingProfile, setSavingProfile] = useState(false);
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [newPwd2, setNewPwd2] = useState("");
  const [savingPwd, setSavingPwd] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const flash = (m: string) => {
    setMsg(m);
    setErr("");
    setTimeout(() => setMsg(""), 2500);
  };
  const fail = (e: any) => {
    setErr(e.message ?? String(e));
    setMsg("");
  };

  const pickAvatar = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许重复选同一张图
    if (!file) return;
    try {
      setAvatar(await fileToAvatar(file));
    } catch (e: any) {
      fail(e);
    }
  };

  const saveProfile = async () => {
    setSavingProfile(true);
    try {
      await api("/auth/profile", { method: "PUT", body: JSON.stringify({ nickname, avatar }) });
      onSaved(); // 通知 App 刷新 /auth/me，书架页头像立即生效
      flash("资料已保存");
    } catch (e: any) {
      fail(e);
    } finally {
      setSavingProfile(false);
    }
  };

  const savePassword = async () => {
    if (newPwd !== newPwd2) return setErr("两次输入的新密码不一致");
    setSavingPwd(true);
    try {
      await api("/auth/password", { method: "PUT", body: JSON.stringify({ oldPassword: oldPwd, newPassword: newPwd }) });
      setOldPwd("");
      setNewPwd("");
      setNewPwd2("");
      flash("密码已修改");
    } catch (e: any) {
      fail(e);
    } finally {
      setSavingPwd(false);
    }
  };

  return (
    <div className="mx-auto min-h-dvh max-w-md p-4">
      <header className="mb-4 flex items-center">
        <Link to="/" className="text-sm text-neutral-400 hover:text-neutral-200">← 书架</Link>
        <h1 className="flex-1 text-center text-base font-bold">账号设置</h1>
        <span className="w-12" />
      </header>

      {/* 头像：点击圆形换图，选择即本地压缩预览，随「保存资料」一起提交 */}
      <div className="mb-4 flex items-center gap-4 rounded-xl bg-neutral-800 p-4">
        <button
          onClick={() => fileRef.current?.click()}
          className="relative h-16 w-16 flex-none overflow-hidden rounded-full bg-neutral-700"
          title="更换头像"
        >
          {avatar ? (
            <img src={avatar} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="text-2xl text-neutral-400">{(me.nickname || me.username)[0]}</span>
          )}
          <span className="absolute inset-x-0 bottom-0 bg-black/50 py-0.5 text-center text-[10px] text-neutral-200">更换</span>
        </button>
        <div className="min-w-0 flex-1 text-sm">
          <div className="truncate font-medium">{me.nickname || me.username}</div>
          <div className="truncate text-xs text-neutral-500">{me.username}</div>
        </div>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={pickAvatar} />
      </div>

      {/* 昵称 */}
      <div className="mb-4 rounded-xl bg-neutral-800 p-4">
        <label className="mb-1.5 block text-xs text-neutral-400">昵称</label>
        <input
          className="w-full rounded-lg bg-neutral-700 px-3 py-2 text-base outline-none focus:ring-2 focus:ring-amber-500"
          placeholder="留空则显示用户名"
          maxLength={20}
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
        />
      </div>

      {msg && <div className="mb-3 rounded-lg bg-emerald-900/60 px-3 py-2 text-sm text-emerald-300">{msg}</div>}
      {err && <div className="mb-3 rounded-lg bg-red-900/60 px-3 py-2 text-sm text-red-300">{err}</div>}

      <button
        onClick={saveProfile}
        disabled={savingProfile}
        className="mb-6 w-full rounded-lg bg-amber-500 py-2.5 text-sm font-medium text-neutral-900 disabled:opacity-50"
      >
        {savingProfile ? "保存中…" : "保存资料"}
      </button>

      {/* 修改密码 */}
      <div className="mb-4 rounded-xl bg-neutral-800 p-4">
        <h2 className="mb-3 text-sm font-bold">修改密码</h2>
        <div className="space-y-2.5">
          <input
            className="w-full rounded-lg bg-neutral-700 px-3 py-2 text-base outline-none focus:ring-2 focus:ring-amber-500"
            placeholder="旧密码"
            type="password"
            value={oldPwd}
            onChange={(e) => setOldPwd(e.target.value)}
          />
          <input
            className="w-full rounded-lg bg-neutral-700 px-3 py-2 text-base outline-none focus:ring-2 focus:ring-amber-500"
            placeholder="新密码（≥6位）"
            type="password"
            value={newPwd}
            onChange={(e) => setNewPwd(e.target.value)}
          />
          <input
            className="w-full rounded-lg bg-neutral-700 px-3 py-2 text-base outline-none focus:ring-2 focus:ring-amber-500"
            placeholder="确认新密码"
            type="password"
            value={newPwd2}
            onChange={(e) => setNewPwd2(e.target.value)}
          />
        </div>
        <button
          onClick={savePassword}
          disabled={savingPwd || !oldPwd || !newPwd}
          className="mt-3 w-full rounded-lg bg-neutral-700 py-2.5 text-sm text-neutral-200 hover:bg-neutral-600 disabled:opacity-50"
        >
          {savingPwd ? "提交中…" : "修改密码"}
        </button>
      </div>
    </div>
  );
}
