-- ============================================================
-- 抖音火花助手 · 数据库表结构（在 Supabase Dashboard → SQL Editor 执行）
-- 说明：sbp_ 部署令牌没有数据库写权限，建表需在控制台手动执行本文件
-- 执行方式：Supabase 控制台 → SQL Editor → 粘贴全部 → Run
-- ============================================================

-- 0) 登录二维码状态（扫码绑定流程：login-qr 创建，login-poll 轮询）
create table if not exists login_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token text not null unique,                     -- 抖音二维码 token
  cookies_json jsonb not null default '{}'::jsonb, -- 二维码会话 cookies（轮询必须用同一份）
  status text not null default 'pending',          -- pending / scanned / confirmed / expired / canceled / bound
  sec_uid text,
  session_id uuid,                                 -- 绑定成功后生成的会话 id
  nickname text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_login_user on login_states(user_id);

-- 1) 抖音账号会话（每个用户可绑定多个抖音号）
create table if not exists douyin_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  douyin_uid text,
  douyin_sec_uid text,
  nickname text,
  avatar_url text,
  cookies_json jsonb not null default '{}'::jsonb,
  identity_token text,
  identity_device_id text,
  status text not null default 'active',        -- active / expired
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_sessions_user on douyin_sessions(user_id);
create index if not exists idx_sessions_status on douyin_sessions(status);

-- 2) 好友火花状态
create table if not exists friends (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references douyin_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id text,
  sec_uid text,
  uid text,
  nickname text,
  avatar_url text,
  days int not null default 0,
  real_days int not null default 0,
  level text not null default '',
  state int not null default 0,
  recover_ddl int not null default 0,
  expire_time bigint not null default 0,
  spark_json jsonb,
  last_sent_at timestamptz,
  send_count int not null default 0,
  is_active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique(session_id, conversation_id)
);
create index if not exists idx_friends_user on friends(user_id);
create index if not exists idx_friends_session on friends(session_id);

-- 3) 发送历史（自动/手动续火花记录）
create table if not exists send_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid references douyin_sessions(id) on delete set null,
  friend_id uuid references friends(id) on delete set null,
  conversation_id text,
  message text,
  trigger_type text not null default 'auto',    -- auto / manual
  status text not null default 'success',       -- success / failed / rate_limited
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists idx_history_user on send_history(user_id, created_at desc);

-- 4) 自动任务配置（每个用户可自定义提醒阈值与消息）
create table if not exists user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  auto_send boolean not null default true,      -- 是否自动续火花
  warn_ddl int not null default 3,              -- 剩余天数 <= 该值时提醒/发送
  message text not null default '火花要灭了，续一下🔥',
  notify_email boolean not null default false,  -- 邮件提醒（预留）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- 行级安全：每个用户只能访问自己的数据
-- ============================================================
alter table login_states enable row level security;
alter table douyin_sessions enable row level security;
alter table friends enable row level security;
alter table send_history enable row level security;
alter table user_settings enable row level security;

create policy "own login states" on login_states
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own sessions" on douyin_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own friends" on friends
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own history" on send_history
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own settings" on user_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 服务端（Edge Function 用 service role）不受 RLS 限制，可读写所有用户数据

-- ============================================================
-- 2026-08-29 新增：登录排队 + 二维码列（配合 GitHub Actions 真浏览器登录）
-- ============================================================
alter table login_states add column if not exists qrcode text;
alter table login_states add column if not exists mobile text;          -- 二次验证：接收短信的手机号（打码）
alter table login_states add column if not exists verify_hint text;     -- 二次验证：给用户看的提示文案
alter table login_states add column if not exists sms_code text;        -- 用户在前端输入的短信验证码（worker 填入页面）

-- 登录排队表：用户点「绑定抖音号」→ 排入队列 → Actions worker 认领处理
create table if not exists login_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending',  -- pending / processing / done / failed / canceled
  token text,                              -- 对应的 login_states.token
  error text,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_login_req_pending on login_requests(status, created_at);
create index if not exists idx_login_req_user on login_requests(user_id);
alter table login_requests enable row level security;
create policy "own login requests" on login_requests
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own login states read" on login_states
  for select using (auth.uid() = user_id);


-- ============================================================
-- 2026-08-31 新增：短信验证码登录状态（替代扫码登录，更稳定）
-- ============================================================
create table if not exists sms_login_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  phone text not null,                              -- 手机号
  verify_token text,                                -- 抖音返回的验证 token
  cookies_json jsonb not null default '{}'::jsonb,  -- 访问 douyin.com 获得的 cookies
  status text not null default 'pending',           -- pending / completed / expired
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_sms_login_user on sms_login_states(user_id);
create index if not exists idx_sms_login_phone on sms_login_states(phone);
alter table sms_login_states enable row level security;
create policy "own sms login states" on sms_login_states
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
