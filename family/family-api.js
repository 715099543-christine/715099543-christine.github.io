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
    listeners: [],
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

     只接管两个键：家庭档案库与「本机账户」。其余键一律交还原生实现。
     触发方式用 Storage.prototype 覆盖而不是重定义 window.localStorage，
     这样无论 zh.js 通过 window.localStorage 还是直接 Storage.prototype 访问都生效。 */
  var nativeGet = window.Storage.prototype.getItem;
  var nativeSet = window.Storage.prototype.setItem;
  var nativeRemove = window.Storage.prototype.removeItem;

  function isManaged(key) {
    return key === PROFILE_KEY || key === ACCOUNT_KEY || key === MIRROR_KEY || key === DEVICE_KEY;
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

  /* 本机只留密文镜像：断网重开也能看见上次同步的内容，磁盘上不出现明文。 */
  function writeMirror() {
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
    if (!envelope || !state.key) return Promise.resolve(false);
    return decryptText(state.key, envelope)
      .then(function (text) {
        var parsed = JSON.parse(text);
        state.cachedText = typeof parsed.profiles === "string" ? parsed.profiles : null;
        state.cachedAccount = typeof parsed.account === "string" ? parsed.account : null;
        return true;
      })
      .catch(function () {
        return false;
      });
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
    state.timer = window.setTimeout(function () {
      state.timer = null;
      flush();
    }, immediate ? 0 : PUSH_DEBOUNCE_MS);
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
      return api("/api/family/profile", { method: "DELETE" })
        .then(function () {
          state.revision = 0;
          state.lastSyncedAt = nowStamp();
          state.lastError = "";
        })
        .catch(function (err) {
          state.lastError = err.message || String(err);
        })
        .then(function () {
          state.syncing = false;
          emit();
        });
    }
    state.queue = null;
    state.syncing = true;
    emit();
    var expected = state.revision;
    return encryptText(state.key, text)
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
        writeMirror();
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
      })
      .then(function () {
        state.syncing = false;
        emit();
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
        return { empty: true };
      }
      state.revision = typeof record.revision === "number" ? record.revision : 0;
      return decryptText(state.key, record.payload).then(function (text) {
        state.cachedText = text;
        return readMirror().then(function () {
          return { empty: false };
        });
      });
    });
  }

  /* ------------------------------------------------------------------ 账号 */

  function adoptSession(data, password) {
    state.user = data.user;
    state.kdfSalt = data.kdf_salt;
    return deriveContentKey(password, data.kdf_salt).then(function (key) {
      state.key = key;
      return readMirror().then(function (hit) {
        if (hit) return null;
        return pull().then(function () {
          return null;
        });
      });
    });
  }

  function register(email, password, displayName, remember) {
    state.lastError = "";
    return api("/api/auth/register", {
      method: "POST",
      body: { email: email, password: password, display_name: displayName },
    })
      .then(function (data) {
        return adoptSession(data, password).then(function () {
          if (remember) return rememberDevice();
          return null;
        });
      })
      .then(function () {
        state.ready = true;
        emit();
        return snapshot();
      })
      .catch(function (err) {
        state.lastError = err.message || String(err);
        emit();
        throw err;
      });
  }

  function login(email, password, remember) {
    state.lastError = "";
    return api("/api/auth/login", { method: "POST", body: { email: email, password: password } })
      .then(function (data) {
        return adoptSession(data, password).then(function () {
          if (remember) return rememberDevice();
          return null;
        });
      })
      .then(function () {
        state.ready = true;
        emit();
        return snapshot();
      })
      .catch(function (err) {
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
        return api("/api/auth/logout", { method: "POST" });
      })
      .catch(function () {
        return null;
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
        var raw = nativeGet.call(window.localStorage, DEVICE_KEY);
        if (!raw) {
          emit();
          return { locked: true };
        }
        return importRawKey(raw)
          .then(function (key) {
            state.key = key;
            return readMirror();
          })
          .then(function (hit) {
            if (hit) return null;
            return pull().then(function () {
              return null;
            });
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
        return readMirror();
      })
      .then(function (hit) {
        if (hit) return null;
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

  function resetCloud() {
    return api("/api/family/profile", { method: "DELETE" }).then(function () {
      state.revision = 0;
      state.cachedText = null;
      state.cachedAccount = null;
      state.lastSyncedAt = nowStamp();
      writeMirror();
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
    resetCloud: resetCloud,
    pull: pull,
    flush: flush,
    lock: lock,
    api: api,
    setApiBase: function (base) {
      API_BASE = String(base || "").replace(/\/+$/, "");
    },
  };
})();
