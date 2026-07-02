#!/usr/bin/env node
/**
 * scan-obfuscation.mjs — Chrome Web Store "Red Titanium" 守门员（warning-only）。
 *
 * 在 build 之后扫描 `.output/<dir>/` 里所有 `.js` 文件，寻找两类
 * obfuscated-code 模式：
 *
 *   1) 直接调用 + 字面量参数：`atob("BASE64")` / `atob('B')` / `atob(\`B\`)`
 *   2) IIFE 包装：`(arg => atob(arg))("BASE64")`（minifier 把
 *      `const f = s => atob(s); f("...")` 折叠成的形式 —— 这次 CWS
 *      拒审命中的正是这种）
 *
 * 命中只发 warning（脚本始终 exit 0），不阻塞 build。目的是在提交
 * CWS 之前抢先看见可能的违规模式 —— 我们已经针对已知的 pi-ai
 * github-copilot.js 做了 transform shim，这里负责防御下一次第三方
 * 依赖再悄悄引入同样的模式。
 *
 * 用法：
 *   node scripts/scan-obfuscation.mjs <dir1> [dir2 ...]
 *
 * 输出：
 *   ⚠ <file>:<line>  <snippet>           — 命中的代码片段
 *     decoded: "Iv1.b507a08c87ecfe98"   — base64 解码预览（仅可打印 ASCII）
 *
 *   或：✓ no obfuscation patterns found in <dir>
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

// ─── 颜色 ───
// 纯 ANSI、零依赖。非 TTY（管道/重定向）退回纯文本，尊重 `NO_COLOR`；
// CI 里可以 `FORCE_COLOR=1` 强开。
const SUPPORTS_COLOR = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  // 走 stderr 因为命中信息都是 console.warn；颜色检测以输出流为准。
  return process.stderr.isTTY === true;
})();
const wrap = (code) => (s) => (SUPPORTS_COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  red: wrap(31),
  yellow: wrap(33),
  green: wrap(32),
  cyan: wrap(36),
  magenta: wrap(35),
  dim: wrap(2),
  redBold: wrap('1;31'),
  yellowBold: wrap('1;33'),
  greenBold: wrap('1;32'),
};

// 小于这个长度的 base64 字面量大概率是测试/noise，不报。所有正则都
// 从这个常量模板，改这里一处就够。
const MIN_BASE64_LEN = 8;

// 直接调用：`atob("…")` / `atob('…')` / `atob(`…`)`
const DIRECT_RE = new RegExp(
  String.raw`\batob\s*\(\s*[\x60'"]([A-Za-z0-9+/=]{${MIN_BASE64_LEN},})[\x60'"]\s*\)`,
  'g',
);

// IIFE 形式：`(x => atob(x))("…")` 及其紧凑变体。x 是任意标识符。
// 注意：本扫描器只覆盖 *箭头函数* IIFE。`(function(s){return atob(s)})("…")`
// 这种 function-expression 形式不在范围内 —— 现代 minifier 几乎不输出，
// 命中过 CWS 的真实案例也都是箭头形式。
const IIFE_RE = new RegExp(
  String.raw`\(\s*\(?\s*\w+\s*\)?\s*=>\s*atob\s*\(\s*\w+\s*\)\s*\)\s*\(\s*[\x60'"]([A-Za-z0-9+/=]{${MIN_BASE64_LEN},})[\x60'"]\s*\)`,
  'g',
);

/**
 * 递归收集目录下所有 .js 文件。
 */
