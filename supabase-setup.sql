-- ============================================================
-- NOREM Supabase セットアップ
-- SQL Editor に貼り付けて Run してください
-- ============================================================

-- 1. 顧客プロフィールテーブル
create table if not exists public.profiles (
  id           uuid references auth.users(id) on delete cascade primary key,
  email        text,
  full_name    text,
  line_id      text,
  created_at   timestamptz default now()
);

-- 2. 注文テーブル
create table if not exists public.orders (
  id               uuid default gen_random_uuid() primary key,
  user_id          uuid references public.profiles(id) on delete set null,
  email            text not null,
  full_name        text,
  postal_code      text,
  prefecture       text,
  city             text,
  address          text,
  items            jsonb not null default '[]',
  subtotal         integer not null default 0,
  shipping         integer not null default 0,
  total            integer not null default 0,
  payment_method   text,
  bespoke_payment  text,  -- 'deposit' or 'full'
  status           text default 'pending',
  notes            text,
  created_at       timestamptz default now()
);

-- 3. Row Level Security（ユーザーは自分のデータのみ閲覧可）
alter table public.profiles enable row level security;
alter table public.orders   enable row level security;

-- profiles: 自分のデータのみ
create policy "profiles_select" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_insert" on public.profiles
  for insert with check (auth.uid() = id);
create policy "profiles_update" on public.profiles
  for update using (auth.uid() = id);

-- orders: 自分の注文のみ（ゲスト注文はemail一致で照合）
create policy "orders_select_own" on public.orders
  for select using (
    auth.uid() = user_id
    or email = (select email from auth.users where id = auth.uid())
  );
create policy "orders_insert" on public.orders
  for insert with check (true);

-- 4. 新規ユーザー登録時にプロフィールを自動作成するトリガー
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', '')
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 完了
select 'セットアップ完了！' as result;
