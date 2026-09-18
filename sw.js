/* Verity 中文控制台 Service Worker（T-E0-030：手机端可安装与离线打开）。
 *
 * 职责边界（与页面内已有的运行时缓存严格分工，不重复缓存 7MB 运行时）：
 *   * 本 Worker 只缓存「应用外壳」：index.html 与其同级的 JS/CSS/清单/图标；
 *   * pyodide/ 运行时与 engine_bundle.js 仍由 zh.js 自己写进 verity-engine-*
 *     Cache Storage（预压缩通道，T-E0-028/029 已覆盖），
 *     首屏、离线打开都不与 Worker 重复下载；
 *   * 导航请求：网络优先，离线时回退到外壳缓存，保证「打开即用」；
 *   * 版本自适应：缓存名带 PRODUCT_VERSION，新版本 activate 时清掉旧外壳缓存。
 *
 * 缓存分区（T-E0-008 V-25-04）：外壳缓存只接受「外壳」这一分区的内容。
 *   * /api/** 与 /healthz 的响应一律不进外壳缓存，也不允许被外壳回退顶替；
 *   * 导航请求只有在目标本身是控制台页面、且响应确实是 text/html 时，才允许刷新
 *     index.html 外壳 —— JSON 或 API 响应在结构上不可能覆盖外壳。
 */

/* 唯一来源 web/version.json；改这里必须同步那里（tests/test_version_sot.py 守住）。 */
const PRODUCT_VERSION = "e0.26.0";
const CACHE_SCHEMA = "r34-production";
const SHELL_CACHE = `verity-zh-shell-v${PRODUCT_VERSION}-${CACHE_SCHEMA}`;

const SHELL_ASSETS = [
  "./index.html",
  "./landing.css",
  "./install-prompt.js",
  "./family/index.html",
  "./family/family.css",
  "./family/family-api.js",
  "./family/family-boot.js",
  "./family/manifest.webmanifest",
  "./family-insurance.js",
  "./family-insurance.css",
  "./hk-insurance-products.json",
  "./zh.js",
  "./zh.css",
  "./styles.css",
  "./verity-digest.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./check/index.html",
  "./check/result/index.html",
  "./assets/framework-DjPHiq1u.js",
  "./assets/index-Coo9Kkt_.css",
  "./assets/index-D77HOuzh.js",
  "./assets/layout-segment-context-D8DWrJ5V.js",
  "./assets/link-Ujj0SID-.js",
  "./assets/page-Bc3PxXF5.js",
  "./assets/page-DfwvNWI1.js",
  "./assets/page-gMGkmG5n.js",
  "./assets/rolldown-runtime-S-ySWqyJ.js",
  "./assets/router-DC3t58rz.js",
  "./og.png",
  "./privacy.html",
  "./terms.html",
];

/* 分区一：应用外壳（允许进缓存）。分区二：接口与健康检查（永不进缓存）。 */
const SHELL_PATHS = new Set(
  SHELL_ASSETS.map((one) => new URL(one, self.location.origin).pathname)
);
/* 预缓存请求同样回站根：cache.addAll() 的相对路径是相对脚本地址解析的。 */
const SHELL_REQUESTS = SHELL_ASSETS.map((one) => new URL(one, self.location.origin).href);
/* 只有这些页面算「zh 外壳入口」，导航响应才有资格刷新 index.html。
 *
 * S-27-05：/en.html 渲染的是英文外壳，把它留在这个集合里会让英文页面覆盖
 * 唯一的 ./index.html 缓存键，离线打开 `/` 时返回错配语言的页面。英文入口
 * 在线时正常透传；离线时不再冒充 zh 外壳（回退到 503 提示）。
 */
/* 首页（landing）与家庭CFO控制台（/family/）各自有独立的外壳键：
   离线时打开哪个入口，必须回它自己的那一份，不能互相冒充。 */
const SHELL_ENTRY_PATHS = new Set(["/", "/index.html", "/landing.html", "/zh", "/zh/", "/zh.html"]);
const FAMILY_ENTRY_PATHS = new Set(["/family", "/family/", "/family/index.html"]);
/* 缓存键一律按「站根」绝对化。/family/sw.js 用 importScripts 复用本文件，
   但相对路径在 Service Worker 里是按**脚本自身**解析的（./x 在子路径下会变成
   /family/x）。缓存键和预缓存清单都必须回站根，否则 /family/ 那份外壳会写到
   错误的键上、预缓存整批 404。 */
