#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
三个新流派的 A 股实证检验（不是回测框架，只回答一个问题：
「这套规则在 A 股上到底是正期望还是负期望，以及前提条件是什么」）。

检验对象与口径，与前端 strategies.js 完全一致：
  1. SuperTrend(10, 3)：收盘翻多 → 次日开盘买入；收盘翻空 → 次日开盘卖出。
     原文说「趋势里拿得住、震荡里小亏一串」，所以按 ADX 与假翻转率分组看差异。
  2. 三指标共振：三灯同亮多（+3）→ 次日开盘买入，持有 3 根收盘卖出。
     原文说「震荡市好用、单边市卖飞」，同样按 ADX 分组。
  3. PA 多周期：只统计「大周期多 + 当前周期上升趋势」的共振日，看其后 5/10 根的表现。

所有交易都含 A 股的实际约束：
  · T+1：次日开盘才买，卖出也等次日开盘（SuperTrend），不存在当日进出；
  · 涨跌停：次日开盘一字涨停（开盘即涨停价且全天最高=最低）无法买入，样本剔除；
  · 成本：双边按 0.12%（佣金+印花税+滑点）扣减，否则短线策略的结论会虚高。

用法：
  python3 tools/backtest.py --n 120
  python3 tools/backtest.py --n 60 --period 5
