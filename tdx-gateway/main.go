// tdx-gateway · 通达信行情网关
//
// 为什么要有这一层：`github.com/injoyai/tdx` 是 Go 库，本项目是 Node。
// 两个选择——每次请求 spawn 一个 Go 进程（启动开销大、每次重连 TCP），
// 或者常驻一个 HTTP 网关复用 TCP 长连接。选后者：414 个板块指数串行拉一遍
// 只要 20 秒，每个请求都重连的话光握手就要几分钟。
//
// 设计约束：
//  1. 单连接 + 互斥锁：通达信协议不是并发安全的，串行是正确性优先的选择
//  2. 多 host 故障转移：实测 124.71.187.122 偶尔超时，必须能自动换
//  3. 端点只暴露本项目真正需要的，不做通用 SDK 封装
//  4. K 线统一输出 [date, open, close, high, low, volume, amount]，
//     与 lib/sources.js 的既有格式完全一致（不引入第二套口径）
//  5. `until` 参数必须生效：网络源默认返回「最新 N 根」，回补历史日时
//     不截断就会把未来数据算进历史（前视偏差）
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/injoyai/tdx/v2"
	"github.com/injoyai/tdx/v2/protocol"
)

var (
	defaultHosts = []string{
		"124.71.187.122:7709", "101.42.240.54:7709", "101.43.159.194:7709",
		"120.53.8.251:7709", "152.136.191.169:7709", "49.232.15.141:7709",
		"82.156.174.84:7709", "119.97.185.59:7709", "81.70.151.186:7709",
	}
)

// conn 是全局唯一的通达信连接。所有查询串行通过 mu。
type conn struct {
	mu     sync.Mutex
	c      tdx.Client
	addr   string
	connAt time.Time
}

var C = &conn{}

func (x *conn) dialLocked() error {
	var lastErr error
	for _, h := range defaultHosts {
		c, err := tdx.DialHosts([]string{h}, tdx.WithRedial(false))
		if err == nil {
			x.c = c
			x.addr = h
			x.connAt = time.Now()
			log.Printf("已连接 %s", h)
			return nil
		}
		lastErr = err
	}
	return lastErr
}

// with 在锁内执行查询；连接失效时重连一次再试。
func (x *conn) with(fn func(tdx.Client) error) error {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.c == nil {
		if err := x.dialLocked(); err != nil {
			return fmt.Errorf("通达信服务器全部不可用：%w", err)
		}
	}
	err := fn(x.c)
	if err == nil {
		return nil
	}
	// 只有连接类错误才重连；业务错误（代码不存在等）重试也没用
	if !isConnErr(err) {
		return err
	}
	if x.c != nil {
		x.c.Close()
	}
	x.c = nil
	if e2 := x.dialLocked(); e2 != nil {
		return fmt.Errorf("重连失败：%w（原错误：%v）", e2, err)
	}
	return fn(x.c)
}

func isConnErr(err error) bool {
	s := strings.ToLower(err.Error())
	for _, k := range []string{"timeout", "eof", "closed", "refused", "reset", "broken", "connection"} {
		if strings.Contains(s, k) {
			return true
		}
	}
	return false
}

/* ---------------- HTTP ---------------- */

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func ok(w http.ResponseWriter, data interface{}) {
	writeJSON(w, 200, map[string]interface{}{"ok": true, "data": data})
}
func fail(w http.ResponseWriter, err error) {
	log.Printf("请求失败: %v", err)
	writeJSON(w, 502, map[string]interface{}{"ok": false, "error": err.Error()})
}

