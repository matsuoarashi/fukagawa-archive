// 公開版の設定。ここに書くのは「公開してよい値」だけです（秘密の鍵は書かない）。
// 空のままでも、閲覧・検索・地図・つながりの図はすべて動きます（書き込みとまとめだけが止まります）。
window.FK_CONFIG = {
  // Supabase → Project Settings → API の「Project URL」
  supabaseUrl: "https://gsrlxjeikejjnnnexnlo.supabase.co",
  // 同じ画面の「anon public」または「Publishable key」（公開用。誰に見られても大丈夫な鍵です）
  // ↓ Supabase の「anon public」キーを、下の "" の間に貼り付けてください
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdzcmx4amVpa2Vqam5ubmV4bmxvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxODMyNTgsImV4cCI6MjEwNzc1OTI1OH0.oG2kdVdrCHhkKBeWSby26yhEr2-iZQWxxjNdu2hgmtk",
  // まとめ（AI）を公開ページでも使うか。使わないなら false
  ai: true,
  // Cloudflare Turnstile の Site Key（使わないなら空のまま）
  turnstileSiteKey: "",
  // ページ上部に出す小さな案内（試験公開中など）。空なら出さない
  banner: "試験公開中です。内容はアーカイブ班が確かめながら増やしています。",
};
