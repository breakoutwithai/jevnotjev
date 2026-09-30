-- jnj_loader: loads and exports record files. NOLOGIN group role; grant it to a login role.
-- It may create a workspace (always restricted: only an admin marks one synthetic), insert
-- records and read them. No UPDATE, no DELETE. Roles are cluster-wide, so this is create-if-missing.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'jnj_loader') then
    create role jnj_loader nologin;
  elsif exists (select 1 from pg_roles where rolname = 'jnj_loader'
                and (rolcanlogin or rolsuper or rolcreaterole or rolcreatedb or rolreplication or rolbypassrls))
     or exists (select 1 from pg_auth_members where member = 'jnj_loader'::regrole) then
    raise exception 'role jnj_loader exists with LOGIN, SUPERUSER, CREATEROLE, CREATEDB, REPLICATION, BYPASSRLS or a role membership; it must be a plain NOLOGIN group role';
  end if;
end $$;

revoke all on schema jnj from public;
grant usage on schema jnj to jnj_loader;

grant select on all tables in schema jnj to jnj_loader;
grant insert (slug) on jnj.workspace to jnj_loader;
grant insert on jnj.import_file, jnj.run, jnj.question, jnj.answer_option, jnj.test_case, jnj.answer, jnj.label
  to jnj_loader;

grant execute on function jnj.load_stage(text, text, text, integer, text, text) to jnj_loader;
grant execute on function jnj.check_answer_set(bigint, bigint) to jnj_loader;
