/* Verity 家庭财富引擎 E0 — 中文控制台客户端。
   同一份 engine/ 代码通过两条通道执行：
     1) 后端通道：本机 python3 -m api.server 提供的 POST /api/v0/analyze
     2) 浏览器通道：Pyodide 在浏览器内直接运行 engine/*.py（静态部署时使用）
   两条通道执行的是同一个引擎，页面不产生任何外部网络请求。 */

"use strict";

const $ = (id) => document.getElementById(id);
const nowMs = () => (window.performance && window.performance.now ? window.performance.now() : Date.now());
const esc = (s) =>
  s === null || s === undefined
    ? ""
    : String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const numAttr = (value) =>
  typeof value === "number" && Number.isFinite(value) ? String(value) : "";
const fmt = (n, d = 2) =>
  n === null || n === undefined || Number.isNaN(Number(n))
    ? "—"
    : Number(n).toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (n) => (n === null || n === undefined ? "—" : fmt(n, 0));
const pct = (n, d = 1) => (n === null || n === undefined ? "—" : `${(Number(n) * 100).toFixed(d)}%`);
const days = (n) => (n === null || n === undefined ? "—" : `${fmt(n, 1)} 天`);
const num = (v) => {
  if (v === "" || v === null || v === undefined) return 0;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : 0;
};

const VERDICT_CN = { PASS: "通过 PASS", REVIEW: "需复核 REVIEW", REFUSE: "拒绝 REFUSE", ABSTAIN: "信息不足 ABSTAIN" };
const VERDICT_TEXT_CN = {
  PASS: "目标落在家庭可承受的风险预算之内，可以进入模拟。",
  REVIEW: "目标可能成立，但缓冲很窄或证据需要人工复核。",
  REFUSE: "目标在结构上与这个家庭能承受的风险冲突。",
  ABSTAIN: "证据不足或不一致，Verity 拒绝下判断。",
};
const ACTION_CN = {
  INCREASE_ALLOCATION: "提高投资比例",
  REDUCE_RISK: "降低风险",
  HEDGE: "购买保护",
  REBALANCE: "再平衡",
  HOLD: "维持不动",
  ABSTAIN: "不下结论 ABSTAIN",
};
const ACTION_TEXT_CN = {
  INCREASE_ALLOCATION: "家庭长期增长层过薄，可以把更多资产负债表投入长期目标。",
  REDUCE_RISK: "在生存缓冲越过阈值之前，先降低风险。",
  HEDGE: "某个压力情景会击穿生存底线，先买保护。",
  REBALANCE: "持仓偏离政策配置过多，先回到政策配置。",
  HOLD: "当前配置在容忍范围内，今天不需要动作。",
  ABSTAIN: "无法为这个家庭给出可信的结论。",
};
const LAYER_CN = [
  ["survival", "生存基石", "cash"],
  ["near_term_duty", "近期刚性责任", "bond"],
  ["protection", "风险保护", "prot"],
  ["long_term_growth", "长期增长", "index"],
  ["high_risk_opportunity", "高风险机会", "equity"],
];
const SCENARIO_CN = {
  income_interruption: "收入中断 3 个月",
  equity_crash: "权益市场大幅下跌",
  rate_change: "利率向不利方向变动",
  medical_shock: "大额未覆盖医疗事件",
  fx_change: "记账币种走强削弱外币资产",
  inflation_spiral: "通胀螺旋：成本上涨＋债务重定价",
  income_concentration: "单一收入依赖：最大收入流中断 12 个月",
  combined_multi_risk: "暴跌＋利率＋医疗＋收入中断同时发生",
};
const SEVERITY_CN = { low: "低", medium: "中", high: "高", critical: "严重" };
const CATEGORY_CN = {
  insurance: "保险", cash: "现金", liquidity: "流动性", asset: "资产", assets: "资产",
  debt: "债务", legal: "法律", social: "社会保障", market: "市场", income: "收入", health: "健康",
};
const STATUS_CN = {
  ACTIVE: "已触发", INACTIVE: "未触发", SECURED: "已覆盖", GAP: "存在缺口",
  NOT_RECORDED: "未记录", REVIEW: "需复核", OK: "已覆盖", GAPS: "存在缺口",
  PASS: "通过", REFUSE: "拒绝", ABSTAIN: "信息不足", RANKED: "已排序",
  FUNDED: "已补足", DEFICIT: "存在赤字", COVERED: "已覆盖", PARTIAL: "部分覆盖",
  NOT_APPLICABLE: "不适用", IMMEDIATE: "立即可用", NEAR: "近期可用", CANNOT_TOUCH: "无法动用",
  OPEN: "存在缺口", SURVIVES: "可以撑住", STRESSED: "被压到临界", COLLAPSES: "会击穿底线",
  PROTECTED: "已隔离", AT_RISK: "部分情景受挤占", UNFUNDED: "无法隔离",
  SHARED: "多人分担", SINGLE_POINT_OF_FAILURE: "单一收入点", UNKNOWN: "无法判断",
};
const ROLE_CN = { primary_earner: "主要收入来源", secondary_earner: "次要收入来源", dependent: "受抚养成员" };
const STABILITY_CN = { high: "稳定", medium: "一般", low: "不稳定" };
const cn = (table, key, fallback) => table[key] || fallback || key || "—";
/* 中文优先 + 机器码保留：给人看的词是中文，契约里的机器码原样跟在后面。 */
const cnCode = (table, key) => (key ? `${cn(table, key, key)}（${key}）` : "—");

/* ------------------------------------------------------------------ 中文优先 + 机器码保留 (T-E0-041)
   页面上的引擎英文原句由 web/i18n_zh.json 契约翻译成中文；翻译仅作用于渲染层，
   不触碰结果 JSON，因此快照哈希 / 审计链 / 原始证据不受影响。
   zhSentence(entry, sentence)：entry = {pattern?, cn}；pattern 命中后把 {0}{1}
   占位符替换为捕获值；pattern 缺省 = 整句静态翻译。占位符没被替换完视为未命中。 */
const VERITY_I18N = window.VERITY_I18N || {};
function zhSentence(entry, sentence) {
  if (!entry) return { cn: "", matched: false };
  const template = entry.cn || "";
  if (entry.match !== undefined && String(sentence || "") !== entry.match) {
    return { cn: "", matched: false };
  }
  if (!entry.pattern) return { cn: template, matched: true };
  const m = String(sentence || "").match(new RegExp(entry.pattern, "m"));
  if (!m) return { cn: "", matched: false };
  let out = template;
  for (let i = 1; i < m.length; i += 1) out = out.split(`{${i - 1}}`).join(m[i]);
  if (/\{\d+\}/.test(out)) return { cn: "", matched: false };
  return { cn: out, matched: true };
}
function zhFirstMatch(entries, sentence) {
  for (const entry of entries || []) {
    const hit = zhSentence(entry, sentence);
    if (hit.matched) return hit.cn;
  }
  return "";
}
/* 可读文本里是否含连续英文（用于判断某字段是否需要翻译；中文句子里的 P0/P1、
   币种码等单 token 不算） */
function looksEnglish(text) {
  return /[A-Za-z]{2,}[^\u4e00-\u9fff]{2,}[A-Za-z]{2,}/.test(String(text || ""));
}


const ASSET_ROWS = [
  ["cash", "现金与存款", "immediate", "可立即动用的活期、货币基金"],
  ["bond", "债券与债券基金", "near", "流动性较好的固收类资产"],
  ["global_index", "全球指数基金", "near", "宽基指数类资产"],
  ["equity", "股票与权益基金", "near", "单一市场或行业权益"],
  ["gold", "黄金", "near", "黄金及其相关资产"],
  ["option_protection", "期权保护头寸", "near", "为组合购买的保护性头寸"],
  ["insurance_linked", "保险连结资产", "cannot_touch", "与保险绑定的资产"],
  ["illiquid", "非流动 / 无法动用", "cannot_touch", "自住房、经营资产等危机中无法动用"],
];
const LIABILITY_ROWS = [
  ["mortgage", "房贷"],
  ["consumer", "消费贷 / 信用贷"],
  ["margin", "保证金 / 融资"],
  ["student", "教育贷款"],
  ["other", "其他负债"],
];
const PROTECTION_ROWS = [
  ["life", "寿险"],
  ["disability", "失能 / 收入损失保障"],
  ["health", "医疗 / 重疾保障"],
  ["property", "财产保障"],
  ["liability", "责任保障"],
];
const LEGAL_ROWS = [
  ["will", "遗嘱"],
  ["beneficiary_designation", "受益人指定"],
  ["guardianship", "子女监护安排"],
  ["power_of_attorney", "授权委托 / 持久授权书"],
];
const SOCIAL_ROWS = [
  ["social_insurance", "基本社会保险缴费"],
  ["medical_insurance", "基本 / 补充医疗保险"],
  ["public_pension", "基本养老金记录"],
  ["employment_support", "失业与就业援助"],
];

/* ------------------------------------------------------------------ 通道探测 */
let CHANNEL = "unknown";

/* 通道探测必须在 2.5 秒内结束，绝不因为探测阻塞首屏填写。 */
const CHANNEL_PROBE_TIMEOUT_MS = 2500;

/* 后端通道是**声明驱动**的：只有页面明确声明「这里有后端」时才发探测请求。
 *
 * 为什么不能无条件探测：静态托管（预览环境）上没有 /healthz，浏览器会把
 * 这次 404 记进控制台（「Failed to load resource: 404」），即使用户代码
 * 已经 catch 也照记不误。结果就是结果页常年挂着几条红字，用户以为产品坏了。
 * 声明来源（按优先级）：
 *   1. window.VERITY_API_BASE（嵌入方/验收脚本显式指定，字符串可为空表示同源）；
 *   2. <meta name="verity-api-base">：api/server.py 在提供本页时注入；
 *   3. ?api=1：本机手工联调。
 * 三者都没有 → 直接判定浏览器通道，零请求、零 404。 */
function declaredApiBase() {
  if (typeof window.VERITY_API_BASE === "string") return window.VERITY_API_BASE;
  const meta = document.querySelector('meta[name="verity-api-base"]');
  if (meta) return meta.getAttribute("content") || "";
  try {
    if (new URLSearchParams(window.location.search).get("api") === "1") return "";
  } catch (err) {
    /* 老浏览器没有 URLSearchParams：当作未声明 */
  }
  return null;
}

/* 同源时 base 为空串，保持原有相对路径形态（healthz / api/v0/analyze）。 */
let API_BASE = "";
function channelUrl(relative) {
  if (!API_BASE) return relative;
  return `${String(API_BASE).replace(/\/+$/, "")}/${relative}`;
}

async function detectChannel() {
  const declared = declaredApiBase();
  if (declared === null) {
    setBrowserChannel();
    return;
  }
  API_BASE = declared;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? window.setTimeout(() => controller.abort(), CHANNEL_PROBE_TIMEOUT_MS) : null;
  try {
    const res = await fetch(channelUrl("healthz"), {
      headers: { Accept: "application/json" },
      signal: controller ? controller.signal : undefined,
    });
    if (res.ok) {
      const body = await res.json();
      if (body && body.algorithm_version) {
        CHANNEL = "api";
        $("st-algo").textContent = body.algorithm_version;
        $("st-authority").textContent = body.production_authority || "OFF";
        $("st-gate").textContent = body.release_gate || "DENY";
        $("st-channel").textContent = "后端 API";
        $("st-channel-hint").textContent = "POST /api/v0/analyze · 真实引擎";
        setEnginePhase("api");
        renderArchiveChannelNotice();
        return;
      }
    }
  } catch (err) {
    /* 声明了后端但探测失败/超时：退回浏览器通道，不改用户可见行为 */
  } finally {
    if (timer) window.clearTimeout(timer);
  }
  setBrowserChannel();
}

/* T-E0-008 C-03：档案流向必须如实说明，不能写死。
   浏览器通道下引擎在本机跑，档案不出这台设备；后端通道下档案会随请求发给后端，
   那句话就不再成立 —— 所以文案跟着通道走。 */
function renderArchiveChannelNotice() {
  const node = $("pf-channel-notice");
  if (!node) return;
  if (CHANNEL === "api") {
    node.textContent = "注意：本次走后端通道。运行引擎时，你填写的家庭档案会作为请求发送到该后端服务器用于计算；是否留存、留存多久取决于该后端的部署方。本机浏览器仍会保存你主动点过「保存」的档案副本。";
    return;
  }
  node.textContent = "本次运行在浏览器内完成：引擎就在这个页面上跑，家庭档案不会离开这台设备；本机保存的档案只在你自己点「保存」时写入，随时可以删除。";
}

function setBrowserChannel() {
  CHANNEL = "browser";
  $("st-channel").textContent = "浏览器内引擎";
  if (typeof renderArchiveChannelNotice === "function") renderArchiveChannelNotice();
  $("st-channel-hint").textContent = "Pyodide 直接运行 engine/*.py（首屏不等它，后台准备）";
  // 安全状态必须来自引擎本体，不能写死在页面里；引擎就绪后再填充。
  $("st-algo").textContent = "准备中…";
  $("st-authority").textContent = "准备中…";
  $("st-gate").textContent = "准备中…";
}

/* ------------------------------------------------------- 浏览器内引擎（Pyodide） */
const RUNNER_SRC = [
  "import json",
  "from engine.constants import ALGORITHM_VERSION, PRODUCTION_AUTHORITY, RELEASE_GATE",
  "from engine.engine import run_engine",
  "from engine.report import audit_ok_for, render_report",
  "",
  "def _verity_run(profile_json, run_id):",
  "    profile = json.loads(profile_json)",
  "    return json.dumps(run_engine(profile, run_id=run_id), ensure_ascii=False, default=str)",
  "",
  "def _verity_report():",
  "    result = json.loads(_verity_report_result)",
  "    return render_report(result, audit_ok_for(result))",
  "",
  "def _verity_meta():",
  "    return json.dumps({",
  "        'algorithm_version': ALGORITHM_VERSION,",
  "        'production_authority': PRODUCTION_AUTHORITY,",
  "        'release_gate': RELEASE_GATE,",
  "    })",
  "",
].join("\n");

/* 引擎准备状态机（T-E0-027 首屏优先）
   首屏只加载本页与 zh.js/zh.css/styles.css，不下载任何引擎运行时。
   引擎运行时（engine_bundle.js + pyodide/，约 13.4 MB）只在浏览器空闲时于后台准备，
   全程显示真实字节进度；失败可重试，失败不影响填写与导出档案。 */
/* wire = 真实网络传输字节；expand = 浏览器内展开后的字节；packed = 构建产出的 .gz。
   pyodide.asm.wasm 原始 10,088,051 字节，静态托管不做 gzip，所以构建时另存一份 .gz。 */
const RUNTIME_TRACKED_BYTES = {
  "pyodide.asm.wasm": {
    wire: 3128270,
    expand: 10088051,
    packed: "pyodide.asm.wasm.gz",
    type: "application/wasm",
  },
  "python_stdlib.zip": { wire: 2341872, expand: 2341872, type: "application/zip" },
  "pyodide-lock.json": { wire: 106335, expand: 106335, type: "application/json" },
};
const RUNTIME_TRACKED_TOTAL = Object.values(RUNTIME_TRACKED_BYTES).reduce((a, b) => a + b.wire, 0);
const RUNTIME_PATH = /(?:^|\/)pyodide\/([A-Za-z0-9._-]+)$/;

/* 运行时资源基准路径（Round 40）：控制台在域根时是 "./"；在 /family/ 子路径下由页面
   把 window.VERITY_RUNTIME_BASE 覆写成 "../"，否则 pyodide/ 与 engine_bundle.js 会被
   请求到 /family/ 子目录而全部 404，表现为「引擎一直准备中」。 */
const RUNTIME_BASE = typeof window !== "undefined" && window.VERITY_RUNTIME_BASE ? window.VERITY_RUNTIME_BASE : "./";
const runtimePath = (asset) => `${RUNTIME_BASE}${asset}`;

const ENGINE_PHASE_LABEL = {
  idle: "引擎尚未开始准备",
  deferred: "首屏已就绪；引擎将在浏览器空闲时自动开始准备",
  downloading: "正在下载浏览器内引擎运行时",
  booting: "正在启动浏览器内 Python 运行时",
  loading: "正在载入 Verity 引擎本体",
  ready: "浏览器内引擎已就绪，可以运行",
  api: "引擎由后端通道执行，无需浏览器内运行时",
  failed: "浏览器内引擎准备失败",
};
const ENGINE_PHASE_FIXED_PCT = { idle: 0, deferred: 0, booting: 78, loading: 92, ready: 100, api: 100, failed: 0 };
const DOWNLOAD_PCT_CEILING = 70;

const engineState = {
  phase: "idle",
  loaded: 0,
  total: RUNTIME_TRACKED_TOTAL,
  files: {},
  attempts: 0,
  started_at: "",
  ready_at: "",
  elapsed_ms: 0,
  deferred_reason: "",
  error: "",
  /* 本机持久缓存：第二次打开时这些文件不再产生任何网络请求。 */
  cache_hits: 0,
  cache_bytes: 0,
  network_bytes: 0,
};
/* 公开给验收脚本、自动化测试和用户复核；页面显示的数字直接取自这里。 */
window.VERITY_ENGINE_PROGRESS = engineState;

const mbText = (n) => `${(Number(n || 0) / 1048576).toFixed(1)} MB`;

function enginePct() {
  if (engineState.phase === "downloading") {
    if (!engineState.total) return 0;
    return Math.min(DOWNLOAD_PCT_CEILING, Math.round((engineState.loaded / engineState.total) * DOWNLOAD_PCT_CEILING));
  }
  const fixed = ENGINE_PHASE_FIXED_PCT[engineState.phase];
  return fixed === undefined ? 0 : fixed;
}

function engineMetaText() {
  switch (engineState.phase) {
    case "deferred":
      return engineState.deferred_reason === "save_data"
        ? "已检测到省流量模式，不会自动下载引擎运行时。填完档案后点「立即准备引擎」再运行。"
        : "首屏已可填写家庭档案。引擎运行时会自动在后台准备，不影响输入。";
    case "downloading":
      return `后台准备中：主文件已下载 ${mbText(engineState.loaded)} / ${mbText(engineState.total)}（压缩传输，展开后约 13.8 MB）。可以继续填档案。`;
    case "booting":
      return "运行时已下载，正在启动浏览器内 Python（数秒）。可以继续填档案。";
    case "loading":
      return "正在把 engine/*.py 写入浏览器内文件系统，随后即可运行。";
    case "ready":
      return `浏览器内引擎已就绪，准备耗时 ${(engineState.elapsed_ms / 1000).toFixed(1)} 秒${cacheSummaryText()}。点「运行 Verity 引擎」立即计算。`;
    case "api":
      return "本页由后端通道执行（POST /api/v0/analyze），使用与浏览器内完全相同的 engine/ 源码。";
    case "failed":
      return `引擎准备失败：${engineState.error}。可以点「重试准备引擎」；仍可用「导出当前档案」保住输入，或在本机用 python3 -m api.server 走后端通道。`;
    default:
      return "首屏已可填写家庭档案；引擎运行时会在后台准备，准备期间不影响输入。";
  }
}

/* 对用户如实说明这次到底走了网络还是本机缓存。 */
function cacheSummaryText() {
  if (!engineState.cache_hits) return "（本次为首次准备，运行时已存到本机，下次打开不再下载）";
  const hit = `本次从本机缓存读取 ${engineState.cache_hits} 项，省下 ${mbText(engineState.cache_bytes)}`;
  const net = engineState.network_bytes ? `，实际下载 ${mbText(engineState.network_bytes)}` : "，没有下载任何运行时文件";
  return `（${hit}${net}）`;
}

function renderEngineStrip() {
  const strip = $("engine-strip");
  if (!strip) return;
  const pct = enginePct();
  const indeterminate = engineState.phase === "booting" || engineState.phase === "loading";
  strip.dataset.phase = engineState.phase;
  strip.dataset.indeterminate = indeterminate ? "true" : "false";
  const phase = $("es-phase");
  if (phase) phase.textContent = ENGINE_PHASE_LABEL[engineState.phase] || engineState.phase;
  const pctEl = $("es-pct");
  if (pctEl) pctEl.textContent = engineState.phase === "failed" ? "—" : `${pct}%`;
  const bar = $("es-bar");
  if (bar) bar.setAttribute("aria-valuenow", String(pct));
  const fill = $("es-bar-fill");
  if (fill) fill.style.width = `${pct}%`;
  const meta = $("es-meta");
  if (meta) meta.textContent = engineMetaText();
  const start = $("es-start");
  if (start) start.classList.toggle("hidden", !["idle", "deferred", "failed"].includes(engineState.phase));
  const retry = $("es-retry");
  if (retry) retry.classList.toggle("hidden", engineState.phase !== "failed");
  if (runPending && CHANNEL !== "api" && engineState.phase !== "ready") {
    const btn = $("w-run");
    if (btn) btn.textContent = `正在准备浏览器引擎 ${pct}%…`;
  }
}

function setEnginePhase(phase, patch) {
  engineState.phase = phase;
  if (patch) Object.assign(engineState, patch);
  renderEngineStrip();
}

let enginePromise = null;
let runtimeFetchShimmed = false;
/* 下载好的运行时文件（ArrayBuffer 视图），让 Pyodide 直接复用，绝不重复下载。 */
const runtimeBytes = new Map();

/* ------------------------------------------- 本机持久缓存 (T-E0-028 前置)
   静态托管不发 Cache-Control，浏览器因此不会真的复用运行时。这里把「展开后」
   的字节写进 Cache Storage：第二次打开直接读本机，网络请求为 0，弱网下也立刻可用。
   缓存里字节数不对就当作未命中，绝不拿坏字节去启动内核。 */
const ENGINE_CACHE_NAME = "verity-engine-v1";
let engineCachePromise = null;

function openEngineCache() {
  if (typeof caches === "undefined") return Promise.resolve(null);
  if (!engineCachePromise) {
    engineCachePromise = caches.open(ENGINE_CACHE_NAME).catch(() => null);
  }
  return engineCachePromise;
}

function engineCacheKey(path) {
  try {
    return new URL(path, document.baseURI).href;
  } catch (err) {
    return path;
  }
}

async function readCachedBytes(path, expectedBytes) {
  const cache = await openEngineCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(engineCacheKey(path));
    if (!hit) return null;
    const bytes = new Uint8Array(await hit.arrayBuffer());
    if (!bytes.byteLength) return null;
    if (expectedBytes && bytes.byteLength !== expectedBytes) return null;
    return bytes;
  } catch (err) {
    return null;
  }
}

async function writeCachedBytes(path, bytes) {
  const cache = await openEngineCache();
  if (!cache || !bytes || !bytes.byteLength) return;
  try {
    await cache.put(
      engineCacheKey(path),
      new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } })
    );
  } catch (err) {
    /* 配额不足或隐私模式：不写缓存不影响本次运行 */
  }
}

function noteCacheHit(bytes) {
  engineState.cache_hits += 1;
  engineState.cache_bytes += bytes;
}

/* 脚本也走缓存：先取字节，再从 blob 载入，避免为了写缓存而下载两次。 */
async function loadCachedScript(path) {
  const cached = await readCachedBytes(path);
  if (cached) {
    noteCacheHit(cached.byteLength);
    await loadScript(URL.createObjectURL(new Blob([cached], { type: "text/javascript" })));
    return;
  }
  const response = await fetch(path, { headers: { Accept: "text/javascript" } });
  if (!response.ok) throw new Error(`无法加载 ${path}（HTTP ${response.status}）`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  engineState.network_bytes += bytes.byteLength;
  await writeCachedBytes(path, bytes);
  await loadScript(URL.createObjectURL(new Blob([bytes], { type: "text/javascript" })));
}

/* 运行时胶水层由 Pyodide 自己用动态 import 拉取，fetch 影子拦不住它。
   这里先把字节拿到手（命中缓存则零网络），再用 blob 模块导入；
   pyodide.asm.js 载入后会把 _createPyodideModule 挂到 globalThis，
   Pyodide 看到它已存在就不会再去网络取一次。失败则退回 Pyodide 自己的加载路径。 */
async function loadCachedModule(path) {
  let bytes = await readCachedBytes(path);
  if (bytes) {
    noteCacheHit(bytes.byteLength);
  } else {
    const response = await fetch(path, { headers: { Accept: "text/javascript" } });
    if (!response.ok) throw new Error(`无法加载 ${path}（HTTP ${response.status}）`);
    bytes = new Uint8Array(await response.arrayBuffer());
    engineState.network_bytes += bytes.byteLength;
    await writeCachedBytes(path, bytes);
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
  try {
    await import(/* webpackIgnore: true */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`无法加载 ${src}`));
    document.head.appendChild(script);
  });
}

/* fetch 的入参可能是字符串、Request（.url）或 URL（.href）；Pyodide 用的是 URL 对象。 */
function requestUrl(input) {
  if (typeof input === "string") return input;
  if (!input) return "";
  return input.url || input.href || String(input);
}

function runtimeAssetName(url) {
  const match = String(url || "").match(RUNTIME_PATH);
  return match ? match[1] : "";
}

function recordRuntimeFile(name, loaded, total) {
  const denominator = total || (RUNTIME_TRACKED_BYTES[name] || {}).wire || loaded;
  engineState.files[name] = { loaded: Math.min(loaded, denominator), total: denominator };
  engineState.loaded = Object.values(engineState.files).reduce((sum, file) => sum + file.loaded, 0);
  renderEngineStrip();
}

/* 浏览器是否支持流式解压；不支持就退回原始 .wasm，任何浏览器都不会被卡住。 */
function supportsGzipStream() {
  if (typeof DecompressionStream !== "function") return false;
  try {
    new DecompressionStream("gzip");
    return true;
  } catch (err) {
    return false;
  }
}

