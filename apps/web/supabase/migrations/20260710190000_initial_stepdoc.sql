create extension if not exists pgcrypto;
create table public.guides(id uuid primary key default gen_random_uuid(),title text not null default 'Untitled guide',description text default '',source_url text,is_public boolean not null default false,public_id uuid unique default gen_random_uuid(),created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table public.steps(id uuid primary key default gen_random_uuid(),guide_id uuid not null references public.guides(id) on delete cascade,position integer not null,type text not null check(type in('action','navigate','section','manual')),text text not null,page_url text,screenshot_path text,rendered_path text,click jsonb,element_meta jsonb,edits jsonb not null default '{"blur":[],"crop":null,"annotations":[]}',created_at timestamptz not null default now());
create index steps_guide_position_idx on public.steps(guide_id,position);
alter table public.guides enable row level security;alter table public.steps enable row level security;
revoke all on public.guides,public.steps from anon,authenticated;
insert into storage.buckets(id,name,public) values('screenshots','screenshots',true) on conflict(id) do update set public=true;
create policy "public screenshot reads" on storage.objects for select to anon,authenticated using(bucket_id='screenshots');
