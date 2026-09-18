/* 「添加到主屏幕」引导（首页用）。
 *
 * 只做三件事：
 *   1. 注册根作用域的 Service Worker（离线外壳与可安装性的前提）；
 *   2. 浏览器给出 beforeinstallprompt 时显示中文按钮，点击即触发系统安装；
 *   3. iOS Safari 没有该事件，改为显示中文手动指引（分享 → 添加到主屏幕）。
 * 已安装（standalone 显示模式）或用户点了「以后再说」时，一律不打扰。
 */
(function () {
  "use strict";

  var DISMISS_KEY = "verity.install.dismissed.v1";
  var bar = document.getElementById("install-bar");
  var textEl = document.getElementById("install-text");
  var yesBtn = document.getElementById("install-yes");
  var noBtn = document.getElementById("install-no");
  var deferred = null;

  function dismissed() {
    try {
      return window.localStorage.getItem(DISMISS_KEY) === "1";
    } catch (err) {
      return false;
    }
  }

  function standalone() {
    return (
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
      window.navigator.standalone === true
    );
  }

  function show(text, label, handler) {
    if (!bar) return;
    if (textEl) textEl.textContent = text;
    if (yesBtn) {
      yesBtn.textContent = label;
      yesBtn.onclick = handler;
    }
    bar.classList.remove("hidden");
  }

  function hide() {
    if (bar) bar.classList.add("hidden");
  }

  if (noBtn) {
    noBtn.addEventListener("click", function () {
      try {
        window.localStorage.setItem(DISMISS_KEY, "1");
      } catch (err) {
        /* 存不下就只是这次不显示 */
      }
      hide();
    });
  }

  window.addEventListener("beforeinstallprompt", function (event) {
    event.preventDefault();
    deferred = event;
    if (dismissed() || standalone()) return;
    show("把 Verity 添加到手机主屏幕，下次一点就开。", "添加到主屏幕", function () {
      hide();
      if (!deferred) return;
      deferred.prompt();
      deferred.userChoice.then(function () {
        deferred = null;
      });
    });
  });

  window.addEventListener("appinstalled", function () {
    deferred = null;
    hide();
  });

  var isIos = /iPad|iPhone|iPod/.test(window.navigator.userAgent);
  var isSafari = isIos && !/CriOS|FxiOS|EdgiOS/.test(window.navigator.userAgent);
  if (isSafari && !dismissed() && !standalone()) {
    show("在 iPhone 上安装：点底部「分享」按钮 → 选择「添加到主屏幕」。", "我知道了", hide);
  }

  if ("serviceWorker" in window.navigator) {
    window.navigator.serviceWorker.register("./sw.js").catch(function () {
      /* 注册失败不影响在线使用，也不弹任何错误 */
    });
  }
})();
