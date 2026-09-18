/* /family/ 子路径的应用外壳 Service Worker。
 *
 * 只做一件事：把根目录那一份外壳缓存逻辑（web/sw.js）原样引入，作用域限定在 /family/。
 * 不复制第二份缓存清单 —— 两份清单一定会漂移，漂移的那天离线打开就会拿到旧外壳。
 * 根 web/sw.js 内部全部用 self.location.origin 构造路径，因此从子路径引入不会错位。
 *
 * 家庭财务数据不在这里：/api/** 与隐私页面在任何情况下都不进 Cache Storage。
 */
importScripts("../sw.js");
