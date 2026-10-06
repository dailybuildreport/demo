/*
 * Конфигурация объектов: «объект → конфигурация → разделы → сущности → данные → универсальный интерфейс».
 *
 *  DSF.SECTION_DEFS   — все функциональные разделы системы (что вообще умеет интерфейс);
 *  DSF.sectionsOf(P)  — какие разделы включены у конкретного объекта;
 *  DSF.registry       — реестр объектов, созданных и настроенных через интерфейс администратора,
 *                       справочник организаций и журнал изменений. Объект хранится как описание
 *                       (та же модель Project, что и у датасетов) и регистрируется в DSF.projects
 *                       без единой строки кода под него. Изменение датасета через «Настройки объекта»
 *                       сохраняется как редактируемая копия; исходный датасет не меняется и
 *                       к нему можно вернуться.
 *  DSF.files          — файлы (документы, фото, вложения): IndexedDB браузера в демо-режиме;
 *  DSF.auth           — роли и права.
 *
 * Хранилище — через подменяемый адаптер (localStorage / IndexedDB в демо). Для промышленной
 * версии достаточно заменить load/save реестра и put/get файлов на вызовы API.
 */
(function (root) {
  'use strict';
  const DSF = root.DSF = root.DSF || {};

  /* ---------- функциональные разделы системы ---------- */
  DSF.SECTION_DEFS = [
    { k: 'overview',  t: 'Обзор', ic: 'grid', s: 'Обзор', fixed: true, d: 'Сводка объекта: готовность, срок, бюджет, ресурсы, требует внимания, фото' },
    { k: 'schedule',  t: 'Реализация / График работ', ic: 'gantt', s: 'График', d: 'Этапы, работы, объёмы, Гант, план/факт/прогноз, критический путь, вехи' },
    { k: 'production', t: 'Производство', ic: 'check', s: 'Производство', d: 'Ежедневный факт подрядчика, подтверждение техзаказчиком и директором, темп и прогноз по темпу' },
    { k: 'quality',   t: 'Качество / стройконтроль', ic: 'shield', s: 'Качество', d: 'Замечания строительного контроля: выдача, устранение, проверка, аналитика по подрядчикам' },
    { k: 'resources', t: 'Ресурсы', ic: 'users', s: 'Ресурсы', d: 'Движение рабочей силы, ИТР, подрядчики, техника и оборудование' },
    { k: 'metrics',   t: 'Производственные показатели', ic: 'chart', s: 'Показатели', d: 'Периодическая отчётность: показатели объекта, план и факт по датам, комментарии, вложения' },
    { k: 'calendar',  t: 'Календарь', ic: 'cal', s: 'Календарь', d: 'События, совещания, приёмки, вехи и сроки поручений' },
    { k: 'budget',    t: 'Бюджет', ic: 'coins', s: 'Бюджет', d: 'Статьи, договоры, доп. соглашения, КС-2, оплаты, прогноз' },
    { k: 'docs',      t: 'Документы', ic: 'folder', s: 'Документы', d: 'РД, ПД, ИД, КС, отчёты, письма, протоколы, разрешения, договоры' },
    { k: 'orders',    t: 'Протокольные поручения', ic: 'list', s: 'Поручения', d: 'Протоколы совещаний, поручения, сроки, исполнение' },
    { k: 'risks',     t: 'Риски', ic: 'alert', s: 'Риски', d: 'Риски и проблемные вопросы, мероприятия, влияние на срок и стоимость' },
    { k: 'photos',    t: 'Фотохроника', ic: 'cam', s: 'Фото', d: 'Фотографии по датам, этапам, работам и категориям' },
    { k: 'timeline',  t: 'Хронология', ic: 'clock', s: 'Хронология', d: 'История жизни проекта: факт, документы, замечания, КС-2, поручения, решения — автоматически' }
  ];
  /* разделы, появившиеся позже: у объектов с явным списком разделов включаются, пока администратор их не отключит */
  const NEW_SECTIONS = ['production', 'quality', 'timeline'];
  DSF.sectionsOf = function (P) {
    const all = DSF.SECTION_DEFS.map(s => s.k);
    let on = Array.isArray(P.sections) ? P.sections.slice() : all.filter(k => k !== 'metrics' || (P.metrics || []).length);
    if (Array.isArray(P.sections)) NEW_SECTIONS.forEach(k => { if (!on.includes(k) && !(P.sectionsOff || []).includes(k)) on.push(k); });
    return all.filter(k => k === 'overview' || on.includes(k));
  };

  /* ---------- контроль и отчётность объекта (настраивается администратором) ---------- */
  DSF.FACT_STEPS = { tz: 'Технический заказчик', director: 'Директор' };
  DSF.CONTROL_DEFAULTS = {
    factChain: ['tz', 'director'],   // кто и в каком порядке подтверждает ежедневный факт подрядчика
    idRequired: true,                // принятая ИД — условие закрытия работ в КС-2 (без неё — предупреждение)
    guaranteeDays: 14,               // срок гарантийного письма по ИД по умолчанию
    slipDays: 7,                     // сигнал: сдвиг работы критического пути, дней
    paceMin: 80,                     // сигнал: темп ниже требуемого, %
    confirmDays: 2,                  // сигнал: отчёт ждёт подтверждения дольше, дней
    ksDays: 5,                       // сигнал: КС-2 ждёт действия дольше, дней
    rdDays: 14                       // сигнал: РД должна быть в производстве за N дней до начала работы
  };
  DSF.controlOf = P => Object.assign({}, DSF.CONTROL_DEFAULTS, (P && P.control) || {});

  /* ---------- участники ---------- */
  DSF.PARTY_ROLES = {
    customer: 'Заказчик', tz: 'Технический заказчик', gc: 'Генеральный подрядчик', contractor: 'Подрядчик',
    designer: 'Проектировщик', supplier: 'Поставщик', control: 'Строительный контроль', other: 'Другой участник'
  };
  DSF.participantsOf = function (P, contracts) {
    if (Array.isArray(P.participants)) return P.participants.map(x => {
      const org = DSF.registry ? DSF.registry.org(x.org) : null;
      return Object.assign({}, x, { name: org ? org.name : (x.name || '—'), orgObj: org || null });
    });
    // объекты из датасетов: участники выводятся из реквизитов и договоров
    const out = [];
    const add = (role, name) => { if (name && !out.some(o => o.name === name && o.role === role)) out.push({ role, name, derived: true }); };
    add('customer', P.customer); add('tz', P.supervisor); add('gc', P.gc); add('designer', P.designer);
    (contracts || P.contracts || []).forEach(c => { if (c.contractor && c.contractor !== P.gc) add('contractor', c.contractor); });
    return out;
  };

  /* ---------- роли и права ---------- */
  DSF.PERMS = {
    view: 'Просмотр', fact: 'Ежедневный факт: подача отчёта', confirm: 'Подтверждение факта (своя ступень)',
    data: 'События, поручения, риски, фото', decide: 'Решения руководителя по сигналам',
    docs: 'Загрузка документов', docapprove: 'Проверка, согласование и передача документов',
    ksgc: 'КС-2: действия подрядчика', kstz: 'КС-2: проверка и приёмка', quality: 'Замечания: выдача и проверка', fix: 'Замечания: устранение',
    schedule: 'Изменение графика', budget: 'Изменение бюджета и оплат', settings: 'Настройки объекта', create: 'Создание объектов', admin: 'Администрирование'
  };
  DSF.ROLES = {
    admin:      { t: 'Администратор системы', short: 'Администратор', perms: Object.keys(DSF.PERMS) },
    director:   { t: 'Директор проекта', short: 'Директор', perms: ['view', 'confirm', 'data', 'decide', 'docs', 'schedule', 'budget', 'settings'] },
    tz:         { t: 'Технический заказчик', short: 'ТЗ', perms: ['view', 'confirm', 'data', 'docs', 'docapprove', 'kstz', 'quality'] },
    contractor: { t: 'Подрядчик', short: 'Подрядчик', perms: ['view', 'fact', 'docs', 'ksgc', 'fix'] },
    viewer:     { t: 'Наблюдатель / инвестор', short: 'Наблюдатель', perms: ['view'] }
  };
  const ROLE_ALIAS = { manager: 'director', engineer: 'tz' };   // роли прежних версий демо
  const ls = {
    get(k) { try { return root.localStorage ? root.localStorage.getItem(k) : null; } catch (e) { return null; } },
    set(k, v) { try { if (!root.localStorage) return false; root.localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    del(k) { try { root.localStorage && root.localStorage.removeItem(k); } catch (e) { /* нет доступа */ } }
  };
  const savedRole = ls.get('dsf-role');
  DSF.auth = {
    role: DSF.ROLES[savedRole] ? savedRole : (ROLE_ALIAS[savedRole] || 'admin'),
    setRole(r) { if (DSF.ROLES[r]) { this.role = r; ls.set('dsf-role', r); } },
    can(p) { const r = DSF.ROLES[this.role] || DSF.ROLES.viewer; return r.perms.includes(p); },
    /* ступень подтверждения факта: роль совпадает со ступенью (администратор может за любую) */
    canStep(step) { return this.role === 'admin' || (this.role === step && this.can('confirm')); },
    name() { return (DSF.ROLES[this.role] || {}).t || ''; }
  };
  DSF.can = p => DSF.auth.can(p);

  /* ---------- служебное ---------- */
  const clone = o => JSON.parse(JSON.stringify(o, (k, v) => (k.startsWith('__') ? undefined : v)));
  const nowIso = () => new Date().toISOString();

  /* значения по умолчанию для описания объекта (совместимо с датасетами) */
  DSF.normalizeProject = function (def) {
    const P = clone(def);
    P.name = P.name || 'Новый объект';
    P.short = P.short || '';
    P.code = P.code || (P.short || P.name).split(/[\s«»"-]+/).filter(Boolean).map(w => w[0]).join('').slice(0, 3).toUpperCase() || 'ОБ';
    P.type = P.type || '';
    P.city = P.city || '';
    P.address = P.address || '';
    P.params = Object.assign({ extra: [] }, P.params || {});
    P.dates = Object.assign({}, P.dates || {});
    P.budget = Object.assign({ reserve: 0, items: [] }, P.budget || {});
    ['tasks', 'contracts', 'risks', 'photos', 'events', 'documents', 'letters', 'protocols', 'orders', 'decisions', 'reports', 'remarks'].forEach(k => { if (!Array.isArray(P[k])) P[k] = []; });
    P.resources = Object.assign({ weeks: [], plan: [], fact: [], itr: [], equipment: [], byContractor: [], kinds: [] }, P.resources || {});
    if (Array.isArray(P.participants)) {
      // реквизиты для совместимости с экранами: первая организация в каждой роли
      const by = role => { const x = P.participants.find(p => p.role === role); const org = x && DSF.registry ? DSF.registry.org(x.org) : null; return org ? org.name : (x && x.name) || ''; };
      P.customer = by('customer') || P.customer || '';
      P.supervisor = by('tz') || P.supervisor || '';
      P.gc = by('gc') || P.gc || '';
      P.designer = by('designer') || P.designer || '';
    }
    P.manager = P.manager || ((P.people || [])[0] ? P.people[0].name + (P.people[0].position ? ', ' + P.people[0].position : '') : '');
    return P;
  };

  /* ---------- реестр объектов ---------- */
  const KEY = 'dsf-registry';
  const EMPTY = () => ({ v: 1, seq: 1, defs: {}, order: [], orgs: [], log: [] });
  const reg = DSF.registry = {
    state: null,
    datasets: new Map(),            // исходные датасеты (неизменяемые)
    lastError: null,
    load() {
      let s = null;
      try { s = JSON.parse(ls.get(KEY) || 'null'); } catch (e) { s = null; }
      this.state = Object.assign(EMPTY(), s || {});
      return this;
    },
    save() {
      const ok = ls.set(KEY, JSON.stringify(this.state));
      this.lastError = ok ? null : 'Хранилище браузера недоступно или заполнено: изменения действуют только до перезагрузки страницы.';
      if (!ok && DSF.onStorageError) DSF.onStorageError(this.lastError);
      return ok;
    },
    persistent() { try { const k = 'dsf-probe'; root.localStorage.setItem(k, '1'); root.localStorage.removeItem(k); return true; } catch (e) { return false; } },
    /* датасеты, подключённые файлами, запоминаются как исходные версии */
    captureDatasets() { DSF.projects.forEach(p => { if (!p.__reg && !this.datasets.has(p.id)) this.datasets.set(p.id, p); }); },
    apply() {
      if (!this.state) this.load();
      this.captureDatasets();
      const ids = new Set(Object.keys(this.state.defs).concat(this.state.order));
      ids.forEach(id => this.applyOne(id));
    },
    applyOne(pid) {
      const def = this.state.defs[pid];
      const idx = DSF.projects.findIndex(p => p.id === pid);
      let P = null;
      if (!def) P = this.datasets.get(pid) || null;
      else if (!def.archived) { P = DSF.normalizeProject(def); P.__reg = true; P.__origin = def.origin; }
      if (P) { if (idx >= 0) DSF.projects[idx] = P; else DSF.projects.push(P); }
      else if (idx >= 0) DSF.projects.splice(idx, 1);
      if (DSF.invalidate) DSF.invalidate(pid);
      if (P) delete P.__model;
    },
    isUser(pid) { const d = this.state.defs[pid]; return !!(d && d.origin === 'user'); },
    isOverride(pid) { const d = this.state.defs[pid]; return !!(d && d.origin === 'dataset'); },
    hasDataset(pid) { return this.datasets.has(pid); },
    /* описание объекта для чтения (настройки, мастер) */
    def(pid) { return this.state.defs[pid] || this.datasets.get(pid) || null; },
    /* редактируемое описание: для датасета создаётся копия, исходник не меняется */
    editable(pid) {
      if (!this.state.defs[pid]) {
        const src = this.datasets.get(pid);
        if (!src) return null;
        const c = clone(src); c.origin = 'dataset'; c.copiedAt = nowIso();
        this.state.defs[pid] = c;
      }
      return this.state.defs[pid];
    },
    mutate(pid, fn, text) {
      const d = this.editable(pid);
      if (!d) return false;
      const out = fn(d);
      d.updatedAt = nowIso();
      if (text) this.log(pid, text);
      this.save();          // при недоступном хранилище — предупреждение, изменение действует в текущем сеансе
      this.applyOne(pid);
      return out === undefined ? true : out;
    },
    uniqueId(base) {
      let id = (DSF.slug ? DSF.slug(base) : String(base).toLowerCase().replace(/[^a-z0-9_-]+/g, '_')).slice(0, 24) || 'obj';
      if (/^[0-9]/.test(id)) id = 'o' + id;
      const used = id2 => ['admin', 'new', 'portfolio'].includes(id2) || DSF.projects.some(p => p.id === id2) || this.state.defs[id2] || this.datasets.has(id2);
      let x = id, n = 2; while (used(x)) x = id + '-' + (n++);
      return x;
    },
    create(def) {
      const d = clone(def);
      d.id = this.uniqueId(d.short || d.name || 'obj');
      d.origin = 'user'; d.createdAt = nowIso(); d.updatedAt = d.createdAt;
      this.state.defs[d.id] = d;
      if (!this.state.order.includes(d.id)) this.state.order.push(d.id);
      this.log(d.id, 'Объект создан: ' + d.name);
      this.save();
      this.applyOne(d.id);
      return d.id;
    },
    setArchived(pid, flag) { const ok = this.mutate(pid, d => { d.archived = !!flag; }, flag ? 'Объект перенесён в архив' : 'Объект восстановлен из архива'); return ok; },
    resetToDataset(pid) { if (!this.isOverride(pid)) return false; delete this.state.defs[pid]; this.log(pid, 'Настройки сброшены к исходному датасету'); this.save(); this.applyOne(pid); return true; },
    removeUser(pid) {
      if (!this.isUser(pid)) return false;
      delete this.state.defs[pid]; this.state.order = this.state.order.filter(x => x !== pid);
      this.log(pid, 'Объект удалён'); this.save(); this.applyOne(pid);
      if (DSF.store) DSF.store.reset(pid);
      return true;
    },
    /* идентификатор внутри объекта (работы, договоры, статьи…) */
    nid(def, prefix) {
      const used = new Set();
      ['tasks', 'contracts', 'risks', 'events', 'protocols', 'orders', 'letters', 'metrics'].forEach(k => (def[k] || []).forEach(x => x && x.id && used.add(x.id)));
      ((def.budget || {}).items || []).forEach(i => used.add(i.code));
      ((def.metricLog) || []).forEach(x => used.add(x.id));
      def.seq = def.seq || 1;
      let id; do { id = prefix + (def.seq++); } while (used.has(id));
      return id;
    },
    log(pid, text) {
      this.state.log.unshift({ at: nowIso(), role: DSF.auth.role, pid, text });
      if (this.state.log.length > 500) this.state.log.length = 500;
    },
    /* ---------- справочник организаций (общий для всех объектов) ---------- */
    org(id) { return id ? this.state.orgs.find(o => o.id === id) || null : null; },
    orgByName(name) { const n = String(name || '').trim().toLowerCase(); return n ? this.state.orgs.find(o => o.name.trim().toLowerCase() === n) || null : null; },
    upsertOrg(o) {
      let x = o.id ? this.org(o.id) : this.orgByName(o.name);
      if (!x) { x = { id: 'org' + (this.state.seq++) }; this.state.orgs.push(x); }
      Object.keys(o).forEach(k => { if (k !== 'id' && o[k] !== undefined) x[k] = o[k]; });
      return x;
    },
    orgUsage(id) {
      const org = this.org(id); if (!org) return [];
      return DSF.projects.filter(p => (p.participants || []).some(x => x.org === id) || (p.contracts || []).some(c => c.contractor === org.name)).map(p => p.name);
    }
  };

  /* ---------- файлы: IndexedDB браузера (демо), в промышленной версии — файловое хранилище ---------- */
  const files = DSF.files = {
    persistent: false, db: null, map: new Map(),
    init() {
      if (this._init) return this._init;
      this._init = new Promise(resolve => {
        const done = () => resolve(this.persistent);
        let idb = null;
        try { idb = root.indexedDB; } catch (e) { idb = null; }
        if (!idb) return done();
        const timer = setTimeout(done, 2500);
        let rq;
        try { rq = idb.open('dsf-files', 1); } catch (e) { clearTimeout(timer); return done(); }
        rq.onupgradeneeded = () => { rq.result.createObjectStore('files', { keyPath: 'id' }); };
        rq.onerror = () => { clearTimeout(timer); done(); };
        rq.onsuccess = () => {
          this.db = rq.result;
          try {
            const all = this.db.transaction('files').objectStore('files').getAll();
            all.onsuccess = () => {
              (all.result || []).forEach(r => { if (!this.map.has(r.id)) this.map.set(r.id, { url: makeUrl(r.blob), blob: r.blob, name: r.name, size: r.size, type: r.type, at: r.at }); });
              this.persistent = true; clearTimeout(timer); done();
            };
            all.onerror = () => { clearTimeout(timer); done(); };
          } catch (e) { clearTimeout(timer); done(); }
        };
      });
      return this._init;
    },
    /* сохранение файла: ссылка доступна сразу, запись в базу — асинхронно */
    put(file) {
      const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const meta = { id, name: file.name, size: file.size, type: file.type || '' };
      this.map.set(id, { url: makeUrl(file), blob: file, name: file.name, size: file.size, type: file.type, at: nowIso() });
      if (this.db) {
        try { this.db.transaction('files', 'readwrite').objectStore('files').put({ id, name: file.name, size: file.size, type: file.type, at: nowIso(), blob: file }); }
        catch (e) { /* не сохранилось — файл остаётся доступен в текущей вкладке */ }
      }
      return meta;
    },
    get(id) { return this.map.get(id) || null; },
    url(id) { const f = this.map.get(id); return f ? f.url : null; },
    blob(id) { const f = this.map.get(id); return f ? f.blob || null : null; },
    remove(id) { this.map.delete(id); if (this.db) try { this.db.transaction('files', 'readwrite').objectStore('files').delete(id); } catch (e) { /* нет доступа */ } }
  };
  function makeUrl(b) { try { return root.URL && root.URL.createObjectURL ? root.URL.createObjectURL(b) : null; } catch (e) { return null; } }
  /* ссылка на изображение: датасеты — файлы photos/, загруженные — из хранилища файлов */
  DSF.imageUrl = function (ref) {
    if (!ref) return '';
    if (String(ref).startsWith('u:')) return files.url(String(ref).slice(2)) || '';
    return 'photos/' + encodeURIComponent(ref) + '.jpg';
  };
})(typeof window !== 'undefined' ? window : globalThis);
