-- jnj-record/1 record store: answers and accept/reject labels.
-- One CSV row = one jnj.answer row plus at most one jnj.label row.
-- Every foreign key between workspace-scoped tables carries workspace_id.
-- Missing confidence, tokens, cost or latency is NULL, never 0. An unlabelled answer has no label row.

create schema jnj;

create table jnj.workspace (
  id bigint generated always as identity primary key,
  slug text not null unique check (slug ~ '^[a-z0-9-]{1,64}$'),
  content_policy text not null default 'restricted'
    check (content_policy in ('synthetic', 'restricted')),
  unique (id, content_policy)
);
comment on column jnj.workspace.content_policy is
  'synthetic: may hold raw text (our own fixtures). restricted: case_input, question and file name keep only sha256 and length.';

create table jnj.import_file (
  id bigint generated always as identity primary key,
  workspace_id bigint not null,
  content_policy text not null,
  purpose text not null check (purpose in ('records', 'labels')),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  original_name_sha256 text not null check (original_name_sha256 ~ '^[0-9a-f]{64}$'),
  original_name_length integer not null check (original_name_length between 1 and 255),
  original_name text,
  loaded_at timestamptz not null default now(),
  constraint original_name_only_when_synthetic check (
    original_name is null
    or (content_policy = 'synthetic'
        and char_length(original_name) = original_name_length
        and encode(sha256(convert_to(original_name, 'UTF8')), 'hex') = original_name_sha256)),
  unique (workspace_id, file_sha256),
  unique (workspace_id, id),
  foreign key (workspace_id, content_policy) references jnj.workspace (id, content_policy)
);
comment on table jnj.import_file is
  'One loaded CSV. A records file creates its runs; a labels file only adds missing labels to loaded answers.';

create table jnj.run (
  id bigint generated always as identity primary key,
  workspace_id bigint not null,
  import_file_pk bigint not null,
  run_id text not null check (run_id ~ '^[A-Za-z0-9_.-]{1,64}$'),
  format_version text not null check (format_version = 'jnj-record/1'),
  unique (workspace_id, run_id),
  unique (workspace_id, id),
  unique (workspace_id, id, import_file_pk),
  foreign key (workspace_id, import_file_pk) references jnj.import_file (workspace_id, id)
);
comment on table jnj.run is 'One run comes from exactly one records file.';

