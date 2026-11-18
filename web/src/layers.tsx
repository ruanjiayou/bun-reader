import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Link, Navigate, UNSAFE_LocationContext, useLocation, useNavigate, useNavigationType, type Location } from "react-router-dom";

/**
 * 页面层栈：一次 PUSH 生成一层，层里的页面组件始终挂载，返回时只是把顶层换成下面那层，
 * 因此列表数据、筛选状态、滚动位置都不用重新加载。刷新后层栈丢失，只按当前 URL 渲染一层。
 *
 * 层与浏览器历史条目一一对应：loc.key 就是 history.state.key。REPLACE 只改当前层的 loc/key
 * 而不换 id（阅读器跳章、预览入库跳详情要保持组件实例），POP 用 key 找回原层（浏览器前进
 * 也能秒回）。找不到 key 说明是刷新前的旧历史条目，降级为单层重建。
 *
 * 转场动画：层栈天然知道「从哪层到哪层」以及前进/后退方向，用 WAAPI 只动画 transform /
 * box-shadow；动画结束立即 cancel，层容器回到「无 transform」的静止态，避免固定定位的
 * 阅读器与编辑弹层长期换掉包含块。动画期间才把离开的层显示出来并盖一层触摸遮罩。
 */

interface Layer {
  id: string;
  key: string;
  loc: Location;
  type: string;
}

/** 一次转场：fromId 是离开的层，toId 是到达的层；forward = 进入（右→左），否则返回（左→右） */
interface Transition {
  fromId: string;
  toId: string;
  forward: boolean;
}

type Stack = { layers: Layer[]; activeId: string; transition: Transition | null };

// 常量对象：避免 Provider 每次渲染都传新值，导致所有层白重渲染
const ACTIVE_CTX = { active: true };
const HIDDEN_CTX = { active: false };
const LayerContext = createContext(ACTIVE_CTX);

/** 当前层是否可见（顶层）。页面可据此暂停朗读、定时器等不应在后台继续的副作用 */
export const useLayerActive = () => useContext(LayerContext).active;

/**
 * 只在顶层生效的重定向。隐藏层若也渲染 <Navigate>，多个层会同时改 history，
 * 把前进/后退搅乱；Guard 与 * fallback 必须用它。
 */
export function ActiveRedirect({ to, replace = true }: { to: string; replace?: boolean }) {
  const active = useLayerActive();
  return active ? <Navigate to={to} replace={replace} /> : null;
}

/**
 * 「返回到某个页面」必须走 POP：写成 <Link to="/"> 是 PUSH，层栈会当成「进入」，
 * 于是返回时也播放右→左动画、还往栈里堆一层并丢掉原页的保活状态。
 * backTo 按目标 pathname 在栈里找最近的那一层，用 navigate(delta) 一次退回去；
 * 找不到（刷新后只有一层、外部链接直达）则 replace 到目标，不算转场。
 * 不传目标时只退一层（回到来源页）：详情页从探索/搜索/书源调试进来，返回就该回那一页，
 * 而不是按「← 书架」的字面跳过它们直奔书架 —— 那种跨层只留给语义明确的「书架」按钮。
 */
const BackContext = createContext<(to?: string) => void>(() => {});
export const useBackTo = () => useContext(BackContext);

/** 外观与 <Link> 一致，普通左键走层栈回退；修饰键 / target=_blank 仍由 Link 自己处理 */
export function BackLink({ to, onClick, target, ...rest }: ComponentProps<typeof Link>) {
  const backTo = useBackTo();
  return (
    <Link
      {...rest}
      to={to}
      target={target}
      onClick={(e) => {
        onClick?.(e);
        if (
          e.defaultPrevented || e.button !== 0 || target ||
          e.metaKey || e.altKey || e.ctrlKey || e.shiftKey
        ) return;
        e.preventDefault();
        backTo(typeof to === "string" ? to : to.pathname ?? "/");
      }}
    />
  );
}

const ANIM_MS = 320;
// 原生 push 更接近「匀速滑入、两端略缓」。试过 .32,.72,0,1（抽屉曲线）：一半时间就走完
// 95% 距离，全屏页面看着像瞬间弹到位；.4,0,.2,1 的位移分布均匀得多
const ANIM_EASE = "cubic-bezier(.4,0,.2,1)";

