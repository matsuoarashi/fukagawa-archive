-- 深川清澄白河 歴史アーカイブ（公開版）のデータベース
-- Supabase の「SQL Editor」にこのファイルの中身を貼り付けて、一度だけ Run してください。
-- 何度実行しても壊れないように書いてあります。

-- ============ 書き込みの回数制限（同じ通信元から1時間に30件まで） ============
create or replace function fk_ip() returns text language sql stable as $$
  select nullif(btrim(coalesce(
    (coalesce(current_setting('request.headers', true), '{}')::json)->>'cf-connecting-ip',
    split_part((coalesce(current_setting('request.headers', true), '{}')::json)->>'x-forwarded-for', ',', 1)
  )), '')
$$;
create or replace function fk_client() returns text language sql stable as $$
  select md5(coalesce(fk_ip(), 'unknown') || 'fk-salt')
$$;

create table if not exists write_log (
  who text not null, tbl text not null, at timestamptz not null default now()
);
create index if not exists write_log_idx on write_log (who, tbl, at);
alter table write_log enable row level security;  -- 方針なし＝外からは読めない

create or replace function fk_throttle() returns trigger language plpgsql security definer set search_path = public as $$
declare c int;
begin
  if auth.role() = 'service_role' then return new; end if;
  delete from write_log where at < now() - interval '2 hours';
  select count(*) into c from write_log where who = fk_client() and tbl = tg_table_name and at > now() - interval '1 hour';
  if c >= (case when fk_ip() is null then 600 else 30 end) then raise exception 'too many writes' using errcode = 'P0001'; end if;
  insert into write_log (who, tbl) values (fk_client(), tg_table_name);
  return new;
end $$;

-- ============ 班のメンバー（承認画面に入れる人） ============
create table if not exists editors (email text primary key);
alter table editors enable row level security;
create or replace function is_editor() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from editors where lower(email) = lower(coalesce(auth.jwt()->>'email', '')))
$$;
drop policy if exists "editors read self" on editors;
create policy "editors read self" on editors for select using (is_editor());

-- 資料IDの形（FK-001, KH-120, MK-G4 など）
create or replace function fk_valid_ids(ids text[]) returns boolean language sql immutable as $$
  select coalesce(bool_and(x ~ '^[A-Z]{2}-[A-Z]{0,3}[0-9]{1,4}$'), false) from unnest(ids) x
$$;

-- ============ 検索された言葉（班が「表に出してよい」とした言葉だけ公開） ============
create table if not exists search_terms (
  q text primary key, status text not null default 'pending' check (status in ('pending','approved','rejected')),
  first_at timestamptz not null default now()
);
create table if not exists searches (
  id bigserial primary key,
  q text not null check (char_length(q) between 1 and 40),
  at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','approved','rejected'))
);
create or replace function fk_search_status() returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.q := btrim(new.q);
  insert into search_terms (q) values (new.q) on conflict (q) do nothing;
  select status into new.status from search_terms where q = new.q;
  new.at := now();
  return new;
end $$;
drop trigger if exists searches_status on searches;
create trigger searches_status before insert on searches for each row execute function fk_search_status();
drop trigger if exists searches_throttle on searches;
create trigger searches_throttle before insert on searches for each row execute function fk_throttle();

-- 言葉を承認・却下したら、過去の検索にも反映
create or replace function fk_term_sync() returns trigger language plpgsql security definer set search_path = public as $$
begin update searches set status = new.status where q = new.q; return new; end $$;
drop trigger if exists terms_sync on search_terms;
create trigger terms_sync after update of status on search_terms for each row execute function fk_term_sync();

-- ============ みんなの散歩道（資料IDの並びだけなので、すぐ公開） ============
create table if not exists walks (
  id bigserial primary key,
  ids text[] not null check (array_length(ids, 1) between 3 and 10 and fk_valid_ids(ids)),
  at timestamptz not null default now(),
  status text not null default 'approved' check (status in ('pending','approved','rejected'))
);
drop trigger if exists walks_throttle on walks;
create trigger walks_throttle before insert on walks for each row execute function fk_throttle();

-- ============ 手がかり（班が確かめたものだけ公開） ============
create table if not exists discoveries (
  id bigserial primary key,
  title text not null check (char_length(title) between 1 and 40),
  body text not null default '' check (char_length(body) <= 300),
  ids text[] not null check (array_length(ids, 1) between 1 and 8 and fk_valid_ids(ids)),
  sub text not null default '' check (char_length(sub) <= 10),
  at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','approved','rejected'))
);
drop trigger if exists disc_throttle on discoveries;
create trigger disc_throttle before insert on discoveries for each row execute function fk_throttle();

