/* Verity 统一对话入口（r61）
 *
 * 首页「和 Verity 说」：一个输入框 + 麦克风 + 发送即可完成建档、补充资料、
 * 提问与运行分析。本模块职责：
 *   1. 三语自动识别（普通话 / 粤语 / English）——不展示语言选择按钮；
 *      文字按用词识别，语音复用下方语音建档的识别通道，结果转文字后同样识别；
 *   2. 意图自动路由（建档 / 运行分析 / 普通问答），用户看不到路由细节；
 *      建档与资料类输入转发给语音建档面板（同一套确认后才写入的流程）；
 *   3. 回答用同一语言：中文与粤语走控制台既有答案并同语言播报，英文给英文摘要；
 *   4. 麦克风不可用或识别失败时自动降级文字输入，不做假按钮。
 *
 * 纯逻辑（detectLang / route / englishAnswer）与 DOM 层分离，Node 可测。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.VerityChatDock = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var HK_MARKERS = ["嘅", "咗", "喺", "係", "唔", "哋", "啲", "同埋", "点解", "乜", "咩", "而家", "屋企", "几多", "边度", "点样", "老豆", "妈咪", "返工", "倾偈", "兔"],
      LANG_LABEL = { "zh-CN": "普通话", "zh-HK": "粤语", en: "English" };

  function detectLang(text) {
    var t = String(text == null ? "" : text).trim();
    if (!t) return "unknown";
    var hasCJK = /[\u3400-\u9fff]/.test(t);
    if (hasCJK) {
      var hkHits = 0;
      for (var i = 0; i < HK_MARKERS.length; i++) if (t.indexOf(HK_MARKERS[i]) !== -1) hkHits += 1;
      return hkHits >= 1 ? "zh-HK" : "zh-CN";
    }
    if (/[A-Za-z]/.test(t)) return "en";
    return "unknown";
  }

  function langLabel(lang) { return LANG_LABEL[lang] || "未识别"; }

  var RUN_WORDS = ["运行", "分析", "计算", "跑一下", "run", "analyze"],
      PROFILE_WORDS = ["建档", "建立", "补充", "修改", "更新", "保存", "家庭成员", "成员", "收入", "支出", "资产", "负债", "保险", "教育", "法律", "税务", "风险", "档案", "资料", "目标", "profile", "income", "asset", "liability", "insurance", "education"];

  function route(text) {
    var t = String(text == null ? "" : text).toLowerCase();
    for (var i = 0; i < RUN_WORDS.length; i++) if (t.indexOf(RUN_WORDS[i].toLowerCase()) !== -1) return "run";
    for (var j = 0; j < PROFILE_WORDS.length; j++) if (t.indexOf(PROFILE_WORDS[j].toLowerCase()) !== -1) return "profile";
    return "ask";
  }

  function moneyCn(n) {
    var num = Number(n || 0);
    return num.toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }

  function englishAnswer(question) {
    var src = (typeof homeResult === "function" && homeResult()) || null;
    var out = [];
    if (!src || !src.result) {
      return "I do not have a result for this family yet. Please set up your family profile and run the analysis first.";
    }
    var r = src.result;
    var q = String(question || "").toLowerCase();
    var safetyDays = (r.today && r.today.safety_days) || (r.safety && r.safety.safety_days) || 0;
    if (/cash|surviv|how long|撑|多久/.test(q)) {
      out.push("Cash runway: about " + moneyCn(Math.round(safetyDays)) + " days (≈ " + moneyCn(Math.round(safetyDays / 30)) + " months) is left if income stops. The 180-day baseline is " + (safetyDays >= 180 ? "met." : "not met yet — top up the emergency fund first."));
    }
    if (/gap|insurance|protection|保障|缺口/.test(q)) {
      var gap = (r.breadwinner || {}).protection_gap || {};
      out.push("Protection gap: " + (Number(gap.gap_after_insurance) > 0 ? "under the worst case you face a shortfall of " + moneyCn(gap.gap_after_insurance) + "." : "zero — your protection covers the worst case."));
    }
    if (/debt|loan|mortgage|债务/.test(q)) {
      var summary = (r.trend || {}).summary || {};
      out.push("Debt: total " + moneyCn(summary.total_debt_end) + ", pressure ratio " + moneyCn(Number((r.safety || {}).debt_pressure_ratio || 0)) + "%.");
    }
    if (/education|school|tuition|教育/.test(q)) {
      var edu = (r.breadwinner || {}).education || {};
      var safe = Array.isArray(edu.unfunded_events) && edu.unfunded_events.length === 0;
      out.push("Education: need " + moneyCn(edu.need) + ", status " + (edu.status || "—") + ". " + (safe ? "Education spending stays protected." : "Education funds may be squeezed in some scenarios."));
    }
    if (/growth|asset|net|trend|增长|资产/.test(q)) {
      var tsum = (r.trend || {}).summary || {};
      out.push("Net worth moves from " + moneyCn(tsum.net_worth_start) + " to " + moneyCn(tsum.net_worth_end) + " over 12 months; deficit months: " + ((tsum.deficit_months || []).length || 0) + ".");
    }
    if (/action|today|do|做|行动/.test(q)) {
      out.push("Today's action: " + ((r.today || {}).action || "—") + ".");
    }
    if (!out.length) {
      out.push("I answer these topics from the latest result: cash runway, protection gap, debt, education, asset growth, today's action.");
    }
    return out.join("\n");
  }

  function domInit() {
    if (typeof document === "undefined") return;
    var form = document.getElementById("chat-form");
    if (!form) return;

    var $ = function (id) { return document.getElementById(id); };
    var log = $("chat-log"), input = $("chat-input"), langPill = $("chat-lang");
    var ttsStop = $("chat-tts-stop");
    var lastLang = "unknown";

    function addLine(who, text) {
      if (!log || !text) return;
      var row = document.createElement("div");
      row.className = "chat-line chat-" + who;
      var bubble = document.createElement("div");
      bubble.className = "chat-bubble";
      bubble.textContent = String(text);
      row.appendChild(bubble);
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;
    }

    function setLang(lang) {
      lastLang = lang;
      if (langPill) {
        langPill.textContent = "识别为" + langLabel(lang);
        langPill.className = "pill " + (lang === "unknown" ? "info" : "ok");
      }
    }

    function speak(text, lang) {
      try {
        if (!("speechSynthesis" in window) || !text) return;
        window.speechSynthesis.cancel();
        var utter = new SpeechSynthesisUtterance(String(text));
        var want = lang === "en" ? "en-US" : lang === "zh-HK" ? "zh-HK" : "zh-CN";
        var pool = window.speechSynthesis.getVoices();
        var found = null;
        for (var i = 0; i < pool.length; i++) {
          var v = pool[i];
          if (v.lang && v.lang.toLowerCase().indexOf(want.toLowerCase()) === 0) { found = v; break; }
        }
        if (found) utter.voice = found;
        else utter.lang = want;
        if (ttsStop) ttsStop.classList.remove("hidden");
        utter.onend = function () { if (ttsStop) ttsStop.classList.add("hidden"); };
        utter.onerror = function () { if (ttsStop) ttsStop.classList.add("hidden"); };
        window.speechSynthesis.speak(utter);
      } catch (err) { /* 播报失败不阻断对话 */ }
    }

    if (ttsStop) {
      ttsStop.addEventListener("click", function () {
        try { window.speechSynthesis.cancel(); } catch (err) { /* noop */ }
        ttsStop.classList.add("hidden");
      });
    }

    function acceptInput(text) {
      var t = String(text || "").trim();
      if (!t) return;
      addLine("user", t);
      var lang = detectLang(t);
      setLang(lang);
      var kind = route(t);
      if (kind === "run") {
        var runBtn = $("home-run");
        if (runBtn && !runBtn.classList.contains("hidden")) {
          addLine("bot", "好的，正在运行家庭分析…");
          runBtn.click();
        } else {
          addLine("bot", "请先建立或保存一份家庭档案，再运行分析。可以点「家庭档案」查看。");
        }
        return;
      }
      if (kind === "profile") {
        var panel = $("voice-builder");
        if (panel) {
          panel.classList.remove("hidden");
          var starter = document.querySelector(".js-voice-start");
          if (starter && !document.documentElement.classList.contains("chat-interview-started")) {
            try {
              document.documentElement.classList.add("chat-interview-started");
              starter.click();
            } catch (err) { /* noop */ }
          }
          panel.scrollIntoView({ behavior: "smooth", block: "start" });
          var vForm = $("voice-form"), vInput = $("voice-input");
          if (vForm && vInput) {
            vInput.value = t;
            vForm.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
          }
          addLine("bot", "正在按你的话整理家庭资料，请在上面的语音建档对话里逐项确认。");
        }
        return;
      }
      var answer = "";
      if (lang === "en") {
        answer = englishAnswer(t);
      } else if (typeof askVerity === "function") {
        askVerity(t);
        var ansEl = $("ask-answer");
        if (ansEl) answer = ansEl.textContent || "";
      }
      if (!answer) answer = "我暂时没有能回答的内容。请先建立家庭档案并运行分析，或换个说法试试。";
      addLine("bot", answer);
      if (/[\u4e00-\u9fff]/.test(answer) || /[A-Za-z]{3,}/.test(answer)) speak(answer, lang === "en" ? "en" : "zh-CN");
    }

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var value = input ? input.value : "";
      if (!value.trim()) return;
      input.value = "";
      acceptInput(value);
    });

    var attach = $("chat-attach");
    if (attach) {
      attach.addEventListener("click", function () {
        var pf = $("pf-file");
        if (pf) pf.click();
        else { var profiles = $("profiles"); if (profiles) profiles.scrollIntoView({ behavior: "smooth", block: "start" }); }
      });
    }

    /* r65：首页默认只有统一对话，其余面板按需展开（展开即滚动到真实面板，不留假按钮） */
    function reveal(id) {
      var el = $(id);
      if (el) el.classList.remove("hidden");
      return el;
    }
    function openPanel(panelId, anchorId) {
      reveal(panelId);
      var target = $(anchorId || panelId);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    var account = $("chat-account");
    if (account) account.addEventListener("click", function () { openPanel("home", "hero-account"); });
    var profileEntry = $("chat-profile");
    if (profileEntry) profileEntry.addEventListener("click", function () {
      reveal("profile-modules");
      openPanel("profiles");
    });
    var vbEntry = $("chat-voice-builder");
    if (vbEntry) vbEntry.addEventListener("click", function () { openPanel("voice-builder"); });
    var wizardEntry = $("chat-wizard");
    if (wizardEntry) wizardEntry.addEventListener("click", function () {
      /* 表格建档仍然是登录后的真实表单流程：走同一个入口，不另造一条通道 */
      var starter = $("hero-establish");
      if (starter) { starter.click(); return; }
      openPanel("wizard");
    });

    var mic = $("chat-mic");
    if (mic) {
      var SpeechImpl = window.SpeechRecognition || window.webkitSpeechRecognition || null;
      mic.addEventListener("click", function () {
        var panel = $("voice-builder");
        if (!panel) { addLine("bot", "语音建档暂不可用，请直接输入文字。"); if (input) input.focus(); return; }
        panel.classList.remove("hidden");
        panel.scrollIntoView({ behavior: "smooth", block: "start" });
        if (!SpeechImpl) {
          addLine("bot", "当前浏览器不支持语音识别：已自动切换为文字输入，直接打字给我即可。");
          if (input) input.focus();
          return;
        }
        var vMic = $("voice-mic");
        if (vMic) vMic.click();
        addLine("bot", "开始聆听（普通话/粤语自动识别）：在下面的语音建档对话里可以暂停、继续或取消。");
      });
    }
  }

  return { detectLang: detectLang, langLabel: langLabel, route: route, englishAnswer: englishAnswer, _domInit: domInit };
});

/* DOM 引导：页面加载完成后挂接统一对话入口。 */
(function () {
  "use strict";
  if (typeof document === "undefined") return;
  function boot() {
    if (typeof VerityChatDock !== "undefined" && VerityChatDock._domInit) VerityChatDock._domInit();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