func main() {
	port := flag.Int("port", 7710, "监听端口")
	flag.Parse()

	mux := http.NewServeMux()

	// 健康检查：真连一次，不做假存活
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		t0 := time.Now()
		var q []tdx.Quote
		err := C.with(func(c tdx.Client) error {
			var e error
			q, e = c.GetQuote("sh000001")
			return e
		})
		if err != nil {
			writeJSON(w, 503, map[string]interface{}{
				"ok": false, "error": err.Error(), "ms": time.Since(t0).Milliseconds(),
			})
			return
		}
		px := 0.0
		if len(q) > 0 {
			px = q[0].Price
		}
		ok(w, map[string]interface{}{
			"server": C.addr, "connectedAt": C.connAt.Format(time.RFC3339),
			"index": px, "ms": time.Since(t0).Milliseconds(),
		})
	})

	// 日线：个股 / 指数 / 板块指数（880xxx）统一入口
	// GET /kline?code=sh600000&count=250&until=2026-11-18
	mux.HandleFunc("/kline", func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		if code == "" {
			writeJSON(w, 400, map[string]interface{}{"ok": false, "error": "code 必填"})
			return
		}
		count, _ := strconv.Atoi(r.URL.Query().Get("count"))
		if count <= 0 || count > 2000 {
			count = 250
		}
		until := strings.TrimSpace(r.URL.Query().Get("until"))

		var rows [][]interface{}
		var lastDate string
		var up, down int
		t0 := time.Now()
		err := C.with(func(c tdx.Client) error {
			// 多取一些，保证截断后仍够 count 根
			resp, err := c.GetKlineDay(code, 0, uint16(count+60))
			if err != nil {
				return err
			}
			ks, err := resp.Klines()
			if err != nil {
				return err
			}
			for _, k := range ks {
				d := k.Time.Format("2006-01-02")
				if until != "" && d > until {
					continue // 前视偏差防护：绝不给调用方「未来」的 K 线
				}
				// 与 lib/sources.js 同一格式：[日期, 开, 收, 高, 低, 量(手), 额(元)]
				rows = append(rows, []interface{}{
					d, k.Open, k.Close, k.High, k.Low, float64(k.Volume), k.Amount,
				})
				lastDate = d
				up, down = k.UpCount, k.DownCount
			}
			if len(rows) > count {
				rows = rows[len(rows)-count:]
			}
			return nil
		})
		if err != nil {
			fail(w, err)
			return
		}
		if len(rows) == 0 {
			writeJSON(w, 404, map[string]interface{}{
				"ok": false, "error": "没有数据（代码可能有误或该日之前无行情）",
			})
			return
		}
		ok(w, map[string]interface{}{
			"code": code, "rows": rows, "asOf": lastDate,
			"upCount": up, "downCount": down, // 指数/板块指数有效，个股为 0
			"source": "tdx", "level": "B", "ms": time.Since(t0).Milliseconds(),
		})
	})

	// 实时五档报价（批量）
	// GET /quote?codes=sh600000,sz000001
	mux.HandleFunc("/quote", func(w http.ResponseWriter, r *http.Request) {
		raw := r.URL.Query().Get("codes")
		codes := []string{}
		for _, s := range strings.Split(raw, ",") {
			if s = strings.TrimSpace(s); s != "" {
				codes = append(codes, s)
			}
		}
		if len(codes) == 0 {
			writeJSON(w, 400, map[string]interface{}{"ok": false, "error": "codes 必填"})
			return
		}
		if len(codes) > 800 {
			codes = codes[:800]
		}
		var qs []tdx.Quote
		t0 := time.Now()
		err := C.with(func(c tdx.Client) error {
			// 单次协议上限 80 只（超了库会报「预期N个，实际80个」）
			for i := 0; i < len(codes); i += 80 {
				j := i + 80
				if j > len(codes) {
					j = len(codes)
				}
				part, err := c.GetQuote(codes[i:j]...)
				if err != nil {
					return err
				}
				qs = append(qs, part...)
			}
			return nil
		})
		if err != nil {
			fail(w, err)
			return
		}
		out := make([]map[string]interface{}, 0, len(qs))
		for _, q := range qs {
			in := q.Instrument
			// Instrument.Code 不含前缀，市场在 Exchange 里；
			// 必须拼回 sh600000——000001 在沪深两市都有，只传 6 位会张冠李戴
			code := exPrefix(in.Exchange) + in.Code
			out = append(out, map[string]interface{}{
				"code": code, "price": q.Price, "preClose": q.PreClose,
				"open": q.Open, "high": q.High, "low": q.Low, "volume": q.Volume,
			})
		}
		ok(w, map[string]interface{}{
			"list": out, "count": len(out), "source": "tdx", "ms": time.Since(t0).Milliseconds(),
		})
	})

	// 板块：名称 → 指数代码映射 + 三套成分（概念/地域/指数）
	// GET /blocks
	mux.HandleFunc("/blocks", func(w http.ResponseWriter, r *http.Request) {
		t0 := time.Now()
		var im []map[string]interface{}
		blocks := map[string][]map[string]interface{}{}
		err := C.with(func(c tdx.Client) error {
			zs, err := c.GetTdxZs()
			if err != nil {
				return err
			}
			for _, z := range zs {
				im = append(im, map[string]interface{}{
					"name": z.Name, "code": z.Code, "type": z.Type,
				})
			}
			for name, f := range map[string]string{
				"gn": protocol.BlockFileGN, "fg": protocol.BlockFileFG, "zs": protocol.BlockFileZS,
			} {
				bs, err := c.GetBlockDataWithIndex(f)
				if err != nil {
					// 单个成分文件失败不该让整包失败，标在结果里
					blocks[name+"_error"] = []map[string]interface{}{{"error": err.Error()}}
					continue
				}
				l := make([]map[string]interface{}, 0, len(bs))
				for _, b := range bs {
					l = append(l, map[string]interface{}{
						"name": b.Name, "code": b.Index, "type": b.Type,
						"codes": b.Codes,
					})
				}
				blocks[name] = l
			}
			return nil
		})
		if err != nil {
			fail(w, err)
			return
		}
		ok(w, map[string]interface{}{
			"indexMap": im, "blocks": blocks, "source": "tdx", "ms": time.Since(t0).Milliseconds(),
		})
	})

	// 全市场快照：一次请求拿完，内部做「代码列表（带缓存）→ 分批报价 → 组装」
	// GET /snapshot
	//
	// 为什么单独做一个端点而不是让 Node 自己拼 /codes + /quote：
	// 代码列表要 3 次 GetCodeAll（约 5.5 秒），每天只变一次，缓存在网关里最省；
	// 而且是 5.3 万个品种，过滤成 A 股 5500 只之后再传给 Node，省掉 90% 的搬运。
	mux.HandleFunc("/snapshot", func(w http.ResponseWriter, r *http.Request) {
		t0 := time.Now()
		type row struct {
			Code     string  `json:"code"`
			Price    float64 `json:"price"`
			PreClose float64 `json:"preClose"`
			Open     float64 `json:"open"`
			High     float64 `json:"high"`
			Low      float64 `json:"low"`
			Volume   int64   `json:"volume"`
			Amount   float64 `json:"amount"`
		}
		var out []row
		var codesN int
		err := C.with(func(c tdx.Client) error {
			codes := aShareCodes(c)
			codesN = len(codes)
			// 单批 80：这是通达信协议的单次报价上限，超了库直接报
			// 「预期500个，实际80个」。5583 只 = 70 批，约 3 秒
			const batch = 80
			for i := 0; i < len(codes); i += batch {
				j := i + batch
				if j > len(codes) {
					j = len(codes)
				}
				qs, err := c.GetQuote(codes[i:j]...)
				if err != nil {
					// 某一批失败不该丢掉整份快照，记录后继续
					log.Printf("快照批次 %d-%d 失败: %v", i, j, err)
					continue
				}
				for _, q := range qs {
					mk := exPrefix(q.Instrument.Exchange)
					if mk == "" {
						continue // 市场不认识就不猜，免得把 000001 张冠李戴
					}
					rr := row{
						Code: mk + q.Instrument.Code,
						Price: q.Price, PreClose: q.PreClose,
						Open: q.Open, High: q.High, Low: q.Low, Volume: q.Volume,
					}
					// 成交额只在内嵌 K 线里
					if q.Standard != nil && q.Standard.Kline != nil {
						rr.Amount = q.Standard.Kline.Amount
					}
					out = append(out, rr)
				}
			}
			return nil
		})
		if err != nil {
			fail(w, err)
			return
		}
		if len(out) == 0 {
			writeJSON(w, 503, map[string]interface{}{"ok": false, "error": "全市场快照为空"})
			return
		}
		ok(w, map[string]interface{}{
			"list": out, "count": len(out), "aShareCodes": codesN,
			"source": "tdx", "ms": time.Since(t0).Milliseconds(),
		})
	})

	// 个股统计：PE/股息/连涨跌/区间涨幅（含资金流字段）
	// GET /stat
	mux.HandleFunc("/stat", func(w http.ResponseWriter, r *http.Request) {
		t0 := time.Now()
		var out []map[string]interface{}
		err := C.with(func(c tdx.Client) error {
			st, err := c.GetTdxStat()
			if err != nil {
				return err
			}
			out = make([]map[string]interface{}, 0, len(st))
			for _, s := range st {
				out = append(out, map[string]interface{}{
					"code": s.Code, "peTTM": s.PETTM, "peStatic": s.PEStatic,
					"divYield": s.DivYield, "trendDays": s.TrendDays,
					"chg5": s.Chg5, "chg10": s.Chg10, "chg20": s.Chg20,
					"chg60": s.Chg60, "chgYTD": s.ChgYTD,
				})
			}
			return nil
		})
		if err != nil {
			fail(w, err)
			return
		}
		ok(w, map[string]interface{}{
			"list": out, "count": len(out), "source": "tdx", "ms": time.Since(t0).Milliseconds(),
		})
	})

	// 行业归属（通达信行业 T + 申万行业 X）
	// GET /hy
	mux.HandleFunc("/hy", func(w http.ResponseWriter, r *http.Request) {
		t0 := time.Now()
		var out []map[string]interface{}
		err := C.with(func(c tdx.Client) error {
			hy, err := c.GetTdxHy()
			if err != nil {
				return err
			}
			out = make([]map[string]interface{}, 0, len(hy))
			for _, v := range hy {
				out = append(out, map[string]interface{}{
					"code": v.Code, "tdxHy": v.TdxHy, "swHy": v.SwHy,
				})
			}
			return nil
		})
		if err != nil {
			fail(w, err)
			return
		}
		ok(w, map[string]interface{}{
			"list": out, "count": len(out), "source": "tdx", "ms": time.Since(t0).Milliseconds(),
		})
	})

	srv := &http.Server{
		Addr:              fmt.Sprintf(":%d", *port),
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// 启动时先连一次，好在日志里立刻看到成功或失败（但不阻断启动）
	go func() {
		if err := C.with(func(c tdx.Client) error { return nil }); err != nil {
			log.Printf("⚠ 启动时连接失败（后续请求会自动重试）：%v", err)
		}
	}()

	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		log.Println("收到退出信号，关闭连接")
		C.mu.Lock()
		if C.c != nil {
			C.c.Close()
		}
		C.mu.Unlock()
		os.Exit(0)
	}()

	log.Printf("tdx-gateway 监听 :%d", *port)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("服务退出：%v", err)
	}
}

