/*
 * Хранилище действий пользователя (журнал изменений поверх датасета).
 *
 * Датасет проекта не изменяется. Всё, что делает пользователь — события календаря,
 * загруженные документы и их движение, поручения, КС-2 подрядчика, черновики писем —
 * записывается сюда как отдельные записи и операции, а движок накладывает их на
 * датасет при сборке модели. Так у каждого объекта остаётся единственный источник.
 *
 * Адаптер хранения подменяемый:
 *   DemoAdapter  — localStorage браузера (демо-режим, без сервера);
 *   для промышленной версии достаточно реализовать load/save к API backend.
 * Сами файлы в демо-режиме живут только в памяти вкладки (blob-ссылки).
 */
(function (root) {
  'use strict';
  const DSF = root.DSF = root.DSF || {};

  const DemoAdapter = {
    name: 'demo-local',
    load(key) { try { const v = root.localStorage && root.localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    save(key, val) { try { root.localStorage && root.localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; } },
    remove(key) { try { root.localStorage && root.localStorage.removeItem(key); } catch (e) { /* нет доступа */ } }
  };

  const EMPTY = () => ({ v: 1, seq: 1, events: [], eventOps: [], docs: [], docOps: [], orders: [], orderOps: [], ks: [], ksOps: [], letters: [] });
  const cache = new Map();
  const files = new Map();   // id файла → { url, name, size, type } (только текущая вкладка)
  const listeners = [];

  const store = {
    adapter: DemoAdapter,
    key: pid => 'dsf-demo-store-' + pid,
    get(pid) {
      if (!cache.has(pid)) {
        const s = Object.assign(EMPTY(), store.adapter.load(store.key(pid)) || {});
        cache.set(pid, s);
      }
      return cache.get(pid);
    },
    /* единая точка изменения: fn получает состояние проекта и меняет его */
    update(pid, fn) {
      const s = store.get(pid);
      const out = fn(s);
      store.adapter.save(store.key(pid), s);
      if (DSF.invalidate) DSF.invalidate(pid);
      listeners.forEach(l => l(pid));
      return out;
    },
    nextId(pid, prefix) { return store.update(pid, s => prefix + '-u' + (s.seq++)); },
    reset(pid) {
      (pid ? [pid] : [...cache.keys()]).forEach(p => { cache.set(p, EMPTY()); store.adapter.remove(store.key(p)); if (DSF.invalidate) DSF.invalidate(p); });
      listeners.forEach(l => l(pid));
    },
    count(pid) { const s = store.get(pid); return s.events.length + s.eventOps.length + s.docs.length + s.docOps.length + s.orders.length + s.orderOps.length + s.ks.length + s.ksOps.length + s.letters.length; },
    onChange(fn) { listeners.push(fn); },
    putFile(file) {
      const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      let url = null;
      try { url = root.URL && root.URL.createObjectURL ? root.URL.createObjectURL(file) : null; } catch (e) { url = null; }
      files.set(id, { url, name: file.name, size: file.size, type: file.type });
      return { id, name: file.name, size: file.size, type: file.type };
    },
    file(id) { return files.get(id) || null; }
  };
  DSF.store = store;
})(typeof window !== 'undefined' ? window : globalThis);
