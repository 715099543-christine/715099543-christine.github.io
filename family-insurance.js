/* Verity 香港保险方案实验室 · 以满足保障缺口为出发点（Round 40）
 *
 * 这个模块回答一个问题：**在我的家庭还差多少保障的前提下，香港市场现有产品里，
 * 用尽可能合理的成本把缺口补上，应该怎么组合？**
 *
 * 三条不可动摇的原则（写在代码里，也写进每一个输出）：
 *   1. 从来没有佣金视角：数据里没有佣金/返佣字段，排序里也不使用任何销售激励，
 *      只按「每年保费 ÷ 补足的保障额度」这个单位成本口径排序。
 *   2. 从不替用户拍板推荐某一家公司：输出的是「覆盖结构 + 单位成本」，
 *      选谁投保由用户决定，Verity 不是持牌经纪。
 *   3. 不编造数字：公开页面无法核验的保费与保额一律留空，由用户填入自己拿到的
 *      正式报价；没有报价就不排序，只做结构匹配。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.VerityInsurance = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var DISCLAIMER =
    "Verity 不是持牌保险经纪，不销售任何保险产品，不推荐任何保险公司或代理人；" +
    "本模块不构成投保建议。所有结论以承保方正式条款、核保结果与报价为准。";

  /* 缺口分类 → 产品 covers 标签 */
  var GAP_TO_COVER = {
    death: ["death"],
    disability: ["disability", "income"],
    critical_illness: ["critical_illness", "cancer"],
    hospitalisation: ["hospitalisation"],
    accident: ["accident"],
    long_term_care: ["long_term_care"],
  };

  var GAP_LABELS = {
    death: "身故（家庭责任期）",
    disability: "失能／收入中断",
    critical_illness: "危疾",
    hospitalisation: "住院医疗",
    accident: "意外",
    long_term_care: "长期护理",
  };

  /* 现有保单 kind → 缺口 key（控制台里已有的 protection 结构） */
  var PROTECTION_KIND_TO_GAP = {
    life: "death",
    disability: "disability",
    critical: "critical_illness",
    critical_illness: "critical_illness",
    health: "hospitalisation",
    medical: "hospitalisation",
    accident: "accident",
    long_term_care: "long_term_care",
    liability: null,
  };

  var DEFAULT_OPTIONS = {
    /* 顶梁柱离世后，家里需要多少年的必要开支才缓得过来 */
    income_replacement_years: 10,
    /* 危疾按几年家庭收入规划（治疗期＋康复期收入损失） */
    critical_illness_income_years: 3,
    /* 失能后按几年必要支出规划 */
    disability_years: 5,
    /* 一次重大住院的自费压力基准（港元） */
    hospitalisation_baseline_hkd_adult: 1500000,
    /* 长期护理：每年护理成本基准（港元）× 年数 */
    long_term_care_annual_hkd: 240000,
    long_term_care_years: 5,
    /* 意外：按几年收入规划 */
    accident_income_years: 1,
    /* 港元换算率（只在家庭币种不是 HKD 时使用，页面会显示实际使用的汇率） */
    fx_to_hkd: { CNY: 1.09, USD: 7.8, HKD: 1, TWD: 0.26, SGD: 5.8, EUR: 8.5, GBP: 9.9 },
  };

  function toNumber(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function round(x) {
    return Math.round(x);
  }

  /* ------------------------------------------------------------ 家庭档案读取 */

  /* 把控制台里的家庭档案（或任何结构相同的对象）整理成本模块需要的输入。 */
  function householdFrom(profile) {
    var p = profile || {};
    var members = Array.isArray(p.members) ? p.members : [];
    var earners = members.filter(function (m) {
      return toNumber(m.annual_income) > 0;
    });
    var primary = members.find(function (m) {
      return m.role === "primary_earner";
    }) || earners.slice().sort(function (a, b) {
      return toNumber(b.annual_income) - toNumber(a.annual_income);
    })[0] || null;

    var assets = Array.isArray(p.assets) ? p.assets : [];
    var liquid = assets
      .filter(function (a) {
        return a.liquidity === "immediate" || a.liquidity === "near";
      })
      .reduce(function (sum, a) {
        return sum + toNumber(a.value);
      }, 0);

    var liabilities = Array.isArray(p.liabilities) ? p.liabilities : [];
    var debt = liabilities.reduce(function (sum, l) {
      return sum + toNumber(l.balance);
    }, 0);
    var mandatory = liabilities.reduce(function (sum, l) {
      return sum + toNumber(l.mandatory_payment);
    }, 0);

    var protection = Array.isArray(p.protection) ? p.protection : [];
    var existing = {};
    var existingPremium = 0;
    protection.forEach(function (item) {
      var gap = PROTECTION_KIND_TO_GAP[item.kind];
      existingPremium += toNumber(item.annual_premium);
      if (gap) existing[gap] = (existing[gap] || 0) + toNumber(item.coverage);
    });

    var education = (Array.isArray(p.future_rigid_outflows) ? p.future_rigid_outflows : []).reduce(function (sum, o) {
      return sum + toNumber(o.amount);
    }, 0);

    var currency = String(p.currency || "CNY").toUpperCase();

    return {
      currency: currency,
      profile_id: p.profile_id || "",
      members: members,
      earners: earners,
      primary: primary,
      annual_income: earners.reduce(function (sum, m) {
        return sum + toNumber(m.annual_income);
      }, 0),
      primary_income: primary ? toNumber(primary.annual_income) : 0,
      essential: toNumber(p.annual_expenses_essential),
      discretionary: toNumber(p.annual_expenses_discretionary),
      mandatory_debt_service: mandatory,
      debt: debt,
      education: education,
      liquid_assets: liquid,
      existing_coverage: existing,
      existing_premium: existingPremium,
      dependents: members.reduce(function (sum, m) {
        return sum + toNumber(m.dependents);
      }, 0),
    };
  }

  /* -------------------------------------------------------------- 缺口计算 */

  function analyze(householdInput, options) {
    var h = householdInput && householdInput.annual_income !== undefined ? householdInput : householdFrom(householdInput);
    var opt = Object.assign({}, DEFAULT_OPTIONS, options || {});
    var rate = (opt.fx_to_hkd && opt.fx_to_hkd[h.currency]) || 1;
    var toHkd = function (amountInFamilyCurrency) {
      return amountInFamilyCurrency * rate;
    };

    var hasEarner = h.annual_income > 0;
    var gaps = [];

    function push(key, needFamily, note, basis) {
      var needHkd = round(toHkd(needFamily));
      var existingHkd = round(toHkd(h.existing_coverage[key] || 0));
      gaps.push({
        key: key,
        label: GAP_LABELS[key],
        need_hkd: Math.max(0, needHkd),
        existing_hkd: existingHkd,
        gap_hkd: Math.max(0, needHkd - existingHkd),
        note: note,
        basis: basis,
      });
    }

    if (hasEarner) {
      var incomeReplace = h.primary_income * opt.income_replacement_years;
      var deathNeed = h.debt + h.education + incomeReplace - h.liquid_assets;
      push("death", deathNeed, "顶梁柱收入中断后，家庭责任期的资金缺口", [
        "未偿债务 " + round(h.debt),
        "未来刚性支出（教育等）" + round(h.education),
        "顶梁柱年收入 " + round(h.primary_income) + " × " + opt.income_replacement_years + " 年",
        "减去可变现资产 " + round(h.liquid_assets),
      ]);
    } else {
      push("death", 0, "档案里没有记录收入，无法计算身故缺口（不猜）", ["家庭档案缺少收入记录"]);
    }

    if (hasEarner) {
      var disabilityNeed = h.essential * opt.disability_years - h.liquid_assets * 0.5;
      push("disability", disabilityNeed, "失能后收入中断，但刚性支出继续发生", [
        "年必要支出 " + round(h.essential) + " × " + opt.disability_years + " 年",
        "可变现资产按 50% 折价计提 " + round(h.liquid_assets * 0.5),
      ]);
      var ciNeed = h.annual_income * opt.critical_illness_income_years;
      push("critical_illness", ciNeed, "确诊后治疗期与康复期的收入损失", [
        "家庭年收入 " + round(h.annual_income) + " × " + opt.critical_illness_income_years + " 年",
      ]);
    } else {
      push("disability", 0, "档案里没有记录收入，无法计算失能缺口（不猜）", ["家庭档案缺少收入记录"]);
      push("critical_illness", 0, "档案里没有记录收入，无法计算危疾缺口（不猜）", ["家庭档案缺少收入记录"]);
    }

    var adults = Math.max(1, h.members.filter(function (m) {
      return toNumber(m.age) >= 18;
    }).length);
    push(
      "hospitalisation",
      round(opt.hospitalisation_baseline_hkd_adult / rate) * adults,
      "按一位成人在私家医院一次重大住院的自费压力计提",
      [adults + " 位成人 × 基准 " + opt.hospitalisation_baseline_hkd_adult + " 港元（自费压力基准，非报价）"]
    );

    if (hasEarner) {
      push("accident", h.annual_income * opt.accident_income_years, "意外导致收入中断的一年缓冲", [
        "家庭年收入 " + round(h.annual_income) + " × " + opt.accident_income_years + " 年",
      ]);
    } else {
      push("accident", 0, "档案里没有记录收入，无法计算意外缺口（不猜）", ["家庭档案缺少收入记录"]);
    }

    var elders = h.members.filter(function (m) {
      return toNumber(m.age) >= 55;
    }).length;
    push(
      "long_term_care",
      elders > 0 ? Math.round((opt.long_term_care_annual_hkd / rate) * opt.long_term_care_years * elders) : 0,
      elders > 0 ? "55 岁以上成员的长护费用准备" : "档案里没有 55 岁以上的成员，暂不计提长护缺口",
      [
        elders + " 位 55 岁以上成员 × 每年 " + opt.long_term_care_annual_hkd + " 港元 × " + opt.long_term_care_years + " 年",
      ]
    );

    gaps.forEach(function (g) {
      g.priority = priorityOf(g, h);
    });
    gaps.sort(function (a, b) {
      return b.priority - a.priority;
    });

    var totalGap = gaps.reduce(function (sum, g) {
      return sum + g.gap_hkd;
    }, 0);
    var biggest = gaps.filter(function (g) {
      return g.gap_hkd > 0;
    })[0] || null;

    return {
      household: h,
      options: opt,
      fx_rate_to_hkd: rate,
      gaps: gaps,
      ranking_basis: "priority = 缺口金额 ÷ 家庭年收入，收入越小、缺口越大越靠前；没有任何佣金或销售激励参与排序",
      total_gap_hkd: totalGap,
      biggest_gap: biggest ? biggest.key : null,
      headline: biggest
        ? "最该先补的是「" + biggest.label + "」，还差 " + biggest.gap_hkd.toLocaleString("zh-CN") + " 港元保障。"
        : "按当前档案记录的保单，六类缺口都已被覆盖到（不代表保额一定充足，请定期复核）。",
      disclaimer: DISCLAIMER,
    };
  }

  function priorityOf(gap, household) {
    if (gap.gap_hkd <= 0) return 0;
    var base = household.annual_income > 0 ? gap.gap_hkd / household.annual_income : gap.gap_hkd / 200000;
    /* 身故与失能直接击穿家庭生存底线，给一档固定加权；危疾次之。 */
    var weight = { death: 1.35, disability: 1.25, critical_illness: 1.1, long_term_care: 1.0, hospitalisation: 0.95, accident: 0.9 }[gap.key] || 1;
    return base * weight;
  }

  /* -------------------------------------------------------- 产品匹配与成本排序 */

  function coversGap(product, gapKey) {
    var tags = GAP_TO_COVER[gapKey] || [gapKey];
    var list = (product && product.covers) || [];
    return tags.some(function (tag) {
      return list.indexOf(tag) >= 0;
    });
  }

  function matchProducts(gaps, catalog) {
    var products = (catalog && catalog.products) || [];
    return gaps.map(function (gap) {
      return {
        gap: gap,
        candidates: products.filter(function (p) {
          return coversGap(p, gap.key);
        }),
      };
    });
  }

  /* quotes：{ [productId]: { annual_premium_hkd, coverage_hkd } } —— 由用户填入自己拿到的正式报价。
     没有报价的条目只做结构匹配，不参与单位成本排序（绝不替用户编一个保费）。 */
  function rankForGap(gapKey, catalog, quotes) {
    var products = ((catalog && catalog.products) || []).filter(function (p) {
      return coversGap(p, gapKey);
    });
    var priced = [];
    var unpriced = [];
    products.forEach(function (p) {
      var q = (quotes || {})[p.id] || {};
      var premium = toNumber(q.annual_premium_hkd) || toNumber(p.premium_hkd_per_year);
      var coverage = toNumber(q.coverage_hkd) || toNumber(p.sum_assured_hkd);
      if (premium > 0 && coverage > 0) {
        priced.push({
          product: p,
          annual_premium_hkd: premium,
          coverage_hkd: coverage,
          cost_per_million_hkd: Math.round((premium / coverage) * 1000000),
        });
      } else {
        unpriced.push(p);
      }
    });
    priced.sort(function (a, b) {
      return a.cost_per_million_hkd - b.cost_per_million_hkd;
    });
    return {
      gap_key: gapKey,
      priced: priced,
      unpriced: unpriced,
      note:
        priced.length === 0
          ? "还没有任何一条产品填入你拿到的正式报价，因此不给成本排序——Verity 不会替你编一个保费。"
          : "按「每补足 100 万港元保障所需的年保费」从低到高排列；口径里没有任何佣金因素。",
    };
  }

  /* ------------------------------------------------------------------ 组合 */

  function combine(selectedIds, catalog, quotes, gaps) {
    var products = (catalog && catalog.products) || [];
    var byId = {};
    products.forEach(function (p) {
      byId[p.id] = p;
    });
    var chosen = (selectedIds || []).map(function (id) {
      return byId[id];
    }).filter(Boolean);

    var totalPremium = 0;
    var coverageByGap = {};
    var missingQuote = [];

    chosen.forEach(function (p) {
      var q = (quotes || {})[p.id] || {};
      var premium = toNumber(q.annual_premium_hkd) || 0;
      totalPremium += premium;
      if (premium <= 0) missingQuote.push(p.id);
      (p.covers || []).forEach(function (tag) {
        var gapKey = Object.keys(GAP_TO_COVER).find(function (key) {
          return GAP_TO_COVER[key].indexOf(tag) >= 0;
        });
        if (!gapKey) return;
        coverageByGap[gapKey] = (coverageByGap[gapKey] || 0) + (toNumber(q.coverage_hkd) || 0);
      });
    });

    var coverageRows = (gaps || []).map(function (gap) {
      var filled = coverageByGap[gap.key] || 0;
      var remaining = Math.max(0, gap.gap_hkd - filled);
      return {
        key: gap.key,
        label: gap.label,
        gap_hkd: gap.gap_hkd,
        filled_hkd: filled,
        remaining_hkd: remaining,
        coverage_ratio: gap.gap_hkd > 0 ? filled / gap.gap_hkd : filled > 0 ? 1 : 0,
      };
    });

    /* 重复覆盖：同一条缺口被两个以上产品同时补，通常是花了两份钱。 */
    var overlaps = [];
    var byGapCount = {};
    chosen.forEach(function (p) {
      (p.covers || []).forEach(function (tag) {
        Object.keys(GAP_TO_COVER).forEach(function (key) {
          if (GAP_TO_COVER[key].indexOf(tag) >= 0) byGapCount[key] = (byGapCount[key] || 0) + 1;
        });
      });
    });
    Object.keys(byGapCount).forEach(function (key) {
      if (byGapCount[key] > 1) {
        overlaps.push({
          gap_key: key,
          label: GAP_LABELS[key],
          count: byGapCount[key],
          message: GAP_LABELS[key] + " 被 " + byGapCount[key] + " 个产品重复覆盖，先确认是不是重复花了钱（例如两份都含住院医疗）。",
        });
      }
    });

    /* 同等覆盖替代：只在一个产品组里比较，用单位成本最低的替换单位成本最高的。 */
    var alternatives = [];
    Object.keys(coverageByGap).forEach(function (gapKey) {
      var rank = rankForGap(gapKey, catalog, quotes);
      if (rank.priced.length < 2) return;
      var cheapest = rank.priced[0];
      var priciest = rank.priced[rank.priced.length - 1];
      alternatives.push({
        gap_key: gapKey,
        label: GAP_LABELS[gapKey],
        cheaper: { product_id: cheapest.product.id, insurer: cheapest.product.insurer, name: cheapest.product.product_name, cost_per_million_hkd: cheapest.cost_per_million_hkd },
        pricier: { product_id: priciest.product.id, insurer: priciest.product.insurer, name: priciest.product.product_name, cost_per_million_hkd: priciest.cost_per_million_hkd },
        saving_per_million_hkd: priciest.cost_per_million_hkd - cheapest.cost_per_million_hkd,
      });
    });

    var totalRemaining = coverageRows.reduce(function (sum, row) {
      return sum + row.remaining_hkd;
    }, 0);

    return {
      selected_count: chosen.length,
      total_annual_premium_hkd: totalPremium,
      coverage_rows: coverageRows,
      total_remaining_gap_hkd: totalRemaining,
      overlaps: overlaps,
      alternatives: alternatives,
      missing_quote_ids: missingQuote,
      note:
        "合计保费只统计你填入的正式报价；未填报价的产品按 0 计入，因此合计是下限而不是估算。" +
        "剩余缺口为 0 也不等于保额充足，须逐年复核。",
      disclaimer: DISCLAIMER,
    };
  }

  /* ------------------------------------------------------------------ 渲染 */

  var state = {
    catalog: null,
    analysis: null,
    quotes: {},
    selected: {},
    error: "",
  };

  function loadProfileFromConsole() {
    try {
      var raw = window.localStorage.getItem("verity.zh.profiles.v1");
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      var profiles = (parsed && parsed.profiles) || [];
      if (!profiles.length) return null;
      var opened = profiles.find(function (item) {
        return item.id === parsed.last_opened;
      });
      return (opened || profiles[profiles.length - 1]).profile || null;
    } catch (err) {
      return null;
    }
  }

  function money(n) {
    return Number(n || 0).toLocaleString("zh-CN");
  }

  function esc(text) {
    return String(text === null || text === undefined ? "" : text).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function render(container) {
    if (!container) return;
    if (!state.catalog) {
      container.innerHTML = '<p class="verity-ins-note">正在载入香港市场产品目录…</p>';
      return;
    }
    if (state.error) {
      container.innerHTML = '<p class="verity-ins-note verity-ins-warn">' + esc(state.error) + "</p>";
      return;
    }
    if (!state.analysis) {
      container.innerHTML =
        '<p class="verity-ins-note">先在控制台里建立并保存家庭档案（第 1～5 步至少要填收入、必要支出与负债），' +
        "这里才会算出保障缺口。没有档案时 Verity 不会替你猜一个家庭。</p>";
      return;
    }

    var analysis = state.analysis;
    var html = [];
    html.push('<div class="verity-ins-headline">' + esc(analysis.headline) + "</div>");
    html.push(
      '<p class="verity-ins-note">换算汇率：1 ' +
        esc(analysis.household.currency) +
        " = " +
        analysis.fx_rate_to_hkd +
        " 港元（可在下方调整）。缺口是规划口径，不是任何一家公司的报价。</p>"
    );

    html.push('<table class="verity-ins-table"><thead><tr><th>保障缺口</th><th class="num">缺口金额（港元）</th><th class="num">已有保障</th><th class="num">优先级</th></tr></thead><tbody>');
    analysis.gaps.forEach(function (gap) {
      html.push(
        "<tr><td>" + esc(gap.label) + '<div class="verity-ins-sub">' + esc(gap.basis.join("；")) + "</div></td>" +
          '<td class="num">' + money(gap.gap_hkd) + "</td>" +
          '<td class="num">' + money(gap.existing_hkd) + "</td>" +
          '<td class="num">' + gap.priority.toFixed(2) + "</td></tr>"
      );
    });
    html.push("</tbody></table>");
    html.push('<p class="verity-ins-note">' + esc(analysis.ranking_basis) + "</p>");

    var top = analysis.gaps.filter(function (g) {
      return g.gap_hkd > 0;
    });
    if (!top.length) {
      html.push('<p class="verity-ins-note">六类缺口按档案记录的保单都已被覆盖到。</p>');
    } else {
      top.forEach(function (gap) {
        var rank = rankForGap(gap.key, state.catalog, state.quotes);
        html.push('<div class="verity-ins-block"><h3>' + esc(gap.label) + " · 候选产品</h3>");
        html.push('<p class="verity-ins-note">' + esc(rank.note) + "</p>");
        html.push('<table class="verity-ins-table"><thead><tr><th>选择</th><th>产品</th><th class="num">你填的年保费（HKD）</th><th class="num">补足保障（HKD）</th><th class="num">每 100 万保障年成本</th></tr></thead><tbody>');
        var rows = rank.priced.map(function (one) {
          return { p: one.product, premium: one.annual_premium_hkd, coverage: one.coverage_hkd, cpm: one.cost_per_million_hkd, priced: true };
        }).concat(
          rank.unpriced.map(function (p) {
            return { p: p, premium: "", coverage: "", cpm: null, priced: false };
          })
        );
        rows.forEach(function (row) {
          var q = state.quotes[row.p.id] || {};
          html.push(
            "<tr><td><input type=\"checkbox\" data-ins-pick=\"" + esc(row.p.id) + "\"" + (state.selected[row.p.id] ? " checked" : "") + " /></td>" +
              "<td>" + esc(row.p.insurer) + "<div class=\"verity-ins-sub\">" + esc(row.p.product_name) + "</div>" +
              '<div class="verity-ins-sub"><a href="' + esc(row.p.source_url) + '" target="_blank" rel="noopener noreferrer">资料来源</a> · 核对日 ' + esc(row.p.as_of_date) + "</div></td>" +
              '<td class="num"><input type="number" min="0" step="100" data-ins-premium="' + esc(row.p.id) + '" value="' + (q.annual_premium_hkd || "") + '" placeholder="待询价" /></td>' +
              '<td class="num"><input type="number" min="0" step="10000" data-ins-coverage="' + esc(row.p.id) + '" value="' + (q.coverage_hkd || "") + '" placeholder="待确认" /></td>' +
              '<td class="num">' + (row.cpm === null ? "—" : money(row.cpm)) + "</td></tr>"
          );
        });
        html.push("</tbody></table></div>");
      });
    }

    var combo = combine(
      Object.keys(state.selected).filter(function (id) {
        return state.selected[id];
      }),
      state.catalog,
      state.quotes,
      analysis.gaps
    );
    state.combo = combo;
    html.push('<div class="verity-ins-block"><h3>我的自由组合</h3>');
    html.push(
      '<p class="verity-ins-note">已选 ' + combo.selected_count + " 项 · 合计年保费（仅计你填入的报价）<strong>" +
        money(combo.total_annual_premium_hkd) + " 港元</strong> · 剩余缺口 <strong>" + money(combo.total_remaining_gap_hkd) + " 港元</strong></p>"
    );
    html.push('<table class="verity-ins-table"><thead><tr><th>缺口</th><th class="num">缺口</th><th class="num">组合已补</th><th class="num">剩余</th><th class="num">覆盖率</th></tr></thead><tbody>');
    combo.coverage_rows.forEach(function (row) {
      html.push(
        "<tr><td>" + esc(row.label) + "</td><td class=\"num\">" + money(row.gap_hkd) + "</td><td class=\"num\">" + money(row.filled_hkd) +
          "</td><td class=\"num\">" + money(row.remaining_hkd) + "</td><td class=\"num\">" + Math.round(row.coverage_ratio * 100) + "%</td></tr>"
      );
    });
    html.push("</tbody></table>");
    combo.overlaps.forEach(function (o) {
      html.push('<p class="verity-ins-note verity-ins-warn">重复覆盖提醒：' + esc(o.message) + "</p>");
    });
    combo.alternatives.forEach(function (a) {
      html.push(
        '<p class="verity-ins-note">同等覆盖更省的选项（' + esc(a.label) + "）：" +
          esc(a.cheaper.insurer + " " + a.cheaper.name) + " 每 100 万保障 " + money(a.cheaper.cost_per_million_hkd) +
          " 港元，比 " + esc(a.pricier.insurer + " " + a.pricier.name) + " 低 " + money(a.saving_per_million_hkd) + " 港元。</p>"
      );
    });
    html.push('<p class="verity-ins-note">' + esc(combo.note) + "</p></div>");
    html.push('<p class="verity-ins-note">' + esc(DISCLAIMER) + "</p>");

    container.innerHTML = html.join("");
    bind(container);
  }

  function bind(container) {
    container.querySelectorAll("[data-ins-pick]").forEach(function (box) {
      box.addEventListener("change", function () {
        state.selected[box.getAttribute("data-ins-pick")] = box.checked;
        render(container);
      });
    });
    container.querySelectorAll("[data-ins-premium]").forEach(function (input) {
      input.addEventListener("change", function () {
        var id = input.getAttribute("data-ins-premium");
        state.quotes[id] = state.quotes[id] || {};
        state.quotes[id].annual_premium_hkd = toNumber(input.value);
        render(container);
      });
    });
    container.querySelectorAll("[data-ins-coverage]").forEach(function (input) {
      input.addEventListener("change", function () {
        var id = input.getAttribute("data-ins-coverage");
        state.quotes[id] = state.quotes[id] || {};
        state.quotes[id].coverage_hkd = toNumber(input.value);
        render(container);
      });
    });
  }

  function refreshProfile() {
    var profile = loadProfileFromConsole();
    state.analysis = profile ? analyze(profile) : null;
  }

  function mount() {
    var container = document.getElementById("insurance-lab-mount");
    if (!container) return;
    refreshProfile();
    render(container);
    if (state.catalog) return;
    var url = new URL("../hk-insurance-products.json", window.location.href).toString();
    window
      .fetch(url, { cache: "no-cache" })
      .then(function (res) {
        if (!res.ok) throw new Error("产品目录读取失败（HTTP " + res.status + "）");
        return res.json();
      })
      .then(function (catalog) {
        state.catalog = catalog;
        state.error = "";
        render(container);
      })
      .catch(function (err) {
        state.error = "香港保险产品目录暂时不可用：" + (err.message || err);
        render(container);
      });
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
    else mount();
  }

  return {
    DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    DISCLAIMER: DISCLAIMER,
    GAP_LABELS: GAP_LABELS,
    GAP_TO_COVER: GAP_TO_COVER,
    householdFrom: householdFrom,
    analyze: analyze,
    matchProducts: matchProducts,
    rankForGap: rankForGap,
    combine: combine,
    mount: mount,
    state: state,
  };
});