create table jnj.question (
  id bigint generated always as identity primary key,
  workspace_id bigint not null,
  content_policy text not null,
  prompt_version text not null check (prompt_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
  question_id text not null check (question_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  question_sha256 text not null check (question_sha256 ~ '^[0-9a-f]{64}$'),
  question_length integer not null check (question_length >= 1),
  question text,
  answer_set text not null check (answer_set ~ '^[^|]+(\|[^|]+)+$'),
  constraint question_only_when_synthetic check (
    question is null
    or (content_policy = 'synthetic'
        and char_length(question) = question_length
        and encode(sha256(convert_to(question, 'UTF8')), 'hex') = question_sha256)),
  foreign key (workspace_id, content_policy) references jnj.workspace (id, content_policy),
  unique (workspace_id, prompt_version, question_id),
  unique (workspace_id, id),
  unique (workspace_id, id, question_id)
);
comment on column jnj.question.answer_set is
  'As written in the file. Fixed per (workspace, prompt_version, question_id); options spell it exactly, in order.';

create table jnj.answer_option (
  workspace_id bigint not null,
  question_pk bigint not null,
  position integer not null check (position >= 1),
  value text not null check (value <> '' and strpos(value, '|') = 0),
  primary key (workspace_id, question_pk, value),
  unique (workspace_id, question_pk, position),
  foreign key (workspace_id, question_pk) references jnj.question (workspace_id, id)
);

create table jnj.test_case (
  id bigint generated always as identity primary key,
  workspace_id bigint not null,
  content_policy text not null,
  run_pk bigint not null,
  case_id text not null check (case_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  case_input_sha256 text not null check (case_input_sha256 ~ '^[0-9a-f]{64}$'),
  case_input_length integer not null check (case_input_length between 1 and 8000),
  case_input text,
  constraint case_input_only_when_synthetic check (
    case_input is null
    or (content_policy = 'synthetic'
        and char_length(case_input) = case_input_length
        and encode(sha256(convert_to(case_input, 'UTF8')), 'hex') = case_input_sha256)),
  unique (run_pk, case_id),
  unique (workspace_id, run_pk, id),
  foreign key (workspace_id, run_pk) references jnj.run (workspace_id, id),
  foreign key (workspace_id, content_policy) references jnj.workspace (id, content_policy)
);
comment on column jnj.test_case.case_input is
  'Raw text, only in a synthetic workspace (CHECK plus the content_policy FK). Otherwise NULL; sha256 and length stay.';
comment on column jnj.test_case.case_input_sha256 is 'Hex sha256 of the UTF-8 bytes of case_input.';

create table jnj.answer (
  id bigint generated always as identity primary key,
  workspace_id bigint not null,
  import_file_pk bigint not null,
  run_pk bigint not null,
  case_pk bigint not null,
  question_pk bigint not null,
  question_id text not null,
  answerer_kind text not null check (answerer_kind in ('jev', 'rule', 'llm', 'human')),
  answerer_model text not null check (answerer_model <> ''),
  output text not null,
  -- exact: 1.00000000000000000001 is above 1 even though validate.py reads it as the float 1.0
  confidence numeric check (confidence between 0 and 1),
  tokens_in bigint check (tokens_in >= 0),
  tokens_out bigint check (tokens_out >= 0),
  cost_usd numeric check (cost_usd >= 0),
  latency_ms bigint check (latency_ms >= 0),
  source_line integer not null check (source_line >= 2),
  -- validate.py's duplicate key: (run_id, case_id, question_id, answerer), no prompt_version
  unique (run_pk, case_pk, question_id, answerer_kind),
  unique (import_file_pk, source_line),
  unique (workspace_id, id),
  foreign key (workspace_id, run_pk, import_file_pk) references jnj.run (workspace_id, id, import_file_pk),
  foreign key (workspace_id, run_pk, case_pk) references jnj.test_case (workspace_id, run_pk, id),
  foreign key (workspace_id, question_pk, question_id) references jnj.question (workspace_id, id, question_id),
  foreign key (workspace_id, question_pk, output) references jnj.answer_option (workspace_id, question_pk, value)
);
comment on column jnj.answer.cost_usd is 'NULL is a gap (cost unknown), never 0. A rule costs 0.';
comment on column jnj.answer.source_line is 'CSV line number in its import_file; export order is (import_file_pk, source_line).';

create table jnj.label (
  answer_pk bigint primary key,
  workspace_id bigint not null,
  import_file_pk bigint not null,
  verdict text not null check (verdict in ('accept', 'reject')),
  source text not null check (source = 'human'),
  labelled_at timestamptz not null default now(),
  foreign key (workspace_id, answer_pk) references jnj.answer (workspace_id, id),
  foreign key (workspace_id, import_file_pk) references jnj.import_file (workspace_id, id)
);

-- Options must spell the question's answer_set exactly, in order, at commit.
create function jnj.check_answer_set(p_workspace bigint, p_question bigint) returns void
language plpgsql as $$
declare
  expected text;
  spelled text;
  positions integer;
  options integer;
begin
  select answer_set into expected from jnj.question where workspace_id = p_workspace and id = p_question;
  if expected is null then
    return;
  end if;
  select string_agg(value, '|' order by position), max(position), count(*)
    into spelled, positions, options
    from jnj.answer_option where workspace_id = p_workspace and question_pk = p_question;
  if spelled is distinct from expected or positions is distinct from options then
    raise exception 'question % answer_set % does not match its options %', p_question, expected, spelled
      using errcode = 'check_violation';
  end if;
end $$;

create function jnj.check_question_answer_set() returns trigger language plpgsql as $$
begin
  perform jnj.check_answer_set(new.workspace_id, new.id);
  return null;
end $$;

create function jnj.check_option_answer_set() returns trigger language plpgsql as $$
begin
  perform jnj.check_answer_set(new.workspace_id, new.question_pk);
  return null;
end $$;

create constraint trigger answer_set_matches_options after insert on jnj.question
  deferrable initially deferred for each row execute function jnj.check_question_answer_set();
create constraint trigger options_match_answer_set after insert on jnj.answer_option
  deferrable initially deferred for each row execute function jnj.check_option_answer_set();

-- Records are append-only.
create function jnj.forbid_update() returns trigger language plpgsql as $$
begin
  raise exception 'UPDATE forbidden on %.%', tg_table_schema, tg_table_name;
end $$;

create trigger forbid_update before update on jnj.import_file for each statement execute function jnj.forbid_update();
create trigger forbid_update before update on jnj.run for each statement execute function jnj.forbid_update();
create trigger forbid_update before update on jnj.question for each statement execute function jnj.forbid_update();
create trigger forbid_update before update on jnj.answer_option for each statement execute function jnj.forbid_update();
create trigger forbid_update before update on jnj.test_case for each statement execute function jnj.forbid_update();
create trigger forbid_update before update on jnj.answer for each statement execute function jnj.forbid_update();
create trigger forbid_update before update on jnj.label for each statement execute function jnj.forbid_update();

-- The 18 format columns in format order, typed, plus the keys a reader needs.
-- Day 7 seam: metric views go in a later migration, in schema jnj_metrics, and read only this view.
create view jnj.record_v1 as
select
  r.format_version, r.run_id, q.prompt_version, c.case_id, c.case_input,
  a.question_id, q.question, q.answer_set, a.answerer_kind as answerer, a.answerer_model,
  a.output, a.confidence, l.verdict as label, l.source as label_source,
  a.tokens_in, a.tokens_out, a.cost_usd, a.latency_ms,
  a.workspace_id, a.import_file_pk, a.source_line, a.id as answer_pk,
  a.run_pk, a.case_pk, a.question_pk, c.case_input_sha256, c.case_input_length,
  q.question_sha256, q.question_length, l.labelled_at
from jnj.answer a
join jnj.run r on r.workspace_id = a.workspace_id and r.id = a.run_pk
join jnj.question q on q.workspace_id = a.workspace_id and q.id = a.question_pk
join jnj.test_case c on c.workspace_id = a.workspace_id and c.id = a.case_pk
left join jnj.label l on l.workspace_id = a.workspace_id and l.answer_pk = a.id;
comment on view jnj.record_v1 is
  'One row per answer. Decision point for pairing: (workspace_id, run_pk, case_pk, question_id).';

-- Load one staged file. The caller fills pg_temp.jnj_stage (line + the 18 columns as raw text,
-- empty string for an empty cell) in the same transaction. Nothing here is committed on error.
create function jnj.load_stage(p_workspace text, p_sha256 text, p_name text, p_purpose text)
returns table (status text, answers bigint, labels bigint)
language plpgsql as $$
declare
  ws jnj.workspace;
  prior jnj.import_file;
  file_pk bigint;
  bad record;
  n_answers bigint := 0;
  n_labels bigint := 0;
begin
  select * into ws from jnj.workspace w where w.slug = p_workspace;
  if not found then
    raise exception 'workspace % does not exist', p_workspace;
  end if;
  perform pg_advisory_xact_lock(hashtext('jnj.load'), ws.id::integer);

  select * into prior from jnj.import_file f where f.workspace_id = ws.id and f.file_sha256 = p_sha256;
  if found then
    if prior.purpose <> p_purpose then
      raise exception 'file sha256 % was already loaded as a % file', left(p_sha256, 12), prior.purpose;
    end if;
    return query select 'unchanged'::text, 0::bigint, 0::bigint;
    return;
  end if;
  insert into jnj.import_file (workspace_id, content_policy, purpose, file_sha256,
      original_name_sha256, original_name_length, original_name)
    values (ws.id, ws.content_policy, p_purpose, p_sha256, encode(sha256(convert_to(p_name, 'UTF8')), 'hex'), char_length(p_name),
      case when ws.content_policy = 'synthetic' then p_name end)
    returning id into file_pk;

  if p_purpose = 'labels' then
    -- every row must be an answer already loaded, identical apart from the label
    select s.line, s.run_id, s.case_id, s.question_id, s.answerer into bad
      from pg_temp.jnj_stage s
      left join jnj.record_v1 v on v.workspace_id = ws.id and v.run_id = s.run_id and v.case_id = s.case_id
        and v.question_id = s.question_id and v.answerer = s.answerer
      where v.answer_pk is null
         or not (v.format_version = s.format_version and v.prompt_version = s.prompt_version
                 and v.question_sha256 = encode(sha256(convert_to(s.question, 'UTF8')), 'hex') and v.answer_set = s.answer_set
                 and v.case_input_sha256 = encode(sha256(convert_to(s.case_input, 'UTF8')), 'hex')
                 and v.answerer_model = s.answerer_model and v.output = s.output
                 and v.confidence is not distinct from nullif(s.confidence, '')::numeric
                 and v.tokens_in is not distinct from nullif(s.tokens_in, '')::bigint
                 and v.tokens_out is not distinct from nullif(s.tokens_out, '')::bigint
                 and v.cost_usd is not distinct from nullif(s.cost_usd, '')::numeric
                 and v.latency_ms is not distinct from nullif(s.latency_ms, '')::bigint)
      order by s.line limit 1;
    if found then
      raise exception 'line %: row does not match a loaded answer (run %, case %, question %, answerer %); a labels file may only add labels to loaded rows',
        bad.line, bad.run_id, bad.case_id, bad.question_id, bad.answerer;
    end if;
    select s.line, s.case_id, s.question_id, s.answerer, v.label into bad
      from pg_temp.jnj_stage s
      join jnj.record_v1 v on v.workspace_id = ws.id and v.run_id = s.run_id and v.case_id = s.case_id
        and v.question_id = s.question_id and v.answerer = s.answerer
      where s.label <> '' and v.label is not null and v.label <> s.label
      order by s.line limit 1;
    if found then
      raise exception 'line %: label for (%, %, %) is already %; changing a label is rejected',
        bad.line, bad.case_id, bad.question_id, bad.answerer, bad.label;
    end if;
    insert into jnj.label (answer_pk, workspace_id, import_file_pk, verdict, source)
      select v.answer_pk, ws.id, file_pk, s.label, s.label_source
      from pg_temp.jnj_stage s
      join jnj.record_v1 v on v.workspace_id = ws.id and v.run_id = s.run_id and v.case_id = s.case_id
        and v.question_id = s.question_id and v.answerer = s.answerer
      where s.label <> '' and v.label is null;
    get diagnostics n_labels = row_count;
    return query select 'loaded'::text, 0::bigint, n_labels;
    return;
  end if;

  -- one run = one file
  select s.run_id, f.file_sha256 into bad
    from (select distinct run_id from pg_temp.jnj_stage) s
    join jnj.run r on r.workspace_id = ws.id and r.run_id = s.run_id
    join jnj.import_file f on f.workspace_id = ws.id and f.id = r.import_file_pk
    order by s.run_id limit 1;
  if found then
    raise exception 'run % is already loaded from file sha256 %; one run = one file: use a new run_id, or load labels as a labels file',
      bad.run_id, left(bad.file_sha256, 12);
  end if;
  insert into jnj.run (workspace_id, import_file_pk, run_id, format_version)
    select distinct ws.id, file_pk, s.run_id, s.format_version from pg_temp.jnj_stage s;

  -- answer_set: no repeated value, and fixed per (workspace, prompt_version, question_id)
  select s.line, s.answer_set into bad
    from pg_temp.jnj_stage s
    where (select count(*) <> count(distinct v) from unnest(string_to_array(s.answer_set, '|')) v)
    order by s.line limit 1;
  if found then
    raise exception 'line %: answer_set % repeats a value; each allowed answer appears once', bad.line, bad.answer_set;
  end if;
  select s.line, s.prompt_version, s.question_id, q.answer_set as was_set, s.answer_set as now_set into bad
    from pg_temp.jnj_stage s
    join jnj.question q on q.workspace_id = ws.id and q.prompt_version = s.prompt_version
      and q.question_id = s.question_id
    where q.question_sha256 <> encode(sha256(convert_to(s.question, 'UTF8')), 'hex') or q.answer_set <> s.answer_set
    order by s.line limit 1;
  if found then
    raise exception 'line %: question % under prompt_version % was loaded with different wording or answer_set (answer_set was %, now %); both are fixed per prompt_version, give the change a new prompt_version',
      bad.line, bad.question_id, bad.prompt_version, bad.was_set, bad.now_set;
  end if;
  with added as (
    insert into jnj.question (workspace_id, content_policy, prompt_version, question_id,
        question_sha256, question_length, question, answer_set)
      select distinct ws.id, ws.content_policy, s.prompt_version, s.question_id,
        encode(sha256(convert_to(s.question, 'UTF8')), 'hex'), char_length(s.question),
        case when ws.content_policy = 'synthetic' then s.question end, s.answer_set
      from pg_temp.jnj_stage s
      where not exists (select 1 from jnj.question q where q.workspace_id = ws.id
                          and q.prompt_version = s.prompt_version and q.question_id = s.question_id)
      returning id, answer_set)
  insert into jnj.answer_option (workspace_id, question_pk, position, value)
    select ws.id, added.id, o.position::integer, o.value
    from added cross join lateral unnest(string_to_array(added.answer_set, '|')) with ordinality as o(value, position);

  insert into jnj.test_case (workspace_id, content_policy, run_pk, case_id, case_input_sha256, case_input_length, case_input)
    select distinct on (r.id, s.case_id) ws.id, ws.content_policy, r.id, s.case_id,
      encode(sha256(convert_to(s.case_input, 'UTF8')), 'hex'), char_length(s.case_input),
      case when ws.content_policy = 'synthetic' then s.case_input end
    from pg_temp.jnj_stage s
    join jnj.run r on r.workspace_id = ws.id and r.run_id = s.run_id
    order by r.id, s.case_id, s.line;

  insert into jnj.answer (workspace_id, import_file_pk, run_pk, case_pk, question_pk, question_id,
      answerer_kind, answerer_model, output, confidence, tokens_in, tokens_out, cost_usd, latency_ms, source_line)
    select ws.id, file_pk, r.id, c.id, q.id, s.question_id, s.answerer, s.answerer_model, s.output,
      nullif(s.confidence, '')::numeric, nullif(s.tokens_in, '')::bigint, nullif(s.tokens_out, '')::bigint,
      nullif(s.cost_usd, '')::numeric, nullif(s.latency_ms, '')::bigint, s.line
    from pg_temp.jnj_stage s
    join jnj.run r on r.workspace_id = ws.id and r.run_id = s.run_id
    join jnj.test_case c on c.workspace_id = ws.id and c.run_pk = r.id and c.case_id = s.case_id
    join jnj.question q on q.workspace_id = ws.id and q.prompt_version = s.prompt_version
      and q.question_id = s.question_id
    order by s.line;
  get diagnostics n_answers = row_count;

  insert into jnj.label (answer_pk, workspace_id, import_file_pk, verdict, source)
    select a.id, ws.id, file_pk, s.label, s.label_source
    from pg_temp.jnj_stage s
    join jnj.answer a on a.workspace_id = ws.id and a.import_file_pk = file_pk and a.source_line = s.line
    where s.label <> '';
  get diagnostics n_labels = row_count;

  return query select 'loaded'::text, n_answers, n_labels;
end $$;
