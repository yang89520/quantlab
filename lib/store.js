'use strict';
/**
 * 自选股 + 分组存储
 * 单文件 JSON，原子写入，所有写操作串行排队避免并发覆盖
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'store.json');

const DEFAULT = {
  version: 1,
  groups: [
    { id: 'g_core', name: '核心持仓', order: 0, collapsed: false },
    { id: 'g_theme', name: '题材跟踪', order: 1, collapsed: false },
  ],
  items: [
    { code: '600986', name: '浙文互联', market: 'sh', groupId: 'g_core', order: 0, addedAt: Date.now() },
  ],
};

let state = null;
let writeQueue = Promise.resolve();

function load() {
  if (state) return state;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      state = {
        version: 1,
        groups: Array.isArray(raw.groups) && raw.groups.length ? raw.groups : DEFAULT.groups.slice(),
        items: Array.isArray(raw.items) ? raw.items : [],
      };
      normalizeOrder();
    } else {
      state = JSON.parse(JSON.stringify(DEFAULT));
      persist();
    }
  } catch (e) {
    console.error('[store] 读取失败，使用默认数据', e.message);
    state = JSON.parse(JSON.stringify(DEFAULT));
  }
  return state;
}

function persist() {
  const snapshot = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.then(() => new Promise((resolve) => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, snapshot, 'utf8');
      fs.renameSync(tmp, FILE);
    } catch (e) {
      console.error('[store] 写入失败', e.message);
    }
    resolve();
  }));
  return writeQueue;
}

function normalizeOrder() {
  state.groups.forEach((g, i) => { g.order = i; });
  const buckets = {};
  state.items.forEach((it) => {
    (buckets[it.groupId] = buckets[it.groupId] || []).push(it);
  });
  Object.values(buckets).forEach((arr) => arr.forEach((it, i) => { it.order = i; }));
  // 清理指向已删除分组的项
  const ids = new Set(state.groups.map((g) => g.id));
  const fallback = state.groups[0] ? state.groups[0].id : null;
  state.items.forEach((it) => {
    if (!ids.has(it.groupId)) it.groupId = fallback;
  });
  state.items = state.items.filter((it) => it.groupId);
}

let uidSeq = 0;
function uid(prefix) {
  // 确定性序号：同一毫秒内多次创建也不会撞 id，且不引入随机数发生器（D-1）
  uidSeq += 1;
  return prefix + '_' + Date.now().toString(36) + uidSeq.toString(36);
}

/* ---------------- 分组 ---------------- */
function listGroups() {
  const s = load();
  return s.groups.slice().sort((a, b) => a.order - b.order);
}

function addGroup(name) {
  const s = load();
  const nm = String(name || '').trim().slice(0, 20);
  if (!nm) throw Object.assign(new Error('分组名不能为空'), { code: 400 });
  if (s.groups.some((g) => g.name === nm)) {
    throw Object.assign(new Error('该分组已存在'), { code: 409 });
  }
  const g = { id: uid('g'), name: nm, order: s.groups.length, collapsed: false };
  s.groups.push(g);
  persist();
  return g;
}

function renameGroup(id, name) {
  const s = load();
  const g = s.groups.find((x) => x.id === id);
  if (!g) throw Object.assign(new Error('分组不存在'), { code: 404 });
  const nm = String(name || '').trim().slice(0, 20);
  if (!nm) throw Object.assign(new Error('分组名不能为空'), { code: 400 });
  if (s.groups.some((x) => x.name === nm && x.id !== id)) {
    throw Object.assign(new Error('该分组已存在'), { code: 409 });
  }
  g.name = nm;
  persist();
  return g;
}

