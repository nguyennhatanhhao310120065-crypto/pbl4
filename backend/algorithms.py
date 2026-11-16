"""4 thuật toán cân bằng tải.

Mỗi class có hàm choose(request, servers, now) -> index server.
Hòa điểm thì chọn server có index nhỏ nhất (min() của Python tự làm vậy
vì nó trả về phần tử đầu tiên đạt giá trị nhỏ nhất).
"""

import hashlib


class RoundRobin:
    key = "rr"
    name = "Round Robin"

    def __init__(self):
        self.next_index = 0

    def choose(self, request, servers, now):
        # Chỉ đếm lượt, không quan tâm server đang bận hay rảnh
        idx = self.next_index
        self.next_index = (self.next_index + 1) % len(servers)
        return idx


class LeastConnections:
    key = "lc"
    name = "Least Connections"

    def choose(self, request, servers, now):
        # Server chậm xử lý lâu -> kết nối mở dồn lại -> tự động ít được chọn
        return min(range(len(servers)), key=lambda i: servers[i].open_connections)


def ip_to_server(ip, num_servers):
    """Băm IP bằng MD5 (ổn định giữa các lần chạy, khác với hash() của Python)."""
    digest = hashlib.md5(ip.encode("utf-8")).hexdigest()
    return int(digest, 16) % num_servers


class IPHash:
    key = "iphash"
    name = "IP Hash"

    def choose(self, request, servers, now):
        # Cùng IP luôn vào cùng server (giữ session), bất kể server đó đang tải nặng
        return ip_to_server(request["client_ip"], len(servers))


class LeastResponseTime:
    key = "lrt"
    name = "Least Response Time"

    # Giá trị khởi tạo khi server chưa hoàn thành request nào (ms).
    # Để nhỏ để server mới vẫn được thử ít nhất vài lần.
    INITIAL_RT = 1.0

    def score(self, server):
        avg_rt = server.avg_recent_rt(self.INITIAL_RT)
        # Công thức gốc là avg_rt × open_connections, nhưng khi mọi server rảnh
        # (open = 0) thì score đều = 0 -> không phân biệt được server nhanh/chậm.
        # Dùng (open + 1) để vẫn ưu tiên server có avg_rt thấp hơn.
        return avg_rt * (server.open_connections + 1)

    def choose(self, request, servers, now):
        return min(range(len(servers)), key=lambda i: self.score(servers[i]))


ALGORITHMS = [RoundRobin, LeastConnections, IPHash, LeastResponseTime]


def make_algorithm(key):
    for cls in ALGORITHMS:
        if cls.key == key:
            return cls()
    raise ValueError("Không có thuật toán: %s" % key)


class Scheduled:
    """Đổi thuật toán theo lịch [(t_ms, key), ...] (lịch bắt đầu từ t = 0).

    Dùng để mô phỏng lại đúng 1 lượt chạy thật mà admin đã đổi thuật toán giữa chừng.
    Mỗi lần đổi tạo thuật toán mới (trạng thái sạch), giống Load Balancer thật.
    """

    def __init__(self, schedule):
        self.schedule = sorted(schedule)
        self.idx = 0
        self.algo = make_algorithm(self.schedule[0][1])

    def choose(self, request, servers, now):
        while self.idx + 1 < len(self.schedule) and self.schedule[self.idx + 1][0] <= now:
            self.idx += 1
            self.algo = make_algorithm(self.schedule[self.idx][1])
        return self.algo.choose(request, servers, now)
