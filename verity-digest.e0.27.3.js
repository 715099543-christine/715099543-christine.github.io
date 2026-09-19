/* Verity 证据复核模块 (T-E0-029)
 *
 * 作用：在本机浏览器里独立重算引擎写下的哈希，证明这份结果快照没有被改动过。
 * 这个文件不产生任何结论，也不做任何计算——它只回答一个问题：
 * 「保存的这份结果，还是不是当初引擎算出来的那一份？」
 *
 * 规范 JSON 必须与 engine/evidence.py 的 _canonical() 逐字节一致：
 *     json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True, default=str)
 * 做法是把快照里保存的**引擎原始 JSON 文本**重新规范化：数字按原文保留，
 * 因此不存在 Python 与 JavaScript 浮点格式差异导致的误判。
 *
 * 失败关闭：任何一步算不出来（没有 SHA-256、文本损坏、缺少字段），都返回 ok=false，
 * 绝不当成「通过」。
 */
(function (global) {
  "use strict";

  const HEX = "0123456789abcdef";

  /* --------------------------------------------------------------- 文本 → 规范 JSON */

  function parseError(detail) {
    const err = new Error(`快照正文无法解析：${detail}`);
    err.code = "E_PARSE";
    return err;
  }

  function escapeCodeUnits(units) {
    let out = '"';
    for (let i = 0; i < units.length; i += 1) {
      const unit = units[i];
      if (unit === 0x22) out += '\\"';
      else if (unit === 0x5c) out += "\\\\";
      else if (unit === 0x08) out += "\\b";
      else if (unit === 0x0c) out += "\\f";
      else if (unit === 0x0a) out += "\\n";
      else if (unit === 0x0d) out += "\\r";
      else if (unit === 0x09) out += "\\t";
      else if (unit < 0x20 || unit > 0x7e) out += `\\u${unit.toString(16).padStart(4, "0")}`;
      else out += String.fromCharCode(unit);
    }
    return `${out}"`;
  }

  /* 解析 JSON 文本，产出一棵「规范形式」节点树；数字保留原文。 */
  function parseCanonicalTree(text) {
    let index = 0;

    function skipSpace() {
      while (index < text.length && " \t\n\r".indexOf(text[index]) >= 0) index += 1;
    }

    function readString() {
      // text[index] === '"'
      index += 1;
      const units = [];
      while (index < text.length) {
        const ch = text[index];
        if (ch === '"') {
          index += 1;
          const decoded = decodeUnits(units);
          return { t: "lit", out: escapeCodeUnits(units), key: decoded, str: decoded };
        }
        if (ch === "\\") {
          const next = text[index + 1];
          if (next === "u") {
            const hex = text.slice(index + 2, index + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw parseError("字符串转义不完整");
            units.push(parseInt(hex, 16));
            index += 6;
          } else if (next === "b") { units.push(0x08); index += 2; }
          else if (next === "f") { units.push(0x0c); index += 2; }
          else if (next === "n") { units.push(0x0a); index += 2; }
          else if (next === "r") { units.push(0x0d); index += 2; }
          else if (next === "t") { units.push(0x09); index += 2; }
          else if (next === '"') { units.push(0x22); index += 2; }
          else if (next === "\\") { units.push(0x5c); index += 2; }
          else if (next === "/") { units.push(0x2f); index += 2; }
          else throw parseError("未知的字符串转义");
        } else if (ch.charCodeAt(0) < 0x20) {
          throw parseError("字符串中出现未转义的控制字符");
        } else {
          units.push(ch.charCodeAt(0));
          index += 1;
        }
      }
      throw parseError("字符串没有结束");
    }

    function readNumber() {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(index));
      if (!match) throw parseError("数字格式不正确");
      index += match[0].length;
      return { t: "lit", out: match[0] };
    }

    function readLiteral() {
      const rest = text.slice(index);
      if (rest.startsWith("true")) { index += 4; return { t: "lit", out: "true" }; }
      if (rest.startsWith("false")) { index += 5; return { t: "lit", out: "false" }; }
      if (rest.startsWith("null")) { index += 4; return { t: "lit", out: "null" }; }
      throw parseError("无法识别的字面量");
    }

    function readArray() {
      index += 1;
      const items = [];
      skipSpace();
      if (text[index] === "]") { index += 1; return { t: "arr", items }; }
      for (;;) {
        items.push(readValue());
        skipSpace();
        if (text[index] === ",") { index += 1; continue; }
        if (text[index] === "]") { index += 1; return { t: "arr", items }; }
        throw parseError("数组缺少逗号或右括号");
      }
    }

    function readObject() {
      index += 1;
      const byKey = new Map();
      skipSpace();
      if (text[index] === "}") { index += 1; return buildObject(byKey); }
      for (;;) {
        skipSpace();
        if (text[index] !== '"') throw parseError("对象的键必须是字符串");
        const keyNode = readString();
        skipSpace();
        if (text[index] !== ":") throw parseError("对象缺少冒号");
        index += 1;
        byKey.set(keyNode.key, [keyNode.out, readValue()]);
        skipSpace();
        if (text[index] === ",") { index += 1; continue; }
        if (text[index] === "}") { index += 1; return buildObject(byKey); }
        throw parseError("对象缺少逗号或右括号");
      }
    }

    function readValue() {
      skipSpace();
      const ch = text[index];
      if (ch === undefined) throw parseError("内容提前结束");
      if (ch === "{") return readObject();
      if (ch === "[") return readArray();
      if (ch === '"') return readString();
      if (ch === "t" || ch === "f" || ch === "n") return readLiteral();
      return readNumber();
    }

    const root = readValue();
    skipSpace();
    if (index !== text.length) throw parseError("正文末尾有多余内容");
    return root;
  }

  function buildObject(byKey) {
    const keys = [...byKey.keys()].sort(compareCodePoints);
    return {
      t: "obj",
      keys,
      entries: keys.map((key) => [key, byKey.get(key)[0], byKey.get(key)[1]]),
    };
  }

  function decodeUnits(units) {
    return String.fromCharCode.apply(null, units);
  }

  /* Python json.dumps(sort_keys=True) 按码点排序；JS 默认按 UTF-16 码元排序。 */
  function compareCodePoints(a, b) {
    const left = Array.from(a);
    const right = Array.from(b);
    const len = Math.min(left.length, right.length);
    for (let i = 0; i < len; i += 1) {
      const la = left[i].codePointAt(0);
      const rb = right[i].codePointAt(0);
      if (la !== rb) return la - rb;
    }
    return left.length - right.length;
  }

  function renderTree(node) {
    if (node.t === "lit") return node.out;
    if (node.t === "arr") return `[${node.items.map(renderTree).join(",")}]`;
    return `{${node.entries.map(([, keyOut, value]) => `${keyOut}:${renderTree(value)}`).join(",")}}`;
  }

  function withoutKeys(node, dropped) {
    if (!node || node.t !== "obj") return node;
    const entries = node.entries.filter(([key]) => !dropped.has(key));
    return { t: "obj", keys: entries.map(([key]) => key), entries };
  }

  function entryOf(node, key) {
    if (!node || node.t !== "obj") return null;
    const found = node.entries.find(([name]) => name === key);
    return found ? found[2] : null;
  }

  /* 取出字面量的文本值：字符串取解码结果（用于与引擎记录的哈希比对），数字/布尔/null 取原文。 */
  function literalText(node) {
    if (!node || node.t !== "lit") return null;
    return typeof node.str === "string" ? node.str : node.out;
  }

  /* --------------------------------------------------------------- 值 → 规范 JSON
     只用于家庭档案输入（由本页 JS 对象产生）。数字按 Python 会得到的结果渲染：
     整数值在 JS 里就是整数文本，Python 解析后也是 int；其余按浮点 repr 规则。 */

  function pythonFloatLiteral(value) {
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "Infinity";
    if (value === -Infinity) return "-Infinity";
    if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
    const negative = value < 0;
    const text = Math.abs(value).toString();
    let mantissa = text;
    let exponent = 0;
    const eIndex = text.indexOf("e");
    if (eIndex >= 0) {
      mantissa = text.slice(0, eIndex);
      exponent = Number(text.slice(eIndex + 1));
    }
    const dot = mantissa.indexOf(".");
    const intPart = dot >= 0 ? mantissa.slice(0, dot) : mantissa;
    const fracPart = dot >= 0 ? mantissa.slice(dot + 1) : "";
    const combined = intPart + fracPart;
    const significant = combined.replace(/^0+/, "").replace(/0+$/, "");
    if (!significant) return negative ? "-0.0" : "0.0";
    const leadingZeros = combined.length - combined.replace(/^0+/, "").length;
    const sciExp = intPart.length - leadingZeros - 1 + exponent;
    const sign = negative ? "-" : "";
    if (sciExp < -4 || sciExp >= 16) {
      const head = significant.slice(0, 1);
      const rest = significant.slice(1);
      const pad = Math.abs(sciExp) < 10 ? `0${Math.abs(sciExp)}` : String(Math.abs(sciExp));
      return `${sign}${head}${rest ? `.${rest}` : ""}e${sciExp < 0 ? "-" : "+"}${pad}`;
    }
    if (sciExp < 0) return `${sign}0.${"0".repeat(-sciExp - 1)}${significant}`;
    const intDigits = significant.slice(0, sciExp + 1).padEnd(sciExp + 1, "0");
    const fracDigits = significant.slice(sciExp + 1);
    return `${sign}${intDigits}.${fracDigits || "0"}`;
  }

  function canonicalFromValue(value) {
    if (value === null) return "null";
    const kind = typeof value;
    if (kind === "string") return escapeCodeUnits(Array.from({ length: value.length }, (_, i) => value.charCodeAt(i)));
    if (kind === "boolean") return value ? "true" : "false";
    if (kind === "number") {
      if (Number.isInteger(value) && Math.abs(value) < 1e21) return String(value === 0 ? 0 : value);
      return pythonFloatLiteral(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalFromValue).join(",")}]`;
    if (kind === "object") {
      const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort(compareCodePoints);
      return `{${keys.map((key) => `${canonicalFromValue(key)}:${canonicalFromValue(value[key])}`).join(",")}}`;
    }
    return "null";
  }

  /* --------------------------------------------------------------- SHA-256 */

  function subtleCrypto() {
    const cryptoObj = global.crypto || (typeof crypto !== "undefined" ? crypto : null);
    return cryptoObj && cryptoObj.subtle ? cryptoObj.subtle : null;
  }

  async function sha256Hex(text) {
    const subtle = subtleCrypto();
    if (!subtle) {
      const err = new Error("这个浏览器环境没有可用的 SHA-256，无法复核快照");
      err.code = "E_NO_SHA256";
      throw err;
    }
    const bytes = new TextEncoder().encode(text);
    const hash = await subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash)).map((b) => HEX[b >> 4] + HEX[b & 15]).join("");
  }

  async function digestText(text) {
    return sha256Hex(text);
  }

  async function digestValue(value) {
    return sha256Hex(canonicalFromValue(value));
  }

  /* --------------------------------------------------------------- 快照复核 */

  const GENESIS_HASH = "0".repeat(64);

  const CHECK_LABELS = {
    payload_digest: "结果正文摘要 audit.payload_digest",
    evidence_record: "证据块自哈希 evidence.record_hash",
    audit_record: "审计记录哈希 audit.record_hash",
    inputs_digest: "输入摘要 evidence.inputs_digest",
    genesis_chain: "审计链起点 prev_hash = 64 个 0，sequence = 0",
  };

  /**
   * 复核一份本机保存的结果快照。
   * @param {{result_text?: string, profile?: object}} snapshot
   * @returns {Promise<{ok: boolean, checks: object[], failures: string[], error?: string, canonical_bytes?: number}>}
   */
  async function verifySnapshot(snapshot) {
    const checks = [];
    const add = (id, expected, actual, note) => {
      const ok = typeof actual === "string" && actual === expected;
      checks.push({ id, label: CHECK_LABELS[id] || id, expected, actual, ok, note: note || "" });
      return ok;
    };

    const resultText = snapshot && snapshot.result_text;
    if (typeof resultText !== "string" || !resultText.trim()) {
      return { ok: false, checks, failures: ["缺少引擎原始输出文本"], error: "E_EMPTY" };
    }
    let tree;
    try {
      tree = parseCanonicalTree(resultText);
    } catch (err) {
      return { ok: false, checks, failures: [`快照正文损坏（${err.message}）`], error: err.code || "E_PARSE" };
    }
    if (!tree || tree.t !== "obj") {
      return { ok: false, checks, failures: ["快照正文不是 JSON 对象"], error: "E_SHAPE" };
    }

    const auditNode = entryOf(tree, "audit");
    const evidenceNode = entryOf(tree, "evidence");
    if (!auditNode || !evidenceNode) {
      return { ok: false, checks, failures: ["快照缺少 evidence 或 audit 区块"], error: "E_SHAPE" };
    }
    const recordedPayloadDigest = literalText(entryOf(auditNode, "payload_digest"));
    const recordedAuditHash = literalText(entryOf(auditNode, "record_hash"));
    const recordedEvidenceHash = literalText(entryOf(evidenceNode, "record_hash"));
    const recordedInputsDigest = literalText(entryOf(evidenceNode, "inputs_digest"));
    const recordedPrevHash = literalText(entryOf(auditNode, "prev_hash"));
    const recordedSequence = literalText(entryOf(auditNode, "sequence"));

    let canonicalFull = "";
    let canonicalBody = "";
    try {
      canonicalFull = renderTree(tree);
      canonicalBody = renderTree(withoutKeys(tree, new Set(["audit", "evidence", "risk_notice"])));
    } catch (err) {
      return { ok: false, checks, failures: [`快照正文无法规范化（${err.message}）`], error: "E_CANON" };
    }

    try {
      add("payload_digest",
        recordedPayloadDigest,
        await digestText(canonicalBody),
        "用规范 JSON 重算「结果正文」的 SHA-256");
      add("audit_record",
        recordedAuditHash,
        await digestText(renderTree(withoutKeys(auditNode, new Set(["record_hash"])))),
        "用规范 JSON 重算审计记录自身的 SHA-256");
      add("evidence_record",
        recordedEvidenceHash,
        await digestText(renderTree(withoutKeys(evidenceNode, new Set(["record_hash"])))),
        "用规范 JSON 重算证据块自身的 SHA-256");
      add("inputs_digest",
        recordedInputsDigest,
        await digestValue((snapshot || {}).profile),
        "用快照里保存的家庭输入重算 SHA-256");
      add("genesis_chain",
        GENESIS_HASH,
        typeof recordedPrevHash === "string" ? recordedPrevHash : "",
        "链起点必须是创世哈希");
      const sequenceOk = recordedSequence === "0";
      if (!sequenceOk) {
        checks.push({
          id: "genesis_sequence",
          label: "审计链序号 sequence = 0",
          expected: "0",
          actual: typeof recordedSequence === "string" ? recordedSequence : "(缺失)",
          ok: false,
          note: "单条审计记录的序号必须是 0",
        });
      }
    } catch (err) {
      return {
        ok: false,
        checks,
        failures: [err.code === "E_NO_SHA256" ? err.message : `复核过程出错（${err.message}）`],
        error: err.code || "E_VERIFY",
        canonical_bytes: canonicalFull.length,
      };
    }

    const failures = checks.filter((check) => !check.ok).map((check) => check.label);
    return { ok: failures.length === 0, checks, failures, canonical_bytes: canonicalFull.length };
  }

  const api = {
    canonicalFromValue,
    canonicalizeResultText(text) {
      return renderTree(parseCanonicalTree(text));
    },
    digestText,
    digestValue,
    sha256Hex,
    verifySnapshot,
    GENESIS_HASH,
  };

  global.VerityDigest = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
