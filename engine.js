/* 信用卡回饋推薦引擎
 * 同一份程式碼給三個地方用：網頁前端、Google Apps Script 後端（每日提醒）、Node 測試。
 * 只用純函式，不碰 DOM、不碰網路。
 */
var CardEngine = (function () {
  'use strict';

  // ---------- 小工具 ----------
  function norm(s) {
    s = String(s == null ? '' : s);
    if (s.normalize) s = s.normalize('NFKC');
    return s.toLowerCase().replace(/[\s\-_.·・'’]/g, '');
  }
  function splitList(s) {
    return String(s || '').split(/[,，、]/).map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function cleanToken(t) {
    t = t.replace(/\([^)]*\)/g, '');      // 去掉完整括號
    t = t.replace(/\(.*$/, '');           // 去掉沒收尾的左括號之後
    t = t.replace(/[()]/g, '');
    return t.trim();
  }
  function num(v) {
    if (v === '' || v == null) return null;
    var n = Number(v);
    return isNaN(n) ? null : n;
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseDate(s) {
    if (!s) return null;
    if (s instanceof Date) return new Date(s.getFullYear(), s.getMonth(), s.getDate());
    var m = String(s).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function lastDayOfMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }

  var FEE = 0.015; // 一般國外交易手續費

  // ---------- 載入資料 ----------
  function load(raw) {
    var cards = {};
    (raw['卡種'] || []).forEach(function (r) {
      cards[r['卡種ID']] = {
        id: r['卡種ID'], bank: r['銀行'], name: r['卡名'], plan: r['等級/方案'],
        form: r['回饋形式'], value: num(r['點數價值(元/點)']) || 1
      };
    });
    var holdings = (raw['持卡'] || []).filter(function (r) { return String(r['啟用'] || 'Y').toUpperCase() !== 'N'; })
      .map(function (r) {
        return {
          id: r['持卡ID'], holder: r['持卡人'], cardId: r['卡種ID'],
          name: r['卡名'] || (cards[r['卡種ID']] ? cards[r['卡種ID']].bank + ' ' + cards[r['卡種ID']].name : r['卡種ID']),
          closeDay: num(r['結帳日(每月幾號)']), birthMonth: num(r['生日月']), note: r['備註'] || ''
        };
      });
    var remByRule = {};
    (raw['登錄提醒'] || []).forEach(function (r) {
      if (!r['規則ID']) return;
      remByRule[r['規則ID']] = { ruleId: r['規則ID'], cycle: r['登錄週期'] || '一次', days: String(r['開放日'] || ''), time: r['開放時間'] || '', note: r['說明'] || '' };
    });
    var rules = (raw['回饋規則'] || []).filter(function (r) { return r['規則ID']; }).map(function (r) {
      var raws = splitList(r['適用通路/類別']);
      return {
        id: r['規則ID'], cardId: r['卡種ID'], type: r['規則類型'], plan: r['需切換權益'] || '',
        region: r['地區'] || '全部', scope: r['適用通路/類別'] || '',
        tokens: raws.map(cleanToken).filter(Boolean),
        cond: r['條件'] || '', unit: r['回饋單位'] || '%',
        total: num(r['總回饋率']) || 0, base: num(r['基本部分']) || 0,
        cap: num(r['加碼上限(元)']), cycle: r['上限週期'] || '',
        reg: String(r['需登錄'] || '').toUpperCase() === 'Y', regNote: r['登錄說明'] || '',
        start: parseDate(r['開始']), end: parseDate(r['結束']),
        status: r['資料狀態'] || '', source: r['來源'] || '',
        reminder: remByRule[r['規則ID']] || null
      };
    });
    var merchants = (raw['通路字典'] || []).filter(function (r) { return r['標準名稱']; }).map(function (r) {
      return { name: String(r['標準名稱']), aliases: splitList(r['別名(逗號分隔)']), cats: splitList(r['類別']), kind: 'merchant' };
    });
    var txs = (raw['刷卡紀錄'] || []).filter(function (r) { return r['紀錄ID']; }).map(function (r) {
      return { id: r['紀錄ID'], date: parseDate(r['日期']), holdingId: r['持卡ID'], ruleId: r['規則ID'],
        merchant: r['通路'], amount: num(r['金額']) || 0, reward: num(r['預估回饋']) || 0, source: r['來源'] || '', note: r['備註'] || '' };
    });
    var regs = (raw['登錄狀態'] || []).filter(function (r) { return r['規則ID']; }).map(function (r) {
      return { holdingId: r['持卡ID'], ruleId: r['規則ID'], key: String(r['週期']), date: parseDate(r['登錄日期']) };
    });
    var db = { cards: cards, holdings: holdings, rules: rules, merchants: merchants, txs: txs, regs: regs };
    db.entities = buildEntities(db);
    return db;
  }

  // ---------- 搜尋用的實體（通路 + 類別） ----------
  var GENERIC_RE = /一般消費|^國外|^日本$|^日幣|實體消費|^國外消費/;
  function isGenericToken(t) { return GENERIC_RE.test(t); }

  function buildEntities(db) {
    var list = db.merchants.slice();
    var known = {};
    list.forEach(function (m) { [m.name].concat(m.aliases).forEach(function (a) { known[norm(a)] = true; }); });
    // 規則裡出現、但字典沒有的通路也加入，確保搜得到
    db.rules.forEach(function (r) {
      r.tokens.forEach(function (t) {
        if (isGenericToken(t) || t.length < 2) return;
        var k = norm(t);
        if (known[k]) return;
        known[k] = true;
        list.push({ name: t, aliases: [], cats: [], kind: 'merchant' });
      });
    });
    var cats = {};
    db.merchants.forEach(function (m) { m.cats.forEach(function (c) { cats[c] = true; }); });
    Object.keys(cats).forEach(function (c) { list.push({ name: c, aliases: [], cats: [c], kind: 'category' }); });
    list.push({ name: '一般消費（其他通路）', aliases: ['一般消費', '一般', '其他', '其他通路'], cats: [], kind: 'general' });
    list.forEach(function (e) { e.keys = [e.name].concat(e.aliases).map(norm).filter(Boolean); });
    return list;
  }

  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 99;
    var dp = []; for (var i = 0; i <= a.length; i++) { dp[i] = [i]; }
    for (var j = 1; j <= b.length; j++) dp[0][j] = j;
    for (i = 1; i <= a.length; i++) for (j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return dp[a.length][b.length];
  }
  function isSubseq(q, s) { var i = 0; for (var j = 0; j < s.length && i < q.length; j++) if (s[j] === q[i]) i++; return i === q.length; }

  /** 模糊搜尋：回傳 [{entity, score}] */
  function search(db, query, limit) {
    var q = norm(query);
    if (!q) return [];
    var out = [];
    db.entities.forEach(function (e) {
      var best = 0;
      e.keys.forEach(function (k) {
        var s = 0;
        if (k === q) s = 100;
        else if (k.indexOf(q) === 0) s = 90;
        else if (k.indexOf(q) >= 0) s = 80;
        else if (k.length >= 2 && q.indexOf(k) >= 0) s = 70;
        else if (q.length >= 3 && lev(q, k) <= 1) s = 60;
        else if (q.length >= 2 && isSubseq(q, k)) s = 45;
        if (s > best) best = s;
      });
      if (e.kind === 'category' && best) best -= 5;
      if (best) out.push({ entity: e, score: best });
    });
    out.sort(function (a, b) { return b.score - a.score || a.entity.name.length - b.entity.name.length; });
    return out.slice(0, limit || 8);
  }

  // ---------- 規則比對 ----------
  function regionOk(ruleRegion, sel) {
    if (sel === '國內') return ruleRegion === '國內' || ruleRegion === '全部';
    if (sel === '日本') return ruleRegion === '日本' || ruleRegion === '國外' || ruleRegion === '全部';
    return ruleRegion === '國外' || ruleRegion === '全部';
  }
  function tokenMatchesKey(t, k) {
    if (t === k) return true;
    if (k.length >= 3 && t.indexOf(k) >= 0) return true;
    if (t.length >= 3 && k.indexOf(t) >= 0) return true;
    return false;
  }
  function genericFor(t, sel, ruleRegion) {
    var domesticGeneric = /一般消費/.test(t) && !/國外|日本|日幣/.test(t);
    if (sel === '國內') return domesticGeneric;
    var overseas = /^國外|國外實體|國外消費|國外一般/.test(t);
    var japan = sel === '日本' && (/^日本|日幣/.test(t));
    return overseas || japan || (domesticGeneric && ruleRegion === '全部');
  }
  /** 這條規則是否適用此實體：回傳 'specific' | 'generic' | null */
  var STORE4 = ['7-11', '全家', '萊爾富', 'OK'];
  function excluded(rule, entity) {
    var m = String(rule.cond).match(/(不含|排除)([^；;。]*)/);
    if (!m) return false;
    var txt = norm(m[2]);
    if (/四大超商/.test(m[2]) && STORE4.some(function (n) { return entity.keys.indexOf(norm(n)) >= 0; })) return true;
    return entity.keys.some(function (k) { return k.length >= 2 && txt.indexOf(k) >= 0; });
  }
  var ONLINE_CATS = ['網購', '旅遊平台', '影音', 'AI 工具', '遊戲', '日本交通卡', '外送'];
  function matchRule(rule, entity, sel, db) {
    if (!regionOk(rule.region, sel)) return null;
    var online = entity && entity.cats.some(function (c) { return ONLINE_CATS.indexOf(c) >= 0; });
    var keys = entity ? entity.keys : [];
    var catKeys = entity ? entity.cats.map(norm) : [];
    // 類別實體：展開成該類別所有通路
    var memberKeys = [];
    if (entity && entity.kind === 'category') {
      db.merchants.forEach(function (m) { if (m.cats.indexOf(entity.name) >= 0) memberKeys = memberKeys.concat([m.name].concat(m.aliases).map(norm)); });
    }
    if (entity && excluded(rule, entity)) return null;
    var generic = false;
    for (var i = 0; i < rule.tokens.length; i++) {
      var t = rule.tokens[i], nt = norm(t);
      if (isGenericToken(t)) {
        if (genericFor(t, sel, rule.region) && !(online && /實體/.test(t + rule.cond))) generic = true;
        continue;
      }
      if (!entity || entity.kind === 'general') continue;
      for (var a = 0; a < keys.length; a++) if (tokenMatchesKey(nt, keys[a])) return 'specific';
      for (var c = 0; c < catKeys.length; c++) {
        var ck = catKeys[c];
        if (ck === '日本') continue;   // 國家不是通路類別
        if (ck.length >= 2 && (nt === ck || nt.indexOf(ck) >= 0)) return 'specific';
      }
      for (var m = 0; m < memberKeys.length; m++) if (memberKeys[m] && nt === memberKeys[m]) return 'specific';
    }
    return generic ? 'generic' : null;
  }

  function isActive(rule, today) {
    if (rule.status === '已過期') return false;
    if (rule.start && rule.start > today) return false;
    if (rule.end && rule.end < today) return false;
    return true;
  }
  function birthdayOk(rule, holding, today) {
    if (!/生日/.test(rule.cond + rule.plan + rule.scope)) return true;
    return holding.birthMonth ? holding.birthMonth === today.getMonth() + 1 : false;
  }

  // ---------- 上限週期 ----------
  function periodRange(rule, holding, d) {
    var y = d.getFullYear(), m = d.getMonth();
    switch (rule.cycle) {
      case '月': return { from: new Date(y, m, 1), to: new Date(y, m, lastDayOfMonth(y, m)) };
      case '季': var q = Math.floor(m / 3) * 3; return { from: new Date(y, q, 1), to: new Date(y, q + 3, 0) };
      case '年': return { from: new Date(y, 0, 1), to: new Date(y, 11, 31) };
      case '活動期間': return { from: rule.start || new Date(y, 0, 1), to: rule.end || new Date(y, 11, 31) };
      case '帳單週期':
        var cd = holding && holding.closeDay;
        if (!cd) return { from: new Date(y, m, 1), to: new Date(y, m, lastDayOfMonth(y, m)), approx: true };
        var closeThis = new Date(y, m, Math.min(cd, lastDayOfMonth(y, m)));
        if (d <= closeThis) {
          var pm = new Date(y, m - 1, 1);
          return { from: addDays(new Date(pm.getFullYear(), pm.getMonth(), Math.min(cd, lastDayOfMonth(pm.getFullYear(), pm.getMonth()))), 1), to: closeThis };
        }
        var nm = new Date(y, m + 1, 1);
        return { from: addDays(closeThis, 1), to: new Date(nm.getFullYear(), nm.getMonth(), Math.min(cd, lastDayOfMonth(nm.getFullYear(), nm.getMonth()))) };
      default: return null;
    }
  }
  function bonusRate(rule) { return Math.max(0, rule.total - rule.base); }
  function capStatus(db, rule, holding, today) {
    if (rule.cap == null || bonusRate(rule) <= 0) return null;
    var p = periodRange(rule, holding, today);
    if (!p) return null;
    var used = 0, spent = 0;
    db.txs.forEach(function (t) {
      if (t.holdingId === holding.id && t.ruleId === rule.id && t.date && t.date >= p.from && t.date <= p.to) {
        spent += t.amount; used += t.amount * bonusRate(rule);
      }
    });
    var remainingBonus = Math.max(0, rule.cap - used);
    return { cap: rule.cap, used: used, spent: spent, ratio: used / rule.cap,
      remainingSpend: remainingBonus / bonusRate(rule), full: remainingBonus <= 0.5,
      resetDate: addDays(p.to, 1), periodTo: p.to, approx: !!p.approx };
  }

  // ---------- 登錄狀態 ----------
  function regCycle(rule) { return rule.reminder ? rule.reminder.cycle : '一次'; }
  function regKey(rule, d) {
    var c = regCycle(rule);
    if (c === '每月') return d.getFullYear() + '-' + pad(d.getMonth() + 1);
    if (c === '每季') return d.getFullYear() + '-Q' + (Math.floor(d.getMonth() / 3) + 1);
    return 'once';
  }
  function isRegistered(db, rule, holding, today) {
    var key = regKey(rule, today);
    return db.regs.some(function (r) { return r.holdingId === holding.id && r.ruleId === rule.id && r.key === key; });
  }
  function isSkipped(db, rule, holding) {
    return db.regs.some(function (r) { return r.holdingId === holding.id && r.ruleId === rule.id && r.key === 'skip'; });
  }
  var WEEK = { '週日': 0, '週一': 1, '週二': 2, '週三': 3, '週四': 4, '週五': 5, '週六': 6 };
  /** 登錄開放狀態：{openNow, openedOn, next}
   *  每月/每季型：本月（本季）開放日已過且還沒登錄 → 開放中 */
  function openStatus(rule, today) {
    var rem = rule.reminder;
    if (!rem || !rem.days) return { openNow: false, openedOn: null, next: null, anytime: true };
    var cyc = rem.cycle, days = splitList(rem.days), past = [], future = [];
    var y = today.getFullYear(), m = today.getMonth();
    days.forEach(function (d) {
      if (WEEK.hasOwnProperty(d)) {
        future.push(addDays(today, (WEEK[d] - today.getDay() + 7) % 7));
      } else if (/^\d{4}-/.test(d)) {
        var dt = parseDate(d); (dt > today ? future : past).push(dt);
      } else if (/^\d+$/.test(d)) {
        var n = +d, thisM = new Date(y, m, Math.min(n, lastDayOfMonth(y, m)));
        if (thisM <= today) past.push(thisM);
        if (thisM >= today) future.push(thisM); else future.push(new Date(y, m + 1, Math.min(n, lastDayOfMonth(y, m + 1))));
      }
    });
    past.sort(function (a, b) { return b - a; }); future.sort(function (a, b) { return a - b; });
    var opened = past[0] || null, openNow = false;
    if (opened) {
      if (cyc === '每月') openNow = opened.getMonth() === m && opened.getFullYear() === y;
      else if (cyc === '每季') openNow = Math.floor(opened.getMonth() / 3) === Math.floor(m / 3) && opened.getFullYear() === y;
    }
    return { openNow: openNow, openedOn: opened, next: future[0] || null, anytime: false };
  }
  function nextOpenDate(rule, today) { return openStatus(rule, today).next; }

  // ---------- 推薦 ----------
  function effRate(rule, card) { return rule.total * (rule.unit === '%' ? 1 : (card ? card.value : 1)); }
  function feeFree(rule) { return /免\s*1\.5%|免.{0,4}手續費/.test(rule.cond); }

  /**
   * opts: {region:'國內'|'日本'|'國外', holder:'全部'|'Peter'|'老婆', amount, today}
   * 回傳每張卡一列，依回饋率由高到低（刷滿的不降名次，只標示）
   */
  function recommend(db, entity, opts) {
    opts = opts || {};
    var sel = opts.region || '國內';
    var today = opts.today || new Date();
    today = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    var rows = [];
    db.holdings.forEach(function (h) {
      if (opts.holder && opts.holder !== '全部' && h.holder !== opts.holder) return;
      var card = db.cards[h.cardId];
      var cands = [];
      // 卡片基本回饋排除此通路（如四大超商、全聯）→ 該卡的一般型規則也不適用
      var baseExcluded = entity && db.rules.some(function (r) { return r.cardId === h.cardId && r.type === '基本' && excluded(r, entity); });
      db.rules.forEach(function (r) {
        if (r.cardId !== h.cardId || !isActive(r, today) || !birthdayOk(r, h, today)) return;
        var how = matchRule(r, entity, sel, db);
        if (!how || (how === 'generic' && baseExcluded)) return;
        var eff = effRate(r, card);
        var net = sel === '國內' || feeFree(r) ? eff : eff - FEE;
        var cap = capStatus(db, r, h, today);
        var baseEff = r.base * (r.unit === '%' ? 1 : card.value);
        var reward = null;
        if (opts.amount) {
          var a = opts.amount, inCap = cap ? Math.min(a, cap.remainingSpend) : a;
          reward = (inCap * bonusRate(r) + a * r.base) * (r.unit === '%' ? 1 : card.value);
        }
        cands.push({ rule: r, how: how, eff: eff, net: net, baseEff: baseEff, cap: cap,
          needReg: r.reg, registered: r.reg ? isRegistered(db, r, h, today) : null, reward: reward });
      });
      if (!cands.length) return;
      cands.forEach(function (c) { c.threshold = /滿額/.test(c.rule.scope); });
      cands.sort(function (a, b) {
        if (a.threshold !== b.threshold) return a.threshold ? 1 : -1;   // 滿額門檻型不當主推
        return b.net - a.net || (a.how === 'specific' ? -1 : 1);
      });
      rows.push({ holding: h, card: card, best: cands[0], others: cands.slice(1, 4) });
    });
    rows.sort(function (a, b) { return b.best.net - a.best.net; });
    return rows;
  }

  // ---------- 待辦 ----------
  function todos(db, today, horizonDays) {
    today = today || new Date();
    today = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    var H = horizonDays || 3;
    var regs = [], caps = [], expiring = [], unconfirmed = [];
    db.holdings.forEach(function (h) {
      db.rules.forEach(function (r) {
        if (r.cardId !== h.cardId || !isActive(r, today)) return;
        if (r.reg && !isRegistered(db, r, h, today) && !isSkipped(db, r, h)) {
          var os = openStatus(r, today);
          var nd = os.openNow ? today : os.next;
          var daysTo = os.anytime ? null : (nd ? Math.round((nd - today) / 86400000) : null);
          regs.push({ holding: h, rule: r, nextOpen: nd, daysTo: daysTo, cycle: regCycle(r), openNow: os.openNow,
            openedOn: os.openedOn, freshToday: !!(os.openedOn && +os.openedOn === +today),
            urgent: daysTo === null ? true : daysTo <= H, key: regKey(r, today) });
        }
        var cs = capStatus(db, r, h, today);
        if (cs && cs.ratio >= 0.8) caps.push({ holding: h, rule: r, cap: cs });
      });
    });
    var seen = {};
    db.rules.forEach(function (r) {
      if (!isActive(r, today)) return;
      if (r.status === '待確認') unconfirmed.push(r);
      if (r.end) {
        var left = Math.round((r.end - today) / 86400000);
        if (left <= 14 && !seen[r.id]) { seen[r.id] = 1; expiring.push({ rule: r, daysLeft: left }); }
      }
    });
    regs.sort(function (a, b) { return (a.daysTo == null ? -1 : a.daysTo) - (b.daysTo == null ? -1 : b.daysTo); });
    return { registrations: regs, caps: caps, expiring: expiring, unconfirmed: unconfirmed };
  }

  /** 記帳時自動挑規則：給持卡 + 實體 + 地區，回傳最佳規則 */
  function bestRuleFor(db, holdingId, entity, region, today) {
    var h = db.holdings.filter(function (x) { return x.id === holdingId; })[0];
    if (!h) return null;
    var rows = recommend(db, entity, { region: region, holder: h.holder, today: today });
    var row = rows.filter(function (x) { return x.holding.id === holdingId; })[0];
    return row ? row.best : null;
  }

  return {
    load: load, search: search, recommend: recommend, todos: todos, bestRuleFor: bestRuleFor,
    periodRange: periodRange, capStatus: capStatus, regKey: regKey, nextOpenDate: nextOpenDate, openStatus: openStatus,
    norm: norm, ymd: ymd, parseDate: parseDate, FEE: FEE
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CardEngine;