async function gunzipBytes(buffer) {
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* 逐个下载运行时主文件：手机上并发三个大文件更慢，进度也无法解释。
   大文件优先走 .gz（静态托管不会替我们压缩），解压结果大小不符即失败关闭，改走原始文件。 */
async function downloadRuntimeFile(name, options) {
  const spec = RUNTIME_TRACKED_BYTES[name] || {};
  const plain = Boolean(options && options.plain);
  const usePacked = !plain && Boolean(spec.packed) && supportsGzipStream();
  const source = usePacked ? runtimePath(`pyodide/${spec.packed}`) : runtimePath(`pyodide/${name}`);
  const wire = usePacked ? spec.wire : spec.expand || spec.wire;

  const settle = (bytes, wireBytes) => {
    runtimeBytes.set(name, bytes);
    engineState.files[name] = { loaded: wireBytes, total: wireBytes };
    engineState.loaded = Object.values(engineState.files).reduce((sum, file) => sum + file.loaded, 0);
    engineState.transfer_bytes = engineState.loaded;
    engineState.network_bytes += wireBytes;
    renderEngineStrip();
  };

  /* 命中本机缓存：零网络字节，直接可用。 */
  const cached = await readCachedBytes(runtimePath(`pyodide/${name}`), spec.expand);
  if (cached) {
    noteCacheHit(cached.byteLength);
    settle(cached, 0);
    return cached;
  }

  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("GET", source, true);
    request.responseType = "arraybuffer";
    request.onprogress = (event) => {
      recordRuntimeFile(name, event.loaded, (event.lengthComputable && event.total) || wire);
    };
    request.onload = () => {
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(`${source} 下载失败（HTTP ${request.status}）`));
        return;
      }
      const buffer = request.response;
      if (!usePacked) {
        const bytes = new Uint8Array(buffer);
        settle(bytes, buffer.byteLength);
        writeCachedBytes(runtimePath(`pyodide/${name}`), bytes);
        resolve(bytes);
        return;
      }
      gunzipBytes(buffer)
        .then((bytes) => {
          if (spec.expand && bytes.byteLength !== spec.expand) {
            throw new Error(`${name} 解压后 ${bytes.byteLength} 字节，与声明的 ${spec.expand} 字节不符`);
          }
          settle(bytes, buffer.byteLength);
          writeCachedBytes(runtimePath(`pyodide/${name}`), bytes);
          resolve(bytes);
        })
        .catch(() => downloadRuntimeFile(name, { plain: true }).then(resolve, reject));
    };
    request.onerror = () => reject(new Error(`${source} 下载失败（网络错误）`));
    request.onabort = () => reject(new Error(`${source} 下载被中断`));
    request.ontimeout = () => reject(new Error(`${source} 下载超时`));
    request.send();
  });
}

async function preloadRuntimeFiles() {
  for (const name of Object.keys(RUNTIME_TRACKED_BYTES)) {
    if (!runtimeBytes.has(name)) await downloadRuntimeFile(name, { plain: false });
  }
}

/* Pyodide 自己也会 fetch 这些文件；已下载的直接由内存返回，保证每个文件只下载一次。
   其余请求（healthz、api、示范家庭、档案文件）原样透传，不改写行为、不记录内容。 */
function installRuntimeFetchShim() {
  if (runtimeFetchShimmed || typeof window.fetch !== "function") return;
  runtimeFetchShimmed = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const name = runtimeAssetName(requestUrl(input));
    if (name && runtimeBytes.has(name)) {
      return Promise.resolve(
        new Response(runtimeBytes.get(name), {
          status: 200,
          headers: { "Content-Type": (RUNTIME_TRACKED_BYTES[name] || {}).type || "application/octet-stream" },
        })
      );
    }
    return nativeFetch(input, init);
  };
}

async function ensureBrowserEngine() {
  if (enginePromise) return enginePromise;
  engineState.error = "";
  engineState.attempts += 1;
  engineState.started_at = new Date().toISOString();
  engineState.started_ms = nowMs();
  /* 重试时保留已经下载好的文件：只重新下载真正缺失的那些。 */
  engineState.files = {};
  engineState.loaded = 0;
  for (const name of Object.keys(RUNTIME_TRACKED_BYTES)) {
    if (runtimeBytes.has(name)) recordRuntimeFile(name, runtimeBytes.get(name).byteLength, RUNTIME_TRACKED_BYTES[name]);
  }
  setEnginePhase("downloading");
  const run = (async () => {
    installRuntimeFetchShim();
    await preloadRuntimeFiles();
    if (!window.VERITY_ENGINE_FILES) await loadCachedScript(runtimePath("engine_bundle.js"));
    if (!window.VERITY_ENGINE_FILES) throw new Error("engine_bundle.js 未加载");
    await loadCachedScript(runtimePath("pyodide/pyodide.js"));
    if (typeof window.loadPyodide !== "function") throw new Error("Pyodide 未加载");
    if (typeof window._createPyodideModule !== "function") {
      try {
        await loadCachedModule(runtimePath("pyodide/pyodide.asm.js"));
      } catch (err) {
        /* 没拿到就让 Pyodide 自己加载，不阻塞引擎启动。 */
      }
    }
    setEnginePhase("booting");
    const py = await window.loadPyodide({ indexURL: runtimePath("pyodide/") });
    setEnginePhase("loading");
    py.FS.mkdirTree("/verity/engine");
    for (const [name, code] of Object.entries(window.VERITY_ENGINE_FILES)) {
      py.FS.writeFile(`/verity/engine/${name}`, code);
    }
    await py.runPythonAsync("import sys\nsys.path.insert(0, '/verity')");
    py.runPython(RUNNER_SRC);
    const meta = JSON.parse(py.runPython("_verity_meta()"));
    $("st-algo").textContent = meta.algorithm_version;
    $("st-authority").textContent = meta.production_authority;
    $("st-gate").textContent = meta.release_gate;
    engineState.ready_at = new Date().toISOString();
    setEnginePhase("ready", { elapsed_ms: Math.round(nowMs() - (engineState.started_ms || nowMs())) });
    return py;
  })();
  enginePromise = run;
  run.catch((err) => {
    enginePromise = null;
    setEnginePhase("failed", { error: (err && err.message) || String(err) });
  });
  return run;
}

function retryBrowserEngine() {
  enginePromise = null;
  engineState.error = "";
  ensureBrowserEngine().catch(() => {});
}

/* 首屏优先：等 load 事件 + 一次空闲回调之后再开始下载引擎运行时。 */
function scheduleEngineWarmup() {
  if (enginePromise) return;
  if (navigator.connection && navigator.connection.saveData) {
    setEnginePhase("deferred", { deferred_reason: "save_data" });
    return;
  }
  setEnginePhase("deferred", { deferred_reason: "" });
  const requestIdle =
    window.requestIdleCallback || ((callback) => window.setTimeout(() => callback({ timeRemaining: () => 0 }), 400));
  const startWhenIdle = () => {
    if (engineState.phase !== "deferred") return;
    ensureBrowserEngine().catch(() => {});
  };
  const afterPaint = () => window.requestAnimationFrame(() => requestIdle(startWhenIdle, { timeout: 2500 }));
  if (document.readyState === "complete") afterPaint();
  else window.addEventListener("load", afterPaint, { once: true });
}

