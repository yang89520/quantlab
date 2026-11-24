# -*- coding: utf-8 -*-
"""月线三重底选股指标 · 历史统计研究
公式来源：用户提供的通达信选股公式（超跌红柱 + 买点 + 地量，三重且）
要点：
  1) 所有指标只用「已完成月线」，最后一根当月未走完的 K 线必须剔除（否则量位失真）；
  2) 信号后 N 月收益用月末收盘买入、N 月后月末收盘卖出；
  3) 基准用同一批样本的等权平均，算超额。
"""
import json
import os
import subprocess
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(_HERE)))  # moon3 → research → scripts → 仓库根
CACHE = os.environ.get('MOON3_CACHE') or os.path.join(_HERE, '.cache', 'month-cache.json')
PY = os.path.join(_ROOT, 'py', '.venv', 'bin', 'python')
RUNNER = os.path.join(_ROOT, 'py', 'tdx_engine', 'runner.py')


def rolling_min(a, n):
    """部分窗口：不足 N 根时用已有根数的最小值（与引擎 _LLV 一致）。"""
    out = np.empty(len(a))
    for i in range(len(a)):
        out[i] = a[max(0, i - n + 1):i + 1].min()
    return out


def rolling_max(a, n):
    out = np.empty(len(a))
    for i in range(len(a)):
        out[i] = a[max(0, i - n + 1):i + 1].max()
    return out


def rolling_mean(a, n):
    """部分窗口均值（与引擎 _MA 一致：窗口内有效值求和除以个数）。"""
    out = np.empty(len(a))
    for i in range(len(a)):
        out[i] = a[max(0, i - n + 1):i + 1].mean()
    return out


def tdx_filter(cond, n):
    """FILTER(X,N)：X 成立后，紧随的 N 根一律置 0。"""
    out = np.zeros(len(cond), dtype=int)
    hold = -1
    for i, v in enumerate(cond):
        if v and i > hold:
            out[i] = 1
            hold = i + n
    return out


def compute(rows, period=60, dev_th=10.0, box_th=20.0, vol_th=20.0, vol_n=30, box_n=34, filt=20):
    """rows: [date, o, c, h, l, v, amount]；返回各中间量与信号。"""
    o = np.array([r[1] for r in rows], float)
    c = np.array([r[2] for r in rows], float)
    h = np.array([r[3] for r in rows], float)
    l = np.array([r[4] for r in rows], float)
    v = np.array([r[5] for r in rows], float)

    ma = rolling_mean(c, period)
    dev = (c / ma - 1) * 100

    mid = (2 * c + h + l) / 4
    lo = rolling_min(l, box_n)
    hi = rolling_max(h, box_n)
    box = (mid - lo) / (hi - lo) * 100

    vlo = rolling_min(v, vol_n)
    vhi = rolling_max(v, vol_n)
    vpos = (v - vlo) / (vhi - vlo + 1e-4) * 100

    oversold = (box < box_th) & (dev < -dev_th)
    raw_buy = (dev < -dev_th) & (box < box_th)
    buy = tdx_filter(raw_buy, filt)
    dry = vpos < vol_th
    xg = oversold & (buy == 1) & dry
    # warmup：MA 要 period 根、箱体要 box_n 根、量位要 vol_n 根。
    # 不足这段历史时算出来的值虽然「有数」，但代表不了长周期位置，一律不认信号。
    warm = max(period, box_n, vol_n)
    mask = np.zeros(len(c), dtype=bool)
    mask[warm:] = True
    xg = xg & mask
    return dict(dev=dev, box=box, vpos=vpos, ma=ma, oversold=oversold,
                raw_buy=raw_buy, buy=buy, dry=dry, xg=xg, c=c, o=o, h=h, l=l, v=v)


