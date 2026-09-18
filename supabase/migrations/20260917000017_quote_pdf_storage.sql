-- Storage bucket for generated quote PDFs. Objects are stored at
-- `<employee_id>/<quote_id>.pdf`, so visibility can be scoped by the same
-- can_access_employee_data() hierarchy-walk used everywhere else, keyed off the first path
-- segment (the uploading employee's id) rather than duplicating quote-row lookups here.

insert into storage.buckets (id, name, public)
values ('quote-pdfs', 'quote-pdfs', false)
on conflict (id) do nothing;

create policy quote_pdfs_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'quote-pdfs'
    and can_access_employee_data(current_employee_id(), ((storage.foldername(name))[1])::uuid)
  );

create policy quote_pdfs_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'quote-pdfs'
    and ((storage.foldername(name))[1])::uuid = current_employee_id()
  );

create policy quote_pdfs_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'quote-pdfs'
    and ((storage.foldername(name))[1])::uuid = current_employee_id()
  );

create policy quote_pdfs_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'quote-pdfs'
    and can_access_employee_data(current_employee_id(), ((storage.foldername(name))[1])::uuid)
  );
