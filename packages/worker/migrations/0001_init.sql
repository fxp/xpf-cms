-- xpf-cms D1: derived state only. Git (main) is the source of truth; `POST /api/reindex` rebuilds `items`.
create table if not exists items (
  ref             text primary key,          -- "howto/skill-state" | "buzzwords/106"
  type            text not null,
  slug            text not null,
  id              text,
  title           text,
  state           text,
  url_path        text,
  first_published text,
  last_updated    text,
  last_commit     text,
  indexed_at      text not null
);
create index if not exists items_type on items(type);

-- one row per publish attempt that reached the Worker (accepted or rejected)
create table if not exists audit (
  id         integer primary key autoincrement,
  ts         text not null,
  actor      text,
  origin     text,                           -- cli | ci | mcp
  verb       text,
  ref        text,
  branch     text,
  commit_sha text,
  status     text not null,                  -- committed | rejected | conflict | error
  detail     text
);
create index if not exists audit_ts on audit(ts);

-- post-commit pipeline instances (Workflow): deploy wait, verify, index
create table if not exists publishes (
  instance_id text primary key,
  ref         text not null,
  verb        text not null,
  branch      text not null,
  commit_sha  text not null,
  status      text not null,                 -- queued | deploying | verifying | done | failed
  created_at  text not null,
  updated_at  text not null,
  error       text
);
