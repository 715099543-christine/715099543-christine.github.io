/* Verity 微信内置浏览器轻提示（r60）。
 * 只做一件事：检测到微信内置浏览器时，显示一条可关闭的低干扰提示，
 * 建议改用 Safari / 系统浏览器获得完整语音与安装体验；绝不跳转、绝不阻断
 * 正常产品首页，也不统计、不上传任何信息。 */
(function () {
  "use strict";

  var UA = (navigator.userAgent || "").toLowerCase();
  var inWeChat = UA.indexOf("micromessenger") !== -1;
  if (!inWeChat) return;

  var bar = document.getElementById("wx-tip");
  if (!bar) return;

  var close = document.getElementById("wx-tip-close");
  if (close) {
    close.addEventListener("click", function () {
      bar.classList.add("hidden");
      try {
        window.localStorage.setItem("verity.wx-tip.dismissed.v1", "1");
      } catch (err) { /* 存不下就只本次隐藏 */ }
    });
  }

  try {
    if (window.localStorage.getItem("verity.wx-tip.dismissed.v1") === "1") {
      bar.classList.add("hidden");
      return;
    }
  } catch (err) { /* 隐私模式等场景忽略 */ }

  bar.classList.remove("hidden");
})();