function runIdFor(profileId) {
  return `run_zh_${String(profileId || "family").replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

async function runEngine(profile) {
  const runId = runIdFor(profile.profile_id);
  /* 这里**不再**重复探测后端：通道在首屏 detectChannel 时已按声明定好，
   * 每次运行再探一次只会给静态部署多造一条 404 控制台噪声。 */
  if (CHANNEL === "api") {
    const res = await fetch(channelUrl("api/v0/analyze"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: profile, run_id: runId }),
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch (err) {
      throw new Error(`后端返回的不是合法 JSON（HTTP ${res.status}）`);
    }
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    /* 原始文本同样交给快照：本机复核要按引擎写下的原文重算哈希，不能重新序列化。 */
    return { channel: "后端 API · /api/v0/analyze", result: body, resultText: text };
  }
  const py = await ensureBrowserEngine();
  py.globals.set("_verity_profile_json", JSON.stringify(profile));
  py.globals.set("_verity_run_id", runId);
  const raw = py.runPython("_verity_run(_verity_profile_json, _verity_run_id)");
  return { channel: "浏览器内引擎 · Pyodide 直接运行 engine/*.py", result: JSON.parse(raw), resultText: raw };
}

/* ------------------------------------------------------------------ 向导构建 */
function memberRow(index, seed) {
  const member = seed || {};
  const wrap = document.createElement("div");
  wrap.className = "row-card w-member";
  wrap.innerHTML = `
    <div class="row-head">
      <span class="idx">成员 ${index + 1}</span>
      <button type="button" class="row-del">删除</button>
    </div>
    <div class="grid c2">
      <div class="field"><label>年龄</label><input type="number" min="0" max="120" step="1" data-field="age" value="${numAttr(member.age)}" /></div>
      <div class="field"><label>家庭角色</label>
        <select data-field="role">
          <option value="primary_earner">主要收入来源</option>
          <option value="secondary_earner">次要收入来源</option>
          <option value="dependent">受抚养成员</option>
        </select>
      </div>
      <div class="field"><label>年收入</label><input type="number" min="0" step="1000" data-field="annual_income" value="${numAttr(member.annual_income)}" /></div>
      <div class="field"><label>收入稳定性</label>
        <select data-field="income_stability">
          <option value="high">稳定</option>
          <option value="medium">一般</option>
          <option value="low">不稳定</option>
        </select>
      </div>
      <div class="field"><label>受抚养人数</label><input type="number" min="0" step="1" data-field="dependents" value="${numAttr(member.dependents != null ? member.dependents : 0)}" /></div>
    </div>`;
  wrap.querySelector(".row-del").addEventListener("click", () => {
    if ($("w-members").querySelectorAll(".w-member").length <= 1) return;
    wrap.remove();
    renumberMembers();
    validate();
  });
  return wrap;
}

function renumberMembers() {
  $("w-members").querySelectorAll(".w-member").forEach((row, index) => {
    row.querySelector(".idx").textContent = `成员 ${index + 1}`;
  });
}

function addMember(seed) {
  const index = $("w-members").querySelectorAll(".w-member").length;
  const row = memberRow(index, seed);
  $("w-members").appendChild(row);
  return row;
}

function outflowRow(seed) {
  const item = seed || {};
  const wrap = document.createElement("div");
  wrap.className = "row-card w-outflow";
  wrap.innerHTML = `
    <div class="row-head"><span class="idx">刚性支出</span><button type="button" class="row-del">删除</button></div>
    <div class="grid c3">
      <div class="field"><label>名称</label><input type="text" data-field="label" value="${item.label ? esc(item.label) : ""}" placeholder="如：孩子大学学费" /></div>
      <div class="field"><label>金额</label><input type="number" min="0" step="1000" data-field="amount" value="${numAttr(item.amount)}" /></div>
      <div class="field"><label>几年后到期</label><input type="number" min="0" max="60" step="1" data-field="years_until_due" value="${numAttr(item.years_until_due)}" /></div>
    </div>`;
  wrap.querySelector(".row-del").addEventListener("click", () => {
    wrap.remove();
    validate();
  });
  return wrap;
}

function buildStaticControls() {
  $("w-assets").innerHTML = ASSET_ROWS.map(
    ([kind, label, liquidity, hint]) => `
    <div class="field asset-row">
      <label for="w-asset-${kind}">${label}</label>
      <input id="w-asset-${kind}" type="number" min="0" step="10000" value="0" />
      <div class="fhint">${hint}${liquidity === "cannot_touch" ? " · 危机中无法动用" : ""}</div>
    </div>`
  ).join("");

  $("w-liabilities").innerHTML = LIABILITY_ROWS.map(
    ([kind, label]) => `
    <div class="row-card">
      <div class="row-head"><strong>${label}</strong></div>
      <div class="grid c3">
        <div class="field"><label for="w-liab-${kind}-balance">未偿余额</label><input id="w-liab-${kind}-balance" type="number" min="0" step="10000" value="0" /></div>
        <div class="field"><label for="w-liab-${kind}-rate">年利率（0–1）</label><input id="w-liab-${kind}-rate" type="number" min="0" max="1" step="0.001" value="0" /></div>
        <div class="field"><label for="w-liab-${kind}-payment">年强制还款额</label><input id="w-liab-${kind}-payment" type="number" min="0" step="1000" value="0" /></div>
      </div>
    </div>`
  ).join("");

  $("w-protection").innerHTML = PROTECTION_ROWS.map(
    ([kind, label]) => `
    <div class="row-card">
      <div class="row-head"><strong>${label}</strong></div>
      <div class="grid c2">
        <div class="field"><label for="w-prot-${kind}-coverage">已生效保额</label><input id="w-prot-${kind}-coverage" type="number" min="0" step="10000" value="0" /></div>
        <div class="field"><label for="w-prot-${kind}-premium">年保费</label><input id="w-prot-${kind}-premium" type="number" min="0" step="100" value="0" /></div>
      </div>
    </div>`
  ).join("");

  $("w-legal").innerHTML = LEGAL_ROWS.map(
    ([kind, label]) => `
    <div class="legal-row">
      <label class="chk"><input type="checkbox" id="w-legal-${kind}" /> 已安排：${label}</label>
      <div class="notein"><input type="text" id="w-legal-${kind}-note" placeholder="备注（可选）" /></div>
    </div>`
  ).join("");

  $("w-social").innerHTML = SOCIAL_ROWS.map(
    ([kind, label]) => `
    <div class="social-row">
      <label class="chk"><input type="checkbox" id="w-social-${kind}" /> 已记录：${label}</label>
      <div class="notein"><input type="text" id="w-social-${kind}-note" placeholder="备注（可选）" /></div>
    </div>`
  ).join("");
}

/* ------------------------------------------------------------------ 收集档案 */
function collectProfile() {
  const currency = $("w-currency").value;
  const members = Array.from($("w-members").querySelectorAll(".w-member")).map((row, index) => {
    const get = (field) => row.querySelector(`[data-field="${field}"]`).value;
    return {
      member_id: `adult_${index + 1}`,
      age: num(get("age")),
      role: get("role"),
      dependents: num(get("dependents")),
      annual_income: num(get("annual_income")),
      income_stability: get("income_stability"),
    };
  });

  const assets = [];
  ASSET_ROWS.forEach(([kind, , liquidity]) => {
    const value = num($(`w-asset-${kind}`).value);
    if (value <= 0) return;
    assets.push({
      asset_id: `${$("w-profile-id").value || "FAMILY"}_${kind}`,
      kind: kind,
      value: value,
      liquidity: liquidity,
      note: "",
      currency: currency,
    });
  });

  const liabilities = [];
  LIABILITY_ROWS.forEach(([kind]) => {
    const balance = num($(`w-liab-${kind}-balance`).value);
    const payment = num($(`w-liab-${kind}-payment`).value);
    if (balance <= 0 && payment <= 0) return;
    liabilities.push({
      liability_id: `${$("w-profile-id").value || "FAMILY"}_${kind}`,
      kind: kind,
      balance: balance,
      annual_rate: num($(`w-liab-${kind}-rate`).value),
      mandatory_payment: payment,
    });
  });

  const protection = [];
  PROTECTION_ROWS.forEach(([kind]) => {
    const coverage = num($(`w-prot-${kind}-coverage`).value);
    const premium = num($(`w-prot-${kind}-premium`).value);
    if (coverage <= 0 && premium <= 0) return;
    protection.push({
      protection_id: `${$("w-profile-id").value || "FAMILY"}_${kind}`,
      kind: kind,
      coverage: coverage,
      annual_premium: premium,
      exclusions: [],
    });
  });

  const futureRigidOutflows = Array.from($("w-outflows").querySelectorAll(".w-outflow"))
    .map((row, index) => {
      const get = (field) => row.querySelector(`[data-field="${field}"]`).value;
      const amount = num(get("amount"));
      if (amount <= 0) return null;
      return {
        outflow_id: `${$("w-profile-id").value || "FAMILY"}_outflow_${index + 1}`,
        label: get("label") || `刚性支出 ${index + 1}`,
        amount: amount,
        years_until_due: num(get("years_until_due")),
      };
    })
    .filter(Boolean);

  const legal_affairs = {};
  LEGAL_ROWS.forEach(([kind]) => {
    legal_affairs[kind] = {
      recorded: $(`w-legal-${kind}`).checked,
      note: $(`w-legal-${kind}-note`).value || "",
    };
  });

  const social_protection = {};
  SOCIAL_ROWS.forEach(([kind]) => {
    social_protection[kind] = {
      recorded: $(`w-social-${kind}`).checked,
      note: $(`w-social-${kind}-note`).value || "",
    };
  });

  /* 本年度已实现净收益（可选，T-E0-044）。留空 = 未记录：引擎不会替你假设赚了多少，
     页面与报告会如实写「进度未记录」。填了数字就按记录读取，不做任何推算。 */
  const annualGoal = {};
  const annualGainRaw = $("w-annual-gain").value.trim();
  if (annualGainRaw !== "") {
    const gain = Number(annualGainRaw);
    if (Number.isFinite(gain)) annualGoal.recorded_net_gain = gain;
  }
  const annualAsOf = $("w-annual-asof").value.trim();
  if (annualAsOf) annualGoal.recorded_as_of = annualAsOf;

  return {
    profile_id: $("w-profile-id").value || "MY-FAMILY-001",
    currency: currency,
    members: members,
    annual_expenses_essential: num($("w-essential").value),
    annual_expenses_discretionary: num($("w-discretionary").value),
    assets: assets,
    liabilities: liabilities,
    protection: protection,
    future_rigid_outflows: futureRigidOutflows,
    legal_affairs: legal_affairs,
    social_protection: social_protection,
    investment_horizon_years: num($("w-horizon").value),
    target_annual_return: num($("w-target").value),
    max_tolerable_loss_pct: num($("w-tolerance").value),
    annual_goal: annualGoal,
  };
}

/* -------------------------------------------------------------- 前端必填校验 */
const FIELD_CN = {
  members: "家庭成员",
  annual_expenses_essential: "家庭年必要支出",
  assets: "家庭资产",
  investment_horizon_years: "投资期限",
  target_annual_return: "目标年化回报",
  max_tolerable_loss_pct: "可承受最大损失",
};

function validate() {
  const profile = collectProfile();
  const missing = [];
  const problems = [];

  if (!profile.members.length || !profile.members.some((m) => m.age > 0)) missing.push("members");
  if (!(profile.annual_expenses_essential > 0)) missing.push("annual_expenses_essential");
  if (!profile.assets.length) missing.push("assets");
  if (!(profile.investment_horizon_years > 0)) missing.push("investment_horizon_years");
  if (!(profile.target_annual_return > 0)) missing.push("target_annual_return");
  if (!(profile.max_tolerable_loss_pct > 0)) missing.push("max_tolerable_loss_pct");

  if (profile.max_tolerable_loss_pct > 0 && profile.max_tolerable_loss_pct < 0.15) {
    problems.push("可承受最大损失低于 15%：按冻结契约，引擎会判定 REFUSE。");
  }
  if (profile.target_annual_return >= 0.12 && profile.max_tolerable_loss_pct < 0.25) {
    problems.push("目标年化回报 ≥12% 但损失预算 <25%：按冻结契约，引擎会判定 REFUSE。");
  }
  const grossIncome = profile.members.reduce((sum, m) => sum + (m.annual_income || 0), 0);
  if (grossIncome > 0 && profile.annual_expenses_essential > grossIncome) {
    problems.push("年必要支出高于家庭年收入：现金流为负，生存底线会被击穿。");
  }

  const box = $("w-validation");
  if (missing.length === 0) {
    box.innerHTML = `<div class="ok">必填项已齐备，可以运行 Verity 引擎。</div>${
      problems.length ? `<ul>${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""
    }`;
  } else {
    box.innerHTML = `<div class="missing">还缺 ${missing.length} 项必填：</div><ul>${missing
      .map((key) => `<li>${esc(FIELD_CN[key] || key)}</li>`)
      .join("")}</ul>${
      problems.length ? `<ul>${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""
    }`;
  }
  $("w-run").disabled = missing.length > 0;
  return missing;
}

/* ------------------------------------------------------------------ 步骤控制 */
let step = 1;
const STEPS = 8;

function showStep(next) {
  step = Math.max(1, Math.min(STEPS, next));
  document.querySelectorAll(".wiz-step").forEach((panel) => {
    panel.classList.toggle("hidden", Number(panel.dataset.step) !== step);
  });
  document.querySelectorAll("#stepper li").forEach((item, index) => {
    item.classList.toggle("active", index + 1 === step);
    item.classList.toggle("done", index + 1 < step);
  });
  $("w-progress").textContent = `第 ${step} / ${STEPS} 步`;
  $("w-prev").disabled = step === 1;
  $("w-next").classList.toggle("hidden", step === STEPS);
  $("w-run").classList.toggle("hidden", step !== STEPS);
  validate();
}

/* ------------------------------------------------------------------ 结果渲染 */
function renderMeta(result, channel) {
  storeDigest = (result.evidence || {}).inputs_digest || "";
  $("run-meta").innerHTML = [
    `执行通道：${esc(channel)}`,
    `run_id：<span class="mono">${esc(result.run_id)}</span>`,
    `引擎版本：${esc(result.algorithm_version)}`,
    `输入摘要：<span class="mono">${esc((result.evidence || {}).inputs_digest || storeDigest)}</span>`,
  ]
    .map((line) => `<div>${line}</div>`)
    .join("");
}

let storeDigest = "";

/* 判定理由的中文化：reason_codes 与 reasons 一一对应（引擎契约），按码取中文模板；
   命中失败且句子是英文时返回空串（由调用方按失败关闭处理）。 */
function zhTranslateReason(code, sentence) {
  if (code === "INCONSISTENT_INPUT") {
    const m = String(sentence || "").match(/^The profile is internally contradictory: (.*)$/m);
    if (!m) return { cn: "", matched: false };
    const body = String(m[1])
      .split("; ")
      .map((frag) => zhFirstMatch(VERITY_I18N["validation"] || [], frag) || (looksEnglish(frag) ? "" : frag))
      .filter(Boolean)
      .join("；");
    return { cn: body ? `家庭档案内部互相矛盾：${body}` : "", matched: Boolean(body) };
  }
  if (code === "PROFILE_VALIDATION_ERROR") {
    const m = String(sentence || "").match(/^Profile validation failed: ([A-Za-z_]+): (.*)$/m);
    if (!m) return { cn: "", matched: false };
    const msg = zhFirstMatch(VERITY_I18N["validation"] || [], m[2]) || (looksEnglish(m[2]) ? "" : m[2]);
    return { cn: msg ? `档案校验失败：${m[1]}：${msg}` : "", matched: Boolean(msg) };
  }
  return zhSentence(((VERITY_I18N["feasibility"] || {}).by_code || {})[code], sentence);
}

function feasibilityReasonCn(result, index = 0) {
  const feasibility = result.feasibility || {};
  const code = (feasibility.reason_codes || [])[index];
  const sentence = (feasibility.reasons || [])[index];
  const hit = zhTranslateReason(code, sentence);
  if (hit.matched) return hit.cn;
  return looksEnglish(sentence) ? "" : sentence;
}

function renderVerdict(result) {
  const verdict = result.verdict || "ABSTAIN";
  const today = result.today || {};
  const feasibility = result.feasibility || {};
  $("r-action").textContent = cn(ACTION_CN, today.action, today.action);
  // 中文口径优先（T-E0-041）；引擎英文原句保留在结果 JSON / #r-raw 审计块里，
  // 机器码（动作码、理由码）在本页继续可见可审计。翻译由 web/i18n_zh.json 契约提供。
  const gloss = cn(ACTION_TEXT_CN, today.action, "");
  const i18nToday = VERITY_I18N["today"] || {};
  const meaningCn = (i18nToday["meaning"] || {})[today.action] || "";
  const abstainReasonCn =
    verdict === "ABSTAIN" || verdict === "REFUSE" ? feasibilityReasonCn(result, 0) : "";
  const reasonCn = abstainReasonCn
    ? `可行性判定为 ${verdict}，因此不下达动作。${abstainReasonCn ? " " + abstainReasonCn : ""}`
    : zhSentence((i18nToday["reason"] || {})[today.action], today.action_reason).cn;
  const actionCodes = [today.action || "ABSTAIN", ...(feasibility.reason_codes || [])].join(" · ");
  $("r-action-why").innerHTML =
    (gloss ? `<div>${esc(gloss)}</div>` : "") +
    (meaningCn ? `<div class="subnote" style="margin-top:6px">引擎口径：${esc(meaningCn)}</div>` : "") +
    (reasonCn ? `<div class="subnote">原因：${esc(reasonCn)}</div>` : "") +
    `<div class="subnote mono">机器码 ${esc(actionCodes)} · 英文原句见「证据与审计 · 完整引擎输出」</div>`;

  const daysClass = (today.safety_days || 0) < 90 ? "neg" : (today.safety_days || 0) < 180 ? "warn" : "pos";
  $("r-today-grid").innerHTML = `
    <div class="metric"><div class="k">整体判定</div><div class="v ${verdict === "PASS" ? "pos" : verdict === "REFUSE" ? "neg" : verdict === "ABSTAIN" ? "warn" : "info"}">${esc(verdict)}</div><div class="h">${esc(cn(VERDICT_TEXT_CN, verdict, ""))}</div></div>
    <div class="metric"><div class="k">家庭总资产</div><div class="v">${money(today.wealth_value)}</div><div class="h">引擎口径：资产合计，不扣负债（净资产见下方）</div></div>
    <div class="metric"><div class="k">生存天数</div><div class="v ${daysClass}">${fmt(today.safety_days, 1)}</div><div class="h">收入中断后可支撑天数</div></div>
    <div class="metric"><div class="k">目标实现概率</div><div class="v info">${today.goal_probability === null || today.goal_probability === undefined ? "—" : pct(today.goal_probability, 0)}</div><div class="h">情景推算，不是预测</div></div>`;

  const codes = (feasibility.reason_codes || []).map((c) => `<span class="pill info">${esc(c)}</span>`).join(" ");
  const reasons = (feasibility.reasons || [])
    .map((r, i) => {
      const code = (feasibility.reason_codes || [])[i];
      const hit = zhTranslateReason(code, r);
      const shown = hit.matched ? hit.cn : looksEnglish(r) ? `转译缺失：${code || "?"}` : r;
      return `<li>${esc(shown)}</li>`;
    })
    .join("");
  $("r-verdict-body").innerHTML = `
    <div class="pill ${verdict === "PASS" ? "ok" : verdict === "REFUSE" ? "bad" : "warn"}">${esc(cn(VERDICT_CN, verdict, verdict))}</div>
    <div style="margin:10px 0 8px">${codes}</div>
    <ul style="margin:0 0 0 18px;color:var(--muted);font-size:13px">${reasons}</ul>
    <div class="grid c3" style="margin-top:14px">
      <div class="metric"><div class="k">达成目标需要的年化回报</div><div class="v">${pct(feasibility.required_return_for_goal)}</div></div>
      <div class="metric"><div class="k">损失预算</div><div class="v">${pct(feasibility.max_tolerable_loss_pct)}</div></div>
      <div class="metric"><div class="k">参考可达回报</div><div class="v info">${pct(feasibility.achievable_return_proxy)}</div></div>
    </div>`;
}

function renderBalance(result, profile) {
  const layers = result.layers || {};
  const safety = result.safety || {};
  const today = result.today || {};
  const amounts = layers.layers || {};
  const fractions = layers.fractions || {};
  const grossIncome = (profile.members || []).reduce((sum, m) => sum + (m.annual_income || 0), 0);
  const totalAssets = (profile.assets || []).reduce((sum, a) => sum + (a.value || 0), 0);
  const totalDebt = (profile.liabilities || []).reduce((sum, l) => sum + (l.balance || 0), 0);
  const mandatory = (profile.liabilities || []).reduce((sum, l) => sum + (l.mandatory_payment || 0), 0);

  $("r-balance-grid").innerHTML = `
    <div class="metric"><div class="k">家庭年收入</div><div class="v">${money(grossIncome)}</div><div class="h">全部成员合计</div></div>
    <div class="metric"><div class="k">年必要支出</div><div class="v">${money(profile.annual_expenses_essential)}</div><div class="h">刚需，不可压缩</div></div>
    <div class="metric"><div class="k">年净结余</div><div class="v ${grossIncome - profile.annual_expenses_essential >= 0 ? "pos" : "neg"}">${money(grossIncome - profile.annual_expenses_essential)}</div><div class="h">年收入 − 年必要支出</div></div>
    <div class="metric"><div class="k">净资产</div><div class="v">${money(totalAssets - totalDebt)}</div><div class="h">资产 ${money(totalAssets)} − 负债 ${money(totalDebt)}</div></div>`;

  const rows = LAYER_CN.map(
    ([key, label, css]) => `
    <div class="flow-row">
      <div class="name">${label}</div>
      <div class="bar"><i class="${css}" style="width:${(Math.max(0, Math.min(1, fractions[key] || 0)) * 100).toFixed(2)}%"></i></div>
      <div class="amt">${money(amounts[key])} · ${pct(fractions[key] || 0)}</div>
    </div>`
  ).join("");

  const assetRows = (profile.assets || [])
    .map((a) => {
      const meta = ASSET_ROWS.find(([kind]) => kind === a.kind) || [a.kind, a.kind];
      return `<tr><td>${esc(meta[1])}</td><td class="num">${money(a.value)}</td><td>${esc(cn(STATUS_CN, String(a.liquidity).toUpperCase(), a.liquidity))}</td></tr>`;
    })
    .join("");
  const liabilityRows = (profile.liabilities || [])
    .map((l) => {
      const meta = LIABILITY_ROWS.find(([kind]) => kind === l.kind) || [l.kind, l.kind];
      return `<tr><td>${esc(meta[1])}</td><td class="num">${money(l.balance)}</td><td class="num">${pct(l.annual_rate, 2)}</td><td class="num">${money(l.mandatory_payment)}</td></tr>`;
    })
    .join("");

  $("r-layers").innerHTML = `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">
      <span class="pill ${layers.funding_status === "FUNDED" ? "ok" : layers.funding_status === "DEFICIT" ? "bad" : "warn"}">资金状态：${esc(cn(STATUS_CN, layers.funding_status, layers.funding_status))}</span>
      <span class="pill info">资产合计 ${money(layers.total_assets)}</span>
      <span class="pill ${(layers.growth_fraction || 0) < 0.2 ? "warn" : "ok"}">增长层占比 ${pct(layers.growth_fraction || 0)}</span>
      <span class="pill ${safety.cash_gap > 0 ? "bad" : "ok"}">现金流缺口 ${money(safety.cash_gap)}</span>
      <span class="pill ${today.relative_to_benchmark >= 0 ? "ok" : "warn"}">相对 60/40 基准 ${pct(today.relative_to_benchmark)}</span>
    </div>
    <div class="flow-bar">${rows}</div>`;

  $("r-assets-table").innerHTML = `
    <div class="scroll"><table>
      <thead><tr><th>资产</th><th class="num">金额</th><th>可动用性</th></tr></thead>
      <tbody>${assetRows || `<tr><td colspan="3" class="note">未记录任何资产。</td></tr>`}</tbody>
    </table></div>
    <div class="scroll" style="margin-top:14px"><table>
      <thead><tr><th>负债</th><th class="num">余额</th><th class="num">年利率</th><th class="num">年强制还款</th></tr></thead>
      <tbody>${liabilityRows || `<tr><td colspan="4" class="note">未记录任何负债。</td></tr>`}</tbody>
    </table></div>
    <div class="note">年强制还款合计 ${money(mandatory)}；债务压力比 ${pct(safety.debt_pressure_ratio)}（阈值 35%）。</div>`;
}

/* ------------------------------------------------- 现金流与资产负债·多月度趋势 (T-E0-031) */

let trendRangeMonths = 12;
let lastTrendView = null;
let lastStressView = null;

function trendMonthRows(trend) {
  const rows = Array.isArray(trend.monthly) ? trend.monthly : [];
  if (!trendRangeMonths) return rows;
  return rows.slice(0, trendRangeMonths);
}

function trendChart(rows, target) {
  const scale = Math.max(
    1,
    target || 0,
    ...rows.map((r) => Math.max(Math.abs(r.cumulative_cash || 0), r.total_debt || 0))
  );
  const targetPct = target ? Math.max(0, Math.min(100, (target / scale) * 100)) : 0;
  const targetLayer = `<div class="tb-target-layer" aria-hidden="true">
      <div class="tb-target" style="height:${targetPct.toFixed(2)}%"><span>应急金目标 ${money(target)}</span></div>
    </div>`;
  const cols = rows
    .map((r) => {
      const cash = Math.max(0, r.cumulative_cash || 0);
      const debt = Math.max(0, r.total_debt || 0);
      const cashH = (cash / scale) * 100;
      const debtH = (debt / scale) * 100;
      const cls = r.deficit ? " neg" : "";
      return `<div class="tb-col${cls}" data-month="${r.month}">
        <div class="tb-plot">
          <i class="tb-bar cash" style="height:${cashH.toFixed(2)}%"></i>
          <i class="tb-bar debt" style="height:${debtH.toFixed(2)}%"></i>
        </div>
        <div class="tb-label">${r.month}</div>
      </div>`;
    })
    .join("");
  return `
    <div class="trend-chart-head">
      <span class="legend"><i class="sw cash"></i>可动用现金</span>
      <span class="legend"><i class="sw debt"></i>未偿负债</span>
      <span class="legend"><i class="sw target"></i>应急金目标（6 个月刚性支出）</span>
    </div>
    <div class="trend-chart">
      ${targetPct > 0 ? targetLayer : ""}
      ${cols}
    </div>`;
}

function trendMilestones(summary, horizon) {
  const pills = [];
  const reserve = summary.months_to_emergency_reserve;
  pills.push(
    reserve
      ? `<span class="pill ok">第 ${reserve} 个月达到 6 个月应急金</span>`
      : `<span class="pill warn">6 个月应急金在 ${horizon} 个月内未达到</span>`
  );
  const debtFree = summary.months_to_debt_free;
  pills.push(
    summary.total_debt_start <= 0
      ? `<span class="pill ok">没有记录负债，无需摊还</span>`
      : debtFree
      ? `<span class="pill ok">第 ${debtFree} 个月负债清零</span>`
      : `<span class="pill warn">按记录的年强制还款，负债在 ${horizon} 个月内未清零</span>`
  );
  const change = summary.net_worth_change || 0;
  pills.push(
    `<span class="pill ${change > 0 ? "ok" : change < 0 ? "bad" : "info"}">净资产变化 ${change >= 0 ? "+" : ""}${money(change)}</span>`
  );
  const deficit = summary.deficit_months || [];
  pills.push(
    deficit.length
      ? `<span class="pill bad">${deficit.length} 个月现金缺口：第 ${deficit.join("、")} 月</span>`
      : `<span class="pill ok">每月都有正向现金结余</span>`
  );
  const negative = summary.negative_amortization_months || [];
  if (negative.length) {
    pills.push(`<span class="pill bad">还款不足以覆盖利息：第 ${negative.join("、")} 月（负债会变大）</span>`);
  }
  if (summary.first_negative_cash_month) {
    pills.push(`<span class="pill bad">第 ${summary.first_negative_cash_month} 个月起现金为负</span>`);
  }
  return `<div class="trend-pills">${pills.join("")}</div>`;
}

function trendTable(rows) {
  const body = rows
    .map(
      (r) => `<tr class="${r.deficit ? "row-deficit" : ""}">
        <td>第 ${r.month} 月</td>
        <td class="num">${money(r.income)}</td>
        <td class="num">${money(r.essential_outflow)}</td>
        <td class="num">${money(r.debt_service)}</td>
        <td class="num ${r.net_cash_flow >= 0 ? "pos" : "neg"}">${money(r.net_cash_flow)}</td>
        <td class="num ${r.cumulative_cash >= 0 ? "pos" : "neg"}">${money(r.cumulative_cash)}</td>
        <td class="num">${money(r.total_debt)}</td>
        <td class="num">${money(r.net_worth)}</td>
        <td class="num">${r.runway_days === null || r.runway_days === undefined ? "—" : days(r.runway_days)}</td>
      </tr>`
    )
    .join("");
  return `<div class="scroll"><table>
    <thead><tr><th>月份</th><th class="num">收入</th><th class="num">必要支出</th><th class="num">债务还款</th>
      <th class="num">净结余</th><th class="num">累计现金</th><th class="num">未偿负债</th><th class="num">净资产</th>
      <th class="num">可生存天数</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

function renderTrend(result, profile) {
  const trend = (result && result.trend) || {};
  const rows = trendMonthRows(trend);
  const summary = trend.summary || {};

  if (trend.status !== "OK") {
    $("r-trend-status").className = "pill bad";
    $("r-trend-status").textContent = `ABSTAIN · ${(trend.reason_codes || []).join("、") || "证据不足"}`;
    $("r-trend-grid").innerHTML = "";
    $("r-trend-chart").innerHTML = "";
    $("r-trend-milestones").innerHTML = "";
    $("r-trend-table").innerHTML = "";
    $("r-trend-note").innerHTML = `<div class="err">${esc(trend.status_reason || "趋势模块按失败关闭。")}</div>`;
    lastTrendView = { status: trend.status, reason_codes: trend.reason_codes || [], months_shown: 0 };
    window.__verityTrendView = lastTrendView;
    return;
  }

  const statusClass =
    summary.trend_status === "IMPROVING" ? "ok" : summary.trend_status === "DETERIORATING" ? "bad" : "warn";
  const statusCn =
    summary.trend_status === "IMPROVING" ? "走向改善" : summary.trend_status === "DETERIORATING" ? "走向变差" : "基本持平";
  $("r-trend-status").className = `pill ${statusClass}`;
  $("r-trend-status").textContent = `${statusCn} · ${trend.horizon_months} 个月口径 · 不假设投资收益`;

  $("r-trend-grid").innerHTML = `
    <div class="metric"><div class="k">月均收入</div><div class="v">${money(summary.monthly_income)}</div><div class="h">家庭记录的年收入 ÷ 12</div></div>
    <div class="metric"><div class="k">月均刚性支出</div><div class="v">${money(summary.monthly_unavoidable_outflow)}</div><div class="h">必要支出 + 债务还款</div></div>
    <div class="metric"><div class="k">月净结余</div><div class="v ${(summary.monthly_net_surplus || 0) >= 0 ? "pos" : "neg"}">${money(summary.monthly_net_surplus)}</div><div class="h">未计入可选支出</div></div>
    <div class="metric"><div class="k">第 ${trend.horizon_months} 月可生存天数</div><div class="v ${(summary.runway_days_end || 0) < 90 ? "neg" : (summary.runway_days_end || 0) < 180 ? "warn" : "pos"}">${days(summary.runway_days_end)}</div><div class="h">起点 ${days(summary.runway_days_start)}</div></div>`;

  $("r-trend-chart").innerHTML = trendChart(rows, summary.emergency_reserve_target);
  $("r-trend-milestones").innerHTML = trendMilestones(summary, trend.horizon_months);
  $("r-trend-table").innerHTML = trendTable(rows);

  const currencyNote = profile && profile.currency ? `金额单位 ${esc(profile.currency)}；` : "";
  $("r-trend-note").innerHTML =
    `${currencyNote}起点现金 ${money(summary.cash_start)} → 第 ${trend.horizon_months} 月 ${money(summary.cash_end)}；` +
    `未偿负债 ${money(summary.total_debt_start)} → ${money(summary.total_debt_end)}；` +
    `净资产 ${money(summary.net_worth_start)} → ${money(summary.net_worth_end)}。` +
    `可选支出按“只从当月结余中支出”处理，因此 ${money(summary.monthly_discretionary_planned)} 的月均可选支出在缺钱时会被压缩，` +
    `刚性支出与债务还款不会被压缩。`;

  lastTrendView = {
    status: trend.status,
    trend_status: summary.trend_status,
    horizon_months: trend.horizon_months,
    months_total: (trend.monthly || []).length,
    months_shown: rows.length,
    range_months: trendRangeMonths,
    monthly: rows.map((r) => ({
      month: r.month,
      net_cash_flow: r.net_cash_flow,
      cumulative_cash: r.cumulative_cash,
      total_debt: r.total_debt,
      net_worth: r.net_worth,
      runway_days: r.runway_days,
    })),
    summary: { ...summary },
    return_assumption: trend.return_assumption,
  };
  window.__verityTrendView = lastTrendView;
}

function setTrendRange(months) {
  trendRangeMonths = Number(months) || 0;
  const group = $("r-trend-range");
  if (group) {
    Array.prototype.forEach.call(group.querySelectorAll("button"), (btn) => {
      btn.classList.toggle("active", Number(btn.dataset.months) === trendRangeMonths);
    });
  }
  if (lastTrendView && lastResultForTrend) renderTrend(lastResultForTrend.result, lastResultForTrend.profile);
}

let lastResultForTrend = null;

function renderSafety(result) {
  const safety = result.safety || {};
  const daysClass = (safety.safety_days || 0) < 90 ? "neg" : (safety.safety_days || 0) < 180 ? "warn" : "pos";
  $("r-safety-grid").innerHTML = `
    <div class="metric"><div class="k">生存天数</div><div class="v ${daysClass}">${fmt(safety.safety_days, 1)}</div><div class="h">目标 ${safety.survival_target_days || 180} 天</div></div>
    <div class="metric"><div class="k">应急金目标金额</div><div class="v">${money(safety.survival_floor_value)}</div><div class="h">按家庭自己记录的 ${fmt(safety.survival_target_days, 0)} 天必要支出换算</div></div>
    <div class="metric"><div class="k">现金缺口</div><div class="v ${safety.cash_gap > 0 ? "neg" : "pos"}">${money(safety.cash_gap)}</div><div class="h">相对应急金目标的缺口</div></div>
    <div class="metric"><div class="k">无法动用资产</div><div class="v warn">${money(safety.untouchable_assets)}</div><div class="h">危机中取不出来的财富</div></div>`;

  const risks = safety.major_risks || [];
  $("r-safety-risks").innerHTML = risks.length
    ? `<div class="scroll"><table><thead><tr><th>风险</th><th>严重度</th><th>说明</th><th>风险码</th></tr></thead><tbody>${risks
        .map((r) => {
          const i18nRisk = (VERITY_I18N["safety"] || {})[r.risk_id] || {};
          const labelCn = i18nRisk.label_cn || r.label;
          const detailHit = zhSentence(i18nRisk, r.detail);
          const detailCn = detailHit.matched ? detailHit.cn : r.detail;
          return `<tr><td>${esc(labelCn)}</td><td class="sev-${esc(r.severity)}">${esc(cn(SEVERITY_CN, r.severity, r.severity))}</td><td>${esc(detailCn)}</td><td><code class="mono">${esc(r.risk_id || "")}</code></td></tr>`;
        })
        .join("")}</tbody></table></div>`
    : `<div class="note">生存底线没有发现重大风险标记。</div>`;
}

/* 顶梁柱与保护缺口（T-E0-043）。这一节回答的是产品存在的理由：
   谁在扛这个家，这个人出事之后家里还能撑多久，孩子的教育会不会被挤占。
   所有数字都来自同一个引擎结果对象，页面不做任何二次估算。 */
/* 顶梁柱与保护缺口弃权时的原因：契约命中的走中文，未命中的英文原句不直接给用户看。 */
function breadwinnerAbstainReason(b) {
  const entry = (VERITY_I18N["status_reason"] || {}).breadwinner_abstain;
  const hit = zhSentence(entry, (b || {}).status_reason);
  if (hit.matched) return hit.cn;
  const reason = (b || {}).status_reason || "";
  return looksEnglish(reason) ? "引擎拒绝下判断，本节遵循同一闸门。" : reason || "证据不足";
}

function renderBreadwinner(result) {
  const b = result.breadwinner || {};
  const gap = b.protection_gap || {};
  const needs = b.needs || {};
  const edu = b.education || {};
  const abstained = b.status === "ABSTAIN";
  /* 线上验收脚本按同一份数据核对页面上的每一格（Round 23 十一套件之一）。 */
  window.__verityBreadwinnerView = {
    status: b.status,
    status_reason: b.status_reason,
    primary_breadwinner_id: b.primary_breadwinner_id,
    top_income_share: b.top_income_share,
    concentration: b.concentration,
    concentration_flag: b.concentration_flag,
    breadwinners: b.breadwinners || [],
    needs,
    education: { status: edu.status, need: edu.need, funded_events: edu.funded_events, unfunded_events: edu.unfunded_events },
    protection_gap: gap,
    scenarios: b.scenarios || [],
    actions: b.actions || [],
  };

  if (abstained) {
    $("r-breadwinner-summary").innerHTML =
      `<span class="pill info">弃权 ABSTAIN</span> <span class="pill">${esc(breadwinnerAbstainReason(b))}</span>`;
    $("r-breadwinner-needs").innerHTML = "";
    $("r-breadwinner-education").innerHTML = "";
    $("r-breadwinner-actions").innerHTML = "";
    $("r-breadwinner-scenarios").tBodies[0].innerHTML =
      '<tr><td colspan="9" class="note">引擎已弃权，不做任何缺口推算。</td></tr>';
    $("r-breadwinner-members").tBodies[0].innerHTML =
      '<tr><td colspan="7" class="note">引擎已弃权，不展示成员收入占比。</td></tr>';
    return;
  }

  const primary = (b.breadwinners || []).find((m) => m.member_id === b.primary_breadwinner_id) || {};
  const concCn = cn(STATUS_CN, b.concentration, b.concentration);
  const concCls = b.concentration === "SINGLE_POINT_OF_FAILURE" ? "warn" : b.concentration === "SHARED" ? "ok" : "info";

  $("r-breadwinner-summary").innerHTML = `
    <span class="pill info">顶梁柱 <code class="mono">${esc(b.primary_breadwinner_id || "—")}</code></span>
    <span class="pill ${concCls}">收入结构：${esc(concCn)}<code class="mono" style="margin-left:6px">${esc(b.concentration || "")}</code></span>
    <span class="pill">最高收入占比 ${pct(b.top_income_share, 1)}</span>
    <span class="pill">家庭年收入合计 ${money(b.gross_income)}</span>
    <span class="pill ${gap.status === "COVERED" ? "ok" : gap.status === "PARTIAL" ? "warn" : "bad"}">保护缺口：${esc(cn(STATUS_CN, gap.status, gap.status))}</span>`;

  $("r-breadwinner-members").tBodies[0].innerHTML = (b.breadwinners || [])
    .map((m) => `<tr>
      <td><code class="mono">${esc(m.member_id)}</code></td>
      <td>${esc(cnCode(ROLE_CN, m.role))}</td>
      <td class="num">${m.age === null || m.age === undefined ? "—" : esc(String(m.age))}</td>
      <td class="num">${money(m.annual_income)}</td>
      <td class="num">${pct(m.income_share, 1)}</td>
      <td><span class="pill ${m.is_breadwinner ? "ok" : "info"}">${m.is_breadwinner ? "是" : "否"}</span></td>
      <td>${esc(cnCode(STABILITY_CN, m.income_stability))}</td>
    </tr>`)
    .join("");

  $("r-breadwinner-needs").innerHTML = `
    <div class="metric"><div class="k">应急金目标金额</div><div class="v">${money(needs.survival_floor_value)}</div><div class="h">按家庭自己记录的 ${fmt(needs.target_days, 0)} 天刚性支出换算</div></div>
    <div class="metric"><div class="k">子女教育等刚性未来支出</div><div class="v">${money(needs.rigid_outflows_total)}</div><div class="h">其中教育 ${money(needs.education_need)}</div></div>
    <div class="metric"><div class="k">刚性需求合计</div><div class="v">${money(needs.need_total)}</div><div class="h">应急金目标 + 刚性支出 + 12 个月强制还款 ${money(needs.debt_service_annual)}</div></div>
    <div class="metric"><div class="k">可动用流动资产</div><div class="v">${money(needs.liquid_assets)}</div><div class="h">不含自住房等无法动用资产</div></div>`;

  const eduItems = (edu.items || [])
    .map((it) => `<li>${esc(it.label)} · ${money(it.amount)}${it.years_until_due === null || it.years_until_due === undefined ? "" : ` · ${fmt(it.years_until_due, 1)} 年后到期`}<span class="pill ${it.near_term ? "warn" : "info"}" style="margin-left:8px">${it.near_term ? "近期" : "远期"}</span></li>`)
    .join("");
  const eduCls = edu.status === "PROTECTED" ? "ok" : edu.status === "NOT_RECORDED" ? "info" : "bad";
  $("r-breadwinner-education").innerHTML = `
    <h3 style="margin:0 0 8px;font-size:14px">子女教育连续性</h3>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">
      <span class="pill ${eduCls}">${esc(cn(STATUS_CN, edu.status, edu.status))}</span>
      <span class="pill">教育资金需求 ${money(edu.need)}</span>
      <span class="pill">可隔离情景 ${(edu.funded_events || []).length}/${(b.scenarios || []).length}</span>
    </div>
    <div class="note">${esc(edu.finding_cn || "")}</div>
    ${eduItems ? `<ul>${eduItems}</ul>` : ""}`;

  $("r-breadwinner-scenarios").tBodies[0].innerHTML = (b.scenarios || [])
    .map((s) => {
      const cls = s.status === "SURVIVES" ? "ok" : s.status === "STRESSED" ? "warn" : "bad";
      const months = s.survival_months === null || s.survival_months === undefined
        ? "剩余收入可覆盖"
        : `${fmt(s.survival_months, 1)} 个月`;
      return `<tr>
        <td>${esc(s.label_cn)}<div class="subnote">${esc(s.note_cn || "")}</div></td>
        <td class="num">${money(s.lost_income_annual)}</td>
        <td class="num">${money(s.payout_recorded)}</td>
        <td class="num">${money(s.resources_after_insurance)}</td>
        <td class="num">${money(s.need_total)}</td>
        <td class="num ${s.gap_after_insurance > 0 ? "neg" : "pos"}">${money(s.gap_after_insurance)}<div class="subnote">保险前 ${money(s.gap_before_insurance)}</div></td>
        <td class="num">${months}<div class="subnote">目标 ${fmt(s.target_months, 1)} 个月</div></td>
        <td><span class="pill ${s.education_funded ? "ok" : "bad"}">${s.education_funded ? "可隔离" : "会被挤占"}</span></td>
        <td><span class="pill ${cls}">${esc(cn(STATUS_CN, s.status, s.status))}<code class="mono" style="margin-left:6px">${esc(s.status)}</code></span><div class="subnote">${esc(s.finding_cn || "")}</div></td>
      </tr>`;
    })
    .join("");

  const actions = (b.actions || [])
    .map((a) => `<li><b>${esc(a.priority)}</b> ${esc(a.action_cn)}${a.cost_estimate ? ` · 涉及资金 ≈${money(a.cost_estimate)}` : ""}<div class="subnote">${esc(a.rationale || "")}</div></li>`)
    .join("");

  $("r-breadwinner-actions").innerHTML = `
    <h3 style="margin:0 0 8px;font-size:14px">这一节给出的优先动作</h3>
    ${actions ? `<ul>${actions}</ul>` : `<div class="note">三种情景下都不存在缺口，本轮没有新增动作。</div>`}
    <div class="note">缺口口径：${esc(gap.formula_cn || "")}。最坏情景为「${esc(gap.worst_event_label_cn || "—")}」，缺口 ${money(gap.worst_gap_after_insurance)}。${esc((b.insurance_reference || {}).note_cn || "")}</div>`;
}
/* 年度目标进度与止盈状态（T-E0-044）。这一节回答的是长期资金那一侧的问题：
   先隔离应急金目标、5 年内到期的刚性支出与一年保障保费，剩下的长期资金今年要赚多少才算达标；窗口外到期的刚性支出由它承担并按到期月份在月度投影中扣除。什么时候该停止新增风险。
   目标收益率来自家庭自己记录的数字；已实现收益只按记录读取，页面不做任何推算。 */
function annualGoalAbstainReason(a) {
  const entry = (VERITY_I18N["status_reason"] || {}).annual_goal_abstain;
  const hit = zhSentence(entry, (a || {}).status_reason);
  if (hit.matched) return hit.cn;
  const reason = (a || {}).status_reason || "";
  return looksEnglish(reason) ? "引擎拒绝下判断，本节遵循同一闸门。" : reason || "证据不足";
}

const ANNUAL_GOAL_STATE_CN = {
  EVIDENCE_INSUFFICIENT: "证据不足（弃权）",
  PROTECTION_FIRST: "先补保障，暂不新增风险",
  REDUCE_RISK_FIRST: "先降风险，再谈目标",
  PROGRESS_NOT_RECORDED: "闸门通过，但本年进度未记录",
  CONTINUE_ON_PLAN: "按计划继续",
  LOCK_PARTIAL: "接近目标，锁定部分利润",
  STOP_ADDING_RISK: "已达目标，停止新增风险",
};
const ANNUAL_GOAL_STATE_CLS = {
  STOP_ADDING_RISK: "ok",
  LOCK_PARTIAL: "warn",
  PROTECTION_FIRST: "bad",
  REDUCE_RISK_FIRST: "bad",
  PROGRESS_NOT_RECORDED: "warn",
};
const ANNUAL_GOAL_PROGRESS_CN = {
  ACHIEVED: "已达成", APPROACHING: "接近达成", BEHIND: "尚未达成", NOT_RECORDED: "未记录",
};

function renderAnnualGoal(result) {
  const a = result.annual_goal || {};
  const basis = a.basis || {};
  const progress = a.progress || {};
  const guardrails = a.guardrails || {};
  const abstained = a.status === "ABSTAIN";
  /* 线上验收脚本按同一份数据核对页面上的每一格（Round 24 十三套件之一）。 */
  window.__verityAnnualGoalView = {
    status: a.status,
    status_reason: a.status_reason,
    state: a.state,
    state_label_cn: a.state_label_cn,
    basis,
    milestones: a.milestones || [],
    progress,
    guardrails,
    lock_profit_condition_cn: a.lock_profit_condition_cn,
    stop_risk_condition_cn: a.stop_risk_condition_cn,
    actions: a.actions || [],
  };

  if (abstained) {
    const stateLabel = cn(ANNUAL_GOAL_STATE_CN, a.state, a.state_label_cn || a.state);
    $("r-annual-goal-summary").innerHTML =
      `<span class="pill info">弃权 ABSTAIN</span> <span class="pill">${esc(stateLabel)}</span> <span class="pill">${esc(annualGoalAbstainReason(a))}</span>`;
    $("r-annual-goal-basis").innerHTML = "";
    $("r-annual-goal-progress").innerHTML = "";
    $("r-annual-goal-guardrails").innerHTML = "";
    $("r-annual-goal-actions").innerHTML = "";
    $("r-annual-goal-milestones").tBodies[0].innerHTML =
      '<tr><td colspan="3" class="note">引擎已弃权，不计算任何年度目标。</td></tr>';
    return;
  }

  const state = a.state;
  const stateCn = cn(ANNUAL_GOAL_STATE_CN, state, a.state_label_cn || state);
  $("r-annual-goal-summary").innerHTML = `
    <span class="pill ${ANNUAL_GOAL_STATE_CLS[state] || "info"}">止盈状态：${esc(stateCn)}<code class="mono" style="margin-left:6px">${esc(state || "")}</code></span>
    <span class="pill">进度：${esc(cn(ANNUAL_GOAL_PROGRESS_CN, progress.status, progress.status_label_cn || progress.status))}</span>
    <span class="pill">目标年化回报 ${pct(basis.target_annual_return, 2)}</span>
    <span class="pill">剩余 ${money(progress.remaining_amount)}</span>`;

  $("r-annual-goal-basis").innerHTML = `
    <div class="metric"><div class="k">年度目标金额</div><div class="v">${money(basis.target_amount)}</div><div class="h">长期资金 × 目标年化回报</div></div>
    <div class="metric"><div class="k">长期资金（5 年内到期刚性已隔离）</div><div class="v">${money(basis.long_term_growth)}</div><div class="h">窗口外刚性支出由它承担，按到期月份在投影中扣除；不是家庭总资产</div></div>
    <div class="metric"><div class="k">本月目标</div><div class="v">${money(basis.monthly_target)}</div><div class="h">按 12 个月均分，不是承诺</div></div>
    <div class="metric"><div class="k">本年已记录净收益</div><div class="v ${progress.recorded ? "" : "info"}">${progress.recorded ? money(progress.recorded_net_gain) : "未记录"}</div><div class="h">${progress.recorded ? `记录日期 ${esc(progress.recorded_as_of || "—")}` : "不推算，只读取记录"}</div></div>`;

  const barWidth = progress.progress_ratio === null || progress.progress_ratio === undefined
    ? 0
    : Math.max(0, Math.min(100, Number(progress.progress_ratio) * 100));
  $("r-annual-goal-progress").innerHTML = `
    <h3 style="margin:0 0 8px;font-size:14px">本年度目标进度</h3>
    <div class="bar" style="min-width:0"><i style="width:${barWidth.toFixed(2)}%;background:${progress.status === "ACHIEVED" ? "#1e7d4b" : progress.status === "APPROACHING" ? "#b26a00" : "#3556b3"}"></i></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">
      <span class="pill">已记录净收益 ${progress.recorded ? money(progress.recorded_net_gain) : "未记录"}</span>
      <span class="pill">进度 ${progress.progress_ratio === null || progress.progress_ratio === undefined ? "无法判断" : pct(progress.progress_ratio, 1)}</span>
      <span class="pill">距 100% 还差 ${money(progress.remaining_amount)}</span>
      <span class="pill">已锁定利润 ${money(progress.locked_profit)}</span>
    </div>
    <div class="note">${esc(progress.note_cn || "")}</div>`;

  $("r-annual-goal-milestones").tBodies[0].innerHTML = (a.milestones || [])
    .map((m) => `<tr>
      <td>${esc(m.label_cn || pct(m.ratio, 0))}</td>
      <td class="num">${money(m.amount)}</td>
      <td class="num">${money(m.remaining)}</td>
    </tr>`)
    .join("");

  const within = guardrails.drawdown_within_budget;
  const withinCn = within === true ? "在预算内" : within === false ? "超出预算" : "未记录";
  $("r-annual-goal-guardrails").innerHTML = `
    <h3 style="margin:0 0 8px;font-size:14px">进入止盈判断前先过三道闸门</h3>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <span class="pill ${guardrails.protection_covered === false ? "bad" : guardrails.protection_covered ? "ok" : "info"}">顶梁柱保护缺口 ${money(guardrails.protection_gap)}${guardrails.protection_gap_status ? `（${esc(guardrails.protection_gap_status)}）` : ""}</span>
      <span class="pill ${guardrails.survival_ok === false ? "bad" : guardrails.survival_ok ? "ok" : "info"}">生存底线 ${guardrails.safety_days === null || guardrails.safety_days === undefined ? "未记录" : `${fmt(guardrails.safety_days, 0)} 天`}（引擎下限 ${fmt(guardrails.min_survival_days, 0)} 天）</span>
      <span class="pill ${within === false ? "bad" : within ? "ok" : "info"}">模拟最大回撤 ${pct(guardrails.simulated_max_drawdown)} · 可承受损失 ${pct(guardrails.max_tolerable_loss_pct)} · ${withinCn}</span>
    </div>
    <div class="note">顺序是固定的：保障 → 生存底线 → 损失预算 → 止盈。任何一道没过，都会先出现在这一节的优先动作里。</div>`;

  const actions = (a.actions || [])
    .map((x) => `<li><b>${esc(x.priority)}</b> ${esc(x.action_cn)}${x.amount ? ` · 涉及资金 ≈${money(x.amount)}` : ""}<div class="subnote">${esc(x.rationale || "")}</div></li>`)
    .join("");
  $("r-annual-goal-actions").innerHTML = `
    <h3 style="margin:0 0 8px;font-size:14px">这一节给出的优先动作</h3>
    ${actions ? `<ul>${actions}</ul>` : `<div class="note">本节没有新增动作。</div>`}
    <div class="note">口径：${esc(a.formula_cn || "")}<br />锁定利润条件：${esc(a.lock_profit_condition_cn || "")}<br />停止新增风险条件：${esc(a.stop_risk_condition_cn || "")}</div>`;
}
function renderRisk(result) {
  const ranking = result.risk_ranking || {};
  const level = ranking.overall_risk_level || "ABSTAIN";
  const codes = ranking.reason_codes || [];
  const items = (ranking.ranked_risks || [])
    .map(
      (r, index) => {
      const i18nRisk = (VERITY_I18N["safety"] || {})[r.risk_id] || {};
      const detailHit = zhSentence(i18nRisk, r.detail_cn);
      const detailCn = detailHit.matched ? detailHit.cn : looksEnglish(r.detail_cn) ? "" : r.detail_cn;
      return `
    <div class="risk-item">
      <div class="risk-head">
        <span class="rank">${index + 1}</span>
        <span class="risk-title">${esc(r.label_cn || r.label_en || r.risk_id)}</span>
        <span class="pill ${r.status === "ACTIVE" ? "bad" : "info"}">${esc(cn(STATUS_CN, r.status, r.status))}</span>
        <span class="pill">${esc(cn(CATEGORY_CN, r.category, r.category))}</span>
        <span class="pill ${r.severity === "critical" || r.severity === "high" ? "bad" : r.severity === "medium" ? "warn" : "ok"}">${esc(cn(SEVERITY_CN, r.severity, r.severity))}</span>
        <span class="pill info">概率 ${pct(r.probability, 0)}</span>
        <span class="pill info">得分 ${fmt(r.score, 2)}</span>
      </div>
      <div class="risk-line">发现：${esc(detailCn)}<code class="mono" style="margin-left:8px">${esc(r.risk_id)}</code></div>
      <div class="risk-line">应对：${esc(r.response_cn || "")}</div>
      <div class="risk-line subnote">证据：风险来源块 <code class="mono">${esc(r.block || "—")}</code> · 严重度权重 × 概率 = ${fmt(r.score, 2)}</div>
    </div>`;
      }
    )
    .join("");

  const i18nRanking = VERITY_I18N["risk_ranking"] || {};
  const methodCn = zhFirstMatch(i18nRanking.ranking_methods, ranking.ranking_method);
  const noticeCn = zhFirstMatch(i18nRanking.notices, ranking.notice);

  $("r-risk-body").innerHTML = `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
      <span class="pill ${ranking.status === "RANKED" ? "ok" : "info"}">${esc(cn(STATUS_CN, ranking.status, ranking.status))}</span>
      <span class="pill ${level === "RESILIENT" ? "ok" : level === "ABSTAIN" ? "info" : "bad"}">整体风险等级 ${esc(level)}</span>
      <span class="pill info">共 ${ranking.risk_count || 0} 项 · 已触发 ${ranking.active_count || 0} 项</span>
      <span class="pill">最高优先级：${esc(ranking.top_risk_id || "无")}</span>
    </div>
    ${codes.length ? `<div style="margin-bottom:10px">${codes.map((c) => `<span class="pill info">${esc(c)}</span>`).join(" ")}</div>` : ""}
    ${items || `<div class="note">这个家庭当前没有被引擎标记出的风险项，风险等级为 ${esc(level)}。</div>`}
    <div class="note">${esc(methodCn || (looksEnglish(ranking.ranking_method) ? "（方法说明转译缺失）" : ranking.ranking_method))} ${esc(noticeCn || (looksEnglish(ranking.notice) ? "（说明转译缺失）" : ranking.notice))}</div>`;
}

function renderProtection(result) {
  const plan = result.protection || {};
  const insurance = result.insurance || {};
  const domains = plan.domains || {};
  const order = plan.domain_order || ["cash", "insurance", "assets", "debt", "legal", "social"];

  const cards = order
    .map((key) => {
      const domain = domains[key] || {};
      const status = domain.status || "ABSTAIN";
      const cls = status === "SECURED" ? "ok" : status === "GAP" ? "bad" : status === "NOT_RECORDED" || status === "REVIEW" ? "warn" : "info";
      const actions = (domain.actions || [])
        .map((a) => `<li><b>${esc(a.priority)}</b> ${esc(a.action_cn)}${a.cost_estimate ? ` · 预计 ≈${money(a.cost_estimate)}` : ""}<div class="subnote">${esc(a.rationale || "")}</div></li>`)
        .join("");
      return `
      <div class="domain-card">
        <div class="dhead">
          <span class="dname">${esc(domain.label_cn || key)}</span>
          <span class="pill ${cls}">${esc(cn(STATUS_CN, status, status))}</span>
        </div>
        <div class="finding">${esc(domain.finding || "")}</div>
        ${actions ? `<ul>${actions}</ul>` : ""}
      </div>`;
    })
    .join("");

  const planRows = (plan.priority_actions || [])
    .map(
      (a) => `<tr>
      <td><span class="pill ${a.priority === "P0" ? "bad" : a.priority === "P1" ? "warn" : "info"}">${esc(a.priority)}</span></td>
      <td>${esc(a.domain_label || "")}</td>
      <td>${esc(a.action_cn)}</td>
      <td>${esc(a.rationale || "")}</td>
      <td class="num">${a.cost_estimate ? money(a.cost_estimate) : "—"}</td>
    </tr>`
    )
    .join("");

  const caps = (insurance.capability_order || [])
    .map((cap) => {
      const c = (insurance.capabilities || {})[cap] || {};
      const st = c.status || "GAP";
      const cls = st === "COVERED" || st === "NOT_APPLICABLE" ? "ok" : st === "PARTIAL" ? "warn" : "bad";
      return `<tr><td>${esc(c.label_cn || cap)}</td><td class="num">${money(c.need)}</td><td class="num">${money(c.coverage)}</td><td class="num ${c.gap > 0 ? "neg" : "pos"}">${money(c.gap)}</td><td><span class="pill ${cls}">${esc(cn(STATUS_CN, st, st))}</span></td></tr>`;
    })
    .join("");

  $("r-protection-body").innerHTML = `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
      <span class="pill ${plan.status === "SECURED" ? "ok" : plan.status === "GAPS" ? "bad" : "warn"}">综合保护状态：${esc(plan.status || "ABSTAIN")}</span>
      <span class="pill info">${esc(plan.status_reason || "")}</span>
      <span class="pill">保障能力得分 ${insurance.coverage_score === null || insurance.coverage_score === undefined ? "—" : insurance.coverage_score}</span>
      <span class="pill">保费负担 ${esc(insurance.premium_burden_status || "—")}</span>
    </div>
    ${cards}
    <h3 style="margin:18px 0 8px;font-size:14px">优先行动清单（按领域与优先级）</h3>
    <div class="scroll"><table>
      <thead><tr><th>优先级</th><th>领域</th><th>动作</th><th>理由</th><th class="num">预计成本</th></tr></thead>
      <tbody>${planRows || `<tr><td colspan="5" class="note">引擎没有返回优先行动。</td></tr>`}</tbody>
    </table></div>
    <h3 style="margin:18px 0 8px;font-size:14px">保险能力缺口审计（六域之一，不是产品中心）</h3>
    <div class="scroll"><table>
      <thead><tr><th>保障能力</th><th class="num">测算需求</th><th class="num">已记录保额</th><th class="num">缺口</th><th>状态</th></tr></thead>
      <tbody>${caps || `<tr><td colspan="5" class="note">没有可用的保险审计结果。</td></tr>`}</tbody>
    </table></div>
    <div class="note">${esc(zhFirstMatch((VERITY_I18N["insurance"] || {}).disclaimers, insurance.disclaimer || "") || insurance.disclaimer || "Verity 不推荐任何保险公司、产品或机构。")}</div>`;
}

function renderStress(result) {
  const stress = result.stress || {};
  const scenarios = stress.scenarios || [];
  const totalAssets = Number((result.safety || {}).total_assets) || 0;
  const rows = scenarios
    .map((s) => {
      const breakdown = s.cash_outflow_breakdown || {};
      const parts = [];
      if (breakdown.uncovered_medical) parts.push(`医疗未覆盖 ${money(breakdown.uncovered_medical)}`);
      if (breakdown.essential_cost_escalation) parts.push(`必要支出上涨 ${money(breakdown.essential_cost_escalation)}`);
      if (breakdown.debt_repricing) parts.push(`债务重定价 ${money(breakdown.debt_repricing)}`);
      const loss = Number(s.portfolio_loss) || 0;
      const lossShare = totalAssets ? `<div class="subnote">占家庭资产 ${pct(loss / totalAssets)}</div>` : "";
      return `<tr>
      <td>${esc(SCENARIO_CN[s.scenario_id] || s.label_cn || s.label || s.scenario_id)}</td>
      <td class="num">${money(loss)}${lossShare}</td>
      <td class="num">${money(s.cash_outflow)}${
        parts.length ? `<div class="subnote">${esc(parts.join(" ＋ "))}</div>` : ""
      }</td>
      <td class="num">${money(s.income_loss)}</td>
      <td class="num">${fmt(s.survival_days_after, 1)}</td>
      <td>${s.breaches_floor ? '<span class="pill bad">击穿底线</span>' : '<span class="pill ok">未击穿</span>'}</td>
      <td class="sev-${esc(s.severity)}">${esc(cn(SEVERITY_CN, s.severity, s.severity))}</td>
      <td class="subnote">${esc(s.notes_cn || s.notes || "")}</td>
    </tr>`;
    })
    .join("");
  $("r-stress-table").querySelector("tbody").innerHTML =
    rows || `<tr><td colspan="8" class="note">没有可用的压力情景结果。</td></tr>`;

  const summary = $("r-stress-summary");
  if (summary) {
    if (!scenarios.length) {
      summary.innerHTML = "";
    } else {
      const worst = stress.worst_scenario || {};
      const worstCn = SCENARIO_CN[stress.worst_scenario_id] || worst.label_cn || worst.label || stress.worst_scenario_id || "—";
      summary.innerHTML =
        `<span class="pill ${stress.survival_breach ? "bad" : "ok"}">击穿生存底线：${stress.survival_breach ? "是" : "否"}</span> ` +
        `<span class="pill ${stress.breach_count ? "bad" : "ok"}">击穿情景数 ${stress.breach_count || 0} / ${scenarios.length}</span> ` +
        `<span class="pill warn">最差情景：${esc(worstCn)}（${fmt(worst.survival_days_after, 1)} 天）</span>`;
    }
  }

  lastStressView = {
    scenario_count: scenarios.length,
    scenario_set_version: stress.scenario_set_version || null,
    worst_scenario_id: stress.worst_scenario_id || null,
    breach_count: stress.breach_count || 0,
    survival_breach: Boolean(stress.survival_breach),
    scenarios: scenarios.map((s) => ({
      scenario_id: s.scenario_id,
      portfolio_loss: s.portfolio_loss,
      cash_outflow: s.cash_outflow,
      income_loss: s.income_loss,
      survival_days_after: s.survival_days_after,
      breaches_floor: Boolean(s.breaches_floor),
      severity: s.severity,
      notes_cn: s.notes_cn || "",
    })),
  };
  window.__verityStressView = lastStressView;
}

let lastTimelineView = null;

/* ---------------------------------------- 危险时间轴：第几个月进入危险区 (T-E0-034) */
function renderTimeline(result) {
  const timeline = (result && result.timeline) || {};
  const rows = Array.isArray(timeline.rows) ? timeline.rows : [];
  const summary = timeline.summary || {};

  const summaryBox = $("r-timeline-summary");
  const table = $("r-timeline-table");
  if (!summaryBox || !table) return;

  if (timeline.status !== "OK" || !rows.length) {
    summaryBox.innerHTML = `<span class="pill bad">ABSTAIN · ${esc((timeline.reason_codes || []).join("、") || "证据不足")}</span>`;
    table.tBodies[0].innerHTML =
      `<tr><td colspan="7"><div class="err">${esc(timeline.status_reason || "危险时间轴按失败关闭：无法判断这个家庭第几个月进入危险区。")}</div></td></tr>`;
    lastTimelineView = { status: timeline.status, rows: 0, summary: null };
    window.__verityTimelineView = lastTimelineView;
    return;
  }

  const earliest = summary.earliest_breach_month;
  summaryBox.innerHTML = [
    earliest
      ? `<span class="pill bad">12 个月内最早进入危险区：第 ${earliest} 个月（${esc(summary.earliest_breach_scenario_label_cn || "—")}）</span>`
      : `<span class="pill ok">12 个月内：全部情景未击穿现金底线</span>`,
    `<span class="pill ${summary.breach_count_within_horizon ? "bad" : "ok"}">12 个月内击穿情景 ${summary.breach_count_within_horizon || 0} / ${rows.length}</span>`,
    `<span class="pill info">${timeline.horizon_months || 12} 个月关口 · ${timeline.long_horizon_months || 60} 个月投影 · 不假设投资收益</span>`,
  ].join(" ");

  const body = rows
    .map((row) => {
      const monthTxt =
        row.status !== "OK"
          ? `<span class="pill info">ABSTAIN</span>`
          : row.breach_in_months
          ? `<span class="pill bad">第 ${row.breach_in_months} 个月</span>`
          : row.beyond_horizon_breach_month
          ? `<span class="pill ok">12 个月内安全</span>`
          : `<span class="pill ok">未见击穿</span>`;
      const gateTxt =
        row.status !== "OK"
          ? "无法判定"
          : row.within_horizon
          ? `<span class="pill bad">月内击穿</span>`
          : row.beyond_horizon_breach_month
          ? `<span class="pill warn">预计第 ${row.beyond_horizon_breach_month} 个月</span>`
          : `<span class="pill ok">安全</span>`;
      const notes =
        row.status === "OK"
          ? `<span class="pf-dim">${esc(row.notes_cn || "")}</span>`
          : `<span class="err">${esc(row.status_reason || "")}</span>`;
      return `<tr class="${row.within_horizon ? "row-deficit" : ""}">
        <td>${esc(SCENARIO_CN[row.scenario_id] || row.label_cn || row.label || row.scenario_id)}</td>
        <td class="num">${monthTxt}</td>
        <td>${gateTxt}</td>
        <td class="num">${row.portfolio_loss ? money(row.portfolio_loss) : "—"}</td>
        <td class="num">${row.cash_outflow ? money(row.cash_outflow) : "—"}</td>
        <td class="num">${row.income_loss ? money(row.income_loss) : "—"}</td>
        <td>${notes}</td>
      </tr>`;
    })
    .join("");

  table.tBodies[0].innerHTML = body;

  lastTimelineView = {
    status: timeline.status,
    horizon_months: timeline.horizon_months,
    long_horizon_months: timeline.long_horizon_months,
    scenario_count: rows.length,
    rows: rows.map((r) => ({
      scenario_id: r.scenario_id,
      status: r.status,
      breach_in_months: r.breach_in_months,
      within_horizon: r.within_horizon,
      beyond_horizon_breach_month: r.beyond_horizon_breach_month,
      portfolio_loss: r.portfolio_loss,
      cash_outflow: r.cash_outflow,
      income_loss: r.income_loss,
      end_runway_days: r.end_runway_days,
    })),
    summary: { ...summary },
    return_assumption: timeline.return_assumption,
  };
  window.__verityTimelineView = lastTimelineView;
}

function renderEvidence(result) {
  const evidence = result.evidence || {};
  const audit = result.audit || {};
  const protectionEvidence = (result.protection || {}).evidence || {};
  const riskEvidence = (result.risk_ranking || {}).evidence || {};
  const sources = (evidence.sources || []).map((s) => `<li><code class="mono">${esc(s)}</code></li>`).join("");
  const assumptionEntries = (VERITY_I18N["evidence"] || {}).assumptions || [];
  const assumptions = (evidence.assumptions || [])
    .map((s) => {
      const cnText = zhFirstMatch(assumptionEntries, s);
      return `<li>${esc(cnText || (looksEnglish(s) ? "（原假设为英文，转译缺失）" : s))}</li>`;
    })
    .join("");
  const riskNoticeCn = zhFirstMatch(VERITY_I18N["risk_notice"] || [], result.risk_notice || audit.risk_notice || "");
  storeDigest = evidence.inputs_digest || "";

  $("r-evidence-body").innerHTML = `
    <div class="ev-block">
      <h3>本次运行的证据</h3>
      <div class="kv"><span class="k">run_id</span><span class="v">${esc(result.run_id)}</span></div>
      <div class="kv"><span class="k">算法版本</span><span class="v">${esc(evidence.algorithm_version || result.algorithm_version)}</span></div>
      <div class="kv"><span class="k">证据状态</span><span class="v">${esc(evidence.evidence_status || "—")}</span></div>
      <div class="kv"><span class="k">输入摘要 sha256</span><span class="v">${esc(evidence.inputs_digest || "—")}</span></div>
      <div class="kv"><span class="k">输出摘要 sha256</span><span class="v">${esc(evidence.output_digest || "—")}</span></div>
      <div class="kv"><span class="k">计算时间 (UTC)</span><span class="v">${esc(evidence.computed_at_utc || "—")}</span></div>
      <div class="kv"><span class="k">保护方案证据哈希</span><span class="v">${esc(protectionEvidence.record_hash || "—")}</span></div>
      <div class="kv"><span class="k">风险排序证据哈希</span><span class="v">${esc(riskEvidence.record_hash || "—")}</span></div>
    </div>
    <div class="ev-block">
      <h3>哈希链审计记录</h3>
      <div class="kv"><span class="k">记录序号</span><span class="v">${esc(audit.sequence)}</span></div>
      <div class="kv"><span class="k">payload 摘要</span><span class="v">${esc(audit.payload_digest || "—")}</span></div>
      <div class="kv"><span class="k">prev_hash</span><span class="v">${esc(audit.prev_hash || "—")}</span></div>
      <div class="kv"><span class="k">record_hash</span><span class="v">${esc(audit.record_hash || "—")}</span></div>
      <div class="kv"><span class="k">风险声明</span><span class="v">${esc(riskNoticeCn || result.risk_notice || audit.risk_notice || "—")}</span></div>
    </div>
    <div class="ev-block">
      <h3>数据来源与假设</h3>
      <div class="subnote">来源</div>
      <ul style="margin:6px 0 10px 18px;color:var(--muted);font-size:12.5px">${sources || "<li>—</li>"}</ul>
      <div class="subnote">假设</div>
      <ul style="margin:6px 0 0 18px;color:var(--muted);font-size:12.5px">${assumptions || "<li>—</li>"}</ul>
    </div>
    <div class="ev-block">
      <h3>完整引擎输出（可复核）</h3>
      <pre class="code" id="r-raw"></pre>
    </div>`;
  $("r-raw").textContent = JSON.stringify(result, null, 1);
}

/* ------------------------------------------------------------------ 运行流程 */
let lastProfile = null;
let runPending = false;

async function run() {
  const missing = validate();
  if (missing.length) {
    $("w-error").textContent = "还有必填项未填写，先把家庭档案补完整。";
    return;
  }
  const profile = collectProfile();
  lastProfile = profile;
  $("w-error").textContent = "";
  $("w-run").disabled = true;
  runPending = true;
  $("w-run").textContent = CHANNEL === "api" ? "运行中…" : "正在准备浏览器引擎…";
  renderEngineStrip();

  try {
    const { channel, result, resultText } = await runEngine(profile);
    renderMeta(result, channel);
    renderVerdict(result);
    renderBalance(result, profile);
    lastResultForTrend = { result, profile };
    renderTrend(result, profile);
    renderSafety(result);
    renderBreadwinner(result);
    renderAnnualGoal(result);
    renderRisk(result);
    renderProtection(result);
    renderStress(result);
    renderTimeline(result);
    renderEvidence(result);
    rememberExportResult(result, channel);
    lastResultText = resultText;
    recordRunResult(result, profile);
    snapshotOpen = false;
    setResultSectionsVisible(true);
    $("r-snapshot").classList.add("hidden");
    const stored = await saveRunSnapshot(result, profile, resultText);
    if (!stored.saved) {
      setMsg(`结果已算出，但结果快照未保存：${stored.reason}。`, "warn");
    } else {
      setMsg(
        `「${(findProfile(currentProfileId) || {}).name || "当前档案"}」的结果快照已保存到本机，并通过 ${stored.proof.checks_passed}/${stored.proof.checks_total} 项哈希复核；下次打开这份档案可以重新复核当次结论。`,
        "ok"
      );
    }
    $("results").classList.remove("hidden");
    /* 首页总览必须跟着这次运行一起刷新：漏掉这一步时，用户跑完引擎回到首页
       仍然看到满屏「—」，会以为没算出来（Round 29 线上验收实测到的缺陷）。 */
    renderHome();
    renderHomeDashboard();
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    surfaceRunFailure((err && err.message) || String(err));
  } finally {
    runPending = false;
    $("w-run").disabled = false;
    $("w-run").textContent = "运行 Verity 引擎";
    renderEngineStrip();
  }
}

/* ------------------------------------------- 体检报告导出 (T-E0-032)
   把与本次运行完全相同的引擎输出（同一份 result 载荷）渲染成《家庭财务体检报告》：
   渲染器就是引擎自带 engine/report.py —— 通过 Pyodide 在浏览器里直接调用，
   与后端批量工具 produce 的是同一个实现，浏览器端不重新实现任何一段渲染逻辑。
   产物是单个自包含 HTML：不依赖网络、不外链脚本与样式，可离线打开、可直接转发。 */
let exportState = { result: null, channel: "" };
let lastResultText = "";
/* S-30-03（Round 31）：当次运行结果的归属主键是**档案条目 id**，不是档案编号字符串。
   档案编号（profile_id）是自由文本、产品不强制唯一；只比编号时，"李家跑完 → 建一份
   同样编号的王家 → 打开王家"会把李家的当次结果当成王家的显示（跨户串数据）。
   这里记下"这次运行是开着哪份档案跑出来的"，首页的 fresh 通道只认同一条目。 */
let freshResultOwnerId = "";
let reportBusy = false;

function setReportStatus(text, kind) {
  const status = $("r-report-status");
  if (!status) return;
  status.textContent = text || "";
  status.classList.toggle("warn", kind === "warn");
  status.classList.toggle("ok", kind === "ok");
}

/* 归属绑定：这次运行是开着哪份档案跑出来的。与结果同生共死 —— 清空结果
   （clearResultAreas → rememberExportResult(null, "")）时一并解绑，否则旧结果会一直
   "认领"着某份档案。运行发生在还没有打开任何档案时（currentProfileId 为空）记为空串，
   交给 addProfile 在落盘那一刻认领（"先运行、后保存"是首次建档的正常路径）。
   抽成具名函数是为了让审计/验收脚本能直接调它，测的是产品口径本身。 */
function bindFreshResultOwner() {
  freshResultOwnerId = exportState.result && currentProfileId ? currentProfileId : "";
  return freshResultOwnerId;
}

function rememberExportResult(result, channel) {
  exportState = { result: result || null, channel: channel || "" };
  bindFreshResultOwner();
  setReportButtons(Boolean(exportState.result));
  if (!exportState.result) {
    setReportStatus("运行引擎后即可导出：报告来自引擎本次真实输出，单文件自包含，可离线打开、可直接转发。");
  } else {
    const status = $("r-report-status");
    if (status) {
      status.textContent = "";
      status.classList.remove("warn", "ok");
    }
  }
}

function setReportButtons(ready) {
  const preview = $("r-report-preview");
  const download = $("r-report-download");
  if (preview) preview.disabled = !ready || reportBusy;
  if (download) download.disabled = !ready || reportBusy;
}

async function ensureReportRenderer() {
  if (CHANNEL === "api" && engineState.phase !== "ready" && engineState.phase !== "booting") {
    setReportStatus("正在准备浏览器内报告渲染器（复用引擎运行时，与这次运行同一实现）…");
  }
  return ensureBrowserEngine();
}

async function renderReportHtml() {
  if (!exportState.result) throw new Error("还没有可导出的引擎结果：先运行一次引擎。");
  const py = await ensureReportRenderer();
  py.globals.set("_verity_report_result", JSON.stringify(exportState.result));
  const html = py.runPython("_verity_report()");
  if (typeof html !== "string" || html.length < 500) throw new Error("报告渲染器返回了异常结果，已按失败关闭处理。");
  return html;
}

function reportFileBase(result) {
  const profileId = String(result.profile_id || "family").replace(/[^A-Za-z0-9_-]/g, "_");
  const runId = String(result.run_id || "run").replace(/[^A-Za-z0-9_-]/g, "_");
  return `verity-report-${profileId}-${runId}`;
}

async function previewReportHtml() {
  reportBusy = true;
  setReportButtons(true);
  try {
    setReportStatus("正在生成报告…");
    const html = await renderReportHtml();
    const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    const win = window.open(url, "_blank");
    if (win) {
      setReportStatus(
        `报告已在新标签页打开（${html.length.toLocaleString()} 字符，自包含、可离线）。点「下载报告 · HTML」得到一个可直接转发的单文件分享给家人或顾问。`,
        "ok"
      );
    } else {
      const status = $("r-report-status");
      status.textContent = "浏览器阻止了自动打开新标签页：";
      status.classList.remove("warn", "ok");
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "点击在浏览器新标签页打开报告";
      status.appendChild(link);
    }
    return url;
  } catch (err) {
    setReportStatus(`预览失败：${(err && err.message) || err}`, "warn");
    return null;
  } finally {
    reportBusy = false;
    setReportButtons(true);
  }
}

async function downloadReportHtml() {
  reportBusy = true;
  setReportButtons(true);
  try {
    setReportStatus("正在生成报告…");
    const html = await renderReportHtml();
    const base = reportFileBase(exportState.result);
    const name = `${base}.html`;
    const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    setReportStatus(
      `已下载「${name}」（${html.length.toLocaleString()} 字符）。报告单文件自包含：不依赖网络、不外链脚本与样式，可离线打开、可直接转发；再度打开是静态文档，不会自动跑引擎。`,
      "ok"
    );
    return name;
  } catch (err) {
    setReportStatus(`导出失败：${(err && err.message) || err}`, "warn");
    return null;
  } finally {
    reportBusy = false;
    setReportButtons(true);
  }
}

let demoProfile = null;

async function loadZhDemoFamily() {
  if (demoProfile) return demoProfile;
  /* 控制台同时被官网根目录与 /family/ 子路径引用：示范档案必须按运行时基址解析，
     否则在 /family/ 下会 404，八步向导拿不到预填输入、走不到结果页。 */
  const demoUrl = new URL(
    `${window.VERITY_RUNTIME_BASE || ""}zh-demo-family.json`,
    document.baseURI
  ).href;
  const res = await fetch(demoUrl, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`示范家庭档案不可用（HTTP ${res.status}）`);
  demoProfile = await res.json();
  return demoProfile;
}

function fillProfile(profile) {
  $("w-profile-id").value = profile.profile_id;
  $("w-currency").value = profile.currency || "CNY";
  $("w-members").innerHTML = "";
  (profile.members || []).forEach((member) => {
    const row = addMember(member);
    row.querySelector('[data-field="role"]').value = member.role || "primary_earner";
    row.querySelector('[data-field="income_stability"]').value = member.income_stability || "high";
  });
  $("w-essential").value = profile.annual_expenses_essential;
  $("w-discretionary").value = profile.annual_expenses_discretionary || 0;
  $("w-outflows").innerHTML = "";
  (profile.future_rigid_outflows || []).forEach((item) => $("w-outflows").appendChild(outflowRow(item)));

  ASSET_ROWS.forEach(([kind]) => {
    const asset = (profile.assets || []).find((a) => a.kind === kind);
    $(`w-asset-${kind}`).value = asset ? asset.value : 0;
  });
  LIABILITY_ROWS.forEach(([kind]) => {
    const liability = (profile.liabilities || []).find((l) => l.kind === kind);
    $(`w-liab-${kind}-balance`).value = liability ? liability.balance : 0;
    $(`w-liab-${kind}-rate`).value = liability ? liability.annual_rate : 0;
    $(`w-liab-${kind}-payment`).value = liability ? liability.mandatory_payment : 0;
  });
  PROTECTION_ROWS.forEach(([kind]) => {
    const policy = (profile.protection || []).find((p) => p.kind === kind);
    $(`w-prot-${kind}-coverage`).value = policy ? policy.coverage : 0;
    $(`w-prot-${kind}-premium`).value = policy ? policy.annual_premium : 0;
  });
  LEGAL_ROWS.forEach(([kind]) => {
    const item = (profile.legal_affairs || {})[kind] || {};
    $(`w-legal-${kind}`).checked = Boolean(item.recorded);
    $(`w-legal-${kind}-note`).value = item.note || "";
  });
  SOCIAL_ROWS.forEach(([kind]) => {
    const item = (profile.social_protection || {})[kind] || {};
    $(`w-social-${kind}`).checked = Boolean(item.recorded);
    $(`w-social-${kind}-note`).value = item.note || "";
  });
  $("w-horizon").value = profile.investment_horizon_years;
  $("w-target").value = profile.target_annual_return;
  $("w-tolerance").value = profile.max_tolerable_loss_pct;
  const annualGoal = profile.annual_goal || {};
  $("w-annual-gain").value =
    annualGoal.recorded_net_gain === null || annualGoal.recorded_net_gain === undefined
      ? ""
      : annualGoal.recorded_net_gain;
  $("w-annual-asof").value = annualGoal.recorded_as_of || "";
  validate();
}

function clearWizard() {
  $("w-profile-id").value = "MY-FAMILY-001";
  $("w-currency").value = "CNY";
  $("w-members").innerHTML = "";
  addMember({ age: 35, annual_income: 300000, income_stability: "high", dependents: 0 });
  $("w-essential").value = 0;
  $("w-discretionary").value = 0;
  $("w-outflows").innerHTML = "";
  ASSET_ROWS.forEach(([kind]) => {
    $(`w-asset-${kind}`).value = 0;
  });
  LIABILITY_ROWS.forEach(([kind]) => {
    $(`w-liab-${kind}-balance`).value = 0;
    $(`w-liab-${kind}-rate`).value = 0;
    $(`w-liab-${kind}-payment`).value = 0;
  });
  PROTECTION_ROWS.forEach(([kind]) => {
    $(`w-prot-${kind}-coverage`).value = 0;
    $(`w-prot-${kind}-premium`).value = 0;
  });
  LEGAL_ROWS.forEach(([kind]) => {
    $(`w-legal-${kind}`).checked = false;
    $(`w-legal-${kind}-note`).value = "";
  });
  SOCIAL_ROWS.forEach(([kind]) => {
    $(`w-social-${kind}`).checked = false;
    $(`w-social-${kind}-note`).value = "";
  });
  $("w-horizon").value = 15;
  $("w-target").value = 0.06;
  $("w-tolerance").value = 0.25;
  $("w-annual-gain").value = "";
  $("w-annual-asof").value = "";
  validate();
}

/* ------------------------------------------------------- 本机家庭档案库 (T-E0-026)
   档案只写入这台设备的 localStorage：不上传、无账号、不收集身份信息。
   存档是「用户输入」，不是「引擎结论」；再次打开只恢复输入，绝不自动重跑引擎。 */
const PROFILE_STORE_KEY = "verity.zh.profiles.v1";
const PROFILE_STORE_VERSION = 2;
const PROFILE_STORE_LEGACY_VERSIONS = [1];
const PROFILE_STORE_LIMIT = 20;
const PROFILE_EXPORT_KIND = "verity.household.profile";

let storeState = { version: PROFILE_STORE_VERSION, last_opened: "", profiles: [] };
let currentProfileId = "";

const nowStamp = () => new Date().toISOString().replace("T", " ").slice(0, 16);

function emptyStore() {
  return { version: PROFILE_STORE_VERSION, last_opened: "", profiles: [] };
}

/* 档案库迁移记录
 * v1 → v2（2026-09-16，T-E0-029）：新增 last_result 完整结果快照（引擎原始输出 + 家庭输入）
 *   与 last_result_proof（复核证据摘要）。v1 档案没有该字段，读取时补 null，
 *   已有的家庭输入原样保留，不做任何猜测性改写。
 * 高于本页支持版本的档案库一律失败关闭：隔离原始数据并以空库启动，绝不按旧规则误读。 */
function migrateStore(parsed) {
  const version = Number(parsed.version) || 1;
  if (version > PROFILE_STORE_VERSION) {
    throw new Error(`档案库版本 ${version} 高于本页支持的 ${PROFILE_STORE_VERSION}`);
  }
  if (version === PROFILE_STORE_VERSION) {
    return { profiles: parsed.profiles, last_opened: parsed.last_opened || "", note: "" };
  }
  if (PROFILE_STORE_LEGACY_VERSIONS.indexOf(version) < 0) {
    throw new Error(`无法识别的档案库版本 ${version}`);
  }
  const profiles = parsed.profiles.map((item) =>
    Object.assign({}, item, {
      last_result: item && item.last_result ? item.last_result : null,
      last_result_proof: item && item.last_result_proof ? item.last_result_proof : null,
    })
  );
  return {
    profiles: profiles,
    last_opened: parsed.last_opened || "",
    note: `已把本机档案库从 v${version} 迁移到 v${PROFILE_STORE_VERSION}（家庭输入原样保留，新增结果快照字段）。`,
  };
}

/* 存储损坏时失败关闭：隔离坏数据、以空库启动，绝不猜用户的家庭数据。 */
function readStore() {
  let raw = null;
  try {
    raw = window.localStorage.getItem(PROFILE_STORE_KEY);
  } catch (err) {
    return { store: emptyStore(), error: `本机存储不可用（${err.message || err}），档案无法保存。`, note: "", migrated: false };
  }
  if (!raw) return { store: emptyStore(), error: "", note: "", migrated: false };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.profiles)) throw new Error("档案库结构不正确");
    const migrated = migrateStore(parsed);
    const profiles = migrated.profiles.filter((item) => item && item.profile && typeof item.profile === "object");
    return {
      store: { version: PROFILE_STORE_VERSION, last_opened: migrated.last_opened, profiles: profiles },
      error: "",
      note: migrated.note,
      migrated: Boolean(migrated.note),
    };
  } catch (err) {
    try {
      window.localStorage.setItem(`${PROFILE_STORE_KEY}.corrupt`, raw.slice(0, 20000));
      window.localStorage.removeItem(PROFILE_STORE_KEY);
    } catch (ignored) {
      /* 隔离失败也不影响以空库启动 */
    }
    return { store: emptyStore(), error: `本机档案库无法解析（${err.message || err}），已隔离坏数据并以空库启动。`, note: "", migrated: false };
  }
}

