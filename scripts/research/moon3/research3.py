# -*- coding: utf-8 -*-
"""第三轮：分层归因 —— 哪些信号更值钱，拥挤度能不能当择时用。"""
import json
import os
from collections import defaultdict

import numpy as np

out = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.cache', 'research-out.json')))
recs = [r for r in out['recs'] if r.get('r12') is not None]
print(f'可用于 12 月归因的信号 {len(recs)} 个')

def stat(name, arr):
    a = np.array(arr)
    if not len(a):
        print(f'{name:<22} 无样本'); return
    print(f'{name:<22}{len(a):>5} 个  均值 {a.mean()*100:>7.1f}%  中位 {np.median(a)*100:>7.1f}%  '
          f'胜率 {(a>0).mean()*100:>5.1f}%  最差 {a.min()*100:>6.1f}%')

print('\n=== 按偏离度分层（C/MA60-1，越负越超跌）===')
for lo, hi, nm in [(-100, -25, '< -25%'), (-25, -15, '-25% ~ -15%'),
                   (-15, -10, '-15% ~ -10%'), (-10, 0, '-10% ~ 0')]:
    stat(nm, [r['r12'] for r in recs if lo <= r['dev'] < hi])

print('\n=== 按箱位分层（34 月区间位置）===')
for lo, hi, nm in [(0, 5, '< 5%'), (5, 10, '5% ~ 10%'), (10, 15, '10% ~ 15%'), (15, 20, '15% ~ 20%')]:
    stat(nm, [r['r12'] for r in recs if lo <= r['box'] < hi])

print('\n=== 按量位分层（30 月成交量位置）===')
for lo, hi, nm in [(0, 5, '< 5%'), (5, 10, '5% ~ 10%'), (10, 15, '10% ~ 15%'), (15, 20, '15% ~ 20%')]:
    stat(nm, [r['r12'] for r in recs if lo <= r['vpos'] < hi])

by_month = defaultdict(list)
for r in recs:
    by_month[r['date'][:7]].append(r['r12'])

print('\n=== 按当月信号数分层（拥挤度 = 市场级超跌程度）===')
for lo, hi, nm in [(0, 3, '1~2 只（个股级）'), (3, 10, '3~9 只'),
                   (10, 30, '10~29 只'), (30, 1000, '>=30 只（市场级）')]:
    vals = []
    for m, vs in by_month.items():
        if lo <= len(vs) < hi:
            vals += vs
    stat(nm, vals)

# 市场级信号出现后，全市场未来 12 月表现
print('\n=== 拥挤月份的「市场」含义：当月出信号 >= 30 只时，全部信号的 12 月收益 ===')
crowded = [m for m, vs in by_month.items() if len(vs) >= 30]
print('拥挤月：', ', '.join(sorted(crowded)))
allv = [v for m in crowded for v in by_month[m]]
stat('拥挤月全部信号', allv)

# 同一只票重复信号的间隔
print('\n=== 同一只票两次信号的间隔（月）===')
cache = json.load(open(os.environ.get('MOON3_CACHE') or os.path.join(os.path.dirname(os.path.abspath(__file__)), '.cache', 'month-cache.json')))['data']
per = defaultdict(list)
for r in out['recs']:
    per[r['sym']].append(r['date'])
gaps = []
for sym, ds in per.items():
    ds = sorted(ds)
    for a, b in zip(ds, ds[1:]):
        ya, ma = int(a[:4]), int(a[5:7])
        yb, mb = int(b[:4]), int(b[5:7])
        gaps.append((yb - ya) * 12 + (mb - ma))
if gaps:
    g = np.array(gaps)
    print(f'重复出信号的票 {len(g)} 对，间隔中位 {np.median(g):.0f} 个月，'
          f'最短 {g.min()}，最长 {g.max()}；间隔 <=20 个月的占 {(g<=20).mean()*100:.0f}%')

# 极端回撤：持有期内最低点
print('\n=== 持有 12 个月内的最大浮亏（从买入月收盘算）===')
dd = []
for r in out['recs']:
    rows = cache[r['sym']]['rows']
    if rows[-1][0][:7] == '2026-11':
        rows = rows[:-1]
    d = [x[0][:7] for x in rows]
    try:
        i0 = d.index(r['date'][:7])
    except ValueError:
        continue
    c = np.array([x[2] for x in rows], float)
    seg = c[i0:i0 + 13]
    if len(seg) < 3:
        continue
    dd.append(seg.min() / seg[0] - 1)
a = np.array(dd)
print(f'{len(a)} 个信号：中位最大浮亏 {np.median(a)*100:.1f}%，'
      f'平均 {a.mean()*100:.1f}%，浮亏超 20% 的占 {(a<-0.2).mean()*100:.0f}%，'
      f'超 30% 的占 {(a<-0.3).mean()*100:.0f}%')