/** 纯函数：按 history 事件算出下一份栈与这次该放的转场（REPLACE / 降级不打动画） */
function nextStack(
  prev: Stack,
  location: Location,
  navType: string,
  make: (loc: Location, type: string) => Layer,
): Stack {
  const fromId = prev.activeId;
  const fromIdx = prev.layers.findIndex((l) => l.id === fromId);
  if (navType === "REPLACE") {
    return {
      ...prev,
      transition: null,
      layers: prev.layers.map((l) =>
        l.id === fromId ? { ...l, loc: location, key: location.key, type: navType } : l,
      ),
    };
  }
  if (navType === "PUSH") {
    // 浏览器在中间位置 PUSH 会丢弃 forward history，层栈同样截断后续层
    const l = make(location, navType);
    return {
      layers: [...prev.layers.slice(0, fromIdx + 1), l],
      activeId: l.id,
      transition: { fromId, toId: l.id, forward: true },
    };
  }
  // POP（返回 / 前进）：保留后续层，只把 activeId 指回目标层；找不到就降级为单层
  const found = prev.layers.find((l) => l.key === location.key);
  if (found) {
    const toIdx = prev.layers.findIndex((l) => l.id === found.id);
    return {
      layers: prev.layers.map((l) => (l.id === found.id ? { ...l, loc: location, type: navType } : l)),
      activeId: found.id,
      // 目标层在栈里位于当前层之后 = 浏览器「前进」，视觉上仍按进入方向播放
      transition: found.id === fromId ? null : { fromId, toId: found.id, forward: toIdx > fromIdx },
    };
  }
  const l = make(location, navType);
  return { layers: [l], activeId: l.id, transition: null };
}

function LayerView({
  layer,
  active,
  register,
  children,
}: {
  layer: Layer;
  active: boolean;
  register: (id: string, el: HTMLDivElement | null) => void;
  children: ReactNode;
}) {
  // 每层覆盖成自己那次的 location：否则隐藏层的 useLocation/useSearchParams 会读到当前顶层 URL。
  // <Routes> 不带 location prop，直接读这个 context，basename 行为与单层时完全一致。
  // UNSAFE_LocationContext 是 react-router 内部 API（当前锁 7.6.x），升级大版本要复查。
  const locCtx = useMemo(
    () => ({ location: layer.loc, navigationType: layer.type }),
    [layer.loc, layer.type],
  );
  const ref = useCallback((el: HTMLDivElement | null) => register(layer.id, el), [register, layer.id]);
  return (
    <LayerContext.Provider value={active ? ACTIVE_CTX : HIDDEN_CTX}>
      <UNSAFE_LocationContext.Provider value={locCtx as any}>
        {/*
          刻意不用 display:none：那会丢掉 scrollTop 并触发重排。visibility + inert 保留布局尺寸，
          每层独立滚动容器让「返回到原来的位置」天然成立；静止态不加 transform/contain，
          否则 fixed inset-0 的阅读器与编辑弹层包含块会变（动画期间短暂有 transform 是可接受的）。
          层容器必须自带不透明底色（bg-neutral-900，与 body 一致）：转场时两层同时可见，
          容器透明会让上下层文字直接叠在一起。阅读器有自己的主题底色，会自己铺满盖住它。
        */}
        <div
          ref={ref}
          className="absolute inset-0 overflow-x-hidden overflow-y-auto bg-neutral-900"
          data-layer-id={layer.id}
          data-active={active ? "1" : "0"}
          style={{
            visibility: active ? "visible" : "hidden",
            pointerEvents: active ? "auto" : "none",
            zIndex: active ? 1 : 0,
          }}
          inert={!active}
          aria-hidden={!active}
        >
          {children}
        </div>
      </UNSAFE_LocationContext.Provider>
    </LayerContext.Provider>
  );
}

