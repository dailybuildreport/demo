/*
 * Цифровой штаб строительства — универсальный движок проекта.
 *
 * PROJECT DATA (data/projects/*.js)  →  DSF.build(project)  →  модель M  →  UI
 *
 * Движок ничего не знает о конкретных объектах, видах работ или стадиях.
 * Датасет содержит только первичные факты (план/факт работ, договоры, риски…),
 * всё производное — готовность, прогноз, критический путь, бюджет, календарь,
 * лента событий, «требует внимания» — считается здесь и только здесь.
 * Файл не трогает DOM и запускается в Node для проверки данных.
 */
(function (root) {
  'use strict';

  const DSF = root.DSF = root.DSF || {};
  DSF.projects = DSF.projects || [];
  DSF.config = Object.assign({ today: '2026-10-05' }, DSF.config || {});
  DSF.register = function (p) { DSF.projects.push(p); };
  DSF.extensions = DSF.extensions || [];
  DSF.invalidate = function (pid) { DSF.projects.forEach(p => { if (!pid || p.id === pid) delete p.__model; }); };

  /* ---------- даты ---------- */
  const DAY = 864e5;
  const dn = s => (s == null || s === '') ? null : Math.round(Date.parse(String(s).slice(0, 10) + 'T00:00:00Z') / DAY);
  const iso = d => new Date(d * DAY).toISOString().slice(0, 10);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sum = (arr, f) => arr.reduce((s, x) => s + (f ? (f(x) || 0) : (x || 0)), 0);
  const monthStart = d => { const x = new Date(d * DAY); return Math.round(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 1) / DAY); };
  const monthEnd = d => { const x = new Date(d * DAY); return Math.round(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 1) / DAY) - 1; };
  const addMonths = (d, n) => { const x = new Date(d * DAY); return Math.round(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + n, 1) / DAY); };
  DSF.util = { DAY, dn, iso, clamp, sum, monthStart, monthEnd, addMonths };

  /* ---------- справочники (общие для всех проектов) ---------- */
  DSF.RISK_STATUS = ['Реализуется', 'Открыт', 'Под контролем', 'Закрыт'];
  DSF.riskLevel = score => score >= 15 ? 'high' : score >= 8 ? 'mid' : 'low';
  /* типы событий календаря: пользовательские + системные (из графика) */
  DSF.EVENT_TYPES = {
    meeting:    { t: 'Встреча',                       c: 'accent',  user: true, letter: 'invite' },
    conference: { t: 'Совещание',                     c: 'accent',  user: true, letter: 'invite' },
    acceptance: { t: 'Приёмка работ',                 c: 'good',    user: true, letter: 'invite' },
    inspection: { t: 'Освидетельствование конструкции', c: 'good',  user: true, letter: 'letter' },
    rd:         { t: 'Выдача РД',                     c: 'accent',  user: true, letter: 'letter' },
    delivery:   { t: 'Поставка',                      c: 'warn',    user: true, letter: 'letter' },
    control:    { t: 'Контрольная дата',              c: 'crit',    user: true, letter: 'letter' },
    site:       { t: 'Событие по объекту',            c: 'neutral', user: true, letter: 'letter' },
    order:      { t: 'Протокольное поручение',        c: 'warn',    user: true, letter: 'letter' },
    other:      { t: 'Другое',                        c: 'neutral', user: true, letter: 'letter' },
    milestone:  { t: 'Веха графика',                  c: 'accent' },
    start:      { t: 'Начало работ',                  c: 'neutral' },
    finish:     { t: 'Завершение работ',              c: 'good' }
  };
  /* двухэтапный процесс КС-2: заявка подрядчика → приёмка → КС-2 по принятому → расчётный период */
  DSF.KS_STATUS = {
    draft:    { t: 'Черновик подрядчика', r: 0, c: 'neutral', stage: 1 },
    sent:     { t: 'Направлено на предварительную проверку', r: 1, c: 'accent', stage: 1 },
    review:   { t: 'Проверяется Техническим заказчиком', r: 2, c: 'accent', stage: 1 },
    remarks:  { t: 'Есть замечания — требуется корректировка', r: 2, c: 'warn', stage: 1 },
    pre:      { t: 'Предварительно согласовано', r: 3, c: 'good', stage: 1 },
    accept:   { t: 'Направлено на приёмку', r: 4, c: 'accent', stage: 1 },
    accepted: { t: 'Работы приняты', r: 5, c: 'good', stage: 1 },
    partial:  { t: 'Принято частично', r: 5, c: 'warn', stage: 1 },
    rejected: { t: 'Не принято — замечания', r: 5, c: 'crit', stage: 1 },
    formed:   { t: 'КС-2 сформирована по принятому объёму', r: 6, c: 'accent', stage: 2 },
    agreed:   { t: 'КС-2 согласована', r: 7, c: 'good', stage: 2 },
    period:   { t: 'Включено в расчётный период', r: 8, c: 'good', stage: 2 },
    paid:     { t: 'Оплачено', r: 9, c: 'good', stage: 2 }
  };
  DSF.KS_NEXT = {
    draft: ['sent'], sent: ['review'], review: ['pre', 'remarks'], remarks: ['sent'], pre: ['accept'],
    accept: ['accepted', 'partial', 'rejected'], accepted: ['formed'], partial: ['formed'], rejected: ['sent'],
    formed: ['agreed'], agreed: ['period'], period: [], paid: []
  };

  function parseDep(s) {
    const m = /^([\w.-]+)(?::(FS|SS|FF)([+-]\d+)?)?$/.exec(String(s).trim());
    if (!m) return { id: String(s), type: 'FS', lag: 0, bad: true };
    return { id: m[1], type: m[2] || 'FS', lag: +(m[3] || 0) };
  }

  /* ---------- прогноз сроков: прямой и обратный проход ---------- */
  function schedule(tasks, byId, T, extra, finalId) {
    const res = new Map();
    const visiting = new Set();
    function fwd(t) {
      if (res.has(t.id)) return res.get(t.id);
      if (visiting.has(t.id)) throw new Error('Цикл в связях работ: ' + t.id);
      visiting.add(t.id);
      const deps = t.deps.map(d => ({ d, r: byId.get(d.id) ? fwd(byId.get(d.id)) : null })).filter(x => x.r);
      const ex = extra.get(t.id) || 0;
      let es, ef;
      if (t.ms) {
        if (t.af != null) { es = ef = t.af; }
        else {
          let x = deps.length ? -Infinity : t.f0;
          deps.forEach(({ d, r }) => { x = Math.max(x, (d.type === 'SS' ? r.es : r.ef) + d.lag); });
          es = ef = Math.max(x, T) + ex;
        }
      } else if (t.done) { es = t.as; ef = t.af; }
      else if (t.as != null) {
        es = t.as;
        const rem = Math.ceil(t.dur * (1 - t.pct / 100));
        ef = Math.max(T + rem - 1, T) + ex;
        deps.forEach(({ d, r }) => { if (d.type === 'FF') ef = Math.max(ef, r.ef + d.lag); });
      } else {
        es = Math.max(t.s0, T);
        deps.forEach(({ d, r }) => {
          if (d.type === 'FS') es = Math.max(es, r.ef + 1 + d.lag);
          if (d.type === 'SS') es = Math.max(es, r.es + d.lag);
        });
        ef = es + t.dur - 1 + ex;
        deps.forEach(({ d, r }) => { if (d.type === 'FF') ef = Math.max(ef, r.ef + d.lag); });
      }
      const o = { es, ef };
      visiting.delete(t.id);
      res.set(t.id, o);
      return o;
    }
    tasks.forEach(fwd);
    const fin = finalId && res.get(finalId) ? res.get(finalId).ef : Math.max(...[...res.values()].map(r => r.ef));
    return { res, end: fin };
  }

  function backward(tasks, byId, res, end) {
    const succ = new Map(tasks.map(t => [t.id, []]));
    tasks.forEach(t => t.deps.forEach(d => { if (succ.has(d.id)) succ.get(d.id).push({ t, d }); }));
    const lf = new Map();
    function late(t) {
      if (lf.has(t.id)) return lf.get(t.id);
      const r = res.get(t.id), span = r.ef - r.es;
      let v = Infinity;
      const ss = succ.get(t.id);
      if (!ss.length) v = end;
      ss.forEach(({ t: s, d }) => {
        const sl = late(s), sr = res.get(s.id), sls = sl - (sr.ef - sr.es);
        if (d.type !== 'FF' && (s.as != null || s.af != null)) return; // ограничение по началу уже выполнено фактом
        if (d.type === 'FS') v = Math.min(v, sls - 1 - d.lag + (s.ms ? 1 : 0));
        else if (d.type === 'SS') v = Math.min(v, sls - d.lag + span);
        else v = Math.min(v, sl - d.lag);
      });
      if (!isFinite(v)) v = end;
      lf.set(t.id, v);
      return v;
    }
    tasks.forEach(late);
    return lf;
  }

  /* ---------- сборка модели проекта ---------- */
  DSF.build = function (P) {
    if (P.__model) return P.__model;
    const T = dn(DSF.config.today);
    const S = (DSF.store && DSF.store.get(P.id)) || {};
    ['events', 'eventOps', 'docs', 'docOps', 'orders', 'orderOps', 'ks', 'ksOps', 'letters'].forEach(k => { if (!Array.isArray(S[k])) S[k] = []; });
    const items = (P.budget.items || []).map(it => Object.assign({ inReadiness: true }, it));
    const itemBy = new Map(items.map(i => [i.code, i]));

    const tasks = P.tasks.map((x, i) => {
      const t = Object.assign({}, x);
      t.idx = i;
      t.ms = !!x.ms;
      t.s0 = dn(x.ps || x.pf); t.f0 = dn(x.pf || x.ps);
      t.as = dn(x.as); t.af = dn(x.af);
      t.pct = x.ms ? (x.af ? 100 : 0) : (x.pct || 0);
      t.done = t.pct >= 100;
      t.dur = t.ms ? 0 : t.f0 - t.s0 + 1;
      t.cost = t.ms ? 0 : (x.cost || 0);
      t.deps = (x.deps || []).map(parseDep);
      t.stage = x.stage || 'Работы';
      const it = itemBy.get(x.item);
      t.weighted = !t.ms && (!it || it.inReadiness !== false);
      return t;
    });
    const byId = new Map(tasks.map(t => [t.id, t]));
    const finalId = (tasks.find(t => t.final) || {}).id;

    /* риски: оценка и влияние */
    const risks = (P.risks || []).map(r => {
      const o = Object.assign({}, r);
      o.score = r.p * r.i;
      o.level = DSF.riskLevel(o.score);
      o.active = r.status !== 'Закрыт';
      o.realized = r.status === 'Реализуется';
      o.eff = r.effect || {};
      return o;
    });
    const extraFor = skip => {
      const m = new Map();
      risks.forEach(r => { if (r.realized && r.eff.task && r.eff.days && r !== skip) m.set(r.eff.task, (m.get(r.eff.task) || 0) + r.eff.days); });
      return m;
    };
    const base = schedule(tasks, byId, T, extraFor(null), finalId);
    const lf = backward(tasks, byId, base.res, base.end);
    tasks.forEach(t => {
      const r = base.res.get(t.id);
      t.es = r.es; t.ef = r.ef;
      t.lf = lf.get(t.id);
      t.float = t.lf - t.ef;
      t.crit = !t.done && t.float <= 0;
      t.extra = extraFor(null).get(t.id) || 0;
      t.planNow = planPct(t, T);
      t.dev = t.ms ? 0 : t.pct - t.planNow;
      t.slip = t.ef - t.f0;                       // + позже плана
      t.started = t.as != null || (t.ms && t.af != null);
      t.state = t.done ? 'done' : t.started ? 'active' : 'wait';
      t.flags = [];
      if (!t.done && t.f0 < T) t.flags.push('overdue');
      if (!t.started && !t.ms && t.s0 < T) t.flags.push('latestart');
      if (t.state === 'active' && t.dev < -7) t.flags.push('lag');
      t.st = taskStatus(t);
    });
    // вклад каждого реализующегося риска в сдвиг окончания проекта
    risks.forEach(r => {
      r.projectDays = 0;
      if (r.realized && r.eff.task && r.eff.days) {
        const alt = schedule(tasks, byId, T, extraFor(r), finalId);
        r.projectDays = base.end - alt.end;
      }
      r.task = r.eff.task ? byId.get(r.eff.task) : null;
    });

    /* этапы (группы работ) */
    const stageNames = [...new Set(tasks.map(t => t.stage))];
    const stages = stageNames.map(name => {
      const ts = tasks.filter(t => t.stage === name);
      const w = ts.filter(t => !t.ms);
      const cost = sum(w, t => t.cost);
      const s = {
        id: 'st' + stageNames.indexOf(name), name, tasks: ts,
        s0: Math.min(...ts.map(t => t.s0)), f0: Math.max(...ts.map(t => t.f0)),
        es: Math.min(...ts.map(t => t.es)), ef: Math.max(...ts.map(t => t.ef)),
        cost,
        pct: cost ? sum(w, t => t.cost * t.pct) / cost : (ts.every(t => t.done) ? 100 : 0),
        planNow: cost ? sum(w, t => t.cost * t.planNow) / cost : 0,
        crit: ts.some(t => t.crit),
        done: ts.every(t => t.done),
        started: ts.some(t => t.started)
      };
      s.as = s.started ? Math.min(...ts.filter(t => t.started).map(t => t.as != null ? t.as : t.af)) : null;
      s.af = s.done ? Math.max(...ts.map(t => t.af != null ? t.af : t.f0)) : null;
      s.slip = s.ef - s.f0;
      s.state = s.done ? 'done' : s.started ? 'active' : 'wait';
      s.dev = s.pct - s.planNow;
      return s;
    });

    /* готовность и сроки */
    const W = tasks.filter(t => t.weighted);
    const wsum = sum(W, t => t.cost);
    const readyAt = (x, fn) => sum(W, t => t.cost * fn(t, x)) / wsum;
    const start = dn(P.dates.start), planEnd = dn(P.dates.planEnd);
    const fin = finalId ? byId.get(finalId) : null;
    const forecastEnd = base.end;
    const root = {
      pc: readyAt(T, (t) => t.pct),
      planNow: readyAt(T, planPct),
      start, planEnd, forecastEnd,
      delay: forecastEnd - planEnd,
      elapsed: clamp(T - start, 0, planEnd - start), total: planEnd - start
    };
    root.dev = root.pc - root.planNow;
    root.timePct = root.elapsed / root.total * 100;
    root.left = Math.max(0, forecastEnd - T);

    /* кривые план/факт/прогноз (готовность, %) */
    const curve = [];
    const c0 = monthStart(Math.min(start, ...tasks.map(t => t.s0))), c1 = monthEnd(Math.max(planEnd, forecastEnd));
    for (let m = c0; m <= c1; m = addMonths(m, 1)) {
      const x = monthEnd(m);
      curve.push({ t: x, plan: readyAt(x, planPct), fact: x <= T ? readyAt(x, factPct) : null, fc: x >= T ? readyAt(x, forecastPct) : null });
    }
    const curveT = { t: T, plan: root.planNow, fact: root.pc, fc: root.pc };

    /* бюджет */
    function fracAt(c, x) {
      const it = itemBy.get(c.item);
      if (c.tasks.length === 0) {
        if (it && it.mode === 'linear') return clamp((x - start + 1) / (forecastEnd - start + 1), 0, 1);
        return 0;
      }
      const b = sum(c.tasks, t => t.cost);
      return b ? sum(c.tasks, t => t.cost * factPct(t, x)) / b / 100 : 0;
    }
    function planFracAt(c, x) {
      const it = itemBy.get(c.item);
      if (c.tasks.length === 0) return it && it.mode === 'linear' ? clamp((x - start + 1) / (planEnd - start + 1), 0, 1) : 0;
      const b = sum(c.tasks, t => t.cost);
      return b ? sum(c.tasks, t => t.cost * planPct(t, x)) / b / 100 : 0;
    }
    const ksCfg = new Map((P.ks2 || []).map(k => [k.contract, k]));
    const KR = st => (DSF.KS_STATUS[st] || DSF.KS_STATUS.draft).r;
    function ksLines(c, from, to) {
      const base = sum(c.tasks, t => t.cost);
      if (!base) return [];
      const k = c.amount / base;
      return c.tasks.map(t => { const p0 = factPct(t, from), p1 = factPct(t, to); return { task: t, p0, p1, amount: t.cost * k * (p1 - p0) / 100 }; }).filter(l => l.amount > 0.05);
    }
    const allKs = [];
    const contracts = (P.contracts || []).map(x => {
      const c = Object.assign({}, x);
      c.d = dn(x.date);
      c.tasks = tasks.filter(t => t.contract === c.id);
      c.frac = fracAt(c, T);
      c.done = c.amount * c.frac;
      c.adv = x.adv || 0; c.ret = x.ret == null ? 0.05 : x.ret;
      // объективное выполнение по графику закрывается ежемесячно на 25-е число
      c.ks = [];
      let acted = 0, n = 0, prev = Math.max(c.d, start) - 1;
      for (let m = monthStart(Math.max(c.d, start)); m <= T; m = addMonths(m, 1)) {
        const ad = m + 24;
        if (ad > T) break;
        const v = c.amount * fracAt(c, ad) - acted;
        if (v > 0.05) {
          n++;
          const paid = ad + 30 <= T;
          const k = { id: 'ks-' + c.id + '-' + n, no: 'КС-2 № ' + n, n, contract: c, period: m, d: ad, obj: v, claimed: v, accepted: v, amount: v, status: paid ? 'paid' : 'period',
            lines: ksLines(c, prev, ad), origin: 'history', history: [
              { d: ad - 4, st: 'sent', text: 'Подрядчик направил КС-2 на проверку' },
              { d: ad - 2, st: 'accepted', text: 'Работы приняты Техническим заказчиком' },
              { d: ad, st: 'agreed', text: 'КС-2 согласована' },
              { d: ad, st: 'period', text: 'Включено в расчётный период ' + MONTHS_FULL[new Date(m * DAY).getUTCMonth()] }
            ].concat(paid ? [{ d: ad + 30, st: 'paid', text: 'Оплачено' }] : []) };
          c.ks.push(k); acted += v; prev = ad;
        }
      }
      c.lastAct = prev;
      // текущая заявка подрядчика по последнему периоду (из датасета)
      const cfg = ksCfg.get(c.id);
      if (cfg && c.ks.length) {
        const k = c.ks[c.ks.length - 1];
        k.origin = 'flow'; k.status = cfg.status;
        k.claimed = k.obj * (cfg.claimedK || 1);
        k.accepted = KR(cfg.status) >= 5 ? (cfg.status === 'rejected' ? 0 : k.obj * (cfg.acceptedK || 1)) : null;
        k.amount = KR(cfg.status) >= 6 ? k.accepted : null;
        k.history = (cfg.history || []).map(h => ({ d: dn(h.date), st: h.st, text: h.text || (DSF.KS_STATUS[h.st] || {}).t, by: h.by }));
        k.event = cfg.event || null;
        k.note = cfg.note || '';
      }
      c.ks.forEach(k => allKs.push(k));
      return c;
    });
    // заявки, созданные пользователем (подрядчиком) в демо
    S.ks.forEach(u => {
      const c = contracts.find(z => z.id === u.contract); if (!c) return;
      const k = { id: u.id, no: u.no || ('Заявка ' + u.id.split('-').pop()), n: c.ks.length + 1, contract: c, period: monthStart(dn(u.date)), d: dn(u.date), obj: u.obj, claimed: u.claimed, accepted: null, amount: null,
        status: 'draft', lines: ksLines(c, c.lastAct, T).map(l => Object.assign(l, { amount: l.amount * (u.obj / Math.max(0.0001, c.done - sum(c.ks, z => z.obj))) })), origin: 'user', user: true,
        history: [{ d: dn(u.date), st: 'draft', text: 'Подрядчик сформировал черновик КС-2', by: u.by }], note: u.note || '' };
      c.ks.push(k); allKs.push(k);
    });
    // операции по КС-2 (переходы статусов, результат приёмки)
    S.ksOps.forEach(op => {
      const k = allKs.find(z => z.id === op.ks); if (!k) return;
      k.status = op.to;
      if (op.event) k.event = op.event;
      if (op.to === 'accepted') k.accepted = k.obj;
      if (op.to === 'partial') k.accepted = Math.min(k.obj, Math.max(0, +op.accepted || 0));
      if (op.to === 'rejected') k.accepted = 0;
      if (op.to === 'sent' && k.accepted != null && KR(k.status) < 5) { k.accepted = null; k.amount = null; }
      if (op.to === 'formed') k.amount = k.accepted;
      if (op.claimed != null) k.claimed = +op.claimed;
      k.history.push({ d: dn(op.date), st: op.to, text: op.text || (DSF.KS_STATUS[op.to] || {}).t, by: op.by, note: op.note });
    });
    contracts.forEach(c => {
      c.claimed = sum(c.ks, k => k.claimed || 0);
      c.accepted = sum(c.ks, k => k.accepted || 0);
      c.ksFormed = sum(c.ks.filter(k => KR(k.status) >= 6), k => k.amount || 0);
      c.agreed = sum(c.ks.filter(k => KR(k.status) >= 7), k => k.amount || 0);
      const paidActs = sum(c.ks.filter(k => k.status === 'paid'), k => k.amount || 0);
      c.acted = sum(c.ks, k => KR(k.status) >= 5 ? (k.accepted || 0) : k.obj); // непринятая часть возвращается в «не предъявлено»
      c.unacted = Math.max(0, c.done - c.acted);
      c.pendingKs = c.ks.filter(k => KR(k.status) < 7 && k.status !== 'rejected');
      const advance = c.amount * c.adv;
      c.advance = advance;
      c.paidActs = paidActs;
      c.paid = advance * (1 - paidActs / c.amount) + paidActs * (1 - c.ret);
      c.retained = paidActs * c.ret;
      c.left = c.amount - c.agreed;
      c.acts = c.ks.filter(k => KR(k.status) >= 7).map(k => ({ no: k.n, date: k.d, amount: k.amount, paid: k.status === 'paid', ks: k }));
      c.state = c.frac >= 0.999 ? 'done' : c.frac > 0 ? 'active' : 'wait';
      c.planFrac = planFracAt(c, T);
    });
    const contractBy = new Map(contracts.map(c => [c.id, c]));
    items.forEach(it => {
      const cs = contracts.filter(c => c.item === it.code);
      const ts = tasks.filter(t => t.item === it.code && !t.ms);
      it.contracts = cs;
      it.tasks = ts;
      it.contracted = sum(cs, c => c.amount);
      it.done = sum(cs, c => c.done);
      it.acted = sum(cs, c => c.acted);
      it.claimed = sum(cs, c => c.claimed);
      it.accepted = sum(cs, c => c.accepted);
      it.agreed = sum(cs, c => c.agreed);
      it.paid = sum(cs, c => c.paid);
      it.taskBase = sum(ts, t => t.cost);
      const uncontracted = it.mode === 'linear' ? Math.max(0, it.budget - it.contracted) : sum(ts.filter(t => !t.contract), t => t.cost);
      it.uncontracted = uncontracted;
      it.riskCost = sum(risks.filter(r => r.realized && r.eff.item === it.code), r => r.eff.cost || 0);
      it.forecast = it.contracted + uncontracted + it.riskCost + (it.adj || 0);
      it.variance = it.forecast - it.budget;
      it.pct = ts.length ? sum(ts, t => t.cost * t.pct) / it.taskBase : (it.budget ? it.done / it.budget * 100 : 0);
    });
    const fin$ = {
      base: sum(items, i => i.budget),
      reserve: P.budget.reserve || 0,
      contracted: sum(items, i => i.contracted),
      done: sum(items, i => i.done),
      acted: sum(items, i => i.acted),
      claimed: sum(items, i => i.claimed),
      accepted: sum(items, i => i.accepted),
      agreed: sum(items, i => i.agreed),
      paid: sum(items, i => i.paid),
      eac: sum(items, i => i.forecast),
      riskOpenCost: sum(risks.filter(r => r.active && !r.realized), r => (r.eff.cost || 0))
    };
    fin$.approved = fin$.base + fin$.reserve;
    fin$.uncontracted = sum(items, i => i.uncontracted);
    fin$.left = fin$.approved - fin$.done;
    fin$.reserveUsed = fin$.eac - fin$.base;
    fin$.reserveLeft = fin$.approved - fin$.eac;
    fin$.reserveUsedPct = fin$.reserve ? fin$.reserveUsed / fin$.reserve * 100 : 0;
    fin$.finPct = fin$.done / fin$.approved * 100;
    fin$.eacDelta = fin$.eac - fin$.approved;
    fin$.state = fin$.eac > fin$.approved ? 'crit' : fin$.reserveUsedPct > 50 ? 'warn' : 'good';
    // освоение по месяцам: план, факт, прогноз (млн ₽, нарастающим итогом)
    const contractPlanAt = x => sum(contracts, c => c.amount * planFracAt(c, x)) +
      sum(tasks.filter(t => !t.contract && !t.ms), t => t.cost * planPct(t, x) / 100) +
      sum(items.filter(i => i.mode === 'linear'), i => Math.max(0, i.budget - i.contracted) * clamp((x - start + 1) / (planEnd - start + 1), 0, 1));
    const contractFactAt = x => sum(contracts, c => c.amount * fracAt(c, x));
    const fcAt = x => {
      // прогноз: остаток договоров и незаконтрактованных работ по прогнозным окнам работ
      return sum(tasks.filter(t => !t.ms), t => {
        const c = t.contract && contractBy.get(t.contract);
        const k = c ? c.amount / Math.max(1, sum(c.tasks, z => z.cost)) : 1;
        return t.cost * k * forecastPct(t, x) / 100;
      }) + sum(contracts.filter(c => c.tasks.length === 0), c => c.amount * clamp((x - start + 1) / (forecastEnd - start + 1), 0, 1));
    };
    const money = [];
    for (let m = c0; m <= c1; m = addMonths(m, 1)) {
      const x = monthEnd(m);
      money.push({ t: x, plan: contractPlanAt(x), fact: x <= T ? contractFactAt(x) : null, fc: x >= T ? fcAt(x) : null });
    }
    fin$.planNow = contractPlanAt(T);

    /* ресурсы */
    const R = P.resources || { weeks: [], plan: [], fact: [], equipment: [] };
    const res = {
      weeks: R.weeks.map(dn), plan: R.plan.slice(), fact: R.fact.slice(),
      itr: (R.itr || []).slice(),
      equipment: (R.equipment || []).slice(),
      byContractor: (R.byContractor || []).slice()
    };
    res.itrNow = res.itr.length ? res.itr[res.itr.length - 1] : null;
    res.now = res.fact[res.fact.length - 1];
    res.planNowWf = res.plan[res.plan.length - 1];
    res.prev = res.fact[res.fact.length - 2];
    res.equipTotal = sum(res.equipment, e => e.count);

    /* календарь: события графика (системные) + события проекта (датасет и пользователь) */
    const events = [];
    tasks.forEach(t => {
      if (t.ms) {
        events.push({ id: 'ms-' + t.id, sys: true, type: 'milestone', kind: t.kind || 'milestone', title: t.name, date: t.af != null ? t.af : t.ef, plan: t.f0, task: t, tasks: [t], done: t.af != null, key: !!t.key });
        return;
      }
      events.push({ id: 's-' + t.id, sys: true, type: 'start', title: 'Начало: ' + t.name, date: t.as != null ? t.as : t.es, plan: t.s0, task: t, tasks: [t], done: t.as != null });
      events.push({ id: 'f-' + t.id, sys: true, type: 'finish', title: 'Завершение: ' + t.name, date: t.af != null ? t.af : t.ef, plan: t.f0, task: t, tasks: [t], done: t.af != null });
    });
    // источник: датасет + записи пользователя, правки и удаления — операциями
    const evSrc = (P.events || []).map(e => Object.assign({}, e)).concat(S.events.map(e => Object.assign({ user: true }, e)));
    S.eventOps.forEach(op => {
      const e = evSrc.find(z => z.id === op.id);
      if (!e) return;
      if (op.op === 'delete') e.deleted = true;
      if (op.op === 'edit') Object.assign(e, op.patch, { edited: true });
    });
    evSrc.filter(e => !e.deleted).forEach(e => {
      const t0 = e.task ? byId.get(e.task) : null;
      let d = e.date ? dn(e.date) : null;
      if (d == null && t0) d = (e.rel === 'finish' ? (t0.af != null ? t0.af : t0.ef) : (t0.as != null ? t0.as : t0.es)) + (e.offset || 0);
      if (d == null) return;
      const ts = [...new Set([].concat(e.task ? [e.task] : [], e.tasks || []))].map(id => byId.get(id)).filter(Boolean);
      const base = {
        id: e.id, type: DSF.EVENT_TYPES[e.type] ? e.type : 'other', title: e.title, date: d, plan: null, time: e.time || '', dur: e.dur || 0,
        place: e.place || '', people: e.people || [], owner: e.owner || '', desc: e.desc || e.note || '',
        task: ts[0] || null, tasks: ts, docIds: e.docs || [], orderId: e.order || null, ksId: e.ks || null,
        user: !!e.user, edited: !!e.edited, src: e
      };
      if (e.repeat && e.repeat.every) {
        const until = dn(e.repeat.until) || T + 120;
        for (let x = d, i = 0; x <= until && i < 120; x += e.repeat.every, i++) events.push(Object.assign({}, base, { id: e.id + '@' + iso(x), series: e.id, date: x, done: x < T }));
      } else events.push(Object.assign(base, { done: d < T }));
    });

    /* фото */
    const photos = (P.photos || []).map(p => Object.assign({}, p, { d: dn(p.date), task: byId.get(p.task) || null })).sort((a, b) => b.d - a.d);

    /* расширения движка: документооборот, протоколы и поручения, письма */
    const ctx = { P, S, T, start, tasks, byId, stages, contracts, items, risks, events, photos, root, allKs };
    DSF.extensions.forEach(f => f(ctx));
    events.sort((a, b) => a.date - b.date || String(a.time).localeCompare(String(b.time)) || a.title.localeCompare(b.title));
    const evBy = new Map(events.map(e => [e.id, e]));

    /* лента календаря: что произошло ← сегодня → что предстоит */
    const recentFrom = T - 30, nextTo = T + 45;
    const feed = events.filter(e => e.date >= recentFrom && e.date < T).sort((a, b) => b.date - a.date || String(b.time).localeCompare(String(a.time)));
    const today = events.filter(e => e.date === T);
    const upcoming = events.filter(e => e.date > T && e.date <= nextTo);

    /* текущие и ближайшие работы */
    const current = tasks.filter(t => t.state === 'active' && !t.ms).sort((a, b) => (b.crit - a.crit) || (a.dev - b.dev));
    const next = tasks.filter(t => t.state === 'wait' && !t.ms && t.es <= T + 60).sort((a, b) => a.es - b.es);
    const msList = tasks.filter(t => t.ms);

    /* текущий этап: этап активной работы с наибольшим остатком стоимости */
    // текущий этап — тот, где сейчас сосредоточен основной объём выполняемых работ
    const vol = s => sum(s.tasks.filter(t => t.state === 'active'), t => t.cost * Math.min(t.pct, 100 - t.pct + 20));
    const act = stages.filter(s => s.state === 'active').sort((a, b) => vol(b) - vol(a));
    const phase = P.phase || (act[0] ? act[0].name : (root.pc >= 99.5 ? 'Завершён' : 'Подготовка'));

    /* сводные статусы */
    const highRisks = risks.filter(r => r.active && r.level === 'high');
    const midRisks = risks.filter(r => r.active && r.level === 'mid');
    const status = {
      schedule: root.delay <= 0 ? 'good' : root.delay <= 14 ? 'warn' : 'crit',
      budget: fin$.state,
      risks: highRisks.length >= 2 ? 'crit' : highRisks.length ? 'warn' : 'good'
    };
    const rank = { good: 0, warn: 1, crit: 2 };
    status.overall = ['schedule', 'budget', 'risks'].map(k => status[k]).sort((a, b) => rank[b] - rank[a])[0];

    /* что требует внимания руководителя */
    const attention = [];
    (ctx.orders || []).filter(o => o.status !== 'done' && (o.status === 'overdue' || o.priority === 'critical'))
      .forEach(o => attention.push({ sev: o.status === 'overdue' ? 'crit' : 'warn', kind: 'order', order: o, text: o.text,
        meta: 'Поручение № ' + o.no + ' · ' + o.owner + ' · ' + (o.status === 'overdue' ? 'просрочено с ' + fmtDate(o.due) : 'срок ' + fmtDate(o.due)), due: o.due, go: 'orders.' + o.id }));
    tasks.filter(t => t.crit && t.slip > 3 && !t.ms && t.state !== 'done').slice(0, 2).forEach(t => attention.push({ sev: t.slip > 14 ? 'crit' : 'warn', text: 'Критический путь: «' + t.name + '» — прогноз +' + t.slip + ' дн. к плану', meta: 'окончание ' + fmtDate(t.ef), go: 'schedule', task: t, due: Infinity }));
    if (fin$.eac > fin$.approved) attention.push({ sev: 'crit', text: 'Прогноз стоимости превышает утверждённый бюджет на ' + fmtMoney(fin$.eacDelta), meta: 'резерв исчерпан', go: 'budget', due: Infinity });
    else if (fin$.reserveUsedPct > 50) attention.push({ sev: 'warn', text: 'Использовано ' + Math.round(fin$.reserveUsedPct) + '% резерва бюджета', meta: 'остаток резерва ' + fmtMoney(fin$.reserveLeft), go: 'budget', due: Infinity });
    attention.sort((a, b) => ((a.kind === 'order' ? 0 : 1) - (b.kind === 'order' ? 0 : 1)) || (rank[b.sev] - rank[a.sev]) || ((a.due || 0) - (b.due || 0)));

    const M = {
      P, T, tasks, byId, stages, root, curve, curveT, contracts, contractBy, items, itemBy, fin: fin$, money,
      res, risks, highRisks, midRisks, events, evBy, photos, feed, today, upcoming, current, next, msList,
      phase, status, attention, finalTask: fin, ks: allKs, ksBy: new Map(allKs.map(k => [k.id, k])), store: S
    };
    ['documents', 'docBy', 'orders', 'orderBy', 'protocols', 'protocolBy', 'letters', 'letterBy', 'reports'].forEach(k => { M[k] = ctx[k]; });
    M.issues = DSF.validate(P, M);
    P.__model = M;
    return M;

    /* --- вспомогательные функции по работе --- */
    function planPct(t, x) {
      if (t.ms) return x >= t.f0 ? 100 : 0;
      return clamp((x - t.s0 + 1) / t.dur, 0, 1) * 100;
    }
    function factPct(t, x) {
      if (t.ms) return t.af != null && x >= t.af ? 100 : 0;
      if (t.as == null || x < t.as) return 0;
      const end = t.af != null ? t.af : T;
      if (x >= end) return t.pct;
      return t.pct * (x - t.as + 1) / (end - t.as + 1);
    }
    function forecastPct(t, x) {
      if (x <= T) return factPct(t, x);
      if (t.done) return 100;
      if (t.ms) return x >= t.ef ? 100 : 0;
      const s = t.as != null ? T : t.es, p0 = t.as != null ? t.pct : 0;
      if (x < s) return p0;
      if (x >= t.ef) return 100;
      return p0 + (100 - p0) * (x - s + 1) / (t.ef - s + 1);
    }
    function taskStatus(t) {
      if (t.ms) return t.af != null ? { k: 'done', t: 'Достигнута', c: 'good' } : t.ef > t.f0 ? { k: 'late', t: 'Сдвиг +' + (t.ef - t.f0) + ' дн.', c: t.ef - t.f0 > 14 ? 'crit' : 'warn' } : { k: 'wait', t: 'По плану', c: 'neutral' };
      if (t.done) return t.af > t.f0 ? { k: 'done', t: 'Завершено, +' + (t.af - t.f0) + ' дн.', c: 'good' } : { k: 'done', t: 'Завершено', c: 'good' };
      if (t.flags.includes('overdue')) return { k: 'over', t: 'Просрочено', c: 'crit' };
      if (t.state === 'active') {
        if (t.slip > 14 || t.dev < -15) return { k: 'late', t: 'Отставание', c: 'crit' };
        if (t.slip > 3 || t.dev < -5) return { k: 'late', t: 'Отставание', c: 'warn' };
        return { k: 'active', t: 'В работе', c: 'accent' };
      }
      if (t.flags.includes('latestart')) return { k: 'over', t: 'Не начато в срок', c: 'crit' };
      if (t.slip > 3) return { k: 'wait', t: 'Сдвиг +' + t.slip + ' дн.', c: t.slip > 14 ? 'crit' : 'warn' };
      return { k: 'wait', t: 'Не начато', c: 'neutral' };
    }
  };

  /* ---------- проверка целостности датасета ---------- */
  DSF.validate = function (P, M) {
    const out = [];
    const T = M.T;
    const E = (m) => out.push({ level: 'error', msg: m });
    const Wn = (m) => out.push({ level: 'warn', msg: m });
    const need = ['id', 'name', 'type', 'dates', 'budget', 'tasks'];
    need.forEach(k => { if (P[k] == null) E('Нет обязательного поля «' + k + '»'); });
    const ids = new Set();
    M.tasks.forEach(t => {
      const n = '«' + t.name + '»';
      if (ids.has(t.id)) E('Повтор id работы ' + t.id); ids.add(t.id);
      if (t.s0 > t.f0) E(n + ': плановое начало позже окончания');
      if (t.ms) { if (t.af != null && t.af > T) E(n + ': веха достигнута в будущем'); return; }
      if (t.pct > 0 && t.as == null) E(n + ': есть % выполнения, но нет фактического начала');
      if (t.pct === 0 && t.as != null && t.as < T - 7) Wn(n + ': начата, но выполнение 0%');
      if (t.as != null && t.as > T) E(n + ': фактическое начало позже отчётной даты');
      if (t.af != null && t.af > T) E(n + ': фактическое окончание позже отчётной даты');
      if (t.af != null && t.pct < 100) E(n + ': есть фактическое окончание, но выполнение ' + t.pct + '%');
      if (t.pct >= 100 && t.af == null) E(n + ': выполнение 100%, но нет фактического окончания');
      if (t.af != null && t.as != null && t.af < t.as) E(n + ': окончание раньше начала');
      if (t.pct < 0 || t.pct > 100) E(n + ': % вне диапазона');
      if (t.item && !M.itemBy.has(t.item)) E(n + ': неизвестная статья бюджета ' + t.item);
      if (t.contract && !M.contractBy.has(t.contract)) E(n + ': неизвестный договор ' + t.contract);
      if (t.pct > 0 && !t.contract) E(n + ': работа выполняется без договора');
      t.deps.forEach(d => {
        if (d.bad) E(n + ': не распознана связь ' + d.id);
        else if (!M.byId.has(d.id)) E(n + ': связь с несуществующей работой ' + d.id);
        else {
          const p = M.byId.get(d.id);
          if (d.type === 'FS' && t.as != null && !p.started) Wn(n + ': начата раньше начала предшествующей «' + p.name + '»');
        }
      });
    });
    M.items.forEach(it => {
      if (it.mode === 'linear') return;
      if (it.tasks.length && Math.abs(it.taskBase - it.budget) > Math.max(0.5, it.budget * 0.002)) E('Статья «' + it.name + '»: бюджет ' + it.budget + ' ≠ сумме стоимостей работ ' + it.taskBase.toFixed(1));
      if (!it.tasks.length) Wn('Статья «' + it.name + '»: нет работ — она не попадёт в график');
    });
    M.contracts.forEach(c => {
      if (!M.itemBy.has(c.item)) E('Договор ' + c.no + ': неизвестная статья ' + c.item);
      if (c.d > T) E('Договор ' + c.no + ': дата подписания в будущем');
      const st = c.tasks.filter(t => t.as != null).map(t => t.as);
      if (st.length && Math.min(...st) < c.d) Wn('Договор ' + c.no + ': работы начаты до подписания');
      if (c.paid > c.amount + 0.01) E('Договор ' + c.no + ': оплачено больше суммы договора');
    });
    if (Math.abs(M.fin.eac - (M.fin.contracted + M.fin.uncontracted + M.items.reduce((s, i) => s + i.riskCost + (i.adj || 0), 0))) > 1) E('Бюджет не сходится: прогноз ≠ законтрактовано + незаконтрактовано + риски');
    M.risks.forEach(r => {
      if (r.eff.task && !M.byId.has(r.eff.task)) E('Риск «' + r.title + '»: неизвестная работа ' + r.eff.task);
      if (r.eff.item && !M.itemBy.has(r.eff.item)) E('Риск «' + r.title + '»: неизвестная статья ' + r.eff.item);
      if (r.realized && r.task && r.task.done) Wn('Риск «' + r.title + '» реализуется на завершённой работе');
      if (!(r.p >= 1 && r.p <= 5 && r.i >= 1 && r.i <= 5)) E('Риск «' + r.title + '»: вероятность и влияние — от 1 до 5');
    });
    (P.events || []).forEach(e => { if (e.task && !M.byId.has(e.task)) E('Событие «' + e.title + '»: неизвестная работа ' + e.task); });
    M.photos.forEach(p => {
      if (p.d > T) E('Фото «' + p.caption + '» датировано будущим');
      if (!p.task) E('Фото «' + p.caption + '»: неизвестная работа');
      else if (p.task.as == null || p.task.as > p.d) E('Фото «' + p.caption + '»: снято до начала работы «' + p.task.name + '»');
      else if (p.task.af != null && p.d > p.task.af + 21) Wn('Фото «' + p.caption + '» снято через 3+ недели после завершения работы');
    });
    const r = M.res;
    if (r.weeks.length !== r.plan.length || r.weeks.length !== r.fact.length) E('Ресурсы: длины рядов не совпадают');
    if (r.weeks.some(w => w > T)) E('Ресурсы: неделя в будущем');
    M.contracts.forEach(c => {
      c.ks.forEach(k => {
        if (k.accepted != null && k.accepted > k.obj + 0.01) E(c.no + ' ' + k.no + ': принято больше фактически выполненного объёма');
        if (k.amount != null && k.accepted != null && k.amount > k.accepted + 0.01) E(c.no + ' ' + k.no + ': сумма КС-2 больше принятого объёма');
        if (k.d > T) E(c.no + ' ' + k.no + ': дата в будущем');
      });
      if (c.agreed > c.accepted + 0.01) E('Договор ' + c.no + ': согласовано КС-2 больше, чем принято');
      if (c.agreed > c.amount + 0.01) E('Договор ' + c.no + ': КС-2 больше суммы договора');
      if (c.acted > c.done + 0.5) E('Договор ' + c.no + ': предъявлено больше выполненного по графику');
    });
    (DSF.validators || []).forEach(v => v(P, M, E, Wn));
    if (!M.finalTask) Wn('Не задана финальная веха (final: true) — прогноз считается по последней работе');
    return out;
  };

  /* ---------- форматирование (общие) ---------- */
  const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const MONTHS_FULL = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  function fmtDate(d) { if (d == null || !isFinite(d)) return '—'; const s = iso(d); return s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4); }
  function fmtMoney(v, unit) {
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v), neg = v < 0 ? '−' : '';
    if (unit === 'млн' || (!unit && a < 1000)) return neg + fmtNum(a, a < 100 ? 1 : 0) + ' млн ₽';
    return neg + fmtNum(a / 1000, 2) + ' млрд ₽';
  }
  function fmtNum(v, dgt = 0) {
    if (v == null || !isFinite(v)) return '—';
    return v.toLocaleString('ru-RU', { minimumFractionDigits: dgt, maximumFractionDigits: dgt }).replace(/ /g, ' ');
  }
  DSF.fmt = { MONTHS, MONTHS_FULL, MONTHS_GEN, date: fmtDate, money: fmtMoney, num: fmtNum };
})(typeof window !== 'undefined' ? window : globalThis);
