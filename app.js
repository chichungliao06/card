/* 刷哪張 — 前端 */
(function () {
  'use strict';
  var E = CardEngine;
  var LS = window.localStorage;
  function lsGet(k) { try { return LS.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { LS.setItem(k, v); } catch (e) {} }

  var DEMO = /[?&]demo=1/.test(location.search);
  var S = {
    api: lsGet('cr_api') || '', token: lsGet('cr_token') || '',
    raw: null, db: null, tab: 'rec',
    region: lsGet('cr_region') || '國內', holder: lsGet('cr_holder') || '全部',
    entity: null, query: '', amount: '', txMonth: monthKey(new Date()), txHolder: '全部'
  };
  var app = document.getElementById('app');

  // ---------- 工具 ----------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pct(x, d) { return (x * 100).toFixed(d == null ? 1 : d) + '%'; }
  function money(n) { return Math.round(n).toLocaleString('zh-TW'); }
  function monthKey(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2); }
  function md(d) { return d ? (d.getMonth() + 1) + '/' + d.getDate() : ''; }
  function todayD() { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function short(s, n) { s = String(s || ''); n = n || 34; return s.length > n ? s.slice(0, n) + '…' : s; }
  function toast(msg) { var t = $('#toast'); t.textContent = msg; t.classList.add('show'); setTimeout(function () { t.classList.remove('show'); }, 1800); }
  function cardLabel(h) { return h.name; }
  function holdingById(id) { return S.db.holdings.filter(function (h) { return h.id === id; })[0]; }
  function ruleById(id) { return S.db.rules.filter(function (r) { return r.id === id; })[0]; }

  // ---------- 後端 ----------
  function apiGet() {
    if (DEMO) return fetch('sample-data.json').then(function (r) { return r.json(); });
    return fetch(S.api + '?action=data&token=' + encodeURIComponent(S.token))
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j.ok) throw new Error(j.error || '讀取失敗'); return j.data; });
  }
  function apiPost(body) {
    if (DEMO) { demoWrite(body); return Promise.resolve({ ok: true, id: body.id }); }
    body.token = S.token;
    return fetch(S.api, { method: 'POST', body: JSON.stringify(body) })   // 純文字，避免 CORS 預檢
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j.ok) throw new Error(j.error || '寫入失敗'); return j; });
  }
  function demoWrite(b) {
    var raw = S.raw;
    if (b.action === 'addTx') raw['刷卡紀錄'].push({ '紀錄ID': b.id, '日期': b.date, '持卡ID': b.holdingId, '規則ID': b.ruleId, '通路': b.merchant, '金額': b.amount, '預估回饋': b.reward, '來源': '網頁', '備註': b.note || '' });
    if (b.action === 'deleteTx') raw['刷卡紀錄'] = raw['刷卡紀錄'].filter(function (r) { return r['紀錄ID'] !== b.id; });
    if (b.action === 'setReg') raw['登錄狀態'].push({ '持卡ID': b.holdingId, '規則ID': b.ruleId, '週期': b.key, '登錄日期': E.ymd(new Date()) });
    if (b.action === 'unsetReg') raw['登錄狀態'] = raw['登錄狀態'].filter(function (r) { return !(r['持卡ID'] === b.holdingId && r['規則ID'] === b.ruleId && String(r['週期']) === b.key); });
  }
  // 寫入：先改本機資料讓畫面立刻反應，再背景同步
  function write(body, localPatch) {
    if (body.action === 'addTx' && !body.id) body.id = 'L' + Date.now();
    if (!DEMO && localPatch) { localPatch(S.raw); }
    if (DEMO) demoWrite(body);
    rebuild(); render();
    if (DEMO) return Promise.resolve();
    return apiPost(body).then(function () { return refresh(true); })
      .catch(function (e) { toast('同步失敗：' + e.message); return refresh(true); });
  }
  function rebuild() { S.db = E.load(S.raw); if (S.entity) S.entity = findEntity(S.entity.name) || S.entity; updateBadge(); }
  function findEntity(name) { return S.db.entities.filter(function (e) { return e.name === name; })[0]; }
  function refresh(silent) {
    if (!silent) $('#syncInfo').textContent = '同步中…';
    return apiGet().then(function (raw) {
      S.raw = raw; lsSet('cr_cache', JSON.stringify(raw)); rebuild(); render();
      var d = new Date(); $('#syncInfo').textContent = (DEMO ? '示範資料 ' : '已同步 ') + d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2);
    }).catch(function (e) {
      $('#syncInfo').textContent = '離線（顯示上次資料）';
      if (!S.raw) { toast(e.message); renderLogin(e.message); }
    });
  }

  // ---------- 導覽 ----------
  document.getElementById('nav').addEventListener('click', function (ev) {
    var b = ev.target.closest('button'); if (!b) return;
    S.tab = b.dataset.tab;
    [].forEach.call(document.querySelectorAll('#nav button'), function (x) { x.classList.toggle('on', x === b); });
    render();
  });
  function render() {
    if (!S.db) return;
    ({ rec: renderRec, tx: renderTx, todo: renderTodo, cards: renderCards })[S.tab]();
  }
  function updateBadge() {
    var t = E.todos(S.db, todayD(), 3);
    var n = t.registrations.filter(function (x) { return x.urgent; }).length + t.caps.length;
    var b = $('#todoBadge'); b.hidden = !n; b.textContent = n;
  }

  // ---------- 登入 ----------
  function renderLogin(err) {
    app.innerHTML =
      '<div class="login card"><h2 style="margin-top:0">第一次使用</h2>' +
      '<label class="hint">Apps Script 網頁應用程式網址（…/exec）</label><input id="lApi" value="' + esc(S.api) + '" placeholder="https://script.google.com/macros/s/…/exec">' +
      '<label class="hint" style="display:block;margin-top:10px">金鑰（OWNER_TOKEN）</label><input id="lTok" value="' + esc(S.token) + '">' +
      (err ? '<p class="hint" style="color:var(--warn)">' + esc(err) + '</p>' : '') +
      '<p><button class="btn" id="lGo">連線</button></p>' +
      '<p class="hint">只會存在這台裝置的瀏覽器裡。</p></div>';
    $('#lGo').onclick = function () {
      S.api = $('#lApi').value.trim(); S.token = $('#lTok').value.trim();
      lsSet('cr_api', S.api); lsSet('cr_token', S.token); refresh();
    };
  }

  // ---------- 推薦 ----------
  function segHtml(id, opts, cur) {
    return '<div class="seg" id="' + id + '">' + opts.map(function (o) { return '<button data-v="' + o + '"' + (o === cur ? ' class="on"' : '') + '>' + o + '</button>'; }).join('') + '</div>';
  }
  function holders() {
    var hs = []; S.db.holdings.forEach(function (h) { if (hs.indexOf(h.holder) < 0) hs.push(h.holder); });
    return ['全部'].concat(hs);
  }
  function renderRec() {
    app.innerHTML =
      segHtml('segRegion', ['國內', '日本', '其他國外'], S.region === '國外' ? '其他國外' : S.region) +
      segHtml('segHolder', holders(), S.holder) +
      '<div class="row"><div class="searchbox"><input id="q" placeholder="輸入通路或類別，例如：華航、壽司郎、外送" autocomplete="off" value="' + esc(S.query) + '"><div class="sugg" id="sugg" hidden></div></div>' +
      '<input id="amt" type="number" inputmode="numeric" placeholder="金額" style="width:96px" value="' + esc(S.amount) + '"></div>' +
      '<div id="results"></div>';
    bindSeg('segRegion', function (v) { S.region = v === '其他國外' ? '國外' : v; lsSet('cr_region', S.region); renderResults(); });
    bindSeg('segHolder', function (v) { S.holder = v; lsSet('cr_holder', v); renderResults(); });
    bindSearch($('#q'), $('#sugg'), function (ent) { S.entity = ent; S.query = ent.name; $('#q').value = ent.name; renderResults(); });
    $('#amt').oninput = function () { S.amount = this.value; renderResults(); };
    renderResults();
  }
  function bindSeg(id, fn) {
    $('#' + id).onclick = function (ev) {
      var b = ev.target.closest('button'); if (!b) return;
      [].forEach.call(this.children, function (x) { x.classList.toggle('on', x === b); });
      fn(b.dataset.v);
    };
  }
  function bindSearch(input, box, onPick) {
    var hits = [];
    function show() {
      hits = E.search(S.db, input.value, 8);
      if (!input.value.trim() || !hits.length) { box.hidden = true; return; }
      box.innerHTML = hits.map(function (h, i) {
        var e = h.entity;
        var sub = e.kind === 'category' ? '類別' : e.kind === 'general' ? '' : (e.aliases.slice(0, 2).join('、') || e.cats.join('、'));
        return '<div data-i="' + i + '">' + esc(e.name) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>';
      }).join('');
      box.hidden = false;
    }
    input.addEventListener('input', show);
    input.addEventListener('focus', show);
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && hits[0]) { ev.preventDefault(); box.hidden = true; onPick(hits[0].entity); input.blur(); } });
    box.addEventListener('mousedown', function (ev) {
      var d = ev.target.closest('[data-i]'); if (!d) return;
      ev.preventDefault(); box.hidden = true; onPick(hits[+d.dataset.i].entity); input.blur();
    });
    input.addEventListener('blur', function () { setTimeout(function () { box.hidden = true; }, 150); });
  }
  function capHtml(c, rule) {
    if (!c) return '<div class="meta">' + (rule.cap == null ? '加碼無上限' : '') + '</div>';
    var w = Math.min(100, c.ratio * 100);
    var cls = c.full ? 'full' : c.ratio >= 0.8 ? 'hi' : '';
    var cyc = { '月': '每月', '季': '每季', '帳單週期': '每期', '活動期間': '活動期間', '年': '每年' }[rule.cycle] || '';
    return '<div class="bar"><i class="' + cls + '" style="width:' + w + '%"></i></div>' +
      '<div class="meta">' + (c.full ? '本期已刷滿，' + md(c.resetDate) + ' 歸零' :
        cyc + '加碼上限 ' + money(c.cap) + '，還能刷 <b>' + money(c.remainingSpend) + '</b> 元｜' + md(c.resetDate) + ' 歸零') +
      (c.approx ? '（結帳日未填，先以自然月計）' : '') + '</div>';
  }
  function ruleChips(c) {
    var r = c.rule, out = [];
    if (r.plan) out.push('<span class="chip plan">' + esc(r.plan) + '權益</span>');
    if (c.needReg) out.push(c.registered ? '<span class="chip ok">已登錄</span>' : '<span class="chip reg">⚠ 未登錄</span>');
    if (c.cap && c.cap.full) out.push('<span class="chip full">本期已滿</span>');
    if (c.how === 'generic') out.push('<span class="chip">一般回饋</span>');
    if (c.threshold) out.push('<span class="chip">需達消費門檻</span>');
    if (r.status === '待確認') out.push('<span class="chip todo">待確認</span>');
    if (r.unit !== '%') out.push('<span class="chip">' + (r.total).toFixed(3) + ' ' + esc(r.unit) + '</span>');
    return out.join('');
  }
  function renderResults() {
    var box = $('#results'); if (!box) return;
    if (!S.entity) {
      box.innerHTML = '<div class="empty">輸入要刷的通路或類別<br><span class="hint">找不到的通路，選「一般消費（其他通路）」看基本回饋排名</span></div>';
      return;
    }
    var amount = Number(S.amount) || 0;
    var rows = E.recommend(S.db, S.entity, { region: S.region, holder: S.holder, amount: amount, today: todayD() });
    if (!rows.length) { box.innerHTML = '<div class="empty">沒有符合的卡片</div>'; return; }
    var overseas = S.region !== '國內';
    box.innerHTML = '<p class="meta">「' + esc(S.entity.name) + '」' + (overseas ? '｜淨回饋已扣 1.5% 海外手續費' : '') + '</p>' +
      rows.map(function (row, i) {
        var b = row.best, r = b.rule, h = row.holding;
        var others = row.others.length ? '<p><b>其他適用：</b>' + row.others.map(function (o) { return pct(o.eff) + ' ' + esc(short(o.rule.scope, 24)) + (o.rule.plan ? '［' + esc(o.rule.plan) + '］' : ''); }).join('；') + '</p>' : '';
        return '<div class="card"><div class="rank"><div class="no">' + (i + 1) + '</div><div class="main">' +
          '<span class="cardname">' + esc(cardLabel(h)) + '</span><span class="holder">' + esc(h.holder) + '</span>' +
          '<div class="chips">' + ruleChips(b) + '</div>' +
          capHtml(b.cap, r) +
          (amount ? '<div class="meta">刷 ' + money(amount) + ' 預估回饋 <b>' + money(b.reward) + '</b> 元</div>' : '') +
          '<details><summary>' + esc(short(r.scope, 30)) + '</summary>' +
          (r.cond ? '<p><b>條件：</b>' + esc(r.cond) + '</p>' : '') +
          (r.regNote ? '<p><b>登錄：</b>' + esc(r.regNote) + '</p>' : '') +
          '<p><b>期間：</b>' + (r.start ? E.ymd(r.start) : '') + ' ~ ' + (r.end ? E.ymd(r.end) : '未載明') + '｜來源：' + esc(r.source) + '</p>' + others +
          '</details>' +
          '<div style="margin-top:8px;display:flex;gap:6px">' +
          '<button class="btn small" data-act="tx" data-h="' + h.id + '" data-r="' + r.id + '">記一筆</button>' +
          (b.needReg && !b.registered ? '<button class="btn small ghost" data-act="reg" data-h="' + h.id + '" data-r="' + r.id + '">我已登錄</button>' : '') +
          '</div></div>' +
          '<div class="pct"><b>' + pct(b.eff) + '</b>' + (overseas ? '<span class="net">淨 ' + pct(b.net) + '</span>' : '') + '</div></div></div>';
      }).join('');
    box.onclick = function (ev) {
      var btn = ev.target.closest('button[data-act]'); if (!btn) return;
      if (btn.dataset.act === 'tx') openTx({ holdingId: btn.dataset.h, ruleId: btn.dataset.r, merchant: S.entity.name, region: S.region, amount: amount });
      if (btn.dataset.act === 'reg') markReg(btn.dataset.h, btn.dataset.r);
    };
  }
  function markReg(hid, rid, skip) {
    var r = ruleById(rid);
    var key = skip ? 'skip' : E.regKey(r, todayD());
    write({ action: 'setReg', holdingId: hid, ruleId: rid, key: key }, function (raw) {
      raw['登錄狀態'].push({ '持卡ID': hid, '規則ID': rid, '週期': key, '登錄日期': E.ymd(new Date()) });
    });
    toast(skip ? '這項之後不再提醒' : '已記錄登錄（' + (key === 'once' ? '整個活動期間' : key) + '）');
  }

  // ---------- 記一筆 ----------
  function openTx(pre) {
    pre = pre || {};
    var dlg = $('#txDlg'), f = $('#txForm');
    var region = pre.region || S.region;
    var opts = S.db.holdings.map(function (h) { return '<option value="' + h.id + '"' + (h.id === pre.holdingId ? ' selected' : '') + '>' + esc(h.holder + '｜' + h.name) + '</option>'; }).join('');
    f.innerHTML = '<h2 style="margin-top:0">記一筆</h2>' +
      '<label>日期</label><input type="date" id="tDate" value="' + E.ymd(new Date()) + '">' +
      '<label>卡片</label><select id="tHold">' + opts + '</select>' +
      '<label>通路</label><div class="searchbox"><input id="tMer" autocomplete="off" value="' + esc(pre.merchant || '') + '"><div class="sugg" id="tSugg" hidden></div></div>' +
      '<label>地區</label>' + segHtml('tReg', ['國內', '日本', '其他國外'], region === '國外' ? '其他國外' : region) +
      '<label>金額（台幣）</label><input type="number" inputmode="numeric" id="tAmt" value="' + (pre.amount || '') + '">' +
      '<label>套用回饋</label><select id="tRule"></select>' +
      '<p class="meta" id="tEst"></p>' +
      '<label>備註</label><input id="tNote">' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px"><button class="btn ghost" value="cancel">取消</button><button class="btn" id="tSave" value="ok">儲存</button></div>';
    var ent = pre.merchant ? (findEntity(pre.merchant) || (E.search(S.db, pre.merchant, 1)[0] || {}).entity) : null;
    function cands() {
      var hid = $('#tHold').value, h = holdingById(hid);
      var rows = E.recommend(S.db, ent, { region: region, holder: h.holder, amount: Number($('#tAmt').value) || 0, today: E.parseDate($('#tDate').value) || todayD() });
      var row = rows.filter(function (x) { return x.holding.id === hid; })[0];
      return row ? [row.best].concat(row.others) : [];
    }
    function fillRules(keep) {
      var cs = cands();
      var sel = $('#tRule');
      sel.innerHTML = cs.map(function (c) { return '<option value="' + c.rule.id + '">' + esc(pct(c.eff) + '｜' + short(c.rule.scope, 22) + (c.rule.plan ? '［' + c.rule.plan + '］' : '')) + '</option>'; }).join('') + '<option value="">（不套用規則）</option>';
      if (keep && cs.some(function (c) { return c.rule.id === keep; })) sel.value = keep;
      est();
    }
    function est() {
      var cs = cands(), rid = $('#tRule').value;
      var c = cs.filter(function (x) { return x.rule.id === rid; })[0];
      var amt = Number($('#tAmt').value) || 0;
      $('#tEst').innerHTML = c && amt ? '預估回饋 <b>' + money(c.reward) + '</b> 元' + (c.cap ? '｜本期還能刷 ' + money(c.cap.remainingSpend) + ' 元' : '') : '';
      return c;
    }
    bindSearch($('#tMer'), $('#tSugg'), function (e) { ent = e; $('#tMer').value = e.name; fillRules(); });
    bindSeg('tReg', function (v) { region = v === '其他國外' ? '國外' : v; fillRules(); });
    $('#tHold').onchange = function () { fillRules(); };
    $('#tAmt').oninput = est; $('#tRule').onchange = est; $('#tDate').onchange = function () { fillRules($('#tRule').value); };
    fillRules(pre.ruleId);
    $('#tSave').onclick = function (ev) {
      ev.preventDefault();
      var amt = Number($('#tAmt').value);
      if (!amt) { toast('請輸入金額'); return; }
      var c = est();
      var body = { action: 'addTx', id: 'L' + Date.now(), date: $('#tDate').value, holdingId: $('#tHold').value, ruleId: $('#tRule').value,
        merchant: $('#tMer').value.trim(), amount: amt, reward: c ? Math.round(c.reward * 10) / 10 : 0, note: $('#tNote').value.trim() };
      dlg.close();
      write(body, function (raw) {
        raw['刷卡紀錄'].push({ '紀錄ID': body.id, '日期': body.date, '持卡ID': body.holdingId, '規則ID': body.ruleId, '通路': body.merchant, '金額': body.amount, '預估回饋': body.reward, '來源': '網頁', '備註': body.note });
      });
      toast('已記錄');
    };
    dlg.showModal();
  }

  // ---------- 記帳紀錄 ----------
  function renderTx() {
    var months = {}; S.db.txs.forEach(function (t) { if (t.date) months[monthKey(t.date)] = 1; }); months[monthKey(new Date())] = 1;
    var mlist = Object.keys(months).sort().reverse();
    var list = S.db.txs.filter(function (t) {
      if (!t.date || monthKey(t.date) !== S.txMonth) return false;
      var h = holdingById(t.holdingId); return S.txHolder === '全部' || (h && h.holder === S.txHolder);
    }).sort(function (a, b) { return b.date - a.date; });
    var sum = 0, rew = 0; list.forEach(function (t) { sum += t.amount; rew += t.reward; });
    app.innerHTML = '<div class="row" style="margin-bottom:8px"><select id="txM">' + mlist.map(function (m) { return '<option' + (m === S.txMonth ? ' selected' : '') + '>' + m + '</option>'; }).join('') + '</select>' +
      '<button class="btn" id="txAdd" style="white-space:nowrap">＋ 記一筆</button></div>' +
      segHtml('txH', holders(), S.txHolder) +
      '<div class="card"><div class="meta">本月 ' + list.length + ' 筆｜刷卡 ' + money(sum) + ' 元｜預估回饋 ' + money(rew) + ' 元</div></div>' +
      (list.length ? '<div class="card list">' + list.map(function (t) {
        var h = holdingById(t.holdingId), r = ruleById(t.ruleId);
        return '<div class="item"><div class="l"><b>' + esc(t.merchant || '（未填通路）') + '</b> <span class="meta">' + md(t.date) + (t.source && t.source !== '網頁' ? '｜' + esc(t.source) : '') + '</span>' +
          '<div class="meta">' + esc(h ? h.holder + '｜' + h.name : t.holdingId) + (r ? '｜' + esc(short(r.scope, 16)) : '') + (t.note ? '｜' + esc(t.note) : '') + '</div></div>' +
          '<div class="r">' + money(t.amount) + '<div class="meta">回饋 ' + t.reward + '</div><button class="btn small ghost" data-del="' + esc(t.id) + '">刪除</button></div></div>';
      }).join('') + '</div>' : '<div class="empty">這個月還沒有紀錄</div>');
    $('#txM').onchange = function () { S.txMonth = this.value; renderTx(); };
    $('#txAdd').onclick = function () { openTx({}); };
    bindSeg('txH', function (v) { S.txHolder = v; renderTx(); });
    app.onclick = function (ev) {
      var d = ev.target.closest('[data-del]'); if (!d) return;
      if (!confirm('刪除這筆紀錄？')) return;
      var id = d.dataset.del;
      write({ action: 'deleteTx', id: id }, function (raw) { raw['刷卡紀錄'] = raw['刷卡紀錄'].filter(function (r) { return String(r['紀錄ID']) !== id; }); });
    };
  }

  // ---------- 待辦 ----------
  function renderTodo() {
    app.onclick = null;
    var t = E.todos(S.db, todayD(), 7);
    var soon = t.registrations.filter(function (x) { return x.daysTo !== null && x.daysTo <= 7; });
    var any = t.registrations.filter(function (x) { return x.daysTo === null; });
    var later = t.registrations.filter(function (x) { return x.daysTo !== null && x.daysTo > 7; });
    function regItem(x) {
      var rem = x.rule.reminder || {};
      var when = x.daysTo === null ? '隨時可登錄' : x.openNow ? '登錄開放中（' + md(x.openedOn) + ' 起）' : x.daysTo === 0 ? '今天開放' : x.daysTo === 1 ? '明天開放' : md(x.nextOpen) + ' 開放';
      return '<div class="item"><div class="l"><b>' + esc(x.holding.holder) + '｜' + esc(x.holding.name) + '</b>' +
        '<div class="meta">' + esc(short(x.rule.scope, 40)) + '</div>' +
        '<div class="meta">' + when + (rem.time ? ' ' + esc(rem.time) : '') + '｜' + esc(x.cycle) + '｜' + esc(rem.note || x.rule.regNote) + '</div></div>' +
        '<div class="r"><button class="btn small" data-reg="' + x.holding.id + '|' + x.rule.id + '">已登錄</button><br>' +
        '<button class="btn small ghost" style="margin-top:4px" data-skip="' + x.holding.id + '|' + x.rule.id + '">不提醒</button></div></div>';
    }
    var html = '';
    html += '<h2>7 天內開放登錄（' + soon.length + '）</h2>' + (soon.length ? '<div class="card list">' + soon.map(regItem).join('') + '</div>' : '<div class="card meta">沒有</div>');
    html += '<h2>隨時可登錄、還沒登錄（' + any.length + '）</h2>' + (any.length ? '<div class="card list">' + any.map(regItem).join('') + '</div>' : '<div class="card meta">沒有</div>');
    html += '<h2>回饋上限 80% 以上（' + t.caps.length + '）</h2>' + (t.caps.length ? '<div class="card list">' + t.caps.map(function (x) {
      return '<div class="item"><div class="l"><b>' + esc(x.holding.holder) + '｜' + esc(x.holding.name) + '</b><div class="meta">' + esc(short(x.rule.scope, 40)) + '</div>' + capHtml(x.cap, x.rule) + '</div></div>';
    }).join('') + '</div>' : '<div class="card meta">沒有</div>');
    html += '<h2>14 天內到期（' + t.expiring.length + '）</h2>' + (t.expiring.length ? '<div class="card list">' + t.expiring.map(function (x) {
      var c = S.db.cards[x.rule.cardId];
      return '<div class="item"><div class="l"><b>' + esc(c ? c.bank + ' ' + c.name : '') + '</b><div class="meta">' + esc(short(x.rule.scope, 40)) + '</div></div><div class="r">剩 ' + x.daysLeft + ' 天</div></div>';
    }).join('') + '</div>' : '<div class="card meta">沒有</div>');
    if (later.length) html += '<details class="card"><summary>之後才開放登錄（' + later.length + '）</summary><div class="list">' + later.map(regItem).join('') + '</div></details>';
    if (t.unconfirmed.length) html += '<h2>資料待確認（' + t.unconfirmed.length + '）</h2><div class="card list">' + t.unconfirmed.map(function (r) {
      var c = S.db.cards[r.cardId]; return '<div class="item"><div class="l"><b>' + esc(c ? c.bank + ' ' + c.name : '') + '</b><div class="meta">' + esc(short(r.scope, 40)) + '｜' + esc(r.source) + '</div></div></div>';
    }).join('') + '</div>';
    app.innerHTML = html;
    app.onclick = function (ev) {
      var b = ev.target.closest('[data-reg],[data-skip]'); if (!b) return;
      var p = (b.dataset.reg || b.dataset.skip).split('|');
      markReg(p[0], p[1], !!b.dataset.skip);
    };
  }

  // ---------- 卡片 ----------
  function renderCards() {
    app.onclick = null;
    var today = todayD();
    var html = '';
    holders().slice(1).forEach(function (who) {
      html += '<h2>' + esc(who) + '</h2>';
      S.db.holdings.filter(function (h) { return h.holder === who; }).forEach(function (h) {
        var rules = S.db.rules.filter(function (r) { return r.cardId === h.cardId && r.status !== '已過期' && (!r.end || r.end >= today); });
        var maxR = rules.reduce(function (m, r) { return Math.max(m, r.total * (r.unit === '%' ? 1 : S.db.cards[h.cardId].value)); }, 0);
        html += '<details class="card"><summary><b style="color:var(--ink)">' + esc(h.name) + '</b>　最高 ' + pct(maxR) + (h.closeDay ? '' : '　<span class="chip todo">結帳日未填</span>') + '</summary>' +
          '<div class="list">' + rules.map(function (r) {
            var cs = E.capStatus(S.db, r, h, today);
            return '<div class="item"><div class="l"><div>' + esc(short(r.scope, 44)) + '</div>' +
              '<div class="chips">' + (r.plan ? '<span class="chip plan">' + esc(r.plan) + '</span>' : '') + '<span class="chip">' + esc(r.region) + '</span>' +
              (r.reg ? '<span class="chip reg">需登錄</span>' : '') + (r.status === '待確認' ? '<span class="chip todo">待確認</span>' : '') +
              (r.end ? '<span class="chip">至 ' + E.ymd(r.end) + '</span>' : '') + '</div>' + (cs ? capHtml(cs, r) : '') + '</div>' +
              '<div class="r"><b>' + (r.unit === '%' ? pct(r.total) : r.total.toFixed(3) + ' ' + esc(r.unit)) + '</b></div></div>';
          }).join('') + '</div></details>';
      });
    });
    html += '<p class="hint">要修改回饋或新增活動，直接改 Google Sheet 的「回饋規則」表，回到這裡重新整理即可。</p>' +
      '<p><button class="btn ghost" id="relog">更換連線設定</button> <button class="btn ghost" id="reload">重新同步</button></p>';
    app.innerHTML = html;
    $('#relog').onclick = function () { renderLogin(); };
    $('#reload').onclick = function () { refresh(); };
  }

  // ---------- 啟動 ----------
  var cache = lsGet('cr_cache');
  if (cache && !DEMO) { try { S.raw = JSON.parse(cache); rebuild(); render(); } catch (e) {} }
  if (DEMO || (S.api && S.token)) refresh(); else renderLogin();
})();
