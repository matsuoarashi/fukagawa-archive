// まとめ（AI）の中継サーバー。Supabase Edge Function として動く。
// ・Anthropic の鍵はここ（Supabase の Secrets）にだけ置く。ページには出ない
// ・ページから受け取るのは「問い（40字まで）と資料ID（20件まで）」だけ。文面はここで組み立てる
//   → 自由な文章を送り込んで、ただのチャットとして使われることを防ぐ
// ・同じ問いの答えはデータベースに7日しまい、2回目からはAIを呼ばない
// ・1人あたり／1日あたり／1か月あたりの上限を超えたら止める

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const ANTHROPIC_API_KEY = env("ANTHROPIC_API_KEY");
const MODEL = env("ANTHROPIC_MODEL", "claude-haiku-5-5");
const DATA_URL = env("DATA_URL"); // 例: https://<アカウント>.github.io/<リポジトリ>/records.json
const ALLOWED_ORIGINS = env("ALLOWED_ORIGINS", "*").split(",").map((s) => s.trim());
const PER_IP = +env("LIMIT_PER_PERSON_DAY", "10");
const PER_DAY = +env("LIMIT_PER_DAY", "300");
const PER_MONTH = +env("LIMIT_PER_MONTH", "3000");
const TURNSTILE_SECRET = env("TURNSTILE_SECRET");
const CACHE_DAYS = 7;

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

type Rec = { id: string; y: number; title: string; place: string; type: string; asof: string; sum: string };
let records: Map<string, Rec> | null = null, loadedAt = 0;
async function getRecords(): Promise<Map<string, Rec>> {
  if (records && Date.now() - loadedAt < 10 * 60 * 1000) return records;
  const res = await fetch(DATA_URL, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) { if (records) return records; throw new Error("records " + res.status); }
  const list: Rec[] = await res.json();
  records = new Map(list.map((r) => [r.id, r])); loadedAt = Date.now();
  return records;
}

// ページ（fukagawa-archive.html の recText / askTask / buildPrompt）と同じ文面
function recText(r: Rec) {
  const s = r.sum.length > 140 ? r.sum.slice(0, 139) + "…" : r.sum;
  return `[${r.id}] ${r.y}年 ${r.title}｜${r.place}｜${r.type}${r.asof ? `｜${r.asof}時点の記事` : ""}｜${s}`;
}
function askTask(kind: string, q: string, ids: string[]) {
  return kind === "story"
    ? `次の順に歩いた資料（${ids.join(" → ")}）を、一続きの散歩の語りとして5〜8文でつなぐ。資料どうしの意外なつながり（同じ場所の別の時代、同じ年の別の出来事など）を見つけて言葉にする。`
    : `質問「${q}」に3〜6文で答える。時代順が分かりやすければ時代順に。`;
}
function buildPrompt(kind: string, q: string, pool: Rec[]) {
  const enc = new TextEncoder(); const out: string[] = []; let used = 0;
  for (const r of pool) { const line = recText(r); const b = enc.encode(line).length + 1; if (used + b > 12000) break; out.push(line); used += b; }
  return `あなたは東京・深川清澄白河の商店街「深川清澄白河共栄会」歴史アーカイブ班の語り部です。
次の「収録資料」だけを根拠に、日本語で答えてください。
・${askTask(kind, q, pool.map((r) => r.id))}
・根拠にした資料のIDを、文末に [FK-012] の形で必ず付ける。
・収録資料にないことは推測で補わない。足りなければ「アーカイブにはまだ記録がありません」と書く。
・種類が「証言」の資料は個人の体験談だと分かるように書く。
・「〜時点の記事」とある資料は、その時点の情報として書き、今もそうだと断定しない（例：「2015年の記事では〜と紹介されていた」）。
・数字は算用数字。見出しや箇条書きの記号は使わない。

収録資料：
${out.join("\n")}`;
}

