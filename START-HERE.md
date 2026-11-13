# 在 Mac 上继续开发 QuantLab

这个包里已经是**完整可运行**的状态：代码、自选股数据、39+1 个流派、四个回测脚本、以及一份从今天起的 git 历史（带基线 tag）。不需要再回顾任何东西，解压就能跑。

---

## 1. 环境要求

| 需要 | 版本 | 怎么查 |
|---|---|---|
| Node.js | ≥ 18（20 LTS 更稳） | `node -v` |
| npm | 随 Node 自带 | `npm -v` |
| Python 3 + numpy | 只有跑回测才需要 | `python3 -c "import numpy"` |

没装 Node 的话：`brew install node`，或者去 nodejs.org 下 pkg 安装包。

## 2. 跑起来

```bash
cd ~/Projects/quantlab          # 解压后的目录
npm install                     # 只有 express 一个依赖，几秒钟
npm start                       # → http://localhost:3000
```

浏览器打开 <http://localhost:3000> 即可。改前端代码（`public/` 下）存盘刷新就生效，不用重启；改后端（`server.js`、`lib/`）需要 Ctrl+C 再 `npm start`。

端口被占用时：`PORT=3100 npm start`。

## 3. 目录怎么分工

```
server.js              Express 入口：/api/stock /api/quote /api/screen /api/watchlist
lib/sources.js         数据源适配（同花顺 → 新浪 → 腾讯 → 东财），含重试与编码处理
lib/quote.js           行情快照、全市场列表、搜索
lib/scan.js            全池扫描与精算
lib/store.js           自选股持久化（写 data/store.json）
public/js/indicators.js   指标库，纯函数，可直接 node 里 require
public/js/strategies.js   40 个流派的规则与评分
public/js/app.js          图表渲染与交互
public/js/screen.js       选股页逻辑
data/store.json        ← 你的自选股，8 条，别误删
tools/backtest*.py        回测脚本，直接 python3 跑，不需要起服务
```

## 4. 和线上那个链接的关系（重要）

线上 `https://a750589e680620c8e.app.workbuddy.host` 是从**沙箱**发布的一份快照，它读的是沙箱里的文件，不读你 Mac 上的文件。

所以：本地改完，线上不会自动变。两条路：

- **只是自己用** → 就本地 `localhost:3000`，够用，数据也是实时的。
- **需要给别人看** → 在 WorkBuddy 里让我重新发布一次；或者临时开个隧道：
  ```bash
  npx localtunnel --port 3000
  ```

## 5. 改坏了怎么退回去

已经给你把 git 建好了，基线是 `v1.0-40strategy`（就是现在这个能跑、验证过的版本）：

```bash
git status                       # 先看改了什么
git diff                         # 看具体差异
git checkout -- public/js/app.js # 撤掉单个文件的改动
git reset --hard v1.0-40strategy # 整个项目退回基线
```

每次动手前先 `git commit -am "改之前"`，出问题就有精确的落点，不用靠记忆回滚。

## 6. 数据源

四个源全是普通 HTTPS（同花顺 `d.10jqka.com.cn`、新浪 `quotes.sina.cn`、腾讯 `qt.gtimg.cn`、东财 `push2his.eastmoney.com`），带自定义 UA 和 Referer，macOS 直连即可。

如果某天取不到数据，先访问 <http://localhost:3000/api/sources> 看是哪个源挂了；公司网络带代理时，给 Node 设 `HTTPS_PROXY` 环境变量。

## 7. 回测

```bash
python3 tools/backtest-threelock.py --n 300    # 三把锁，约 20 分钟
python3 tools/backtest-tritf.py                # 三周期共振
python3 tools/backtest.py                      # SuperTrend / 三灯
python3 tools/verify-tdx.py                    # 与通达信独立通道对账（需 tdxrs）
```

首次跑会拉全量日线并缓存到 `/tmp`，第二次起是秒级。`--probe` 只统计信号频次，不做收益计算。
