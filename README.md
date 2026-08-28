# 🔥 抖音火花助手（多人云端版）

自动检测好友火花剩余有效期，到期前自动发送消息续火花。网页扫码绑定抖音号，全免费架构（GitHub Pages + Supabase + GitHub Actions）。

## 架构
- **前端**：GitHub Pages 静态站点（`index.html` + `app.js`），适配手机与桌面
- **后端**：Supabase Edge Functions（Deno）+ Postgres，免费档
  - `login-qr`：把登录任务排队（二维码由 Actions worker 生成）
  - `login-poll`：轮询登录结果，确认后自动绑定会话
  - `refresh-spark`：拉取指定会话的火花状态并入库
  - `send-spark`：一键给好友发续火花消息
  - `daily-run`：遍历所有用户刷新火花 + 自动续火花（幂等，24h 冷却）
- **登录环境**：`.github/workflows/spark-login.yml` 用 GitHub Actions 免费额度跑真浏览器（Chromium）生成抖音二维码、等待扫码并保存登录态；每 2 分钟兜底检查一次排队任务，也可手动触发
- **自动触发**：`.github/workflows/cron-spark.yml` 每 6 小时调一次 `daily-run`；用户打开网页也会触发一次

## 首次部署（管理员）
1. **建表**：Supabase 控制台 → SQL Editor → 粘贴执行 `supabase/schema.sql`；另需执行：
   ```sql
   alter table public.login_states add column if not exists qrcode text;
   ```
2. **部署函数**：
   ```powershell
   $env:SUPABASE_ACCESS_TOKEN = "sbp_..."   # 你的 Supabase 访问令牌
   supabase functions deploy login-qr login-poll refresh-spark send-spark daily-run --project-ref <项目ID>
   ```
3. **GitHub Secrets**：
   - `SUPABASE_URL`、`SUPABASE_ANON_KEY`（定时任务用）
   - `SUPABASE_SERVICE_KEY`（登录 worker 写数据库用，管理端密钥，仅存 GitHub，不落库不公开）
4. **GitHub Pages**：仓库 Settings → Pages → 部署源选 `main` 分支根目录
5. **Supabase Auth**：Authentication → URL Configuration 的 Redirect URLs 添加 `https://<用户名>.github.io/<仓库名>/**`（邮箱登录/验证码需要）

## 用户使用
1. 打开网站 → 邮箱注册/登录
2. 「绑定抖音号」→ 等待约 1-2 分钟（Actions 启动登录环境）→ 手机抖音 App 扫码确认 → 自动绑定
3. 「立即检查」拉取所有好友火花状态
4. 到期前自动发送（可在设置里改提前天数、消息内容、开关自动发送）；也可以手动点「续火花」

## 隐私与安全
- 抖音登录态（cookies）加密存储在各自账号名下，行级安全（RLS）保证每个用户只能看到自己的数据
- `supabase/functions/_shared/templates.ts` 含协议身份数据，已加入 `.gitignore`，不入库
- 发送消息使用用户自己的账号，频率受 24h 冷却限制

## 目录
- `supabase/functions/` — Edge Functions 源码
- `supabase/schema.sql` — 数据库建表脚本（控制台手动执行）
- `worker/` — GitHub Actions 登录 worker（Playwright 真浏览器）
- `.github/workflows/` — spark-login（登录）/ spark-daily（定时续火花）
- `app.js / index.html / style.css / config.js` — 网页控制台
