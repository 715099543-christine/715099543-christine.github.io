/* Verity AI家庭CFO · 后台核心（运行时无关）
 *
 * 这里只有业务规则，没有任何运行时依赖：存储通过注入的 store 端口访问，
 * 因此同一份代码在 Node（node:sqlite）与 Cloudflare Workers（D1）上跑的是同一套逻辑。
 *
 * 安全姿态（与 platform/CONTRACT.md 对齐）：
 *   * 失败关闭：任何校验不过、任何异常，都不返回业务数据；
 *   * 归属隔离：所有档案读写都以会话里的 user_id 为准，跨账号一律 404（不泄漏存在性）；
 *   * 双层加密：端侧已加密的正文在库内再用「每用户 DEK」加密一次，库里没有明文列；
 *   * 不泄漏：500 只回机器码与中文提示，绝不回堆栈。
 */
import {
  PASSWORD_ITERATIONS,
  aesGcmDecrypt,
  aesGcmEncrypt,
  b64,
  deriveKek,
  fromUtf8,
  importAesKey,
  pbkdf2,
  randomBytes,
  randomToken,
  sha256B64,
  timingSafeEqual,
  unb64,
  utf8,
} from "./crypto.mjs";

import { API_VERSION } from "./version.mjs";

export { API_VERSION };
export const SESSION_COOKIE = "verity_sess";
export const MAX_PAYLOAD_BYTES = 1024 * 1024;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* r71 · 找回口令（忘记密码）：
 * 恢复材料全部由端侧生成，服务端只做两件事——原样存下来、在重置时等值校验恢复码。
 * 恢复码本身（以及由它派生的密钥）从不发送到服务端，服务端因此也无法解开家庭档案。 */
const RECOVERY_SALT_RE = /^[A-Za-z0-9+/=]{16,64}$/;
const RECOVERY_WRAP_RE = /^v1\.[A-Za-z0-9+/=]{12,64}\.[A-Za-z0-9+/=]{8,4096}$/;
const RECOVERY_VERIFIER_RE = /^[A-Za-z0-9+/=]{40,64}$/;
const RECOVERY_ITER_MIN = 10000;
const RECOVERY_ITER_MAX = 1000000;
const RECOVERY_CODE_RE = /^[A-Za-z0-9-]{16,64}$/;

function readRecoveryMaterial(value) {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { error: "恢复材料格式不正确。" };
  }
  const salt = String(value.salt || "");
  const wrap = String(value.wrap || "");
  const verifier = String(value.verifier || "");
  const iter = Number(value.iter || 0);
  if (!RECOVERY_SALT_RE.test(salt)) return { error: "恢复材料格式不正确。" };
  if (!RECOVERY_WRAP_RE.test(wrap)) return { error: "恢复材料格式不正确。" };
  if (!RECOVERY_VERIFIER_RE.test(verifier)) return { error: "恢复材料格式不正确。" };
  if (!Number.isInteger(iter) || iter < RECOVERY_ITER_MIN || iter > RECOVERY_ITER_MAX) {
    return { error: "恢复材料格式不正确。" };
  }
  return {
    value: {
      recovery_salt: salt,
      recovery_wrap: wrap,
      recovery_verifier: verifier,
      recovery_iter: iter,
    },
  };
}

function recoveryConfigured(user) {
  return Boolean(user && user.recovery_verifier);
}

/* ------------------------------------------------------------------ 工具 */

function utf8Length(text) {
  return utf8(text).length;
}

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign(
      {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
      headers
    ),
  });
}

export function errorResponse(code, message, status, extra = {}) {
  return jsonResponse(Object.assign({ error: { code, message } }, extra), status);
}

function parseCookies(header) {
  const out = {};
  String(header || "")
    .split(";")
    .forEach((part) => {
      const idx = part.indexOf("=");
      if (idx < 0) return;
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (key) out[key] = decodeURIComponent(value);
    });
  return out;
}

