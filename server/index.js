// platform/api/crypto.mjs
var encoder = new TextEncoder();
var decoder = new TextDecoder();
var PASSWORD_ITERATIONS = 21e4;
var SESSION_BYTES = 32;
function b64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < view.length; i += 1) out += String.fromCharCode(view[i]);
  return btoa(out);
}
function unb64(text) {
  const raw = atob(String(text || ""));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}
function randomBytes(n) {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}
function randomToken(n = SESSION_BYTES) {
  return b64(randomBytes(n)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function timingSafeEqual(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}
async function pbkdf2(password, saltBytes, iterations = PASSWORD_ITERATIONS) {
  const base = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    base,
    256
  );
  return new Uint8Array(bits);
}
async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(text)));
  return new Uint8Array(digest);
}
async function sha256B64(text) {
  return b64(await sha256(text));
}
async function deriveKek(masterKeyB64, info = "verity-family-cfo/kek/v1") {
  const raw = unb64(masterKeyB64);
  if (raw.length !== 32) throw new Error("VERITY_MASTER_KEY \u5FC5\u987B\u662F 32 \u5B57\u8282 base64");
  const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode("verity-family-cfo/salt/v1"), info: encoder.encode(info) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
async function aesGcmEncrypt(key, plaintextBytes, aad) {
  const iv = randomBytes(12);
  const params = { name: "AES-GCM", iv };
  if (aad) params.additionalData = encoder.encode(aad);
  const ct = await crypto.subtle.encrypt(params, key, plaintextBytes);
  return { iv: b64(iv), ct: b64(ct) };
}
async function aesGcmDecrypt(key, ivB64, ctB64, aad) {
  const params = { name: "AES-GCM", iv: unb64(ivB64) };
  if (aad) params.additionalData = encoder.encode(aad);
  const plain = await crypto.subtle.decrypt(params, key, unb64(ctB64));
  return new Uint8Array(plain);
}
async function importAesKey(rawBytes) {
  return crypto.subtle.importKey("raw", rawBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
function utf8(text) {
  return encoder.encode(String(text));
}
function fromUtf8(bytes) {
  return decoder.decode(bytes);
}

// platform/api/core.mjs
var API_VERSION = "e0.26.0";
var SESSION_COOKIE = "verity_sess";
var MAX_PAYLOAD_BYTES = 1024 * 1024;
var SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
var LOGIN_MAX_FAILURES = 5;
var LOGIN_LOCK_MS = 15 * 60 * 1e3;
var MAX_JSON_BYTES = 2 * 1024 * 1024;
var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function utf8Length(text) {
  return utf8(text).length;
}
function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign(
      {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer"
      },
      headers
    )
  });
}
function errorResponse(code, message, status, extra = {}) {
  return jsonResponse(Object.assign({ error: { code, message } }, extra), status);
}
function parseCookies(header) {
  const out = {};
  String(header || "").split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx < 0) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  });
  return out;
}
function sessionCookie(token, { secure = true, maxAgeSeconds = SESSION_TTL_MS / 1e3 } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeSeconds)}`
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
function clearCookie({ secure = true } = {}) {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
function iso(date) {
  return date.toISOString();
}
function userShape(row, displayName) {
  return {
    id: row.id,
    email: row.email,
    display_name: displayName || "",
    created_at: row.created_at
  };
}
function createApi(options) {
  const store = options.store;
  const masterKey = options.masterKey;
  const mode = options.mode || "production";
  const now = options.now || (() => /* @__PURE__ */ new Date());
  const allowedOrigins = (options.allowedOrigins || []).filter(Boolean);
  const trustProxySecure = options.localInsecureCookie === true;
  if (!store) throw new Error("createApi \u9700\u8981\u6CE8\u5165 store");
  if (!masterKey) throw new Error("createApi \u9700\u8981 VERITY_MASTER_KEY");
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
      vary: "Origin"
    };
  }
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
      return { error: errorResponse("payload_too_large", "\u8BF7\u6C42\u4F53\u8D85\u8FC7 2 MiB \u4E0A\u9650\u3002", 413) };
    }
    let text;
    try {
      text = await request.text();
    } catch (err) {
      return { error: errorResponse("invalid_request", "\u65E0\u6CD5\u8BFB\u53D6\u8BF7\u6C42\u4F53\u3002", 400) };
    }
    if (utf8Length(text) > MAX_JSON_BYTES) {
      return { error: errorResponse("payload_too_large", "\u8BF7\u6C42\u4F53\u8D85\u8FC7 2 MiB \u4E0A\u9650\u3002", 413) };
    }
    try {
      const parsed = text ? JSON.parse(text) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      return { value: parsed };
    } catch (err) {
      return { error: errorResponse("invalid_request", "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5\u7684 JSON \u5BF9\u8C61\u3002", 400) };
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
  async function handle(request) {
    let url;
    try {
      url = new URL(request.url);
    } catch (err) {
      return errorResponse("invalid_request", "\u8BF7\u6C42\u5730\u5740\u65E0\u6CD5\u89E3\u6790\u3002", 400);
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
        if (!originAllowed(request, url)) return errorResponse("forbidden", "\u6765\u6E90\u4E0D\u88AB\u5141\u8BB8\u3002", 403, cors);
        const parsed = await readJson(request);
        if (parsed.error) return parsed.error;
        return await register(request, url, parsed.value, cors);
      }
      if (path === "/api/auth/login" && method === "POST") {
        if (!originAllowed(request, url)) return errorResponse("forbidden", "\u6765\u6E90\u4E0D\u88AB\u5141\u8BB8\u3002", 403, cors);
        const parsed = await readJson(request);
        if (parsed.error) return parsed.error;
        return await login(request, url, parsed.value, cors);
      }
      if (path === "/api/auth/logout" && method === "POST") {
        if (!originAllowed(request, url)) return errorResponse("forbidden", "\u6765\u6E90\u4E0D\u88AB\u5141\u8BB8\u3002", 403, cors);
        const session = await currentSession(request, url);
        if (session) {
          await store.deleteSession(session.tokenHash);
          await store.appendAudit(session.user.id, iso(now()), "logout", "");
        }
        return new Response(null, {
          status: 204,
          headers: Object.assign({ "set-cookie": clearCookie({ secure: cookieSecure(request, url) }) }, cors)
        });
      }
      if (path === "/api/auth/me" && method === "GET") {
        const session = await currentSession(request, url);
        if (!session) return errorResponse("unauthenticated", "\u5C1A\u672A\u767B\u5F55\u6216\u4F1A\u8BDD\u5DF2\u8FC7\u671F\u3002", 401, cors);
        return jsonResponse({ user: await publicUser(session.user), kdf_salt: session.user.kdf_salt }, 200, cors);
      }
      if (path === "/api/family/profile") {
        const session = await currentSession(request, url);
        if (!session) return errorResponse("unauthenticated", "\u5C1A\u672A\u767B\u5F55\u6216\u4F1A\u8BDD\u5DF2\u8FC7\u671F\u3002", 401, cors);
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
                updated_at: row.updated_at
              }
            },
            200,
            cors
          );
        }
        if (method === "PUT") {
          if (!originAllowed(request, url)) return errorResponse("forbidden", "\u6765\u6E90\u4E0D\u88AB\u5141\u8BB8\u3002", 403, cors);
          const parsed = await readJson(request);
          if (parsed.error) return parsed.error;
          const body = parsed.value;
          const payload = body.payload;
          const expected = body.expected_revision;
          if (typeof payload !== "string" || !payload.length) {
            return errorResponse("invalid_request", "payload \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32\u3002", 400, cors);
          }
          if (utf8Length(payload) > MAX_PAYLOAD_BYTES) {
            return errorResponse("payload_too_large", "\u5BB6\u5EAD\u6863\u6848\u8D85\u8FC7 1 MiB \u4E0A\u9650\u3002", 413, cors);
          }
          if (!Number.isInteger(expected) || expected < 0) {
            return errorResponse("invalid_request", "expected_revision \u5FC5\u987B\u662F\u975E\u8D1F\u6574\u6570\u3002", 400, cors);
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
              now: stamp
            });
            await store.appendAudit(session.user.id, stamp, "profile_saved", `revision=${result.revision}`);
            return jsonResponse({ revision: result.revision, updated_at: result.updated_at }, 200, cors);
          } catch (err) {
            if (err && err.code === "conflict") {
              return errorResponse("conflict", "\u4E91\u7AEF\u5DF2\u6709\u66F4\u65B0\u7684\u7248\u672C\uFF0C\u8BF7\u5148\u91CD\u65B0\u8F7D\u5165\u3002", 409, Object.assign({ current_revision: err.currentRevision }, cors));
            }
            throw err;
          }
        }
        if (method === "DELETE") {
          if (!originAllowed(request, url)) return errorResponse("forbidden", "\u6765\u6E90\u4E0D\u88AB\u5141\u8BB8\u3002", 403, cors);
          await store.deleteRecord(session.user.id);
          await store.appendAudit(session.user.id, iso(now()), "profile_deleted", "");
          return new Response(null, { status: 204, headers: cors });
        }
        return errorResponse("invalid_request", "\u4E0D\u652F\u6301\u7684\u65B9\u6CD5\u3002", 405, cors);
      }
      if (path === "/api/family/audit" && method === "GET") {
        const session = await currentSession(request, url);
        if (!session) return errorResponse("unauthenticated", "\u5C1A\u672A\u767B\u5F55\u6216\u4F1A\u8BDD\u5DF2\u8FC7\u671F\u3002", 401, cors);
        const raw = Number(url.searchParams.get("limit") || 50);
        const limit = Number.isFinite(raw) ? Math.max(1, Math.min(200, Math.floor(raw))) : 50;
        const entries = await store.listAudit(session.user.id, limit);
        return jsonResponse({ entries }, 200, cors);
      }
      return errorResponse("invalid_request", "\u6CA1\u6709\u8FD9\u4E2A\u63A5\u53E3\u3002", 404, cors);
    } catch (err) {
      return errorResponse("internal_error", "\u670D\u52A1\u7AEF\u6682\u65F6\u65E0\u6CD5\u5B8C\u6210\u8FD9\u6B21\u8BF7\u6C42\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002", 500, cors);
    }
  }
  async function register(request, url, body, cors) {
    const email = String(body.email || "").trim();
    const password = String(body.password || "");
    const displayName = String(body.display_name || "").trim();
    if (!EMAIL_RE.test(email) || email.length > 200) {
      return errorResponse("invalid_request", "\u90AE\u7BB1\u683C\u5F0F\u4E0D\u6B63\u786E\u3002", 400, cors);
    }
    if (password.length < 10 || password.length > 256) {
      return errorResponse("invalid_request", "\u53E3\u4EE4\u957F\u5EA6\u5FC5\u987B\u5728 10 \u5230 256 \u4F4D\u4E4B\u95F4\u3002", 400, cors);
    }
    if (displayName.length > 80) {
      return errorResponse("invalid_request", "\u5BB6\u5EAD\u79F0\u547C\u8FC7\u957F\uFF08\u4E0A\u9650 80 \u5B57\uFF09\u3002", 400, cors);
    }
    const emailNorm = email.toLowerCase();
    const existing = await store.findUserByEmailNorm(emailNorm);
    if (existing) return errorResponse("conflict", "\u8FD9\u4E2A\u90AE\u7BB1\u5DF2\u7ECF\u6CE8\u518C\u8FC7\u4E86\uFF0C\u8BF7\u76F4\u63A5\u767B\u5F55\u3002", 409, cors);
    const stamp = iso(now());
    const userId = `u_${randomToken(12)}`;
    const passwordSalt = b64(randomBytes(16));
    const passwordHash = b64(await pbkdf2(password, unb64(passwordSalt), PASSWORD_ITERATIONS));
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
      password_iter: PASSWORD_ITERATIONS,
      kdf_salt: b64(randomBytes(16)),
      dek_wrapped: wrapped.ct,
      dek_iv: wrapped.iv,
      dek_version: 1,
      created_at: stamp,
      updated_at: stamp
    };
    await store.createUser(row);
    await store.appendAudit(userId, stamp, "registered", "");
    const token = randomToken();
    const tokenHash = await sha256B64(token);
    const expiresAt = iso(new Date(now().getTime() + SESSION_TTL_MS));
    await store.createSession({ tokenHash, userId, createdAt: stamp, expiresAt, lastSeenAt: stamp });
    return jsonResponse(
      { user: await publicUser(row), kdf_salt: row.kdf_salt },
      201,
      Object.assign({ "set-cookie": sessionCookie(token, { secure: cookieSecure(request, url) }) }, cors)
    );
  }
  async function login(request, url, body, cors) {
    const email = String(body.email || "").trim();
    const password = String(body.password || "");
    if (!email || !password) {
      return errorResponse("invalid_request", "\u8BF7\u586B\u5199\u90AE\u7BB1\u4E0E\u53E3\u4EE4\u3002", 400, cors);
    }
    const emailNorm = email.toLowerCase();
    const failure = await store.getLoginFailure(emailNorm);
    if (failure && failure.locked_until && new Date(failure.locked_until).getTime() > now().getTime()) {
      const retry = Math.max(1, Math.ceil((new Date(failure.locked_until).getTime() - now().getTime()) / 1e3));
      return jsonResponse(
        { error: { code: "rate_limited", message: "\u767B\u5F55\u5931\u8D25\u6B21\u6570\u8FC7\u591A\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002" } },
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
        const retry = Math.max(1, Math.ceil((new Date(bumped.locked_until).getTime() - now().getTime()) / 1e3));
        return jsonResponse(
          { error: { code: "rate_limited", message: "\u767B\u5F55\u5931\u8D25\u6B21\u6570\u8FC7\u591A\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002" } },
          429,
          Object.assign({ "retry-after": String(retry) }, cors)
        );
      }
      return errorResponse("unauthenticated", "\u90AE\u7BB1\u6216\u53E3\u4EE4\u4E0D\u6B63\u786E\u3002", 401, cors);
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
      lastSeenAt: stamp
    });
    await store.appendAudit(user.id, stamp, "login", "");
    return jsonResponse(
      { user: await publicUser(user), kdf_salt: user.kdf_salt },
      200,
      Object.assign({ "set-cookie": sessionCookie(token, { secure: cookieSecure(request, url) }) }, cors)
    );
  }
  return { handle };
}

// platform/api/router.mjs
function isApiRequest(request) {
  try {
    return new URL(request.url).pathname.startsWith("/api/");
  } catch (err) {
    return false;
  }
}
function createRouter(api, options = {}) {
  const onUnhandled = options.onUnhandled || null;
  return async function handle(request) {
    const method = request.method.toUpperCase();
    if (!isApiRequest(request)) {
      if (onUnhandled) return onUnhandled(request);
      return errorResponse("invalid_request", "\u6CA1\u6709\u8FD9\u4E2A\u63A5\u53E3\u3002", 404);
    }
    if (method === "HEAD") {
      const probe = new Request(request.url, { method: "GET", headers: request.headers });
      const res = await api.handle(probe).catch(
        () => errorResponse("internal_error", "\u670D\u52A1\u7AEF\u6682\u65F6\u65E0\u6CD5\u5B8C\u6210\u8FD9\u6B21\u8BF7\u6C42\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002", 500)
      );
      return new Response(null, { status: res.status, headers: res.headers });
    }
    return api.handle(request).catch(
      () => errorResponse("internal_error", "\u670D\u52A1\u7AEF\u6682\u65F6\u65E0\u6CD5\u5B8C\u6210\u8FD9\u6B21\u8BF7\u6C42\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002", 500)
    );
  };
}

// platform/adapters/cf-worker/store.mjs
var D1Store = class {
  constructor(db) {
    this.db = db;
  }
  static _row(result) {
    return result && result.results && result.results[0] || null;
  }
  async findUserByEmailNorm(emailNorm) {
    return await this.db.prepare("SELECT * FROM users WHERE email_norm = ?").bind(emailNorm).first() || null;
  }
  async getUserById(id) {
    return await this.db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first() || null;
  }
  async createUser(row) {
    await this.db.prepare(
      `INSERT INTO users (id, email, email_norm, display_name, display_name_iv, password_hash, password_salt, password_iter,
                            kdf_salt, dek_wrapped, dek_iv, dek_version, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      row.id,
      row.email,
      row.email_norm,
      row.display_name,
      row.display_name_iv,
      row.password_hash,
      row.password_salt,
      row.password_iter,
      row.kdf_salt,
      row.dek_wrapped,
      row.dek_iv,
      row.dek_version,
      row.created_at,
      row.updated_at
    ).run();
  }
  async createSession(row) {
    await this.db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?,?,?,?,?)").bind(row.tokenHash, row.userId, row.createdAt, row.expiresAt, row.lastSeenAt).run();
  }
  async getSession(tokenHash) {
    return await this.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").bind(tokenHash).first() || null;
  }
  async touchSession(tokenHash, at) {
    await this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").bind(at, tokenHash).run();
  }
  async deleteSession(tokenHash) {
    await this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
  }
  async getRecord(userId) {
    return await this.db.prepare("SELECT * FROM household_records WHERE user_id = ?").bind(userId).first() || null;
  }
  async putRecord(input) {
    const { userId, payload, payloadIv, expectedRevision, now } = input;
    const conflict = async () => {
      const existing = await this.db.prepare("SELECT revision FROM household_records WHERE user_id = ?").bind(userId).first();
      const err = new Error("conflict");
      err.code = "conflict";
      err.currentRevision = existing ? existing.revision : 0;
      return err;
    };
    if (expectedRevision === 0) {
      const res2 = await this.db.prepare(
        `INSERT INTO household_records (user_id, payload, payload_iv, payload_tag, revision, created_at, updated_at)
           SELECT ?, ?, ?, ?, 1, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM household_records WHERE user_id = ?)`
      ).bind(userId, payload, payloadIv, "", now, now, userId).run();
      if (res2 && res2.meta && res2.meta.changes > 0) return { revision: 1, updated_at: now };
      throw await conflict();
    }
    const res = await this.db.prepare(
      `UPDATE household_records
            SET payload = ?, payload_iv = ?, revision = ?, updated_at = ?
          WHERE user_id = ? AND revision = ?`
    ).bind(payload, payloadIv, expectedRevision + 1, now, userId, expectedRevision).run();
    if (res && res.meta && res.meta.changes > 0) {
      return { revision: expectedRevision + 1, updated_at: now };
    }
    throw await conflict();
  }
  async deleteRecord(userId) {
    await this.db.prepare("DELETE FROM household_records WHERE user_id = ?").bind(userId).run();
  }
  async appendAudit(userId, at, action, detail) {
    await this.db.prepare("INSERT INTO audit_log (user_id, at, action, detail) VALUES (?,?,?,?)").bind(userId, at, action, detail).run();
  }
  async listAudit(userId, limit) {
    const res = await this.db.prepare("SELECT at, action, detail FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT ?").bind(userId, limit).all();
    return res && res.results || [];
  }
  async getLoginFailure(emailNorm) {
    return await this.db.prepare("SELECT * FROM login_failures WHERE email_norm = ?").bind(emailNorm).first() || null;
  }
  async bumpLoginFailure(emailNorm, at, lockMs, maxFailures) {
    const nowMs = Date.parse(at);
    const row = await this.getLoginFailure(emailNorm);
    let count = 1;
    let firstFail = at;
    if (row && nowMs - Date.parse(row.first_fail_at) <= lockMs) {
      count = row.fail_count + 1;
      firstFail = row.first_fail_at;
    }
    const lockedUntil = count >= maxFailures ? new Date(nowMs + lockMs).toISOString() : null;
    await this.db.prepare(
      `INSERT INTO login_failures (email_norm, fail_count, first_fail_at, last_fail_at, locked_until)
         VALUES (?,?,?,?,?)
         ON CONFLICT(email_norm) DO UPDATE SET fail_count = excluded.fail_count,
           first_fail_at = excluded.first_fail_at, last_fail_at = excluded.last_fail_at,
           locked_until = excluded.locked_until`
    ).bind(emailNorm, count, firstFail, at, lockedUntil).run();
    return { fail_count: count, locked_until: lockedUntil };
  }
  async resetLoginFailure(emailNorm) {
    await this.db.prepare("DELETE FROM login_failures WHERE email_norm = ?").bind(emailNorm).run();
  }
};