function writeStore() {
  try {
    window.localStorage.setItem(PROFILE_STORE_KEY, JSON.stringify(storeState));
    return "";
  } catch (err) {
    return `保存失败：本机存储空间不足或被禁用（${err.message || err}）。`;
  }
}

function storeBytes() {
  try {
    const raw = window.localStorage.getItem(PROFILE_STORE_KEY) || "";
    return raw.length * 2;
  } catch (err) {
    return 0;
  }
}

const humanBytes = (n) => (n >= 1024 ? `${fmt(n / 1024, 1)} KB` : `${n} B`);

function nextProfileId() {
  let n = storeState.profiles.length + 1;
  while (storeState.profiles.some((item) => item.id === `pf-${n}`)) n += 1;
  return `pf-${n}`;
}

function findProfile(id) {
  return storeState.profiles.find((item) => item.id === id) || null;
}

/* Q-29-03（Round 30）：提示原本只写进 #pf-msg，而那张档案卡片在手机上位于首屏
   之外的第 3~4 屏。用户在首页点「导出 / 导入 / 清空本机档案」或触发存储类告警时，
   视野内没有任何反馈，会读成"按钮没反应"。这里把同一条提示镜像到 #home-notice。
   文本从 #pf-msg 现场读回（不另存一份状态），因此两条通道不可能互相矛盾。

   R30-N-01/02/03（Round 31）：判据与呈现两处一起改。
     N-01：用户在第 2~4 屏触发提示、只往上滚一点时，旧的"档案卡片在不在视野内"
           会判成"在视野内"（卡片露出一角），于是镜像收起，而 #pf-msg 还在屏幕
           下方看不见 —— 反馈凭空消失。判据改成**#pf-msg 自己是否在视野内**。
     N-02：卡片"部分在视野内"时同理，两种反馈都看不到；新判据与卡片无关。
     N-03：320×568 这类矮屏上提示带原先在文档流里（band top=682px > 视口高），
           自身就落在首屏之外。呈现改为底部浮层（CSS #home-notice 用 position: fixed）。 */

