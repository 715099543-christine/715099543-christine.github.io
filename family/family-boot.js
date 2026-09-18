/* Verity AI家庭CFO · /family/ 登录闸门与控制台启动器（Round 40）
 *
 * 职责：在真实账号会话建立之前，绝不加载也不会启动家庭CFO控制台（web/zh.js）。
 * 控制台启动时，它的持久化层已经被 family-api.js 接管为「服务端加密档案」。 */
(function () {
  "use strict";

  var store = window.VerityFamilyStore;
  var unlocked = false;

  function $(id) {
    return document.getElementById(id);
  }

  function show(node) {
    if (node) node.classList.remove("hidden");
  }

  function hide(node) {
    if (node) node.classList.add("hidden");
  }

  function setGateMessage(text, kind) {
    var el = $("gate-msg");
    if (!el) return;
    el.textContent = text || "";
    el.dataset.kind = kind || "";
    el.classList.toggle("hidden", !text);
  }

  function setMode(mode) {
    ["login", "register", "unlock"].forEach(function (name) {
      var tab = $("gate-tab-" + name);
      var panel = $("gate-form-" + name);
      var on = name === mode;
      if (tab) tab.setAttribute("aria-selected", on ? "true" : "false");
      if (panel) panel.classList.toggle("hidden", !on);
    });
    setGateMessage("", "");
  }

  function busy(on, label) {
    var nodes = document.querySelectorAll("#family-gate button[type=submit]");
    Array.prototype.forEach.call(nodes, function (b) {
      b.disabled = Boolean(on);
    });
    var spin = $("gate-busy");
    if (spin) {
      spin.textContent = on ? label || "正在处理…" : "";
      spin.classList.toggle("hidden", !on);
    }
  }

  function readForm(id) {
    var form = $(id);
    if (!form) return null;
    return {
      email: String((form.querySelector("[name=email]") || {}).value || "").trim(),
      password: String((form.querySelector("[name=password]") || {}).value || ""),
      display: String((form.querySelector("[name=display_name]") || {}).value || "").trim(),
      remember: Boolean((form.querySelector("[name=remember]") || {}).checked),
    };
  }

  function startConsole() {
    if (unlocked) return;
    unlocked = true;
    hide($("family-gate"));
    document.documentElement.classList.remove("family-locked");
    renderAccountChip();
    var scripts = ["../verity-digest.js", "../zh.js", "../family-insurance.js"];
    var index = 0;
    (function next() {
      if (index >= scripts.length) return;
      var src = scripts[index];
      index += 1;
      var tag = document.createElement("script");
      tag.src = src;
      tag.async = false;
      tag.onerror = function () {
        /* 可选模块（如保险实验室尚未随包发布）缺失不阻断控制台 */
        next();
      };
      tag.onload = next;
      document.body.appendChild(tag);
    })();
    registerShell();
  }

  function registerShell() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("./sw.js").catch(function () {
      /* 离线外壳注册失败不影响在线使用 */
    });
  }

  function renderAccountChip() {
    var snap = store.snapshot();
    var chip = $("cloud-chip");
    var text = $("cloud-text");
    if (!chip || !text) return;
    var kind = "ok";
    if (snap.lastError) kind = "bad";
    else if (snap.syncing) kind = "busy";
    chip.dataset.kind = kind;
    if (snap.lastError) text.textContent = snap.lastError;
    else if (snap.syncing) text.textContent = "正在保存到云端…";
    else if (snap.lastSyncedAt) text.textContent = "已加密保存到云端 · " + snap.lastSyncedAt;
    else text.textContent = "已登录 · 云端档案通道就绪";
    var whoEl = $("cloud-who");
    if (whoEl) {
      whoEl.textContent = snap.user ? (snap.user.display_name || snap.user.email) + " · " + snap.user.email : "";
    }
  }

  function bind() {
    ["login", "register", "unlock"].forEach(function (name) {
      var tab = $("gate-tab-" + name);
      if (tab) tab.addEventListener("click", function () { setMode(name); });
    });

    var loginForm = $("gate-form-login");
    if (loginForm) {
      loginForm.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var v = readForm("gate-form-login");
        if (!v.email || !v.password) { setGateMessage("请填写邮箱与口令。", "bad"); return; }
        busy(true, "正在登录…");
        store.login(v.email, v.password, v.remember)
          .then(function () { busy(false); startConsole(); })
          .catch(function (err) { busy(false); setGateMessage(err.message || String(err), "bad"); });
      });
    }

    var registerForm = $("gate-form-register");
    if (registerForm) {
      registerForm.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var v = readForm("gate-form-register");
        if (!v.email || !v.password) { setGateMessage("请填写邮箱与口令。", "bad"); return; }
        if (v.password.length < 10) { setGateMessage("口令至少 10 位：它同时用于两处——登录校验，以及在你的浏览器里加密家庭档案。", "bad"); return; }
        busy(true, "正在创建账号…");
        store.register(v.email, v.password, v.display, v.remember)
          .then(function () { busy(false); startConsole(); })
          .catch(function (err) { busy(false); setGateMessage(err.message || String(err), "bad"); });
      });
    }

    var unlockForm = $("gate-form-unlock");
    if (unlockForm) {
      unlockForm.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var v = readForm("gate-form-unlock");
        if (!v.password) { setGateMessage("请输入口令以解密云端档案。", "bad"); return; }
        busy(true, "正在解密云端档案…");
        store.unlock(v.password)
          .then(function () { busy(false); startConsole(); })
          .catch(function (err) { busy(false); setGateMessage(err.message || String(err), "bad"); });
      });
    }

    var logout = $("cloud-logout");
    if (logout) {
      logout.addEventListener("click", function () {
        if (!window.confirm("退出登录会结束本机会话并清除本机密钥缓存，云端档案仍然保留。确定退出？")) return;
        logout.disabled = true;
        store.logout().then(function () { window.location.reload(); });
      });
    }
  }

  function boot() {
    bind();
    store.subscribe(function () { if (unlocked) renderAccountChip(); });
    store.ready = false;
    store
      .resume()
      .then(function (result) {
        if (result && result.locked) {
          var who = store.snapshot().user;
          var label = $("unlock-who");
          if (label && who) label.textContent = who.email;
          setMode("unlock");
          show($("family-gate"));
          return;
        }
        if (result && result.anonymous) {
          setMode("login");
          show($("family-gate"));
          return;
        }
        if (result && result.offline) {
          setMode("login");
          setGateMessage(store.snapshot().lastError || "无法连接云端服务。", "bad");
          show($("family-gate"));
          return;
        }
        startConsole();
      })
      .catch(function (err) {
        setMode("login");
        setGateMessage(err.message || String(err), "bad");
        show($("family-gate"));
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
