#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
「三把锁低吸模型」的 A 股实证检验。

原文（桔子写指标，2026-11-13）给的是通达信条件选股公式，三把锁串成一条信号：

  第一把锁·动量底  MOMI 双平滑动量创近 3 日/近 7 日新低，且近 2 日曾为负，今日上穿 3 日均线
  第二把锁·布林回踩  近 4 日最低价触及布林下轨 ×1.04 以内，今日收涨且收盘不低于下轨 ×0.98
  第三把锁·60 日线多头  |C-MA60|/MA60 < 5%，MA60 / MA20 / MA5 全部拐头向上

本脚本要回答四个问题：
  1. 照抄原文能否选出票？（原文 M60UP 写的是 MA5 > REF(MA5,1)*1.2，即 5 日线单日涨 20%，
     这在 A 股几乎不可能 —— 先验证是不是笔误）
  2. 修正后信号密度多大？平均每年几次？
  3. 这套「趋势中回调低吸」到底有没有正期望？与随机买入差多少？
  4. 三把锁各自贡献了什么？缺一把会怎样？

口径与前端 indicators.js / strategies.js 的 threelock 一致：
  · EMA 递归，初值取首值（通达信同）
  · STD 用总体标准差（与全系统 BOLL 统一；通达信 STD 是样本口径，轨道宽度差约 2.6%，阈值 1.04 倍足够宽，不影响排序）
  · 信号在 T 日收盘确认，T+1 开盘买入；T+1 一字涨停剔除；双边成本 0.12%

用法：
  python3 tools/backtest-threelock.py --probe      # 只看信号频次，不交易
  python3 tools/backtest-threelock.py --n 120      # 完整回测
