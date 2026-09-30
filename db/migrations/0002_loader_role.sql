-- jnj_loader: loads and exports record files. NOLOGIN group role; grant it to a login role.
-- It may create a workspace (always restricted: only an admin marks one synthetic), insert
-- records and read them. No UPDATE, no DELETE. Roles are cluster-wide, so this is create-if-missing.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'jnj_loader') then
    create role jnj_loader nologin;
  elsif exists (select 1 from pg_roles where rolname = 'jnj_loader'
                and (rolcanlogin or rolsuper or rolcreaterole)) then
    raise exception 'role jnj_loader exists with LOGIN, SUPERUSER or CREATEROLE; it must be a NOLOGIN group role';
  end if;
end $$;

revoke all on schema jnj from public;
grant usage on schema jnj to jnj_loader;

grant select on all tables in schema jnj to jnj_loader;
grant insert (slug) on jnj.workspace to jnj_loader;
grant insert on jnj.import_file, jnj.run, jnj.question, jnj.answer_option, jnj.test_case, jnj.answer, jnj.label
  to jnj_loader;

revoke execute on all functions in schema jnj from public;
-- Functions created later by the migrating role are not executable by PUBLIC either. Per-schema
-- default privileges cannot revoke a global default, so this applies to the migrating role's
-- functions in this database.
alter default privileges revoke execute on functions from public;
grant execute on function jnj.load_stage(text, text, text, text) to jnj_loader;
grant execute on function jnj.check_answer_set(bigint, bigint) to jnj_loader;