-- ============ 場所の手がかり（班だけが読む） ============
create table if not exists place_hints (
  id bigserial primary key,
  rec_id text not null check (rec_id ~ '^[A-Z]{2}-[A-Z]{0,3}[0-9]{1,4}$'),
  text text not null check (char_length(text) between 1 and 120),
  at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','approved','rejected'))
);
drop trigger if exists hints_throttle on place_hints;
create trigger hints_throttle before insert on place_hints for each row execute function fk_throttle();

-- ============ 読み書きの方針（RLS） ============
alter table search_terms enable row level security;
alter table searches enable row level security;
alter table walks enable row level security;
alter table discoveries enable row level security;
alter table place_hints enable row level security;

do $$ declare t text; begin
  foreach t in array array['searches','walks','discoveries','place_hints','search_terms'] loop
    execute format('drop policy if exists "public read" on %I', t);
    execute format('drop policy if exists "anyone add" on %I', t);
    execute format('drop policy if exists "editors all" on %I', t);
    execute format('create policy "editors all" on %I for all using (is_editor()) with check (is_editor())', t);
  end loop;
end $$;

-- 誰でも読める：承認済みのものだけ（場所の手がかりは公開しない）
create policy "public read" on searches    for select using (status = 'approved');
create policy "public read" on walks       for select using (status = 'approved');
create policy "public read" on discoveries for select using (status = 'approved');
-- 誰でも書ける：決まった形のものだけ。承認済みとして書き込むことはできない
create policy "anyone add" on searches    for insert with check (true);  -- 状態はトリガーが決める
create policy "anyone add" on walks       for insert with check (status = 'approved');
create policy "anyone add" on discoveries for insert with check (status = 'pending');
create policy "anyone add" on place_hints for insert with check (status = 'pending');

-- 公開ページが読む列だけに絞る
revoke all on searches, walks, discoveries, place_hints, search_terms, editors, write_log from anon, authenticated;
grant select (q, at) on searches to anon, authenticated;
grant insert (q) on searches to anon, authenticated;
grant select (id, ids, at) on walks to anon, authenticated;
grant insert (ids) on walks to anon, authenticated;
grant select (id, title, body, ids, sub, at, status) on discoveries to anon, authenticated;
grant insert (title, body, ids, sub) on discoveries to anon, authenticated;
grant insert (rec_id, text) on place_hints to anon, authenticated;
grant usage on all sequences in schema public to anon, authenticated;
-- 班のメンバー（ログイン済み）は承認画面から全部を扱う。実際に許すかは上の is_editor() 方針で決まる
grant select, update, delete on searches, walks, discoveries, place_hints, search_terms to authenticated;
grant select on editors to authenticated;

-- ============ まとめ（AI）の回数と答えのしまい場所。中継サーバーだけが使う ============
create table if not exists ai_cache (
  key text primary key, text text not null, at timestamptz not null default now()
);
create table if not exists ai_usage (
  day date not null, who text not null, n int not null default 0, primary key (day, who)
);
alter table ai_cache enable row level security;
alter table ai_usage enable row level security;

create or replace function fk_take_quota(p_who text, p_per_ip int, p_per_day int, p_per_month int)
returns text language plpgsql security definer set search_path = public as $$
declare c int;
begin
  perform pg_advisory_xact_lock(42);
  select coalesce(sum(n), 0) into c from ai_usage where day >= date_trunc('month', current_date)::date;
  if c >= p_per_month then return 'month'; end if;
  select coalesce(sum(n), 0) into c from ai_usage where day = current_date;
  if c >= p_per_day then return 'day'; end if;
  select coalesce(sum(n), 0) into c from ai_usage where day = current_date and who = p_who;
  if c >= p_per_ip then return 'ip'; end if;
  insert into ai_usage (day, who, n) values (current_date, p_who, 1)
    on conflict (day, who) do update set n = ai_usage.n + 1;
  return 'ok';
end $$;
revoke all on function fk_take_quota(text, int, int, int) from public, anon, authenticated;

-- 班が承認画面で使用量を見るための集計
create or replace function fk_usage_summary() returns json language sql stable security definer set search_path = public as $$
  select case when is_editor() then json_build_object(
    'today', (select coalesce(sum(n), 0) from ai_usage where day = current_date),
    'month', (select coalesce(sum(n), 0) from ai_usage where day >= date_trunc('month', current_date)::date),
    'cached', (select count(*) from ai_cache)
  ) else null end
$$;
grant execute on function fk_usage_summary() to authenticated;

-- ============ 最後に：班のメンバーのメールアドレスを登録 ============
-- 下の行の例を書き換えて、メンバーの人数分だけ実行してください。
-- insert into editors (email) values ('member@example.com') on conflict do nothing;
