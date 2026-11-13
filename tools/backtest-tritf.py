#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
「三周期共振」的 A 股实证检验。

要回答的不是「这套方法能不能赚钱」，而是三个更具体的问题：
  1. 原文那两层过滤（月线连续 2 月、周线连续 2 周站上 20 均线）到底有没有用？
     —— 对照：只挑日线买点、不加上层过滤。
  2. 「日线买点」这个动作本身有没有增量？
     —— 对照：三层都在线上、但没有出现回踩/放量/跳空倍量的日子。
  3. 三种买点形态（缩量回踩 / 放量启动 / 跳空倍量回踩）哪一种更值钱？

口径与前端 public/js/indicators.js 的 TRICYCLE 完全一致：
  · 月/周层：连续 N 根收盘价 > 20 均线；只数「已收官」的周期
  · 日线层：收盘 > MA20，买点 = 三种形态之一
  · 量能：当日量 / 前 3 日均量（不含当日）

A 股约束（一条都不省）：
  · T+1：次日开盘买入、次日开盘卖出
  · 一字涨停无法买入 → 剔除
  · 双边成本 0.12%（佣金 + 印花税 + 滑点）
  · 退出：收盘跌破 MA20，次日开盘卖；或满 120 根强制平仓

用法：
  python3 tools/backtest-tritf.py --n 120
  python3 tools/backtest-tritf.py --n 200 --host localhost --port 3000