function cors(origin: string | null) {
  const ok = ALLOWED_ORIGINS.includes("*") || (origin && ALLOWED_ORIGINS.includes(origin));
  return {
    "access-control-allow-origin": ok ? (origin ?? "*") : ALLOWED_ORIGINS[0],
    "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-expose-headers": "x-fk-cache",
    "vary": "origin",
  };
}
const fail = (h: Record<string, string>, status: number, code: string) =>
  new Response(JSON.stringify({ code }), { status, headers: { ...h, "content-type": "application/json" } });

async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const h = cors(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  if (req.method !== "POST") return fail(h, 405, "method");
  const origin = req.headers.get("origin");
  if (!ALLOWED_ORIGINS.includes("*") && (!origin || !ALLOWED_ORIGINS.includes(origin))) return fail(h, 403, "not_granted");

  let body: { kind?: string; q?: string; ids?: string[]; turnstile?: string };
  try { body = await req.json(); } catch { return fail(h, 400, "bad_request"); }
  const kind = body.kind === "story" ? "story" : "summary";
  const q = String(body.q ?? "").trim().slice(0, 40);
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).slice(0, 20);
  if (kind === "summary" && !q) return fail(h, 400, "bad_request");
  if (!ids.length) return fail(h, 400, "bad_request");

  const ip = req.headers.get("cf-connecting-ip") ?? (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() ?? "unknown";
  const who = (await sha(ip + "fk-salt")).slice(0, 32);

  if (TURNSTILE_SECRET) {
    const fd = new FormData(); fd.append("secret", TURNSTILE_SECRET); fd.append("response", String(body.turnstile ?? "")); fd.append("remoteip", ip);
    const v = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: fd }).then((r) => r.json()).catch(() => ({ success: false }));
    if (!v.success) return fail(h, 403, "not_granted");
  }

  let recs: Map<string, Rec>;
  try { recs = await getRecords(); } catch { return fail(h, 503, "unavailable"); }
  const pool = ids.map((id) => recs.get(id)).filter((r): r is Rec => !!r);
  if (!pool.length) return fail(h, 400, "bad_request");

  // 同じ問い・同じ資料なら、しまってある答えを返す（AIは呼ばない・回数にも数えない）
  const key = await sha(MODEL + "|" + kind + "|" + q + "|" + pool.map((r) => r.id).join(","));
  const { data: hit } = await db.from("ai_cache").select("text, at").eq("key", key).maybeSingle();
  if (hit && Date.now() - new Date(hit.at).getTime() < CACHE_DAYS * 864e5) {
    return new Response(hit.text, { headers: { ...h, "content-type": "text/plain; charset=utf-8", "x-fk-cache": "hit" } });
  }

  const { data: quota, error: qerr } = await db.rpc("fk_take_quota", { p_who: who, p_per_ip: PER_IP, p_per_day: PER_DAY, p_per_month: PER_MONTH });
  if (qerr) return fail(h, 503, "unavailable");
  if (quota === "ip") return fail(h, 429, "daily_limit");
  if (quota === "day" || quota === "month") return fail(h, 429, "daily_limit");

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 800, stream: true, messages: [{ role: "user", content: buildPrompt(kind, q, pool) }] }),
  });
  if (!upstream.ok || !upstream.body) return fail(h, upstream.status === 429 ? 429 : 502, upstream.status === 429 ? "rate_limited" : "unavailable");

  // Anthropic の流れ（SSE）から文字だけを取り出して、そのままページへ流す
  let full = "";
  const reader = upstream.body.pipeThrough(new TextDecoderStream()).getReader();
  const stream = new ReadableStream({
    async start(ctrl) {
      const enc = new TextEncoder(); let buf = "", done = false;
      try {
        while (true) {
          const { value, done: end } = await reader.read(); if (end) break;
          buf += value; const lines = buf.split("\n"); buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
            if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") { full += ev.delta.text; ctrl.enqueue(enc.encode(ev.delta.text)); }
            if (ev.type === "message_stop") done = true;
          }
        }
      } catch { /* 途中で切れたら、そこまでを返す */ }
      ctrl.close();
      if (done && full) await db.from("ai_cache").upsert({ key, text: full, at: new Date().toISOString() });
    },
  });
  return new Response(stream, { headers: { ...h, "content-type": "text/plain; charset=utf-8", "x-fk-cache": "miss" } });
});