/* 主提示通道 #pf-msg 当前是否在用户视野内 —— 唯一的显隐判据。
   刻意不依赖粘性导航高度，也不依赖任何模块级状态：量不到就当成"不在视野内"
   （宁可多显示一条提示，也不能漏掉反馈）。 */
function msgBoxInView() {
  const box = $("pf-msg");
  if (!box || typeof box.getBoundingClientRect !== "function") return false;
  const rect = box.getBoundingClientRect();
  if (!rect || typeof rect.top !== "number" || typeof rect.bottom !== "number") return false;
  return rect.top < window.innerHeight && rect.bottom > 0;
}

/* 主提示通道当前是什么语气 —— 从 #pf-msg 的 class 现场读回，不另存状态。 */
function msgKindFromBox() {
  const box = $("pf-msg");
  const cls = (box && box.className) || "";
  return /(^|\s)warn(\s|$)/.test(String(cls)) ? "warn" : "";
}

function syncHomeNotice(text, kind) {
  const band = $("home-notice");
  if (!band) return;
  if (!text || msgBoxInView()) {
    band.className = "note hidden";
    band.textContent = "";
    return;
  }
  band.className = kind === "warn" ? "err" : "note";
  band.textContent = text;
}

function setMsg(text, kind) {
  const box = $("pf-msg");
  box.className = kind ? `note ${kind}` : "note";
  box.textContent = text;
  /* 首屏镜像只是提示的附加通道：它失败（无布局信息的执行台、旧浏览器）
     绝不能反过来影响 #pf-msg 这条主通道。 */
  try {
    syncHomeNotice(text, kind || "");
  } catch (err) {
    /* 首屏镜像不可用时静默降级，提示本身照常可用。 */
  }
}

function renderProfileList() {
  const list = $("pf-list");
  $("pf-count").textContent = String(storeState.profiles.length);
  $("pf-bytes").textContent = storeState.profiles.length ? humanBytes(storeBytes()) : "—";
  $("pf-last").textContent = currentProfileId ? (findProfile(currentProfileId) || {}).name || "未保存" : "未保存";

  if (!storeState.profiles.length) {
    list.innerHTML = '<div class="note">本机还没有已保存档案。</div>';
    return;
  }

  const rows = storeState.profiles
    .slice()
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .map((item) => {
      const active = item.id === currentProfileId;
      const run = item.last_run || null;
      const snapshot = item.last_result || null;
      const badge = run
        ? `<span class="pill ${run.verdict === "PASS" ? "ok" : run.verdict === "REFUSE" ? "bad" : "warn"}">上次判定 ${esc(cn(VERDICT_CN, run.verdict))}</span>`
        : '<span class="pill">尚未运行</span>';
      const snapshotBadge = snapshot
        ? `<span class="pill ok">结果快照已保存 · 可复核</span>`
        : '<span class="pill warn">未保存结果快照</span>';
      const members = Array.isArray((item.profile || {}).members) ? item.profile.members.length : 0;
      return `<div class="pf-item${active ? " active" : ""}">
        <div class="pf-main">
          <div class="pf-title"><strong>${esc(item.name)}</strong>${active ? '<span class="pill ok">当前打开</span>' : ""}</div>
          <div class="pf-meta">档案编号 ${esc(item.profile.profile_id || "—")} · ${members} 名成员 · 更新于 ${esc(item.updated_at)}</div>
          <div class="pf-meta">${badge}${run && run.at ? ` <span class="pf-dim">${esc(run.at)}</span>` : ""}</div>
          <div class="pf-meta">${snapshotBadge}${snapshot ? ` <span class="pf-dim">快照保存于 ${esc(snapshot.saved_at || "—")}</span>` : ""}</div>
        </div>
        <div class="pf-actions">
          <button type="button" class="ghost" data-pf-open="${esc(item.id)}">打开</button>
          ${snapshot ? `<button type="button" class="ghost" data-pf-snapshot="${esc(item.id)}">查看上次结果</button>` : ""}
          <button type="button" class="ghost" data-pf-overwrite="${esc(item.id)}">用当前内容覆盖</button>
          <button type="button" class="ghost pf-danger" data-pf-delete="${esc(item.id)}">删除</button>
        </div>
      </div>`;
    })
    .join("");
  list.innerHTML = rows;
}

function addProfile(name, profile) {
  if (storeState.profiles.length >= PROFILE_STORE_LIMIT) {
    setMsg(`本机最多保存 ${PROFILE_STORE_LIMIT} 份档案，请先删除不再需要的档案。`, "warn");
    return false;
  }
  const pending = pendingImportedSnapshot;
  pendingImportedSnapshot = null;
  /* S-29-03 纵深防御：导入后用户可能改填了别户家庭、或先另存了另一份档案，
     半路留下的待写快照绝不能跟着落到不相干的档案上。落盘前再问一次归属。 */
  const carried = pending && importedSnapshotBelongsToProfile(pending.snapshot, profile) ? pending : null;
  const entry = {
    id: nextProfileId(),
    name: name,
    created_at: nowStamp(),
    updated_at: nowStamp(),
    profile: profile,
    last_run: null,
    last_result: carried ? carried.snapshot : null,
    last_result_proof: carried
      ? { verified_at: nowStamp(), imported: true, checks_passed: carried.checks_passed, checks_total: carried.checks_total }
      : null,
  };
  storeState.profiles.push(entry);
  currentProfileId = entry.id;
  /* S-30-03："先运行、后保存"是首次建档的正常路径（还没有档案时跑引擎，跑完才命名保存）。
     owner 为空只可能来自"运行当时没有打开任何档案"，此时这份新档案就是那次运行的家，
     认领过来；owner 已经指向别的档案时绝不改写 —— 否则一份同编号的新档案会继承
     上一户的结果。 */
  if (exportState.result && !freshResultOwnerId) freshResultOwnerId = entry.id;
  return true;
}

function commitStore(name, verb) {
  storeState.last_opened = currentProfileId;
  const failure = writeStore();
  if (failure) {
    setMsg(failure, "warn");
    return false;
  }
  $("pf-name").value = name;
  renderProfileList();
  renderHome();
  renderHomeDashboard();
  setMsg(`已${verb}「${name}」到本机。下次打开本页面会自动恢复这份档案的输入。`, "ok");
  return true;
}

/* 「保存当前档案」：开着哪份就更新哪份；没有打开的档案时新建一份。 */
async function saveCurrentProfile() {
  const profile = collectProfile();
  const typed = ($("pf-name").value || "").trim();
  const name = typed || profile.profile_id || "未命名档案";
  const existing = currentProfileId ? findProfile(currentProfileId) : null;

  if (existing) {
    existing.name = name;
    existing.updated_at = nowStamp();
    existing.profile = profile;
    /* S-30-06（Round 31）："覆盖已打开的档案"这条路径原先既不落导入的快照，也不清待写状态 ——
       半路留下的待写快照会跨操作残留，随后挂到另一份新档案上，而"导入的快照会跟着保存
       一起落盘"这条对用户的承诺在更新路径上根本不成立。
       这里与 addProfile 走同一道归属闸门：属于这份档案就落盘，不属于就丢弃，
       无论如何都不再留在待写状态里（待写状态绝不允许跨操作残留）。 */
    const pending = pendingImportedSnapshot;
    pendingImportedSnapshot = null;
    if (pending && !existing.last_result && importedSnapshotBelongsToProfile(pending.snapshot, profile)) {
      existing.last_result = pending.snapshot;
      existing.last_result_proof = {
        verified_at: nowStamp(),
        imported: true,
        checks_passed: pending.checks_passed,
        checks_total: pending.checks_total,
      };
    }
    if (!existing.last_result) await attachJustRunSnapshot(existing);
    return commitStore(name, "更新");
  }
  if (!addProfile(name, profile)) return;
  registerAccountWithFamily(name);
  commitStore(name, "保存");
  await attachJustRunSnapshot(findProfile(currentProfileId));
}

/* 「另存为新档案」：无论当前开着哪份，都新建一份，原来的档案保持不变。 */
function saveCurrentProfileAsNew() {
  const profile = collectProfile();
  const typed = ($("pf-name").value || "").trim() || profile.profile_id || "未命名档案";
  const open = currentProfileId ? findProfile(currentProfileId) : null;
  const name = open && open.name === typed ? `${typed} 副本` : typed;
  if (!addProfile(name, profile)) return;
  return commitStore(name, "另存");
}

/* 清空重填意味着「开始一份新档案」：解除与已保存档案的绑定，避免误覆盖。 */
function detachCurrentProfile() {
  if (!currentProfileId) return;
  const open = findProfile(currentProfileId);
  currentProfileId = "";
  storeState.last_opened = "";
  writeStore();
  renderProfileList();
  setMsg(open ? `已与「${open.name}」解除绑定。现在填写的是新档案，保存时会新建一份，不会覆盖原档案。` : "", "");
}

/* 打开档案只恢复输入，不自动运行引擎：结论必须由用户当场触发并留下新的 run_id。 */
function openProfile(id) {
  const item = findProfile(id);
  if (!item) {
    setMsg("这份档案在本机已不存在。", "warn");
    renderProfileList();
    return;
  }
  currentProfileId = id;
  storeState.last_opened = id;
  writeStore();
  fillProfile(item.profile);
  $("pf-name").value = item.name;
  snapshotOpen = false;
  $("r-snapshot").classList.add("hidden");
  setResultSectionsVisible(true);
  clearResultAreas();
  $("results").classList.add("hidden");
  showStep(1);
  $("w-error").textContent = "";
  renderProfileList();
  renderHome();
  renderHomeDashboard();
  const run = item.last_run;
  setMsg(
    run
      ? `已恢复「${item.name}」的输入（上次判定 ${VERDICT_CN[run.verdict] || run.verdict}，${run.at}）。点「运行 Verity 引擎」按当前输入重新计算。`
      : `已恢复「${item.name}」的输入，尚未运行过。点「运行 Verity 引擎」查看结果。`,
    "ok"
  );
  $("wizard").scrollIntoView({ behavior: "smooth", block: "start" });
}

function deleteProfile(id) {
  const item = findProfile(id);
  if (!item) return;
  if (!window.confirm(`删除本机档案「${item.name}」？该档案的输入、上次运行摘要与结果快照都会被移除。`)) return;
  storeState.profiles = storeState.profiles.filter((entry) => entry.id !== id);
  if (currentProfileId === id) currentProfileId = "";
  if (storeState.last_opened === id) storeState.last_opened = "";
  writeStore();
  renderProfileList();
  renderHome();
  renderHomeDashboard();
  setMsg(`已从本机删除「${item.name}」。`, "ok");
}