async function collectJsFiles(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // 不要静默吞掉 —— warning-only 契约里，最坏的失败模式就是
      // 「明明读不到目录却报告 ✓ all clear」，那等于放违规进 CWS。
      console.warn(c.yellow(`scan-obfuscation: failed to read ${dir}: ${err?.message ?? err}`));
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

/**
 * 在 `text` 里跑 `regex`，把每次命中映射成 `{ line, col, match, b64, kind }`。
 * 通过累计换行数定位行号 —— 对 minified 单行 bundle 同样适用，所有
 * 命中都会落在第 1 行，那种情况下行号本来就没什么意义。
 * `kind` 让调用方区分高风险（IIFE 包装，命中过 CWS）vs 低风险（直接
 * atob 字面量，比如 PDF.js 的字体资源）。
 */
function findMatches(text, regex, kind) {
  const results = [];
  let m;
  while ((m = regex.exec(text)) !== null) {
    const before = text.slice(0, m.index);
    const line = before.split('\n').length;
    const lastNl = before.lastIndexOf('\n');
    const col = m.index - (lastNl === -1 ? 0 : lastNl + 1) + 1;
    results.push({ line, col, match: m[0], b64: m[1], kind });
  }
  return results;
}

/**
 * 尝试 base64-decode 并返回可打印 ASCII 预览；包含非可打印字节时返回
 * `null`（调用方会标 `[binary]`）。
 *
 * 不需要包 try/catch：Node 的 `Buffer.from(_, 'base64')` 对任何字符串都
 * 不会抛异常 —— 无效 base64 会被静默 decode 成乱字节，再被下面的
 * printable-ASCII 过滤拦掉。我们的正则已经把入参约束在 `[A-Za-z0-9+/=]`
 * 范围内，结构上必然是合法 base64。
 */
function decodePreview(b64) {
  const str = Buffer.from(b64, 'base64').toString('utf8');
  // 允许 \t \n \r 和 0x20-0x7E。其它字节认定为 binary。
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c >= 0x20 && c <= 0x7e) continue;
    return null;
  }
  return str.length > 80 ? str.slice(0, 80) + '…' : str;
}

function snippet(match) {
  // 截断过长的 match，避免输出爆炸。
  return match.length > 120 ? match.slice(0, 117) + '...' : match;
}

async function scanDir(dir) {
  const root = path.resolve(dir);
  let stat;
  try {
    stat = await fs.stat(root);
  } catch {
    console.warn(c.yellow(`scan-obfuscation: skip "${dir}" (path does not exist)`));
    return { hits: 0, files: 0 };
  }
  if (!stat.isDirectory()) {
    console.warn(c.yellow(`scan-obfuscation: skip "${dir}" (not a directory)`));
    return { hits: 0, files: 0 };
  }

  const files = await collectJsFiles(root);
  let iifeCount = 0;
  let directCount = 0;

  for (const file of files) {
    const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');
    const text = await fs.readFile(file, 'utf8');
    const hits = [
      ...findMatches(text, IIFE_RE, 'iife'),
      ...findMatches(text, DIRECT_RE, 'direct'),
    ];
    if (hits.length === 0) continue;

    for (const h of hits) {
      const preview = decodePreview(h.b64);
      const isBinary = preview === null;
      const previewStr = isBinary ? c.magenta('[binary]') : c.green(JSON.stringify(preview));
      const isIife = h.kind === 'iife';
      const tagColor = isIife ? c.redBold : c.yellowBold;
      const lineColor = isIife ? c.red : c.yellow;
      const tag = isIife ? 'IIFE  ' : 'direct';
      const loc = `${c.cyan(rel)}${c.dim(`:${h.line}:${h.col}`)}`;
      console.warn(`${lineColor('⚠')}  [${tagColor(tag)}] ${loc}  ${snippet(h.match)}`);
      console.warn(`   ${c.dim('decoded:')} ${previewStr}`);
      if (isIife) iifeCount++; else directCount++;
    }
  }

  const total = iifeCount + directCount;
  if (total === 0) {
    console.log(c.green(`✓ scan-obfuscation: no obfuscation patterns found in ${dir} (${files.length} .js files scanned)`));
  } else {
    // 整体汇总：只要有 IIFE 命中就用红色，否则黄色。
    const summaryColor = iifeCount > 0 ? c.redBold : c.yellowBold;
    console.warn(summaryColor(`⚠ scan-obfuscation: ${total} potential obfuscation pattern(s) found in ${dir} (${files.length} .js files scanned)`));
    console.warn(`   ${c.red(`${iifeCount} IIFE-wrapped`)} — high risk, matches the Chrome Web Store "Red Titanium" rejection signature.`);
    console.warn(`   ${c.yellow(`${directCount} direct atob(literal)`)} — lower risk, may be legitimate (font/icon blobs). Review case-by-case.`);
    console.warn(c.dim('   Build did NOT fail — this is a warning. Review hits before submitting to CWS.'));
  }
  return { hits: total, files: files.length };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node scripts/scan-obfuscation.mjs <dir1> [dir2 ...]');
    // 不输入参数算用法错误，给个非零退出，但只在「完全没传参」时；
    // 一旦传了参，无论命中多少都 exit 0（warning-only 契约）。
    process.exit(2);
  }
  for (const dir of args) {
    await scanDir(dir);
  }
  process.exit(0);
}

main().catch((err) => {
  // 扫描器自身崩溃也只 warn，不阻塞 build。
  console.warn(c.yellow(`scan-obfuscation: scanner crashed: ${err?.stack ?? err}`));
  process.exit(0);
});
