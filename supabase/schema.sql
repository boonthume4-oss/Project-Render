-- Arch Prompt Studio — Supabase schema (accounts, per-user cloud data, token ledger, PromptPay top-ups).
-- Run the whole file in the Supabase SQL editor. It is idempotent: running it again keeps existing data.
-- Balances, the ledger and top-ups are written only by the server (service role), balances only through apply_tokens().

create extension if not exists pgcrypto;

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  balance numeric(12, 2) not null default 0 check (balance >= 0),
  created_at timestamptz default now()
);

create table if not exists public.token_ledger (
  id bigserial primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  delta numeric(12, 2) not null,
  kind text check (kind in ('topup', 'render', 'refund', 'admin')),
  ref text unique,
  meta jsonb,
  created_at timestamptz default now()
);
create index if not exists token_ledger_user_idx on public.token_ledger (user_id, created_at desc);

create table if not exists public.topups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles (id) on delete cascade,
  omise_charge_id text unique,
  amount_thb int not null,
  status text not null default 'pending',
  created_at timestamptz default now(),
  credited_at timestamptz
);
create index if not exists topups_user_idx on public.topups (user_id, created_at desc);

create table if not exists public.user_data (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  project jsonb,
  options jsonb,
  render_state jsonb,
  history jsonb,
  presets jsonb,
  updated_at timestamptz default now()
);

/* ------------------------------------------------------------------ */
/* Profile on signup (+ backfill for users created before this script) */
/* ------------------------------------------------------------------ */

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

insert into public.profiles (id, email)
select u.id, u.email from auth.users u
on conflict (id) do nothing;

/* ------------------------------------------------------------------ */
/* Row level security                                                  */
/* ------------------------------------------------------------------ */

alter table public.profiles enable row level security;
alter table public.token_ledger enable row level security;
alter table public.topups enable row level security;
alter table public.user_data enable row level security;

-- Read-only for the owner; no client policy for insert/update/delete (the service role bypasses RLS).
drop policy if exists "profiles: own select" on public.profiles;
create policy "profiles: own select" on public.profiles for select to authenticated using (id = auth.uid());

drop policy if exists "ledger: own select" on public.token_ledger;
create policy "ledger: own select" on public.token_ledger for select to authenticated using (user_id = auth.uid());

drop policy if exists "topups: own select" on public.topups;
create policy "topups: own select" on public.topups for select to authenticated using (user_id = auth.uid());

-- Belt and braces: client roles cannot write balances, the ledger or top-ups even if a policy is added by mistake.
revoke insert, update, delete, truncate on public.profiles from anon, authenticated;
revoke insert, update, delete, truncate on public.token_ledger from anon, authenticated;
revoke insert, update, delete, truncate on public.topups from anon, authenticated;
revoke all on public.user_data from anon;

-- user_data: the owner may read and write only their own row.
drop policy if exists "user_data: own select" on public.user_data;
create policy "user_data: own select" on public.user_data for select to authenticated using (user_id = auth.uid());
drop policy if exists "user_data: own insert" on public.user_data;
create policy "user_data: own insert" on public.user_data for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "user_data: own update" on public.user_data;
create policy "user_data: own update" on public.user_data for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "user_data: own delete" on public.user_data;
create policy "user_data: own delete" on public.user_data for delete to authenticated using (user_id = auth.uid());
grant select, insert, update, delete on public.user_data to authenticated;

/* ------------------------------------------------------------------ */
/* Storage: private bucket user-images, objects at <uid>/<imageKey>    */
/* ------------------------------------------------------------------ */

insert into storage.buckets (id, name, public) values ('user-images', 'user-images', false)
on conflict (id) do nothing;

drop policy if exists "user-images: own select" on storage.objects;
create policy "user-images: own select" on storage.objects for select to authenticated
  using (bucket_id = 'user-images' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "user-images: own insert" on storage.objects;
create policy "user-images: own insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'user-images' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "user-images: own update" on storage.objects;
create policy "user-images: own update" on storage.objects for update to authenticated
  using (bucket_id = 'user-images' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'user-images' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "user-images: own delete" on storage.objects;
create policy "user-images: own delete" on storage.objects for delete to authenticated
  using (bucket_id = 'user-images' and (storage.foldername(name))[1] = auth.uid()::text);

/* ------------------------------------------------------------------ */
/* apply_tokens: the only way a balance changes (service role only)    */
/* ------------------------------------------------------------------ */

-- Atomic: locks the profile row, inserts the ledger row (a ref that already exists = already applied → returns the
-- current balance unchanged), updates the balance and returns it. Raises 'insufficient_tokens' when the result
-- would be negative and 'profile_not_found' for an unknown user.
create or replace function public.apply_tokens(p_user uuid, p_delta numeric, p_kind text, p_ref text, p_meta jsonb default '{}'::jsonb)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance numeric(12, 2);
  v_id bigint;
begin
  if p_ref is null or length(p_ref) = 0 then
    raise exception 'ref_required';
  end if;
  select balance into v_balance from public.profiles where id = p_user for update;
  if not found then
    raise exception 'profile_not_found';
  end if;
  if exists (select 1 from public.token_ledger where ref = p_ref) then
    return v_balance;
  end if;
  if v_balance + p_delta < 0 then
    raise exception 'insufficient_tokens';
  end if;
  insert into public.token_ledger (user_id, delta, kind, ref, meta)
  values (p_user, p_delta, p_kind, p_ref, coalesce(p_meta, '{}'::jsonb))
  on conflict (ref) do nothing
  returning id into v_id;
  if v_id is null then
    -- the same ref was applied concurrently: leave the balance as it is
    return v_balance;
  end if;
  update public.profiles set balance = balance + p_delta where id = p_user returning balance into v_balance;
  return v_balance;
end;
$$;

revoke all on function public.apply_tokens(uuid, numeric, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.apply_tokens(uuid, numeric, text, text, jsonb) to service_role;

revoke all on function public.handle_new_user() from public, anon, authenticated;
