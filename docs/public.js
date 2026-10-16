// 公開版のつなぎ役。Claude 上の版が使っている window.claude.use("db" / "sample") を、
// Supabase（データベース）と中継サーバー（まとめ）に置き換える。アーカイブ本体のコードは同じものを使う。
(function () {
  const C = window.FK_CONFIG || {};
  const base = (C.supabaseUrl || "").replace(/\/$/, "");
  const key = C.supabaseAnonKey || "";
  const live = !!(base && key);
  const H = { apikey: key, Authorization: "Bearer " + key };

  if (C.banner) document.addEventListener("DOMContentLoaded", () => {
    const b = document.createElement("div");
    b.textContent = C.banner;
    b.style.cssText = "position:relative;z-index:5;padding:6px 16px;font-size:12px;text-align:center;background:rgba(240,200,110,.12);color:inherit;border-bottom:1px solid rgba(240,200,110,.25)";
    document.body.prepend(b);
  });

  // ページの呼び名 → データベースの表と列
  const TABLES = {
    searches:    { table: "searches",    read: "q,at",                         write: (d) => ({ q: String(d.q || "").slice(0, 40) }) },
    walks:       { table: "walks",       read: "id,ids,at",                    write: (d) => ({ ids: (d.ids || []).slice(0, 10) }) },
    discoveries: { table: "discoveries", read: "id,title,body,ids,sub,at,status", write: (d) => ({ title: String(d.title || "").slice(0, 40), body: String(d.body || "").slice(0, 300), ids: (d.ids || []).slice(0, 8), sub: String(d.sub || "").slice(0, 10) }) },
    placeHints:  { table: "place_hints", read: null,                           write: (d) => ({ rec_id: String(d.id || ""), text: String(d.text || "").slice(0, 120) }) },
  };

  function err(code) { const e = new Error(code); e.code = code; return e; }

  function collection(name) {
    const t = TABLES[name]; if (!t) throw err("unknown_collection");
    const q = { order: null, dir: "desc", lim: 50 };
    const api = {
      orderBy(f, dir) { q.order = f; q.dir = dir === "asc" ? "asc" : "desc"; return api; },
      limit(n) { q.lim = n; return api; },
      async get() {
        if (!t.read) throw err("not_granted");
        const url = `${base}/rest/v1/${t.table}?select=${t.read}${q.order ? `&order=${q.order}.${q.dir}` : ""}&limit=${q.lim}`;
        const res = await fetch(url, { headers: H });
        if (!res.ok) throw err("unavailable");
        const rows = await res.json();
        return { docs: rows.map((r) => ({ id: String(r.id ?? ""), data: () => ({ ...r, at: r.at ? Date.parse(r.at) : 0 }) })) };
      },
      // 変化の通知のかわりに、開いている間だけ90秒ごとに読み直す
      onSnapshot(cb, onErr) {
        let stop = false, timer = null;
        const tick = async () => {
          if (stop) return;
          if (document.visibilityState === "visible") { try { cb(await api.get()); } catch (e) { onErr && onErr(e); } }
          timer = setTimeout(tick, 90000);
        };
        tick();
        return () => { stop = true; clearTimeout(timer); };
      },
      async add(doc) {
        const res = await fetch(`${base}/rest/v1/${t.table}`, {
          method: "POST", headers: { ...H, "content-type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify(t.write(doc)),
        });
        if (!res.ok) throw err(res.status === 429 || res.status === 400 ? "rate_limited" : "not_granted");
        return { id: "" };
      },
    };
    return api;
  }
  const dbNs = live ? Object.freeze({ collection }) : null;

  // ---- Turnstile（人の操作かを確かめる。設定したときだけ） ----
  let tsReady = null, tsWidget = null, tsResolve = null;
  function turnstileToken() {
    if (!C.turnstileSiteKey) return Promise.resolve("");
    if (!tsReady) tsReady = new Promise((ok, ng) => {
      window.fkTurnstileLoaded = () => {
        const box = document.createElement("div"); box.style.cssText = "position:fixed;bottom:12px;right:12px;z-index:99"; document.body.appendChild(box);
        tsWidget = window.turnstile.render(box, { sitekey: C.turnstileSiteKey, execution: "execute", appearance: "interaction-only",
          callback: (tok) => { tsResolve && tsResolve(tok); tsResolve = null; }, "error-callback": () => { tsResolve && tsResolve(""); tsResolve = null; } });
        ok();
      };
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=fkTurnstileLoaded";
      s.async = true; s.onerror = () => ng(err("unavailable")); document.head.appendChild(s);
    });
    return tsReady.then(() => new Promise((ok) => { tsResolve = ok; window.turnstile.reset(tsWidget); window.turnstile.execute(tsWidget); }));
  }

  // ---- まとめ：問いと資料IDだけを中継サーバーへ送り、返ってくる文字を順に表示 ----
  async function ask(payload, opts = {}) {
    const { signal, onText } = opts;
    const turnstile = await turnstileToken();
    let res;
    try {
      res = await fetch(`${base}/functions/v1/ask`, {
        method: "POST", signal, headers: { ...H, "content-type": "application/json" },
        body: JSON.stringify({ ...payload, turnstile }),
      });
    } catch (e) { throw err(signal && signal.aborted ? "cancelled" : "unavailable"); }
    if (!res.ok) { let code = "unavailable"; try { code = (await res.json()).code || code; } catch {} throw err(code); }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let text = "";
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        const delta = dec.decode(value, { stream: true }); text += delta;
        onText && onText({ text, delta });
      }
    } catch (e) { const x = err(signal && signal.aborted ? "cancelled" : "unavailable"); x.text = text; throw x; }
    return { text, truncated: false };
  }

  const aiOn = live && C.ai !== false;
  if (aiOn) window.FK_PUBLIC = Object.freeze({ ask });
  // 本体は sample が「ある」ことでまとめのボタンを出す。公開版では FK_PUBLIC.ask が実際の送り先
  const sampleNs = aiOn ? Object.assign(() => Promise.reject(err("not_granted")), { json: () => Promise.reject(err("not_granted")) }) : null;

  if (!window.claude) {
    window.claude = Object.freeze({
      use: async (name) => (name === "db" ? dbNs : name === "sample" ? sampleNs : null),
    });
  }
})();