/* ---------------- A 股代码列表（带缓存） ----------------
 *
 * GetCodeAll 返回的是「该市场全部品种」：sh 27894 条里绝大多数是指数、基金、
 * 债券、权证和 999999 这类占位符，真正的 A 股只有 2000 多只。
 * 5.3 万条全传给 Node 再过滤纯属浪费带宽，所以在网关侧就筛掉。
 *
 * 缓存 1 小时：新股上市会让列表变，但一天最多几次，没必要每次快照都拉 5.5 秒。
 */

var codeCache struct {
	mu   sync.Mutex
	at   time.Time
	list []string
}

// isAShare 按号段判断是否 A 股个股（与 lib/snapshot.js 的 A_SHARE_WHERE 同一口径）
func isAShare(market, code string) bool {
	switch market {
	case "sh":
		return strings.HasPrefix(code, "600") || strings.HasPrefix(code, "601") ||
			strings.HasPrefix(code, "603") || strings.HasPrefix(code, "605") ||
			strings.HasPrefix(code, "688") || strings.HasPrefix(code, "689")
	case "sz":
		return strings.HasPrefix(code, "000") || strings.HasPrefix(code, "001") ||
			strings.HasPrefix(code, "002") || strings.HasPrefix(code, "003") ||
			strings.HasPrefix(code, "300") || strings.HasPrefix(code, "301") ||
			strings.HasPrefix(code, "302")
	case "bj":
		return strings.HasPrefix(code, "4") || strings.HasPrefix(code, "8") ||
			strings.HasPrefix(code, "92")
	}
	return false
}

