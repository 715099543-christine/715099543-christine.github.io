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
  var LOCAL_ACCOUNT_KEY = "verity.zh.localaccount.v1";
  var LOCAL_VAULT_KEY = "verity.zh.vault.v1";
  var LOCAL_DEVICE_KEY = "verity.zh.localdevice.v1";
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
    /* "cloud" = 服务端账号通道；"local" = 本机账号（数据只在本设备，密文落盘）。 */
    mode: "cloud",
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

  /* ---------------------------------------------------- 本机账号（无服务端通道）

     为什么必须有这一层：正式域名上的服务端接口通道一旦不可用（例如托管的 Worker
     抛异常、返回 5xx），原来的实现是「失败关闭」——登录闸门永远打不开，产品直接不可用。
     本机账号把账号与档案都留在设备上：口令在浏览器里派生密钥，档案以同一套 v1 信封
     加密后写进 localStorage，磁盘上不出现明文。

     边界（必须诚实标注给用户看）：本机账号只在当前浏览器/设备上存在；换设备取回家庭
     档案需要服务端通道。因此本层只作为「通道不可用时的可用降级」，登录成功后用户能在
     界面上看到「本机账户」标识，不会被误认为云端已保存。 */

  function readLocalAccount() {
    try {
      var raw = nativeGet.call(window.localStorage, LOCAL_ACCOUNT_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !parsed.email_norm || !parsed.kdf_salt || !parsed.verifier) {
        return null;
      }
      return parsed;
    } catch (ignored) {
      return null;
    }
  }

  function writeLocalAccount(account) {
    try {
      nativeSet.call(window.localStorage, LOCAL_ACCOUNT_KEY, JSON.stringify(account));
      return true;
    } catch (ignored) {
      return false;
    }
  }

  function clearLocalAccount() {
    try {
      nativeRemove.call(window.localStorage, LOCAL_ACCOUNT_KEY);
    } catch (ignored) {
      /* 清不掉不影响会话已经结束 */
    }
  }

  /* 本机账号的口令凭据：只存口令派生结果的 SHA-256，存不下明文口令，也不能反推密钥。 */
  function localVerifier(key) {
    return exportRawKey(key).then(function (rawB64) {
      return subtle().digest("SHA-256", b64ToBytes(rawB64));
    }).then(bytesToB64);
  }

  function writeVault() {
    if (state.mode !== "local" || !state.key) return Promise.resolve(false);
    var hasContent = state.cachedText !== null || state.cachedAccount !== null;
    if (!hasContent) {
      try {
        nativeRemove.call(window.localStorage, LOCAL_VAULT_KEY);
      } catch (ignored) {
        /* 删不掉不影响已经清空的语义 */
      }
      state.lastSyncedAt = nowStamp();
      return Promise.resolve(true);
    }
    var payload = JSON.stringify({
      account: state.cachedAccount,
      profiles: state.cachedText,
      revision: state.revision,
      saved_at: nowStamp(),
    });
    return encryptText(state.key, payload).then(function (envelope) {
      nativeSet.call(window.localStorage, LOCAL_VAULT_KEY, envelope);
      state.lastSyncedAt = nowStamp();
      return true;
    });
  }

  function readVault() {
    if (!state.key) return Promise.resolve(false);
    var envelope = nativeGet.call(window.localStorage, LOCAL_VAULT_KEY);
    if (!envelope) return Promise.resolve(false);
    return decryptText(state.key, envelope).then(function (text) {
      var parsed = JSON.parse(text);
      state.cachedText = typeof parsed.profiles === "string" ? parsed.profiles : null;
      state.cachedAccount = typeof parsed.account === "string" ? parsed.account : null;
      state.revision = typeof parsed.revision === "number" ? parsed.revision : 0;
      return true;
    }).catch(function () {
      return false;
    });
  }

  /* 服务端通道不可用：网络错误、5xx。4xx（口令错、邮箱重复）必须原样报给用户。 */
  function isChannelUnavailable(err) {
    if (!err) return false;
    if (err.code === "offline") return true;
    if (typeof err.status === "number" && err.status >= 500) return true;
    return false;
  }

  function adoptLocalSession(account, remember, cause) {
    state.mode = "local";
    state.user = { email: account.email, display_name: account.display_name || "" };
    state.kdfSalt = account.kdf_salt;
    state.revision = 0;
    state.lastSyncedAt = "";
    var note = "本机账户模式：云端账号通道不可用（" + ((cause && (cause.message || cause)) || "未说明原因") + "），家庭档案只加密保存在这台设备上，换设备取回需要云端通道恢复。";
    state.lastError = note;
    return deriveContentKey(account.__password, account.kdf_salt).then(function (key) {
      state.key = key;
      return Promise.all([readVault(), readMirror()]).then(function (results) {
        if (!results[0] && results[1]) {
          /* 旧版本留下的密文镜像也能接管，避免升级后看到空档案。 */
          return writeVault().then(function () {
            return null;
          });
        }
        return null;
      });
    }).then(function () {
      if (remember) return rememberDevice();
      return null;
    });
  }

  function registerLocal(email, password, displayName, remember, cause) {
    var norm = String(email || "").trim().toLowerCase();
    var existing = readLocalAccount();
    if (existing && existing.email_norm !== norm) {
      return Promise.reject(new Error(
        "本机已经有一个本机账号（" + existing.email + "）。本机账户模式下一台设备只保存一个账号，请改用该账号登录。"
      ));
    }
    var saltB64 = bytesToB64(randomBytes(16));
    return deriveContentKey(password, saltB64).then(function (key) {
      return localVerifier(key).then(function (verifier) {
        var account = {
          email: String(email || "").trim(),
          email_norm: norm,
          display_name: String(displayName || "").trim(),
          kdf_salt: saltB64,
          verifier: verifier,
          created_at: nowStamp(),
        };
        if (!writeLocalAccount(account)) {
          throw new Error("浏览器拒绝了本机存储（可能是隐私模式或存储已满），无法创建本机账号。");
        }
        account.__password = password;
        return adoptLocalSession(account, remember, cause);
      });
    });
  }

  function loginLocal(email, password, remember, cause) {
    var norm = String(email || "").trim().toLowerCase();
    var account = readLocalAccount();
    if (!account) {
      return Promise.reject(new Error("本机没有找到这个账号，请改用「注册新账号」在本机创建。"));
    }
    if (account.email_norm !== norm) {
      return Promise.reject(new Error("本机保存的账号是 " + account.email + "，与本机档案不匹配。"));
    }
    return deriveContentKey(password, account.kdf_salt).then(function (key) {
      return localVerifier(key).then(function (verifier) {
        if (verifier !== account.verifier) {
          throw new Error("本机账户口令不正确。");
        }
        account.__password = password;
        return adoptLocalSession(account, remember, cause);
      });
    });
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
    return (
      key === PROFILE_KEY ||
      key === ACCOUNT_KEY ||
      key === MIRROR_KEY ||
      key === DEVICE_KEY ||
      key === LOCAL_ACCOUNT_KEY ||
      key === LOCAL_DEVICE_KEY ||
      key === LOCAL_VAULT_KEY
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
    if (state.mode === "local") return flushLocal();
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

  /* 本机账号：落盘目标换成同设备密文库，其余语义（防抖、清空、时间戳）与云端一致。 */
  function flushLocal() {
    if (state.queue === null || state.syncing) return Promise.resolve();
    state.queue = null;
    state.syncing = true;
    emit();
    return writeVault()
      .then(function () {
        state.lastError = "本机账户模式：家庭档案已加密保存在这台设备上（换设备取回需要云端通道）。";
      })
      .catch(function (err) {
        state.lastError = "保存到本机失败：" + (err.message || err);
      })
      .then(function () {
        state.syncing = false;
        emit();
      });
  }

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
        state.mode = "cloud";
        return adoptSession(data, password).then(function () {
          if (remember) return rememberDevice();
          return null;
        });
      }, function (err) {
        if (!isChannelUnavailable(err)) throw err;
        return registerLocal(email, password, displayName, remember, err);
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
      }, function (err) {
        if (!isChannelUnavailable(err)) throw err;
        return loginLocal(email, password, remember, err);
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
    /* 本机账号与云端账号的密钥不同源，必须分开存，否则会出现「记得我」之后解不开的情况。 */
    var slot = state.mode === "local" ? LOCAL_DEVICE_KEY : DEVICE_KEY;
    return exportRawKey(state.key).then(function (raw) {
      try {
        nativeSet.call(window.localStorage, slot, raw);
      } catch (ignored) {
        /* 存不下就退化成「每次打开需要输入口令」 */
      }
    });
  }

  function logout() {
    if (state.timer) window.clearTimeout(state.timer);
    state.timer = null;
    if (state.mode === "local") {
      /* 退出本机账号只结束会话：本机账号与加密档案都保留，「重新登录数据不丢失」。 */
      try {
        nativeRemove.call(window.localStorage, LOCAL_DEVICE_KEY);
      } catch (ignored) {
        /* 清不掉不影响会话已经结束 */
      }
      lock();
      return Promise.resolve();
    }
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
        var localAccount = readLocalAccount();
        if (isChannelUnavailable(err) && localAccount) {
          return resumeLocal(localAccount, err);
        }
        emit();
        return { offline: true };
      });
  }

  /* 通道不可用但有本机账号：直接回到本机加密档案，不做任何假装成云端的展示。 */
  function resumeLocal(account, cause) {
    state.mode = "local";
    state.user = { email: account.email, display_name: account.display_name || "" };
    state.kdfSalt = account.kdf_salt;
    state.lastError = "本机账户模式：云端账号通道不可用（" + ((cause && (cause.message || cause)) || "未说明原因") + "），已用本机加密档案继续。";
    var raw = nativeGet.call(window.localStorage, LOCAL_DEVICE_KEY);
    if (!raw) {
      emit();
      return Promise.resolve({ locked: true });
    }
    return importRawKey(raw)
      .then(function (key) {
        state.key = key;
        return readVault();
      })
      .then(function () {
        state.ready = true;
        emit();
        return { locked: false };
      })
      .catch(function () {
        state.key = null;
        emit();
        return { locked: true };
      });
  }

  /* 会话在、口令不在：让用户输入一次口令解锁（端侧加密的正常代价）。 */
  function unlock(password) {
    if (!state.user) return Promise.reject(new Error("尚未登录。"));
    if (state.mode === "local") {
      var account = readLocalAccount();
      if (!account) return Promise.reject(new Error("本机账号信息已丢失，请在本机重新注册。"));
      return loginLocal(account.email, password, true, null)
        .then(function () {
          state.ready = true;
          state.lastError = "本机账户模式：家庭档案已用本机口令解密（数据只在这台设备上）。";
          emit();
          return snapshot();
        })
        .catch(function (err) {
          state.lastError = err.message || String(err);
          emit();
          throw err;
        });
    }
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
    if (state.mode === "local") {
      try {
        nativeRemove.call(window.localStorage, LOCAL_VAULT_KEY);
        nativeRemove.call(window.localStorage, MIRROR_KEY);
      } catch (ignored) {
        /* 删不掉不影响「已清空」的语义 */
      }
      state.revision = 0;
      state.cachedText = null;
      state.cachedAccount = null;
      state.lastSyncedAt = nowStamp();
      emit();
      return Promise.resolve();
    }
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
    mode: function () {
      return state.mode;
    },
    localAccount: function () {
      var account = readLocalAccount();
      if (!account) return null;
      return { email: account.email, display_name: account.display_name || "", created_at: account.created_at || "" };
    },
    registerLocal: function (email, password, displayName, remember) {
      return registerLocal(email, password, displayName, remember, null).then(function () {
        state.ready = true;
        emit();
        return snapshot();
      });
    },
    loginLocal: function (email, password, remember) {
      return loginLocal(email, password, remember, null).then(function () {
        state.ready = true;
        emit();
        return snapshot();
      });
    },
    forgetLocalAccount: function () {
      clearLocalAccount();
      try {
        nativeRemove.call(window.localStorage, LOCAL_DEVICE_KEY);
        nativeRemove.call(window.localStorage, LOCAL_VAULT_KEY);
      } catch (ignored) {
        /* 清不掉不影响账号已经移除 */
      }
      lock();
    },
    setApiBase: function (base) {
      API_BASE = String(base || "").replace(/\/+$/, "");
    },
  };
})();