function removeGroup(id, moveTo) {
  const s = load();
  const idx = s.groups.findIndex((x) => x.id === id);
  if (idx < 0) throw Object.assign(new Error('分组不存在'), { code: 404 });
  if (s.groups.length === 1) {
    throw Object.assign(new Error('至少保留一个分组'), { code: 400 });
  }
  const fallback = moveTo && s.groups.some((g) => g.id === moveTo && g.id !== id)
    ? moveTo
    : s.groups.find((g) => g.id !== id).id;
  s.items.forEach((it) => { if (it.groupId === id) it.groupId = fallback; });
  s.groups.splice(idx, 1);
  normalizeOrder();
  persist();
  return { movedTo: fallback };
}

function reorderGroups(ids) {
  const s = load();
  if (!Array.isArray(ids)) throw Object.assign(new Error('参数错误'), { code: 400 });
  const map = new Map(s.groups.map((g) => [g.id, g]));
  const next = [];
  ids.forEach((id) => { if (map.has(id)) { next.push(map.get(id)); map.delete(id); } });
  map.forEach((g) => next.push(g));
  s.groups = next;
  normalizeOrder();
  persist();
  return s.groups;
}

/* ---------------- 自选股 ---------------- */
function listItems() {
  const s = load();
  return s.items.slice().sort((a, b) => a.order - b.order);
}

// 个股：裸 6 位；指数：市场前缀 + 6 位（sh000001），避免与同号个股冲突
const CODE_RE = /^(?:\d{6}|(?:sh|sz|bj)\d{6})$/;

function addItem({ code, name, market, groupId, asset }) {
  const s = load();
  const c = String(code || '').trim().toLowerCase();
  if (!CODE_RE.test(c)) throw Object.assign(new Error('代码格式不正确'), { code: 400 });
  if (s.items.some((it) => it.code === c)) {
    throw Object.assign(new Error('该标的已在自选列表中'), { code: 409 });
  }
  const gid = s.groups.some((g) => g.id === groupId) ? groupId : s.groups[0].id;
  const bucket = s.items.filter((it) => it.groupId === gid);
  const pref = c.match(/^(sh|sz|bj)\d{6}$/) ? c.slice(0, 2) : null;
  const it = {
    code: c,
    name: String(name || c).slice(0, 20),
    market: pref || (market === 'sh' || market === 'sz' || market === 'bj' ? market : (/^6/.test(c) ? 'sh' : 'sz')),
    asset: (pref || asset === 'index') ? 'index' : 'stock',
    groupId: gid,
    order: bucket.length,
    addedAt: Date.now(),
  };
  s.items.push(it);
  persist();
  return it;
}

function updateItem(code, patch) {
  const s = load();
  const it = s.items.find((x) => x.code === code);
  if (!it) throw Object.assign(new Error('该股票不在自选中'), { code: 404 });
  if (patch.groupId !== undefined) {
    if (!s.groups.some((g) => g.id === patch.groupId)) {
      throw Object.assign(new Error('目标分组不存在'), { code: 404 });
    }
    it.groupId = patch.groupId;
  }
  if (patch.name !== undefined) it.name = String(patch.name).slice(0, 20);
  normalizeOrder();
  persist();
  return it;
}

function removeItem(code) {
  const s = load();
  const idx = s.items.findIndex((x) => x.code === code);
  if (idx < 0) throw Object.assign(new Error('该股票不在自选中'), { code: 404 });
  s.items.splice(idx, 1);
  normalizeOrder();
  persist();
  return { ok: true };
}

function reorderItems(groupId, codes) {
  const s = load();
  if (!Array.isArray(codes)) throw Object.assign(new Error('参数错误'), { code: 400 });
  const inGroup = s.items.filter((x) => x.groupId === groupId);
  const map = new Map(inGroup.map((x) => [x.code, x]));
  const next = [];
  codes.forEach((c) => { if (map.has(c)) { next.push(map.get(c)); map.delete(c); } });
  map.forEach((x) => next.push(x));
  next.forEach((x, i) => { x.order = i; });
  persist();
  return next;
}

module.exports = {
  listGroups, addGroup, renameGroup, removeGroup, reorderGroups,
  listItems, addItem, updateItem, removeItem, reorderItems,
};
