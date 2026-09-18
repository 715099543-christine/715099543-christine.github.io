# legacy-check — 原「Check before you invest」投资核查工具归档

- 归档时间：2026-09-18（Asia/Hong_Kong），正式域名切换前冻结
- 来源：https://www.verityready.com/ 现行旧站（托管于 ChatGPT Sites / vinext，域名 CNAME custom-domains.chatgpt.site）
- 用途：部署新 Verity AI家庭CFO 后，原投资核查工具（/check 与 /check/result）迁移到 https://www.verityready.com/check/ 继续可用
- 迁移方式：旧站核查流程为纯客户端应用（React + sessionStorage，无服务端依赖），全部页面与构建资源静态归档，随 Cloudflare Pages 发布
- 完整性：SHA256SUMS.txt 对每个文件给出校验值；部署脚本将本目录装配到 dist/check/，并把 og.png 复制到站点根 /og.png 以兼容 RSC 内的绝对引用
- 版权与归属：归档为原站公开页面与静态资源快照，品牌归属 Verity 公司；仅用于本站点 /check/ 迁移，不改变原核查工具功能
- 重抓方法：curl https://www.verityready.com/check 与 /check/result，下载 /assets/*，将 /assets/ 与 /og.png 引用改写为相对路径；结果与当前 SHA256SUMS 比对
