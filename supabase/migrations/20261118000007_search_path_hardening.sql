-- Pin search_path on the three Phase 19–22 functions the Supabase security advisor flagged
-- (function_search_path_mutable). No behaviour change.
alter function enquiries_default_followup() set search_path = public;
alter function ca_rate(jsonb, int) set search_path = public;
alter function utrust_eligible(used_car_evaluations) set search_path = public;
