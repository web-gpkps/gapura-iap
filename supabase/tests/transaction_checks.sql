begin;
do $test$
declare result jsonb; before_version bigint; before_rev bigint; before_baseline jsonb;
 token uuid:=gen_random_uuid(); failed boolean:=false;
begin
 if has_table_privilege('anon','public.iap_tracker','SELECT') or
 has_function_privilege('anon','public.iap_mutate(text,jsonb,date)','EXECUTE') or
 has_function_privilege('authenticated','public.iap_sync_config(text)','EXECUTE') or
 has_function_privilege('authenticated','public.iap_snapshot_since(bigint)','EXECUTE') or
 has_function_privilege('authenticated','public.iap_sync_baseline(uuid)','EXECUTE') or
 has_table_privilege('authenticated','public.iap_tracker_rev','SELECT')
 then raise exception 'Server-only access grants failed'; end if;
 select rev into before_rev from public.iap_tracker_rev where id;
 result:=public.iap_mutate('create_case',
 '{"iapId":"__IAP_TRANSACTION_TEST__","title":"Test","station":"CGK","steps":[
 {"step":"Test","action":"Test","pic":"A","timeline":"","targetDate":"9 Sep 2026",
 "status":"Belum Dimulai","progress":0,"actualDate":"","evidence":"","evidenceLink":""}],
 "context":{"incident":"Test incident","parties":"","purpose":"","effectiveDate":"","rootCause":"","kpis":["KPI"]}}',
 '2026-09-14');
 if not exists(select 1 from public.iap_tracker where iap_id='__IAP_TRANSACTION_TEST__'
 and incident='Test incident' and kpis='KPI' and stored_overdue='TERLAMBAT')
 then raise exception 'Atomic create/context/overdue failed'; end if;
 if (select rev from public.iap_tracker_rev where id) <= before_rev
 then raise exception 'Tracker write did not raise the rev'; end if;
 if public.iap_snapshot_since((select rev from public.iap_tracker_rev where id)) ? 'rows' or
 not public.iap_snapshot_since(before_rev) ? 'rows' or
 jsonb_array_length(public.iap_snapshot_since(null)->'rows') <> jsonb_array_length(public.iap_snapshot())
 then raise exception 'Snapshot since rev failed'; end if;
 select version into before_version from public.iap_tracker where iap_id='__IAP_TRANSACTION_TEST__';
 perform public.iap_mutate('update_step',
 '{"iapId":"__IAP_TRANSACTION_TEST__","stepNo":1,"input":{
 "step":"Test","action":"Test","pic":"B","timeline":"","targetDate":"9 Sep 2026",
 "status":"Selesai","progress":100,"actualDate":"14 Sep 2026","evidence":"","evidenceLink":""}}',
 '2026-09-14');
 if not exists(select 1 from public.iap_tracker where iap_id='__IAP_TRANSACTION_TEST__'
 and pic='B' and stored_overdue='-' and version>before_version)
 then raise exception 'Update/version/overdue failed'; end if;
 if public.iap_parse_date('9 September 2026') <> '2026-09-09'::date or
 public.iap_parse_date('9 Okt. 2026') <> '2026-10-09'::date or
 public.iap_merge_evidence('https://docs.google.com/document/d/abc/edit?usp=x',
 'https://docs.google.com/document/d/abc/preview') <> 'https://docs.google.com/document/d/abc/preview'
 then raise exception 'Date aliases or legacy evidence normalization failed'; end if;
 begin
  perform public.iap_mutate('append_evidence',
  '{"keys":[{"iapId":"__IAP_TRANSACTION_TEST__","stepNo":1},{"iapId":"__missing__","stepNo":1}],"link":"https://example.com/test"}',
  '2026-09-14');
 exception when others then failed:=true; end;
 if not failed or exists(select 1 from public.iap_tracker where iap_id='__IAP_TRANSACTION_TEST__' and evidence_link<>'')
 then raise exception 'Multi-key rollback failed'; end if;
 update public.iap_tracker set evidence_link='https://docs.google.com/document/d/abc/edit?usp=x'
 where iap_id='__IAP_TRANSACTION_TEST__';
 perform public.iap_mutate('append_evidence',
 '{"keys":[{"iapId":"__IAP_TRANSACTION_TEST__","stepNo":1}],"link":"https://docs.google.com/document/d/abc/preview"}',
 '2026-09-14');
 if not exists(select 1 from public.iap_tracker where iap_id='__IAP_TRANSACTION_TEST__'
 and evidence_link='https://docs.google.com/document/d/abc/preview')
 then raise exception 'Legacy evidence union failed'; end if;
 update public.iap_sync_state set next_run_at=now(),lease_token=null,lease_until=null where id;
 perform public.iap_sync_acquire(token);
 failed:=false;
 begin
  perform public.iap_sync_apply(token,jsonb_build_array(jsonb_build_object(
    'iapId','__IAP_TRANSACTION_TEST__','stepNo',1,'version',before_version,'cells',null)),'[]');
 exception when others then failed:=true; end;
 if not failed or not exists(select 1 from public.iap_tracker where iap_id='__IAP_TRANSACTION_TEST__')
 then raise exception 'Compare-and-set failed'; end if;
 perform public.iap_mutate('delete_case','{"iapId":"__IAP_TRANSACTION_TEST__"}','2026-09-14');
 if exists(select 1 from public.iap_tracker where iap_id='__IAP_TRANSACTION_TEST__')
 then raise exception 'Delete failed'; end if;
 perform public.iap_sync_finish(token,'[]','test quota backoff',120);
 if not exists(select 1 from public.iap_sync_state where next_run_at>=now()+interval '120 seconds')
 then raise exception 'Persistent Retry-After failed'; end if;
 select baseline into before_baseline from public.iap_sync_state where id;
 update public.iap_sync_state set next_run_at=now(),failures=0 where id;
 result:=public.iap_sync_acquire(token);
 if result ? 'baseline' or not result ? 'rev' or public.iap_sync_baseline(token) is distinct from before_baseline
 then raise exception 'Acquire must leave the baseline behind'; end if;
 perform public.iap_sync_finish(token);
 if (select baseline from public.iap_sync_state where id) is distinct from before_baseline or
 not exists(select 1 from public.iap_sync_state where failures=0 and last_error is null)
 then raise exception 'Idle finish must keep the baseline'; end if;
end $test$;
select 'CRUD, Jakarta overdue, context, version, rev, atomic rollback, CAS, idle sync, and grants passed' as verification;
rollback;
