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

  /* r71 P0：提示条出现时必须先给页面让位，否则会压住右下角「回到顶部 / 章节」
     与页面最后一行的可点控件。让位高度用实测值，不写死常数。 */
  function reserve() {
    if (window.VerityBottomTip) window.VerityBottomTip.reserve("wx-tip", bar);
  }

  function release() {
    if (window.VerityBottomTip) window.VerityBottomTip.release("wx-tip");
  }

  var close = document.getElementById("wx-tip-close");
  if (close) {
    close.addEventListener("click", function () {
      bar.classList.add("hidden");
      release();
      try {
        window.localStorage.setItem("verity.wx-tip.dismissed.v1", "1");
      } catch (err) { /* 存不下就只本次隐藏 */ }
    });
  }

  /* 转屏 / 字号变化都会改变提示条高度，重新实测一次。 */
  window.addEventListener("resize", function () {
    if (!bar.classList.contains("hidden")) reserve();
  });

  try {
    if (window.localStorage.getItem("verity.wx-tip.dismissed.v1") === "1") {
      bar.classList.add("hidden");
      return;
    }
  } catch (err) { /* 隐私模式等场景忽略 */ }

  bar.classList.remove("hidden");
  reserve();
})();
