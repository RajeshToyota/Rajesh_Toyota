-- Storage bucket for booking signature captures, mirroring quote-pdfs' access pattern:
-- objects live at `<employee_id>/<booking_id>.png`, scoped by can_access_employee_data() keyed
-- off the first path segment.

insert into storage.buckets (id, name, public)
values ('booking-signatures', 'booking-signatures', false)
on conflict (id) do nothing;

create policy booking_signatures_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'booking-signatures'
    and can_access_employee_data(current_employee_id(), ((storage.foldername(name))[1])::uuid)
  );

create policy booking_signatures_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'booking-signatures'
    and ((storage.foldername(name))[1])::uuid = current_employee_id()
  );

create policy booking_signatures_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'booking-signatures'
    and ((storage.foldername(name))[1])::uuid = current_employee_id()
  );

create policy booking_signatures_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'booking-signatures'
    and can_access_employee_data(current_employee_id(), ((storage.foldername(name))[1])::uuid)
  );
