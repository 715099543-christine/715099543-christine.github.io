/* Verity AI家庭CFO · /family/ 账号与云端档案通道（Round 40）
 *
 * 这一层只做四件事，别的一概不做：
 *   1. 真实账号：/api/auth/register|login|logout|me（HttpOnly 会话 Cookie，同源）。
 *   2. 真实后台数据库：家庭档案读写 /api/family/profile，服务端按 user_id 做归属隔离，
 *      并以「主密钥 → 每用户 DEK → 正文」的信封加密落库。
 *   3. 端侧加密：口令派生密钥（PBKDF2-HMAC-SHA256 / 210000 次 / 每账号独立盐）在浏览器里
 *      把档案加密成 v1.<iv>.<ct> 信封后才出网。**服务端拿不到口令，因此拿不到明文。**
 *   4. 对既有控制台（web/zh.js）零侵入：代理 localStorage 里的两个档案键，
 *      读走服务端、写回服务端。zh.js 的 4500 行业务逻辑一行都不改。
 *
 * 失败关闭：拿不到服务端数据时绝不回退到「本机演示档案」，宁可显示空库与错误提示。
 */
(function () {
  "use strict";

  var API_BASE = String(window.__VERITY_API_BASE__ || "").replace(/\/+$/, "");
  var PROFILE_KEY = "verity.zh.profiles.v1";
  var ACCOUNT_KEY = "verity.zh.account.v1";
  var DEVICE_KEY = "verity.zh.device.v1";
  var MIRROR_KEY = "verity.zh.secure.v1";
  var PBKDF2_ITERATIONS = 210000;
  /* r71 · 找回口令。恢复码与口令彼此独立：口令负责日常登录与解密，恢复码只在忘记口令时
     把「口令派生密钥」解出来，然后再用新口令重新包一次。恢复码本身从不发给服务端。 */
  var RECOVERY_ITERATIONS = 210000;
  var RECOVERY_LENGTH = 20;
  var RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  var PUSH_DEBOUNCE_MS = 700;

  var state = {
    user: null,
    kdfSalt: "",
    key: null,
    revision: 0,
    cachedText: null,
    cachedAccount: null,
    ready: false,
    syncing: false,
    lastError: "",
    lastSyncedAt: "",
    queue: null,
    timer: null,
    retryMs: 1000,
    pendingVersion: 0,
    listeners: [],
    mode: "cloud",
    /* 注册后一次性展示的恢复码；用户确认抄写后清空，不留存在任何存储里。 */
    recoveryCode: "",
    recoveryConfigured: false,
  };

  /* ---------------------------------------------------------------- 基础工具 */

  function bytesToB64(bytes) {
    var view = new Uint8Array(bytes);
    var out = "";
    for (var i = 0; i < view.length; i += 1) out += String.fromCharCode(view[i]);
    return window.btoa(out);
  }

  function b64ToBytes(text) {
    var raw = window.atob(text);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  }

  function randomBytes(n) {
    var out = new Uint8Array(n);
    window.crypto.getRandomValues(out);
    return out;
  }

  function subtle() {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error("当前浏览器不支持 WebCrypto，无法加密家庭档案（请使用较新的 Chrome / Safari / Edge）。");
    }
    return window.crypto.subtle;
  }

  function nowStamp() {
    return new Date().toISOString().replace("T", " ").slice(0, 16);
  }

  /* 口令 → 端侧内容密钥。盐由服务端在注册时生成并随登录返回（盐不是秘密）。 */
  function deriveContentKey(password, saltB64) {
    var enc = new TextEncoder();
    return subtle()
      .importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"])
      .then(function (base) {
        return subtle().deriveKey(
          { name: "PBKDF2", salt: b64ToBytes(saltB64), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
          base,
          { name: "AES-GCM", length: 256 },
          true,
          ["encrypt", "decrypt"]
        );
      });
  }

  function encryptText(key, text) {
    var iv = randomBytes(12);
    var enc = new TextEncoder();
    return subtle().encrypt({ name: "AES-GCM", iv: iv }, key, enc.encode(text)).then(function (ct) {
      return "v1." + bytesToB64(iv) + "." + bytesToB64(ct);
    });
  }

  function decryptText(key, envelope) {
    var parts = String(envelope || "").split(".");
    if (parts.length !== 3 || parts[0] !== "v1") {
      return Promise.reject(new Error("云端档案信封格式无法识别，可能是更早版本写入的数据。"));
    }
    var dec = new TextDecoder();
    return subtle()
      .decrypt({ name: "AES-GCM", iv: b64ToBytes(parts[1]) }, key, b64ToBytes(parts[2]))
      .then(function (plain) {
        return dec.decode(plain);
      })
      .catch(function () {
        throw new Error("用当前口令解不开云端档案（口令已变更时会这样）。请确认口令，或选择重置云端档案。");
      });
  }

  /* 恢复码：20 位、100 bit 熵，去掉 0/O/1/I 等易混字符；展示时按 5 位分组便于抄写。 */
  function generateRecoveryCode() {
    var bytes = randomBytes(RECOVERY_LENGTH);
    var out = "";
    for (var i = 0; i < RECOVERY_LENGTH; i += 1) {
      out += RECOVERY_ALPHABET.charAt(bytes[i] % RECOVERY_ALPHABET.length);
    }
    return out;
  }

  function formatRecoveryCode(code) {
    return normalizeRecoveryCode(code).replace(/(.{5})(?=.)/g, "$1-");
  }

  /* 用户抄下的是带连字符的版本，输入时可能大小写/空格/连字符不一，统一归一化后再派生。 */
  function normalizeRecoveryCode(code) {
    return String(code || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  }

  function sha256B64(text) {
    return subtle()
      .digest("SHA-256", new TextEncoder().encode(text))
      .then(function (buf) {
        return bytesToB64(new Uint8Array(buf));
      });
  }

  function deriveRecoveryKey(code, saltB64, iterations) {
    var enc = new TextEncoder();
    return subtle()
      .importKey("raw", enc.encode(code), { name: "PBKDF2" }, false, ["deriveKey"])
      .then(function (base) {
        return subtle().deriveKey(
          { name: "PBKDF2", salt: b64ToBytes(saltB64), iterations: iterations || RECOVERY_ITERATIONS, hash: "SHA-256" },
          base,
          { name: "AES-GCM", length: 256 },
          true,
          ["encrypt", "decrypt"]
        );
      });
  }

  /* 恢复材料：salt/wrap/verifier 三者都是端侧算出来的，服务端只是保管。
     wrap 里装的是「当前口令派生出的内容密钥」的原始字节，只有拿着恢复码才解得开。 */
  function buildRecoveryMaterial(rawKeyB64, code) {
    var normalized = normalizeRecoveryCode(code);
    var salt = bytesToB64(randomBytes(16));
    return deriveRecoveryKey(normalized, salt, RECOVERY_ITERATIONS)
      .then(function (recoveryKey) {
        return encryptText(recoveryKey, rawKeyB64).then(function (wrap) {
          return sha256B64(normalized).then(function (verifier) {
            return { salt: salt, wrap: wrap, verifier: verifier, iter: RECOVERY_ITERATIONS };
          });
        });
      });
  }

  function recoveryMaterialFromActiveKey(code) {
    if (!state.key) return Promise.reject(new Error("尚未解锁云端档案，无法生成恢复码。"));
    return exportRawKey(state.key).then(function (raw) {
      return buildRecoveryMaterial(raw, code);
    });
  }

  function exportRawKey(key) {
    return subtle().exportKey("raw", key).then(bytesToB64);
  }

  function importRawKey(rawB64) {
    return subtle().importKey("raw", b64ToBytes(rawB64), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
  }

  /* ------------------------------------------------------------------ 网络层 */

  function api(path, options) {
    var opts = options || {};
    var init = {
      method: opts.method || "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
    };
    if (opts.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    return window
      .fetch(API_BASE + path, init)
      .catch(function () {
        throw Object.assign(new Error("无法连接 Verity 云端服务（网络不可用或服务未启动）。"), { code: "offline" });
      })
      .then(function (res) {
        if (res.status === 204) return null;
        return res
          .json()
          .catch(function () {
            return null;
          })
          .then(function (data) {
            if (res.ok) return data;
            var err = (data && data.error) || {};
            throw Object.assign(new Error(err.message || "请求失败（HTTP " + res.status + "）。"), {
              code: err.code || "http_" + res.status,
              status: res.status,
              data: data,
            });
          });
      });
  }

  /* ------------------------------------------------ 通知订阅（给 UI 层用） */

  function subscribe(fn) {
    state.listeners.push(fn);
    fn(snapshot());
    return function () {
      state.listeners = state.listeners.filter(function (one) {
        return one !== fn;
      });
    };
  }

  function snapshot() {
    return {
      ready: state.ready,
      user: state.user,
      syncing: state.syncing,
      lastError: state.lastError,
      lastSyncedAt: state.lastSyncedAt,
      revision: state.revision,
      unlocked: Boolean(state.key),
      mode: state.mode,
      recovery_code: state.recoveryCode,
      recovery_configured: state.recoveryConfigured,
    };
  }

  function emit() {
    var snap = snapshot();
    state.listeners.forEach(function (fn) {
      try {
        fn(snap);
      } catch (ignored) {
        /* UI 层自己的异常不得影响同步 */
      }
    });
  }

  /* ------------------------------------------------ localStorage 代理（零侵入）

     只接管家庭档案库与账户元数据键。两者都只作为当前会话缓存与加密待同步草稿，
     永久权威副本仍在云端。其余键一律交还原生实现。
     触发方式用 Storage.prototype 覆盖而不是重定义 window.localStorage，
     这样无论 zh.js 通过 window.localStorage 还是直接 Storage.prototype 访问都生效。 */
  var nativeGet = window.Storage.prototype.getItem;
  var nativeSet = window.Storage.prototype.setItem;
  var nativeRemove = window.Storage.prototype.removeItem;

  function isManaged(key) {
    return (
      key === PROFILE_KEY ||
      key === ACCOUNT_KEY ||
      key === MIRROR_KEY ||
      key === DEVICE_KEY
    );
  }

  function installStorageProxy() {
    window.Storage.prototype.getItem = function (key) {
      if (key === PROFILE_KEY) return state.cachedText;
      if (key === ACCOUNT_KEY) return state.cachedAccount;
      if (key === MIRROR_KEY || key === DEVICE_KEY) return nativeGet.call(this, key);
      return nativeGet.call(this, key);
    };
    window.Storage.prototype.setItem = function (key, value) {
      if (key === PROFILE_KEY) {
        state.cachedText = String(value);
        writeMirror();
        schedulePush();
        return;
      }
      if (key === ACCOUNT_KEY) {
        state.cachedAccount = String(value);
        writeMirror();
        schedulePush();
        return;
      }
      if (isManaged(key) && key !== MIRROR_KEY && key !== DEVICE_KEY) return;
      try {
        nativeSet.call(this, key, value);
      } catch (ignored) {
        /* 配额或隐私模式：非托管键写不进去不影响云端通道 */
      }
    };
    window.Storage.prototype.removeItem = function (key) {
      if (key === PROFILE_KEY) {
        state.cachedText = null;
        writeMirror();
        schedulePush(true);
        return;
      }
      if (key === ACCOUNT_KEY) {
        state.cachedAccount = null;
        writeMirror();
        schedulePush(true);
        return;
      }
      nativeRemove.call(this, key);
    };
  }

  /* 本机只留尚未成功同步的加密草稿；云端数据库是唯一永久权威数据源。 */
  function writeMirror() {
    state.pendingVersion += 1;
    var pendingVersion = state.pendingVersion;
    try {
      if (!state.key || (state.cachedText === null && state.cachedAccount === null)) {
        nativeRemove.call(window.localStorage, MIRROR_KEY);
        return;
      }
      var payload = JSON.stringify({
        account: state.cachedAccount,
        profiles: state.cachedText,
        revision: state.revision,
        saved_at: nowStamp(),
      });
      encryptText(state.key, payload).then(function (envelope) {
        if (pendingVersion !== state.pendingVersion || state.queue === null) return;
        try {
          nativeSet.call(window.localStorage, MIRROR_KEY, envelope);
        } catch (ignored) {
          /* 镜像写不进去不影响云端存档 */
        }
      });
    } catch (ignored) {
      /* 镜像只是加速项 */
    }
  }

  function readMirror() {
    var envelope = nativeGet.call(window.localStorage, MIRROR_KEY);
    if (!envelope || !state.key) return Promise.resolve(null);
    return decryptText(state.key, envelope)
      .then(function (text) {
        var parsed = JSON.parse(text);
        return {
          profiles: typeof parsed.profiles === "string" ? parsed.profiles : null,
          account: typeof parsed.account === "string" ? parsed.account : null,
          revision: typeof parsed.revision === "number" ? parsed.revision : 0,
        };
      })
      .catch(function () {
        return null;
      });
  }

  function encodeCloudRecord() {
    return JSON.stringify({
      kind: "verity.cloud.record",
      version: 1,
      profiles: state.cachedText,
      account: state.cachedAccount,
    });
  }

  function decodeCloudRecord(text) {
    try {
      var parsed = JSON.parse(text);
      if (parsed && parsed.kind === "verity.cloud.record" && parsed.version === 1) {
        return {
          profiles: typeof parsed.profiles === "string" ? parsed.profiles : null,
          account: typeof parsed.account === "string" ? parsed.account : null,
        };
      }
    } catch (ignored) {
      /* 旧记录的正文就是档案库 JSON 字符串。 */
    }
    return { profiles: text, account: null };
  }

  /* ------------------------------------------------------------ 推送到服务端 */

  function schedulePush(immediate) {
    if (!state.key || !state.user) {
      state.lastError = "尚未登录，家庭档案不会写入任何地方。";
      emit();
      return;
    }
    state.queue = true;
    if (state.timer) window.clearTimeout(state.timer);
    var delay = typeof immediate === "number" ? immediate : immediate ? 0 : PUSH_DEBOUNCE_MS;
    state.timer = window.setTimeout(function () {
      state.timer = null;
      flush();
    }, delay);
    emit();
  }

  function flush() {
    if (state.queue === null) return Promise.resolve();
    if (state.syncing) return Promise.resolve();
    var text = state.cachedText;
    if (text === null || typeof text !== "string" || !text.length) {
      /* 档案被清空：服务端也要为空，否则「重新登录后恢复」会把已删数据又拉回来。 */
      state.queue = null;
      state.syncing = true;
      emit();
      return api("/api/family/profile", {
        method: "DELETE",
        body: { expected_revision: state.revision },
      })
        .then(function () {
          state.revision = 0;
          state.lastSyncedAt = nowStamp();
          state.lastError = "";
          state.retryMs = 1000;
          state.pendingVersion += 1;
          try {
            nativeRemove.call(window.localStorage, MIRROR_KEY);
          } catch (ignored) {
            /* 清理失败不改变云端删除已成功的事实 */
          }
        })
        .catch(function (err) {
          state.lastError = err.message || String(err);
          state.queue = true;
          state.retryMs = Math.min(state.retryMs * 2, 60000);
        })
        .then(function () {
          state.syncing = false;
          emit();
          if (state.queue) schedulePush(state.retryMs);
        });
    }
    state.queue = null;
    state.syncing = true;
    emit();
    var expected = state.revision;
    return encryptText(state.key, encodeCloudRecord())
      .then(function (envelope) {
        return api("/api/family/profile", {
          method: "PUT",
          body: { payload: envelope, expected_revision: expected },
        });
      })
      .then(function (res) {
        state.revision = res && typeof res.revision === "number" ? res.revision : expected + 1;
        state.lastSyncedAt = nowStamp();
        state.lastError = "";
        state.retryMs = 1000;
        state.pendingVersion += 1;
        try {
          nativeRemove.call(window.localStorage, MIRROR_KEY);
        } catch (ignored) {
          /* 清理失败不改变云端已保存成功的事实 */
        }
      })
      .catch(function (err) {
        if (err.code === "conflict") {
          /* 别处改过：以服务端为准重新拉取，避免本机覆盖别处的更新。 */
          state.lastError = "云端已有更新的版本，已重新载入云端档案；刚才这次修改未保存，请复核后再次保存。";
          return pull().then(function () {
            emit();
          });
        }
        if (err.code === "unauthenticated") {
          state.lastError = "会话已过期，请重新登录后再保存。";
          lock();
          return;
        }
        state.lastError = "保存到云端失败：" + (err.message || err);
        state.queue = true;
        state.retryMs = Math.min(state.retryMs * 2, 60000);
      })
      .then(function () {
        state.syncing = false;
        emit();
        if (state.queue) schedulePush(state.retryMs);
      });
  }

  /* ------------------------------------------------------------ 拉取与服务端 */

  function pull() {
    return api("/api/family/profile").then(function (data) {
      var record = data && data.record;
      if (!record) {
        state.revision = 0;
        state.cachedText = null;
        state.cachedAccount = null;
        return readMirror().then(function (pending) {
          if (pending) {
            state.cachedText = pending.profiles;
            state.cachedAccount = pending.account;
            state.queue = true;
            state.lastError = "发现尚未同步的加密草稿，正在恢复并重试保存到云端。";
            schedulePush(true);
          }
          return { empty: !pending, pending: pending };
        });
      }
      state.revision = typeof record.revision === "number" ? record.revision : 0;
      return decryptText(state.key, record.payload).then(function (text) {
        var cloud = decodeCloudRecord(text);
        state.cachedText = cloud.profiles;
        state.cachedAccount = cloud.account;
        return readMirror().then(function (pending) {
          if (pending && pending.profiles === cloud.profiles && pending.account === cloud.account) {
            state.lastSyncedAt = nowStamp();
            state.lastError = "";
            state.pendingVersion += 1;
            try {
              nativeRemove.call(window.localStorage, MIRROR_KEY);
            } catch (ignored) {
              /* 云端内容已与待同步草稿一致，清理失败不改变事实 */
            }
          } else if (pending && state.revision === Number(pending.revision || 0)) {
            state.cachedText = pending.profiles;
            state.cachedAccount = pending.account;
            state.queue = true;
            state.lastError = "发现尚未同步的加密草稿，正在恢复并重试保存到云端。";
            schedulePush(true);
          } else if (pending) {
            state.cachedText = cloud.profiles;
            state.cachedAccount = cloud.account;
            state.lastError = "云端档案已更新，本机待同步草稿未覆盖云端；请重新检查后保存。";
          }
          return { empty: false, pending: Boolean(pending) };
        });
      });
    });
  }

  /* ------------------------------------------------------------------ 账号 */

  function adoptSession(data, password) {
    state.user = data.user;
    state.kdfSalt = data.kdf_salt;
    state.recoveryConfigured = Boolean(data.recovery_configured);
    return deriveContentKey(password, data.kdf_salt).then(function (key) {
      state.key = key;
      return pull().then(function () {
        return null;
      });
    });
  }

  function register(email, password, displayName, remember) {
    state.lastError = "";
    var recoveryCode = generateRecoveryCode();
    return api("/api/auth/register", {
      method: "POST",
      body: { email: email, password: password, display_name: displayName },
    })
      .then(function (data) {
        state.mode = "cloud";
        state.recoveryCode = recoveryCode;
        return adoptSession(data, password).then(function () {
          /* 恢复码必须在拿到 kdf_salt 之后才能包住内容密钥，所以注册与登记恢复材料是两次请求。
             登记失败不阻断注册（用户仍可正常使用），但会明确提示让用户重新生成一次。 */
          return recoveryMaterialFromActiveKey(recoveryCode)
            .then(function (material) {
              return api("/api/auth/recovery", { method: "POST", body: { recovery: material } });
            })
            .then(function () { state.recoveryConfigured = true; return null; }, function (err) {
              state.recoveryCode = "";
              state.recoveryConfigured = false;
              state.lastError = "恢复码未能登记到云端（" + (err.message || String(err)) + "），请稍后在账号设置里重新生成。";
            });
        }).then(function () {
          if (remember) return rememberDevice();
          return null;
        });
      })
      .then(function () {
        state.ready = true;
        emit();
        return snapshot();
      }, function (err) {
        state.lastError = err.message || String(err);
        emit();
        throw err;
      });
  }

  function login(email, password, remember) {
    state.lastError = "";
    return api("/api/auth/login", { method: "POST", body: { email: email, password: password } })
      .then(function (data) {
        state.mode = "cloud";
        return adoptSession(data, password).then(function () {
          if (remember) return rememberDevice();
          return null;
        });
      })
      .then(function () {
        state.ready = true;
        emit();
        return snapshot();
      }, function (err) {
        state.lastError = err.message || String(err);
        emit();
        throw err;
      });
  }

  function rememberDevice() {
    if (!state.key) return Promise.resolve();
    return exportRawKey(state.key).then(function (raw) {
      try {
        nativeSet.call(window.localStorage, DEVICE_KEY, raw);
      } catch (ignored) {
        /* 存不下就退化成「每次打开需要输入口令」 */
      }
    });
  }

  function logout() {
    if (state.timer) window.clearTimeout(state.timer);
    state.timer = null;
    var pending = state.queue ? flush() : Promise.resolve();
    return pending
      .then(function () {
        if (state.queue || state.syncing || state.lastError) {
          throw new Error(state.lastError || "仍有家庭档案尚未同步到云端，请恢复网络并等待同步完成后再退出。");
        }
        return api("/api/auth/logout", { method: "POST" });
      })
      .then(function () {
        try {
          nativeRemove.call(window.localStorage, DEVICE_KEY);
          nativeRemove.call(window.localStorage, MIRROR_KEY);
        } catch (ignored) {
          /* 清不掉也不影响会话已经结束 */
        }
        lock();
      });
  }

  function lock() {
    state.user = null;
    state.key = null;
    state.kdfSalt = "";
    state.cachedText = null;
    state.cachedAccount = null;
    state.revision = 0;
    state.ready = false;
    state.queue = null;
    emit();
  }

  /* 刷新/重开浏览器：会话 Cookie 还在，用本机设备密钥直接解锁，无需重新输入口令。
     换设备或退出过登录时，退回「输入口令解锁云端档案」。 */
  function resume() {
    return api("/api/auth/me")
      .then(function (data) {
        state.user = data.user;
        state.kdfSalt = data.kdf_salt;
        state.recoveryConfigured = Boolean(data.recovery_configured);
        var raw = nativeGet.call(window.localStorage, DEVICE_KEY);
        if (!raw) {
          emit();
          return { locked: true };
        }
        return importRawKey(raw)
          .then(function (key) {
            state.key = key;
            return pull();
          })
          .then(function () {
            state.ready = true;
            emit();
            return { locked: false };
          });
      })
      .catch(function (err) {
        if (err.code === "unauthenticated") {
          state.user = null;
          emit();
          return { anonymous: true };
        }
        state.lastError = err.message || String(err);
        emit();
        return { offline: true };
      });
  }

  /* 会话在、口令不在：让用户输入一次口令解锁（端侧加密的正常代价）。 */
  function unlock(password) {
    if (!state.user) return Promise.reject(new Error("尚未登录。"));
    return deriveContentKey(password, state.kdfSalt)
      .then(function (key) {
        state.key = key;
        return pull();
      })
      .then(function () {
        return rememberDevice();
      })
      .then(function () {
        state.ready = true;
        state.lastError = "";
        emit();
        return snapshot();
      })
      .catch(function (err) {
        state.lastError = err.message || String(err);
        emit();
        throw err;
      });
  }

  /* 已登录用户（含老账号）生成/更换恢复码：用当前内存里的内容密钥包装，不需要重新输入口令。 */
  function configureRecovery() {
    var code = generateRecoveryCode();
    return recoveryMaterialFromActiveKey(code)
      .then(function (material) {
        return api("/api/auth/recovery", { method: "POST", body: { recovery: material } });
      })
      .then(function () {
        state.recoveryCode = code;
        state.recoveryConfigured = true;
        state.lastError = "";
        emit();
        return { recovery_code: code, formatted: formatRecoveryCode(code) };
      }, function (err) {
        state.lastError = err.message || String(err);
        emit();
        throw err;
      });
  }

  function acknowledgeRecoveryCode() {
    state.recoveryCode = "";
  }

  /* 忘记口令：只用「邮箱 + 恢复码 + 新口令」三条信息完成重置，且云端家庭档案必须原样保留。
     全流程没有任何一步把明文家庭数据或恢复码发给服务端：
       1) begin：验恢复码 → 取回端侧密文与恢复材料；
       2) 端侧用恢复码解出旧内容密钥 → 用新口令派生新密钥 → 重新加密同一份档案；
       3) reset：服务端换口令散列、把重加密后的密文写回去、签发新会话。 */
  function resetPassword(email, code, newPassword) {
    var normalized = normalizeRecoveryCode(code);
    if (normalized.length < 16) {
      return Promise.reject(new Error("恢复码格式不正确，请按 5 位一组完整抄写（共 20 位）。"));
    }
    state.lastError = "";
    var context = null;
    return api("/api/auth/recovery/begin", { method: "POST", body: { email: email, recovery_code: normalized } })
      .then(function (data) {
        context = data;
        return deriveRecoveryKey(normalized, data.recovery_salt, data.recovery_iter);
      })
      .then(function (recoveryKey) {
        return decryptText(recoveryKey, context.recovery_wrap);
      })
      .then(function (rawKeyB64) {
        if (!context.record) return { plain: null, revision: 0 };
        return importRawKey(rawKeyB64).then(function (oldKey) {
          return decryptText(oldKey, context.record.payload).then(function (plain) {
            return { plain: plain, revision: context.record.revision };
          });
        });
      })
      .then(function (carried) {
        var newSalt = bytesToB64(randomBytes(16));
        return deriveContentKey(newPassword, newSalt).then(function (newKey) {
          var encrypted = carried.plain === null ? Promise.resolve(null) : encryptText(newKey, carried.plain);
          return encrypted.then(function (payload) {
            return buildRecoveryMaterial(newKey, normalized).then(function (material) {
              return { carried: carried, newSalt: newSalt, newKey: newKey, payload: payload, material: material };
            });
          });
        });
      })
      .then(function (next) {
        var body = {
          email: email,
          recovery_code: normalized,
          new_password: newPassword,
          new_kdf_salt: next.newSalt,
          recovery: next.material,
        };
        if (next.payload) {
          body.payload = next.payload;
          body.expected_revision = next.carried.revision;
        }
        return api("/api/auth/recovery/reset", { method: "POST", body: body }).then(function (data) {
          state.user = data.user;
          state.kdfSalt = data.kdf_salt;
          state.key = next.newKey;
          state.mode = "cloud";
          state.recoveryConfigured = true;
          state.revision = 0;
          return pull();
        });
      })
      .then(function () {
        state.ready = true;
        state.lastError = "";
        emit();
        return snapshot();
      })
      .catch(function (err) {
        state.lastError = err.message || String(err);
        emit();
        throw err;
      });
  }

  function resetCloud() {
    return api("/api/family/profile", {
      method: "DELETE",
      body: { expected_revision: state.revision },
    }).then(function () {
      state.revision = 0;
      state.cachedText = null;
      state.cachedAccount = null;
      state.lastSyncedAt = nowStamp();
      state.pendingVersion += 1;
      try {
        nativeRemove.call(window.localStorage, MIRROR_KEY);
      } catch (ignored) {
        /* 清理失败不改变云端删除已成功的事实 */
      }
      emit();
    });
  }

  installStorageProxy();

  window.VerityFamilyStore = {
    PROFILE_KEY: PROFILE_KEY,
    ACCOUNT_KEY: ACCOUNT_KEY,
    subscribe: subscribe,
    snapshot: snapshot,
    resume: resume,
    register: register,
    login: login,
    logout: logout,
    unlock: unlock,
    resetPassword: resetPassword,
    configureRecovery: configureRecovery,
    acknowledgeRecoveryCode: acknowledgeRecoveryCode,
    recoveryCode: function () {
      return state.recoveryCode;
    },
    formatRecoveryCode: formatRecoveryCode,
    resetCloud: resetCloud,
    pull: pull,
    flush: flush,
    lock: lock,
    api: api,
    mode: function () {
      return state.mode;
    },
    setApiBase: function (base) {
      API_BASE = String(base || "").replace(/\/+$/, "");
    },
  };
})();
