-- Black Desert Resort FF&E Tracker — Supabase setup
-- Run this whole file once in Supabase: Dashboard → SQL Editor → New query → Paste → Run.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  email text,
  role text not null default 'owner_relations' check (role in ('manager', 'owner_relations')),
  invited_at timestamptz,
  invited_by uuid,
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
  project text not null,
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
    check (status in ('Pending', 'Duplicate', 'Approved', 'In Progress', 'Fulfilled', 'Rejected', 'Cancelled')),
  requested_by uuid default auth.uid() references public.profiles (id) on delete set null,
  requester_name text,
  source text not null default 'app' check (source in ('app', 'email', 'import', 'document')),
  source_ref uuid,
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewer_name text,
  review_note text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------- settings: projects & options
-- Managers edit these on the Settings page.
create table if not exists public.app_settings (
  id int primary key default 1 check (id = 1),
  projects jsonb not null,       -- [{ name, subprojects: [...], aliases: [], archived }], e.g. a resort and its areas
  options jsonb not null default '{}'::jsonb,  -- { categories: [], locations: [], units: [] }
  updated_at timestamptz not null default now()
);
insert into public.app_settings (id, projects) values (1, '[
  {"name": "Black Desert Resort", "aliases": ["BDR"], "subprojects": ["The Terrace", "The Cove", "Resort Center", "Pickleball", "Waterpark"]},
  {"name": "Cornerstone", "aliases": [], "subprojects": []},
  {"name": "Sweetens Cove", "aliases": [], "subprojects": []},
  {"name": "Marcella", "aliases": [], "subprojects": []}
]'::jsonb) on conflict (id) do nothing;

-- Projects are now managed in app_settings, so drop the old fixed lists.
alter table public.requests drop constraint if exists requests_project_check;

-- Sub-projects, shared notes and follow-ups on every kind of item.
alter table public.requests add column if not exists sub_project text;
alter table public.requests add column if not exists notes text;
alter table public.requests add column if not exists notes_updated_at timestamptz;
alter table public.requests add column if not exists notes_updated_by_name text;
alter table public.requests add column if not exists follow_up_on date;
alter table public.requests add column if not exists follow_up_note text;
alter table public.requests add column if not exists follow_up_by_name text;

-- Only managers may change review fields; requesters may only cancel their own pending request.
create or replace function public.guard_request_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Managers, and changes made directly in the Supabase dashboard / SQL editor (no signed-in user).
  if auth.uid() is null or public.is_manager() then
    return new;
  end if;
  -- Anyone may add notes or a follow-up (through set_item_notes / set_follow_up).
  if (to_jsonb(new) - array['notes', 'notes_updated_at', 'notes_updated_by_name', 'follow_up_on', 'follow_up_note', 'follow_up_by_name', 'updated_at'])
     = (to_jsonb(old) - array['notes', 'notes_updated_at', 'notes_updated_by_name', 'follow_up_on', 'follow_up_note', 'follow_up_by_name', 'updated_at']) then
    return new;
  end if;
  if old.requested_by is distinct from auth.uid() or old.status not in ('Pending', 'Duplicate') then
    raise exception 'Only managers can change this request';
  end if;
  if new.status not in ('Pending', 'Duplicate', 'Cancelled')
     or new.reviewed_by is distinct from old.reviewed_by
     or new.review_note is distinct from old.review_note
     or new.priority is distinct from old.priority
     or new.requested_by is distinct from old.requested_by then
    raise exception 'Requesters can only edit or cancel their own pending requests';
  end if;
  return new;
end $$;

-- How the requester expects it to be filled, fulfilled history, duplicates of
-- earlier (rejected) requests, and the spec-sheet item and its price.
alter table public.requests add column if not exists fulfillment text check (fulfillment in ('attic', 'order', 'unsure'));
alter table public.requests add column if not exists fulfilled_at timestamptz;
alter table public.requests add column if not exists fulfilled_by_name text;
alter table public.requests add column if not exists duplicate_of uuid references public.requests (id) on delete set null;
alter table public.requests add column if not exists spec_item_id uuid;
alter table public.requests add column if not exists unit_price numeric(12, 2);

-- "Completed" is now called "Fulfilled"; requests can also wait in "Duplicate".
alter table public.requests drop constraint if exists requests_status_check;
update public.requests set status = 'Fulfilled', fulfilled_at = coalesce(fulfilled_at, updated_at) where status = 'Completed';
alter table public.requests add constraint requests_status_check
  check (status in ('Pending', 'Duplicate', 'Approved', 'In Progress', 'Fulfilled', 'Rejected', 'Cancelled'));

