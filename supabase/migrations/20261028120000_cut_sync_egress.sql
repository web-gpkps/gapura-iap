-- Cuts the egress that got the project restricted. Every cron cycle downloaded the
-- whole tracker three times — the baseline handed out with the lease, then a
-- snapshot before and after reconciling — about 1.35 MB a minute while the data
-- sat unchanged. Dashboard renders downloaded it again on every refresh.
--
-- A revision counter, bumped in the same transaction as every tracker write, lets
-- the worker and the dashboard ask "anything new since rev N?" for a few bytes.
-- The baseline stays in the database and leaves it only when Sheets and Supabase
-- both changed since the last sync, the one case the three-way merge needs it.

create table public.iap_tracker_rev (
 id boolean primary key default true check(id),
 rev bigint not null default 0
);
insert into public.iap_tracker_rev(id) values(true);
alter table public.iap_tracker_rev enable row level security;
revoke all on public.iap_tracker_rev from public,anon,authenticated;
grant select,update on public.iap_tracker_rev to service_role;
create policy "server only" on public.iap_tracker_rev
 as restrictive for all to anon, authenticated using (false) with check (false);

-- Statement level, so an import of many rows bumps once. A statement that touches
-- no rows still bumps; that only costs one extra download, never a missed change.
create function public.iap_bump_rev() returns trigger
language plpgsql set search_path='' as $$
begin
 update public.iap_tracker_rev set rev=rev+1 where id;
 return null;
end $$;
revoke all on function public.iap_bump_rev() from public,anon,authenticated;
create trigger iap_tracker_rev
after insert or update or delete or truncate on public.iap_tracker
for each statement execute function public.iap_bump_rev();

-- One statement, so the rev and the rows share one MVCC snapshot: a write that
-- commits in between can never be tagged with a rev from before it.
create function public.iap_snapshot_since(p_rev bigint default null) returns jsonb
language sql stable set search_path='' as $$
 select case when p_rev is not distinct from t.rev then jsonb_build_object('rev',t.rev)
  else jsonb_build_object('rev',t.rev,'rows',public.iap_snapshot()) end
 from public.iap_tracker_rev t where t.id;
$$;
revoke all on function public.iap_snapshot_since(bigint) from public,anon,authenticated;
grant execute on function public.iap_snapshot_since(bigint) to service_role;

-- What the last successful sync saw: a fingerprint of the rows both sides agreed
-- on, and the tracker rev they were read at.
alter table public.iap_sync_state add column baseline_hash text, add column synced_rev bigint;

create or replace function public.iap_sync_acquire(p_token uuid, p_force boolean default false)
returns jsonb language plpgsql set search_path='' as $$
declare s public.iap_sync_state;
begin
 update public.iap_sync_state set lease_token=p_token,lease_until=now()+interval '5 minutes'
 where id
  and (next_run_at<=now() or (p_force and failures=0))
  and (lease_until is null or lease_until<now())
 returning * into s;
 if not found then return null; end if;
 -- The baseline stays behind; iap_sync_baseline hands it out only when a merge needs it.
 return jsonb_build_object('initialized',s.initialized,
  'baseline_count',jsonb_array_length(s.baseline),'baseline_hash',s.baseline_hash,
  'synced_rev',s.synced_rev,'rev',(select rev from public.iap_tracker_rev where id));
end $$;

create function public.iap_sync_baseline(p_token uuid) returns jsonb
language sql stable set search_path='' as $$
 select baseline from public.iap_sync_state where id and lease_token=p_token;
$$;
revoke all on function public.iap_sync_baseline(uuid) from public,anon,authenticated;
grant execute on function public.iap_sync_baseline(uuid) to service_role;

-- p_baseline is now optional. A cycle that found nothing to do finishes without
-- one, so the stored baseline, its hash, and its rev stay as they are and the
-- large jsonb is not rewritten every minute.
drop function public.iap_sync_finish(uuid,jsonb,text,integer);
create function public.iap_sync_finish(p_token uuid,p_baseline jsonb default null,p_error text default null,
 p_retry_after_seconds integer default 0,p_baseline_hash text default null,p_rev bigint default null)
returns void language plpgsql set search_path='' as $$
declare acknowledged boolean:=p_error is null and p_baseline is not null;
begin
 update public.iap_sync_state set
  baseline=case when acknowledged then p_baseline else baseline end,
  baseline_hash=case when acknowledged then p_baseline_hash else baseline_hash end,
  synced_rev=case when acknowledged then p_rev else synced_rev end,
  initialized=initialized or p_error is null,
  last_success_at=case when p_error is null then now() else last_success_at end,
  last_error=p_error, failures=case when p_error is null then 0 else failures+1 end,
  next_run_at=now()+case when p_error is null then interval '50 seconds'
    else greatest(coalesce(p_retry_after_seconds,0),least(3600,60*power(2,least(failures,6)))) * interval '1 second' end,
  lease_token=null,lease_until=null
 where id and lease_token=p_token;
 if not found then raise exception 'Sync lease lost'; end if;
end $$;
revoke all on function public.iap_sync_finish(uuid,jsonb,text,integer,text,bigint) from public,anon,authenticated;
grant execute on function public.iap_sync_finish(uuid,jsonb,text,integer,text,bigint) to service_role;

-- The Apps Script webhook carries live sheet edits, so the cron is the safety net
-- the README always meant it to be. App edits reach Sheets within five minutes.
-- Does nothing when the job has not been scheduled yet.
do $$
begin
 perform cron.alter_job(jobid, schedule := '*/5 * * * *') from cron.job where jobname='iap-google-mirror';
exception when insufficient_privilege then
 raise notice 'Could not reschedule iap-google-mirror; set it to */5 * * * * from the SQL editor.';
end $$;