"""
import argparse
import json
import os
import random
import urllib.request

import numpy as np

COST = 0.0012
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


def ema(x, n):
    """通达信 EMA：首值作为初值递推"""
    out = np.empty(len(x), dtype=float)
    if not len(x):
        return out
    k = 2.0 / (n + 1)
    prev = x[0]
    out[0] = prev
    for i in range(1, len(x)):
        prev = x[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def stdp(x, n):
    """总体标准差（与前端 STD 一致）"""
    out = np.full(len(x), np.nan)
    for i in range(n - 1, len(x)):
        w = x[i - n + 1:i + 1]
        out[i] = w.std()
    return out


def llv(x, n):
    out = np.full(len(x), np.nan)
    for i in range(n - 1, len(x)):
        out[i] = x[i - n + 1:i + 1].min()
    return out


def ref(x, k=1):
    out = np.full(len(x), np.nan)
    if k < len(x):
        out[k:] = x[:-k]
    return out


def count_ge(cond, n, th=1):
    """COUNT(cond, n) >= th"""
    c = cond.astype(int)
    cs = np.cumsum(np.insert(c, 0, 0))
    out = np.zeros(len(c), dtype=bool)
    for i in range(n - 1, len(c)):
        out[i] = (cs[i + 1] - cs[i + 1 - n]) >= th
    return out


def exist(cond, n):
    """EXIST(cond, n)：近 n 根内出现过（含当日）"""
    c = cond.astype(int)
    cs = np.cumsum(np.insert(c, 0, 0))
    out = np.zeros(len(c), dtype=bool)
    for i in range(len(c)):
        lo = max(0, i - n + 1)
        out[i] = (cs[i + 1] - cs[lo]) > 0
    return out


def filter_sig(cond, n):
    """通达信 FILTER(X,N)：X 成立后，其后 N 根内的信号全部置 0"""
    out = cond.copy()
    block_until = -1
    for i in range(len(cond)):
        if i <= block_until:
            out[i] = False
        elif cond[i]:
            block_until = i + n
    return out


def pack(rows):
    a = np.array([[r[1], r[2], r[3], r[4], r[5]] for r in rows], dtype=float)
    return {'d': [r[0] for r in rows], 'o': a[:, 0], 'c': a[:, 1],
            'h': a[:, 2], 'l': a[:, 3], 'v': a[:, 4]}


def load(code, host, port):
    d = http_json('http://%s:%d/api/stock/%s?period=day&bars=1200' % (host, port, code))['data']
    if not d.get('klines') or len(d['klines']) < 320:
        return None
    return {'code': code, 'name': d.get('name') or code, 'day': pack(d['klines'])}


def build(D, ma5_slope=1.2, lock3=True):
    """ma5_slope: 原文 1.2；修正版传 1.0（只要求 MA5 上行）
       lock3: False 时不要求第三把锁（用于拆解贡献）"""
    c, h, l, o = D['c'], D['h'], D['l'], D['o']
    n = len(c)

    mom = np.zeros(n)
    mom[1:] = c[1:] - c[:-1]
    e1, e2 = ema(mom, 6), ema(ema(mom, 6), 6)
    a1, a2 = ema(np.abs(mom), 6), ema(ema(np.abs(mom), 6), 6)
    with np.errstate(divide='ignore', invalid='ignore'):
        momi = np.where(a2 > 0, 100 * e2 / a2, 0.0)

    ma3 = sma(momi, 3)
    # 第一把锁：近 3 日最低 = 近 7 日最低（新低落在最近 3 天里）& 近 2 日曾为负 & 今日上穿 MA3
    low3, low7 = llv(momi, 3), llv(momi, 7)
    newlow = np.isclose(low3, low7, rtol=0, atol=1e-12)
    was_neg = count_ge(momi < 0, 2, 1)
    above3 = momi > ma3
    bsig = newlow & was_neg & above3
    ssig = filter_sig(bsig, 4)

    # 近期活跃：22 日内至少一天涨幅 > 1.5%
    up15 = np.zeros(n, dtype=bool)
    up15[1:] = c[1:] / c[:-1] > 1.015
    recent = count_ge(up15, 22, 1)
    qd = recent & ssig

    # 第二把锁：布林下轨回踩
    ma20 = sma(c, 20)
    sd20 = stdp(c, 20)
    blo = ma20 - 2 * sd20
    btch = l <= blo * 1.04
    brise = np.zeros(n, dtype=bool)
    brise[1:] = (c[1:] > c[:-1]) & (c[1:] >= (blo * 0.98)[1:])
    bb = exist(btch, 4) & brise

    # 第三把锁：60 日线多头 + 距离 5% 以内
    ma60 = sma(c, 60)
    nr60 = np.abs(c - ma60) / ma60 < 0.05
    m60up = (ma60 > ref(ma60)) & (ma20 > ref(ma20)) & (sma(c, 5) > ref(sma(c, 5)) * ma5_slope)

    sig = qd & bb & nr60 & m60up if lock3 else qd & bb & nr60
    return {'momi': momi, 'ma3': ma3, 'bsig': bsig, 'ssig': ssig, 'qd': qd, 'act': recent,
            'btch': btch, 'bb': bb, 'nr60': nr60, 'm60up': m60up, 'sig': sig,
            'ma20': ma20, 'blo': blo, 'ma60': ma60}


def limit_blocked(D, i):
    if i + 1 >= len(D['c']):
        return True
    return (D['o'][i + 1] >= D['c'][i] * 1.097) and (abs(D['h'][i + 1] - D['l'][i + 1]) < 1e-9)


def atr14(D):
    c, h, l = D['c'], D['h'], D['l']
    n = len(c)
    tr = np.zeros(n)
    for i in range(1, n):
        tr[i] = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
    out = np.full(n, np.nan)
    for i in range(14, n):
        out[i] = tr[i - 13:i + 1].mean()
    return out


def run_trades(st, sig, hold=None, exit_mode='ma60'):
    """exit_mode: ma60 收盘跌破 60 线 / buf 跌破 97% / low 收盘跌破信号 K 线低点 / atr 收盘跌破(低点-1ATR)"""
    D = st['day']
    n = len(D['c'])
    atr = atr14(D)
    out = []
    i = 65
    while i < n - 2:
        if not sig['sig'][i]:
            i += 1
            continue
        if limit_blocked(D, i):
            i += 1
            continue
        entry = D['o'][i + 1]
        if hold is not None:
            j = i + hold
            if j >= n:
                break
            exit_i = j
        else:
            exit_i = None
            floor = None
            if exit_mode == 'low':
                floor = D['l'][i] * 0.995
            elif exit_mode == 'atr':
                a = atr[i]
                floor = (D['l'][i] - a) if not np.isnan(a) else D['l'][i] * 0.97
            for j in range(i + 1, min(n, i + 1 + MAX_HOLD)):
                if floor is not None:
                    if D['c'][j] < floor:
                        exit_i = min(j + 1, n - 1)
                        break
                else:
                    m = sig['ma60'][j]
                    if not np.isnan(m) and D['c'][j] < (m * 0.97 if exit_mode == 'buf' else m):
                        exit_i = min(j + 1, n - 1)
                        break
            if exit_i is None:
                exit_i = min(n - 1, i + MAX_HOLD)
        px = D['o'][exit_i] if exit_i < n else D['c'][n - 1]
        out.append({'ret': (px / entry - 1) - COST, 'bars': exit_i - (i + 1), 'i': i})
        i = exit_i + 1
    return out


def stat(trades, label):
    if not trades:
        print('%-34s %5d' % (label, 0))
        return
    r = np.array([t['ret'] for t in trades])
    b = np.array([t['bars'] for t in trades])
    win = r > 0
    gl = -r[~win].sum()
    pf = (r[win].sum() / gl) if gl > 0 else 99
    print('%-34s %5d  胜率 %5.1f%%  均值 %+6.2f%%  中位 %+6.2f%%  盈亏比 %5.2f  持仓 %4.0f 根'
          % (label, len(r), win.mean() * 100, r.mean() * 100, np.median(r) * 100, pf, np.median(b)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--n', type=int, default=120)
    ap.add_argument('--host', default='localhost')
    ap.add_argument('--port', type=int, default=3000)
    ap.add_argument('--seed', type=int, default=20261113)
    ap.add_argument('--probe', action='store_true')
    args = ap.parse_args()

    mk = http_json('http://%s:%d/api/screen/market' % (args.host, args.port))['data']
    pool = [x['code'] for x in (mk.get('list') or []) if x['code'][:2] in ('60', '00', '30')]
    random.seed(args.seed)
    sample = random.sample(pool, min(args.n, len(pool)))
    print('股票池 %d 只，抽样 %d 只\n' % (len(pool), len(sample)))

    cache = '/tmp/threelock-cache.json'
    items = []
    if os.path.exists(cache):
        try:
            raw = json.load(open(cache, encoding='utf-8'))
            if raw.get('seed') == args.seed and raw.get('n') == len(sample) and len(raw.get('items') or []) > 50:
                items = raw['items']
                print('命中缓存：%d 只' % len(items))
        except Exception:
            items = []
    if not items:
        for k, code in enumerate(sample):
            try:
                st = load(code, args.host, args.port)
                if st:
                    items.append({'code': st['code'], 'name': st['name'],
                                  'd': st['day']['d'], 'o': st['day']['o'].tolist(),
                                  'c': st['day']['c'].tolist(), 'h': st['day']['h'].tolist(),
                                  'l': st['day']['l'].tolist(), 'v': st['day']['v'].tolist()})
            except Exception as e:
                print('  skip', code, type(e).__name__, str(e)[:40])
            if (k + 1) % 20 == 0:
                print('  已载入 %d/%d' % (k + 1, len(sample)))
        try:
            json.dump({'seed': args.seed, 'n': len(sample), 'items': items}, open(cache, 'w', encoding='utf-8'))
        except Exception as e:
            print('缓存写入失败', e)
    print('\n有效标的 %d 只，平均 %.0f 根日线\n'
          % (len(items), np.mean([len(it['c']) for it in items])))

    sts = []
    for it in items:
        D = {k: np.array(it[k]) for k in ('o', 'c', 'h', 'l', 'v')}
        D['d'] = it['d']
        sts.append({'code': it['code'], 'name': it['name'], 'day': D})

    # ---- 1. 原文 vs 修正：信号频次 ----
    print('=== 第一把结论：原文公式能不能选出票 ===')
    for label, slope in (('原文 MA5>REF(MA5,1)*1.2', 1.2), ('修正 MA5>REF(MA5,1)', 1.0)):
        tot = 0
        per_stock = []
        for st in sts:
            s = build(st['day'], ma5_slope=slope)
            m60 = s['m60up']
            tot += int(m60.sum())
            per_stock.append(s['sig'].sum())
        print('  %-26s 第三把锁成立 %5d 次 / %d 根；完整信号 %4d 次（%.2f 次/只·5年）'
              % (label, tot, sum(len(x['day']['c']) - 65 for x in sts), sum(per_stock),
                 np.mean(per_stock)))

    sigs = []
    for st in sts:
        s = build(st['day'], ma5_slope=1.0)
        sigs.append((st, s))

    n_sig = sum(int(s['sig'].sum()) for _, s in sigs)
    yrs = np.mean([len(st['day']['c']) for st in sts]) / 243
    print('\n=== 修正版信号密度 ===')
    print('  信号 %d 次 / %d 只 / 平均 %.1f 年 → 每只每年 %.2f 次'
          % (n_sig, len(sigs), yrs, n_sig / len(sigs) / yrs))

    if args.probe:
        return

    # ---- 2. 主测 ----
    print('\n=== 三把锁（修正版）：四种退出 ===')
    for mode, label in (('ma60', '  收盘跌破 MA60'), ('buf', '  跌破 MA60 的 97%'),
                        ('low', '  收盘跌破信号 K 线低点'), ('atr', '  收盘跌破(低点-1ATR)')):
        t = []
        for st, s in sigs:
            t += run_trades(st, s, exit_mode=mode)
        stat(t, label)

    base = []
    for st, s in sigs:
        base += run_trades(st, s, exit_mode='ma60')
    print('\n=== 固定持有（信号日次日开盘买入）===')
    for hold in (3, 5, 10, 20, 60):
        t = []
        for st, s in sigs:
            t += run_trades(st, s, hold=hold)
        stat(t, '  持 %d 根' % hold)

    # ---- 3. 拆解三把锁 ----
    print('\n=== 三把锁各自的贡献（统一跌破 MA60 退出）===')
    variants = {
        'A 三把锁齐全': None,
        'B 缺第三把锁（不管 60 线）': 'no3',
        'C 只要动量底 + 60 线': 'no2',
        'D 只要布林回踩 + 60 线（无活性）': 'no1',
        'D2 去掉第一把锁，其余全保留': 'no1b',
        'E 只要第三把锁（趋势本身）': 'only3',
    }
    for label, mode in variants.items():
        t = []
        for st, s in sigs:
            v = dict(s)
            if mode == 'no3':
                v['sig'] = s['qd'] & s['bb'] & s['nr60']
            elif mode == 'no2':
                v['sig'] = s['qd'] & s['nr60'] & s['m60up']
            elif mode == 'no1':
                v['sig'] = s['bb'] & s['nr60'] & s['m60up']
            elif mode == 'no1b':
                # 严格「只去掉动量底」：活性、布林、趋势、距离全部保留
                v['sig'] = s['act'] & s['bb'] & s['nr60'] & s['m60up']
            elif mode == 'only3':
                v['sig'] = s['nr60'] & s['m60up']
            t += run_trades(st, v, exit_mode='ma60')
        stat(t, label)

    # ---- 4. 相对基线 ----
    print('\n=== 与「随便哪天买」的差别（同样持有 20 根）===')
    rnd = []
    rng = np.random.default_rng(args.seed)
    for st in sts:
        D = st['day']
        n = len(D['c'])
        for _ in range(max(1, int(n / 60))):
            i = int(rng.integers(65, n - 21))
            if limit_blocked(D, i):
                continue
            rnd.append({'ret': (D['o'][i + 21] / D['o'][i + 1] - 1) - COST, 'bars': 20})
    stat(rnd, '  随机日买入（持 20 根）')
    t = []
    for st, s in sigs:
        t += run_trades(st, s, hold=20)
    stat(t, '  三把锁信号（持 20 根）')

    # 同期「买了就不动」：用来判断正收益是来自择时，还是这批票本身就在涨
    bh = []
    for st in sts:
        D = st['day']
        bh.append({'ret': D['c'][-1] / D['o'][65] - 1, 'bars': len(D['c']) - 65})
    stat(bh, '  同期买入持有（每只一次）')

    # ---- 5. 逐年 ----
    print('\n=== 按年份（跌破 MA60 退出）===')
    buckets = {}
    for st, s in sigs:
        for tr in run_trades(st, s, exit_mode='ma60'):
            y = st['day']['d'][tr['i']][:4]
            buckets.setdefault(y, []).append(tr)
    for y in sorted(buckets):
        stat(buckets[y], '  ' + y)

    # ---- 5.5 只在「贴线」区间做（0~3.5%），看是否比原版好 ----
    print('\n=== 收窄到「距 60 线 0~3.5%」的 A 组（跌破 MA60 退出）===')
    tight = []
    for st, s in sigs:
        D = st['day']
        for tr in run_trades(st, s, exit_mode='ma60'):
            i = tr['i']
            m = s['ma60'][i]
            if np.isnan(m):
                continue
            dev = (D['c'][i] - m) / m * 100
            if 0 <= dev < 3.5:
                tight.append(tr)
    stat(tight, '  贴线 0~3.5%')

    # ---- 6. 距离 60 线的分档 ----
    print('\n=== 信号日距 60 线越近越好吗 ===')
    bins = [(-1, 0, '下方 0~5%'), (0, 2, '上方 0~2%'), (2, 3.5, '上方 2~3.5%'), (3.5, 9, '上方 3.5~5%')]
    for lo, hi, label in bins:
        t = []
        for st, s in sigs:
            D = st['day']
            for tr in run_trades(st, s, exit_mode='ma60'):
                i = tr['i']
                m = s['ma60'][i]
                if np.isnan(m):
                    continue
                dev = (D['c'][i] - m) / m * 100
                if lo <= dev < hi:
                    t.append(tr)
        stat(t, '  ' + label)


if __name__ == '__main__':
    main()
