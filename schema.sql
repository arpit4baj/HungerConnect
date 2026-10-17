-- HungerConnect: PostgreSQL / Supabase schema
create type user_role as enum ('donor','ngo','volunteer','admin');
create type donation_status as enum ('available','requested','accepted','picked_up','delivered','expired','removed');

create table profiles (            -- one row per auth.users row
  id uuid primary key references auth.users on delete cascade,
  role user_role not null, name text not null check (length(name)>1),
  phone text, address text, lat double precision, lng double precision,
  verified boolean not null default false,       -- NGOs need admin verification
  capacity int check (capacity >= 0),            -- NGO beneficiary capacity
  created_at timestamptz not null default now());

create table verification_documents (
  id bigserial primary key, profile_id uuid not null references profiles on delete cascade,
  file_path text not null, status text not null default 'pending', created_at timestamptz default now());

create table donations (
  id bigserial primary key, donor_id uuid not null references profiles,
  name text not null, food_type text not null, servings int not null check (servings between 1 and 1000),
  weight_kg numeric check (weight_kg > 0),       -- null = not measured (impact uses estimate)
  prepared_at timestamptz not null, expires_at timestamptz not null,
  storage_info text not null, allergens text, image_path text,
  pickup_address text not null, lat double precision, lng double precision,
  status donation_status not null default 'available',
  ngo_id uuid references profiles, volunteer_id uuid references profiles,
  proof_note text, proof_path text, flagged boolean default false,
  created_at timestamptz not null default now(),
  check (expires_at > prepared_at));

create table donation_requests (
  id bigserial primary key, donation_id bigint not null references donations on delete cascade,
  ngo_id uuid not null references profiles, status text not null default 'pending',
  created_at timestamptz default now());
-- Prevents two organizations from claiming the same donation:
create unique index one_active_request on donation_requests(donation_id) where status in ('pending','accepted');

create table notifications (id bigserial primary key, user_id uuid not null references profiles,
  message text not null, read boolean default false, created_at timestamptz default now());
create table reports (id bigserial primary key, donation_id bigint references donations,
  reporter_id uuid references profiles, reason text not null, status text default 'open', created_at timestamptz default now());

-- Expiry: run every 5 min with pg_cron
-- select cron.schedule('expire','*/5 * * * *',$$update donations set status='expired' where status in ('available','requested') and expires_at < now()$$);

-- Row-level security (examples; repeat for other tables)
alter table donations enable row level security;
create policy "read available" on donations for select using (status='available' or donor_id=auth.uid() or ngo_id=auth.uid() or volunteer_id=auth.uid());
create policy "donor writes own" on donations for all using (donor_id=auth.uid()) with check (donor_id=auth.uid());
alter table profiles enable row level security;
create policy "own profile" on profiles for select using (id=auth.uid());
