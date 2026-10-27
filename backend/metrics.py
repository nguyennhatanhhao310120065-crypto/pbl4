"""Tính số liệu so sánh cho 1 lần chạy mô phỏng."""

import statistics


def percentile(values, p):
    """Percentile kiểu nội suy tuyến tính (giống numpy mặc định)."""
    if not values:
        return 0.0
    data = sorted(values)
    if len(data) == 1:
        return data[0]
    pos = (len(data) - 1) * p / 100.0
    lo = int(pos)
    hi = min(lo + 1, len(data) - 1)
    return data[lo] + (data[hi] - data[lo]) * (pos - lo)


def count_overloads(events, num_servers, threshold):
    """Đếm số lần kết nối mở VƯỢT LÊN ngưỡng (chuyển từ < ngưỡng sang >= ngưỡng).

    Không đếm mỗi sự kiện khi đang ở trên ngưỡng, vì như vậy 1 đợt quá tải
    dài sẽ bị đếm thành nhiều lần.
    """
    counts = [0] * num_servers
    prev = [0] * num_servers
    for e in events:
        s = e["server"]
        cur = e["open_connections_after"]
        if prev[s] < threshold <= cur:
            counts[s] += 1
        prev[s] = cur
    return counts


def overload_time(events, num_servers, threshold):
    """Tổng thời gian (ms) mỗi server nằm ở trạng thái >= ngưỡng.

    Bổ sung cho count_overloads: 1 server quá tải liên tục chỉ "vượt ngưỡng"
    1 lần nhưng thời gian quá tải rất dài.
    """
    total = [0.0] * num_servers
    since = [None] * num_servers  # thời điểm bắt đầu đợt quá tải hiện tại
    for e in events:
        s = e["server"]
        over = e["open_connections_after"] >= threshold
        if over and since[s] is None:
            since[s] = e["t"]
        elif not over and since[s] is not None:
            total[s] += e["t"] - since[s]
            since[s] = None
    return total


def compute_metrics(requests, assignments, events, params):
    n_srv = params["num_servers"]
    total = len(assignments)

    makespan = max(a["finish"] for a in assignments) if assignments else 0.0
    req_count = [0] * n_srv
    busy = [0.0] * n_srv
    for a in assignments:
        req_count[a["server"]] += 1
        busy[a["server"]] += a["service_time"]
    total_busy = sum(busy) or 1.0

    waits = [a["wait"] for a in assignments]
    responses = [a["response"] for a in assignments]

    # Phân bố request của sticky client lên các server
    sticky_ids = set(r["id"] for r in requests if r["client_ip"] == params["sticky_ip"])
    sticky_dist = [0] * n_srv
    for a in assignments:
        if a["request_id"] in sticky_ids:
            sticky_dist[a["server"]] += 1

    # Số kết nối mở lớn nhất từng thấy trên mỗi server
    max_open = [0] * n_srv
    for e in events:
        max_open[e["server"]] = max(max_open[e["server"]], e["open_connections_after"])

    overloads = count_overloads(events, n_srv, params["overload_threshold"])
    over_time = overload_time(events, n_srv, params["overload_threshold"])

    return {
        "makespan": round(makespan, 3),
        "request_count": req_count,
        "request_pct": [round(100.0 * c / total, 2) for c in req_count],
        "busy_time": [round(b, 3) for b in busy],
        "busy_pct": [round(100.0 * b / total_busy, 2) for b in busy],
        "utilization": [round(b / makespan, 4) if makespan else 0 for b in busy],
        "avg_wait": round(statistics.mean(waits), 3) if waits else 0,
        "avg_response": round(statistics.mean(responses), 3) if responses else 0,
        "p95_response": round(percentile(responses, 95), 3),
        "max_response": round(max(responses), 3) if responses else 0,
        "overload_count": overloads,
        "overload_total": sum(overloads),
        "overload_time": [round(x, 1) for x in over_time],
        "max_open": max_open,
        "sticky_total": len(sticky_ids),
        "sticky_distribution": sticky_dist,
    }