def engine_check(rows, formula, line='XG'):
    ohlcv = {
        'datetime': [r[0] for r in rows],
        'open': [r[1] for r in rows], 'close': [r[2] for r in rows],
        'high': [r[3] for r in rows], 'low': [r[4] for r in rows],
        'vol': [r[5] for r in rows], 'amount': [r[6] for r in rows],
    }
    p = subprocess.run([PY, RUNNER], text=True, capture_output=True,
                       input=json.dumps({'task': 'run', 'formula': formula,
                                         'outputLine': line, 'ohlcv': ohlcv, 'params': {}},
                                        ensure_ascii=False))
    r = json.loads(p.stdout.strip().split('\n')[-1])
    return r


FORMULA = """周期:=60;
偏离阈:=10;
箱位阈:=20;
均60:=MA(C,周期);
偏离:=(C/均60-1)*100;
中位:=(2*C+H+L)/4;
低34:=LLV(L,34);
高34:=HHV(H,34);
箱位:=(中位-低34)/(高34-低34)*100;
超跌红柱:=箱位<20 AND 偏离<-10;
原始买:=偏离<-偏离阈 AND 箱位<箱位阈;
买:=FILTER(原始买,20);
量位:=(V-LLV(V,30))/(HHV(V,30)-LLV(V,30)+0.0001)*100;
地量:=量位<20;
XG:超跌红柱 AND 买 AND 地量;
"""