-- Managers set the priority after approving, so new requests from anyone else start at Normal.
create or replace function public.guard_request_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_manager() then
    new.priority := 'Normal';
  end if;
  return new;
end $$;
drop trigger if exists guard_request_insert on public.requests;
create trigger guard_request_insert before insert on public.requests
  for each row execute function public.guard_request_insert();

drop trigger if exists guard_request_update on public.requests;
create trigger guard_request_update before update on public.requests
  for each row execute function public.guard_request_update();

-- ------------------------------------------------- inventory & attic stock
create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  project text not null,
  stock_type text not null default 'Attic Stock' check (stock_type in ('Attic Stock', 'Inventory')),
  item_name text not null,
  ffe_tag text,
  category text,
  description text,
  location text,
  quantity int not null default 0 check (quantity >= 0),
  unit text not null default 'ea',
  min_qty int,
  vendor text,
  notes text,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.inventory_moves (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.inventory_items (id) on delete cascade,
  direction text not null check (direction in ('out', 'in')),
  quantity int not null check (quantity > 0),
  qty_after int not null,
  dest_sub_project text,
  dest_building text,
  dest_room text,
  linked_ticket text,
  note text,
  moved_by uuid default auth.uid() references public.profiles (id) on delete set null,
  moved_by_name text,
  moved_at timestamptz not null default now()
);
alter table public.inventory_items drop constraint if exists inventory_items_project_check;
alter table public.inventory_items add column if not exists sub_project text;
alter table public.inventory_items add column if not exists notes_updated_at timestamptz;
alter table public.inventory_items add column if not exists notes_updated_by_name text;

create index if not exists inventory_moves_item on public.inventory_moves (item_id, moved_at desc);

drop function if exists public.record_inventory_move(uuid, text, int, text, text, text, text, text);

-- Any signed-in staff member can take stock out (or put it back); the count and
-- the log entry are written together so they can't drift apart.
create or replace function public.record_inventory_move(
  p_item uuid, p_direction text, p_qty int,
  p_dest_sub_project text default null, p_dest_building text default null, p_dest_room text default null,
  p_ticket text default null, p_note text default null)
returns public.inventory_items language plpgsql security definer set search_path = public as $$
declare
  it public.inventory_items;
begin
  if auth.uid() is null then raise exception 'Please sign in'; end if;
  if p_direction not in ('out', 'in') then raise exception 'Direction must be out or in'; end if;
  if p_qty is null or p_qty < 1 then raise exception 'Quantity must be at least 1'; end if;
  select * into it from public.inventory_items where id = p_item for update;
  if not found then raise exception 'Item not found'; end if;
  if p_direction = 'out' and it.quantity < p_qty then
    raise exception 'Only % on hand', it.quantity;
  end if;
  update public.inventory_items
     set quantity = quantity + case when p_direction = 'out' then -p_qty else p_qty end, updated_at = now()
   where id = p_item returning * into it;
  insert into public.inventory_moves (item_id, direction, quantity, qty_after, dest_sub_project, dest_building, dest_room,
                                      linked_ticket, note, moved_by, moved_by_name)
  values (p_item, p_direction, p_qty, it.quantity, nullif(p_dest_sub_project, ''), nullif(p_dest_building, ''),
          nullif(p_dest_room, ''), nullif(p_ticket, ''), nullif(p_note, ''), auth.uid(),
          (select full_name from public.profiles where id = auth.uid()));
  return it;
end $$;
revoke all on function public.record_inventory_move from public, anon;
grant execute on function public.record_inventory_move to authenticated;

