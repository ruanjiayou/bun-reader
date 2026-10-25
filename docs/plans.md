# 当前计划

> 记录最新计划与待办。设计规范见 [docs/design.md](./design.md)，按日期的变更记录见根目录 [CHANGELOG.md](../CHANGELOG.md)。

## 进行中

### 幽香书房 Playwright 链路最终验证
- 机制已就绪：有头 Chrome 弹窗 → WAF 验证码人工输入（180s 窗口）→ cookie 存持久化 profile（`data/browser-profile`）一劳永逸
- 待验证：目录 1400+ 章全量翻页 → 正文批量抓取；再次触发验证码时应复用已存 cookie 直接通过

### 存量缓存重抓
- 正文规则已换 `.textBlocks()`（段落换行），header 已对象化生效——需删除旧缓存重新同步后确认

## 已完成

- [x] 脚本引擎实施计划（TDD 10 步全部落地）：DB 列 → runtime → script.ts → facade → 转换器 → 路由 → 表单制 UI → Playwright 化
- [x] 自适应限速器（滑动窗口计频 + high 不可触及 + okSinceFail 语义）
- [x] 阅读器 UI 规范沉淀（见 design.md 第四部分）

## 备选 / 观察

- 规则引擎标废弃观察：跑稳一版后评估是否删除 rules 分支
- Worker 强隔离 / 源市场 / 签名校验：不做，分享场景再议
