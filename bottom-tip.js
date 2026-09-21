/* Verity 底部浮层让位（r71 P0「悬浮提示遮挡操作」）。
 *
 * 背景：微信提示条 / 安装引导都是 position:fixed 的底部浮层，出现后会压住页面最后一行
 * 可点控件与右下角「回到顶部 / 章节」按钮，用户点不到。修法不是猜一个 padding 常数，
 * 而是把浮层的实测高度写进 --bottom-tip-h，由 CSS 决定让多少位置（见 styles.css / zh.css /
 * family.css）。多个浮层同时出现时取最大值，避免互相覆盖后让位不足。
 */
(function () {
  "use strict";

  var active = new Map();

  function apply() {
    var tallest = 0;
    active.forEach(function (height) {
      if (height > tallest) tallest = height;
    });
    var root = document.documentElement;
    if (tallest > 0) {
      root.style.setProperty("--bottom-tip-h", tallest + "px");
      root.classList.add("has-bottom-tip");
    } else {
      root.style.removeProperty("--bottom-tip-h");
      root.classList.remove("has-bottom-tip");
    }
  }

  function reserve(key, node) {
    if (!node) return;
    var height = Math.ceil(node.getBoundingClientRect().height || 0) + 14;
    active.set(key, height);
    apply();
  }

  function release(key) {
    if (!active.has(key)) return;
    active.delete(key);
    apply();
  }

  window.VerityBottomTip = { reserve: reserve, release: release };
})();
