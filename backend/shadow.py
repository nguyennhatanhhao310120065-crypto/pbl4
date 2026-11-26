"""Mô phỏng trực tiếp (shadow) 4 thuật toán trên luồng request thật.

Load Balancer thật mỗi lúc chỉ chạy 1 thuật toán. Để trang admin hiện cả 4 sơ đồ cùng lúc,
mỗi request thật đi qua LB cũng được đưa ngay vào 4 cụm server ảo (mỗi thuật toán 1 cụm).
Server ảo giống engine mô phỏng: 1 worker, hàng đợi FIFO, thời gian xử lý = base × hệ số chậm.

Vì FIFO 1 worker nên lúc nhận request đã biết luôn thời điểm xong:
    start = max(now, lúc server rảnh),  finish = start + base × hệ số chậm.
Trước mỗi lần chọn server, các request đã xong (finish <= now) được lấy ra trước, giống quy tắc
"FINISH trước ARRIVAL" của engine mô phỏng.
"""

from collections import deque

from backend.algorithms import ALGORITHMS, make_algorithm
from backend.simulator import RECENT_WINDOW


class ShadowServer:
    """Server ảo; có open_connections, avg_recent_rt như simulator.Server để dùng chung thuật toán."""

    def __init__(self, index, slow_factor):
        self.index = index
        self.slow_factor = slow_factor
        self.jobs = deque()         # (finish_ms, id, arrival_ms, emit) theo thứ tự FIFO
        self.free_at = 0.0
        self.recent_rt = deque(maxlen=RECENT_WINDOW)
        self.done = 0
        self.enabled = True

    @property
    def open_connections(self):
        return len(self.jobs)

    def avg_recent_rt(self, default):
        if not self.recent_rt:
            return default
        return sum(self.recent_rt) / len(self.recent_rt)


class ShadowCluster:
    """Cụm server ảo chạy 1 thuật toán."""

    def __init__(self, key, factors):
        self.key = key
        self.algorithm = make_algorithm(key)
        self.servers = [ShadowServer(i, f) for i, f in enumerate(factors)]

    def advance(self, now, emit):
        """Lấy ra các request đã xong tới thời điểm now (ms)."""
        for s in self.servers:
            while s.jobs and s.jobs[0][0] <= now:
                finish, rid, arrival, visible = s.jobs.popleft()
                s.done += 1
                s.recent_rt.append(finish - arrival)
                if visible:
                    emit({"e": "f", "id": rid, "s": s.index, "ok": True, "g": self.key, "t": round(finish, 1)})

    def assign(self, now, rid, base, client_ip):
        """Chọn server (trong các server đang bật) rồi xếp vào hàng đợi. Trả về index server, None nếu tắt hết."""
        active = [s for s in self.servers if s.enabled]
        if not active:
            return None
        s = active[self.algorithm.choose({"client_ip": client_ip}, active, now)]
        idx = s.index
        start = max(now, s.free_at)
        s.free_at = start + base * s.slow_factor
        s.jobs.append([s.free_at, rid, now, False])
        return idx

    def reset(self):
        """Bắt đầu lại từ trạng thái sạch (giống LB khi bắt đầu lượt đo); request đang xử lý vẫn giữ."""
        self.algorithm = make_algorithm(self.key)
        for s in self.servers:
            s.done = 0
            s.recent_rt.clear()

    def snapshot(self):
        return [{"open": s.open_connections, "done": s.done, "enabled": s.enabled} for s in self.servers]


class Shadows:
    """4 cụm ảo, nhận cùng 1 luồng request."""

    DEFAULT_BASE = 10.0   # ms, khi chưa biết thời gian xử lý của request nào

    def __init__(self, factors):
        self.clusters = {cls.key: ShadowCluster(cls.key, list(factors)) for cls in ALGORITHMS}
        self.known_bases = deque(maxlen=200)

    def mean_base(self):
        if not self.known_bases:
            return self.DEFAULT_BASE
        return sum(self.known_bases) / len(self.known_bases)

    def learn_base(self, base):
        """Ghi nhận thời gian xử lý gốc đo được (dùng cho request không khai báo X-Work-Ms)."""
        if base is not None and base > 0:
            self.known_bases.append(base)

    def advance(self, now, emit):
        for c in self.clusters.values():
            c.advance(now, emit)

    def on_request(self, now, rid, base, client_ip, kind, current, emit, num=None):
        """Đưa 1 request thật vào cả 4 cụm ảo.

        Sơ đồ của thuật toán đang chạy vẽ bằng số liệu thật, nên chỉ phát sự kiện cho 3 cụm còn lại.
        Quyết định phát hay không lấy theo lúc request đến, nên khi đổi thuật toán giữa chừng
        mỗi request vẫn xuất hiện đúng 1 lần trên mỗi sơ đồ.
        """
        if base is None:
            base = self.mean_base()
        else:
            self.learn_base(base)
        self.advance(now, emit)
        for key, c in self.clusters.items():
            idx = c.assign(now, rid, base, client_ip)
            if idx is not None and key != current:
                c.servers[idx].jobs[-1][3] = True
                emit({"e": "a", "id": rid, "n": rid if num is None else num, "s": idx, "k": kind,
                      "ip": client_ip, "g": key, "t": round(now, 1)})

    def reset(self):
        for c in self.clusters.values():
            c.reset()

    # ---- Cụm server thay đổi (admin chỉnh trên trang): áp dụng cho cả 4 cụm ảo ----

    def set_factor(self, index, factor):
        """Request đã xếp hàng giữ thời gian xử lý cũ, giống Web Server thật."""
        for c in self.clusters.values():
            c.servers[index].slow_factor = factor

    def set_enabled(self, index, enabled):
        """Server bị tắt không nhận request mới, request đang có vẫn xử lý xong."""
        for c in self.clusters.values():
            c.servers[index].enabled = enabled

    def add_server(self, factor):
        for c in self.clusters.values():
            c.servers.append(ShadowServer(len(c.servers), factor))

    def remove_last(self):
        for c in self.clusters.values():
            c.servers.pop()

    def snapshot(self):
        return {key: c.snapshot() for key, c in self.clusters.items()}
