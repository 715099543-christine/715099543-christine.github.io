# r71 · 正式站点 /api/ 侧代码合入说明（找回口令）

## 背景
静态侧已经与权威镜像对齐（version.json = e0.34.0）。但 /family/ 页面上的「忘记口令」
需要三个新接口，正式域名的 /api/ 侧代码还是上一版，现在返回 404：

    POST /api/auth/recovery          （已登录用户补发恢复码）
    POST /api/auth/recovery/begin    （验恢复码，取回端侧密文）
    POST /api/auth/recovery/reset    （换口令 + 写回重加密档案 + 签发新会话）

因此必须把这四个文件按本次提供的权威版本合入站点项目的 /api/ 侧代码。
**除这四个文件外不要动任何东西**，特别是：静态资源绑定、路由（www 301 / /device* 301 /
/family → /family/index.html 目录回落）、D1 绑定名、Worker Secret 名称，全部保持原样。

## 要合入的文件（直接取用，不要自行改写）
| 站点项目里的路径 | 取这个地址 |
|---|---|
| api/core.mjs | https://715099543-christine.github.io/_agent-merge/r71/core.mjs |
| api/store.mjs | https://715099543-christine.github.io/_agent-merge/r71/store.mjs |
| api/version.mjs | https://715099543-christine.github.io/_agent-merge/r71/version.mjs |
| （数据库建表语句所在文件，通常是 worker 入口） | 按下面 §数据库 手工加 4 行，**不要整体替换** |

`core.mjs` 与 `store.mjs` 都是运行时无关的纯逻辑文件（不 import 任何 Node 专有模块），
在两个适配器上跑的是同一套语义；`store.mjs` 只是新增了三个方法，既有方法逐字未改。

## 数据库：老库必须补列（4 行，幂等）
本项目此前执行建表用的是 `CREATE TABLE IF NOT EXISTS` 一类的语句，它**不会给已存在的表补列**。
在「建表语句执行之后」追加下面四条，每条单独 try/catch（重复执行会报 duplicate column，
忽略即可；这些列都有默认值，老用户不会丢数据）：

    ALTER TABLE users ADD COLUMN recovery_salt TEXT NOT NULL DEFAULT ''
    ALTER TABLE users ADD COLUMN recovery_wrap TEXT NOT NULL DEFAULT ''
    ALTER TABLE users ADD COLUMN recovery_verifier TEXT NOT NULL DEFAULT ''
    ALTER TABLE users ADD COLUMN recovery_iter INTEGER NOT NULL DEFAULT 0

注意：不要整体替换 worker 入口文件——上一轮线上事故（r69：D1 绑定不提供 exec() 导致
全部 /api/** 熔断）就是出在这一层。只加这 4 行、且必须走 prepare(sql).run() 的能力探测路径。

## 发布后必须实测并回报（缺一不可）
1. `POST https://verityready.com/api/auth/recovery/begin`
   body `{"email":"probe@example.com","recovery_code":"AAAAAAAAAAAAAAAAAAAA"}`
   → 期望 **401**，响应体 `{"error":{"code":"unauthenticated",...}}`（**不是 404**）。
2. `GET https://verityready.com/api/health` → 期望 `{"ok":true,"version":"e0.34.0",...}`；
   `GET https://verityready.com/api/healthz` → 期望 `{"ok":true,"database":"ready",...}`。
3. 注册一个测试账号并登录一次，确认老功能没坏：
   `POST /api/auth/register` 应返回 201，`GET /api/auth/me` 应返回 200。
4. 报回：Sites 版本号、发布完成时间。

## 失败即回滚
若第 2 或第 3 步任何一项不通过（例如 /api/health 非 200、healthz 不是 database ready、
注册返回 5xx），**立即把站点回滚到上一个可用版本（版本 14）**，然后如实报告失败点，
不要带着坏掉的接口对外发布。
