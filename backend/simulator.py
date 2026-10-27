"""Engine mô phỏng sự kiện rời rạc (Discrete-Event Simulation).

Thay vì chạy theo từng bước thời gian cố định, ta nhảy thẳng tới sự kiện
kế tiếp trong hàng đợi ưu tiên (heapq). Chỉ có 2 loại sự kiện:
  - ARRIVAL: request đến load balancer -> chọn server -> vào hàng đợi server
  - FINISH : server xử lý xong 1 request -> lấy request tiếp theo trong hàng FIFO
"""

import copy
import heapq
from collections import deque

from backend.algorithms import ALGORITHMS, make_algorithm
from backend.config import DEFAULT_PARAMS, slow_factors
from backend.generator import generate_requests
from backend.metrics import compute_metrics

ARRIVAL = "ARRIVAL"
FINISH = "FINISH"

# Cùng thời điểm thì xử lý FINISH trước ARRIVAL: server vừa xong việc
# được tính là đã giảm kết nối trước khi load balancer ra quyết định mới.
PRIORITY = {FINISH: 0, ARRIVAL: 1}

RECENT_WINDOW = 10  # LRT lấy trung bình 10 request hoàn thành gần nhất


class Server:
    """Server ảo: 1 worker, hàng đợi FIFO."""

    def __init__(self, index, slow_factor):
        self.index = index
        self.slow_factor = slow_factor
        self.current = None          # request đang xử lý
        self.queue = deque()         # request đang chờ
        self.recent_rt = deque(maxlen=RECENT_WINDOW)

    @property
    def open_connections(self):
        # Kết nối mở = đang xử lý + đang chờ
        return (1 if self.current is not None else 0) + len(self.queue)

    def avg_recent_rt(self, default):
        if not self.recent_rt:
            return default
        return sum(self.recent_rt) / len(self.recent_rt)


def simulate(requests, algorithm, params):
    """Chạy 1 thuật toán trên bộ request. Trả về assignments, events, metrics."""
    factors = slow_factors(params)
    servers = [Server(i, f) for i, f in enumerate(factors)]

    heap = []
    seq = 0  # số thứ tự để heap không phải so sánh dict khi trùng (t, priority)

    def push(t, kind, req_id, server_idx):
        nonlocal seq
        heapq.heappush(heap, (t, PRIORITY[kind], seq, kind, req_id, server_idx))
        seq += 1

    by_id = {r["id"]: r for r in requests}
    assignments = {}
    events = []

    def start_next(server, now):
        """Nếu server rảnh và có request chờ thì bắt đầu xử lý."""
        if server.current is None and server.queue:
            req_id = server.queue.popleft()
            server.current = req_id
            a = assignments[req_id]
            a["start"] = now
            a["service_time"] = by_id[req_id]["base_service_time"] * server.slow_factor
            push(now + a["service_time"], FINISH, req_id, server.index)

    for r in requests:
        push(r["arrival_time"], ARRIVAL, r["id"], None)

    while heap:
        now, _, _, kind, req_id, server_idx = heapq.heappop(heap)

        if kind == ARRIVAL:
            req = by_id[req_id]
            idx = algorithm.choose(req, servers, now)
            server = servers[idx]
            assignments[req_id] = {"server": idx, "arrival": now}
            server.queue.append(req_id)
            start_next(server, now)
            events.append({
                "t": round(now, 3), "type": ARRIVAL, "request_id": req_id,
                "server": idx, "open_connections_after": server.open_connections,
            })
        else:  # FINISH
            server = servers[server_idx]
            a = assignments[req_id]
            a["finish"] = now
            a["wait"] = a["start"] - a["arrival"]
            a["response"] = now - a["arrival"]
            server.recent_rt.append(a["response"])
            server.current = None
            start_next(server, now)
            events.append({
                "t": round(now, 3), "type": FINISH, "request_id": req_id,
                "server": server_idx, "open_connections_after": server.open_connections,
            })

    # Đổi assignments sang list theo thứ tự id, làm tròn cho JSON gọn
    assign_list = []
    for r in requests:
        a = assignments[r["id"]]
        assign_list.append({
            "request_id": r["id"],
            "server": a["server"],
            "arrival": round(a["arrival"], 3),
            "start": round(a["start"], 3),
            "finish": round(a["finish"], 3),
            "service_time": round(a["service_time"], 3),
            "wait": round(a["wait"], 3),
            "response": round(a["response"], 3),
        })

    metrics = compute_metrics(requests, assign_list, events, params)
    return {"assignments": assign_list, "events": events, "metrics": metrics}


def run_all(params, requests=None):
    """Chạy cả 4 thuật toán trên CÙNG 1 bộ request (mỗi thuật toán 1 bản copy)."""
    if requests is None:
        requests = generate_requests(params)
    results = {}
    for cls in ALGORITHMS:
        algo = cls()  # tạo mới -> trạng thái sạch (vd: con trỏ Round Robin về 0)
        results[cls.key] = simulate(copy.deepcopy(requests), algo, params)
    return requests, results


def print_table(results, params):
    n = params["num_servers"]
    head = "%-20s %9s %8s %8s %8s %6s  " % ("Thuật toán", "Makespan", "WaitTB", "RespTB", "p95", "QuáTải")
    head += " ".join("%6s" % ("s%d" % i) for i in range(n))
    print(head)
    print("-" * len(head))
    for cls in ALGORITHMS:
        m = results[cls.key]["metrics"]
        line = "%-20s %9.1f %8.1f %8.1f %8.1f %6d  " % (
            cls.name, m["makespan"], m["avg_wait"], m["avg_response"],
            m["p95_response"], m["overload_total"])
        line += " ".join("%5.1f%%" % p for p in m["request_pct"])
        print(line)


if __name__ == "__main__":
    import sys
    params = dict(DEFAULT_PARAMS)
    if len(sys.argv) > 1 and sys.argv[1] == "uniform":
        params.update({"heavy_percent": 0, "num_slow_servers": 0, "sticky_percent": 0})
        print("== Preset: Hệ thống đồng nhất ==")
    requests, results = run_all(params)
    print_table(results, params)

    from backend.algorithms import ip_to_server
    print()
    print("Sticky IP %s -> IP Hash luôn chọn s%d" % (
        params["sticky_ip"], ip_to_server(params["sticky_ip"], params["num_servers"])))
    print("\n% thời gian xử lý (busy time) và utilization:")
    for cls in ALGORITHMS:
        m = results[cls.key]["metrics"]
        print("  %-20s busy: %s | util: %s | quá tải: %s, ms quá tải: %s" % (
            cls.name,
            " ".join("%5.1f%%" % p for p in m["busy_pct"]),
            " ".join("%4.0f%%" % (100 * u) for u in m["utilization"]),
            m["overload_count"], m["overload_time"]))
    print("\nPhân bố request của sticky client:")
    for cls in ALGORITHMS:
        print("  %-20s %s" % (cls.name, results[cls.key]["metrics"]["sticky_distribution"]))
