'use strict';
/**
 * 下钻返回原位置（docs/dev/06 §5.2：「下钻必须能返回原位置（保留滚动位置与筛选状态）」）。
 *
 * 做法：
 *  · 点带 `data-back` 的链接离开时，把当前页的 滚动位置 + 页面状态（window.QLPageState()）存进 sessionStorage
 *  · 回到该页时（同一 pathname，30 分钟内），把滚动位置与页面状态还原
 *  · 若存在更早来源页，页面右上角出现「← 返回」，点它按浏览器历史回退
 *
 * 只做「导航态」这一件事，不掺业务逻辑；页面状态由各页自己通过
 * window.QLPageState() / window.QLApplyState(state) 提供，页面不提供就不还原状态（也不报错）。
 */
(function () {
  var KEY = 'ql.navReturn.v1';
  var TTL = 30 * 60 * 1000;     // 30 分钟内有效，过期视为新会话

  function load() {
    try {
      var raw = sessionStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.warn('[nav] 读取返回态失败', e);
      return {};
    }
  }

  function save(map) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(map));
    } catch (e) {
      console.warn('[nav] 保存返回态失败', e);
    }
  }

  function pageKey() {
    return location.pathname + location.search;
  }

  /** 离开当前页前记录状态 */
  function capture() {
    var map = load();
    var extra = null;
    try {
      extra = typeof window.QLPageState === 'function' ? window.QLPageState() : null;
    } catch (e) {
      console.warn('[nav] 采集页面状态失败', e);
    }
    map[pageKey()] = { top: window.scrollY || 0, extra: extra, at: Date.now() };
    save(map);
  }

  // 冒泡阶段之前捕获（capture=true），保证页面自身的点击处理不影响记录
  document.addEventListener('click', function (ev) {
    var el = ev.target;
    while (el && el !== document.body) {
      if (el.tagName === 'A' && el.hasAttribute('data-back')) { capture(); return; }
      el = el.parentNode;
    }
  }, true);

  // 浏览器前进/后退（含 bfcache）也记录一次，避免漏存
  window.addEventListener('pagehide', function () {
    if (document.visibilityState === 'hidden') return;   // 切标签页不算离开
  });

  function applyExtra(extra) {
    if (!extra) return;
    try {
      if (typeof window.QLApplyState === 'function') window.QLApplyState(extra);
    } catch (e) {
      console.warn('[nav] 还原页面状态失败', e);
    }
  }

  /** 还原滚动位置：等内容渲染出来（高度够）再滚，最多等 4s */
  function restoreScroll(top, deadline) {
    if (top <= 0) return;
    var limit = deadline || (Date.now() + 4000);
    if (document.documentElement.scrollHeight - window.innerHeight >= top || Date.now() > limit) {
      window.scrollTo(0, top);
      return;
    }
    requestAnimationFrame(function () { restoreScroll(top, limit); });
  }

  /** 恢复本次进入的页面状态；返回来源页信息（没有则 null） */
  function restore() {
    var map = load();
    var now = Date.now();
    var mine = map[pageKey()];
    if (mine && now - (mine.at || 0) < TTL) {
      applyExtra(mine.extra);
      // 页面异步渲染，滚动放到 load 之后
      if (document.readyState === 'complete') restoreScroll(mine.top);
      else window.addEventListener('load', function () { restoreScroll(mine.top); });
    }
    // 找最近的其它来源页，供「← 返回」按钮使用
    var best = null;
    Object.keys(map).forEach(function (k) {
      var v = map[k];
      if (!v || now - (v.at || 0) >= TTL) return;
      if (k.split('?')[0] === location.pathname) return;
      if (!best || v.at > best.at) best = { href: k, at: v.at };
    });
    return best;
  }

  window.QLNav = { capture: capture, restore: restore };

  // 自动挂「← 返回」按钮（页面若自备返回入口则不重复插入）
  document.addEventListener('DOMContentLoaded', function () {
    var origin = restore();
    if (!origin || document.getElementById('qlBack')) return;
    var a = document.createElement('a');
    a.id = 'qlBack';
    a.className = 'ql-back';
    a.href = origin.href;
    a.setAttribute('data-back', '1');
    a.textContent = '← 返回';
    a.title = '回到离开时的位置（保留筛选与滚动）';
    a.addEventListener('click', function (ev) {
      ev.preventDefault();
      if (history.length > 1) history.back();
      else location.href = origin.href;
    });
    document.body.appendChild(a);
  });
})();