-- ---------------------------------------------------------- email requests
create table if not exists public.email_requests (
  id uuid primary key default gen_random_uuid(),
  message_id text unique,
  received_at timestamptz not null default now(),
  from_email text,
  from_name text,
  subject text,
  body text,
  attachments jsonb not null default '[]'::jsonb,   -- [{ path, kind, name }]
  project text,
  buildings text,
  rooms text,
  item_needed text,
  ffe_tag text,
  spec text,
  quantity int default 1,
  priority text default 'Normal',
  needed_by date,
  details text,
  ai_summary text,
  status text not null default 'New' check (status in ('New', 'Duplicate', 'Converted', 'Dismissed')),
  duplicate_of uuid references public.requests (id) on delete set null,
  duplicate_of_email uuid references public.email_requests (id) on delete set null,
  duplicate_reason text,
  match_score numeric,
  converted_request uuid references public.requests (id) on delete set null,
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewer_name text,
  reviewed_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.email_requests add column if not exists sub_project text;
alter table public.email_requests add column if not exists notes text;
alter table public.email_requests add column if not exists notes_updated_at timestamptz;
alter table public.email_requests add column if not exists notes_updated_by_name text;
alter table public.email_requests add column if not exists follow_up_on date;
alter table public.email_requests add column if not exists follow_up_note text;
alter table public.email_requests add column if not exists follow_up_by_name text;

-- Notes and follow-ups can be written by any signed-in staff member on any item,
-- even where they can't otherwise edit it.
create or replace function public.set_item_notes(p_table text, p_id uuid, p_notes text)
returns void language plpgsql security definer set search_path = public as $$
declare who text;
begin
  if auth.uid() is null then raise exception 'Please sign in'; end if;
  if p_table not in ('requests', 'inventory_items', 'email_requests') then raise exception 'Unknown item type'; end if;
  select full_name into who from public.profiles where id = auth.uid();
  execute format('update public.%I set notes = $1, notes_updated_at = now(), notes_updated_by_name = $2 where id = $3', p_table)
    using nullif(p_notes, ''), who, p_id;
end $$;
revoke all on function public.set_item_notes from public, anon;
grant execute on function public.set_item_notes to authenticated;

create or replace function public.set_follow_up(p_table text, p_id uuid, p_on date, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare who text;
begin
  if auth.uid() is null then raise exception 'Please sign in'; end if;
  if p_table not in ('requests', 'email_requests') then raise exception 'Unknown item type'; end if;
  select full_name into who from public.profiles where id = auth.uid();
  execute format('update public.%I set follow_up_on = $1, follow_up_note = $2, follow_up_by_name = case when $1 is null then null else $3 end where id = $4', p_table)
    using p_on, nullif(p_note, ''), who, p_id;
end $$;
revoke all on function public.set_follow_up from public, anon;
grant execute on function public.set_follow_up to authenticated;

-- When someone submits a ticket in the app that an emailed request already
-- describes, the email copy is filed as a duplicate so managers review it once.
create or replace function public.link_email_duplicate(p_email uuid, p_request uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Please sign in'; end if;
  update public.email_requests
     set status = 'Duplicate', duplicate_of = p_request,
         duplicate_reason = coalesce(p_reason, 'Also submitted in the app')
   where id = p_email and status = 'New';
end $$;
revoke all on function public.link_email_duplicate from public, anon;
grant execute on function public.link_email_duplicate to authenticated;

-- Requests can also come from uploaded documents (PDFs and spreadsheets).
alter table public.requests drop constraint if exists requests_source_check;
alter table public.requests add constraint requests_source_check check (source in ('app', 'email', 'import', 'document'));

-- ------------------------------------------------------------- spec sheet
-- The FF&E spec items people pick from on the request form, with item prices.
create table if not exists public.spec_items (
  id uuid primary key default gen_random_uuid(),
  project text not null,
  sub_project text,              -- empty = available in every sub-project
  name text not null,
  ffe_tag text,
  spec text,
  manufacturer text,
  vendor text,
  unit_price numeric(12, 2),
  unit text not null default 'ea',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists spec_items_project on public.spec_items (project, sub_project, name);

-- -------------------------------------------- uploaded files (PDFs, spreadsheets)
-- Kept with the project (and the sub-project they were uploaded to) so anyone can
-- open them later; sub_projects lists every sub-project their requests went to.
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  project text not null,
  sub_project text,
  sub_projects text[] not null default '{}',
  name text not null,
  kind text not null default 'other' check (kind in ('pdf', 'spreadsheet', 'other')),
  path text,
  size_bytes bigint,
  summary text,
  requests_created int not null default 0,
  uploaded_by uuid default auth.uid() references public.profiles (id) on delete set null,
  uploaded_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists documents_project on public.documents (project, created_at desc);

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
alter table public.inventory_items enable row level security;
alter table public.inventory_moves enable row level security;
alter table public.email_requests enable row level security;
alter table public.app_settings enable row level security;
alter table public.documents enable row level security;
alter table public.spec_items enable row level security;

drop policy if exists "everyone sees the spec sheet" on public.spec_items;
create policy "everyone sees the spec sheet" on public.spec_items for select to authenticated using (true);
drop policy if exists "managers edit the spec sheet" on public.spec_items;
create policy "managers edit the spec sheet" on public.spec_items for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

drop policy if exists "everyone sees documents" on public.documents;
create policy "everyone sees documents" on public.documents for select to authenticated using (true);
drop policy if exists "staff upload documents" on public.documents;
create policy "staff upload documents" on public.documents for insert to authenticated with check (uploaded_by = auth.uid());
drop policy if exists "uploader or manager edits documents" on public.documents;
create policy "uploader or manager edits documents" on public.documents for update to authenticated
  using (uploaded_by = auth.uid() or public.is_manager()) with check (uploaded_by = auth.uid() or public.is_manager());
drop policy if exists "uploader or manager deletes documents" on public.documents;
create policy "uploader or manager deletes documents" on public.documents for delete to authenticated
  using (uploaded_by = auth.uid() or public.is_manager());

drop policy if exists "everyone reads settings" on public.app_settings;
create policy "everyone reads settings" on public.app_settings for select to authenticated using (true);
drop policy if exists "managers edit settings" on public.app_settings;
create policy "managers edit settings" on public.app_settings for update to authenticated
  using (public.is_manager()) with check (public.is_manager());

-- Renaming a project (or sub-project) updates every record that uses it.
create or replace function public.rename_project(p_old text, p_new text, p_sub_old text default null, p_sub_new text default null)
returns void language plpgsql security definer set search_path = public as $$
declare t text;
begin
  if not public.is_manager() then raise exception 'Only managers can rename projects'; end if;
  foreach t in array array['requests', 'inventory_items', 'email_requests', 'spec_items'] loop
    if p_sub_old is null then
      execute format('update public.%I set project = $1 where project = $2', t) using p_new, p_old;
    else
      execute format('update public.%I set sub_project = $1 where project = $2 and sub_project = $3', t) using p_sub_new, p_old, p_sub_old;
    end if;
  end loop;
  if p_sub_old is not null then
    update public.inventory_moves m set dest_sub_project = p_sub_new
      from public.inventory_items i where i.id = m.item_id and i.project = p_old and m.dest_sub_project = p_sub_old;
  end if;
end $$;
revoke all on function public.rename_project from public, anon;
grant execute on function public.rename_project to authenticated;

drop policy if exists "everyone sees inventory" on public.inventory_items;
create policy "everyone sees inventory" on public.inventory_items for select to authenticated using (true);
drop policy if exists "managers manage inventory" on public.inventory_items;
create policy "managers manage inventory" on public.inventory_items for all to authenticated
  using (public.is_manager()) with check (public.is_manager());
drop policy if exists "everyone sees inventory log" on public.inventory_moves;
create policy "everyone sees inventory log" on public.inventory_moves for select to authenticated using (true);

drop policy if exists "everyone sees email requests" on public.email_requests;
create policy "everyone sees email requests" on public.email_requests for select to authenticated using (true);
drop policy if exists "managers review email requests" on public.email_requests;
create policy "managers review email requests" on public.email_requests for update to authenticated
  using (public.is_manager()) with check (public.is_manager());
drop policy if exists "managers delete email requests" on public.email_requests;
create policy "managers delete email requests" on public.email_requests for delete to authenticated using (public.is_manager());

drop policy if exists "profiles readable by staff" on public.profiles;
create policy "profiles readable by staff" on public.profiles for select to authenticated using (true);
drop policy if exists "managers set roles" on public.profiles;
create policy "managers set roles" on public.profiles for update to authenticated
  using (public.is_manager() and id <> auth.uid()) with check (public.is_manager());

drop policy if exists "everyone sees requests" on public.requests;
create policy "everyone sees requests" on public.requests for select to authenticated using (true);
drop policy if exists "staff submit requests" on public.requests;
create policy "staff submit requests" on public.requests for insert to authenticated
  with check (requested_by = auth.uid() and ((status in ('Pending', 'Duplicate') and reviewed_by is null) or public.is_manager()));
drop policy if exists "managers or requester update" on public.requests;
create policy "managers or requester update" on public.requests for update to authenticated
  using (public.is_manager() or (requested_by = auth.uid() and status in ('Pending', 'Duplicate')))
  -- What a requester may change (e.g. cancelling) is checked by guard_request_update.
  with check (public.is_manager() or requested_by = auth.uid());
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
values ('ffe-docs', 'ffe-docs', false)
on conflict (id) do nothing;

drop policy if exists "staff view documents" on storage.objects;
create policy "staff view documents" on storage.objects for select to authenticated
  using (bucket_id = 'ffe-docs');
drop policy if exists "staff upload own documents" on storage.objects;
create policy "staff upload own documents" on storage.objects for insert to authenticated
  with check (bucket_id = 'ffe-docs' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "uploader or manager deletes documents" on storage.objects;
create policy "uploader or manager deletes documents" on storage.objects for delete to authenticated
  using (bucket_id = 'ffe-docs' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_manager()));

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
declare t text;
begin
  foreach t in array array['profiles', 'inventory_items', 'inventory_moves', 'email_requests', 'app_settings', 'documents', 'spec_items'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ----------------------------------------------------- make the first manager
-- After you create your own account in the app, run this once (with your email):
--   update public.profiles set role = 'manager' where email = 'you@blackdesertresort.com';
-- From then on, managers invite, remove and change roles for everyone else inside the app (Team & Roles).
