-- Gravity RSVP / Evolution API database boundary
-- Run once in Supabase Dashboard > SQL Editor before the first Render deploy.
-- Evolution owns all tables inside this schema through its bundled Prisma
-- migrations. Do not create RSVP guest tables here; Google Sheets remains the
-- RSVP system of record.

create schema if not exists evolution_api authorization postgres;

-- Keep the Evolution schema out of Supabase's anonymous/authenticated API roles.
revoke all on schema evolution_api from anon, authenticated;

comment on schema evolution_api is
  'Private Evolution API v2.3.7 state. Not a Gravity RSVP guest database.';

-- AFTER the Render service has started successfully, run this read-only query
-- to verify that Evolution applied its migrations:
--
-- select table_name
-- from information_schema.tables
-- where table_schema = 'evolution_api'
-- order by table_name;
--
-- You should see _prisma_migrations plus Evolution-owned tables. Their exact
-- list belongs to the pinned Evolution version and must not be hand-maintained.