"""
import argparse
import bisect
import json
import random
import urllib.request

import numpy as np

COST = 0.0012          # 双边
MAX_HOLD = 120


def http_json(url, timeout=90):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def sma(x, n):
    out = np.full(len(x), np.nan)
    if len(x) < n:
        return out
    cs = np.cumsum(np.insert(x, 0, 0.0))
    out[n - 1:] = (cs[n:] - cs[:-n]) / n
    return out


def pack(rows):
    """[date, open, close, high, low, vol, amount] → dict"""
    if not rows:
        return None
    a = np.array([[r[1], r[2], r[3], r[4], r[5]] for r in rows], dtype=float)
    return {
        'd': [r[0] for r in rows],
        'o': a[:, 0], 'c': a[:, 1], 'h': a[:, 2], 'l': a[:, 3], 'v': a[:, 4],
        'ma20': sma(a[:, 1], 20),
    }


def load(code, host, port):
    d = http_json('http://%s:%d/api/stock/%s?period=day&bars=1200' % (host, port, code))['data']
    day = pack(d.get('klines'))
    if not day or len(day['c']) < 320:
        return None
    return {
        'code': code, 'name': d.get('name') or code,
        'day': day, 'week': pack(d.get('week')), 'month': pack(d.get('month')),
    }


def streak_arr(c, ma):
    """连续多少根收在均线上（逐根）"""
    s = np.zeros(len(c), dtype=int)
    for k in range(len(c)):
        if not np.isnan(ma[k]) and c[k] > ma[k]:
            s[k] = (s[k - 1] + 1) if k > 0 else 1
        else:
            s[k] = 0
    return s


def map_simple(per_dates, day_dates):
    """每根日线 → 日期 ≤ 它的最后一根周期线索引"""
    idx = np.full(len(day_dates), -1, dtype=int)
    p = -1
    for i, d in enumerate(day_dates):
        while p + 1 < len(per_dates) and per_dates[p + 1] <= d:
            p += 1
        idx[i] = p
    return idx


def build_signals(st):
    """返回逐根日线的 level / buy / kind / pile，与前端同口径"""
    D, W, M = st['day'], st['week'], st['month']
    if not W or not M:
        return None
    n = len(D['c'])

    # 是否「该周期最后交易日」：向后看一根就知道（不是未来函数，只用于判定这根是否已收官）
    def is_end(dates):
        e = np.zeros(len(dates), dtype=bool)
        for i in range(len(dates)):
            if i == len(dates) - 1:
                e[i] = True
            else:
                e[i] = dates[i][:7] != dates[i + 1][:7] if len(dates[i]) == 10 and dates is M['d'] else True
        return e

    # 月/周的「已收官」判断：日线日期 == 该周期线日期 且 该日线不是月末/周末 → 视为未完成
    def ended_mask(per_d, day_dates, mode):
        """对每根日线，判断 ≤ 它的最后一根周期线是否已收官"""
        idx = map_simple(per_d, day_dates)
        out = np.zeros(n, dtype=bool)
        for i in range(n):
            k = idx[i]
            if k < 0:
                out[i] = False
                continue
            if k < len(per_d) - 1:
                out[i] = True                      # 后面还有更晚的周期线，这根当然已收官
            else:
                # 就是最后一根：只有当天确实是该周期的最后一天才算完成
                d = day_dates[i]
                if mode == 'month':
                    out[i] = (i == n - 1) or (day_dates[i + 1][:7] != d[:7])
                else:
                    out[i] = (i == n - 1) or (day_dates[i + 1][:7] != d[:7] or
                                              int(day_dates[i + 1][8:10]) < int(d[8:10]))
        return idx, out

    m_idx, m_end = ended_mask(M['d'], D['d'], 'month')
    w_idx, w_end = ended_mask(W['d'], D['d'], 'week')

    ms = streak_arr(M['c'], M['ma20'])
    ws = streak_arr(W['c'], W['ma20'])
    dma = D['ma20']

    # 日线量能
    v = D['v']
    vma3 = np.full(n, np.nan)
    for i in range(3, n):
        if v[i - 1] > 0 and v[i - 2] > 0 and v[i - 3] > 0:
            vma3[i] = (v[i - 1] + v[i - 2] + v[i - 3]) / 3.0
    volr = np.where((vma3 > 0) & ~np.isnan(vma3), v / np.where(vma3 > 0, vma3, 1), np.nan)

    pull = np.zeros(n, dtype=bool)
    launch = np.zeros(n, dtype=bool)
    gapv = np.zeros(n, dtype=bool)
    for i in range(3, n):
        if np.isnan(dma[i]):
            continue
        ma = dma[i]
        r = volr[i]
        if D['l'][i] <= ma * 1.02 and D['c'][i] > ma and D['c'][i] >= D['o'][i] * 0.998 and not np.isnan(r) and r <= 1.2:
            pull[i] = True
        if D['c'][i] > D['o'][i] and D['c'][i] > ma and not np.isnan(r) and r >= 1.5:
            launch[i] = True
        if D['o'][i] > D['c'][i - 1] * 1.005 and not np.isnan(r) and r >= 2:
            gapv[i] = True

    buy = np.zeros(n, dtype=bool)
    kind = np.array([''] * n, dtype=object)
    for i in range(3, n):
        if np.isnan(dma[i]):
            continue
        dev = (D['c'][i] - dma[i]) / dma[i] * 100
        g = any(gapv[max(3, i - 5):i + 1])
        k = ''
        if launch[i]:
            k = 'launch'
        elif g and -1 <= dev <= 4:
            k = 'gapback'
        elif pull[i]:
            k = 'pull'
        if k:
            buy[i] = True
            kind[i] = k

    # 周线倍量堆量（近 12 周 ≥2 周超过前 4 周均量 1.8 倍）
    wv = W['v']
    pileset = set()
    Wn = len(W['c'])
    for k in range(4, Wn):
        base = wv[k - 4:k].mean()
        if base > 0 and wv[k] > base * 1.8:
            pileset.add(k)

    # 逐日：月/周连续根数
    m_streak = np.zeros(n, dtype=int)
    w_streak = np.zeros(n, dtype=int)
    pile_on = np.zeros(n, dtype=bool)
    for i in range(n):
        mi = m_idx[i] - (0 if m_end[i] else 1)
        wi = w_idx[i] - (0 if w_end[i] else 1)
        if mi >= 0:
            m_streak[i] = ms[mi]
        if wi >= 0:
            w_streak[i] = ws[wi]
            cnt = sum(1 for k in range(max(4, wi - 12), wi + 1) if k in pileset)
            pile_on[i] = cnt >= 2

    level = ((m_streak > 0).astype(int) + (w_streak > 0).astype(int) +
             ((~np.isnan(dma)) & (D['c'] > dma)).astype(int))
    return {'m': m_streak, 'w': w_streak, 'level': level, 'buy': buy, 'kind': kind,
            'pile': pile_on, 'dma': dma, 'volr': volr}


def limit_blocked(D, i):
    """次日开盘一字涨停 → 买不到"""
    if i + 1 >= len(D['c']):
        return True
    prev = D['c'][i]
    o = D['o'][i + 1]
    return (o >= prev * 1.097) and (abs(D['h'][i + 1] - D['l'][i + 1]) < 1e-9)


def run_trades(st, sig, need_level, need_buy, hold=None, exit_mode='ma20'):
    """exit_mode: ma20 跌破均线 / buf 跌破均线 3% / low 跌破买点 K 线低点 / hold 固定根数"""
    D = st['day']
    n = len(D['c'])
    out = []
    i = 25
    while i < n - 2:
        ok = True
        if need_level:
            ok = ok and sig['level'][i] >= 3 and sig['m'][i] >= 2 and sig['w'][i] >= 2
        if need_buy:
            ok = ok and sig['buy'][i]
        if not ok:
            i += 1
            continue
        if limit_blocked(D, i):
            i += 1
            continue
        entry = D['o'][i + 1]
        exit_i = None
        if hold is not None:
            j = i + 1 + hold - 1
            if j >= n:
                break
            exit_i = j
        else:
            floor = None
            if exit_mode == 'low':
                floor = D['l'][i] * 0.995          # 结构止损：买点那根 K 线的低点
            for j in range(i + 1, min(n, i + 1 + MAX_HOLD)):
                if exit_mode == 'low':
                    if D['c'][j] < floor:
                        exit_i = min(j + 1, n - 1)
                        break
                else:
                    m = sig['dma'][j]
                    if not np.isnan(m) and D['c'][j] < (m * 0.97 if exit_mode == 'buf' else m):
                        exit_i = min(j + 1, n - 1)
                        break
            if exit_i is None:
                exit_i = min(n - 1, i + MAX_HOLD)
        px = D['o'][exit_i] if exit_i < n else D['c'][n - 1]
        ret = (px / entry - 1) - COST
        out.append({'ret': ret, 'bars': exit_i - (i + 1), 'kind': sig['kind'][i],
                    'pile': bool(sig['pile'][i]), 'i': i})
        i = exit_i + 1
    return out


def stat(trades, label):
    if not trades:
        print('%-30s %5s' % (label, 0))
        return
    r = np.array([t['ret'] for t in trades])
    b = np.array([t['bars'] for t in trades])
    win = r > 0
    gains = r[win].sum()
    losses = -r[~win].sum()
    pf = (gains / losses) if losses > 0 else float('inf')
    print('%-30s %5d  胜率 %5.1f%%  均值 %+6.2f%%  中位 %+6.2f%%  盈亏比 %5.2f  持仓 %4.0f 根'
          % (label, len(r), win.mean() * 100, r.mean() * 100, np.median(r) * 100,
             pf if pf != float('inf') else 99, np.median(b)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--n', type=int, default=120)
    ap.add_argument('--host', default='localhost')
    ap.add_argument('--port', type=int, default=3000)
    ap.add_argument('--seed', type=int, default=20261113)
    args = ap.parse_args()

    mk = http_json('http://%s:%d/api/screen/market' % (args.host, args.port))['data']
    pool = [x['code'] for x in (mk.get('list') or []) if x['code'][:2] in ('60', '00', '30')]
    random.seed(args.seed)
    sample = random.sample(pool, min(args.n, len(pool)))
    print('股票池 %d 只，抽样 %d 只\n' % (len(pool), len(sample)))

    cache_path = '/tmp/tritf-cache.json'
    sigs = []
    import os
    if os.path.exists(cache_path):
        try:
            raw = json.load(open(cache_path, encoding='utf-8'))
            if raw.get('seed') == args.seed and raw.get('n') == len(sample) and len(raw.get('items') or []) > 50:
                sigs = [({'code': it['code'], 'name': it['name'],
                          'day': {'d': it['d'], 'o': np.array(it['o']), 'c': np.array(it['c']),
                                  'h': np.array(it['h']), 'l': np.array(it['l']), 'v': np.array(it['v']),
                                  'ma20': np.array(it['ma20'])},
                          'week': None, 'month': None},
                         {'m': np.array(it['m']), 'w': np.array(it['w']), 'level': np.array(it['level']),
                          'buy': np.array(it['buy'], dtype=bool), 'kind': np.array(it['kind'], dtype=object),
                          'pile': np.array(it['pile'], dtype=bool), 'dma': np.array(it['ma20']),
                          'volr': np.array(it['volr'])})
                        for it in raw['items']]
                print('命中缓存：%d 只（%s）' % (len(sigs), cache_path))
        except Exception as e:
            print('缓存不可用，重新拉取：', e)
            sigs = []

    for k, code in enumerate(sample) if not sigs else []:
        try:
            st = load(code, args.host, args.port)
            if not st:
                continue
            sig = build_signals(st)
            if sig is None:
                continue
            sigs.append((st, sig))
        except Exception as e:
            print('  skip', code, type(e).__name__, str(e)[:50])
        if (k + 1) % 20 == 0:
            print('  已载入 %d/%d' % (k + 1, len(sample)))

    print('\n有效标的 %d 只\n' % len(sigs))

    if not os.path.exists(cache_path):
        try:
            items = []
            for st, sig in sigs:
                D = st['day']
                items.append({'code': st['code'], 'name': st['name'],
                              'd': D['d'], 'o': D['o'].tolist(), 'c': D['c'].tolist(),
                              'h': D['h'].tolist(), 'l': D['l'].tolist(), 'v': D['v'].tolist(),
                              'ma20': D['ma20'].tolist(), 'm': sig['m'].tolist(), 'w': sig['w'].tolist(),
                              'level': sig['level'].tolist(), 'buy': sig['buy'].tolist(),
                              'kind': [str(x) for x in sig['kind']], 'pile': sig['pile'].tolist(),
                              'volr': [None if np.isnan(x) else round(float(x), 4) for x in sig['volr']]})
            json.dump({'seed': args.seed, 'n': len(sample), 'items': items},
                      open(cache_path, 'w', encoding='utf-8'))
            print('已缓存到 %s\n' % cache_path)
        except Exception as e:
            print('缓存写入失败：', e)

    # A 原文完整版：三层门槛 + 买点
    A = []
    for st, sig in sigs:
        A += run_trades(st, sig, True, True)
    # B 只要买点，不看月周
    B = []
    for st, sig in sigs:
        B += run_trades(st, sig, False, True)
    # C 三层门槛，不要买点（只站位）
    C = []
    for st, sig in sigs:
        C += run_trades(st, sig, True, False)

    print('=== 退出方式敏感性（同一批信号，只换卖出规则）===')
    stat(A, '  跌破 MA20')
    for mode, label in (('buf', '  跌破 MA20 的 97%'), ('low', '  跌破买点 K 线低点')):
        t = []
        for st, sig in sigs:
            t += run_trades(st, sig, True, True, exit_mode=mode)
        stat(t, label)

    print('\n=== 三层过滤到底有没有用（统一用「跌破 MA20」）===')
    stat(A, 'A 三层门槛 + 日线买点')
    stat(B, 'B 只有日线买点（无月周过滤）')
    stat(C, 'C 三层门槛，无买点（只站位）')
    R = []
    for st, sig in sigs:
        R += run_trades(st, sig, False, False)
    stat(R, 'D 随机日买入（基线，同样退出）')

    print('\n=== 固定持有 ===')
    for hold in (5, 10, 20, 60):
        a = []
        for st, sig in sigs:
            a += run_trades(st, sig, True, True, hold=hold)
        stat(a, '  持 %d 根' % hold)

    print('\n=== 按买点形态（趋势口径）===')
    for kd in ('pull', 'launch', 'gapback'):
        stat([t for t in A if t['kind'] == kd], '  ' + {'pull': '缩量回踩', 'launch': '放量启动', 'gapback': '跳空倍量回踩'}[kd])

    print('\n=== 按周线堆量 ===')
    stat([t for t in A if t['pile']], '  前期有倍量堆量')
    stat([t for t in A if not t['pile']], '  无堆量')

    # 买入持有对照
    bh = []
    for st, sig in sigs:
        D = st['day']
        if len(D['c']) > 300:
            bh.append({'ret': D['c'][-1] / D['c'][0] - 1, 'bars': len(D['c'])})
    print()
    stat(bh, '对照：同期买入持有')


if __name__ == '__main__':
    main()
