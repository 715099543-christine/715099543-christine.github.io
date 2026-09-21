/* 产品版本号（接口侧）——唯一来源是 ``web/version.json`` 的 ``product_version``。
 *
 * 为什么单独一个文件：Round 41 起 ``core.mjs`` 里写死 ``API_VERSION``，但每一轮升级
 * 产品版本（``web/version.json`` / ``dist/sw.js``）时都没人回来改它，于是正式域名上
 * ``/api/health`` 自报的版本比真实发布版本落后 3 个版本（e0.26.0 vs e0.29.0）——
 * 「拿版本号核对线上到底是哪一版」这条最基本的发布核查因此失效（Round 53 实测发现）。
 *
 * 现在的约束：本文件的 ``API_VERSION`` 必须与 ``web/version.json`` 的 ``product_version``
 * 逐字符相同，由 ``tests/test_version_sot.py`` 守住；升级版本时两个文件一起改。
 * 不要在这里读文件或环境变量：``api/`` 必须同时能在 Worker 与 Node 上跑。
 */
export const API_VERSION = "e0.34.0";
