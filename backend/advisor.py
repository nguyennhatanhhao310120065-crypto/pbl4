"""Đề xuất thuật toán dựa trên traffic thật.

Load Balancer ghi lại các request thật trong WINDOW giây gần nhất (thời điểm đến, IP,
thời gian xử lý gốc). Hàm analyze() mô phỏng cả 4 thuật toán trên ĐÚNG chuỗi request đó
rồi xếp hạng: nếu thuật toán đang dùng kém hơn rõ rệt thì đề xuất chuyển.

Chạy trong tiến trình riêng (ProcessPoolExecutor) để phần mô phỏng không tranh CPU với LB.
"""

import copy
import statistics
from collections import Counter

from backend.algorithms import ALGORITHMS, ip_to_server
from backend.config import DEFAULT_PARAMS, cluster_params, slow_factors
from backend.simulator import run_all

WINDOW = 20.0          # chưa bấm "Bắt đầu gửi" lần nào: mô phỏng trên traffic 20 giây gần nhất
MAX_TRACE = 20000      # tối đa số request giữ lại (= số request lớn nhất của 1 lượt gửi; 10.000 request mô phỏng < 0,5 s)
MIN_REQUESTS = 20      # ít hơn thì chưa đủ dữ liệu để đánh giá
# Chỉ đề xuất khi thuật toán tốt nhất giảm chờ TB ít nhất 30% và ít nhất 5 ms (tránh đổi qua lại vì chênh lệch nhỏ)
MIN_GAIN_RATIO = 0.30
MIN_GAIN_MS = 5.0

ALGO_NAMES = {c.key: c.name for c in ALGORITHMS}


def build_requests(trace):
    """trace: list {t (giây), ip, base (ms hoặc None), kind} -> danh sách request giống generator.

    Request chưa biết thời gian xử lý (chưa xong, không có header X-Work-Ms) lấy trung bình các request đã biết.
    """
    known = [r["base"] for r in trace if r["base"] is not None]
    fallback = statistics.mean(known) if known else 0.0
    t0 = trace[0]["t"]
    return [{
        "id": i,
        "arrival_time": round((r["t"] - t0) * 1000.0, 3),
        "client_ip": r["ip"],
        "kind": r["kind"],
        "base_service_time": round(r["base"] if r["base"] is not None else fallback, 3),
    } for i, r in enumerate(trace)]


def make_params(requests, factors=None):
    """factors: hệ số chậm của các server đang bật (cụm thật hiện tại). None = cụm mặc định trong config."""
    params = dict(DEFAULT_PARAMS, **cluster_params())
    if factors:
        slow = [f for f in factors if f != 1]
        params.update(num_servers=len(factors), factors=list(factors), num_slow_servers=len(slow),
                      slow_factor=slow[0] if slow else 1)
    params["num_requests"] = len(requests)
    # "Sticky client" của traffic thật = IP gửi nhiều request nhất
    ips = Counter(r["client_ip"] for r in requests)
    params["sticky_ip"] = ips.most_common(1)[0][0] if ips else DEFAULT_PARAMS["sticky_ip"]
    return params


def rank(results):
    def key(k):
        m = results[k]["metrics"]
        return (m["avg_wait"], m["makespan"], m["overload_total"])
    return sorted(results, key=key)


def analyze(trace, current, real, factors=None, names=None):
    """Mô phỏng 4 thuật toán trên trace, trả bảng so sánh + đề xuất.

    real: số liệu đo thật trong cửa sổ (để hiển thị cạnh số mô phỏng).
    factors / names: hệ số chậm và tên các server đang bật (mô phỏng theo đúng cụm hiện tại).
    """
    requests = build_requests(trace)
    params = make_params(requests, factors)
    names = names or ["s%d" % i for i in range(params["num_servers"])]
    _, results = run_all(params, requests)
    order = rank(results)
    best = order[0]
    cur = results[current]["metrics"]
    top = results[best]["metrics"]
    gain = cur["avg_wait"] - top["avg_wait"]
    suggest = (best != current and gain >= MIN_GAIN_MS and gain >= MIN_GAIN_RATIO * cur["avg_wait"])

    slow = [i for i, f in enumerate(slow_factors(params)) if f != 1]
    rows = []
    for k in order:
        m = results[k]["metrics"]
        rows.append({
            "key": k,
            "name": ALGO_NAMES[k],
            "avg_wait": m["avg_wait"],
            "p95_response": m["p95_response"],
            "makespan": m["makespan"],
            "max_open": max(m["max_open"]),
            "overload_total": m["overload_total"],
            "slow_pct": round(sum(m["request_pct"][i] for i in slow), 2),
            "request_pct": m["request_pct"],
        })
    return {
        "count": len(requests),
        "duration_ms": requests[-1]["arrival_time"],
        "current": current,
        "best": best,
        "suggest": suggest,
        "gain_ms": round(gain, 1),
        "gain_pct": round(100.0 * gain / cur["avg_wait"], 1) if cur["avg_wait"] else 0.0,
        "rows": rows,
        "real": real,
        "slow_servers": [names[i] for i in slow],
        "server_names": list(names),
    }


def snapshot(trace, factors=None):
    """Dữ liệu đầy đủ cho phần phân tích chi tiết: cùng định dạng với /api/simulate
    (phát lại 4 khung, biểu đồ, nhận xét) + so sánh có / không sticky client."""
    requests = build_requests(trace)
    params = make_params(requests, factors)
    _, results = run_all(params, requests)

    # "Không sticky": chia request của sticky IP lần lượt cho các IP khác có trong traffic
    others = sorted(set(r["client_ip"] for r in requests) - {params["sticky_ip"]}) or ["192.168.1.1"]
    no_sticky = copy.deepcopy(requests)
    k = 0
    for r in no_sticky:
        if r["client_ip"] == params["sticky_ip"]:
            r["client_ip"] = others[k % len(others)]
            k += 1
    _, results_ns = run_all(params, no_sticky)

    return {
        "params": params,
        "requests": requests,
        "sticky_server": ip_to_server(params["sticky_ip"], params["num_servers"]),
        "algorithms": [{"key": c.key, "name": c.name} for c in ALGORITHMS],
        "results": results,
        "sticky": {
            "params": dict(params, sticky_percent=round(100.0 * k / len(requests), 1)),
            "results": {
                "without": {key: res["metrics"] for key, res in results_ns.items()},
                "with": {key: res["metrics"] for key, res in results.items()},
            },
        },
    }
