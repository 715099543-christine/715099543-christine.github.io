/* Verity 语音建档 · 对话式建档面板（Round 52）
 *
 * 依赖：../voice-nlu.js（window.VerityVoiceNLU）与控制台（zh.js）的全局函数
 *       collectProfile / fillProfile / validate / saveCurrentProfile / setMsg / showStep。
 * 职责：
 *   1. 首页突出「开始语音建立家庭档案」：语音（普通话/粤语）+ 文字备用双通道；
 *   2. 一次只问一个最关键缺失项，把用户的话解析成事实 → 逐项复述 → 确认后才写入草稿；
 *   3. 支持语音指令：上一题 / 我说错了 / 修改 / 稍后填写 / 保存退出 / 继续 / 运行家庭分析 / 查看摘要；
 *   4. 每次确认自动同步底层表单并落云端（复用控制台云端保存通道，权威数据在云端）。
 *
 * 隐私：使用麦克风前必须先点按钮（用户手势触发浏览器授权弹窗）；原始录音不落盘，
 *       不做广告/训练用途；只有用户确认后的结构化数据才会保存。
 */
(function () {
  "use strict";

  var NLU = window.VerityVoiceNLU;
  if (!NLU) return;

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    draft: null,          /* 与 collectProfile() 同构的草稿 */
    asked: [],            /* 已问过的问题 key */
    pending: null,        /* 等待用户确认的 {fact, questionKey} */
    lastFact: null,       /* 最近一次已确认事实（供「我说错了」回退） */
    mode: "zh-CN",        /* 普通话；zh-HK = 粤语 */
    listening: false,
    history: [],          /* [{who:"bot"|"user", text}] */
    speech: null,         /* SpeechRecognition 实例 */
    busy: false,
  };

  function bot(text) { appendLine("bot", text); }
  function self(text) { appendLine("user", text); }

  function appendLine(who, text) {
    if (!text) return;
    state.history.push({ who: who, text: String(text) });
    var log = $("voice-log");
    if (!log) return;
    var row = document.createElement("div");
    row.className = "voice-line voice-" + who;
    var bubble = document.createElement("div");
    bubble.className = "voice-bubble";
    bubble.textContent = String(text);
    row.appendChild(bubble);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  function status(text, kind) {
    var el = $("voice-status");
    if (el) {
      el.textContent = text || "";
      el.dataset.kind = kind || "idle";
    }
  }

  function renderSummary() {
    var el = $("voice-summary");
    if (!el) return;
    el.innerHTML = "";
    var items = NLU.summaryFacts(state.draft);
    if (!items.length) {
      var empty = document.createElement("span");
      empty.className = "voice-summary-empty";
      empty.textContent = "还没有确认任何内容。";
      el.appendChild(empty);
      return;
    }
    items.forEach(function (item) {
      var chip = document.createElement("span");
      chip.className = "voice-chip";
      chip.textContent = item;
      el.appendChild(chip);
    });
  }

  /* ------------------------------------------------------------ 对话流程 */

  function freshDraft() {
    var form;
    try { form = collectProfile(); } catch (err) { form = null; }
    var draft = form ? JSON.parse(JSON.stringify(form)) : {};
    draft.profile_id = typeof draft.profile_id === "string" ? draft.profile_id : "";
    draft.currency = draft.currency || "CNY";
    draft.members = draft.members || [];
    draft.assets = draft.assets || [];
    draft.liabilities = draft.liabilities || [];
    draft.protection = draft.protection || [];
    draft.future_rigid_outflows = draft.future_rigid_outflows || [];
    draft.legal_affairs = draft.legal_affairs || {};
    draft.social_protection = draft.social_protection || {};
    draft.tax_affairs = draft.tax_affairs || {};
    draft.education_plan = draft.education_plan || {};
    draft.annual_goal = draft.annual_goal || {};
    /* 已有表单内容的会话（如打开了已保存档案）视为已问过 */
    state.asked = askedFromDraft(draft);
    return draft;
  }

  function askedFromDraft(draft) {
    var asked = [];
    ["profile_id", "members_count", "members_age", "income", "expense_essential",
     "expense_discretionary", "assets_cash", "assets_other", "assets_illiquid",
     "liabilities", "protection", "education", "outflows", "goal_horizon",
     "goal_return", "goal_tolerance"].forEach(function (key) {
      if (NLU.isFulfilled(draft, key)) asked.push(key);
    });
    return asked;
  }

  function askNext() {
    var q = NLU.nextQuestion(state.draft, state.asked);
    if (!q) {
      bot("该问的都问完了。你可以说「保存退出」把档案存到云端，或者说「运行家庭分析」出结果。");
      status("可以保存或运行分析", "ok");
      return;
    }
    bot(q.question);
    status(q.key === "liabilities" || q.key === "protection" || q.key === "education" || q.key === "assets_cash" || q.key === "assets_other" || q.key === "assets_illiquid" ? "如果某类没有，直接说「没有」" : "");
  }

  var QUESTION_HINT = {
    profile_id: "给档案起个名字",
    members_count: "家里有几口人",
    members_age: "成员的年龄",
    income: "家庭收入",
    expense_essential: "必要支出",
    expense_discretionary: "可选支出",
    assets_cash: "现金与存款",
    assets_other: "其他投资",
    assets_illiquid: "房产/车等",
    liabilities: "贷款负债",
    protection: "保险保障",
    education: "教育金计划",
    outflows: "一次性大额支出",
    goal_horizon: "投资年限",
    goal_return: "目标收益",
    goal_tolerance: "可承受亏损",
  };

  function welcome() {
    bot("你好，我是 Verity 语音建档助手。你像聊天一样告诉我家里的情况就行。先从第一个问题开始。");
    askNext();
  }

  function handleText(text) {
    var t = String(text || "").trim();
    if (!t) return;
    self(t);

    var command = NLU.commandOf(t);
    if (command) {
      runCommand(command);
      return;
    }

    if (state.pending) {
      if (NLU.isConfirm(t)) {
        confirmPending();
        return;
      }
      if (NLU.isDeny(t)) {
        bot("没关系，是我听错了。我再复述一次我理解的：" + NLU.echoFact(state.pending.fact) + "。你可以这样重新说：比如「每月生活费两万」。");
        return;
      }
      /* 在确认环节给了新内容：当作新描述重新解析 */
      state.pending = null;
    }

    var parsed = NLU.parseUtterance(t, { currency: (state.draft && state.draft.currency) || "CNY" });
    if (parsed.command) {
      runCommand(parsed.command);
      return;
    }
    if (!parsed.facts.length) {
      bot("我暂时没听懂这一句，麻烦换一种说法。也可以说「稍后填写」跳过，或说「查看摘要」看看我已经记下的内容。");
      return;
    }
    if (parsed.facts.length === 1 && parsed.facts[0].type === "unclassified_amount") {
      bot("我听到一笔金额 " + NLU.moneyCn(parsed.facts[0].amount, state.draft.currency) + "，但不清楚它属于哪一项。能补充说下这是收入、支出还是某项资产吗？");
      return;
    }
    if (parsed.facts.length === 1) {
      startConfirm(parsed.facts[0]);
      return;
    }
    /* 多事实：先全部复述，让用户一次性确认 */
    var echoText = parsed.facts.map(function (f) { return NLU.echoFact(f); }).join("；");
    bot("我听到：" + echoText + "。都对吗？回答「对」或「不对」。");
    state.pending = { facts: parsed.facts, multi: true, questionKey: lastQuestionKeyAfter(t) };
  }

  function startConfirm(fact) {
    state.pending = { fact: fact, multi: false, questionKey: currentQuestionKey() };
    bot("我听到：" + NLU.echoFact(fact) + "。对吗？");
  }

  function confirmPending() {
    if (!state.pending) return;
    var facts = state.pending.multi ? state.pending.facts : [state.pending.fact];
    facts.forEach(function (fact) {
      if (fact.type === "none") return;
      NLU.applyToDraft(state.draft, fact);
      state.lastFact = fact;
      state.lastRight = state.pending.questionKey;
      state.missingKey = null;
    });
    var q = state.pending;
    state.pending = null;
    markAskedAfterApply(q.questionKey, facts);
    renderSummary();
    bot("已记录。");
    askNext();
  }

  /* 以「没有/无」回答某类数据：用户说「没有」→ 相应问题标记为已知为空 */
  function markAskedAfterApply(questionKey, facts) {
    if (!questionKey) return;
    if (state.asked.indexOf(questionKey) < 0) state.asked.push(questionKey);
    /* 「没有」类回答本身不含事实：handleText 里对 deny 之外的“没有”单独处理 */
  }

  function currentQuestionKey() {
    var q = NLU.nextQuestion(state.draft, state.asked);
    return q ? q.key : null;
  }

  function lastQuestionKeyAfter(t) {
    var q = NLU.nextQuestion(state.draft, state.asked);
    return q ? q.key : null;
  }

  function runCommand(cmd) {
    switch (cmd) {
      case "PREV": {
        if (state.asked.length) {
          var key = state.asked.pop();
          bot("回到上一题：" + (QUESTION_HINT[key] || "") + "。或者你可以直接重新说。");
        } else {
          bot("这是第一题，没有更早的问题了。");
        }
        askNext();
        break;
      }
      case "CORRECT": {
        if (state.pending) {
          state.pending = null;
          bot("好的，刚才这条先不算。请重新说。");
          return;
        }
        if (state.lastFact) {
          var undone = NLU.echoFact(state.lastFact);
          rollbackLastFact();
          bot("已撤销刚才确认的「" + undone + "」。请重新说，或说「上一题」返回。");
        } else {
          bot("还没有需要修改的记录。");
        }
        askNext();
        break;
      }
      case "SKIP":
        state.pending = null;
        bot("好的，这道先跳过。");
        askNext();
        break;
      case "SAVE":
        saveAndExit();
        break;
      case "RUN":
        runAnalysis();
        break;
      case "RESUME":
        bot("好的，继续建档。");
        askNext();
        break;
      case "SUMMARY": {
        var items = NLU.summaryFacts(state.draft);
        bot(items.length ? "目前已经确认：" + items.join("；") + "。" : "目前还没有确认任何内容，我们从第一个问题开始。");
        break;
      }
      case "RESET":
        if (window.confirm("重新开始语音建档会清空本次语音草稿（已保存到云端的档案不受影响）。确定？")) {
          state.draft = freshDraft();
          state.asked = [];
          state.pending = null;
          state.lastFact = null;
          renderSummary();
          bot("好的，重新开始建档。");
          askNext();
        }
        break;
      default:
        break;
    }
  }

  /* 「我说错了」：撤销上一次已确认事实（金额型事实用减法回退；结构型事实重新计算）。 */
  function rollbackLastFact() {
    var fact = state.lastFact;
    if (!fact || !state.draft) return;
    switch (fact.type) {
      case "member_income": {
        var annual = fact.period === "monthly" ? fact.amount * 12 : fact.amount;
        var whoIdx = fact.who === "primary" ? 0 : 1;
        if (state.draft.members[whoIdx]) {
          state.draft.members[whoIdx].annual_income = Math.max(0, Number(state.draft.members[whoIdx].annual_income || 0) - annual);
        }
        break;
      }
      case "expense": {
        var amount = fact.period === "monthly" ? fact.amount * 12 : fact.amount;
        if (fact.essential) state.draft.annual_expenses_essential = Math.max(0, Number(state.draft.annual_expenses_essential || 0) - amount);
        else state.draft.annual_expenses_discretionary = Math.max(0, Number(state.draft.annual_expenses_discretionary || 0) - amount);
        break;
      }
      case "asset": {
        var assets = state.draft.assets || [];
        for (var i = assets.length - 1; i >= 0; i--) {
          if (assets[i].kind === fact.kind) {
            assets[i].value = Number(assets[i].value || 0) - fact.amount;
            if (assets[i].value <= 0) assets.splice(i, 1);
            break;
          }
        }
        break;
      }
      case "liability": {
        var liabs = state.draft.liabilities || [];
        for (var j = liabs.length - 1; j >= 0; j--) {
          if (liabs[j].kind === fact.kind) {
            liabs[j].balance = Math.max(0, Number(liabs[j].balance || 0) - fact.balance);
            if (liabs[j].balance <= 0 && !liabs[j].mandatory_payment) liabs.splice(j, 1);
            break;
          }
        }
        break;
      }
      case "protection": {
        var prot = state.draft.protection || [];
        fact.kinds.forEach(function (kind) {
          for (var k = prot.length - 1; k >= 0; k--) {
            if (prot[k].kind === kind) {
              prot[k].coverage = Math.max(0, Number(prot[k].coverage || 0) - (fact.coverage || 0));
              prot[k].annual_premium = Math.max(0, Number(prot[k].annual_premium || 0) - (fact.premium || 0));
              if (prot[k].coverage <= 0 && prot[k].annual_premium <= 0) prot.splice(k, 1);
              break;
            }
          }
        });
        break;
      }
      case "members": {
        /* 成员结构重算成本低：从草稿清除所有成员，交还对话流程重问 */
        state.draft.members = [];
        break;
      }
      default:
        break;
    }
    state.lastFact = null;
    renderSummary();
  }

  /* ------------------------------------------------------------ 保存到云端 / 运行分析 */

  function cloudReady() {
    var fs = window.VerityFamilyStore;
    var snap = fs && typeof fs.snapshot === "function" ? fs.snapshot() : null;
    return !!(snap && snap.mode === "cloud" && snap.ready === true);
  }

  function syncFormWithDraft() {
    fillProfile(state.draft);
    var nameInput = $("pf-name");
    if (nameInput && state.draft.profile_id) nameInput.value = state.draft.profile_id;
    if (typeof validate === "function") validate();
  }

  function saveAndExit() {
    if (state.busy) return;
    state.busy = true;
    status("正在保存到云端…", "busy");
    if (!cloudReady()) {
      status("需要先登录", "warn");
      bot("家庭档案要登录云端账号后才能加密保存。请回到顶部「我的家庭CFO」注册或登录，然后点「继续语音建档」接着填。");
      state.busy = false;
      return;
    }
    syncFormWithDraft();
    Promise.resolve(saveCurrentProfile())
      .then(function (result) {
        var fs = window.VerityFamilyStore;
        var snap = fs && typeof fs.snapshot === "function" ? fs.snapshot() : null;
        var synced = snap && !snap.lastError;
        var name = (state.draft.profile_id || "").trim() || "家庭档案";
        if (result === false) throw new Error("保存被取消：请先补全必填项，或先登录云端账号。");
        status(synced ? "已加密保存到云端" : "已写入待同步草稿", synced ? "ok" : "warn");
        bot(synced
          ? "「" + name + "」已经加密保存到云端。关掉页面、换设备或重新登录都能取回。接下来可以随时说「运行家庭分析」。"
          : "「" + name + "」已保存为加密草稿，但云端同步还没确认：" + (snap ? snap.lastError : "未知错误") + "。网络恢复后会自动重试。");
      })
      .catch(function (err) {
        status("保存未完成", "warn");
        bot("保存没有成功：" + (err && err.message ? err.message : String(err)) + "。可以再说一遍「保存退出」重试。");
      })
      .then(function () { state.busy = false; });
  }

  function runAnalysis() {
    if (!cloudReady()) {
      bot("请先登录云端账号并保存档案，再运行家庭分析。");
      return;
    }
    syncFormWithDraft();
    var defer = saveCurrentProfile;
    Promise.resolve(defer())
      .then(function (result) {
        if (result === false) throw new Error("保存被取消，请先补全必要信息。");
        var runBtn = $("w-run");
        if (runBtn && !runBtn.classList.contains("hidden")) {
          status("正在运行家庭分析…", "busy");
          bot("档案已保存，正在用你的真实数据运行家庭分析，稍等片刻。");
          runBtn.click();
        } else {
          if (typeof showStep === "function") showStep(8);
          status("需要先确认向导数据", "warn");
          bot("档案已保存。部分必要信息还缺，我继续问你：");
          state.asked = askedFromDraft(state.draft);
          askNext();
        }
      })
      .catch(function (err) {
        bot("运行分析前保存失败：" + (err && err.message ? err.message : String(err)));
      });
  }

  /* ------------------------------------------------------------ 语音识别（普通话/粤语 + 文字备用） */

  var SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition || null;

  function supportText() {
    return SpeechRecognitionImpl
      ? "支持语音输入（普通话/粤语），也可以直接打字。"
      : "当前浏览器不支持语音识别，已切换为文字输入：把你想说的话打进输入框即可。";
  }

  function stopListening() {
    if (state.speech && state.listening) {
      try { state.speech.stop(); } catch (ignored) { /* noop */ }
    }
    state.listening = false;
    var btn = $("voice-mic");
    if (btn) btn.dataset.on = "false";
    status("", "idle");
  }

  function setLang(mode) {
    state.mode = mode;
    var langLabel = mode === "zh-HK" ? "粤语" : "普通话";
    var toggleOn = $("voice-lang-zh") ? (mode === "zh-CN" ? "zh" : "hk") : "";
    var zh = $("voice-lang-zh"), hk = $("voice-lang-hk");
    if (zh) zh.setAttribute("aria-pressed", mode === "zh-CN" ? "true" : "false");
    if (hk) hk.setAttribute("aria-pressed", mode === "zh-HK" ? "true" : "false");
    var hint = $("voice-lang-hint");
    if (hint) hint.textContent = langLabel + "识别";
    if (state.speech) {
      try { state.speech.lang = mode; } catch (ignored) { /* noop */ }
    }
  }

  function startListening() {
    if (!SpeechRecognitionImpl) {
      bot("这个浏览器不支持语音识别，请用输入框打字告诉我。");
      $("voice-input").focus();
      return;
    }
    if (state.listening) {
      stopListening();
      return;
    }
    /* 点击即视为用户同意本次会话使用麦克风（浏览器会再弹授权确认） */
    bot("正在听…（点击麦克风图标可停止；也可以直接打字）");
    var rec = new SpeechRecognitionImpl();
    rec.lang = state.mode;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    state.speech = rec;
    state.listening = true;
    var btn = $("voice-mic");
    if (btn) btn.dataset.on = "true";
    status("正在听…", "busy");

    rec.onresult = function (event) {
      var transcript = "";
      for (var i = 0; i < event.results.length; i++) {
        if (event.results[i].isFinal) transcript += event.results[i][0].transcript;
      }
      if (transcript) {
        status("识别完成", "ok");
        stopListening();
        handleText(transcript);
      }
    };
    rec.onerror = function (event) {
      stopListening();
      var msg = event && event.error;
      if (msg === "not-allowed" || msg === "service-not-allowed") {
        status("麦克风没有获得授权", "warn");
        self("（授权被拒绝）");
        bot("浏览器拒绝了麦克风访问。你可以在浏览器地址栏重新允许麦克风，或者直接用下面的输入框打字。");
      } else if (msg === "no-speech") {
        status("没有听到声音", "idle");
        bot("没有听到声音。你可以再点一次麦克风，或者直接打字。");
      } else {
        status("语音识别失败：" + (msg || "未知错误"), "warn");
        bot("语音识别暂时不可用（" + (msg || "未知错误") + "），请用输入框打字，功能不受影响。");
      }
    };
    rec.onend = function () {
      if (state.listening) {
        state.listening = false;
        var b = $("voice-mic");
        if (b) b.dataset.on = "false";
        status("", "idle");
      }
    };
    try { rec.start(); } catch (err) {
      stopListening();
      bot("语音启动失败（" + (err && err.message ? err.message : err) + "），请用输入框打字。");
    }
  }

  /* ------------------------------------------------------------ 初始化 */

  function bind() {
    var mic = $("voice-mic");
    if (mic) mic.addEventListener("click", startListening);

    var form = $("voice-form");
    if (form) {
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var input = $("voice-input");
        if (!input) return;
        var value = input.value;
        input.value = "";
        handleText(value);
      });
    }

    var zh = $("voice-lang-zh"), hk = $("voice-lang-hk");
    if (zh) zh.addEventListener("click", function () { setLang("zh-CN"); });
    if (hk) hk.addEventListener("click", function () { setLang("zh-HK"); });

    /* 快捷指令 chips */
    document.querySelectorAll("[data-voice-cmd]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        handleText(btn.getAttribute("data-voice-cmd"));
      });
    });

    document.querySelectorAll(".js-voice-start").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var panel = $("voice-builder");
        if (panel) {
          panel.classList.remove("hidden");
          panel.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        if (!state.history.length) { state.draft = freshDraft(); welcome(); }
      });
    });

    document.querySelectorAll("[data-voice-resume]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var panel = $("voice-builder");
        if (panel) {
          panel.classList.remove("hidden");
          panel.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        state.draft = freshDraft();
        if (!state.history.length) welcome();
        else { bot("好的，继续建档。"); askNext(); }
      });
    });
  }

  function init() {
    bind();
    setLang(window.VerityVoiceLang || "zh-CN");
    var hint = $("voice-support-hint");
    if (hint) hint.textContent = supportText();
    var mic = $("voice-mic");
    if (mic && !SpeechRecognitionImpl) mic.disabled = true;
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