function exportCurrentProfile() {
  const profile = collectProfile();
  const open = currentProfileId ? findProfile(currentProfileId) : null;
  const payload = {
    kind: PROFILE_EXPORT_KIND,
    version: PROFILE_STORE_VERSION,
    exported_at: nowStamp(),
    profile: profile,
    last_result: open && open.last_result ? open.last_result : null,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${(profile.profile_id || "verity-family").replace(/[^A-Za-z0-9_-]/g, "_")}-profile.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  setMsg("已导出当前档案文件（只含你填写的家庭输入，不含任何账号或身份信息）。", "ok");
}

/* T-E0-008 V-25-01：导入文件的结构与类型必须逐字段校验。
   只检查「有没有 members / assets」是不够的 —— 一个字段里的字符串会被当成 HTML
   属性写进页面。这里把每类字段的类型钉死，不符合就整份拒绝。 */
function profileShapeError(profile) {
  const isNum = (value) => typeof value === "number" && Number.isFinite(value);
  const optNum = (value) => value === null || value === undefined || isNum(value);
  const optStr = (value) => value === null || value === undefined || typeof value === "string";
  const fail = (message) => `档案字段不符合约定：${message}`;

  const member = (item, index) => {
    if (!item || typeof item !== "object") return fail(`members[${index}] 不是对象`);
    if (!optNum(item.age)) return fail(`members[${index}].age 必须是数字`);
    if (!optNum(item.annual_income)) return fail(`members[${index}].annual_income 必须是数字`);
    if (!optNum(item.dependents)) return fail(`members[${index}].dependents 必须是数字`);
    if (!optStr(item.role) || !optStr(item.income_stability)) return fail(`members[${index}] 文本字段类型不符`);
    return "";
  };
  const numericFields = {
    assets: ["value"],
    liabilities: ["balance", "annual_rate", "mandatory_payment"],
    protection: ["coverage", "annual_premium"],
    future_rigid_outflows: ["amount", "years_until_due"],
  };
  const textFields = {
    assets: ["asset_id", "kind", "liquidity", "note", "currency"],
    liabilities: ["liability_id", "kind", "note", "currency"],
    protection: ["protection_id", "kind", "note", "currency"],
    future_rigid_outflows: ["outflow_id", "label", "currency"],
  };

  for (const [index, item] of profile.members.entries()) {
    const problem = member(item, index);
    if (problem) return problem;
  }
  for (const [key, fields] of Object.entries(numericFields)) {
    const list = profile[key];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) return fail(`${key} 必须是列表`);
    for (const [index, item] of list.entries()) {
      if (!item || typeof item !== "object") return fail(`${key}[${index}] 不是对象`);
      for (const field of fields) {
        if (!optNum(item[field])) return fail(`${key}[${index}].${field} 必须是数字`);
      }
      for (const field of textFields[key] || []) {
        if (!optStr(item[field])) return fail(`${key}[${index}].${field} 必须是文本`);
      }
    }
  }
  if (!optNum(profile.annual_expenses_discretionary)) return fail("annual_expenses_discretionary 必须是数字");
  if (!optNum(profile.investment_horizon_years)) return fail("investment_horizon_years 必须是数字");
  if (!optNum(profile.target_annual_return)) return fail("target_annual_return 必须是数字");
  if (!optNum(profile.max_tolerable_loss_pct)) return fail("max_tolerable_loss_pct 必须是数字");
  if (!optStr(profile.currency)) return fail("currency 必须是文本");
  return "";
}

function acceptImportedProfile(parsed) {
  if (!parsed || typeof parsed !== "object") throw new Error("文件内容不是 JSON 对象");
  const profile = parsed.kind === PROFILE_EXPORT_KIND || parsed.profile ? parsed.profile : parsed;
  if (!profile || typeof profile !== "object") throw new Error("文件里没有家庭档案对象");
  if (typeof profile.profile_id !== "string" || !profile.profile_id) throw new Error("档案缺少 profile_id");
  if (!Array.isArray(profile.members) || !profile.members.length) throw new Error("档案缺少家庭成员");
  if (typeof profile.annual_expenses_essential !== "number") throw new Error("档案缺少年必要支出");
  if (!Array.isArray(profile.assets)) throw new Error("档案缺少资产列表");
  const shapeError = profileShapeError(profile);
  if (shapeError) throw new Error(shapeError);
  /* 快照处置先算出来，再和「输入已读入」一起组装成最终提示 —— 两件事都要落在
     用户眼前（S-30-02）。这里用 try/catch 兜底：拿不准的文件最多丢掉快照，
     绝不能把用户合法的家庭输入一起挡在门外（S-30-04）。 */
  let disposition = noSnapshotDisposition();
  try {
    disposition = restoreSnapshotFromImport(parsed, profile) || noSnapshotDisposition();
  } catch (err) {
    pendingImportedSnapshot = null;
    disposition = {
      note: "文件里的结果快照无法安全读取，已跳过，不会写入本机：导入只搬运这户人家的输入。",
      kind: "warn",
    };
  }
  fillProfile(profile);
  const typed = ($("pf-name").value || "").trim();
  $("pf-name").value = typed && typed !== (parsed.name || "") ? typed : (parsed.name || profile.profile_id);
  validate();
  showStep(1);
  setMsg(importNotice(importedInputLine(profile.profile_id), disposition.note), disposition.kind === "warn" ? "warn" : "ok");
}

/* 导入文件的单份上限。一份家庭档案是纯文本输入 + 一份结果快照，
   正常体积在几十 KB 量级；2 MB 足够容纳远超真实使用的档案，
   又能把"拖进来一个几百 MB 的文件"挡在读取之前。 */
const PROFILE_IMPORT_LIMIT_BYTES = 2000000;

function importProfileFile(file) {
  if (!file) return;
  /* S-29-04（Round 30）：大小闸门必须落在真正读取文件之前 ——
     放在读取之后等于没修：那时文件整份已经进了内存，再拒绝也救不回卡死或 OOM。 */
  if (typeof file.size === "number" && file.size > PROFILE_IMPORT_LIMIT_BYTES) {
    setMsg(
      `导入失败：文件 ${humanBytes(file.size)} 超过单份上限 ${humanBytes(PROFILE_IMPORT_LIMIT_BYTES)}，已中止读取，没有读入任何内容。请确认选择的是本页「导出当前档案」生成的文件。`,
      "warn"
    );
    const input = $("pf-file");
    if (input) input.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => setMsg("读取文件失败，请重试。", "warn");
  reader.onload = () => {
    try {
      acceptImportedProfile(JSON.parse(String(reader.result)));
    } catch (err) {
      setMsg(`导入失败：${err.message || err}。请选择由本页「导出当前档案」生成的文件。`, "warn");
    }
  };
  reader.readAsText(file);
}

/* 彻底删除本机与 Verity 相关的全部存储条目。
   只删主键是不够的：解析失败时会被隔离到 `<key>.corrupt`，那份明文副本必须一起删掉，
   否则「清空本机档案」之后家庭资料仍留在浏览器里（T-E0-008 C-02）。 */
function purgeLocalArchiveData() {
  let removed = 0;
  try {
    const keys = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key && key.startsWith("verity.")) keys.push(key);
    }
    keys.forEach((key) => {
      window.localStorage.removeItem(key);
      removed += 1;
    });
  } catch (ignored) {
    /* 存储被禁用时无物可删 */
  }
  return removed;
}

function clearAllProfiles() {
  if (!storeState.profiles.length) {
    setMsg("本机没有已保存档案。", "");
    return;
  }
  if (!window.confirm(`清空本机全部 ${storeState.profiles.length} 份档案？此操作不可撤销。`)) return;
  storeState = emptyStore();
  currentProfileId = "";
  const removed = purgeLocalArchiveData();
  renderProfileList();
  accountState = null;
  renderHome();
  renderHomeDashboard();
  setMsg(`已清空本机档案（含 ${removed} 项本机数据，包括此前隔离出来的损坏副本）。当前页面上的输入仍在，可重新保存。`, "ok");
}

/* 打开页面时恢复上次档案的输入（只恢复输入；引擎必须由用户当场重新运行）。 */
function restoreLastProfile() {
  const item = storeState.last_opened ? findProfile(storeState.last_opened) : null;
  if (!item) return;
  currentProfileId = item.id;
  fillProfile(item.profile);
  $("pf-name").value = item.name;
  renderProfileList();
  renderHome();
  renderHomeDashboard();
  setMsg(`已自动恢复上次打开的档案「${item.name}」的输入。点「运行 Verity 引擎」按当前输入重新计算。`, "ok");
}

/* 运行成功后把这条 run 的摘要挂到当前档案上，作为「上次判定」证据。 */
function recordRunResult(result, profile) {
  if (!currentProfileId && profile) {
    const typed = ($("pf-name").value || "").trim();
    if (typed) saveCurrentProfile();
  }
  const item = currentProfileId ? findProfile(currentProfileId) : null;
  if (!item) return;
  item.last_run = {
    at: nowStamp(),
    run_id: result.run_id,
    verdict: typeof result.verdict === "string" ? result.verdict : "",
    action: (result.today || {}).action || "",
    algorithm_version: result.algorithm_version,
    inputs_digest: (result.evidence || {}).inputs_digest || "",
  };
  item.updated_at = nowStamp();
  writeStore();
  renderProfileList();
}


/* ------------------------------------------------- 结果快照与本机复核 (T-E0-029)

   解决的问题：关掉页面以后，「上一次这个判定是怎么算出来的」无从复核，只剩一句「上次判定 PASS」。
   现在的做法：把这一轮引擎的**原始输出文本**、算它用的**家庭输入**、以及复核结果一起存进这份档案；
   重新打开时由浏览器用与引擎相同的规范 JSON 重算哈希，逐项比对。

   三条硬规则：
     1. 打开快照只展示历史结果，绝不冒充本次计算，也绝不自动重跑引擎；
     2. 复核不通过（哈希不一致 / 正文损坏 / 环境没有 SHA-256）→ 失败关闭，不展示任何指标；
     3. 快照只存在这台设备，不上传、无账号、不收集身份信息。 */

const SNAPSHOT_LIMIT_BYTES = 400000;

function digestModule() {
  const mod = window.VerityDigest;
  if (!mod || typeof mod.verifySnapshot !== "function" || typeof mod.digestValue !== "function") return null;
  return mod;
}

/* 复核失败时按失败关闭返回，绝不把「算不出来」当成「通过」。 */
async function verifySnapshotOrFail(snapshot) {
  const mod = digestModule();
  if (!mod) return { ok: false, failures: ["本页缺少 VerityDigest 复核模块"], checks: [] };
  try {
    const proof = await mod.verifySnapshot({ result_text: snapshot.result_text, profile: snapshot.profile });
    return {
      ok: !!proof.ok,
      failures: proof.failures || [],
      checks: proof.checks || [],
      canonical_bytes: proof.canonical_bytes || 0,
    };
  } catch (err) {
    return { ok: false, failures: [`复核无法完成（${(err && err.message) || err}）`], checks: [] };
  }
}

/* 快照保存之后，这份档案的输入有没有被改过？（用于把「旧输入的结果」说清楚） */
async function inputsChangedSinceSnapshot(item, snapshot) {
  const mod = digestModule();
  if (!mod) return null;
  try {
    const saved = await mod.digestValue(snapshot.profile);
    const now = await mod.digestValue(item.profile);
    return saved !== now;
  } catch (err) {
    return null;
  }
}

/* 「先运行、后保存」的兜底：用户在本次运行之后才点「保存当前档案」时，
   把当次结果快照也附到这份档案上，让「查看上次结果」可用。
   只处理刚运行过引擎且档案上还没有快照的情况；复核不通过就失败关闭，不附着。 */
/* 「这份结果是不是这户人家的」—— 唯一的判定口径，落盘前必须过这一关。

   背景（Round 29 安全审计 S-29-02）：不校验归属时，实测可以把 family-A 的结论
   写进 family-B 的快照里（snapshot_profile_id=family-A，档案却是 family-B），
   首页随后把 A 家的数字当成 B 家的显示。跨户串数据是产品红线，宁可少存一份快照
   也不能串。抽成具名函数是为了让审计脚本能直接问它 —— 判定必须可观测，
   不能靠"落盘没成功"去反推（落盘还可能因为大小/复核失败而没成功）。 */
function snapshotBelongsToProfile(result, item) {
  const resultProfileId = (result && result.profile_id) || "";
  const itemProfileId = (item && item.profile && item.profile.profile_id) || "";
  return Boolean(resultProfileId) && Boolean(itemProfileId) && resultProfileId === itemProfileId;
}

async function attachJustRunSnapshot(item) {
  if (!item || item.last_result) return;
  if (!exportState.result || !lastResultText) return;
  const result = exportState.result;
  if (!snapshotBelongsToProfile(result, item)) return;
  const snapshot = {
    saved_at: nowStamp(),
    run_id: result.run_id,
    algorithm_version: result.algorithm_version,
    verdict: typeof result.verdict === "string" ? result.verdict : "",
    channel: exportState.channel || (CHANNEL === "api" ? "api" : "browser"),
    result_text: lastResultText,
    profile: item.profile,
  };
  if (JSON.stringify(snapshot).length * 2 > SNAPSHOT_LIMIT_BYTES) return;
  const proof = await verifySnapshotOrFail(snapshot);
  if (!proof.ok) return;
  item.last_result = snapshot;
  item.last_result_proof = {
    verified_at: nowStamp(),
    checks_passed: proof.checks.filter((check) => check.ok).length,
    checks_total: proof.checks.length,
    canonical_bytes: proof.canonical_bytes,
  };
  item.updated_at = nowStamp();
  const failure = writeStore();
  if (!failure) renderProfileList();
}

/* 运行成功后保存完整结果快照；复核不通过就不落盘。 */
async function saveRunSnapshot(result, profile, resultText) {
  if (!currentProfileId && profile) {
    const typed = ($("pf-name").value || "").trim();
    if (typed) saveCurrentProfile();
  }
  const item = currentProfileId ? findProfile(currentProfileId) : null;
  if (!item) return { saved: false, reason: "当前没有打开的档案" };
  if (typeof resultText !== "string" || !resultText) {
    return { saved: false, reason: "引擎原始输出文本缺失，无法保存可复核的快照" };
  }
  const snapshot = {
    saved_at: nowStamp(),
    run_id: result.run_id,
    algorithm_version: result.algorithm_version,
    verdict: typeof result.verdict === "string" ? result.verdict : "",
    channel: CHANNEL === "api" ? "api" : "browser",
    result_text: resultText,
    profile: profile,
  };
  const size = JSON.stringify(snapshot).length * 2;
  if (size > SNAPSHOT_LIMIT_BYTES) {
    return { saved: false, reason: `快照约 ${humanBytes(size)}，超过单份上限 ${humanBytes(SNAPSHOT_LIMIT_BYTES)}` };
  }
  const proof = await verifySnapshotOrFail(snapshot);
  if (!proof.ok) {
    return { saved: false, reason: `本机复核未通过（${proof.failures.join("、")}）` };
  }
  item.last_result = snapshot;
  item.last_result_proof = {
    verified_at: nowStamp(),
    checks_passed: proof.checks.filter((check) => check.ok).length,
    checks_total: proof.checks.length,
    canonical_bytes: proof.canonical_bytes,
  };
  item.updated_at = nowStamp();
  const failure = writeStore();
  if (failure) return { saved: false, reason: failure };
  renderProfileList();
  return { saved: true, proof: item.last_result_proof };
}

let snapshotOpen = false;

function setResultSectionsVisible(visible) {
  ["r-verdict", "r-balance", "r-trend", "r-timeline", "r-safety", "r-breadwinner", "r-annual-goal", "r-risk", "r-protection", "r-stress", "r-evidence"].forEach((id) => {
    const node = $(id);
    if (node) node.classList.toggle("hidden", !visible);
  });
}

/* 复核不通过时，先清空所有结果区域：绝不让上一个结果留在屏幕上冒充这一份。 */
function clearResultAreas() {
  rememberExportResult(null, "");
  lastResultText = "";
  ["run-meta", "r-action", "r-action-why", "r-today-grid", "r-verdict-body", "r-balance-grid", "r-layers",
   "r-assets-table", "r-trend-grid", "r-trend-chart", "r-trend-milestones", "r-trend-table", "r-trend-note", "r-timeline-summary", "r-safety-grid", "r-safety-risks", "r-breadwinner-summary", "r-breadwinner-needs", "r-breadwinner-education", "r-breadwinner-actions", "r-annual-goal-summary", "r-annual-goal-basis", "r-annual-goal-progress", "r-annual-goal-guardrails", "r-annual-goal-actions", "r-risk-body", "r-protection-body", "r-evidence-body"]
    .forEach((id) => {
      const node = $(id);
      if (node) node.innerHTML = "";
    });
  const table = $("r-stress-table");
  if (table && table.tBodies.length) {
    table.tBodies[0].innerHTML = '<tr><td colspan="7" class="note">—</td></tr>';
  }
  const timelineTable = $("r-timeline-table");
  if (timelineTable && timelineTable.tBodies.length) {
    timelineTable.tBodies[0].innerHTML = '<tr><td colspan="7" class="note">—</td></tr>';
  }
  const bwMembers = $("r-breadwinner-members");
  if (bwMembers && bwMembers.tBodies.length) {
    bwMembers.tBodies[0].innerHTML = '<tr><td colspan="7" class="note">—</td></tr>';
  }
  const bwScenarios = $("r-breadwinner-scenarios");
  if (bwScenarios && bwScenarios.tBodies.length) {
    bwScenarios.tBodies[0].innerHTML = '<tr><td colspan="9" class="note">—</td></tr>';
  }
  const goalMilestones = $("r-annual-goal-milestones");
  if (goalMilestones && goalMilestones.tBodies.length) {
    goalMilestones.tBodies[0].innerHTML = '<tr><td colspan="3" class="note">—</td></tr>';
  }
}