"""
import argparse
import json
import math
import random
import sys
import urllib.request

import numpy as np


# ---------------- 数据 ----------------
def http_json(url, timeout=60):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def load(code, host, port):
    d = http_json('http://%s:%d/api/stock/%s?period=day&bars=1200' % (host, port, code))['data']
    k = d.get('klines') or []
    if len(k) < 300:
        return None
    # 返回顺序是 [date, open, close, high, low, vol, amount]
    arr = np.array([[r[1], r[2], r[3], r[4], r[5]] for r in k], dtype=float)
    return {'o': arr[:, 0], 'c': arr[:, 1], 'h': arr[:, 2], 'l': arr[:, 3], 'v': arr[:, 4],
            'name': d.get('name') or code, 'code': code}


# ---------------- 指标（与 indicators.js 同口径） ----------------
def wilder(x, n):
    out = np.full(len(x), np.nan)
    if len(x) < n:
        return out
    out[n - 1] = np.nanmean(x[:n])
    for i in range(n, len(x)):
        out[i] = (out[i - 1] * (n - 1) + x[i]) / n
    return out


def true_range(h, l, c):
    tr = np.zeros(len(c))
    tr[0] = h[0] - l[0]
    for i in range(1, len(c)):
        tr[i] = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
    return tr


def supertrend(h, l, c, period=10, mult=3.0):
    atr = wilder(true_range(h, l, c), period)
    n = len(c)
    up = np.full(n, np.nan)
    dn = np.full(n, np.nan)
    st = np.full(n, np.nan)
    dr = np.zeros(n, dtype=int)
    start = -1
    for i in range(n):
        if np.isnan(atr[i]):
            continue
        hl2 = (h[i] + l[i]) / 2
        bl = hl2 - mult * atr[i]
        bu = hl2 + mult * atr[i]
        if start < 0:
            start = i
            up[i], dn[i], dr[i], st[i] = bl, bu, 1, bl
            continue
        up[i] = max(bl, up[i - 1]) if c[i - 1] > up[i - 1] else bl
        dn[i] = min(bu, dn[i - 1]) if c[i - 1] < dn[i - 1] else bu
        d = dr[i - 1]
        if d == -1 and c[i] > dn[i - 1]:
            d = 1
        elif d == 1 and c[i] < up[i - 1]:
            d = -1
        dr[i] = d
        st[i] = up[i] if d == 1 else dn[i]
    return atr, dr, st


def adx(h, l, c, n=14):
    tr = true_range(h, l, c)
    pdm = np.zeros(len(c))
    mdm = np.zeros(len(c))
    for i in range(1, len(c)):
        u = h[i] - h[i - 1]
        d = l[i - 1] - l[i]
        pdm[i] = u if (u > d and u > 0) else 0
        mdm[i] = d if (d > u and d > 0) else 0
    atr = wilder(tr, n)
    pdi = 100 * wilder(pdm, n) / np.where(atr == 0, np.nan, atr)
    mdi = 100 * wilder(mdm, n) / np.where(atr == 0, np.nan, atr)
    dx = 100 * np.abs(pdi - mdi) / np.where((pdi + mdi) == 0, np.nan, (pdi + mdi))
    out = np.full(len(c), np.nan)
    first = n - 1
    if len(c) > first + n:
        out[first + n - 1] = np.nanmean(dx[first:first + n])
        for i in range(first + n, len(c)):
            out[i] = (out[i - 1] * (n - 1) + dx[i]) / n
    return out


def ema(x, n):
    out = np.empty(len(x))
    k = 2 / (n + 1)
    out[0] = x[0]
    for i in range(1, len(x)):
        out[i] = x[i] * k + out[i - 1] * (1 - k)
    return out


def macd(c):
    dif = ema(c, 12) - ema(c, 26)
    dea = ema(dif, 9)
    return dif, dea, (dif - dea) * 2


def kdj(h, l, c, n=9):
    rsv = np.full(len(c), np.nan)
    for i in range(n - 1, len(c)):
        hh, ll = h[i - n + 1:i + 1].max(), l[i - n + 1:i + 1].min()
        rsv[i] = 50 if hh == ll else (c[i] - ll) / (hh - ll) * 100
    K = np.full(len(c), np.nan)
    D = np.full(len(c), np.nan)
    k1 = d1 = 50.0
    for i in range(len(c)):
        if np.isnan(rsv[i]):
            continue
        k1 = (2 * k1 + rsv[i]) / 3
        d1 = (2 * d1 + k1) / 3
        K[i], D[i] = k1, d1
    return K, D, 3 * K - 2 * D


def rsi(c, n=6):
    out = np.full(len(c), np.nan)
    if len(c) < n + 1:
        return out
    g = np.zeros(len(c))
    ls = np.zeros(len(c))
    for i in range(1, len(c)):
        d = c[i] - c[i - 1]
        g[i] = max(d, 0)
        ls[i] = max(-d, 0)
    ag, al = np.nanmean(g[1:n + 1]), np.nanmean(ls[1:n + 1])
    out[n] = 100 if al == 0 else 100 - 100 / (1 + ag / al)
    for i in range(n + 1, len(c)):
        ag = (ag * (n - 1) + g[i]) / n
        al = (al * (n - 1) + ls[i]) / n
        out[i] = 100 if al == 0 else 100 - 100 / (1 + ag / al)
    return out


def trilights(macd_t, kdj_t, rsi_t, c):
    dif, dea, hist = macd_t
    K, D, J = kdj_t
    n = len(c)
    S = np.zeros(n, dtype=int)
    for i in range(n):
        if np.isnan(dif[i]) or np.isnan(K[i]) or np.isnan(rsi_t[i]) or np.isnan(J[i]):
            S[i] = 99
            continue
        a = 1 if dif[i] > dea[i] else -1
        if abs(hist[i]) < c[i] * 0.0005:
            a = 0
        if J[i] < 0:
            b = 1
        elif J[i] > 100:
            b = -1
        else:
            b = 0
            for t in range(i, max(0, i - 3), -1):
                if np.isnan(K[t - 1]) or np.isnan(D[t - 1]):
                    continue
                if K[t - 1] <= D[t - 1] and K[t] > D[t]:
                    b = 1
                    break
                if K[t - 1] >= D[t - 1] and K[t] < D[t]:
                    b = -1
                    break
            if b == 0:
                b = 0 if (abs(K[i] - D[i]) < 1.5 and 35 < J[i] < 65) else (1 if K[i] > D[i] else -1)
        r = rsi_t[i]
        if r >= 80:
            cc = -1
        elif r <= 20:
            cc = 1
        elif r > 60:
            cc = 1
        elif r < 40:
            cc = -1
        else:
            cc = 0
        S[i] = a + b + cc
    return S


# ---------------- 交易模拟 ----------------
COST = 0.0012


def limit_open_blocked(d, i):
    """次日开盘一字涨停：开盘=最高=最低 且相对前收涨 9.8% 以上（主板口径近似）"""
    if i <= 0 or i >= len(d['c']):
        return False
    o, h, l = d['o'][i], d['h'][i], d['l'][i]
    prev = d['c'][i - 1]
    return h == l and o >= prev * 1.098


def bt_supertrend(d, adx_arr):
    _, dr, _ = supertrend(d['h'], d['l'], d['c'])
    trades = []
    pos = 0
    entry = 0.0
    for i in range(30, len(d['c']) - 1):
        if dr[i] == 1 and dr[i - 1] == -1 and pos == 0:
            j = i + 1
            if limit_open_blocked(d, j):
                continue
            pos, entry = 1, d['o'][j]
            entry_i = j
        elif dr[i] == -1 and dr[i - 1] == 1 and pos == 1:
            j = i + 1
            exit_px = d['o'][j]
            ret = exit_px / entry * (1 - COST) - 1
            trades.append({'ret': ret, 'bars': j - entry_i, 'adx': adx_arr[i] if not np.isnan(adx_arr[i]) else np.nan,
                           'entry_i': entry_i, 'exit_i': j})
            pos = 0
    return trades


def bt_tri(d, adx_arr, hold=3):
    S = trilights(macd(d['c']), kdj(d['h'], d['l'], d['c']), rsi(d['c'], 6), d['c'])
    trades = []
    for i in range(70, len(d['c']) - hold - 1):
        if S[i] != 3:
            continue
        dup = any(S[t] == 3 for t in range(max(0, i - hold), i))
        if dup:
            continue
        j = i + 1
        if limit_open_blocked(d, j):
            continue
        entry, exit_px = d['o'][j], d['c'][i + hold]
        trades.append({'ret': exit_px / entry * (1 - COST) - 1, 'bars': hold,
                       'adx': adx_arr[i] if not np.isnan(adx_arr[i]) else np.nan})
    return trades


def bt_buyhold(d):
    return d['c'][-1] / d['c'][60] - 1


def stat(trades, label):
    if not trades:
        print('%-26s 无样本' % label)
        return
    r = np.array([t['ret'] for t in trades])
    win = (r > 0).mean()
    print('%-26s n=%-5d 胜率=%5.1f%% 均值=%+6.2f%% 中位=%+6.2f%% 盈亏比=%.2f' % (
        label, len(r), win * 100, r.mean() * 100, np.median(r) * 100,
        (r[r > 0].mean() / abs(r[r <= 0].mean())) if (r > 0).any() and (r <= 0).any() else float('nan')))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--n', type=int, default=120)
    ap.add_argument('--hold', type=int, default=3)
    ap.add_argument('--host', default='localhost')
    ap.add_argument('--port', type=int, default=3000)
    a = ap.parse_args()

    mk = http_json('http://%s:%d/api/screen/market' % (a.host, a.port))
    pool = mk.get('data') or mk
    if isinstance(pool, dict):
        pool = pool.get('codes') or pool.get('list') or []
    pool = [x['code'] if isinstance(x, dict) else x for x in pool]
    random.seed(20261113)
    codes = random.sample(pool, min(a.n, len(pool)))

    st_all, tri_all = [], []
    hi_adx, lo_adx = [], []
    bh = []
    ok = 0
    for code in codes:
        try:
            d = load(code, a.host, a.port)
        except Exception:
            continue
        if not d:
            continue
        ok += 1
        adx_arr = adx(d['h'], d['l'], d['c'])
        st_all += bt_supertrend(d, adx_arr)
        tri_all += bt_tri(d, adx_arr, a.hold)
        bh.append(bt_buyhold(d))

    print('\n样本 %d 只（成功 %d），区间约 1200 根日线\n' % (len(codes), ok))
    print('— SuperTrend(10,3) 翻多买入 / 翻空卖出，次日开盘执行，双边成本 0.12% —')
    stat(st_all, '全部信号')
    stat([t for t in st_all if not np.isnan(t['adx']) and t['adx'] >= 25], 'ADX≥25（强趋势）')
    stat([t for t in st_all if not np.isnan(t['adx']) and t['adx'] < 20], 'ADX<20（震荡）')
    if st_all:
        bars = np.array([t['bars'] for t in st_all])
        print('%-26s 平均持仓 %.0f 根（中位 %.0f）' % ('', bars.mean(), np.median(bars)))
        stat([t for t in st_all if t['bars'] <= 5], '  持仓≤5根（被反复打脸）')
        stat([t for t in st_all if 6 <= t['bars'] <= 20], '  持仓6~20根')
        stat([t for t in st_all if t['bars'] > 20], '  持仓>20根（拿住了）')

    print('\n— 三指标共振：三灯同亮多，次日开盘买入，持有 %d 根收盘卖出 —' % a.hold)
    stat(tri_all, '全部同亮')
    stat([t for t in tri_all if not np.isnan(t['adx']) and t['adx'] < 20], 'ADX<20（震荡，原文适用）')
    stat([t for t in tri_all if not np.isnan(t['adx']) and t['adx'] >= 30], 'ADX≥30（单边，原文失效）')

    print('\n— 对照 —')
    bh = np.array(bh)
    print('%-26s 均值=%+.2f%% 中位=%+.2f%% 正收益占比=%.1f%%' % (
        '同期买入持有（1200根）', bh.mean() * 100, np.median(bh) * 100, (bh > 0).mean() * 100))


if __name__ == '__main__':
    main()
