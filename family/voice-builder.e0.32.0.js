/* Verity 语音建档 · 对话式建档面板（Round 52）
 *
 * 依赖：../voice-nlu.js（window.VerityVoiceNLU）与控制台（zh.js）的全局函数
 *       collectProfile / fillProfile / validate / saveCurrentProfile / setMsg / showStep。
 * 职责：
 *   1. 首页突出「开始语音建立家庭档案」：语音（普通话/粤语）+ 文字备用双通道；
 *   2. 一次只问一个最关键缺失项，把用户的话解析成事实 → 逐项复述 → 确认后才写入草稿；
 *   3. 支持语音指令：上一题 / 我说错了 / 修改 / 稍后填写 / 保存退出 / 继续 / 运行家庭分析 / 查看摘要；
 *   4. 每次确认自动同步底层表单并落云端（复用控制台云端保存通道，权威数据在云端）；
 *   5. Round 59：麦克风授权 / 暂停 / 继续 / 取消 / 识别失败 / 网络中断（自动重试一次）
 *      六个出口都有明确反馈，且任何出口都不保存原始录音。
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
    pendingName: null,    /* 等待用户确认档案名称 {next, proposed} */
    pendingRun: false,    /* 说过「运行家庭分析」——缺项补齐后自动运行（Round 55） */
    interviewStarted: false, /* 建档问答是否已开始（Round 57） */
    session: false,       /* 语音会话是否进行中（Round 59：暂停/继续/取消的载体） */
    paused: false,        /* 会话已暂停（已识别内容已入对话，不重复提交） */
    suppress: false,      /* 自己调 stop() 触发的 aborted/no-speech 不算故障 */
    retryTimer: 0,        /* 网络中断自动重试定时器 */
    retryUsed: false,     /* 本次会话是否已重试过一次 */
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
    state.interviewStarted = true;
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
    state.interviewStarted = true;
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

    if (state.pendingName) {
      takeNameReply(t);
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
    if (state.pendingRun) {
      maybeCompleteAnalysis();
      return;
    }
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
    if (!cloudReady()) {
      status("需要先登录", "warn");
      bot("家庭档案要登录云端账号后才能加密保存。请回到顶部「我的家庭CFO」注册或登录，然后点「继续语音建档」接着填。");
      return;
    }
    ensureProfileName(commitSaveAndExit);
  }

  function commitSaveAndExit() {
    if (state.busy) return;
    state.busy = true;
    status("正在保存到云端…", "busy");
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
    ensureProfileName(commitRunAnalysis);
  }

  /* Round 55 修复定位（r54 留缺口 2）：
     以前「运行家庭分析」在缺项时进入逐项补问，
     第一问是「档案名称」 —— 而 NLU 当时并没有名称提取规则，
     换设备恢复后语音建档的档案名称恒为空，
     导致这条命令永远卡在问名，引擎从未启动。
     现在：先给可确认的默认名（用户回「对」或直接说新名），
     保存后若仍缺必填项，一个一个补问，补齐后自动运行。 */
  function commitRunAnalysis() {
    if (state.busy) return;
    state.busy = true;
    status("正在保存并准备分析…", "busy");
    syncFormWithDraft();
    Promise.resolve(saveCurrentProfile())
      .then(function (result) {
        state.busy = false;
        if (result === false) throw new Error("保存被取消，请先补全必要信息。");
        if (typeof showStep === "function") showStep(8);
        var missing = typeof validate === "function" ? validate() : [];
        var runBtn = $("w-run");
        if (!missing.length && runBtn && !runBtn.classList.contains("hidden")) {
          status("正在运行家庭分析…", "busy");
          bot("档案已保存，正在用你的真实数据运行家庭分析，稍等片刻。");
          runBtn.click();
          return;
        }
        state.asked = askedFromDraft(state.draft);
        state.pendingRun = true;
        status("还差几项必填", "warn");
        bot("档案已保存。部分必要信息还缺，我继续问你：");
        askNext();
      })
      .catch(function (err) {
        state.busy = false;
        bot("运行分析前保存失败：" + (err && err.message ? err.message : String(err)) + "。可以再说一遍「运行家庭分析」重试。");
      });
  }

  /* 保存/运行前的名称闸门：语音建档全程可以不回答「档案名称」，
     但该字段是运行与云端的必填主键。这里给出可确认的默认名，
     用户回「对」即采用，或直接说新名字；绝不静默虚构。 */
  function defaultProfileName() {
    var fs = window.VerityFamilyStore;
    var snap = fs && typeof fs.snapshot === "function" ? fs.snapshot() : null;
    var who = snap && snap.user ? String(snap.user.display_name || "").trim() : "";
    var base = who && who.length >= 2 && who.length <= 12 && who.indexOf("@") < 0 ? who : "我们家";
    return base + " " + new Date().getFullYear();
  }

  function ensureProfileName(next) {
    if ((state.draft.profile_id || "").trim()) { next(); return; }
    if (state.pendingName) {
      if (state.pendingName.next !== next) state.pendingName.next = next;
      bot("请先确认档案名称：回复「对」用我建议的名字，或直接说个新名字。");
      return;
    }
    var proposed = defaultProfileName();
    state.pendingName = { next: next, proposed: proposed };
    status("需要先确认档案名称", "warn");
    bot("这份档案还没有名字。我建议用「" + proposed + "」：回复「对」就按这个名称保存；也可以直接告诉我新名字，比如「李家 2026」。");
  }

  function takeNameReply(text) {
    var t = String(text || "").trim();
    var pending = state.pendingName;
    if (!pending) return false;
    var name = null;
    if (NLU.isConfirm(t)) {
      name = pending.proposed;
    } else {
      var parsed = NLU.parseUtterance(t, { currency: (state.draft && state.draft.currency) || "CNY" });
      var facts = (parsed && parsed.facts) || [];
      for (var i = 0; i < facts.length; i++) {
        if (facts[i].type === "profile_name") { name = facts[i].name; break; }
      }
      if (!name) {
        var cleaned = t
          .replace(/^(就?叫|名字(?:叫|是)|档案(?:叫|名字是)|起名|命名为?|取名为?|改成|改叫)/, "")
          .replace(/[，,。.！!？?、吧了哦哈]+$/g, "")
          .trim();
        if (cleaned && !NLU.isConfirm(cleaned) && !/^(不对|不是|算了|跳过|稍后)/.test(cleaned)) name = cleaned;
      }
    }
    if (!name) {
      bot("没听清档案名称。回复「对」用我建议的名字，或直接说个新名字，比如「李家 2026」。");
      return true;
    }
    name = String(name).trim().slice(0, 40);
    state.draft.profile_id = name;
    if (state.asked.indexOf("profile_id") < 0) state.asked.push("profile_id");
    state.pendingName = null;
    syncFormWithDraft();
    renderSummary();
    bot("档案名称已确认：「" + name + "」。");
    pending.next();
    return true;
  }

  /* 说过「运行家庭分析」后每次确认一条事实，就检查一次必填项：
     齐了立即自动运行引擎，不再要求用户凍多说一次。 */
  function maybeCompleteAnalysis() {
    syncFormWithDraft();
    var missing = typeof validate === "function" ? validate() : [];
    var runBtn = $("w-run");
    if (!missing.length && runBtn && !runBtn.classList.contains("hidden")) {
      state.pendingRun = false;
      status("正在运行家庭分析…", "busy");
      bot("信息齐了，正在用你的真实数据运行家庭分析，稍等片刻。");
      runBtn.click();
      return;
    }
    askNext();
  }

  /* ------------------------------------------------------------ 语音识别（普通话/粤语 + 文字备用） */

  var SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition || null;

  function supportText() {
    return SpeechRecognitionImpl
      ? "支持语音输入（普通话/粤语），也可以直接打字。"
      : "当前浏览器不支持语音识别，已切换为文字输入：把你想说的话打进输入框即可。";
  }

  /* 无语音能力时把用户明确引导到文字输入：高亮输入行 + 聚焦，避免「点击无反应」 */
  function after(ms, fn) {
    if (typeof window !== "undefined" && typeof window.setTimeout === "function") window.setTimeout(fn, ms);
  }

  function guideToTextInput() {
    var box = $("voice-input");
    if (!box) return;
    var wrap = null;
    try {
      wrap = (typeof box.closest === "function" && box.closest(".voice-input-row")) || box.parentNode || null;
    } catch (ignored) { wrap = box.parentNode || null; }
    if (wrap && wrap.classList) {
      wrap.classList.add("voice-input-nudge");
      after(1800, function () { wrap.classList.remove("voice-input-nudge"); });
    }
    if (typeof box.focus === "function") box.focus();
    try {
      if (typeof box.setSelectionRange === "function") box.setSelectionRange(box.value.length, box.value.length);
    } catch (ignored) { /* noop */ }
  }

  /* ------------------------------------------------ 会话控制（Round 59）
     必做的六个出口：麦克风授权 / 暂停 / 继续 / 取消 / 识别失败 / 网络中断。
     任何路径都不保存原始录音、不把识别文字写入日志或缓存，只有用户逐项确认的
     事实才会进入草稿并同步云端。 */

  var RETRY_DELAY_MS = 2500;

  /* 会话控件（暂停 / 取消）只在真正聆听期间出现，结束时立刻收起，不做假按钮。 */
  function setControls(active, paused) {
    var pause = $("voice-pause"), cancel = $("voice-cancel");
    if (pause) {
      pause.classList[active ? "remove" : "add"]("hidden");
      pause.textContent = paused ? "继续" : "暂停";
      pause.setAttribute("aria-label", paused ? "继续语音输入" : "暂停语音输入");
      pause.setAttribute("aria-pressed", paused ? "true" : "false");
    }
    if (cancel) cancel.classList[active ? "remove" : "add"]("hidden");
  }

  function clearRetry() {
    if (state.retryTimer) {
      try { window.clearTimeout(state.retryTimer); } catch (ignored) { /* noop */ }
      state.retryTimer = 0;
    }
  }

  /* 停止底层识别（暂停、结束、错误路径共用）。state.suppress 让「我们自己调 stop()」
     触发的 aborted/no-speech 不被误报成识别故障。 */
  function stopListening(keepStatus) {
    state.suppress = true;
    if (state.speech && state.listening) {
      try { state.speech.stop(); } catch (ignored) { /* noop */ }
    }
    state.listening = false;
    state.speech = null;
    var btn = $("voice-mic");
    if (btn) btn.dataset.on = "false";
    if (!keepStatus) status("", "idle");
    after(1500, function () { state.suppress = false; });
  }

  function endSession() {
    clearRetry();
    state.session = false;
    state.paused = false;
    state.retryUsed = false;
    stopListening(true);
    setControls(false, false);
  }

  function handleRecognError(err) {
    /* 先判定，再停底层：我们自己调 stop() 时浏览器可能同步回调 onend/onerror，
       顺序反了会把「网络中断」误判成「用户暂停」，让用户看到错的提示。 */
    var wasPaused = state.paused;
    var intentional = state.suppress && (err === "aborted" || err === "no-speech");
    stopListening(true);
    if (wasPaused || intentional) {
      state.suppress = false;
      if (state.session) status("已暂停，点「继续」接着说", "warn");
      return;
    }
    if (err === "not-allowed" || err === "service-not-allowed") {
      endSession();
      status("麦克风没有获得授权", "warn");
      bot("浏览器拒绝了麦克风访问。你可以在浏览器地址栏里重新允许麦克风，或者直接用下面的输入框打字。");
      guideToTextInput();
      return;
    }
    if (err === "no-speech") {
      if (state.session) {
        state.paused = true;
        setControls(true, true);
        status("没有听到声音，点「继续」或重新点麦克风", "idle");
        return;
      }
      status("没有听到声音", "idle");
      bot("没有听到声音。你可以再点一次麦克风，或者直接打字。");
      return;
    }
    if (err === "network") {
      if (state.session && !state.retryUsed) {
        state.retryUsed = true;
        status("网络中断，正在自动重试一次…", "busy");
        bot("网络断了，正在自动重试一次；如果仍然不行，直接在输入框打字也能建档。");
        clearRetry();
        state.retryTimer = window.setTimeout(function () {
          state.retryTimer = 0;
          if (state.session && !state.paused) listen();
        }, RETRY_DELAY_MS);
        return;
      }
      endSession();
      status("网络中断，语音识别暂时不可用", "warn");
      bot("网络仍然不稳定，已切回文字输入：把你想说的内容打进下面的输入框即可，功能不受影响。");
      guideToTextInput();
      return;
    }
    endSession();
    status("语音识别失败：" + (err || "未知错误"), "warn");
    bot("语音识别暂时不可用（" + (err || "未知错误") + "），请用输入框打字，功能不受影响。");
    guideToTextInput();
  }

  function listen() {
    if (!SpeechRecognitionImpl || !state.session) return;
    var rec = new SpeechRecognitionImpl();
    rec.lang = state.mode;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    rec.onresult = function (event) {
      var transcript = "";
      for (var i = 0; i < event.results.length; i++) {
        if (event.results[i].isFinal) transcript += event.results[i][0].transcript;
      }
      if (!transcript) return;
      endSession();
      /* 语言自动判定要在结束会话之后：只改模式，不重启识别实例 */
      applyAutoLang(transcript);
      status("识别完成", "ok");
      handleText(transcript);
    };
    rec.onerror = function (event) { handleRecognError(event && event.error); };
    rec.onend = function () {
      if (!state.listening) return;
      var self_stopped = state.suppress;   /* 我们自己 stop() 触发的 onend，不算「自动收尾」 */
      state.listening = false;
      state.speech = null;
      var b = $("voice-mic");
      if (b) b.dataset.on = "false";
      if (self_stopped || state.paused || !state.session) return;
      /* 移动端识别常在一次停顿后自动收尾：不当成故障，给「继续」而不是静默失败 */
      state.paused = true;
      setControls(true, true);
      status("已停止聆听，点「继续」接着说", "idle");
    };
    state.speech = rec;
    state.listening = true;
    state.paused = false;
    var btn = $("voice-mic");
    if (btn) btn.dataset.on = "true";
    setControls(true, false);
    status("正在听…", "busy");
    try { rec.start(); } catch (err) {
      endSession();
      status("语音启动失败", "warn");
      bot("语音启动失败（" + (err && err.message ? err.message : err) + "），请用输入框打字。");
      guideToTextInput();
    }
  }

  /* r65：前端不展示语言选择按钮 —— 按本轮识别出的用词自动判定语言，
     粤语用词（嘅/咗/唔/屋企…）判为粤语，其余中文判为普通话，下一轮聆听即用该语言。 */
  var HK_MARKERS = ["嘅", "咗", "喺", "係", "唔", "哋", "啲", "同埋", "点解", "乜", "咩", "而家", "屋企", "几多", "边度", "点样", "老豆", "妈咪", "返工", "倾偈"];

  function autoLangFor(text) {
    var t = String(text == null ? "" : text);
    if (!/[\u3400-\u9fff]/.test(t)) return null;
    for (var i = 0; i < HK_MARKERS.length; i++) if (t.indexOf(HK_MARKERS[i]) !== -1) return "zh-HK";
    return "zh-CN";
  }

  function applyAutoLang(text) {
    var mode = autoLangFor(text);
    if (!mode || mode === state.mode) return mode;
    state.mode = mode;
    var zh = $("voice-lang-zh"), hk = $("voice-lang-hk");
    if (zh) zh.setAttribute("aria-pressed", mode === "zh-CN" ? "true" : "false");
    if (hk) hk.setAttribute("aria-pressed", mode === "zh-HK" ? "true" : "false");
    var hint = $("voice-lang-hint");
    if (hint) hint.textContent = (mode === "zh-HK" ? "粤语" : "普通话") + "识别";
    return mode;
  }

  function setLang(mode) {
    state.mode = mode;
    var langLabel = mode === "zh-HK" ? "粤语" : "普通话";
    var zh = $("voice-lang-zh"), hk = $("voice-lang-hk");
    if (zh) zh.setAttribute("aria-pressed", mode === "zh-CN" ? "true" : "false");
    if (hk) hk.setAttribute("aria-pressed", mode === "zh-HK" ? "true" : "false");
    var hint = $("voice-lang-hint");
    if (hint) hint.textContent = langLabel + "识别";
    if (state.speech) {
      try { state.speech.lang = mode; } catch (ignored) { /* noop */ }
    }
    /* 语言按钮在聆听中也要真的生效：重启一个带新语言的识别实例（会话与已确认内容不变） */
    if (state.session && !state.paused) {
      stopListening(true);
      listen();
    }
  }

  function startListening() {
    if (!SpeechRecognitionImpl) {
      /* 无语音识别能力时也必须有明确反馈：提示 + 高亮输入框 + 聚焦，绝不静默 */
      bot("这个浏览器不支持语音识别，已切换为文字输入：把成员、收支、资产、负债、保险、教育或目标打进下面的输入框，我会逐项识别。");
      status("语音不可用，请用文字输入", "warn");
      guideToTextInput();
      return;
    }
    /* 会话进行中再点麦克风 = 暂停/继续（识别中图标为红色脉冲，语义一致） */
    if (state.session) { togglePause(); return; }
    /* 点击即视为用户同意本次会话使用麦克风（浏览器会再弹授权确认） */
    state.session = true;
    state.paused = false;
    state.retryUsed = false;
    state.suppress = false;
    bot("正在听…（可以点「暂停」歇一下、点「取消」放弃这次输入，也可以直接打字）");
    listen();
  }

  function pauseListening() {
    if (!state.session || state.paused) return;
    state.paused = true;
    clearRetry();
    stopListening(true);
    setControls(true, true);
    status("已暂停，点「继续」接着说", "warn");
  }

  function resumeListening() {
    if (!state.session || !state.paused) return;
    state.paused = false;
    listen();
  }

  function togglePause() {
    if (state.paused) resumeListening();
    else pauseListening();
  }

  /* 取消：丢弃本次会话（录音不落盘，识别结果也不保存） */
  function cancelSession(announce) {
    clearRetry();
    var rec = state.speech;
    if (rec) {
      try { rec.abort(); } catch (ignored) { /* noop */ }
    }
    endSession();
    status("已取消本次语音输入", "idle");
    if (announce) bot("已取消本次语音输入，刚才说的话没有保存。");
  }

  /* ------------------------------------------------------------ 初始化 */

  function bind() {
    var mic = $("voice-mic");
    if (mic) mic.addEventListener("click", startListening);

    var pauseBtn = $("voice-pause");
    if (pauseBtn) pauseBtn.addEventListener("click", togglePause);
    var cancelBtn = $("voice-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", function () { cancelSession(true); });

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
        /* Round 57：无语音识别环境下点击麦克风会写入一条引导气泡到 history，
           旧写法用 history.length 判定「是否已开始建档」，会让随后的开始按钮
           变成点不动的假按钮（问答不启动）。改判「问答是否真的开始过」。 */
        if (!state.interviewStarted) { state.draft = freshDraft(); welcome(); }
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
    /* Round 59：会话控件默认收起（HTML 里也带 hidden，双保险，避免出现假按钮） */
    setControls(false, false);
    /* Round 57：暴露「语音面板已就绪」标记。family-boot 是异步串行加载脚本的，
       脚本就位前点击「开始语音建立家庭档案」不会绑定任何行为；自动化验收与
       前端自检都需要一个确定的就绪信号，而不是靠 sleep 猜。 */
    try {
      if (document.documentElement && document.documentElement.classList) {
        document.documentElement.classList.add("voice-builder-ready");
      }
    } catch (ignored) { /* noop */ }
    var hint = $("voice-support-hint");
    if (hint) hint.textContent = supportText();
    var mic = $("voice-mic");
    if (mic && !SpeechRecognitionImpl) {
      /* 不真正 disabled（disabled 会吞掉点击、导致点击无任何反馈）；
         改为软禁用语义 + 点击引导文字输入 */
      mic.setAttribute("aria-disabled", "true");
      mic.setAttribute("aria-label", "当前浏览器不支持语音识别，点击改用文字输入");
      mic.dataset.unsupported = "true";
      mic.title = "当前浏览器不支持语音识别，点击可切换到文字输入";
      mic.classList.add("voice-mic-fallback");
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