const SHELL_CACHE_KEYS = {
  shell: new URL("./index.html", self.location.origin).href,
  family: new URL("./family/index.html", self.location.origin).href,
};
const CHECK_ENTRY_PATHS = new Set(["/check", "/check/", "/check/result", "/check/result/"]);

function isApiRequest(url) {
  return url.pathname === "/healthz" || url.pathname.startsWith("/api/");
}

function isHtmlResponse(response) {
  if (!response || !response.headers || typeof response.headers.get !== "function") return false;
  return (response.headers.get("Content-Type") || "").toLowerCase().includes("text/html");
}

function offlineShellResponse() {
  return new Response("离线模式：当前没有网络，且应用外壳尚未缓存完成。联网后重试。", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        await cache.addAll(SHELL_REQUESTS);
      } catch (error) {
        /* 一个资源缺失不该让整个离线外壳装不上（装不上 = 永远无法离线打开）。
           逐个补装，缺哪个就如实报哪个，绝不因此静默跳过。 */
        const missed = [];
        for (const url of SHELL_REQUESTS) {
          try {
            await cache.add(url);
          } catch (err) {
            missed.push(url);
          }
        }
        if (missed.length) console.warn("[verity-sw] 外壳资源缺失，已跳过：", missed.join(", "));
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((name) => name.startsWith("verity-zh-shell-") && name !== SHELL_CACHE)
          .map((name) => caches.delete(name))
      );
      /* S-27-04：引擎运行时缓存按 SW（= 产品版本）激活周期清空。zh.js 的
       * 引擎缓存名不带版本号（verity-engine-v1），跨版本升级后旧 engine_bundle
       * 若不被清理，页面会继续加载旧算法代码；本 SW 每次随版本变更重新激活，
       * 这里把上一代的引擎运行时缓存全部清掉，强制下次加载重新下载。 */
      await Promise.all(
        keys
          .filter((name) => name.startsWith("verity-engine-"))
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  /* 运行时交给 zh.js 自己的 Cache Storage 管理；本 Worker 一律放行，避免双份存储。 */
  if (url.pathname.includes("/pyodide/")) return;
  /* 接口分区：既不读外壳缓存，也不写外壳缓存（T-E0-008 V-25-04）。 */
  if (isApiRequest(url)) return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(event.request);
          /* 只有「控制台页面 + HTML 响应」才允许刷新外壳；接口响应没有这条路径。 */
          if (fresh && fresh.ok && isHtmlResponse(fresh)) {
            if (FAMILY_ENTRY_PATHS.has(url.pathname)) {
              const cache = await caches.open(SHELL_CACHE);
              await cache.put(SHELL_CACHE_KEYS.family, fresh.clone());
            } else if (SHELL_ENTRY_PATHS.has(url.pathname)) {
              const cache = await caches.open(SHELL_CACHE);
              await cache.put(SHELL_CACHE_KEYS.shell, fresh.clone());
            }
          }
          return fresh;
        } catch (error) {
          if (CHECK_ENTRY_PATHS.has(url.pathname)) {
            const fallback = url.pathname.startsWith("/check/result")
              ? "./check/result/index.html"
              : "./check/index.html";
            return (await caches.match(fallback)) || offlineShellResponse();
          }
          const key = FAMILY_ENTRY_PATHS.has(url.pathname)
            ? SHELL_CACHE_KEYS.family
            : SHELL_ENTRY_PATHS.has(url.pathname)
              ? SHELL_CACHE_KEYS.shell
              : null;
          if (!key) return offlineShellResponse();
          const cached = await caches.match(key);
          if (cached) return cached;
          return offlineShellResponse();
        }
      })()
    );
    return;
  }

  if (event.request.method === "GET" && SHELL_PATHS.has(url.pathname)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(url.pathname);
        const network = fetch(event.request)
          .then((response) => {
            /* 只缓存自己的外壳资产：不缓存不透明响应、错误响应与他人分区的内容。 */
            if (response && response.ok && response.type !== "opaque") {
              const copy = response.clone();
              caches
                .open(SHELL_CACHE)
                .then((cache) => cache.put(url.pathname, copy))
                .catch(() => {});
            }
            return response;
          })
          .catch(() => cached);
        return cached || network;
      })()
    );
  }
});