func aShareCodes(c tdx.Client) []string {
	codeCache.mu.Lock()
	defer codeCache.mu.Unlock()
	if len(codeCache.list) > 0 && time.Since(codeCache.at) < time.Hour {
		return codeCache.list
	}
	list := []string{}
	for _, m := range []struct {
		name string
		ex   protocol.Exchange
	}{
		{"sh", protocol.ExchangeSH},
		{"sz", protocol.ExchangeSZ},
		{"bj", protocol.ExchangeBJ},
	} {
		r, err := c.GetCodeAll(m.ex)
		if err != nil {
			// 单个市场失败不该让整个快照失败，另外两个市场照常返回
			log.Printf("GetCodeAll(%s) 失败: %v", m.name, err)
			continue
		}
		for _, it := range r.List {
			// Instrument.Code 是纯 6 位（实测 sh 市场返回 "600000"，不带前缀），
			// 所以市场用外层循环的 m.name 补，不能指望从 Code 里切
			six := strings.ReplaceAll(strings.TrimSpace(it.Instrument.Code), ".", "")
			if len(six) > 6 {
				six = six[len(six)-6:]
			}
			if len(six) != 6 {
				continue
			}
			if isAShare(m.name, six) {
				list = append(list, m.name+six)
			}
		}
	}
	if len(list) > 0 {
		codeCache.at = time.Now()
		codeCache.list = list
		log.Printf("A 股代码列表已刷新：%d 只", len(list))
	}
	return list
}

// exPrefix 协议市场编号 → 本项目用的市场前缀
func exPrefix(e protocol.Exchange) string {
	switch e {
	case protocol.ExchangeSH:
		return "sh"
	case protocol.ExchangeSZ:
		return "sz"
	case protocol.ExchangeBJ:
		return "bj"
	}
	return ""
}
