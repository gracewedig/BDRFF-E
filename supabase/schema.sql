-- Black Desert Resort FF&E Tracker — Supabase setup
-- Run this whole file once in Supabase: Dashboard → SQL Editor → New query → Paste → Run.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  email text,
  role text not null default 'owner_relations' check (role in ('manager', 'owner_relations')),
  created_at timestamptz not null default now()
);

-- Create a profile automatically whenever someone signs up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)), new.email)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'manager');
$$;

-- ---------------------------------------------------------------- requests
create table if not exists public.requests (
  id uuid primary key default gen_random_uuid(),
  ticket_no bigint generated always as identity,
  project text not null check (project in ('The Terrace', 'The Cove', 'Resort Center', 'Pickleball', 'Waterpark')),
  buildings text not null,
  rooms text not null,
  item_needed text not null,
  ffe_tag text not null,
  spec text,
  quantity int not null default 1 check (quantity > 0),
  priority text not null default 'Normal' check (priority in ('Low', 'Normal', 'High', 'Urgent')),
  needed_by date not null,
  details text,
  photos jsonb not null default '[]'::jsonb,      -- [{ path, kind: 'concept' | 'damage', name }]
  status text not null default 'Pending'
    check (status in ('Pending', 'Approved', 'In Progress', 'Completed', 'Rejected', 'Cancelled')),
  requested_by uuid not null default auth.uid() references public.profiles (id),
  requester_name text,
  reviewed_by uuid references public.profiles (id),
  reviewer_name text,
  review_note text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Only managers may change review fields; requesters may only cancel their own pending request.
create or replace function public.guard_request_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_manager() then
    return new;
  end if;
  if old.requested_by <> auth.uid() or old.status <> 'Pending' then
    raise exception 'Only managers can change this request';
  end if;
  if new.status not in ('Pending', 'Cancelled')
     or new.reviewed_by is distinct from old.reviewed_by
     or new.review_note is distinct from old.review_note
     or new.requested_by <> old.requested_by then
    raise exception 'Requesters can only edit or cancel their own pending requests';
  end if;
  return new;
end $$;

drop trigger if exists guard_request_update on public.requests;
create trigger guard_request_update before update on public.requests
  for each row execute function public.guard_request_update();

-- ------------------------------------------------------------ action items
create table if not exists public.action_items (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title text not null default '',
  notes text,
  status text not null default 'Not Started' check (status in ('Not Started', 'In Progress', 'Waiting', 'Done')),
  priority text not null default 'Normal' check (priority in ('Low', 'Normal', 'High', 'Urgent')),
  due_date date,
  linked_ticket text,
  category text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------- saved views
create table if not exists public.saved_views (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  name text not null,
  prompt text,
  spec jsonb not null,
  pinned boolean not null default false,
  created_at timestamptz not null default now()
);

-- -------------------------------------------------------- row-level security
alter table public.profiles enable row level security;
alter table public.requests enable row level security;
alter table public.action_items enable row level security;
alter table public.saved_views enable row level security;

drop policy if exists "profiles readable by staff" on public.profiles;
create policy "profiles readable by staff" on public.profiles for select to authenticated using (true);
drop policy if exists "managers set roles" on public.profiles;
create policy "managers set roles" on public.profiles for update to authenticated
  using (public.is_manager() and id <> auth.uid()) with check (public.is_manager());

drop policy if exists "everyone sees requests" on public.requests;
create policy "everyone sees requests" on public.requests for select to authenticated using (true);
drop policy if exists "staff submit requests" on public.requests;
create policy "staff submit requests" on public.requests for insert to authenticated
  with check (requested_by = auth.uid() and status = 'Pending' and reviewed_by is null);
drop policy if exists "managers or requester update" on public.requests;
create policy "managers or requester update" on public.requests for update to authenticated
  using (public.is_manager() or (requested_by = auth.uid() and status = 'Pending'));
drop policy if exists "managers delete requests" on public.requests;
create policy "managers delete requests" on public.requests for delete to authenticated using (public.is_manager());

drop policy if exists "own action items" on public.action_items;
create policy "own action items" on public.action_items for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
drop policy if exists "managers read action items" on public.action_items;
create policy "managers read action items" on public.action_items for select to authenticated using (public.is_manager());

drop policy if exists "own saved views" on public.saved_views;
create policy "own saved views" on public.saved_views for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

-- ------------------------------------------------------------------ photos
insert into storage.buckets (id, name, public)
values ('ffe-photos', 'ffe-photos', false)
on conflict (id) do nothing;

drop policy if exists "staff view photos" on storage.objects;
create policy "staff view photos" on storage.objects for select to authenticated
  using (bucket_id = 'ffe-photos');
drop policy if exists "staff upload own photos" on storage.objects;
create policy "staff upload own photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'ffe-photos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "managers delete photos" on storage.objects;
create policy "managers delete photos" on storage.objects for delete to authenticated
  using (bucket_id = 'ffe-photos' and public.is_manager());

-- --------------------------------------------------------------- realtime
do $$
begin
  alter publication supabase_realtime add table public.requests;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.profiles;
exception when duplicate_object then null;
end $$;

-- ----------------------------------------------------- make the first manager
-- After you create your own account in the app, run this once (with your email):
--   update public.profiles set role = 'manager' where email = 'you@blackdesertresort.com';
-- From then on, managers can change everyone else's role inside the app (Team & Roles).
