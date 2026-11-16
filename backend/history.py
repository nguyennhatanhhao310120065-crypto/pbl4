"""Lịch sử chạy thật theo từng giai đoạn thuật toán.

Mỗi lần đổi thuật toán mở 1 giai đoạn mới. Request được tính cho giai đoạn của thuật toán đã chọn server cho
nó (lúc request đến), nên số liệu mỗi giai đoạn phản ánh đúng thuật toán đó. Mỗi giai đoạn ghi riêng từng server
(số request, chờ TB, hàng đợi lớn nhất, quá tải) để trang admin vẽ sơ đồ "LB đã chia tải thế nào" cho từng giai đoạn.

Lưu ý khi đọc số liệu: ngay sau khi đổi, hàng đợi do thuật toán cũ để lại vẫn còn, nên vài giây đầu của
giai đoạn mới còn chịu ảnh hưởng của giai đoạn trước.
"""

import time
from collections import deque
from datetime import datetime

from backend.metrics import percentile

MAX_SEGMENTS = 30       # số giai đoạn giữ lại
MAX_SAMPLES = 5000      # số thời gian phản hồi giữ lại mỗi giai đoạn để tính p95


class Segment:
    def __init__(self, seg_id, algo, now, source):
        self.id = seg_id
        self.algo = algo
        self.source = source          # "manual" (chọn tay), "advice" (theo đề xuất), "start", "run"
        self.started = now
        self.started_at = datetime.now().strftime("%H:%M:%S")
        self.ended_at = None
        self.first = None             # lúc request đầu tiên / cuối cùng của giai đoạn đến
        self.last = None
        self.count = 0
        self.done = 0
        self.errors = 0
        self.sum_wait = 0.0
        self.sum_resp = 0.0
        self.responses = deque(maxlen=MAX_SAMPLES)
        self.per_server = {}          # tên server -> số liệu riêng server đó trong giai đoạn (để vẽ sơ đồ)
        self.max_open = 0
        self.overloads = 0

    def server(self, name, factor=None):
        st = self.per_server.get(name)
        if st is None:
            st = self.per_server[name] = {"count": 0, "done": 0, "sum_wait": 0.0, "open": 0, "max_open": 0,
                                          "overloads": 0, "over_s": 0.0, "over_since": None,
                                          "factor": 1, "enabled": True}
        if factor is not None:
            st["factor"] = factor
        return st

    def over_seconds(self, st, now):
        """Tổng thời gian server ở trạng thái quá tải (kể cả đợt đang diễn ra)."""
        return st["over_s"] + (now - st["over_since"] if st["over_since"] is not None else 0.0)

    def summary(self):
        now = time.perf_counter()
        span = (self.last - self.first) if self.count > 1 else 0.0
        total = self.count or 1
        servers = []
        for name in sorted(self.per_server):
            st = self.per_server[name]
            servers.append({
                "name": name,
                "count": st["count"],
                "pct": round(100.0 * st["count"] / total, 1),
                "avg_wait": round(st["sum_wait"] / st["done"], 1) if st["done"] else None,
                "max_open": st["max_open"],
                "overloads": st["overloads"],
                "overload_s": round(self.over_seconds(st, now), 1),
                "factor": st["factor"],
                "enabled": st["enabled"],
            })
        return {
            "id": self.id,
            "algo": self.algo,
            "source": self.source,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "count": self.count,
            "done": self.done,
            "errors": self.errors,
            "traffic_s": round(span, 1),
            "rps": round(self.count / span, 1) if span > 0 else None,
            "avg_wait": round(self.sum_wait / self.done, 2) if self.done else None,
            "avg_response": round(self.sum_resp / self.done, 2) if self.done else None,
            "p95_response": round(percentile(list(self.responses), 95), 1) if self.responses else None,
            "max_open": self.max_open,
            "overloads": self.overloads,
            # Số lần vượt ngưỡng dễ gây hiểu lầm (quanh ngưỡng thì đếm nhiều lần mà rất ngắn) -> kèm tổng thời gian
            "overload_s": round(sum(s["overload_s"] for s in servers), 1),
            "per_server": {s["name"]: s["pct"] for s in servers},
            "servers": servers,
        }


class History:
    def __init__(self, algo):
        self.segments = deque(maxlen=MAX_SEGMENTS)
        self.next_id = 1
        self.version = 0              # tăng khi có thay đổi -> biết lúc nào cần gửi lại
        self.threshold = 5
        self.start_segment(algo, "start")

    @property
    def current(self):
        return self.segments[-1]

    def start_segment(self, algo, source, now=None):
        now = time.perf_counter() if now is None else now
        if self.segments:
            cur = self.current
            if cur.count == 0:
                self.segments.pop()   # giai đoạn không có request nào thì bỏ, không làm rối lịch sử
            else:
                cur.ended_at = datetime.now().strftime("%H:%M:%S")
        self.segments.append(Segment(self.next_id, algo, now, source))
        self.next_id += 1
        self.version += 1

    def clear(self, algo):
        self.segments.clear()
        self.start_segment(algo, "start")

    # Hàng đợi / quá tải của giai đoạn chỉ đếm request do CHÍNH thuật toán đó chia (không tính hàng đợi
    # thuật toán trước để lại), để sơ đồ mỗi giai đoạn phản ánh đúng cách chia của thuật toán đó.

    def on_arrival(self, server_name, now):
        """Trả về giai đoạn để LB gắn vào request; lúc request xong cộng đúng vào giai đoạn này."""
        seg = self.current
        seg.count += 1
        seg.first = now if seg.first is None else seg.first
        seg.last = now
        st = seg.server(server_name)
        st["count"] += 1
        st["open"] += 1
        if st["open"] > st["max_open"]:
            st["max_open"] = st["open"]
            seg.max_open = max(seg.max_open, st["open"])
        if st["open"] == self.threshold:   # vừa vượt lên ngưỡng (đếm giống bản mô phỏng)
            st["overloads"] += 1
            seg.overloads += 1
            st["over_since"] = now
        self.version += 1
        return seg

    def on_finish(self, seg, ok, wait_ms, response_ms, server_name=None):
        if server_name is not None:
            st = seg.server(server_name)
            st["open"] -= 1
            if st["open"] < self.threshold and st["over_since"] is not None:
                st["over_s"] += time.perf_counter() - st["over_since"]
                st["over_since"] = None
        if ok:
            seg.done += 1
            seg.sum_wait += wait_ms
            seg.sum_resp += response_ms
            seg.responses.append(response_ms)
            if server_name is not None:
                st = seg.server(server_name)
                st["done"] += 1
                st["sum_wait"] += wait_ms
        else:
            seg.errors += 1
        self.version += 1

    def tick(self, servers, threshold):
        """Gọi định kỳ: ghi đủ các server của cụm (kể cả chưa nhận request / đang tắt) vào giai đoạn hiện tại."""
        seg = self.current
        self.threshold = threshold
        for s in servers:
            st = seg.server(s.name, s.slow_factor)
            if st["enabled"] != s.enabled:
                st["enabled"] = s.enabled
                self.version += 1

    def snapshot(self):
        return {
            "segments": [s.summary() for s in self.segments],
            "threshold": self.threshold,
        }
