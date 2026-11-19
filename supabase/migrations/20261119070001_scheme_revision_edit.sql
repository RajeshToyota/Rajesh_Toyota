-- Edit and delete a scheme revision from the Schemes tab, which is now the only editor of schemes
-- and their lines (the raw /admin/schemes and /admin/scheme-line-items tables are gone).
--
-- update_scheme_revision edits a revision in place: its lines are updated by id, so their
-- conditions (scheme_conditions) and claim documents stay attached. A line that has claim documents
-- cannot be removed. The revision may not overlap another revision of the same scheme (same model,
-- suffixes and name).
-- p: {id, name, suffix_scope_list (array or null), valid_from, valid_to,
--     lines: [{id (omit for a new line), line_type, scheme_master_code, tkm_share, dealer_share,
--              prev_my_tkm_share, prev_my_dealer_share, is_customer_facing}]}
create or replace function update_scheme_revision(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := (p->>'id')::uuid;
  v_name text := nullif(trim(p->>'name'), '');
  v_from date := (p->>'valid_from')::date;
  v_to date := coalesce(nullif(p->>'valid_to', '')::date, date '2099-12-31');
  v_scope text[] := case when jsonb_typeof(p->'suffix_scope_list') = 'array'
                         then (select array_agg(x order by x) from jsonb_array_elements_text(p->'suffix_scope_list') x) end;
  v_model uuid;
  v_clash schemes%rowtype;
  v_keep uuid[];
  l jsonb;
begin
  if not (is_master_data_admin() or has_right('schemes', 'edit')) then
    raise exception 'You need Schemes: edit';
  end if;
  select model_id into v_model from schemes where id = v_id;
  if v_model is null then
    raise exception 'That scheme revision no longer exists';
  end if;
  if v_name is null or v_from is null then
    raise exception 'Scheme name and start date are required';
  end if;
  if v_to < v_from then
    raise exception 'The end date is before the start date';
  end if;
  if jsonb_typeof(p->'lines') <> 'array' or jsonb_array_length(p->'lines') = 0 then
    raise exception 'A scheme needs at least one line';
  end if;

  perform pg_advisory_xact_lock(hashtext('scheme:' || v_model || ':' || v_name));

  select * into v_clash from schemes
  where id <> v_id and model_id = v_model and name = v_name and suffix_scope_list is not distinct from v_scope
    and valid_from <= v_to and valid_to >= v_from
  order by valid_from limit 1;
  if v_clash.id is not null then
    raise exception 'The revision would overlap the one from % to %', v_clash.valid_from, v_clash.valid_to;
  end if;

  update schemes set name = v_name, suffix_scope_list = v_scope, valid_from = v_from, valid_to = v_to, updated_at = now()
  where id = v_id;

  -- Lines left out of p are removed, unless a claim document points at them.
  select coalesce(array_agg((x->>'id')::uuid), '{}') into v_keep
  from jsonb_array_elements(p->'lines') x where nullif(x->>'id', '') is not null;
  if exists (select 1 from scheme_claim_documents d join scheme_line_items i on i.id = d.scheme_line_item_id
             where i.scheme_id = v_id and i.id <> all (v_keep)) then
    raise exception 'A line you removed has claim documents; keep it or remove the documents first';
  end if;
  delete from scheme_line_items where scheme_id = v_id and id <> all (v_keep);

  for l in select * from jsonb_array_elements(p->'lines') loop
    if nullif(l->>'id', '') is not null then
      update scheme_line_items set
        line_type = coalesce(nullif(l->>'line_type', ''), (select name from scheme_master where code = l->>'scheme_master_code')),
        scheme_master_code = nullif(l->>'scheme_master_code', ''),
        tkm_share = coalesce((l->>'tkm_share')::numeric, 0),
        dealer_share = coalesce((l->>'dealer_share')::numeric, 0),
        prev_my_tkm_share = nullif(l->>'prev_my_tkm_share', '')::numeric,
        prev_my_dealer_share = nullif(l->>'prev_my_dealer_share', '')::numeric,
        is_customer_facing = coalesce((l->>'is_customer_facing')::boolean, true),
        updated_at = now()
      where id = (l->>'id')::uuid and scheme_id = v_id;
      if not found then
        raise exception 'A line of this revision no longer exists; reload and try again';
      end if;
    else
      insert into scheme_line_items (scheme_id, line_type, scheme_master_code, tkm_share, dealer_share,
                                     prev_my_tkm_share, prev_my_dealer_share, is_customer_facing)
      values (v_id, coalesce(nullif(l->>'line_type', ''), (select name from scheme_master where code = l->>'scheme_master_code')),
              nullif(l->>'scheme_master_code', ''), coalesce((l->>'tkm_share')::numeric, 0), coalesce((l->>'dealer_share')::numeric, 0),
              nullif(l->>'prev_my_tkm_share', '')::numeric, nullif(l->>'prev_my_dealer_share', '')::numeric,
              coalesce((l->>'is_customer_facing')::boolean, true));
    end if;
  end loop;
  return v_id;
end;
$$;

-- Deletes a revision (its lines and their conditions go with it). The revision just before it, if
-- it ran up to this one, runs on to this one's end date again, so the scheme has no gap. Refused
-- when a line has claim documents.
create or replace function delete_scheme_revision(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s schemes%rowtype;
begin
  if not (is_master_data_admin() or has_right('schemes', 'edit')) then
    raise exception 'You need Schemes: edit';
  end if;
  select * into s from schemes where id = p_id;
  if s.id is null then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtext('scheme:' || s.model_id || ':' || s.name));
  if exists (select 1 from scheme_claim_documents d join scheme_line_items i on i.id = d.scheme_line_item_id where i.scheme_id = p_id) then
    raise exception 'This revision has claim documents and cannot be deleted';
  end if;
  update schemes set valid_to = s.valid_to, updated_at = now()
  where model_id = s.model_id and name = s.name and suffix_scope_list is not distinct from s.suffix_scope_list
    and valid_to = s.valid_from - 1;
  delete from schemes where id = p_id;
end;
$$;

revoke execute on function update_scheme_revision(jsonb) from public, anon;
revoke execute on function delete_scheme_revision(uuid) from public, anon;
grant execute on function update_scheme_revision(jsonb) to authenticated;
grant execute on function delete_scheme_revision(uuid) to authenticated;
