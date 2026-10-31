import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ensureScriptFile, loadInst, materializeScripts, saveScriptFile } from "../src/source/script";

// 落盘脚本是产物，数据库 code 列才是真相：
// 1) data/sources 被清空/换机器（文件不存在）→ 按 code 自动生成
// 2) 旧版本把 file:///D:/... 写进了文件 → 不修路径，直接按 code 重新生成
// 线上事故：Windows 保存的源搬到 Linux，脚手架里的绝对路径变成 /D:/... → Cannot find module

const DIR = "data/sources";
const T_LOST = 99101; // 文件不存在
const T_STALE = 99102; // 老格式（外机绝对路径）
const T_SAVE = 99103;

const SPEC = 'from "../../src/source/runtime.ts"';
const IMPORTS = `import { fetchText, parse, abs, log, nodes, ruleText, ruleSel, browserOpen, browserText } from `;
const BODY = `export default class Source {\n  base = "https://example.com";\n  headers = { "User-Agent": "t" };\n}\n`;
const scaffoldFile = (spec: string) => `// AUTO SCAFFOLD —— 由引擎生成，请勿修改本段\n${IMPORTS}"${spec}";\n\n${BODY}`;

beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  for (const id of [T_LOST, T_STALE, T_SAVE]) rmSync(`${DIR}/${id}.js`, { force: true });
});
afterAll(() => {
  for (const id of [T_LOST, T_STALE, T_SAVE]) rmSync(`${DIR}/${id}.js`, { force: true });
});

describe("脚本源落盘自动生成", () => {
  test("文件被删 → 用传入的 code 自动生成并正常加载", async () => {
    const file = `${DIR}/${T_LOST}.js`;
    expect(existsSync(file)).toBe(false);

    const inst = await loadInst(T_LOST, BODY);
    expect(inst.base).toBe("https://example.com");
    expect(typeof inst.headers).toBe("object"); // runtime 注入正常

    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf-8")).toContain(SPEC);
  });

  test("老格式文件（外机绝对路径）→ 按 code 重新生成，不再做路径修复", async () => {
    const file = `${DIR}/${T_STALE}.js`;
    writeFileSync(file, scaffoldFile("file:///D:/definitely-missing-bun-reader/src/source/runtime.ts"));

    const inst = await loadInst(T_STALE, BODY);
    expect(inst.base).toBe("https://example.com");

    const rebuilt = readFileSync(file, "utf-8");
    expect(rebuilt).toContain(SPEC);
    expect(rebuilt).not.toContain("D:/");
  });

  test("既没有文件也没有 code → 明确报错（不静默失败）", async () => {
    await expect(ensureScriptFile(99119)).rejects.toThrow(/没有代码|code/);
  });

  test("saveScriptFile 落盘的脚手架只用相对路径，不含盘符", () => {
    saveScriptFile(T_SAVE, BODY);
    const saved = readFileSync(`${DIR}/${T_SAVE}.js`, "utf-8");
    expect(saved).toContain(SPEC);
    // 盘符形态（C:/ 或 C:\）不应出现；注意别误伤 URL 里的 "https://"
    expect(saved).not.toMatch(/(^|["'(\s])[A-Za-z]:[\\/]/);
    expect(saved).not.toContain("file://");
  });

  test("materializeScripts 启动扫描可重复执行（幂等、不抛错）", async () => {
    const first = await materializeScripts();
    expect(typeof first.total).toBe("number");
    expect(Array.isArray(first.generated)).toBe(true);
    // 再跑一次：文件都在 → 不再生成
    const second = await materializeScripts();
    expect(second.generated.length).toBe(0);
  });
});