export function PageLayers({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navType = useNavigationType();
  const navigate = useNavigate();
  const seq = useRef(0);
  const make = useCallback(
    (loc: Location, type: string): Layer => ({ id: `L${++seq.current}`, key: loc.key, loc, type }),
    [],
  );

  // 初始只有当前一层（刷新时 React Router 的 location.key === "default"）
  const [stack, setStack] = useState<Stack>(() => {
    const l = make(location, navType);
    return { layers: [l], activeId: l.id, transition: null };
  });
  // location effect 在同一批更新里可能连续触发（PUSH 后立刻 REPLACE），必须读同步快照
  const stackRef = useRef(stack);
  stackRef.current = stack;

  // 回退用 POP，层栈才能按「返回」方向播放动画并复用目标层（数据/滚动不重载）。
  // navigate(delta) 一次跨多层，浏览器前进仍能逐层回来；栈里没有目标层就 replace 兜底。
  const backTo = useCallback((to?: string) => {
    const s = stackRef.current;
    const idx = s.layers.findIndex((l) => l.id === s.activeId);
    // 不指定目标 = 只退一层，回到用户实际来的那一页（探索/搜索/书源/书架都适用）
    if (!to && idx > 0) {
      navigate(-1);
      return;
    }
    if (to) {
      for (let i = idx - 1; i >= 0; i--) {
        if (s.layers[i].loc.pathname === to) {
          navigate(i - idx);
          return;
        }
      }
    }
    navigate(to ?? "/", { replace: true });
  }, [navigate]);

  const rootRef = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const register = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) nodes.current.set(id, el);
    else nodes.current.delete(id);
  }, []);
  const running = useRef<Animation[]>([]);
  // 最近一场动画的签名：同一对层、同一方向在动画还没播完时重复到达，直接忽略。
  // 这是 key 去重之外的第二道防线（例如两次 popstate 间隔中 navType 被别的更新打断）。
  const lastPlay = useRef<{ sig: string; anims: Animation[] } | null>(null);

  const lastLoc = useRef(location);
  // layout effect：在浏览器绘制前把层栈同步到最新 location，避免新页面出现前闪一帧旧页
  useLayoutEffect(() => {
    if (lastLoc.current === location) return;
    // iOS 独立 PWA 的边缘侧滑偶尔会对**同一个历史条目**连发两次 popstate：
    // React Router 每次都 new 一个 location 对象，引用比较挡不住。第二次 key 相同，
    // nextStack 会把它判成「回到当前层」(transition:null)，从而 cancel 掉第一次
    // 刚开始播的动画 —— 用户看到的就是同一页滑两次 / 滑到一半跳走。
    // 按 key 去重：同一 history entry 的重复 POP 直接丢弃，不碰层栈、不打断动画。
    // history key 是唯一的，只有重复投递才会连着出现两次相同的 key（中间夹别的关键字则不会命中）。
    if (
      navType === "POP" &&
      lastLoc.current.key === location.key &&
      lastLoc.current.pathname === location.pathname &&
      lastLoc.current.search === location.search
    ) return;
    lastLoc.current = location;
    const next = nextStack(stackRef.current, location, navType, make);
    stackRef.current = next;
    setStack(next);
  }, [location, navType, make]);

  // 转场：DOM 已按新栈提交，绘制前应用 backwards fill 的起始关键帧，不会闪一帧终点画面
  useLayoutEffect(() => {
    const t = stack.transition;
    // 第二道防线：同一场转场（同层对 + 同方向）在动画还没结束时被重复提交，
    // 多半是 iOS 侧滑连发 popstate 的残留，绝不能 cancel 掉正在播的动画再来一遍。
    if (t && lastPlay.current?.sig === `${t.fromId}>${t.toId}:${t.forward}` &&
        lastPlay.current.anims.some((a) => a.playState === "running")) return;
    // 每次栈变化先收掉上一场动画（快速连点 / REPLACE 打断 / POP 降级时 t 为 null）
    const prevAnims = running.current;
    running.current = [];
    prevAnims.forEach((a) => a.cancel());
    // cancel 会撤掉动画样式；手动覆盖过的 visibility / zIndex 要收回成 React 该有的值
    nodes.current.forEach((el, id) => {
      const active = id === stack.activeId;
      el.style.visibility = active ? "visible" : "hidden";
      el.style.zIndex = active ? "1" : "0";
      el.classList.remove("layer-elevated");
    });
    rootRef.current?.removeAttribute("data-animating");
    if (!t) return;

    const from = nodes.current.get(t.fromId);
    const to = nodes.current.get(t.toId);
    const root = rootRef.current;
    // 系统开了「减少动态效果」就只保留即时切换
    if (!from || !to || !root || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // 离开的层平时是 visibility:hidden，动画期间要露出来（上层滑入/滑出时会露出它）；
    // 返回时还得盖在目标层上方才能看见它滑走。底层全程静止、不做视差位移。
    from.style.visibility = "visible";
    if (!t.forward) from.style.zIndex = "2";
    // 上层页面的左边缘投影用静态 class：把 box-shadow 放进 keyframes 会让整层每帧重绘，
    // 大列表页（几十本书）会明显掉帧；静态阴影随 transform 一起进合成层，只画一次
    const moving = t.forward ? to : from;
    moving.classList.add("layer-elevated");
    root.setAttribute("data-animating", "1"); // CSS 生成透明遮罩，吃掉转场期间的点击/触摸

    // 只有上层动：进入时新页 100% → 0 从右覆盖过来；返回时当前页 0 → 100% 从左往右退出。
    // 底层保持不动（原生导航就是压栈/出栈，下层不该跟着平移），两层都自带不透明底色不会透叠。
    const opts: KeyframeAnimationOptions = { duration: ANIM_MS, easing: ANIM_EASE, fill: "both" };
    const frames = t.forward
      ? [{ transform: "translateX(100%)" }, { transform: "translateX(0)" }]
      : [{ transform: "translateX(0)" }, { transform: "translateX(100%)" }];
    const anims = [moving.animate(frames, opts)];
    running.current = anims;
    lastPlay.current = { sig: `${t.fromId}>${t.toId}:${t.forward}`, anims };
    Promise.all(anims.map((a) => a.finished.catch(() => {}))).then(() => {
      if (running.current !== anims) return; // 已被下一次导航取消，清理由那次负责
      anims.forEach((a) => a.cancel()); // 撤掉 transform，别让 fixed 元素长期换包含块
      running.current = [];
      lastPlay.current = null;
      from.style.visibility = "hidden";
      from.style.zIndex = "0";
      [from, to].forEach((el) => el.classList.remove("layer-elevated"));
      root.removeAttribute("data-animating");
    });
  }, [stack]);

  return (
    <BackContext.Provider value={backTo}>
      <div ref={rootRef} className="page-layers fixed inset-0 overflow-hidden">
        {stack.layers.map((l) => (
          <LayerView key={l.id} layer={l} active={l.id === stack.activeId} register={register}>
            {children}
          </LayerView>
        ))}
      </div>
    </BackContext.Provider>
  );
}
