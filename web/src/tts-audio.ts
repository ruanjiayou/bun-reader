// iOS 音频会话（AVAudioSession category）适配
//
// 症状：iOS 上升级系统后朗读突然没声音，插耳机却正常。
// 原因不是引擎坏了，而是 Web Speech 合成在 iOS 上走「环境音（ambient）」类别的音频会话：
// 侧边静音开关一拨到静音，外放直接哑掉；耳机不走这条路由，所以照样有声。
// 对比一下就明白：静音开关打开时看视频/听音乐仍有声，因为 <audio>/<video> 播放会把会话
// 抬到 playback 类别，静音开关管不到它。
//
// 所以朗读期间把会话顶到 playback，两手段叠加：
//   1) navigator.audioSession.type = "playback"（Safari 16.4+ / iOS 17+ 的 Web Audio Session API，首选）
//   2) 挂一条静音音轨循环播放——媒体播放本身就会抬会话，给没有 audioSession API 的老系统兜底
// 只在 iOS 上启用；桌面端不创建多余音频元素。

type AudioSessionLike = { type: string };

const isIOS = () =>
  typeof navigator !== "undefined" &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

// 8kHz / 8bit 单声道静音 WAV（PCM 静音值 128），运行时拼，避免往仓库塞 base64 大块
const silentWav = (sec = 1) => {
  const rate = 8000;
  const n = rate * sec;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const tag = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  tag(0, "RIFF");
  v.setUint32(4, 36 + n, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // 单声道
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true); // 8bit
  tag(36, "data");
  v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128);
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(bin)}`;
};

let el: HTMLAudioElement | null = null;
let prevType: string | null = null;

const session = (): AudioSessionLike | null =>
  (navigator as unknown as { audioSession?: AudioSessionLike }).audioSession ?? null;

// 朗读开始前调用：必须在用户手势的调用栈里（iOS 不放行无手势的首次播放）
export const holdAudioSession = () => {
  if (!isIOS()) return;
  const s = session();
  if (s) {
    if (prevType === null) prevType = s.type;
    s.type = "playback"; // 静音开关不再影响输出
  }
  if (!el) {
    el = new Audio(silentWav());
    el.loop = true;
    el.preload = "auto";
    el.setAttribute("playsinline", "");
  }
  // 音轨本身静音，volume 保持 1：WebKit 可能把 volume=0 的媒体当成「没在播」，会话就不抬了
  el.play().catch(() => {});
};

// 停止朗读 / 离开阅读器时调用：释放音频焦点，别占着会话挡掉别的 App
export const releaseAudioSession = () => {
  if (!isIOS()) return;
  if (el) {
    el.pause();
    try {
      el.currentTime = 0;
    } catch {}
  }
  const s = session();
  if (s && prevType !== null) {
    s.type = prevType;
    prevType = null;
  }
};