function parseSnapshotResult(snapshot) {
  if (!snapshot || typeof snapshot.result_text !== "string") return null;
  try {
    const parsed = JSON.parse(snapshot.result_text);
    if (!parsed || typeof parsed !== "object" || !parsed.evidence || !parsed.audit) return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

/* 手机屏幕上要一眼能对齐比较：只取首 8 位 + 末 4 位，完整值仍在证据区里可读。 */
const shortHash = (value) => {
  const text = typeof value === "string" ? value : "";
  if (!text) return "—";
  return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text;
};

function renderSnapshotProof(proof) {
  if (!proof.ok) {
    return `<div class="err">未通过本机哈希复核：${esc(proof.failures.join("、"))}。按失败关闭，这份快照不能作为任何决策依据。</div>`;
  }
  return `<div class="pill ok">复核通过</div> <span class="pf-dim">${esc(String(proof.checks.filter((c) => c.ok).length))}/${esc(String(proof.checks.length))} 项哈希由本机浏览器重算并一致</span>`;
}

function renderSnapshotChecks(proof) {
  if (!proof.checks.length) return "";
  const rows = proof.checks
    .map(
      (check) => `<tr>
        <td>${esc(check.label)}</td>
        <td class="mono">${esc(shortHash(check.expected))}</td>
        <td class="mono">${esc(shortHash(check.actual))}</td>
        <td><span class="pill ${check.ok ? "ok" : "bad"}">${check.ok ? "一致" : "不一致"}</span></td>
      </tr>`
    )
    .join("");
  return `<div class="scroll"><table>
      <thead><tr><th>复核项</th><th>引擎写下</th><th>本机重算</th><th>结论</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

async function openSnapshot(id) {
  const item = findProfile(id);
  const snapshot = item ? item.last_result : null;
  if (!item || !snapshot) {
    setMsg("这份档案没有保存过结果快照：先运行一次引擎，结果会自动存进本机。", "warn");
    renderProfileList();
    return;
  }
  const result = parseSnapshotResult(snapshot);
  if (!result) {
    clearResultAreas();
    setResultSectionsVisible(false);
    $("r-snapshot").classList.remove("hidden");
    $("r-snapshot-sub").innerHTML = `「${esc(item.name)}」的结果快照正文已损坏，无法解析。`;
    $("r-snapshot-proof").innerHTML = '<div class="err">快照正文不是合法 JSON，按失败关闭：不展示任何指标，请重新运行引擎生成新的结果。</div>';
    $("r-snapshot-checks").innerHTML = "";
    $("results").classList.remove("hidden");
    renderHomeDashboard();
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  const profile = snapshot.profile && typeof snapshot.profile === "object" ? snapshot.profile : item.profile;
  const proof = await verifySnapshotOrFail({ result_text: snapshot.result_text, profile: snapshot.profile });
  const stale = await inputsChangedSinceSnapshot(item, snapshot);

  currentProfileId = id;
  storeState.last_opened = id;
  writeStore();
  fillProfile(item.profile);
  $("pf-name").value = item.name;
  renderProfileList();

  snapshotOpen = true;
  $("r-snapshot").classList.remove("hidden");
  $("r-snapshot-sub").innerHTML =
    `这是 <strong>${esc(snapshot.saved_at || "—")}</strong> 保存在本机的「${esc(item.name)}」结果快照` +
    `（run_id <span class="mono">${esc(snapshot.run_id || "—")}</span>，引擎版本 ${esc(snapshot.algorithm_version || "—")}）——` +
    `<strong>不是本次重算</strong>，也没有自动重跑引擎。要按现在的输入重算，点下面的「按当前输入重新运行」。`;
  $("r-snapshot-proof").innerHTML =
    renderSnapshotProof(proof) +
    (stale === true
      ? '<div class="note warn" style="margin-top:8px">这份档案的输入在快照保存之后被修改过：下面显示的是<strong>当时那次运行</strong>的结果，不是当前输入的结果。</div>'
      : "") +
    (proof.ok && proof.canonical_bytes
      ? `<div class="pf-dim" style="margin-top:6px">复核范围：结果正文 ${esc(String(proof.canonical_bytes))} 字符规范 JSON；输出摘要 output_digest 由引擎在计算过程中写下，覆盖的是引擎内部中间态，浏览器只展示记录值、不重算。</div>`
      : "");
  $("r-snapshot-checks").innerHTML = renderSnapshotChecks(proof);

  if (proof.ok) {
    setResultSectionsVisible(true);
    renderMeta(result, "本机保存的结果快照（未重新计算）");
    renderVerdict(result);
    renderBalance(result, profile);
    lastResultForTrend = { result, profile };
    renderTrend(result, profile);
    renderSafety(result);
    renderBreadwinner(result);
    renderAnnualGoal(result);
    renderRisk(result);
    renderProtection(result);
    renderStress(result);
    renderTimeline(result);
    renderEvidence(result);
    rememberExportResult(result, "本机保存的结果快照（未重新计算）");
  } else {
    clearResultAreas();
    setResultSectionsVisible(false);
    $("r-snapshot-proof").innerHTML =
      '<div class="err">未通过本机哈希复核，按失败关闭：不展示任何指标。快照正文或哈希与引擎记录不一致，可能是本机存储被改动。请点「按当前输入重新运行」重新计算。</div>' +
      renderSnapshotProof(proof);
  }

  $("results").classList.remove("hidden");
  $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  setMsg(
    proof.ok
      ? `已打开「${item.name}」的结果快照，${proof.checks.filter((c) => c.ok).length}/${proof.checks.length} 项哈希复核一致。`
      : `「${item.name}」的结果快照未通过复核，已按失败关闭处理。`,
    proof.ok ? "ok" : "warn"
  );
}

/* 导入的档案文件里若带结果快照，先按同样的失败关闭规则复核，再决定是否保留。
   复核不通过的文件快照不会写入本机——导入只搬运输入，不搬运不可信结论。 */
let pendingImportedSnapshot = null;

/* S-30-02（Round 31）：导入路径上有两件事必须都告诉用户 ——「输入已读入」与「快照怎么处置了」。
   以前两件事抢同一个提示节点，后写的那条把前一条盖掉：快照被归属闸门拒绝的警示会被随后的
   "已导入档案「X」…"覆盖，用户以为快照跟着来了（而它并没有）。
   现在两件事各占一段（#pf-msg 用 white-space: pre-line 呈现为两行），由同一个组装函数合并，
   语气取两者中更需要注意的那一个。 */
function importedInputLine(profileId) {
  return `已导入档案「${profileId}」的输入。检查无误后点「保存当前档案」写入本机。`;
}

function importNotice(inputLine, disposition) {
  return disposition ? `${inputLine}\n${disposition}` : inputLine;
}

async function auditImportedSnapshot(snapshot) {
  const proof = await verifySnapshotOrFail({ result_text: snapshot.result_text, profile: snapshot.profile });
  const passed = proof.checks.filter((check) => check.ok).length;
  const profileId = (snapshot.profile && snapshot.profile.profile_id) || "—";
  if (!proof.ok) {
    pendingImportedSnapshot = null;
    setMsg(
      importNotice(
        importedInputLine(profileId),
        `文件里的结果快照未通过哈希复核（${proof.failures.join("、")}），不会写入本机：保存这份档案只会保存家庭输入。`
      ),
      "warn"
    );
    return false;
  }
  pendingImportedSnapshot = { snapshot: snapshot, checks_passed: passed, checks_total: proof.checks.length };
  setMsg(
    importNotice(
      importedInputLine(profileId),
      `文件里的结果快照通过 ${passed}/${proof.checks.length} 项哈希复核，保存档案时会一并写入本机。`
    ),
    "ok"
  );
  return true;
}

/* S-29-03（Round 30 安全复测）：导入的快照必须属于被导入的那一份档案。

   只做哈希复核是不够的 —— 哈希只能证明"这份结论没被改过"，不能证明"这份结论
   是这户人家的"。实测可构造出 profile.profile_id=family-B、last_result.profile
   .profile_id=family-A 的文件：复核全部通过，甲家的结论被挂到乙家档案上，
   首页随后把甲家的数字当乙家显示。跨户串数据是产品红线。

   这里与运行链路（snapshotBelongsToProfile）共用同一条「这份结果是不是这户人家的」
   口径，并抽成具名函数，让审计脚本可以直接问它，不靠"没落盘"去反推。

   S-30-01（Round 31）：只看**信封**是不够的。信封声明乙家（归属闸门放行、哈希自洽
   5/5）而 result_text 正文里 profile_id=family-A 的文件，会把甲家的数字挂到乙家首页。
   哈希答的是"有没有被改过"，信封答的是"文件说它是谁家的"，正文才答"这些数字算的是
   谁家"——三者必须一致。现在这条口径同时校验**信封与正文**，两份声明都要等于目标档案。 */
function snapshotBodyProfileId(snapshot) {
  if (!snapshot || typeof snapshot.result_text !== "string") return "";
  try {
    const body = JSON.parse(snapshot.result_text);
    return body && typeof body.profile_id === "string" ? body.profile_id : "";
  } catch (err) {
    return "";
  }
}

function importedSnapshotBelongsToProfile(snapshot, profile) {
  const envelopeProfileId = (snapshot && snapshot.profile && snapshot.profile.profile_id) || "";
  const bodyProfileId = snapshotBodyProfileId(snapshot);
  const profileId = (profile && profile.profile_id) || "";
  if (!profileId) return false;
  return Boolean(envelopeProfileId) && Boolean(bodyProfileId)
    && envelopeProfileId === profileId && bodyProfileId === profileId;
}

/* 展示口径（首页渲染）：比导入闸门略宽一点点，只宽在「旧快照没有信封」这一种情况上 ——
   早期版本存下的快照只有正文、没有信封，若一律按无主处理，老用户打开首页会看到满屏「—」。
   但**正文声明的归属是硬要求**：正文说这些数字是别人家的，就绝不挂到这份档案下。
   信封若存在，也必须与档案一致（信封与正文分属两户的文件在这一层同样被挡住）。 */
function snapshotMatchesArchive(snapshot, profile) {
  const profileId = (profile && profile.profile_id) || "";
  if (!profileId) return false;
  if (snapshotBodyProfileId(snapshot) !== profileId) return false;
  const envelopeProfileId = (snapshot && snapshot.profile && snapshot.profile.profile_id) || "";
  return !envelopeProfileId || envelopeProfileId === profileId;
}

function noSnapshotDisposition() {
  return { note: "", kind: "" };
}

function restoreSnapshotFromImport(parsed, profile) {
  const incoming = parsed && parsed.last_result;
  if (!incoming || typeof incoming !== "object") return noSnapshotDisposition();
  if (typeof incoming.result_text !== "string" || !incoming.result_text) return noSnapshotDisposition();
  /* S-30-04（Round 31）：极深嵌套的正文会让 JSON.stringify 抛 RangeError。以前这个异常会
     穿过 reader.onload 的 catch，把**整份导入**中止，并把原始 JS 文案
     （"Maximum call stack size exceeded"）显示给用户 —— 连合法的家庭输入一起丢掉。
     就地失败关闭：只丢快照，输入照常导入，文案对人可读。 */
  let oversize = false;
  try {
    oversize = JSON.stringify(incoming).length * 2 > SNAPSHOT_LIMIT_BYTES;
  } catch (err) {
    pendingImportedSnapshot = null;
    return {
      note: "文件里的结果快照结构异常（嵌套层数超限），已跳过，无法写入本机：导入只搬运这户人家的输入。",
      kind: "warn",
    };
  }
  if (oversize) {
    pendingImportedSnapshot = null;
    return {
      note: `文件里的结果快照超过单份上限，已跳过，不会写入本机：导入只搬运这户人家的输入。`,
      kind: "warn",
    };
  }
  if (!importedSnapshotBelongsToProfile(incoming, profile)) {
    pendingImportedSnapshot = null;
    const envelopeId = (incoming.profile && incoming.profile.profile_id) || "未知";
    const bodyId = snapshotBodyProfileId(incoming) || "未知";
    return {
      note:
        `文件里的结果快照属于另一份档案（信封声明 ${envelopeId}、正文声明 ${bodyId}，当前档案编号 ${profile.profile_id}），` +
        `不会写入本机：导入只搬运这户人家的输入。` +
        `如果你刚刚改过这份档案的编号，那这份文件里的快照仍记着旧编号 —— 这属于正常现象，` +
        `重新运行一次引擎即可为新编号留下快照。`,
      kind: "warn",
    };
  }
  auditImportedSnapshot(incoming).catch(() => {
    pendingImportedSnapshot = null;
  });
  return noSnapshotDisposition();
}

/* --------------------------------- 结果页章节索引与回到顶部 (T-E0-040)

   真实问题：结果页在 320 px 屏上总高约一万像素——判定、现金流、月度趋势、危险时间轴、
   生存底线、风险排序、综合保护方案、压力测试、证据审计，一共九个章节。用户想让引擎
   回答「我还能撑多久」，滑到「证据」以后想回到「生存底线」，只能一屏屏手滑。

   修法不是新做一个页面，而是在**同一份页面、同一套导航**里加两个动作：
     1. 章节索引：列出**当前真实可见**的章节（还没跑出来的章节不会列进来），点一下直接落位；
     2. 回到顶部：一键回到页面顶部。

   落位不能直接用 scrollIntoView：顶部导航是 sticky 的，章节标题会被压在导航条下面。
   这里按 header 的**实测高度**计算目标滚动位置，并由真实浏览器逐宽度复量。 */
const RESULT_SECTIONS = [
  { id: "r-snapshot", label: "上次结果" },
  { id: "r-verdict", label: "判定与今日行动" },
  { id: "r-balance", label: "现金流与资产负债" },
  { id: "r-trend", label: "多月度趋势" },
  { id: "r-timeline", label: "危险时间轴" },
  { id: "r-safety", label: "家庭生存底线" },
  { id: "r-breadwinner", label: "顶梁柱与保护缺口" },
  { id: "r-annual-goal", label: "年度目标与止盈" },
  { id: "r-risk", label: "风险排序" },
  { id: "r-protection", label: "综合保护方案" },
  { id: "r-stress", label: "压力测试" },
  { id: "r-evidence", label: "证据与审计" },
];
/* 落位后章节标题与导航条之间留出的呼吸距离（px）。 */
const SECTION_LANDING_GAP_PX = 16;
let activeSectionId = "";
let sectionIndexOpen = false;

function stickyHeaderHeight() {
  const header = document.querySelector("header.top");
  return header ? Math.round(header.getBoundingClientRect().height) : 0;
}

/* CSS 里的锚点让位距离也用实测值：手机与桌面的导航条高度不一样，
   猜一个常数就必然有一端被压住。 */
function syncStickyHeaderVar() {
  const height = stickyHeaderHeight();
  if (height > 0) document.documentElement.style.setProperty("--sticky-header-h", `${height}px`);
  return height;
}

/* 当前真实可见的章节：隐藏的章节不进目录，避免点进去一片空白。 */
function visibleResultSections() {
  return RESULT_SECTIONS
    .map((item) => ({ id: item.id, label: item.label, node: document.getElementById(item.id) }))
    .filter((item) => item.node && !item.node.classList.contains("hidden"));
}

function sectionLandingTop(node) {
  const raw = node.getBoundingClientRect().top + window.scrollY - stickyHeaderHeight() - SECTION_LANDING_GAP_PX;
  return Math.max(0, Math.round(raw));
}

function renderSectionIndex() {
  const list = $("sec-index-list");
  if (!list) return [];
  const items = visibleResultSections();
  list.innerHTML = "";
  items.forEach((item, index) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sec-item";
    button.dataset.target = item.id;
    const num = document.createElement("span");
    num.className = "sec-num";
    num.textContent = String(index + 1);
    const name = document.createElement("span");
    name.className = "sec-name";
    name.textContent = item.label;
    const mark = document.createElement("span");
    mark.className = "sec-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "›";
    button.append(num, name, mark);
    button.addEventListener("click", () => gotoResultSection(item.id));
    li.appendChild(button);
    list.appendChild(li);
  });
  const count = $("sec-index-count");
  if (count) count.textContent = `${items.length} 章`;
  paintActiveSection();
  return items;
}

function paintActiveSection() {
  const list = $("sec-index-list");
  if (!list) return;
  list.querySelectorAll(".sec-item").forEach((button) => {
    const on = button.dataset.target === activeSectionId;
    button.classList.toggle("active", on);
    if (on) {
      button.setAttribute("aria-current", "true");
    } else {
      button.removeAttribute("aria-current");
    }
  });
}

function setSectionIndexOpen(open) {
  const panel = $("sec-index-panel");
  const scrim = $("sec-index-scrim");
  const toggle = $("sec-index-toggle");
  if (!panel || !toggle) return;
  sectionIndexOpen = Boolean(open);
  panel.classList.toggle("hidden", !sectionIndexOpen);
  if (scrim) scrim.classList.toggle("hidden", !sectionIndexOpen);
  toggle.setAttribute("aria-expanded", sectionIndexOpen ? "true" : "false");
  if (sectionIndexOpen) {
    const items = renderSectionIndex();
    const active = panel.querySelector(".sec-item.active");
    const target = active || panel.querySelector(".sec-item") || $("sec-index-close");
    if (target) target.focus({ preventScroll: true });
    if (!items.length) {
      const hint = $("sec-index-hint");
      if (hint) hint.textContent = "还没有可跳转的章节：先运行 Verity 引擎算出结果。";
    }
  }
}

/* 落位用的滚动（T-E0-044 加固）：瞬时落位，不再用平滑动画。

   Round 24 的第十三套验收在**线上**抓到：点章节索引后卡片仍在首屏之外
   （实测「点第 7 章后 top=4048」「点回到顶部后 scrollY 仍是 22652」），
   而同一份代码在机器空闲时又完全正常。根因是平滑滚动由**动画帧驱动**：
   结果页现在有二十七屏高（约 22,000 px），页面上还可能正跑着浏览器内引擎，
   动画帧被饿死时，用户点了章节就停在原地或半路。

   落位是功能，动画只是装饰。这里改成瞬时滚动：
     * 位移与动画帧、与页面长度都无关，点一下必然到达；
     * 顺带覆盖了「减少动态效果」这个无障碍偏好（瞬时本来就是它的等效行为）；
     * 让位口径不变 —— 目标位置仍由 sectionLandingTop() 用实测导航条高度算出。 */
function scrollToPosition(top) {
  window.scrollTo({ top: Math.max(0, Math.round(top)), behavior: "auto" });
  updateActiveSection();
}

/* 落位：先关目录，再滚动到「章节标题正好在导航条下方」的位置。 */
function gotoResultSection(id) {
  const node = document.getElementById(id);
  if (!node) return;
  setSectionIndexOpen(false);
  activeSectionId = id;
  paintActiveSection();
  scrollToPosition(sectionLandingTop(node));
}

function scrollToTop() {
  setSectionIndexOpen(false);
  scrollToPosition(0);
}

/* 当前章节：以「已越过导航条下沿的最后一个章节」为准；滚到底部时取最后一章。 */
function updateActiveSection() {
  const items = visibleResultSections();
  if (!items.length) {
    if (activeSectionId) {
      activeSectionId = "";
      paintActiveSection();
    }
    return;
  }
  const line = stickyHeaderHeight() + SECTION_LANDING_GAP_PX;
  const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4;
  let current = atBottom ? items[items.length - 1].id : items[0].id;
  if (!atBottom) {
    for (const item of items) {
      if (item.node.getBoundingClientRect().top - line <= 0) current = item.id;
    }
  }
  if (current !== activeSectionId) {
    activeSectionId = current;
    paintActiveSection();
  }
}

/* 章节浮层只在「真的算出结果」之后出现；档案切换、清空、快照收起时自动退场。 */
function syncSectionNav() {
  const nav = $("sec-nav");
  const results = $("results");
  if (!nav || !results) return;
  const ready = !results.classList.contains("hidden") && visibleResultSections().length > 0;
  nav.classList.toggle("hidden", !ready);
  if (!ready) setSectionIndexOpen(false);
  if (ready) updateActiveSection();
}

function bindSectionNav() {
  const toggle = $("sec-index-toggle");
  const top = $("sec-top");
  const close = $("sec-index-close");
  const scrim = $("sec-index-scrim");
  if (!toggle || !top) return;
  toggle.addEventListener("click", () => setSectionIndexOpen(!sectionIndexOpen));
  top.addEventListener("click", scrollToTop);
  if (close) close.addEventListener("click", () => setSectionIndexOpen(false));
  if (scrim) scrim.addEventListener("click", () => setSectionIndexOpen(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && sectionIndexOpen) setSectionIndexOpen(false);
  });
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      updateActiveSection();
      /* 滚动时同步首屏镜像提示的显隐：档案卡片进入视野即收起，不重复显示。 */
      try {
        syncHomeNotice(($("pf-msg") || {}).textContent || "", msgKindFromBox());
      } catch (err) {
        /* 无布局信息的环境下不参与显隐同步。 */
      }
    });
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", () => {
    syncStickyHeaderVar();
    onScroll();
  });
  syncStickyHeaderVar();
  /* 结果区的显隐由多条路径驱动（运行、切换档案、清空、展开快照）：
     监听真实 DOM，而不是在每处调用点各写一遍。 */
  const results = $("results");
  if (results && typeof MutationObserver === "function") {
    new MutationObserver(() => {
      syncSectionNav();
      if (sectionIndexOpen) renderSectionIndex();
    }).observe(results, { attributes: true, attributeFilter: ["class"], subtree: true });
  }
  syncSectionNav();
}

/* ========================================================= Round 29 · 品牌首页与家庭总览
   注册（本机账户）→ 建档 → 运行引擎 → 首页 8 模块总览 → 直接问 Verity。
   账户与档案仍然只保存在这台设备的浏览器里（localStorage），不上传、不收集身份信息。 */
const ACCOUNT_STORE_KEY = "verity.zh.account.v1";

let accountState = null;

function readAccount() {
  try {
    const raw = window.localStorage.getItem(ACCOUNT_STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.account_id !== "string") return null;
    accountState = parsed;
    return parsed;
  } catch (err) {
    return null;
  }
}

function writeAccount(acc) {
  try {
    window.localStorage.setItem(ACCOUNT_STORE_KEY, JSON.stringify(acc));
    accountState = acc;
    return true;
  } catch (err) {
    return false;
  }
}

function ensureAccount() {
  if (accountState) return accountState;
  const existing = readAccount();
  if (existing) return existing;
  const acc = {
    account_id: `vcf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    family_name: "",
    created_at: nowStamp(),
    updated_at: nowStamp(),
    profile_ids: [],
  };
  writeAccount(acc);
  return acc;
}

/* 首次保存家庭档案时完成「注册」：为这份档案的家庭名称建立本机账户记录。 */
function registerAccountWithFamily(name) {
  const acc = ensureAccount();
  acc.family_name = name || acc.family_name || "我的家庭";
  acc.updated_at = nowStamp();
  if (currentProfileId && acc.profile_ids.indexOf(currentProfileId) < 0) {
    acc.profile_ids.push(currentProfileId);
  }
  writeAccount(acc);
  return acc;
}

function resetAccount() {
  accountState = null;
  try {
    window.localStorage.removeItem(ACCOUNT_STORE_KEY);
  } catch (ignored) {
    /* 存储被禁用时无物可删 */
  }
}

/* 顶部品牌区与 Hero：新用户引导「建立我的家庭」，老用户显示「继续使用」。 */
function renderHome() {
  const acc = readAccount();
  const nameEl = $("hero-account-name");
  const metaEl = $("hero-account-meta");
  const back = $("hero-back");
  const registered = acc && acc.family_name;
  if (nameEl) {
    nameEl.textContent = registered ? `「${acc.family_name}」` : "尚未注册";
  }
  if (metaEl) {
    metaEl.textContent = registered
      ? `本机账户 ${esc(acc.account_id)} · 注册于 ${esc(acc.created_at)} · 仅保存在此浏览器，不上传`
      : "首次保存家庭档案即完成注册（仅保存在本机浏览器，不上传）。";
  }
  const hasProfiles = storeState.profiles.length > 0;
  if (back) {
    back.classList.toggle("hidden", !hasProfiles);
    if (hasProfiles) {
      back.textContent = currentProfileId ? "继续使用当前档案" : "回到我的家庭档案";
    }
  }
}

/* 首页总览的数据源：优先最近一次运行（刚运行完），其次档案上的结果快照。 */
function homeResult() {
  if (!currentProfileId) return null;
  const item = findProfile(currentProfileId);
  if (!item) return null;
  /* 快照优先：快照与档案对象绑定（随档案保存），不会跨档案串户。
     刚运行完且快照尚未落盘时，才回退到当次运行结果（用 run_id 与档案快照做一致性校验）。 */
  if (item.last_result && typeof item.last_result.result_text === "string") {
    /* S-30-01 纵深防御：即使一份快照已经落在本机（旧版本写的、或绕过了导入闸门），
       正文声明的归属与这份档案对不上时，宁可不显示，也不把别家的数字挂上来。 */
    if (!snapshotMatchesArchive(item.last_result, item.profile)) return null;
    try {
      return {
        result: JSON.parse(item.last_result.result_text),
        source: "snapshot",
        saved_at: item.last_result.saved_at || "",
        proof: item.last_result_proof || null,
      };
    } catch (err) {
      return null;
    }
  }
  /* S-30-03：fresh 通道的归属判据是**当次运行属于哪份档案条目**。
     编号相同不代表同一户人家（编号是自由文本），所以除了编号一致，
     还要求"这次运行就是开着当前这份档案跑出来的"。 */
  if (
    exportState.result &&
    item.profile &&
    exportState.result.profile_id === item.profile.profile_id &&
    freshResultOwnerId === currentProfileId &&
    (!item.last_run || !item.last_run.run_id || exportState.result.run_id === item.last_run.run_id)
  ) {
    return { result: exportState.result, source: "fresh", saved_at: "" };
  }
  return null;
}

/* 语义模块名 → 首页 DOM id。六个模块名来自 data-module（safety/cash/education/
   protection_gap/debt/growth），但它们并不等于 id 后缀：保障缺口那格的 id 是
   hm-gap。以前靠 `hm-${id}` 拼字符串，protection_gap 就永远拼不出节点、静默失败，
   首页那一格永远是「—」（Round 29 独立 QA 实测 Q-29-02）。这里改成显式映射表，
   并由 tests/test_r29_brand_home.py 逐条核对表与页面 id 锁步。 */
const HOME_METRIC_IDS = {
  safety: "hm-safety",
  cash: "hm-cash",
  education: "hm-education",
  protection_gap: "hm-gap",
  debt: "hm-debt",
  growth: "hm-growth",
};

/* 运行失败必须**在用户当前看得到的地方**说出来。

   Round 29 独立 QA（Q-29-04）实测：从首页「运行 Verity 引擎」发起、引擎资源加载
   失败时，唯一的那句报错写在向导区的 #w-error 里（y≈3662，第 3~4 屏之外），
   用户视野内什么都没有，看上去就是"点了没反应"。现在按"用户此刻在哪"决定：
   向导在视野内就报在向导，否则报在首页总览状态行，并滚动到看得见的位置。 */
function surfaceRunFailure(detail) {
  const wizardVisible = (() => {
    const runBtn = $("w-run");
    if (!runBtn) return false;
    const rect = runBtn.getBoundingClientRect();
    return rect.top < window.innerHeight && rect.bottom > 0;
  })();
  const long =
    engineState.phase === "failed"
      ? `运行失败：${detail}。引擎运行时没有准备好，可点上方「重试准备引擎」；或先「导出当前档案」保住输入。`
      : `运行失败：${detail}。可以再试一次；你已经填的家庭档案不会丢。`;
  const el = $("w-error");
  if (el) el.textContent = long;
  if (wizardVisible) {
    if (el) scrollToPosition(sectionLandingTop(el));
    return;
  }
  const status = $("home-status");
  if (status) {
    status.textContent = long;
    status.classList.add("err-text");
  }
  const banner = $("home-error");
  if (banner) {
    banner.textContent = long;
    banner.className = "err";
    banner.classList.remove("hidden");
    /* 走仓库统一的落位助手：它按粘性导航高度算偏移，且是瞬时落位
       （T-E0-044 起本区块禁止裸的滚动API与平滑动画，见 tests/test_section_index.py）。 */
    scrollToPosition(sectionLandingTop(banner));
  }
}

function setHomeMetric(id, value, hint, cls) {
  const base = HOME_METRIC_IDS[id] || `hm-${id}`;
  const v = $(base);
  const h = $(`${base}-hint`);
  if (v) {
    v.textContent = value;
    v.className = cls ? `v ${cls}` : "v";
  }
  if (h && hint) h.textContent = hint;
}

function highestRateDebt() {
  const item = currentProfileId ? findProfile(currentProfileId) : null;
  const profile = item ? item.profile : null;
  if (!profile || !Array.isArray(profile.liabilities)) return null;
  const withRate = profile.liabilities.filter((liab) => liab && Number(liab.rate) > 0);
  if (!withRate.length) return null;
  return withRate.slice().sort((a, b) => Number(b.rate) - Number(a.rate))[0];
}

/* 「今日三件事」：全部来自最近一次引擎结果与当前档案输入，逐条标注来源与去向。 */
function deriveThreeThings(r) {
  const items = [];
  /* 这些结果块必须在函数作用域声明：保持项在 if/else 之外使用它们，
     写在 else 里就是块级作用域，跨块引用会直接抛 ReferenceError
     （Round 29 实测：整块「今日三件事」因此渲染不出来）。 */
  const safety = r.safety || {};
  const safetyDays =
    (r.today && Number(r.today.safety_days)) || Number(safety.safety_days) || 0;
  const feasibility = r.feasibility || {};
  const breadwinner = r.breadwinner || {};
  const gap = breadwinner.protection_gap || {};
  const edu = breadwinner.education || {};
  const trend = (r.trend && r.trend.summary) || {};
  if (r.verdict === "ABSTAIN" || r.verdict === "REFUSE") {
    const reasons = Array.isArray(feasibility.reasons) ? feasibility.reasons.filter(Boolean) : [];
    items.push({
      sev: "high",
      title: r.verdict === "ABSTAIN" ? "补齐关键信息，让 Verity 能给出判定" : "先处理与目标冲突的结构问题",
      detail: reasons[0]
        ? String(reasons[0])
        : "信息不足时 Verity 拒绝猜测，不做任何假设性的动作。",
      target: "#r-verdict",
    });
    /* 拒答家庭同样要给够 3 条 —— 但这 3 条是"怎么解封"，不是编出来的财务结论。 */
    items.push({
      sev: "mid",
      title: reasons.length > 1 ? `还有 ${reasons.length - 1} 条理由要一起处理` : "把缺的输入补回家庭档案",
      detail: reasons.length > 1
        ? reasons.slice(1, 3).map((x) => String(x)).join("；")
        : "Verity 不会替你假设收入、负债或保障；缺哪一项就补哪一项，改完记得保存。",
      target: "#profiles",
    });
    items.push({
      sev: "mid",
      title: "补完之后重新运行一次引擎",
      detail: `这次判定是${cn(VERDICT_CN, r.verdict, r.verdict)}，属于 fail-closed 的安全动作；输入补齐后重跑，结论才会变成可执行的动作。`,
      target: "#home-run",
    });
  } else {
    if (safetyDays > 0 && safetyDays < 180) {
      items.push({
        sev: safetyDays < 90 ? "high" : "mid",
        title: "现金缓冲不足：把可支撑时间补到 180 天以上",
        detail: `当前收入中断后约可支撑 ${fmt(safetyDays, 1)} 天，低于 180 天底线（${fmt(safetyDays / 30, 1)} 个月）。`,
        target: "#r-safety",
      });
    }
    if (Number(gap.gap_after_insurance) > 0) {
      items.push({
        sev: "high",
        title: `补上保障缺口 ${money(gap.gap_after_insurance)}`,
        detail: `最坏情景是「${gap.worst_event_label_cn || "顶梁柱发生意外"}」。`,
        target: "#r-breadwinner",
      });
    }
    if (Array.isArray(edu.unfunded_events) && edu.unfunded_events.length > 0) {
      items.push({
        sev: "high",
        title: `教育资金有 ${edu.unfunded_events.length} 个情景未被隔离`,
        detail: `教育资金需求 ${money(edu.need)}；在这些意外情景下教育支出会被挤占。`,
        target: "#r-breadwinner",
      });
    }
    const debt = highestRateDebt();
    if (debt && Number(debt.rate) > 0.06) {
      items.push({
        sev: "mid",
        title: `优先偿还高息债务（年利率 ${pct(Number(debt.rate))}）`,
        detail: `「${esc(debt.kind)}」未偿余额 ${money(debt.balance)}，利率高于 6%。`,
        target: "#r-balance",
      });
    }
    if (Array.isArray(trend.deficit_months) && trend.deficit_months.length > 0) {
      items.push({
        sev: "high",
        title: `${trend.deficit_months.length} 个赤字月份需要处理`,
        detail: `按家庭自己记录的月度投影，第 ${trend.deficit_months.join("、")} 个月现金结余为负。`,
        target: "#r-trend",
      });
    } else if (trend.net_worth_change != null && Number(trend.net_worth_change) < 0) {
      items.push({
        sev: "mid",
        title: "净资产在减少",
        detail: `按记录的 12 个月投影，净资产变化 ${money(trend.net_worth_change)}。`,
        target: "#r-trend",
      });
    }
    if (
      feasibility.required_return_for_goal != null &&
      feasibility.achievable_return_proxy != null &&
      Number(feasibility.required_return_for_goal) > Number(feasibility.achievable_return_proxy)
    ) {
      items.push({
        sev: "mid",
        title: "目标回报率高于参考可达区间",
        detail: `目标 ${pct(Number(feasibility.required_return_for_goal))}，参考可达 ${pct(Number(feasibility.achievable_return_proxy))}；先调整目标或补资本。`,
        target: "#r-annual-goal",
      });
    }
  }
  const action = (r.today || {}).action;
  if (action && action !== "ABSTAIN") {
    const reason = (r.today || {}).action_reason || "";
    const detail = reason && !looksEnglish(String(reason)) ? String(reason) : ACTION_TEXT_CN[action] || "";
    items.push({
      sev: items.length ? "mid" : "ok",
      title: `今日动作：${ACTION_CN[action] || action}`,
      detail: detail,
      target: "#r-verdict",
    });
  }

  /* 家庭健康时"必须做的事"可能只有 1 件，但 CEO 规定的首页必须有 3 条。
     这里补的是**保持项**：每条都来自这次引擎结果里的真实数字，只是把"要处理"
     改成"要守住"；不许为了凑数编造数字，也不许把没发生的事写成风险。 */
  if (r.verdict !== "ABSTAIN" && r.verdict !== "REFUSE") {
    if (safetyDays >= 180) {
      items.push({
        sev: "ok",
        title: "守住 180 天现金缓冲",
        detail: `收入中断后约可支撑 ${fmt(safetyDays, 1)} 天（约 ${fmt(safetyDays / 30, 1)} 个月），已高于 180 天底线，别把缓冲挪去追收益。`,
        target: "#r-safety",
      });
    }
    if (Number(gap.gap_after_insurance) <= 0 && Number(gap.coverage_ratio) > 0) {
      items.push({
        sev: "ok",
        title: "保障覆盖已达标，别退保",
        detail: `最坏情景「${gap.worst_event_label_cn || "顶梁柱发生意外"}」覆盖比例 ${pct(Number(gap.coverage_ratio), 2)}，当前没有留下资金缺口。`,
        target: "#r-breadwinner",
      });
    }
    if (Array.isArray(edu.funded_events) && edu.funded_events.length > 0 &&
        !(Array.isArray(edu.unfunded_events) && edu.unfunded_events.length > 0)) {
      items.push({
        sev: "ok",
        title: "教育资金保持隔离",
        detail: `教育资金需求 ${money(edu.need)}，已在 ${edu.funded_events.length} 个意外情景下保持可支付，不要和长期投资混在一个账户里。`,
        target: "#r-breadwinner",
      });
    }
    const debtRatio = Number(safety.debt_pressure_ratio || 0);
    if (debtRatio > 0 && debtRatio <= 0.4) {
      items.push({
        sev: "ok",
        title: "债务压力保持可控",
        detail: `债务压力比 ${pct(debtRatio, 2)}，在 40% 以内；继续优先偿还利率最高的那一笔。`,
        target: "#r-balance",
      });
    }
    if (trend.net_worth_change != null && Number(trend.net_worth_change) >= 0) {
      items.push({
        sev: "ok",
        title: "资产在安全增长",
        detail: `按记录的 12 个月投影，净资产 ${money(trend.net_worth_start)} → ${money(trend.net_worth_end)}，变化 ${money(trend.net_worth_change)}。`,
        target: "#r-trend",
      });
    }
    items.push({
      sev: "ok",
      title: "更新档案，过一段时间重跑一次",
      detail: "收入、房贷、孩子学段一变，结论就会变。先把变化写回家庭档案，再重跑引擎。",
      target: "#profiles",
    });
  }

  if (!items.length) {
    items.push({
      sev: "ok",
      title: "今天没有必须动手的事项",
      detail: "现金、保障、教育、债务与增长都在可接受区间；继续保持记录，定期重跑引擎。",
      target: "#home",
    });
  }
  return items.slice(0, 3);
}

function renderThreeThings(items) {
  const el = $("home-three");
  if (!el) return;
  el.innerHTML = items
    .map(
      (t, index) => `<li class="t-sev-${esc(t.sev || "mid")}">
      <div class="t-title">${index + 1}. ${esc(t.title)}</div>
      <div class="t-detail">${esc(t.detail || "")}</div>
      <button type="button" class="t-go" data-go="${esc(t.target || "#home")}">看这一节 →</button>
    </li>`
    )
    .join("");
}

/* 首页 8 模块总览：家庭安全 / 现金可支撑时间 / 教育资金 / 保障缺口 / 债务 /
   资产安全增长 / 今日三件事 / 直接问 Verity。无数据时给出新用户与老用户引导。 */
function renderHomeDashboard() {
  const has = storeState.profiles.length > 0;
  const item = currentProfileId ? findProfile(currentProfileId) : null;
  const src = homeResult();
  const statusEl = $("home-status");
  const threeEl = $("home-three");
  const askEl = $("ask-answer");
  if (askEl) askEl.dataset.ready = src ? "1" : "0";

  if (!has) {
    if (statusEl) statusEl.textContent = "还没有家庭档案。点「建立我的家庭」注册并建立第一份家庭档案。";
    ["safety", "cash", "education", "protection_gap", "debt", "growth"].forEach((key) =>
      setHomeMetric(key, "—")
    );
    if (threeEl) threeEl.innerHTML = '<li class="note">还没有可整理的事项。先注册并运行一次引擎。</li>';
    if (askEl) askEl.textContent = "注册并运行一次引擎后，这里会直接回答你。";
    return;
  }
  if (!src || !src.result) {
    if (statusEl) {
      statusEl.textContent = item
        ? `「${esc(item.name)}」已注册保存。运行一次引擎后，这里会展示你家庭的 8 项核心情况。`
        : "运行一次引擎后，这里会展示你家庭的 8 项核心情况。";
    }
    ["safety", "cash", "education", "protection_gap", "debt", "growth"].forEach((key) =>
      setHomeMetric(key, "—")
    );
    if (threeEl) threeEl.innerHTML = '<li class="note">还没有运行结果。点「运行 Verity 引擎」后会给出今日三件事。</li>';
    if (askEl) askEl.textContent = "运行一次引擎后，这里会直接回答你。";
    return;
  }

  const r = src.result;
  const today = r.today || {};
  const safety = r.safety || {};
  const breadwinner = r.breadwinner || {};
  const gap = breadwinner.protection_gap || {};
  const edu = breadwinner.education || {};
  const trendSummary = (r.trend || {}).summary || {};
  const safetyDays = today.safety_days != null ? today.safety_days : safety.safety_days;
  const dayCls = safetyDays < 90 ? "neg" : safetyDays < 180 ? "warn" : "pos";
  const verdictCls = r.verdict === "PASS" ? "pos" : r.verdict === "REFUSE" ? "neg" : r.verdict === "ABSTAIN" ? "warn" : "info";
  const debtCls = Number((safety || {}).debt_pressure_ratio || 0) > 0.4 ? "neg" : "pos";
  const growthCls = Number(trendSummary.net_worth_change || 0) >= 0 ? "pos" : "neg";

  setHomeMetric("safety", esc(cn(VERDICT_CN, r.verdict, r.verdict)), `整体判定与生存底线 · ${fmt(safetyDays, 1)} 天`, verdictCls);
  setHomeMetric("cash", `${fmt(safetyDays, 1)} 天`, `收入中断后可支撑天数（约 ${fmt(safetyDays / 30, 1)} 个月）`, dayCls);
  setHomeMetric(
    "education",
    edu.funded_events && edu.funded_events.length > 0 ? "已隔离" : "未隔离",
    `教育资金需求 ${money(edu.need)} · 状态 ${edu.status || "—"}${edu.funded_events ? ` · ${edu.funded_events.length} 个情景可隔离` : ""}`,
    edu.unfunded_events && edu.unfunded_events.length > 0 ? "neg" : "pos"
  );
  setHomeMetric(
    "protection_gap",
    Number(gap.gap_after_insurance) > 0 ? money(gap.gap_after_insurance) : "无缺口",
    `最坏情景:${gap.worst_event_label_cn || "—"} · 覆盖比例 ${pct(Number(gap.coverage_ratio), 2)}`,
    Number(gap.gap_after_insurance) > 0 ? "neg" : "pos"
  );
  setHomeMetric(
    "debt",
    money(trendSummary.total_debt_end != null ? trendSummary.total_debt_end : safety.mandatory_debt_service_annual),
    `债务压力比 ${pct(Number((safety || {}).debt_pressure_ratio || 0), 2)} · ${Array.isArray(trendSummary.deficit_months) && trendSummary.deficit_months.length ? "有赤字月份" : "无赤字月份"}`,
    debtCls
  );
  setHomeMetric(
    "growth",
    trendSummary.net_worth_change != null ? money(trendSummary.net_worth_change) : "—",
    `净资产 ${money(trendSummary.net_worth_start)} → ${money(trendSummary.net_worth_end)} · 年度目标：${(r.annual_goal || {}).state_label_cn || "—"}`,
    growthCls
  );

  renderThreeThings(deriveThreeThings(r));
  if (askEl) {
    askEl.textContent =
      "可以点上方快捷问题，或输入问题问我。回答基于这份最近一次引擎结果，不会联网。";
  }
  if (statusEl) {
    const verdictLabel = cn(VERDICT_CN, r.verdict, r.verdict);
    if (src.source === "snapshot" && src.saved_at) {
      const proofOk = src.proof && src.proof.checks_passed === src.proof.checks_total;
      statusEl.textContent = `最近一次引擎结果：${verdictLabel}，快照保存于 ${src.saved_at}，本机复核 ${src.proof ? `${src.proof.checks_passed}/${src.proof.checks_total}` : "—"} 项一致。`;
      if (item && item.last_result) {
        inputsChangedSinceSnapshot(item, item.last_result).then((changed) => {
          if (changed === true && statusEl) {
            statusEl.textContent = `${statusEl.textContent} ⚠ 档案输入在快照之后被修改过，按当前输入重新运行后再看。`;
          }
        });
      }
    } else {
      statusEl.textContent = `本次运行结果：${verdictLabel}。`;
    }
  }
}

/* 直接问 Verity：只读当前家庭的最近一次结果做即时回答；没有结果时只给引导。 */
function askVerity(question) {
  const answer = $("ask-answer");
  if (!answer) return;
  const src = homeResult();
  const txt = String(question || "").trim();
  if (!src || !src.result) {
    answer.textContent =
      "我还没有这个家庭的运行结果，暂时无法给出基于数据的回答。请先「建立我的家庭」并「运行 Verity 引擎」。";
    return;
  }
  if (!txt) {
    answer.textContent = "请在上方输入问题，或点一个快捷问题。";
    return;
  }
  const r = src.result;
  const q = txt.toLowerCase();
  const lines = [];
  const say = (head, body) => lines.push(`【${head}】${body}`);
  const safetyDays = (r.today && r.today.safety_days) || (r.safety && r.safety.safety_days) || 0;
  const moneyNow = (value) => money(value);
  if (/现金|撑|多久|可支撑|断电|survival/.test(q)) {
    const mood = safetyDays < 90 ? "紧张" : safetyDays < 180 ? "偏紧" : "充足";
    say(
      "现金可支撑时间",
      `按最近一次结果，收入中断后约可支撑 ${fmt(safetyDays, 1)} 天（约 ${fmt(safetyDays / 30, 1)} 个月），处于${mood}状态。` +
        (safetyDays < 180 ? "低于 180 天底线，建议先把现金缓冲补到 180 天以上。" : "高于 180 天底线。")
    );
  }
  if (/保障|缺口|保险|保护|身故|失能/.test(q)) {
    const gap = (r.breadwinner || {}).protection_gap || {};
    say(
      "保障缺口",
      Number(gap.gap_after_insurance) > 0
        ? `最坏情景「${gap.worst_event_label_cn || "—"}」下资金缺口 ${moneyNow(gap.gap_after_insurance)}，需要补强。`
        : `最坏情景「${gap.worst_event_label_cn || "—"}」下资金缺口为 0，保障覆盖完整。`
    );
  }
  if (/债务|债|借款|房贷|利率|还款/.test(q)) {
    const debt = highestRateDebt();
    const summary = (r.trend || {}).summary || {};
    say(
      "债务",
      `最近一次结果：债务总额 ${moneyNow(summary.total_debt_end)}，债务压力比 ${pct(Number((r.safety || {}).debt_pressure_ratio || 0), 2)}。` +
        (debt
          ? `利率最高的一笔是「${esc(debt.kind)}」(${pct(Number(debt.rate))}，未偿余额 ${moneyNow(debt.balance)})。`
          : "当前档案记录里没有带利率的负债。")
    );
  }
  if (/教育|孩子|学费|升学/.test(q)) {
    const edu = (r.breadwinner || {}).education || {};
    const safe = Array.isArray(edu.unfunded_events) && edu.unfunded_events.length === 0;
    say(
      "教育资金",
      `需求 ${moneyNow(edu.need)}，状态 ${edu.status || "—"}：${safe ? "意外情景下教育支出都能先被隔离，教育连续性成立。" : "有情景下教育资金会被挤占，需要补强。"}`
    );
  }
  if (/增长|资产|收益|回报|趋势|净值|净资产|涨/.test(q)) {
    const summary = (r.trend || {}).summary || {};
    say(
      "资产安全增长",
      `按家庭自己记录的 12 个月投影，净资产从 ${moneyNow(summary.net_worth_start)} 到 ${moneyNow(summary.net_worth_end)}（变化 ${moneyNow(summary.net_worth_change)}）；赤字月份 ${(summary.deficit_months || []).length || 0} 个。年度目标状态：${(r.annual_goal || {}).state_label_cn || "—"}。`
    );
  }
  if (/动作|今天|做什么|怎么办|行动|先做/.test(q)) {
    const action = (r.today || {}).action || "";
    const reason = (r.today || {}).action_reason || "";
    const detail = reason && !looksEnglish(String(reason)) ? String(reason) : ACTION_TEXT_CN[action] || "";
    say("今日动作", `${ACTION_CN[action] || action || "—"}。${detail}`);
  }
  if (!lines.length) {
    lines.push(
      "我按这个家庭的最近一次结果回答这些主题：现金可支撑时间、保障缺口、债务、教育资金、资产安全增长、今日动作。"
    );
    lines.push("其他问题请先看「综合保护方案」与「证据与审计」两节，或把问题换成上面 6 个主题之一。");
  }
  answer.textContent = lines.join("\n");
}

/* 小工具：让「看这一节」横跨全部已渲染章节跳转。 */
function landTo(selector) {
  const node = document.querySelector(selector);
  if (node && typeof scrollToPosition === "function" && typeof sectionLandingTop === "function") {
    scrollToPosition(sectionLandingTop(node));
  }
}

function bindHomeJump() {
  const three = $("home-three");
  if (!three) return;
  three.addEventListener("click", (event) => {
    const target = event.target.closest("[data-go]");
    if (!target) return;
    landTo(target.dataset.go);
  });
}

/* ------------------------------------------------------------------ 绑定 */
function bind() {
  const navToggle = $("nav-toggle");
  const nav = $("main-nav");
  navToggle.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    navToggle.setAttribute("aria-expanded", open ? "true" : "false");
  });
  nav.querySelectorAll("a").forEach((link) =>
    link.addEventListener("click", () => {
      nav.classList.remove("open");
      navToggle.setAttribute("aria-expanded", "false");
    })
  );

  const trendRange = $("r-trend-range");
  if (trendRange) {
    trendRange.querySelectorAll("button").forEach((btn) =>
      btn.addEventListener("click", () => setTrendRange(btn.dataset.months))
    );
  }

  $("w-add-member").addEventListener("click", () => {
    addMember({ age: 35, annual_income: 0, income_stability: "medium", dependents: 0 });
    validate();
  });
  $("w-add-outflow").addEventListener("click", () => {
    $("w-outflows").appendChild(outflowRow({ years_until_due: 5 }));
    validate();
  });
  $("w-demo").addEventListener("click", async () => {
    try {
      fillProfile(await loadZhDemoFamily());
      showStep(1);
      $("w-error").textContent = "";
    } catch (err) {
      $("w-error").textContent = `载入示范家庭失败：${err.message || err}`;
    }
  });
  $("w-clear").addEventListener("click", () => {
    detachCurrentProfile();
    clearWizard();
    showStep(1);
  });
  $("pf-save").addEventListener("click", saveCurrentProfile);
  $("pf-save-as").addEventListener("click", saveCurrentProfileAsNew);
  $("pf-export").addEventListener("click", exportCurrentProfile);
  $("pf-import").addEventListener("click", () => $("pf-file").click());
  $("pf-file").addEventListener("change", (event) => {
    importProfileFile(event.target.files && event.target.files[0]);
    event.target.value = "";
  });
  $("pf-clear-all").addEventListener("click", clearAllProfiles);
  $("es-start").addEventListener("click", () => {
    ensureBrowserEngine().catch(() => {});
  });
  $("es-retry").addEventListener("click", retryBrowserEngine);
  const reportPreview = $("r-report-preview");
  const reportDownload = $("r-report-download");
  if (reportPreview) reportPreview.addEventListener("click", previewReportHtml);
  if (reportDownload) reportDownload.addEventListener("click", downloadReportHtml);
  $("pf-list").addEventListener("click", (event) => {
    const target = event.target.closest("[data-pf-open], [data-pf-snapshot], [data-pf-overwrite], [data-pf-delete]");
    if (!target) return;
    if (target.dataset.pfOpen) return openProfile(target.dataset.pfOpen);
    if (target.dataset.pfSnapshot) return openSnapshot(target.dataset.pfSnapshot);
    if (target.dataset.pfOverwrite) {
      openProfile(target.dataset.pfOverwrite);
      return saveCurrentProfile();
    }
    if (target.dataset.pfDelete) return deleteProfile(target.dataset.pfDelete);
  });
  const nameInput = $("pf-name");
  nameInput.addEventListener("input", () => {
    const open = currentProfileId ? findProfile(currentProfileId) : null;
    setMsg(
      open
        ? `当前打开「${open.name}」，「保存当前档案」会更新这一份；想保留原档案就点「另存为新档案」。`
        : "给档案起个名字，然后点「保存当前档案」新建一份。",
      ""
    );
  });

  $("w-prev").addEventListener("click", () => showStep(step - 1));
  $("w-next").addEventListener("click", () => showStep(step + 1));
  $("w-run").addEventListener("click", run);
  $("r-snapshot-rerun").addEventListener("click", () => {
    showStep(STEPS);
    $("wizard").scrollIntoView({ behavior: "smooth", block: "start" });
    setMsg("要按当前输入重算：确认向导里的数据后点「运行 Verity 引擎」。", "");
  });
  $("r-snapshot-close").addEventListener("click", () => {
    snapshotOpen = false;
    $("r-snapshot").classList.add("hidden");
    $("results").classList.add("hidden");
  });

  document.querySelectorAll("#wizard input, #wizard select").forEach((input) => {
    input.addEventListener("input", validate);
    input.addEventListener("change", validate);
  });

  /* Round 29 首页：品牌 Hero、8 模块总览、直接问 Verity */
  ["hero-establish", "home-establish"].forEach((id) => {
    const btn = $(id);
    if (btn) {
      btn.addEventListener("click", () => {
        landTo("#wizard");
      });
    }
  });
  const heroBack = $("hero-back");
  if (heroBack) {
    heroBack.addEventListener("click", () => {
      landTo("#profiles");
    });
  }
  const heroDemo = $("hero-demo");
  if (heroDemo) {
    heroDemo.addEventListener("click", async () => {
      try {
        fillProfile(await loadZhDemoFamily());
        showStep(1);
        $("w-error").textContent = "";
        landTo("#wizard");
      } catch (err) {
        $("w-error").textContent = `载入示范家庭失败：${err.message || err}`;
      }
    });
  }
  const homeRun = $("home-run");
  if (homeRun) {
    homeRun.addEventListener("click", () => {
      const runBtn = $("w-run");
      if (runBtn && !runBtn.classList.contains("hidden")) {
        runBtn.click();
      } else {
        showStep(STEPS);
        landTo("#wizard");
        setMsg("确认向导数据后点「运行 Verity 引擎」，运行后首页总览会立即更新。", "");
      }
    });
  }
  const askForm = $("ask-form");
  if (askForm) {
    askForm.addEventListener("submit", (event) => {
      event.preventDefault();
      askVerity($("ask-input").value);
    });
  }
  document.querySelectorAll("#ask-chips button").forEach((btn) => {
    btn.addEventListener("click", () => {
      askVerity((btn.dataset.q || "").trim());
    });
  });
  bindHomeJump();
  renderHome();
  renderHomeDashboard();

}

