/* Verity 语音建档 · 中文自然语言理解与对话规划（Round 52）
 *
 * 纯逻辑模块，不依赖 DOM / 网络 / 语音 API：浏览器与 Node（测试）共用。
 * 职责：
 *   1. 把用户一句中文描述解析成「可确认的结构化事实」（成员/收支/资产/负债/保险/教育/目标）；
 *   2. 逐项复述待确认内容（echo），用户说「是/对」才写入草稿 —— 不得猜测用户没给的数据；
 *   3. 每次对话只补问一个最关键缺失项（nextQuestion）；
 *   4. 识别语音指令：上一题/我说错了/修改/稍后填写/保存退出/继续/运行家庭分析/查看摘要。
 *
 * 出错的语义：所有解析函数都返回「未命中」或「冲突」，宁可多问一遍，也不替用户假设。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.VerityVoiceNLU = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ------------------------------------------------------------ 中文数字 */

  var DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  var UNITS = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };
  var CN_CHARS = "零一二两三四五六七八九十百千万亿点";
  var UNIT_WORDS = "元块美元港币人民币新币％%";

  /* 「一百二十万」= 1,200,000；「十万」= 100,000；「一点五万」= 15,000；
     「两万五」按口语 = 25,000；「五千」= 5,000；「三十」= 30。 */
  function parseChineseNumber(text) {
    if (!text || typeof text !== "string") return null;
    var s = String(text).replace(/[，,]/g, "").trim();
    if (!s) return null;
    var total = 0, section = 0, digitVal = 0, lastBig = 0, prevUnit = 0;
    var trailingDigit = 0, sawSmallAfterBig = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (ch === "点") {
        var frac = 0, scale = 0.1;
        while (i + 1 < s.length && DIGITS[s[i + 1]] !== undefined) {
          frac += DIGITS[s[i + 1]] * scale;
          scale /= 10;
          i += 1;
        }
        var base = total + section + digitVal + frac;
        if (i + 1 < s.length && (s[i + 1] === "万" || s[i + 1] === "亿")) {
          var decimalUnit = s[i + 1] === "万" ? 10000 : 100000000;
          return base * decimalUnit;
        }
        return base;
      }
      if (ch === "零") continue;
      if (DIGITS[ch] !== undefined) {
        digitVal = DIGITS[ch];
        trailingDigit = lastBig ? digitVal : 0;
        continue;
      }
      if (UNITS[ch] !== undefined) {
        var unit = UNITS[ch];
        if (unit >= 10000) {
          section = (section + digitVal) * unit;
          total += section;
          section = 0;
          digitVal = 0;
          lastBig = unit;
          trailingDigit = 0;
          sawSmallAfterBig = false;
        } else {
          section += (digitVal === 0 ? 1 : digitVal) * unit;
          digitVal = 0;
          if (lastBig && unit < lastBig) sawSmallAfterBig = true;
        }
        prevUnit = unit;
        continue;
      }
      return null;
    }
    var result = total + section + digitVal;
    /* 口语尾数：两万五 = 25,000；三万二 = 32,000（仅当尾数直接跟在万/亿后且没有其他小单位） */
    if (lastBig && trailingDigit > 0 && !sawSmallAfterBig && section === 0 && digitVal > 0) {
      result += trailingDigit * (lastBig / 10) - trailingDigit;
    }
    return result;
  }

  var CN_COUNT = { 一个: 1, 两个: 2, 俩: 2, 三个: 3, 仨: 3, 四个: 4, 五个: 5, 六个: 6, 七个: 7, 八个: 8, 九个: 9, 十个: 10 };

  function parseCount(text) {
    var m = /(\d+)/.exec(text || "");
    if (m) return Number(m[1]);
    for (var k in CN_COUNT) {
      if (CN_COUNT.hasOwnProperty(k) && text.indexOf(k) >= 0) return CN_COUNT[k];
    }
    return null;
  }

  /* ------------------------------------------------------------ 币种 */

  var CURRENCIES = [
    { re: /(?:港币|港元|\bhkd\b)/i, code: "HKD", label: "港币" },
    { re: /(?:美元|美金|\busd\b)/i, code: "USD", label: "美元" },
    { re: /(?:新加坡元|新币|\bsgd\b)/i, code: "SGD", label: "新加坡元" },
    { re: /(?:人民币|\bcny\b|元|块)/i, code: "CNY", label: "人民币" },
  ];

  function parseCurrency(text) {
    if (!text) return null;
    for (var i = 0; i < CURRENCIES.length; i++) {
      if (CURRENCIES[i].re.test(text)) return { code: CURRENCIES[i].code, label: CURRENCIES[i].label };
    }
    return null;
  }

  /* ------------------------------------------------------------ 金额抽取（限定关键词后的小窗口，避免跨句误捡） */

  function amountAfter(text, from) {
    var slice = String(text).slice(from, from + 24);
    var m = new RegExp(
      "^[^0-9" + CN_CHARS + "]{0,6}(?:大概|大约|估计|预计|是|为|有|约|还|欠|存了|已存|准备|准备了|每月存|应该|目前|现在|一共|总共|差不多|大概有|约有)*" +
      "((?:\\d+(?:\\.\\d+)?)|(?:[" + CN_CHARS + "]+))" +
      "(万|亿|元|块|美元|港币|人民币|新币|岁|％|%)?",
      ""
    ).exec(slice);
    if (!m) return null;
    var rawNum = m[1], suffix = m[3] || "";
    var value;
    if (/^\d/.test(rawNum)) {
      value = Number(rawNum) * (suffix === "万" ? 10000 : suffix === "亿" ? 100000000 : 1);
    } else {
      var parsed = parseChineseNumber(rawNum);
      if (parsed === null) return null;
      value = parsed;
    }
    if (!Number.isFinite(value) || value < 0) return null;
    return { value: value, raw: m[0].replace(/[，,]/g, "").trim() };
  }

  /* patterns 下所有命中位置之后的金额 */
  function amountsBeside(text, pattern) {
    var re = new RegExp(pattern.source, "g");
    var out = [];
    var m;
    while ((m = re.exec(text)) !== null) {
      var amt = amountAfter(text, m.index + m[0].length);
      if (amt) out.push({ value: amt.value, raw: amt.raw, index: m.index, keyword: m[0], after: amt });
      if (m.index === re.lastIndex) re.lastIndex += 1;
    }
    return out;
  }

  function percentOf(text) {
    if (!text) return null;
    var m = /(\d+(?:\.\d+)?)\s*%/.exec(text);
    if (m) return Number(m[1]) / 100;
    var c = /百分之([零一二两三四五六七八九十]+)/.exec(text);
    if (c && c[1]) {
      var p = parseChineseNumber(c[1]);
      if (p !== null) return p / 100;
    }
    return null;
  }

  /* 在包含 pattern 命中的那个子句里找百分比（如「利率百分之三，月供八千」） */
  function rateNear(text, pattern) {
    if (!text) return null;
    var clauses = String(text).split(/[，,。；;]/);
    for (var i = 0; i < clauses.length; i++) {
      var m = new RegExp(pattern.source).exec(clauses[i]);
      if (!m) continue;
      var r = percentOf(clauses[i]);
      if (r !== null) return r;
    }
    return null;
  }

  /* 在包含 pattern 命中的那个子句（按逗号/句号切分）里找百分比，避免跨子句误捡 */
  function percentNear(text, pattern) {
    if (!text) return null;
    var clauses = String(text).split(/[，,。；;]/);
    for (var i = 0; i < clauses.length; i++) {
      var m = new RegExp(pattern.source).exec(clauses[i]);
      if (!m) continue;
      var r = percentOf(clauses[i]);
      if (r !== null) return r;
    }
    return null;
  }

  function periodOf(text) {
    if (!text) return null;
    if (/(每月|每个月|月度)/.test(text)) return { period: "monthly", label: "每月" };
    if (/(每年|每年度)/.test(text)) return { period: "annual", label: "每年" };
    if (/(一次性|一次|现付)/.test(text)) return { period: "one_off", label: "一次性" };
    return null;
  }

  /* ------------------------------------------------------------ 实体词表 */

  var ASSET_RULES = [
    { re: /(?:活期|存款|现金|银行|货币基金)/, kind: "cash", label: "现金与存款" },
    { re: /(?:债券|固收|国债|债基)/, kind: "bond", label: "债券与固收" },
    { re: /(?:指数基金|宽基|沪深300|标普500|纳斯达克|指数投资)/, kind: "global_index", label: "全球指数基金" },
    { re: /(?:股票|权益基金|混合基金|主动基金|基金)/, kind: "equity", label: "股票与权益基金" },
    { re: /(?:黄金)/, kind: "gold", label: "黄金" },
    { re: /(?:期权保护|保护性头寸|对冲)/, kind: "option_protection", label: "期权保护头寸" },
    { re: /(?:保险连结|投连险|分红险|年金险)/, kind: "insurance_linked", label: "保险连结资产" },
    { re: /(?:房子|房产|自住房|商铺|店面|汽车|车子|公司股权|企业股权|经营资产)/, kind: "illiquid", label: "非流动/无法动用资产" },
  ];

  var LIABILITY_RULES = [
    { re: /(?:房贷|按揭|楼贷)/, kind: "mortgage", label: "房贷" },
    { re: /(?:消费贷|信用贷|信用卡|花呗|借呗)/, kind: "consumer", label: "消费贷/信用卡" },
    { re: /(?:融资|保证金|配资|杠杆)/, kind: "margin", label: "融资/保证金" },
    { re: /(?:学贷|教育贷|学生贷款)/, kind: "student", label: "教育贷款" },
    { re: /(?:其他|其它|借款|欠款|外债)/, kind: "other", label: "其他负债" },
  ];

  var PROTECTION_RULES = [
    { re: /(?:定期寿险|寿险|人寿|身故保障)/, kind: "life", label: "寿险" },
    { re: /(?:重疾险|重疾|大病险)/, kind: "critical_illness", label: "重疾险" },
    { re: /(?:医疗险|医疗|百万医疗|住院|医保补充)/, kind: "medical", label: "医疗险" },
    { re: /(?:意外险|意外)/, kind: "accident", label: "意外险" },
  ];

  var ROLES = [
    { re: /(?:爸爸|老公|丈夫|先生|父亲|我自己|我本人|顶梁柱|我)/, key: "primary", label: "主要收入" },
    { re: /(?:妈妈|老婆|妻子|太太|母亲)/, key: "secondary", label: "次要收入" },
    { re: /(?:孩子|儿子|女儿|小孩|子女|老大|老二|宝宝|娃|儿子女儿)/, key: "child", label: "受抚养成员" },
  ];

  /* 找出离关键词最近的成员角色（用于收入/年龄归属） */
  function whoNear(text, keywordIndex) {
    var best = null, bestDist = 1e9;
    ROLES.forEach(function (role) {
      var re = new RegExp(role.re.source, "g");
      var m;
      while ((m = re.exec(text)) !== null) {
        var dist = Math.abs(m.index - keywordIndex);
        if (m.index < keywordIndex && dist < bestDist) {
          bestDist = dist;
          best = role.key;
        }
      }
    });
    return best || "primary";
  }

  /* ------------------------------------------------------------ 指令 */

  function commandOf(text) {
    var t = String(text || "").trim();
    if (/^(上一题|上一步|返回|回去|退回|回到上一题)/.test(t)) return "PREV";
    if (/(我说错了|说错了|我说错|改一下|修改|纠正|错了|不对|不是这个|重说)/.test(t)) return "CORRECT";
    if (/(稍后|以后再说|跳过|算了|先不填|先跳过|这题先跳过)/.test(t)) return "SKIP";
    if (/(保存退出|保存并退出|保存|存好|退出建档|结束建档|完成建档|建档完成)/.test(t)) return "SAVE";
    if (/(运行家庭分析|运行分析|开始分析|出结果|跑一下|运行引擎|分析一下)/.test(t)) return "RUN";
    if (/(继续|接着|继续上次|上次还没|继续建档|继续语音)/.test(t)) return "RESUME";
    if (/(查看摘要|摘要|我填了什么|知道了什么|看到了什么|了解一下)/.test(t)) return "SUMMARY";
    if (/(重来|重新开始|清空)/.test(t)) return "RESET";
    return null;
  }

  /* ------------------------------------------------------------ 事实抽取（主入口） */


  function extractFacts(text, meta) {
    var out = [];
    var t = String(text || "");
    var command = commandOf(t);
    if (command) return { command: command, facts: [] };
    var currency = parseCurrency(t) || (meta && meta.currency ? { code: meta.currency } : null);
    var cc = currency ? currency.code : (meta ? meta.currency : null);

    /* —— 档案名称（「就叫我们家 2026」「名字叫李家的家」）。
       必须在金额/年份规则之前：名称句常混入年份或金额，
       晚探测会被拆成 unclassified_amount，导致「档案名称」
       这一问永远没有语音入口可答（Round 55 恢复后测出）。 */
    var tTrim = String(t).replace(/[\uff0c,\u3002.\uff01!\uff1f?~\uff5e\u3001\s]+$/g, "").trim();
    var tLead = tTrim.replace(/^[\s\uff1a:\u300c\u300d“”‘’]+/, "");
    var nameRe = /(?:\u5c31?\u53eb|\u540d\u5b57(?:\u53eb|\u662f|\u4e3a)|\u6863\u6848(?:\u53eb|\u540d\u5b57\u662f|\u540d(?:\u5b57)?\u4e3a)|\u8d77\u540d|\u547d\u540d\u4e3a?|\u53d6\u540d\u4e3a?|\u6539\u6210|\u6539\u53eb|\u6635\u79f0(?:\u53eb|\u662f))\s*(.+?)(?:\u5427|\u4e86|\u54e6|\u54c8|\u5c31\u597d|\u5c31\u884c|\u597d\u4e0d\u597d|\u53ef\u4ee5\u5417)?$/;
    var nameMatch = nameRe.exec(tLead);
    if (nameMatch) {
      var rawName = String(nameMatch[1] || "").trim()
        .replace(/(?:\u5427|\u4e86|\u54e6|\u54c8|\u5c31\u597d|\u5c31\u884c|\u597d\u4e0d\u597d|\u53ef\u4ee5\u5417|\u5bf9\u5427)$/g, "").trim();
      if (rawName && rawName.length >= 1 && rawName.length <= 40 && !/^(\u5bf9|\u662f|\u597d\u7684|\u53ef\u4ee5|\u884c|\u55ef|\u6ca1\u95ee\u9898|\u786e\u5b9a)$/.test(rawName)) {
        out.push({ type: "profile_name", name: rawName, raw: String(t) });
      }
    }

    /* —— 成员：人数（全局匹配，支持「两个大人一个孩子」一次报全） —— */
    var adults = null, children = null;
    var countRe = /(?:有|一共|总共|家里)?\s*((?:\d+)|\d*[一两两三四五六七八九十]+(?:个)?个?)\s*(大人|成人|成年人|小孩|孩子|子女|娃|老人)/g;
    var cm;
    while ((cm = countRe.exec(t)) !== null) {
      var n = parseCount(cm[1]);
      if (n === null) continue;
      if (cm[2] === "小孩" || cm[2] === "孩子" || cm[2] === "子女" || cm[2] === "娃") children = (children || 0) + n;
      else adults = (adults || 0) + n;
    }

    if (adults !== null || children !== null) {
      out.push({ type: "members", adults: adults, children: children });
    }

    /* —— 成员：年龄段句（如「我三十六岁」「孩子三岁」） —— */
    ROLES.forEach(function (role) {
      var re = new RegExp(role.re.source + "[^0-9" + CN_CHARS + "]{0,4}(?:是|今年|已经)?\\s*((?:\\d+(?:\\.\\d+)?)|[" + CN_CHARS + "]{1,4})岁", "");
      var m = re.exec(t);
      if (!m) return;
      var age;
      if (/^\d/.test(m[1])) age = Number(m[1]);
      else age = parseChineseNumber(m[1]);
      if (age !== null && age > 0 && age <= 120) {
        out.push({ type: "member_age", who: role.key, age: age, label: role.label + "成员", raw: m[0] });
      }
    });

    /* —— 成员：收入（「我月收入三万」/「年收入五十万」） —— */
    var incomeRe = /(?:的)?(?:年收入|年薪|月收入|月薪|月入|月工资|工资|薪资|收入)/;
    var incHits = amountsBeside(t, incomeRe);
    incHits.forEach(function (hit) {
      var who = whoNear(t, hit.index);
      var p = periodOf(t);
      if (!p && /(?:年收入|年薪)/.test(t)) p = { period: "annual" };
      if (!p && /(?:月收入|月薪|月入|月工资)/.test(t)) p = { period: "monthly" };
      out.push({
        type: "member_income", who: who, amount: hit.value, raw_amount: hit.raw,
        period: p ? p.period : null, label: "收入", currency: cc,
      });
    });

    /* —— 支出（必要/可选） —— */
    var essential = /(?:必要|刚性|基本|生活|全家|家庭)?(?:支出|开销|花费|花销|生活费)/.test(t) && !/(?:可选|娱乐|旅游|可压缩|非必需|享受)/.test(t);
    var discretionary = /(?:可选|娱乐|旅游|可压缩|非必需|享受)/.test(t) && /(?:支出|开销|花费)/.test(t);
    if (essential || discretionary) {
      var expHits = amountsBeside(t, /(?:支出|开销|花费|花销|生活费)/);
      expHits.forEach(function (hit) {
        var p = periodOf(t);
        if (!p && /年/.test(t.slice(Math.max(0, hit.index - 4), hit.index + 2))) p = { period: "annual" };
        out.push({
          type: "expense", essential: essential && !discretionary, amount: hit.value, raw_amount: hit.raw,
          period: p ? p.period : null, label: "家庭支出", currency: cc,
        });
      });
    }
    if (essential && !expHits.length) {
      var anyExp = amountAfter(t, 0);
      if (anyExp) out.push({ type: "expense", essential: true, amount: anyExp.value, raw_amount: anyExp.raw, period: null, label: "家庭支出", currency: cc });
    }

    /* —— 一次性大额支出 —— */
    if (/(?:一次性|未来|几年后|三年后|五年后|十年后|到时候|将来)/.test(t) && /(?:学费|支出|费用|用钱|教育金|买房|装修|婚礼|购车)/.test(t)) {
      var outHits = amountsBeside(t, /(?:学费|支出|费用|教育金|买房|装修|婚礼|购车)/);
      outHits.forEach(function (hit) {
        out.push({ type: "outflow", amount: hit.value, raw_amount: hit.raw, label: "一次性大额支出", currency: cc });
      });
    }

    /* —— 资产（每种资产各取一笔，支持一句里报多项） —— */
    ASSET_RULES.forEach(function (rule) {
      var hits = amountsBeside(t, rule.re);
      hits.forEach(function (hit) {
        if (/(?:保险|保费|保额)/.test(hit.keyword)) return;
        out.push({ type: "asset", kind: rule.kind, amount: hit.value, raw_amount: hit.raw, label: rule.label, currency: cc });
      });
    });

    /* —— 负债 —— */
    LIABILITY_RULES.forEach(function (rule) {
      if (!rule.re.test(t)) return;
      var isBalance = /(?:欠|余额|还剩|还欠|未还|贷款|贷款余额)/.test(t);
      var balHits = amountsBeside(t, /(?:欠|还欠|余额|还剩|未还|贷款)/);
      var bal = balHits.length ? balHits[balHits.length - 1].value : null;
      if (bal === null) {
        var any = amountAfter(t, t.indexOf(rule.label[0] >= 0 ? t.indexOf("贷") : 0));
        bal = any ? any.value : null;
      }
      if (bal === null) {
        var probe = amountsBeside(t, rule.re);
        bal = probe.length ? probe[0].value : null;
      }
      var rate = rateNear(t, /(?:利率|年化|利息|百分比)/);
      var payHits = amountsBeside(t, /(?:月供|每月还|每个月还|月还款|月付)/);
      var payment = payHits.length ? payHits[0].value : null;
      if (bal !== null || payment !== null) {
        out.push({
          type: "liability", kind: rule.kind, label: rule.label,
          balance: bal === null ? 0 : bal, rate: rate, payment: payment,
          period: payment !== null ? "monthly" : null,
          raw_amount: bal !== null ? String(bal) : null, currency: cc,
        });
      }
    });

    /* —— 保险 —— */
    var protKinds = [];
    PROTECTION_RULES.forEach(function (p) { if (p.re.test(t)) protKinds.push(p.kind); });
    if (protKinds.length) {
      var covHits = amountsBeside(t, /(?:保额|保障|额度|赔付|赔)/);
      var premHits = amountsBeside(t, /(?:保费|一年交|每年交|缴费|交了)/);
      var coverage = covHits.length ? covHits[0].value : null;
      var premium = premHits.length ? premHits[0].value : null;
      if (coverage === null && premium === null) {
        var protAmt = amountAfter(t, t.indexOf(protKinds[0] !== null ? "险" : "险"));
        coverage = protAmt ? protAmt.value : null;
      }
      if (coverage !== null || premium !== null) {
        out.push({
          type: "protection", kinds: protKinds, coverage: coverage, premium: premium,
          raw_amount: (covHits[0] || premHits[0] || {}).raw || null, currency: cc, label: "保险",
        });
      }
    }

    /* —— 教育计划 —— */
    if (/(?:教育|学费|读书|上学|留学|大学|幼儿园|小学|中学)/.test(t)) {
      var edu = { type: "education" };
      var costHits = amountsBeside(t, /(?:学费|费用|预计|需要|大学)/);
      var saveHits = amountsBeside(t, /(?:已存|存了|现有|准备|准备了|储备)/);
      var monthHits = amountsBeside(t, /(?:每月存|每月投|定投|每月)/);
      if (costHits.length) { edu.expected_cost = costHits[0].value; edu.raw_amount = costHits[0].raw; }
      if (saveHits.length) edu.current_savings = saveHits[0].value;
      if (monthHits.length) edu.monthly_investment = monthHits[0].value;
      var ty = /(?:目标|上大学|入学)?\s*(20\d{2})\s*年/.exec(t);
      if (ty) edu.target_year = Number(ty[1]);
      if (edu.expected_cost !== undefined || edu.current_savings !== undefined || edu.monthly_investment !== undefined || edu.target_year) {
        out.push(edu);
      }
    }

    /* —— 目标参数 —— */
    if (/(?:投资|持有|计划)?\s*(?:期限|年数|几年|多久|投资多少年)/.test(t) || /[投资投打算持有计划]\s*(?:个|)?.{0,2}年/.test(t)) {
      var yrs = /(\d{1,2})\s*年/.exec(t);
      var cnYrs = /[投资投打算持有计划][^0-9]{0,3}([一二两三四五六七八九十]{1,2})年/.exec(t);
      if (yrs) out.push({ type: "goal", horizon_years: Number(yrs[1]), label: "投资期限" });
      else if (cnYrs) {
        var hv = parseChineseNumber(cnYrs[1]);
        if (hv !== null && hv > 0 && hv <= 60) out.push({ type: "goal", horizon_years: hv, label: "投资期限" });
      }
    }
    if (/(?:目标收益|年化收益|年化回报|回报率|收益率|预期收益|目标年化)/.test(t)) {
      var r = percentNear(t, /(?:收益|回报|收益率|年化)/);
      if (r === null) r = percentOf(t);
      if (r !== null) out.push({ type: "goal", target_return: r, label: "目标收益" });
    }
    if (/(?:最大亏损|能接受亏|可承受损失|亏损容忍|回撤|最多亏)/.test(t)) {
      var lr = percentNear(t, /(?:亏损|损失|回撤|最多亏|能接受亏)/);
      if (lr === null) lr = percentOf(t);
      if (lr !== null) out.push({ type: "goal", tolerance: lr, label: "亏损容忍" });
    }

    if (!out.length) {
      var lonely = amountAfter(t, 0);
      if (lonely) out.push({ type: "unclassified_amount", amount: lonely.value, raw_amount: lonely.raw });
    }
    return { command: null, facts: out };
  }

  function isConfirm(text) { return /^(是|对|对的|没错|确认|可以|对呀|对的呀|嗯|是的是的|没问题|确定|好|好的|行|确认无误)$/.test(String(text || "").trim()); }
  function isDeny(text) {
    var t = String(text || "").trim();
    return /^(不|不是|不对|错了|没有|否|不对吧|再想想)/.test(t) || /(不是这个|我说错了|不对的|不是的)/.test(t);
  }

  /* ------------------------------------------------------------ 回显（逐项复述，确认后才写入） */

  function moneyCn(value, currency) {
    var label = { CNY: "元", HKD: "港币", USD: "美元", SGD: "新加坡元" }[currency] || "元";
    var v = Number(value);
    if (!Number.isFinite(v)) return "";
    var trim = function (x) { return String(Number(x.toFixed(2))); };
    if (v >= 100000000) return trim(v / 100000000) + "亿" + label;
    if (v >= 10000) return trim(v / 10000) + "万" + label;
    return Math.round(v).toLocaleString("zh-CN") + label;
  }

  function periodCn(p) {
    return p === "monthly" ? "每月" : p === "annual" ? "每年" : p === "one_off" ? "一次性" : "";
  }

  var WHO_CN = { primary: "主要收入成员", secondary: "次要收入成员", child: "受抚养成员" };

  function echoFact(fact) {
    if (!fact) return "";
    switch (fact.type) {
      case "profile_name":
        return "档案名称「" + String(fact.name || "") + "」";
      case "members":
        return (fact.adults !== null ? fact.adults + " 位大人" : "") + (fact.children !== null ? (fact.adults !== null ? "、" : "") + fact.children + " 位受抚养成员" : "");
      case "member_age":
        return WHO_CN[fact.who] + " " + fact.age + " 岁";
      case "member_income":
        return WHO_CN[fact.who] + " " + periodCn(fact.period) + "收入 " + moneyCn(fact.amount, fact.currency);
      case "expense":
        return (fact.essential ? "必要支出" : "可选支出") + (fact.period ? " " + periodCn(fact.period) : "") + " " + moneyCn(fact.amount, fact.currency);
      case "outflow":
        return fact.label + " " + moneyCn(fact.amount, fact.currency);
      case "asset":
        return "资产·" + fact.label + " " + moneyCn(fact.amount, fact.currency);
      case "liability": {
        var lb = "负债·" + fact.label + " 余额 " + moneyCn(fact.balance, fact.currency);
        if (fact.rate !== null && fact.rate !== undefined && fact.rate > 0) lb += "，利率 " + (fact.rate * 100).toFixed(1) + "%";
        if (fact.payment) lb += "，月供 " + moneyCn(fact.payment, fact.currency);
        return lb;
      }
      case "protection": {
        var names = fact.kinds.map(function (k) {
          var hit = null;
          PROTECTION_RULES.forEach(function (p) { if (p.kind === k) hit = p.label; });
          return hit || k;
        }).join("、");
        return "保险·" + names + (fact.coverage !== null && fact.coverage !== undefined ? "，保额 " + moneyCn(fact.coverage, fact.currency) : "") +
          (fact.premium !== null && fact.premium !== undefined ? "，年保费 " + moneyCn(fact.premium, fact.currency) : "");
      }
      case "education": {
        var parts = ["教育计划"];
        if (fact.expected_cost !== undefined) parts.push("预期费用 " + moneyCn(fact.expected_cost, fact.currency));
        if (fact.current_savings !== undefined) parts.push("已准备 " + moneyCn(fact.current_savings, fact.currency));
        if (fact.monthly_investment !== undefined) parts.push("每月投入 " + moneyCn(fact.monthly_investment, fact.currency));
        if (fact.target_year) parts.push("目标年份 " + fact.target_year);
        return parts.join("，");
      }
      case "goal": {
        var bits = [];
        if (fact.horizon_years !== undefined) bits.push("投资期限 " + fact.horizon_years + " 年");
        if (fact.target_return !== undefined) bits.push("目标年化 " + (fact.target_return * 100).toFixed(1) + "%");
        if (fact.tolerance !== undefined) bits.push("可承受最大亏损 " + (fact.tolerance * 100).toFixed(1) + "%");
        return bits.join("，");
      }
      case "unclassified_amount":
        return "收到金额 " + moneyCn(fact.amount, null) + "（不确定属于哪一项，麻烦补充说明一下）";
      default:
        return "";
    }
  }

  /* ------------------------------------------------------------ 草稿装配（用户确认后才调用） */

  function emptyMembers() {
    return { member_id: "adult_1", age: 0, role: "primary_earner", dependents: 0, annual_income: 0, income_stability: "medium" };
  }

  function nextProfileId(profile_id) {
    return ((profile_id || "FAMILY") + "_" + Date.now().toString(36)).replace(/[^A-Za-z0-9_\-]/g, "_");
  }

  function liquidityOf(kind) {
    var map = {
      cash: "immediate", bond: "near", global_index: "near", equity: "near", gold: "near",
      option_protection: "near", insurance_linked: "cannot_touch", illiquid: "cannot_touch",
    };
    return map[kind] || "near";
  }

  function applyToDraft(draft, fact) {
    if (!fact) return draft;
    switch (fact.type) {
      case "members": {
        draft.members = draft.members || [];
        var adults = fact.adults === null ? draft.members.filter(function (m) { return m.role !== "dependent"; }).length : fact.adults;
        var children = fact.children === null ? draft.members.filter(function (m) { return m.role === "dependent"; }).length : fact.children;
        draft.members = [];
        for (var a = 0; a < adults; a++) {
          draft.members.push({ member_id: "adult_" + (a + 1), age: 0, role: a === 0 ? "primary_earner" : "secondary_earner", dependents: 0, annual_income: 0, income_stability: "medium" });
        }
        for (var c = 0; c < children; c++) {
          draft.members.push({ member_id: "child_" + (c + 1), age: 0, role: "dependent", dependents: 1, annual_income: 0, income_stability: "medium" });
        }
        break;
      }
      case "member_age": {
        draft.members = draft.members || [];
        if (fact.who === "child") {
          var childRow = null;
          draft.members.forEach(function (m) { if (m.role === "dependent" && !childRow) childRow = m; });
          if (!childRow) {
            childRow = { member_id: "child_1", age: 0, role: "dependent", dependents: 1, annual_income: 0, income_stability: "medium" };
            draft.members.push(childRow);
          }
          childRow.age = fact.age;
        } else {
          var idx = fact.who === "primary" ? 0 : draft.members.length > 1 ? 1 : 0;
          if (!draft.members.length) draft.members.push(emptyMembers());
          draft.members[idx].age = fact.age;
        }
        break;
      }
      case "member_income": {
        draft.members = draft.members || [emptyMembers()];
        var whoIdx = fact.who === "primary" ? 0 : fact.who === "secondary" ? (draft.members.length > 1 ? 1 : 0) : Math.min(1, draft.members.length - 1);
        if (!draft.members[whoIdx]) draft.members[whoIdx] = emptyMembers();
        var annual = fact.period === "monthly" ? fact.amount * 12 : fact.amount;
        draft.members[whoIdx].annual_income = Number(draft.members[whoIdx].annual_income || 0) + annual;
        break;
      }
      case "expense": {
        var amount = fact.period === "monthly" ? fact.amount * 12 : fact.amount;
        if (fact.essential) draft.annual_expenses_essential = Number(draft.annual_expenses_essential || 0) + amount;
        else draft.annual_expenses_discretionary = Number(draft.annual_expenses_discretionary || 0) + amount;
        break;
      }
      case "outflow": {
        draft.future_rigid_outflows = draft.future_rigid_outflows || [];
        draft.future_rigid_outflows.push({ outflow_id: nextProfileId(draft.profile_id), label: "语音记录·" + (fact.label || "大额支出"), amount: fact.amount, years_until_due: 5 });
        break;
      }
      case "asset": {
        draft.assets = draft.assets || [];
        var existing = draft.assets.find(function (a) { return a.kind === fact.kind; });
        if (existing) existing.value = Number(existing.value || 0) + fact.amount;
        else draft.assets.push({
          asset_id: nextProfileId(draft.profile_id) + "_" + fact.kind,
          kind: fact.kind, value: fact.amount, liquidity: liquidityOf(fact.kind), note: "", currency: fact.currency || draft.currency || "CNY",
        });
        break;
      }
      case "liability": {
        draft.liabilities = draft.liabilities || [];
        var found = draft.liabilities.find(function (l) { return l.kind === fact.kind; });
        if (found) {
          found.balance = Number(found.balance || 0) + fact.balance;
          if (fact.rate !== null && fact.rate !== undefined && fact.rate > 0) found.annual_rate = fact.rate;
          if (fact.payment) found.mandatory_payment = Number(found.mandatory_payment || 0) + fact.payment;
        } else {
          draft.liabilities.push({
            liability_id: nextProfileId(draft.profile_id) + "_" + fact.kind,
            kind: fact.kind, balance: Number(fact.balance || 0),
            annual_rate: fact.rate !== null && fact.rate !== undefined && fact.rate > 0 ? fact.rate : 0,
            mandatory_payment: fact.payment || 0,
          });
        }
        break;
      }
      case "protection": {
        draft.protection = draft.protection || [];
        fact.kinds.forEach(function (kind) {
          var hit = draft.protection.find(function (p) { return p.kind === kind; });
          if (hit) {
            if (fact.coverage !== null && fact.coverage !== undefined) hit.coverage = Number(hit.coverage || 0) + fact.coverage;
            if (fact.premium !== null && fact.premium !== undefined) hit.annual_premium = Number(hit.annual_premium || 0) + fact.premium;
          } else {
            draft.protection.push({
              protection_id: nextProfileId(draft.profile_id) + "_" + kind,
              kind: kind,
              coverage: fact.coverage === null || fact.coverage === undefined ? 0 : fact.coverage,
              annual_premium: fact.premium === null || fact.premium === undefined ? 0 : fact.premium,
              exclusions: [],
            });
          }
        });
        break;
      }
      case "profile_name": {
        var nm = String(fact.name || "").trim().slice(0, 40);
        if (nm) draft.profile_id = nm;
        break;
      }
      case "education": {
        draft.education_plan = draft.education_plan || {};
        if (fact.expected_cost !== undefined) draft.education_plan.expected_cost = fact.expected_cost;
        if (fact.current_savings !== undefined) draft.education_plan.current_savings = fact.current_savings;
        if (fact.monthly_investment !== undefined) draft.education_plan.monthly_investment = fact.monthly_investment;
        if (fact.target_year) draft.education_plan.target_year = fact.target_year;
        break;
      }
      case "goal": {
        if (fact.horizon_years !== undefined) draft.investment_horizon_years = fact.horizon_years;
        if (fact.target_return !== undefined) draft.target_annual_return = fact.target_return;
        if (fact.tolerance !== undefined) draft.max_tolerable_loss_pct = fact.tolerance;
        break;
      }
      default:
        break;
    }
    return draft;
  }

  /* ------------------------------------------------------------ 逐项补问（一次一问） */

  var QUESTIONS = [
    { key: "profile_id", ask: function () { return "先给这份家庭档案起个名字吧，比如「我们家 2026」。"; } },
    { key: "members_count", ask: function () { return "家里有几口人？比如「两个大人、一个孩子」。"; } },
    { key: "members_age", ask: function (draft) {
      var member = (draft.members || []).find(function (m) { return m.age <= 0; });
      var who = member && member.role === "dependent" ? "孩子/受抚养成员" : (member && member.role === "secondary_earner" ? "另一位大人" : "你");
      return who + "今年多大年纪？（说数字加“岁”，或者直接说“这题先跳过”）";
    } },
    { key: "income", ask: function () { return "家里每月或每年收入大概多少？比如「我月收入三万」。没有固定收入就说「稍后填写」。"; } },
    { key: "expense_essential", ask: function () { return "家里平时每月或每年大概花多少钱？比如「每月生活费两万」。"; } },
    { key: "expense_discretionary", ask: function () { return "有没有娱乐、旅游这类可选开销？比如说个数，没有就说「没有」。"; } },
    { key: "assets_cash", ask: function () { return "现在现金和存款大概有多少？比如「存款五十万」。"; } },
    { key: "assets_other", ask: function () { return "还有债券、指数基金、股票、黄金这些投资吗？可以说「股票三十万」，没有就说「没有」。"; } },
    { key: "assets_illiquid", ask: function () { return "房产、车子或公司股权这类不好动用的资产大约值多少？比如「自住房两百万」，没有就说「没有」。"; } },
    { key: "liabilities", ask: function () { return "有房贷、车贷或其他欠款吗？比如「房贷还欠一百二十万，月供八千」。没有就说「没有」。"; } },
    { key: "protection", ask: function () { return "全家有哪些保险？可以说「重疾险保额五十万，一年保费一万」。没有就说「没有」。"; } },
    { key: "education", ask: function (draft) {
      var hasChild = (draft.members || []).some(function (m) { return m.role === "dependent" || m.dependents > 0; });
      return hasChild ? "孩子将来上学的钱有打算吗？比如「大学学费预计四十万，已经存了十万」。没有就说「没有」。"
                      : "有需要准备的教育金吗？没有就说「没有」。";
    } },
    { key: "outflows", ask: function () { return "未来几年有没有一次性的大额用钱计划？比如「三年后孩子留学要五十万」。没有就说「没有」。"; } },
    { key: "goal_horizon", ask: function () { return "这笔钱打算投资多少年？比如「十年」。"; } },
    { key: "goal_return", ask: function () { return "你期望的年化收益是多少？比如「年化百分之五」。"; } },
    { key: "goal_tolerance", ask: function () { return "能接受的最大亏损是多少？比如「百分之十五」。"; } },
  ];

  function isFulfilled(draft, key) {
    if (!draft) return false;
    switch (key) {
      case "profile_id": return !!(draft.profile_id || "").trim();
      case "members_count": return (draft.members || []).length > 0;
      case "members_age": return (draft.members || []).length > 0 && (draft.members || []).every(function (m) { return m.age > 0; });
      case "income": return (draft.members || []).some(function (m) { return Number(m.annual_income || 0) > 0; }) || draft._skip_income === true;
      case "expense_essential": return Number(draft.annual_expenses_essential || 0) > 0;
      case "expense_discretionary": return Number(draft.annual_expenses_discretionary || 0) > 0 || draft._no_discretionary === true;
      case "assets_cash": return (draft.assets || []).some(function (a) { return a.kind === "cash" && a.value > 0; }) || draft._no_assets === true;
      case "assets_other": return (draft.assets || []).some(function (a) { return a.kind !== "cash" && a.kind !== "illiquid" && a.value > 0; }) || draft._no_assets === true;
      case "assets_illiquid": return (draft.assets || []).some(function (a) { return a.kind === "illiquid"; }) || draft._no_assets === true;
      case "liabilities": return (draft.liabilities || []).length > 0 || draft._no_liabilities === true;
      case "protection": return (draft.protection || []).length > 0 || draft._no_protection === true;
      case "education": return !!(draft.education_plan && (draft.education_plan.expected_cost !== undefined || draft.education_plan.current_savings !== undefined || draft.education_plan.monthly_investment !== undefined)) || draft._no_education === true;
      case "outflows": return (draft.future_rigid_outflows || []).length > 0 || draft._no_outflows === true;
      case "goal_horizon": return Number(draft.investment_horizon_years || 0) > 0;
      case "goal_return": return Number(draft.target_annual_return || 0) > 0;
      case "goal_tolerance": return Number(draft.max_tolerable_loss_pct || 0) > 0;
      default: return true;
    }
  }

  function nextQuestion(draft, asked) {
    for (var i = 0; i < QUESTIONS.length; i++) {
      var q = QUESTIONS[i];
      if (asked.indexOf(q.key) >= 0) continue;
      if (!isFulfilled(draft, q.key)) return { key: q.key, question: q.ask(draft) };
    }
    return null;
  }

  function markNegated(draft, key) {
    switch (key) {
      case "income": draft._skip_income = true; break;
      case "expense_discretionary": draft._no_discretionary = true; break;
      case "assets_cash":
      case "assets_other":
      case "assets_illiquid": draft._no_assets = true; break;
      case "liabilities": draft._no_liabilities = true; break;
      case "protection": draft._no_protection = true; break;
      case "education": draft._no_education = true; break;
      case "outflows": draft._no_outflows = true; break;
      default: break;
    }
  }

  /* ------------------------------------------------------------ 摘要（已了解的家庭情况） */

  function summaryFacts(draft) {
    var items = [];
    if (!draft) return items;
    var name = (draft.profile_id || "").trim();
    if (name) items.push("档案「" + name + "」");
    var members = draft.members || [];
    if (members.length) {
      var adults = members.filter(function (m) { return m.role !== "dependent"; }).length;
      var children = members.filter(function (m) { return m.role === "dependent"; }).length;
      var parts = [];
      if (adults) parts.push(adults + " 位大人");
      if (children) parts.push(children + " 位孩子");
      items.push("成员：" + parts.join("、"));
    }
    var totalIncome = members.reduce(function (s, m) { return s + Number(m.annual_income || 0); }, 0);
    if (totalIncome > 0) items.push("年收入 " + moneyCn(totalIncome, draft.currency));
    if (Number(draft.annual_expenses_essential || 0) > 0) items.push("必要支出 " + moneyCn(draft.annual_expenses_essential, draft.currency) + "/年");
    if (Number(draft.annual_expenses_discretionary || 0) > 0) items.push("可选支出 " + moneyCn(draft.annual_expenses_discretionary, draft.currency) + "/年");
    function labelOf(rules, kind) {
      for (var i = 0; i < rules.length; i++) if (rules[i].kind === kind) return rules[i].label;
      return kind;
    }
    (draft.assets || []).forEach(function (a) { if (Number(a.value || 0) > 0) items.push("资产：" + labelOf(ASSET_RULES, a.kind) + " " + moneyCn(a.value, a.currency || draft.currency)); });
    (draft.liabilities || []).forEach(function (l) { if (Number(l.balance || 0) > 0) items.push("负债：" + labelOf(LIABILITY_RULES, l.kind) + " " + moneyCn(l.balance, draft.currency)); });
    (draft.protection || []).forEach(function (p) {
      if (Number(p.coverage || 0) > 0) items.push("保障：" + labelOf(PROTECTION_RULES, p.kind) + " 保额 " + moneyCn(p.coverage, draft.currency));
    });
    if (draft.education_plan && draft.education_plan.expected_cost !== undefined) items.push("教育金预算 " + moneyCn(draft.education_plan.expected_cost, draft.currency));
    return items;
  }

  return {
    parseChineseNumber: parseChineseNumber,
    parseCount: parseCount,
    parseCurrency: parseCurrency,
    amountAfter: amountAfter,
    amountsBeside: amountsBeside,
    percentOf: percentOf,
    periodOf: periodOf,
    parseUtterance: extractFacts,
    commandOf: commandOf,
    isConfirm: isConfirm,
    isDeny: isDeny,
    echoFact: echoFact,
    applyToDraft: applyToDraft,
    nextQuestion: nextQuestion,
    isFulfilled: isFulfilled,
    markNegated: markNegated,
    summaryFacts: summaryFacts,
    moneyCn: moneyCn,
    emptyMembers: emptyMembers,
  };
});