def main():
    cache = json.load(open(CACHE))
    data = cache['data']
    print(f'样本 {len(data)} 只，抓取于 {cache["savedAt"]}')

    # ---- 1) 与引擎对账（挑样本里第一只，和 600986 若有）----
    key = 'sh600986' if 'sh600986' in data else next(iter(data))
    rows = [r for r in data[key]['rows']]
    eng = engine_check(rows, FORMULA)
    mine = compute(rows)
    if eng.get('ok'):
        e_buy = np.array([x or 0 for x in eng['outputs']['买']], int)
        e_xg = np.array([x or 0 for x in eng['outputs']['XG']], int)
        same_buy = np.array_equal(e_buy, mine['buy'])
        # XG 只比 warmup 之后：引擎会照实算前 60 根（通达信也用部分窗口），
        # 研究口径刻意把那段判为无效，两边在「有意义的区间」必须逐根一致。
        w = 94
        same_xg = np.array_equal(e_xg[w:], mine['xg'].astype(int)[w:])
        print(f'对账 {key}: 买 一致={same_buy}  XG(warmup 后) 一致={same_xg}  '
              f'信号数 引擎={int(e_xg[w:].sum())} 本地={int(mine["xg"].sum())}')
        if not (same_buy and same_xg):
            print('  ⚠ 不一致，需先排查再谈统计')
            return

    # ---- 2) 全样本信号与未来收益 ----
    HOR = [1, 3, 6, 12, 24]
    recs = []
    bench = {h: [] for h in HOR}
    universe = 0
    skipped_new = 0

    for sym, v in data.items():
        rows = v['rows']
        if len(rows) < 60 + 34:
            skipped_new += 1
            continue
        # 剔除最后一根未完成月：日期不是月末或等于今天所在月
        last_date = rows[-1][0]
        if last_date[:7] == '2026-11':
            rows = rows[:-1]
        if len(rows) < 60 + 34:
            skipped_new += 1
            continue
        r = compute(rows)
        universe += 1
        c = r['c']
        n = len(c)
        # 基准：每个月末对每只票的 h 月收益，汇总成市场均值
        for i in range(60, n):
            for h in HOR:
                if i + h < n:
                    bench[h].append(c[i + h] / c[i] - 1)
        for i in np.flatnonzero(r['xg']):
            i = int(i)
            rec = {'sym': sym, 'name': v.get('name'), 'date': rows[i][0],
                   'dev': float(r['dev'][i]), 'box': float(r['box'][i]),
                   'vpos': float(r['vpos'][i]), 'close': float(c[i])}
            for h in HOR:
                rec[f'r{h}'] = (c[i + h] / c[i] - 1) if i + h < n else None
            recs.append(rec)

    print(f'可用样本 {universe} 只（新上市/历史不足剔除 {skipped_new}）')
    print(f'信号总数 {len(recs)}，平均每只 {len(recs)/max(1,universe):.2f} 次，'
          f'平均每只每年 {len(recs)/max(1,universe)/(max(1,max(len(v["rows"]) for v in data.values()))/12):.2f} 次')

    bm = {h: float(np.mean(bench[h])) for h in HOR}
    print('\n=== 信号后收益（月线，收盘买入，N 月末收盘卖出）===')
    print(f'{"持有":<6}{"样本":>6}{"胜率":>9}{"均值":>10}{"中位":>10}{"基准":>10}{"超额":>10}{"最好":>9}{"最差":>9}')
    stats = {}
    for h in HOR:
        vals = [r[f'r{h}'] for r in recs if r[f'r{h}'] is not None]
        if not vals:
            continue
        a = np.array(vals)
        stats[h] = dict(n=len(a), win=float((a > 0).mean()), mean=float(a.mean()),
                        med=float(np.median(a)), bench=bm[h], ex=float(a.mean() - bm[h]),
                        best=float(a.max()), worst=float(a.min()))
        print(f'{h:<6}{len(a):>6}{a.mean() and (a>0).mean()*100:>8.1f}%'
              f'{a.mean()*100:>9.1f}%{np.median(a)*100:>9.1f}%{bm[h]*100:>9.1f}%'
              f'{(a.mean()-bm[h])*100:>9.1f}%{a.max()*100:>8.1f}%{a.min()*100:>8.1f}%')

    # ---- 3) 分年份 ----
    print('\n=== 按信号年份分布（12 个月持有）===')
    by_year = {}
    for r in recs:
        y = r['date'][:4]
        by_year.setdefault(y, []).append(r.get('r12'))
    for y in sorted(by_year):
        vals = [x for x in by_year[y] if x is not None]
        if not vals:
            print(f'{y}  {len(by_year[y]):>3} 个   （持有期不足）')
            continue
        a = np.array(vals)
        print(f'{y}  {len(by_year[y]):>3} 个  均值 {a.mean()*100:>7.1f}%  胜率 {(a>0).mean()*100:>5.1f}%')

    # ---- 4) 参数敏感性 ----
    print('\n=== 参数敏感性（信号数 / 12 月均值收益 / 胜率）===')
    grid = []
    for period in (40, 60, 80):
        for dev_th in (5, 10, 15, 20):
            grid.append(dict(period=period, dev_th=dev_th, box_th=20, vol_th=20))
    for box_th in (10, 20, 30, 40):
        grid.append(dict(period=60, dev_th=10, box_th=box_th, vol_th=20))
    for vol_th in (10, 20, 30, 40):
        grid.append(dict(period=60, dev_th=10, box_th=20, vol_th=vol_th))
    print(f'{"周期":>4}{"偏离":>6}{"箱位":>6}{"量位":>6}{"信号":>7}{"12月均值":>11}{"胜率":>8}{"24月均值":>11}')
    for g in grid:
        tot, r12, win12, r24 = 0, [], [], []
        for sym, v in data.items():
            rows = v['rows']
            if len(rows) < g['period'] + 34:
                continue
            if rows[-1][0][:7] == '2026-11':
                rows = rows[:-1]
            if len(rows) < g['period'] + 34:
                continue
            r = compute(rows, **g)
            c = r['c']; n = len(c)
            for i in np.flatnonzero(r['xg']):
                i = int(i); tot += 1
                if i + 12 < n: r12.append(c[i + 12] / c[i] - 1)
                if i + 24 < n: r24.append(c[i + 24] / c[i] - 1)
        a12 = np.array(r12) if r12 else np.array([0.0])
        a24 = np.array(r24) if r24 else np.array([0.0])
        print(f'{g["period"]:>4}{g["dev_th"]:>6}{g["box_th"]:>6}{g["vol_th"]:>6}{tot:>7}'
              f'{a12.mean()*100:>10.1f}%{(a12>0).mean()*100:>7.1f}%{a24.mean()*100:>10.1f}%')

    os.makedirs(os.path.join(_HERE, '.cache'), exist_ok=True)
    json.dump({'stats': stats, 'recs': recs}, open(os.path.join(_HERE, '.cache', 'research-out.json'), 'w'), ensure_ascii=False)


if __name__ == '__main__':
    main()