// platform/adapters/cf-worker/worker.mjs
var SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY"
};
function isApiPath(pathname) {
  return pathname === "/healthz" || pathname.startsWith("/api/");
}
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (isApiPath(url.pathname)) {
      if (!env.DB) {
        return new Response(
          JSON.stringify({ error: { code: "internal_error", message: "\u670D\u52A1\u7AEF\u672A\u7ED1\u5B9A\u5173\u7CFB\u5E93\uFF08D1\uFF09\u3002" } }),
          { status: 500, headers: { "content-type": "application/json; charset=utf-8" } }
        );
      }
      if (!env.VERITY_MASTER_KEY) {
        return new Response(
          JSON.stringify({ error: { code: "internal_error", message: "\u670D\u52A1\u7AEF\u7F3A\u5C11\u4E3B\u5BC6\u94A5\u914D\u7F6E\u3002" } }),
          { status: 500, headers: { "content-type": "application/json; charset=utf-8" } }
        );
      }
      const api = createApi({
        store: new D1Store(env.DB),
        masterKey: String(env.VERITY_MASTER_KEY).trim(),
        mode: "production",
        /* 同源部署：默认不放行任何跨源来源，写请求的 Origin 校验按同源判定。 */
        allowedOrigins: []
      });
      const router = createRouter(api, { onUnhandled: () => notFound() });
      const response = await router(request);
      return withHeaders(response, SECURITY_HEADERS);
    }
    if (!env.ASSETS) return notFound();
    const asset = await env.ASSETS.fetch(request);
    if (asset.status === 404) {
      const fallback = await directoryIndex(url, env);
      if (fallback) return withHeaders(fallback, SECURITY_HEADERS);
    }
    return withHeaders(asset, SECURITY_HEADERS);
  }
};
async function directoryIndex(url, env) {
  const path = url.pathname.replace(/\/+$/, "");
  if (!path) return null;
  const probe = new Request(new URL(`${path}/index.html`, url.origin).toString(), {
    method: "GET",
    headers: url.search ? void 0 : void 0
  });
  const res = await env.ASSETS.fetch(probe);
  if (res.status !== 200) return null;
  const headers = new Headers(res.headers);
  headers.set("content-type", headers.get("content-type") || "text/html; charset=utf-8");
  return new Response(res.body, { status: 200, headers });
}
function withHeaders(response, extra) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function notFound() {
  return new Response("404 Not Found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS }
  });
}
export {
  worker_default as default
};
