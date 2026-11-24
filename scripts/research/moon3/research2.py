# -*- coding: utf-8 -*-
"""第二轮：判断这个指标是「选股」还是「择时」，以及组合层面的真实表现。"""
import json
import os
from collections import defaultdict

import numpy as np

from research import compute

cache = json.load(open(os.environ.get('MOON3_CACHE') or os.path.join(os.path.dirname(os.path.abspath(__file__)), '.cache', 'month-cache.json')))['data']
out = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.cache', 'research-out.json')))
recs = out['recs']

# ---------- 1) 信号拥挤度：同一个月有多少只票同时出信号 ----------
by_month = defaultdict(list)
for r in recs:
    by_month[r['date'][:7]].append(r)
months = sorted(by_month)
print(f'=== 信号月份分布（共 {len(months)} 个月有信号）===')
cnts = [len(by_month[m]) for m in months]
print(f'月均 {np.mean(cnts):.1f} 只，中位 {np.median(cnts):.0f} 只，最多 {max(cnts)} 只（{months[int(np.argmax(cnts))]}）')
print('前 12 个最拥挤的月份：')
for m in sorted(months, key=lambda x: -len(by_month[x]))[:12]:
    v = [r['r12'] for r in by_month[m] if r.get('r12') is not None]
    s = f'12月中位 {np.median(v)*100:+.1f}%' if v else '（观察期不足）'
    print(f'  {m}  {len(by_month[m]):>3} 只   {s}')
singles = [m for m in months if len(by_month[m]) == 1]
print(f'只有 1 只出信号的月份：{len(singles)} 个（占 {len(singles)/len(months)*100:.0f}%）')

# ---------- 2) 组合层面：每月等权买入当月所有信号，持有 N 月 ----------
print('\n=== 组合净值（每月等权买入当月全部信号，持有 12 个月，逐月滚动）===')
# 对齐到月末序列：用 2020-11 起的月份轴
import datetime
axis = []
y, m = 2020, 11
while True:
    axis.append(f'{y:04d}-{m:02d}')
    m += 1
    if m == 13:
        m = 1; y += 1
    if (y, m) > (2026, 9):
        break

pos_ret = []      # 每个月，所有「持有中」信号的当月收益（等权）
nav = [1.0]
per_month = []
for k, mm in enumerate(axis):
    # 当月持有的是过去 12 个月内出过信号、且未满 12 个月的
    rets = []
    for back in range(0, 12):
        src = axis[k - back] if k - back >= 0 else None
        if not src:
            continue
        for r in by_month.get(src, []):
            pass
    per_month.append(len(by_month.get(mm, [])))

print('（改用逐笔持有期收益聚合，见下）')

# 真正的月度组合：对每个信号，把它未来 12 个月的收益按 1/12 摊到每个月
monthly = defaultdict(list)
for r in recs:
    sym = r['sym']
    rows = cache[sym]['rows']
    if rows[-1][0][:7] == '2026-11':
        rows = rows[:-1]
    dates = [x[0][:7] for x in rows]
    try:
        i0 = dates.index(r['date'][:7])
    except ValueError:
        continue
    c = np.array([x[2] for x in rows], float)
    for k in range(1, 13):
        if i0 + k >= len(c):
            break
        monthly[dates[i0 + k]].append(c[i0 + k] / c[i0 + k - 1] - 1)

nav = [1.0]
curve = []
for mm in axis[1:]:
    v = monthly.get(mm, [])
    if not v:
        continue
    r = float(np.mean(v))
    nav.append(nav[-1] * (1 + r))
    curve.append((mm, nav[-1], len(v), r))
print(f'{"月份":<9}{"净值":>8}{"持仓数":>8}{"月收益":>9}')
for mm, nv, n, r in curve:
    print(f'{mm:<9}{nv:>8.3f}{n:>8}{r*100:>8.1f}%')
if curve:
    peak = 0; mdd = 0
    for _, nv, _, _ in curve:
        peak = max(peak, nv); mdd = max(mdd, 1 - nv / peak)
    print(f'末净值 {curve[-1][1]:.3f}，最大回撤 {mdd*100:.1f}%，'
          f'月胜率 {np.mean([1 if r>0 else 0 for _,_,_,r in curve])*100:.0f}%，共 {len(curve)} 个月')

# ---------- 3) 同月全市场对比（排除 beta） ----------
print('\n=== 同月对比：信号股 vs 当月全市场（12 个月收益）===')
allret = defaultdict(list)   # 每个"买入月" -> 全样本所有票未来 12 月收益
for sym, v in cache.items():
    rows = v['rows']
    if rows[-1][0][:7] == '2026-11':
        rows = rows[:-1]
    c = np.array([x[2] for x in rows], float)
    d = [x[0][:7] for x in rows]
    for i in range(len(c) - 12):
        allret[d[i]].append(c[i + 12] / c[i] - 1)

excess = []
for r in recs:
    m = r['date'][:7]
    if r.get('r12') is None or not allret.get(m):
        continue
    base = float(np.mean(allret[m]))
    excess.append(r['r12'] - base)
e = np.array(excess)
print(f'配对样本 {len(e)}，平均超额 {e.mean()*100:+.1f}%，中位 {np.median(e)*100:+.1f}%，'
      f'跑赢当月市场比例 {(e>0).mean()*100:.1f}%')
print(f'超额 >0 的月份占 {len([1 for r,ex in zip([x for x in recs if x.get("r12") is not None and allret.get(x["date"][:7])], e) if ex>0])/len(e)*100:.0f}%')
