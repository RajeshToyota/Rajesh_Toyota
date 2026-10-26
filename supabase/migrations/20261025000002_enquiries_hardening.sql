-- Security advisor follow-up to 20261025000001: pin normalize_mobile's search_path, and stop the
-- enquiry stage triggers being callable as RPCs (Supabase grants authenticated EXECUTE by default;
-- triggers need no grant to fire).
alter function normalize_mobile(text) set search_path = public;
revoke execute on function enquiries_follow_quote() from authenticated;
revoke execute on function enquiries_follow_booking() from authenticated;