export function sessionCookie(token, { secure = true, maxAgeSeconds = SESSION_TTL_MS / 1000 } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeSeconds)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie({ secure = true } = {}) {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function iso(date) {
  return date.toISOString();
}

/* 家庭称呼与档案正文一样属于家庭数据：库里只存密文。
   解密密钥是每用户 DEK，只有拿到主密钥的服务端进程能解，因此这里放在 createApi 内部。 */
function userShape(row, displayName) {
  return {
    id: row.id,
    email: row.email,
    display_name: displayName || "",
    created_at: row.created_at,
  };
}

/* ------------------------------------------------------------------ 主入口 */

export function createApi(options) {
  const store = options.store;
  const masterKey = options.masterKey;
  const mode = options.mode || "production";
  const now = options.now || (() => new Date());
  const allowedOrigins = (options.allowedOrigins || []).filter(Boolean);
  const trustProxySecure = options.localInsecureCookie === true;
  /* 口令派生次数必须按运行时给：Cloudflare Workers 上限 100000（见 crypto.mjs）。
     缺省沿用本地 210000；老账号按库里的 password_iter 验算，不受这里的改动影响。 */
  const passwordIterations = Number(options.passwordIterations) || PASSWORD_ITERATIONS;
  if (!store) throw new Error("createApi 需要注入 store");
  if (!masterKey) throw new Error("createApi 需要 VERITY_MASTER_KEY");

  /* CORS：只有白名单来源才拿到凭证许可，且必须回显具体来源（不能用 *）。 */
  function corsHeaders(request) {
    const origin = request.headers.get("origin") || "";
    if (!origin) return {};
    if (allowedOrigins.indexOf(origin) < 0) return {};
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,accept",
      "access-control-max-age": "600",
      vary: "Origin",
    };
  }

  /* 写请求的同源校验：浏览器一定会带 Origin。带了就必须在白名单或同源里；
     没带说明不是浏览器发起的跨站请求（例如服务端脚本），放行。 */
  function originAllowed(request, url) {
    const origin = request.headers.get("origin");
    if (!origin) return true;
    if (allowedOrigins.indexOf(origin) >= 0) return true;
    try {
      const o = new URL(origin);
      return o.host === url.host;
    } catch (err) {
      return false;
    }
  }

  function cookieSecure(request, url) {
    if (trustProxySecure) return false;
    if (url.protocol === "https:") return true;
    const host = (url.hostname || "").toLowerCase();
    const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
    return local ? false : true;
  }

  async function readJson(request) {
    const declared = Number(request.headers.get("content-length") || 0);
    if (declared && declared > MAX_JSON_BYTES) {
      return { error: errorResponse("payload_too_large", "请求体超过 2 MiB 上限。", 413) };
    }
    let text;
    try {
      text = await request.text();
    } catch (err) {
      return { error: errorResponse("invalid_request", "无法读取请求体。", 400) };
    }
    if (utf8Length(text) > MAX_JSON_BYTES) {
      return { error: errorResponse("payload_too_large", "请求体超过 2 MiB 上限。", 413) };
    }
    try {
      const parsed = text ? JSON.parse(text) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      return { value: parsed };
    } catch (err) {
      return { error: errorResponse("invalid_request", "请求体不是合法的 JSON 对象。", 400) };
    }
  }

  async function currentSession(request, url) {
    const token = parseCookies(request.headers.get("cookie") || "")[SESSION_COOKIE];
    if (!token) return null;
    const hash = await sha256B64(token);
    const row = await store.getSession(hash);
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= now().getTime()) {
      await store.deleteSession(hash);
      return null;
    }
    const user = await store.getUserById(row.user_id);
    if (!user) return null;
    await store.touchSession(hash, iso(now()));
    return { user, tokenHash: hash };
  }

  async function unwrapDek(user, aad) {
    const kek = await deriveKek(masterKey);
    const raw = await aesGcmDecrypt(kek, user.dek_iv, user.dek_wrapped, aad);
    return importAesKey(raw);
  }

  async function sealPayload(user, plaintext) {
    const dek = await unwrapDek(user, `user:${user.id}`);
    const { iv, ct } = await aesGcmEncrypt(dek, utf8(plaintext), `record:${user.id}`);
    return { payload: ct, payload_iv: iv, payload_tag: "" };
  }

  async function openPayload(user, row) {
    const dek = await unwrapDek(user, `user:${user.id}`);
    const raw = await aesGcmDecrypt(dek, row.payload_iv, row.payload, `record:${user.id}`);
    return fromUtf8(raw);
  }

  /* 出接口前才解密家庭称呼；解不开就按空称呼返回，绝不因此把 500 抛给用户。 */
  async function publicUser(row) {
    let name = "";
    if (row.display_name && row.display_name_iv) {
      try {
        const dek = await unwrapDek(row, `user:${row.id}`);
        name = fromUtf8(await aesGcmDecrypt(dek, row.display_name_iv, row.display_name, `display:${row.id}`));
      } catch (err) {
        name = "";
      }
    }
    return userShape(row, name);
  }

  /* --------------------------------------------------------------- 路由 */

  async function handle(request) {
    let url;
    try {
      url = new URL(request.url);
    } catch (err) {
      return errorResponse("invalid_request", "请求地址无法解析。", 400);
    }
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();
    const cors = corsHeaders(request);

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (path === "/api/health" && method === "GET") {
        return jsonResponse({ ok: true, version: API_VERSION, mode, time: iso(now()) }, 200, cors);
      }

      if (path === "/api/auth/register" && method === "POST") {
        if (!originAllowed(request, url)) return errorResponse("forbidden", "来源不被允许。", 403, cors);
        const parsed = await readJson(request);
        if (parsed.error) return parsed.error;
        return await register(request, url, parsed.value, cors);
      }

      if (path === "/api/auth/recovery" && method === "POST") {
        if (!originAllowed(request, url)) return errorResponse("forbidden", "来源不被允许。", 403, cors);
        const parsed = await readJson(request);
        if (parsed.error) return parsed.error;
        return await saveRecovery(request, url, parsed.value, cors);
      }

      if (path === "/api/auth/recovery/begin" && method === "POST") {
        if (!originAllowed(request, url)) return errorResponse("forbidden", "来源不被允许。", 403, cors);
        const parsed = await readJson(request);
        if (parsed.error) return parsed.error;
        return await recoveryBegin(request, url, parsed.value, cors);
      }

      if (path === "/api/auth/recovery/reset" && method === "POST") {
        if (!originAllowed(request, url)) return errorResponse("forbidden", "来源不被允许。", 403, cors);
        const parsed = await readJson(request);
        if (parsed.error) return parsed.error;
        return await recoveryReset(request, url, parsed.value, cors);
      }

      if (path === "/api/auth/login" && method === "POST") {
        if (!originAllowed(request, url)) return errorResponse("forbidden", "来源不被允许。", 403, cors);
        const parsed = await readJson(request);
        if (parsed.error) return parsed.error;
        return await login(request, url, parsed.value, cors);
      }

      if (path === "/api/auth/logout" && method === "POST") {
        if (!originAllowed(request, url)) return errorResponse("forbidden", "来源不被允许。", 403, cors);
        const session = await currentSession(request, url);
        if (session) {
          await store.deleteSession(session.tokenHash);
          await store.appendAudit(session.user.id, iso(now()), "logout", "");
        }
        return new Response(null, {
          status: 204,
          headers: Object.assign({ "set-cookie": clearCookie({ secure: cookieSecure(request, url) }) }, cors),
        });
      }

      if (path === "/api/auth/me" && method === "GET") {
        const session = await currentSession(request, url);
        if (!session) return errorResponse("unauthenticated", "尚未登录或会话已过期。", 401, cors);
        return jsonResponse(
          { user: await publicUser(session.user), kdf_salt: session.user.kdf_salt, recovery_configured: recoveryConfigured(session.user) },
          200,
          cors
        );
      }

      if (path === "/api/family/profile") {
        const session = await currentSession(request, url);
        if (!session) return errorResponse("unauthenticated", "尚未登录或会话已过期。", 401, cors);

        if (method === "GET") {
          const row = await store.getRecord(session.user.id);
          if (!row) return jsonResponse({ record: null }, 200, cors);
          const payload = await openPayload(session.user, row);
          return jsonResponse(
            {
              record: {
                payload,
                revision: row.revision,
                created_at: row.created_at,
                updated_at: row.updated_at,
              },
            },
            200,
            cors
          );
        }

        if (method === "PUT") {
          if (!originAllowed(request, url)) return errorResponse("forbidden", "来源不被允许。", 403, cors);
          const parsed = await readJson(request);
          if (parsed.error) return parsed.error;
          const body = parsed.value;
          const payload = body.payload;
          const expected = body.expected_revision;
          if (typeof payload !== "string" || !payload.length) {
            return errorResponse("invalid_request", "payload 必须是非空字符串。", 400, cors);
          }
          if (utf8Length(payload) > MAX_PAYLOAD_BYTES) {
            return errorResponse("payload_too_large", "家庭档案超过 1 MiB 上限。", 413, cors);
          }
          if (!Number.isInteger(expected) || expected < 0) {
            return errorResponse("invalid_request", "expected_revision 必须是非负整数。", 400, cors);
          }
          const sealed = await sealPayload(session.user, payload);
          const stamp = iso(now());
          try {
            const result = await store.putRecord({
              userId: session.user.id,
              payload: sealed.payload,
              payloadIv: sealed.payload_iv,
              payloadTag: sealed.payload_tag,
              expectedRevision: expected,
              now: stamp,
            });
            await store.appendAudit(session.user.id, stamp, "profile_saved", `revision=${result.revision}`);
            return jsonResponse({ revision: result.revision, updated_at: result.updated_at }, 200, cors);
          } catch (err) {
            if (err && err.code === "conflict") {
              return errorResponse("conflict", "云端已有更新的版本，请先重新载入。", 409, Object.assign({ current_revision: err.currentRevision }, cors));
            }
            throw err;
          }
        }

        if (method === "DELETE") {
          if (!originAllowed(request, url)) return errorResponse("forbidden", "来源不被允许。", 403, cors);
          const parsed = await readJson(request);
          if (parsed.error) return parsed.error;
          const expected = parsed.value.expected_revision;
          if (!Number.isInteger(expected) || expected < 0) {
            return errorResponse("invalid_request", "expected_revision 必须是非负整数。", 400, cors);
          }
          try {
            await store.deleteRecord(session.user.id, expected);
            await store.appendAudit(session.user.id, iso(now()), "profile_deleted", `revision=${expected}`);
            return new Response(null, { status: 204, headers: cors });
          } catch (err) {
            if (err && err.code === "conflict") {
              return errorResponse("conflict", "云端已有更新的版本，请先重新载入。", 409, Object.assign({ current_revision: err.currentRevision }, cors));
            }
            throw err;
          }
        }

        return errorResponse("invalid_request", "不支持的方法。", 405, cors);
      }

      if (path === "/api/family/audit" && method === "GET") {
        const session = await currentSession(request, url);
        if (!session) return errorResponse("unauthenticated", "尚未登录或会话已过期。", 401, cors);
        const raw = Number(url.searchParams.get("limit") || 50);
        const limit = Number.isFinite(raw) ? Math.max(1, Math.min(200, Math.floor(raw))) : 50;
        const entries = await store.listAudit(session.user.id, limit);
        return jsonResponse({ entries }, 200, cors);
      }

      return errorResponse("invalid_request", "没有这个接口。", 404, cors);
    } catch (err) {
      /* 失败关闭：不回堆栈、不回内部结构，只回机器码与中文提示。 */
      return errorResponse("internal_error", "服务端暂时无法完成这次请求，请稍后重试。", 500, cors);
    }
  }

  async function register(request, url, body, cors) {
    const email = String(body.email || "").trim();
    const password = String(body.password || "");
    const displayName = String(body.display_name || "").trim();
    if (!EMAIL_RE.test(email) || email.length > 200) {
      return errorResponse("invalid_request", "邮箱格式不正确。", 400, cors);
    }
    if (password.length < 10 || password.length > 256) {
      return errorResponse("invalid_request", "口令长度必须在 10 到 256 位之间。", 400, cors);
    }
    if (displayName.length > 80) {
      return errorResponse("invalid_request", "家庭称呼过长（上限 80 字）。", 400, cors);
    }
    const recovery = readRecoveryMaterial(body.recovery);
    if (recovery.error) return errorResponse("invalid_request", recovery.error, 400, cors);
    const emailNorm = email.toLowerCase();
    const existing = await store.findUserByEmailNorm(emailNorm);
    if (existing) return errorResponse("conflict", "这个邮箱已经注册过了，请直接登录。", 409, cors);

    const stamp = iso(now());
    const userId = `u_${randomToken(12)}`;
    const passwordSalt = b64(randomBytes(16));
    const passwordHash = b64(await pbkdf2(password, unb64(passwordSalt), passwordIterations));
    const kek = await deriveKek(masterKey);
    const dekRaw = randomBytes(32);
    const wrapped = await aesGcmEncrypt(kek, dekRaw, `user:${userId}`);
    const dek = await importAesKey(dekRaw);
    const sealedName = await aesGcmEncrypt(dek, utf8(displayName), `display:${userId}`);

    const row = {
      id: userId,
      email,
      email_norm: emailNorm,
      display_name: sealedName.ct,
      display_name_iv: sealedName.iv,
      password_hash: passwordHash,
      password_salt: passwordSalt,
      password_iter: passwordIterations,
      kdf_salt: b64(randomBytes(16)),
      dek_wrapped: wrapped.ct,
      dek_iv: wrapped.iv,
      dek_version: 1,
      created_at: stamp,
      updated_at: stamp,
    };
    await store.createUser(row);
    if (recovery.value) {
      await store.setRecovery(userId, recovery.value, stamp);
      await store.appendAudit(userId, stamp, "recovery_configured", "source=register");
    }
    await store.appendAudit(userId, stamp, "registered", "");

    const token = randomToken();
    const tokenHash = await sha256B64(token);
    const expiresAt = iso(new Date(now().getTime() + SESSION_TTL_MS));
    await store.createSession({ tokenHash, userId, createdAt: stamp, expiresAt, lastSeenAt: stamp });

    return jsonResponse(
      { user: await publicUser(row), kdf_salt: row.kdf_salt, recovery_configured: recoveryConfigured(Object.assign({}, row, recovery.value || {})) },
      201,
      Object.assign({ "set-cookie": sessionCookie(token, { secure: cookieSecure(request, url) }) }, cors)
    );
  }

  async function login(request, url, body, cors) {
    const email = String(body.email || "").trim();
    const password = String(body.password || "");
    if (!email || !password) {
      return errorResponse("invalid_request", "请填写邮箱与口令。", 400, cors);
    }
    const emailNorm = email.toLowerCase();
    const failure = await store.getLoginFailure(emailNorm);
    if (failure && failure.locked_until && new Date(failure.locked_until).getTime() > now().getTime()) {
      const retry = Math.max(1, Math.ceil((new Date(failure.locked_until).getTime() - now().getTime()) / 1000));
      return jsonResponse(
        { error: { code: "rate_limited", message: "登录失败次数过多，请稍后再试。" } },
        429,
        Object.assign({ "retry-after": String(retry) }, cors)
      );
    }

    const user = await store.findUserByEmailNorm(emailNorm);
    const iterations = user ? user.password_iter || PASSWORD_ITERATIONS : PASSWORD_ITERATIONS;
    const salt = user ? user.password_salt : b64(randomBytes(16));
    const candidate = b64(await pbkdf2(password, unb64(salt), iterations));
    const ok = Boolean(user) && timingSafeEqual(candidate, user.password_hash);

    if (!ok) {
      const bumped = await store.bumpLoginFailure(emailNorm, iso(now()), LOGIN_LOCK_MS, LOGIN_MAX_FAILURES);
      if (bumped && bumped.locked_until) {
        const retry = Math.max(1, Math.ceil((new Date(bumped.locked_until).getTime() - now().getTime()) / 1000));
        return jsonResponse(
          { error: { code: "rate_limited", message: "登录失败次数过多，请稍后再试。" } },
          429,
          Object.assign({ "retry-after": String(retry) }, cors)
        );
      }
      return errorResponse("unauthenticated", "邮箱或口令不正确。", 401, cors);
    }

    await store.resetLoginFailure(emailNorm);
    const stamp = iso(now());
    const token = randomToken();
    const tokenHash = await sha256B64(token);
    await store.createSession({
      tokenHash,
      userId: user.id,
      createdAt: stamp,
      expiresAt: iso(new Date(now().getTime() + SESSION_TTL_MS)),
      lastSeenAt: stamp,
    });
    await store.appendAudit(user.id, stamp, "login", "");
    return jsonResponse(
      { user: await publicUser(user), kdf_salt: user.kdf_salt, recovery_configured: recoveryConfigured(user) },
      200,
      Object.assign({ "set-cookie": sessionCookie(token, { secure: cookieSecure(request, url) }) }, cors)
    );
  }

  /* --------------------------------------------------------- r71 找回口令 */

  /* 限流键与登录共用同一张表，但用命名空间隔开：
     恢复码试错不能拖慢正常登录，也不能靠恢复接口绕过登录限流。 */
  function recoveryBucket(emailNorm) {
    return `${emailNorm}#recovery`;
  }

  async function recoveryLocked(bucket) {
    const failure = await store.getLoginFailure(bucket);
    if (failure && failure.locked_until && new Date(failure.locked_until).getTime() > now().getTime()) {
      const retry = Math.max(1, Math.ceil((new Date(failure.locked_until).getTime() - now().getTime()) / 1000));
      return jsonResponse(
        { error: { code: "rate_limited", message: "恢复码尝试次数过多，请稍后再试。" } },
        429,
        Object.assign({ "retry-after": String(retry) }, {})
      );
    }
    return null;
  }

  /* 恢复码只以摘要形式比对：即使数据库整库泄漏，也无法反推出可用的恢复码。 */
  async function verifyRecoveryCode(user, emailNorm, code) {
    const bucket = recoveryBucket(emailNorm);
    if (!user || !recoveryConfigured(user)) return { ok: false, response: null };
    const candidate = await sha256B64(code);
    const ok = timingSafeEqual(candidate, user.recovery_verifier || "");
    if (!ok) {
      await store.bumpLoginFailure(bucket, iso(now()), LOGIN_LOCK_MS, LOGIN_MAX_FAILURES);
      return { ok: false, response: null };
    }
    await store.resetLoginFailure(bucket);
    return { ok: true, response: null };
  }

  async function issueSession(user, request, url, stamp) {
    const token = randomToken();
    const tokenHash = await sha256B64(token);
    await store.createSession({
      tokenHash,
      userId: user.id,
      createdAt: stamp,
      expiresAt: iso(new Date(now().getTime() + SESSION_TTL_MS)),
      lastSeenAt: stamp,
    });
    return sessionCookie(token, { secure: cookieSecure(request, url) });
  }

  /* 已登录用户补发/更换恢复材料（老账号没有恢复码时走这里）。 */
  async function saveRecovery(request, url, body, cors) {
    const session = await currentSession(request, url);
    if (!session) return errorResponse("unauthenticated", "尚未登录或会话已过期。", 401, cors);
    const material = readRecoveryMaterial(body.recovery);
    if (material.error) return errorResponse("invalid_request", material.error, 400, cors);
    if (!material.value) return errorResponse("invalid_request", "缺少恢复材料。", 400, cors);
    const stamp = iso(now());
    await store.setRecovery(session.user.id, material.value, stamp);
    await store.appendAudit(session.user.id, stamp, "recovery_configured", "source=session");
    return jsonResponse({ ok: true, recovery_configured: true }, 200, cors);
  }

  /* 第一步：只验恢复码，验过才把「端侧密文」交回给同一个浏览器去解密。
     交付的内容里没有任何明文：档案正文仍是端侧密文，没有恢复码根本解不开。 */
  async function recoveryBegin(request, url, body, cors) {
    const email = String(body.email || "").trim();
    const code = String(body.recovery_code || "").replace(/\s+/g, "");
    if (!EMAIL_RE.test(email) || !RECOVERY_CODE_RE.test(code)) {
      return errorResponse("unauthenticated", "邮箱或恢复码不正确。", 401, cors);
    }
    const emailNorm = email.toLowerCase();
    const locked = await recoveryLocked(recoveryBucket(emailNorm));
    if (locked) return locked;

    const user = await store.findUserByEmailNorm(emailNorm);
    const verified = await verifyRecoveryCode(user, emailNorm, code);
    if (!verified.ok) return errorResponse("unauthenticated", "邮箱或恢复码不正确。", 401, cors);

    const row = await store.getRecord(user.id);
    const stamp = iso(now());
    await store.appendAudit(user.id, stamp, "recovery_verified", "");
    return jsonResponse(
      {
        recovery_salt: user.recovery_salt,
        recovery_wrap: user.recovery_wrap,
        recovery_iter: user.recovery_iter,
        record: row ? { payload: await openPayload(user, row), revision: row.revision } : null,
      },
      200,
      cors
    );
  }

  /* 第二步：设置新口令。顺序刻意写成「先落档案、再换口令」——
     档案写入出现版本冲突时直接 409 返回，口令保持原样，用户重来一次即可，
     不会出现「口令已经换了、档案还是旧密钥加密的」这种谁也解不开的中间态。 */
  async function recoveryReset(request, url, body, cors) {
    const email = String(body.email || "").trim();
    const code = String(body.recovery_code || "").replace(/\s+/g, "");
    const newPassword = String(body.new_password || "");
    const newKdfSalt = String(body.new_kdf_salt || "");
    const payload = body.payload;
    const expected = body.expected_revision;
    if (!EMAIL_RE.test(email) || !RECOVERY_CODE_RE.test(code)) {
      return errorResponse("unauthenticated", "邮箱或恢复码不正确。", 401, cors);
    }
    if (newPassword.length < 10 || newPassword.length > 256) {
      return errorResponse("invalid_request", "新口令长度必须在 10 到 256 位之间。", 400, cors);
    }
    if (!RECOVERY_SALT_RE.test(newKdfSalt)) {
      return errorResponse("invalid_request", "新的加密盐格式不正确。", 400, cors);
    }
    const material = readRecoveryMaterial(body.recovery);
    if (material.error) return errorResponse("invalid_request", material.error, 400, cors);
    if (!material.value) return errorResponse("invalid_request", "缺少更新后的恢复材料。", 400, cors);
    if (payload !== undefined) {
      if (typeof payload !== "string" || !payload.length) {
        return errorResponse("invalid_request", "payload 必须是非空字符串。", 400, cors);
      }
      if (utf8Length(payload) > MAX_PAYLOAD_BYTES) {
        return errorResponse("payload_too_large", "家庭档案超过 1 MiB 上限。", 413, cors);
      }
      if (!Number.isInteger(expected) || expected < 0) {
        return errorResponse("invalid_request", "expected_revision 必须是非负整数。", 400, cors);
      }
    }

    const emailNorm = email.toLowerCase();
    const locked = await recoveryLocked(recoveryBucket(emailNorm));
    if (locked) return locked;

    const user = await store.findUserByEmailNorm(emailNorm);
    const verified = await verifyRecoveryCode(user, emailNorm, code);
    if (!verified.ok) return errorResponse("unauthenticated", "邮箱或恢复码不正确。", 401, cors);

    const stamp = iso(now());
    if (payload !== undefined) {
      const sealed = await sealPayload(user, payload);
      try {
        await store.putRecord({
          userId: user.id,
          payload: sealed.payload,
          payloadIv: sealed.payload_iv,
          payloadTag: sealed.payload_tag,
          expectedRevision: expected,
          now: stamp,
        });
      } catch (err) {
        if (err && err.code === "conflict") {
          return errorResponse(
            "conflict",
            "云端已有更新的版本，请重新开始找回流程后再试。",
            409,
            Object.assign({ current_revision: err.currentRevision }, cors)
          );
        }
        throw err;
      }
    }

    const passwordSalt = b64(randomBytes(16));
    const passwordHash = b64(await pbkdf2(newPassword, unb64(passwordSalt), passwordIterations));
    const next = Object.assign({}, material.value, {
      password_hash: passwordHash,
      password_salt: passwordSalt,
      password_iter: passwordIterations,
      kdf_salt: newKdfSalt,
    });
    await store.updatePassword(user.id, next, stamp);
    /* 口令重置是「账号可能已被他人占用」的信号：把其余会话全部吊销，
       只保留本次重置刚刚签发的这一个。 */
    await store.deleteSessionsForUser(user.id);
    await store.appendAudit(user.id, stamp, "password_reset", `revision=${expected === undefined ? "unchanged" : expected + 1}`);

    const fresh = Object.assign({}, user, next);
    const cookie = await issueSession(fresh, request, url, stamp);
    return jsonResponse(
      { user: await publicUser(fresh), kdf_salt: fresh.kdf_salt, recovery_configured: true },
      200,
      Object.assign({ "set-cookie": cookie }, cors)
    );
  }

  return { handle };
}