/* ------------------------------------------- PWA (T-E0-030)
   可安装 + 离线打开 + 版本自适应：
   * sw.js 缓存应用外壳（index.html 与其同级的 JS/CSS/清单/图标）；
   * pyodide/ 运行时仍由本页自己的 Cache Storage 管理，两者不重复存储；
   * 状态条如实说明：是否已受服务工作者控制、当前离线、新版本是否就绪。 */
const pwaState = { supported: false, controlling: false, updateReady: false };

function pwaText(offlineNow) {
  if (!("serviceWorker" in navigator)) {
    return "当前浏览器不支持服务工作线程：离线打开与「添加到主屏幕」不可用，在线使用不受影响。";
  }
  if (!pwaState.supported) {
    return "正在确认离线可用性…";
  }
  if (!pwaState.controlling) {
    return "应用外壳已缓存：断网也能打开本页。用浏览器菜单「添加到主屏幕」可像 App 一样启动。";
  }
  if (offlineNow) {
    return "当前离线：正在使用本机缓存的页面与应用外壳；引擎运行时若已在本机，仍可继续计算。";
  }
  return "离线打开已就绪：本页由服务工作线程控制，外壳随时可从本机打开，引擎运行时首次在线准备后保存在本机。";
}

function renderPwaStatus() {
  const strip = $("pwa-strip");
  if (!strip) return;
  let kind = "ok";
  if (!("serviceWorker" in navigator) || !pwaState.supported) kind = "off";
  else if (!navigator.onLine) kind = "offline";
  else if (pwaState.updateReady) kind = "update";
  strip.classList.remove("hidden");
  const dot = $("pwa-dot");
  if (dot) dot.dataset.kind = kind;
  const textEl = $("pwa-text");
  if (textEl) textEl.textContent = pwaText(!navigator.onLine);
  const reloadBtn = $("pwa-reload");
  if (reloadBtn) reloadBtn.classList.toggle("hidden", !pwaState.updateReady);
}

function registerServiceWorker() {
  const reloadBtn = $("pwa-reload");
  if (reloadBtn) reloadBtn.addEventListener("click", () => location.reload());
  if (!("serviceWorker" in navigator)) {
    renderPwaStatus();
    return;
  }
  navigator.serviceWorker.register("./sw.js")
    .then((registration) => {
      pwaState.supported = true;
      pwaState.controlling = Boolean(navigator.serviceWorker.controller);
      window.addEventListener("load", () => registration.update());
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            pwaState.updateReady = true;
            renderPwaStatus();
          }
        });
      });
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        pwaState.controlling = true;
        renderPwaStatus();
      });
      window.addEventListener("online", renderPwaStatus);
      window.addEventListener("offline", renderPwaStatus);
      renderPwaStatus();
    })
    .catch((error) => {
      const strip = $("pwa-strip");
      if (!strip) return;
      strip.classList.remove("hidden");
      const dot = $("pwa-dot");
      if (dot) dot.dataset.kind = "off";
      const textEl = $("pwa-text");
      if (textEl) textEl.textContent = `服务工作线程注册失败：${error && error.message ? error.message : error}`;
    });
}

/* --------------------------------------------------- 接口契约与版本 (T-E0-015)
   同一份 OpenAPI 描述文件在三处共用，且必须字节一致：
     1. 后端通道：GET /api/v0/openapi.json（api/server.py 直接回同一份文本）；
     2. 静态通道：dist/openapi.json（构建时写入）；
     3. 本页：window.VERITY_OPENAPI（服务端与构建脚本注入同一份文本）。
   源头是 api/openapi.py 的路由表 —— 端点、版本号、安全姿态都不是在这里手写的。
   本页只渲染，不改任何数字：契约缺失时如实说明并停止渲染，不显示编造的版本号。
   机器码（方法、路径、参数名、版本号）继续渲染可见，这是契约而不是英文残留。 */
const VERITY_OPENAPI = window.VERITY_OPENAPI || null;
const API_METHOD_LABEL = { GET: "读取", POST: "提交", PUT: "替换", PATCH: "修改", DELETE: "删除" };
let apiContractRendered = false;

function apiContractDoc() {
  return VERITY_OPENAPI && typeof VERITY_OPENAPI === "object" ? VERITY_OPENAPI : null;
}

function apiContractStatus(text, kind) {
  const node = $("api-contract-status");
  if (!node) return;
  node.textContent = text;
  node.className = `pill ${kind || "info"}`;
}

/* 把描述文件展开成「方法 + 路径」逐条端点；顺序按路由表原序，不重排。 */
function apiContractOperations(doc) {
  const rows = [];
  const paths = (doc && doc.paths) || {};
  Object.keys(paths).forEach((path) => {
    const item = paths[path] || {};
    Object.keys(item).forEach((method) => {
      const operation = item[method] || {};
      rows.push({
        method: String(method).toUpperCase(),
        path,
        summary: operation.summary || "",
        required: (operation.parameters || []).filter((one) => one.required).map((one) => one.name),
        hasBody: Boolean(operation.requestBody),
        stateChange: Boolean(operation["x-verity-state-change"]),
      });
    });
  });
  return rows;
}

function renderApiContract() {
  const metrics = $("api-contract-metrics");
  const body = $("api-contract-body");
  if (!metrics || !body) return;
  const doc = apiContractDoc();
  const meta = (doc && doc["x-verity"]) || null;
  if (!doc || !meta) {
    /* 失败关闭：没有描述文件就不给任何版本数字，也不假装有契约。 */
    metrics.innerHTML = "";
    body.textContent = "未注入接口描述文件，本页不显示任何版本或端点信息。";
    apiContractStatus("描述文件未注入", "warn");
    return;
  }
  const info = doc.info || {};
  const metricsSpec = [
    ["接口主版本", meta.api_version, "api_version"],
    ["契约修订号", info.version || meta.api_contract_version, "info.version"],
    ["引擎版本", meta.algorithm_version, "algorithm_version"],
    ["产品版本", meta.product_version, "product_version"],
  ];
  metrics.innerHTML = metricsSpec
    .map(([label, value, code]) => `
      <div class="metric">
        <div class="k">${esc(label)}</div>
        <div class="v info mono">${esc(value || "—")}</div>
        <div class="h">${esc(code)}</div>
      </div>`)
    .join("");

  const operations = apiContractOperations(doc);
  const rows = operations
    .map((one) => `
      <tr>
        <td><code class="mono">${esc(one.method)}</code></td>
        <td><code class="mono">${esc(one.path)}</code></td>
        <td>${esc(one.summary)}</td>
        <td>${one.required.length ? one.required.map((name) => `<code class="mono">${esc(name)}</code>`).join(" ") : "—"}</td>
        <td>${one.hasBody ? "有" : "无"}</td>
        <td>${one.stateChange ? "会写入本机记录" : "只读"}</td>
      </tr>`)
    .join("");

  const versioning = meta.versioning || {};
  const versioningItems = Object.keys(versioning)
    .map((key) => `<li><strong>${esc(key)}</strong>：${esc(versioning[key])}</li>`)
    .join("");
  const guaranteeItems = (meta.guarantees || []).map((one) => `<li>${esc(one)}</li>`).join("");
  const headers = meta.response_headers || {};
  const headerItems = Object.keys(headers)
    .map((key) => `<li><code class="mono">${esc(key)}</code>：${esc(headers[key])}</li>`)
    .join("");

  body.innerHTML = `
    <div class="sub">端点清单（共 ${operations.length} 个动作）：与后端真正接受的路由同源，改一处即全部生效。</div>
    <div class="scroll"><table id="api-contract-table">
      <thead><tr><th>方法</th><th>路径</th><th>用途</th><th>必填参数</th><th>请求体</th><th>是否改状态</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <h3 class="mt">版本化与兼容承诺</h3>
    <ul>${versioningItems}</ul>
    <h3 class="mt">接口保证</h3>
    <ul>${guaranteeItems}</ul>
    <h3 class="mt">响应头记录的安全姿态</h3>
    <ul>${headerItems}</ul>`;
  apiContractRendered = true;
  setApiContractExpanded(true);
  apiContractStatus(`端点 ${operations.length} 个`, "ok");
}

function setApiContractExpanded(expanded) {
  const button = $("api-contract-toggle");
  const body = $("api-contract-body");
  if (!button || !body) return;
  button.setAttribute("aria-expanded", expanded ? "true" : "false");
  button.textContent = expanded ? "收起端点清单" : "展开端点清单";
  body.classList.toggle("hidden", !expanded);
}

function toggleApiContract() {
  const button = $("api-contract-toggle");
  if (!button) return;
  setApiContractExpanded(button.getAttribute("aria-expanded") !== "true");
}

/* 浏览器内生成并下载描述文件本体（不发起任何网络请求，离线同样可用）。
   内容取自同一份注入文本，因此与后端 /api/v0/openapi.json 是同一份契约。 */
function downloadApiContract() {
  const doc = apiContractDoc();
  if (!doc) {
    apiContractStatus("描述文件未注入，无法导出", "warn");
    return;
  }
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "verity-openapi.json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  apiContractStatus(`已导出描述文件（${text.length} 字符）`, "ok");
}

function bindApiContract() {
  const download = $("api-contract-download");
  if (download) download.addEventListener("click", downloadApiContract);
  const toggle = $("api-contract-toggle");
  if (toggle) toggle.addEventListener("click", toggleApiContract);
}

function boot() {
  buildStaticControls();
  bindApiContract();
  renderApiContract();
  registerServiceWorker();
  const loaded = readStore();
  storeState = loaded.store;
  /* 迁移结果立即写回：只有落盘了，档案库版本号才是真的。 */
  if (loaded.migrated) writeStore();
  if (loaded.error) setMsg(loaded.error, "warn");
  renderProfileList();
  addMember({ age: 35, annual_income: 300000, income_stability: "high", dependents: 0 });
  bind();
  bindSectionNav();
  showStep(1);
  restoreLastProfile();
  /* 迁移提示必须保留下来：它和「已恢复上次档案」是两件不同的事。 */
  if (loaded.note) setMsg(`${loaded.note} ${$("pf-msg").textContent || ""}`.trim(), loaded.error ? "warn" : "ok");
  renderEngineStrip();
  detectChannel()
    .then(() => {
      if (CHANNEL === "browser") {
        /* 静态部署形态：首屏渲染完成后才在后台准备引擎；失败只体现在状态条，不污染填写流程 */
        scheduleEngineWarmup();
      }
      renderEngineStrip();
    })
    .catch(() => {});
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
