"""Sinh bộ request dùng chung cho cả 4 thuật toán."""

import random

from backend.config import DEFAULT_PARAMS


def generate_requests(params):
    """Sinh danh sách request theo params, dùng random.Random(seed) riêng.

    Mỗi request rút đủ 5 số ngẫu nhiên theo thứ tự cố định
    (khoảng cách đến, sticky?, client, nặng?, thời gian xử lý).
    Nhờ vậy khi đổi % sticky thì thời điểm đến và loại request vẫn y hệt,
    chỉ IP thay đổi -> so sánh có/không sticky công bằng.
    """
    rng = random.Random(params["seed"])
    rate_per_ms = params["arrival_rate"] / 1000.0
    requests = []
    t = 0.0
    for i in range(params["num_requests"]):
        # Poisson process: khoảng cách giữa 2 request theo phân phối mũ
        t += rng.expovariate(rate_per_ms)
        u_sticky = rng.random()
        client_no = rng.randint(1, params["num_clients"])
        u_heavy = rng.random()
        u_service = rng.random()

        if u_sticky < params["sticky_percent"] / 100.0:
            ip = params["sticky_ip"]
        else:
            ip = "192.168.1.%d" % client_no

        if u_heavy < params["heavy_percent"] / 100.0:
            kind = "heavy"
            lo, hi = params["heavy_min"], params["heavy_max"]
        else:
            kind = "light"
            lo, hi = params["light_min"], params["light_max"]
        service = lo + (hi - lo) * u_service  # phân phối đều [lo, hi]

        requests.append({
            "id": i,
            "arrival_time": round(t, 3),
            "client_ip": ip,
            "kind": kind,
            "base_service_time": round(service, 3),
        })
    return requests


def describe(requests, params):
    """Thống kê nhanh bộ request để kiểm tra."""
    n = len(requests)
    heavy = sum(1 for r in requests if r["kind"] == "heavy")
    sticky = sum(1 for r in requests if r["client_ip"] == params["sticky_ip"])
    duration = requests[-1]["arrival_time"] if requests else 0
    total_work = sum(r["base_service_time"] for r in requests)
    return {
        "count": n,
        "heavy_pct": 100.0 * heavy / n,
        "sticky_pct": 100.0 * sticky / n,
        "duration_ms": duration,
        "real_rate": 1000.0 * n / duration if duration else 0,
        "mean_service": total_work / n,
        "distinct_ips": len(set(r["client_ip"] for r in requests)),
    }


if __name__ == "__main__":
    reqs = generate_requests(DEFAULT_PARAMS)
    s = describe(reqs, DEFAULT_PARAMS)
    print("Số request         : %d" % s["count"])
    print("Tỷ lệ nặng         : %.1f%% (đề: %s%%)" % (s["heavy_pct"], DEFAULT_PARAMS["heavy_percent"]))
    print("Tỷ lệ sticky client: %.1f%% (đề: %s%%)" % (s["sticky_pct"], DEFAULT_PARAMS["sticky_percent"]))
    print("Khoảng thời gian   : %.1f ms" % s["duration_ms"])
    print("Tốc độ đến thực tế : %.1f req/s (đề: %s)" % (s["real_rate"], DEFAULT_PARAMS["arrival_rate"]))
    print("Thời gian xử lý TB : %.2f ms (gốc, chưa nhân hệ số chậm)" % s["mean_service"])
    print("Số IP khác nhau    : %d" % s["distinct_ips"])
    print("5 request đầu:")
    for r in reqs[:5]:
        print("  ", r)
