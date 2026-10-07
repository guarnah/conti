-- Conti: tabella dei dati con accesso riservato al proprietario.
-- Incolla tutto in Supabase → SQL Editor → New query → Run.

create table if not exists public.docs (
  user_id    uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  path       text        not null,
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, path)
);

alter table public.docs enable row level security;

drop policy if exists "docs: leggo solo i miei"      on public.docs;
drop policy if exists "docs: inserisco solo i miei"  on public.docs;
drop policy if exists "docs: modifico solo i miei"   on public.docs;
drop policy if exists "docs: cancello solo i miei"   on public.docs;
create policy "docs: leggo solo i miei"     on public.docs for select using (auth.uid() = user_id);
create policy "docs: inserisco solo i miei" on public.docs for insert with check (auth.uid() = user_id);
create policy "docs: modifico solo i miei"  on public.docs for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "docs: cancello solo i miei"  on public.docs for delete using (auth.uid() = user_id);

-- sincronizzazione in tempo reale tra telefono e PC
alter table public.docs replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;
