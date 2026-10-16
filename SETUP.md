# 深川清澄白河 歴史アーカイブ 公開版のつくり方

班のメンバーに見てもらう**試験公開**までの手順です。全部で1〜2時間ほど。順番どおりに進めれば、途中で止めても大丈夫です。

## できあがる形

| 部品 | 役わり | 費用の目安 |
|---|---|---|
| GitHub Pages | 公開ページそのもの（`docs` フォルダ） | 無料 |
| Supabase | みんなの散歩道・検索された言葉・手がかりの保管と承認、まとめの中継 | 無料枠で足ります |
| Anthropic API | 「この言葉でまとめを読む」「散歩道を物語にする」の文章づくり | 使った分だけ。上限は自分で決められます |
| Cloudflare Turnstile（任意） | まとめのボタンを機械が連打するのを防ぐ | 無料 |

Claude 上の版はこれまでどおり**班の作業場**として残します。資料の取り込みと「手がかり探し」はそちらで行い、公開ページにはその結果だけを出します。

> **鍵の扱い**：Anthropic の API キー、Supabase の service_role キー、Turnstile の Secret Key は、各サービスの管理画面にだけ入力してください。チャットやファイル、GitHub には書かないでください。`config.js` に書くのは「公開してよい値」（Supabase の URL と anon キー、Turnstile の Site Key）だけです。

---

## 1. GitHub にページを置く（済み）

- リポジトリ：`matsuoarashi/fukagawa-archive`（Public）
- 公開ページ：`https://matsuoarashi.github.io/fukagawa-archive/`
- Settings → Pages で「main ブランチの `/docs` フォルダ」から公開する設定にしてあります。`docs` の中を書き換えると、数分でページに反映されます。

## 2. Supabase（保管と承認）を用意する

1. [supabase.com](https://supabase.com) でアカウントを作り、**New project** を作ります。リージョンは **Tokyo (ap-northeast-1)**。データベースのパスワードは管理画面が作るものをそのまま使い、パスワード管理アプリなどに控えます。
2. 左の **SQL Editor** を開き、`supabase/schema.sql` の中身を全部貼り付けて **Run**。
3. 続けて、班のメンバーのメールアドレスを登録します（人数分）：
   ```sql
   insert into editors (email) values ('メンバーのアドレス') on conflict do nothing;
   ```
4. **Authentication → URL Configuration** の「Site URL」に公開ページのURL（`https://matsuoarashi.github.io/fukagawa-archive/`）を入れ、「Redirect URLs」に `https://matsuoarashi.github.io/fukagawa-archive/admin.html` を足します。
5. **Project Settings → API**（または API Keys）で「Project URL」と、公開用の鍵（「anon public」または「Publishable key」）を確認します。

## 3. `config.js` に公開用の値を入れる

GitHub のリポジトリで `docs/config.js` を開き、鉛筆マークで編集します。

```js
supabaseUrl: "https://xxxx.supabase.co",   // Project URL
supabaseAnonKey: "eyJ... または sb_publishable_...",  // 公開用の鍵（公開してよい鍵）
```

保存（Commit）すると数分でページが更新され、「いま町で調べられている言葉」「みんなの散歩道」が動き出します。

## 4. まとめ（AI）の中継をつなぐ

1. [console.anthropic.com](https://console.anthropic.com) で共栄会用の組織を作り、支払い方法を登録します。
   **Settings → Limits** で月の使用上限（例：月3,000円ほど）を先に決めておくと安心です。
2. **API Keys** で新しい鍵を作ります。表示された鍵は、次の手順で Supabase に入れるまで画面を閉じないでください。
3. Supabase の **Edge Functions → Secrets**（Project Settings → Edge Functions）に、次の値を登録します：

   | 名前 | 入れる値 |
   |---|---|
   | `ANTHROPIC_API_KEY` | 手順2の鍵 |
   | `DATA_URL` | `https://matsuoarashi.github.io/fukagawa-archive/records.json` |
   | `ALLOWED_ORIGINS` | `https://matsuoarashi.github.io`（独自ドメインを使う場合はそれも、カンマ区切りで） |
   | `LIMIT_PER_PERSON_DAY` | 1人1日あたりの回数（例：`10`） |
   | `LIMIT_PER_DAY` | サイト全体の1日の回数（例：`300`） |
   | `LIMIT_PER_MONTH` | サイト全体の1か月の回数（例：`3000`） |

4. **Edge Functions → Deploy a new function → Via Editor** を選び、名前を `ask` にして、`supabase/functions/ask/index.ts` の中身を貼り付けて **Deploy**。
   デプロイ後、その関数の **Details（設定）** で「Enforce JWT verification（JWTの確認）」を**オフ**にします。この関数は、送り元のページ・人ごとの回数・（任意で）Turnstile を自分で確かめるので、オフで問題ありません。
5. 公開ページで何か検索し、「この言葉でまとめを読む」を押して文章が出れば完成です。

### 費用の目安
まとめ1回で送る量は約2,000〜4,000トークン、返ってくる文章は数百トークンです。小さいモデル（初期設定）なら1回あたり1円未満が目安です。
同じ問いの答えは7日間データベースにしまい、2回目からはAIを呼びません（回数にも数えません）。上の上限を超えると、その日はボタンを押しても「今日の回数がいっぱい」と出るだけで、費用は増えません。

## 5. 承認台を使う

`https://matsuoarashi.github.io/fukagawa-archive/admin.html` を開き、登録したメールアドレスを入れると、ログイン用のリンクが届きます。

- **手がかり**：承認したものだけが「班で確かめた手がかり」として公開されます
- **場所の手がかり**：公開されません。地図の位置を決める参考にします
- **検索された言葉**：承認した言葉だけが「いま町で調べられている言葉」に出ます（いたずらの言葉が表に出ないように）
- **みんなの散歩道**：資料IDの並びだけなので自動で公開。不自然なものは「隠す」で消せます
- **まとめの使用量**：きょう・今月の回数と、しまってある答えの数

## 6.（任意）まとめのボタンを機械の連打から守る

1. Cloudflare にサインインし、**Turnstile → Add widget**。ドメインに `matsuoarashi.github.io` を入れ、モードは **Invisible** か **Managed**。
2. 表示された **Site Key** を `docs/config.js` の `turnstileSiteKey` に入れます（公開してよい値）。
3. **Secret Key** は Supabase の Secrets に `TURNSTILE_SECRET` という名前で入れます（公開しない）。

## 7.（任意）独自ドメイン

`archive.fukagawa-kiyosumi.jp` のような住所にしたい場合は、ドメインを取得し、GitHub の **Settings → Pages → Custom domain** に入力して、ドメイン側に CNAME を設定します。
その後、Supabase の Site URL・Redirect URLs と `ALLOWED_ORIGINS`、`DATA_URL` を新しい住所に変えてください。

---

## 資料を足したとき

Claude 上の版（班の作業場）で資料を足したら、Claude に「公開版を作り直して」と頼んでください。`docs/index.html` と `docs/records.json` を作り直します。その2つを GitHub に上げ直せば、数分で公開ページに反映されます。

## 一般公開の前に決めておくこと

- 証言・学校資料・作文の扱い（本人や学校の了解、公開してよい範囲）
- 架空の作文サンプルを公開ページから外すか
- 問い合わせ先と、掲載資料の出典表示の確認（区報・深川くらし・雑誌記事）
- 班の中で、承認台を見る担当と頻度
