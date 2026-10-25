# 书源脚本引擎实施计划

日期：2026-10-25 · 设计：docs/plans/2026-10-25-source-script-engine.md · 方法：TDD（红→绿→重构）

## 任务拆解（每步含验证）

1. **DB 列**：sources 加 `type`（默认 rules）/`code` 两列（db.ts try/catch ALTER + schema.ts）
   验证：启动无错，`bun -e` 查表结构
2. **RED script-engine.test.ts**：fixture 站点 + class 源字符串，覆盖
   全链路 search→getDetail→getChapters(next 翻页)→getContent({text,next} 合并)、
   replace 成员生效、headers 注入（fixture 校验 Cookie）、缺 search 返回 []、
   超时报错、动态 import 缓存按 mtime 失效、abs() 相对补全
3. **GREEN src/source/runtime.ts**：注入 API（fetchText 带 AsyncLocalStorage headers/parse/abs/log/ruleText/ruleList）
4. **GREEN src/source/script.ts**：加载器（scaffold 落盘、动态 import+mtime 缓存、bind 实例、超时）+ 四个适配函数（searchScript/bookInfoScript/tocScript/contentScript，含引擎侧去重/上限/净化/replace）
5. **facade（src/source/engine-entry.ts）**：`engineFor(row)` → rules/script 统一接口 {search, bookInfo, toc, content, hasSearch}；books.ts / sources.ts 调用点改造；现有 23 测试保持全绿
6. **转换器 convert.ts + convert.test.ts**：rulesToScript(src) 生成 class 代码；
   测试断言：同 fixture 下生成脚本与规则引擎产出一致
7. **路由 sources.ts**：POST / 支持 {type, code}（rules 保存时自动生成 code 落库）、
   GET /:id/code 返回当前 js、调试/体检接口按 type 分流
8. **UI Sources.tsx**：新建/编辑选类型；script 源 = 代码编辑器；rules 源 = 原表单 + 只读预览
9. **存量迁移**：scripts/convert-existing.ts 把 id=2/3 转 script 落盘，手动验证全链路
10. **收尾**：bun test 全绿 + tsc + build，分里程碑提交

## 边界

- 规则引擎代码保留（标废弃），删除另行评估
- Worker 隔离 / Playwright / 源市场：不做
