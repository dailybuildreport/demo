/*
 * Манифест демо-портфеля.
 * Чтобы добавить проект: положите файл data/projects/<id>.js (DSF.register({...}))
 * и допишите его id в список ниже. Интерфейс и движок менять не нужно.
 */
window.DSF = window.DSF || {};
DSF.config = { today: '2026-10-05', title: 'FLOW — Цифровой штаб строительства' };
DSF.manifest = ['kristall', 'bereg', 'vostok', 'briz', 'ladoga'];
/* производственный контур демо (data/flow/<id>.js): ежедневные отчёты, ИД, замечания, гарантийные письма — вымышленные */
DSF.flowManifest = ['kristall', 'bereg', 'vostok', 'briz', 'ladoga'];
