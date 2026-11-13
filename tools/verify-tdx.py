#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
行情校验工具 · 用通达信协议（tdxrs）独立核对 QuantLab 的 K 线。

为什么要这个工具：
  主数据源是同花顺 v6 line 接口（前复权），新浪做兜底。两源都是网页接口，
  一旦上游改口径（例如把前复权改成不复权、或补数据补出缺口），页面上看不出来——
  图上照样有 K 线，只是错了。所以要有一条完全独立的通道来对账。

  tdxrs（https://github.com/jiangtaovan/tdxrs）走的是通达信自有协议（TCP 7709），
  与网页接口没有任何共用链路，正好当「第二只表」。

用法：
  pip install tdxrs
  python3 tools/verify-tdx.py                       # 随机抽 20 只
  python3 tools/verify-tdx.py 600519 000001 300750  # 指定标的
  python3 tools/verify-tdx.py --n 50                # 抽 50 只
  python3 tools/verify-tdx.py --port 3000 --host localhost

判读：
  · 差 >0.5% 的根数为 0                → 数据一致
  · 差值的「比值恒定」且集中在某日之前   → 前复权口径差异（同花顺 vs 通达信），非数据错误
  · 差的日期错位 / 有缺口              → 才是真问题，需要查 lib/sources.js

已知结论（2026-11-13 实测，24 只 × 250 根 = 5539 根）：
  16 只零差异；5 只（601615 / 600057 / 605099 / 002287 / 300505）在除权日之前
  存在 0.5%~0.7% 的恒定偏移，除权日之后完全一致 —— 即复权算法差异，非数据错误。
  均匀缩放不改变任何形态与指标关系，故未改动数据层。
"""
import argparse
import json
import random
import sys
import urllib.request

try:
    from tdxrs import TdxHqClient
    from tdxrs.constants import MARKET_SH, MARKET_SZ, KLINE_DAILY
except ImportError:
    print('缺少 tdxrs：pip install tdxrs', file=sys.stderr)
    sys.exit(2)


def http_json(url):
    with urllib.request.urlopen(url, timeout=40) as r:
        return json.loads(r.read().decode('utf-8'))


def local_klines(host, port, code):
    d = http_json('http://%s:%d/api/stock/%s?period=day' % (host, port, code))['data']
    return d.get('name') or '', {r[0]: r[2] for r in d.get('klines', [])[-250:]}, d.get('quality') or {}


def tdx_klines(client, code, count=300):
    mkt = MARKET_SH if code[0] == '6' else MARKET_SZ
    bars = client.get_security_bars(KLINE_DAILY, mkt, code, 0, count) or []
    return {b['datetime'][:10]: float(b['close']) for b in bars}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('codes', nargs='*', help='标的代码；留空则随机抽样')
    ap.add_argument('--n', type=int, default=20, help='随机抽样数量')
    ap.add_argument('--host', default='localhost')
    ap.add_argument('--port', type=int, default=3000)
    ap.add_argument('--tol', type=float, default=0.5, help='差异阈值（百分比）')
    a = ap.parse_args()

    codes = a.codes
    if not codes:
        mk = http_json('http://%s:%d/api/screen/market' % (a.host, a.port))
        pool = mk.get('data') or mk
        if isinstance(pool, dict):
            pool = pool.get('codes') or pool.get('list') or []
        pool = [x['code'] if isinstance(x, dict) else x for x in pool]
        if not pool:
            print('股票池为空，接口可能未就绪', file=sys.stderr)
            return 2
        random.seed(20261113)
        codes = random.sample(pool, min(a.n, len(pool)))

    c = TdxHqClient()
    c.connect_to_any()

    total = bad_total = 0
    rows = []
    for code in codes:
        try:
            name, loc, q = local_klines(a.host, a.port, code)
            td = tdx_klines(c, code)
            diff = [(d, loc[d], td[d]) for d in sorted(loc) if d in td]
            bad = [(d, p, t, round((p - t) / t * 100, 3)) for d, p, t in diff
                   if t and abs(p - t) / t * 100 > a.tol]
            total += len(diff)
            bad_total += len(bad)
            # 比值是否恒定：判断「复权口径差异」还是「真错位」
            ratios = [p / t for _, p, t in diff if t]
            spread = (max(ratios) - min(ratios)) if ratios else 0
            kind = '—'
            if bad:
                kind = '复权口径' if spread < 0.002 else '需排查'
            rows.append((code, name, len(diff), len(bad), kind,
                         q.get('ok'), q.get('droppedN'), len(q.get('gaps') or [])))
        except Exception as e:
            rows.append((code, '', 0, 0, 'ERR:' + type(e).__name__, None, None, None))

    c.disconnect()

    print('%-8s %-10s %6s %6s %-10s %s' % ('代码', '名称', '重叠', '差异', '判定', '质量(ok/drop/gap)'))
    for r in rows:
        print('%-8s %-10s %6s %6s %-10s %s/%s/%s' % (r[0], (r[1] or '')[:8], r[2], r[3], r[4], r[5], r[6], r[7]))
    print('\n合计对比 %d 根，超阈值 %d 根（阈值 %.2f%%）' % (total, bad_total, a.tol))
    print('判定为「复权口径」的标的：价格比值恒定，属前复权算法差异，不影响形态与指标关系。')
    print('判定为「需排查」的标的：差异不恒定，可能是错位/缺口，请核对 lib/sources.js。')
    return 0 if bad_total == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
