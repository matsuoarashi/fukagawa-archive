// Claude 上の版（fukagawa-archive.html）から公開版の docs/index.html と docs/records.json を作る。
// 使い方: node build.mjs ../fukagawa-archive.html
// 資料を足したときは、Claude に「公開版を作り直して」と頼めば、この手順で作り直します。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(process.argv[2] || resolve(here, "../fukagawa-archive.html"));
let html = readFileSync(src, "utf8");

// 1) 公開用のつなぎ役を本体スクリプトの直前に差し込み、HTMLの骨組みで包む
const at = html.indexOf("<script>");
if (at < 0) throw new Error("本体の <script> が見つかりません");
html = html.slice(0, at) + `<script src="config.js"></script>\n<script src="public.js"></script>\n` + html.slice(at);
const page = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="深川・清澄白河の歴史を、資料・区報・町の記事から時の流れと地図でたどるアーカイブ。">
<style>*,*::before,*::after{box-sizing:border-box}body{margin:0}</style>
</head>
<body>
${html}
</body>
</html>
`;
writeFileSync(resolve(here, "docs/index.html"), page);

// 2) まとめの中継サーバーが読む資料一覧（ページの中の資料と同じもの）
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require(resolve(process.env.NODE_PATH || "", "playwright"))); }
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const p = await browser.newPage();
await p.setContent(`<meta charset="utf-8">` + readFileSync(src, "utf8"), { waitUntil: "domcontentloaded" });
await p.waitForFunction(() => typeof window.FK_EXPORT === "function");
const recs = await p.evaluate(() => window.FK_EXPORT());
await browser.close();
writeFileSync(resolve(here, "docs/records.json"), JSON.stringify(recs));
console.log(`index.html ${(page.length / 1024).toFixed(0)}KB / records.json ${recs.length}件`);
