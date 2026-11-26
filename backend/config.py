"""Tham số mô phỏng mặc định (theo đề bài).

Mọi tham số đều nằm trong DEFAULT_PARAMS để giao diện có thể chỉnh được.
"""

DEFAULT_PARAMS = {
    "num_requests": 300,        # Tổng số request
    "num_servers": 4,           # Số server (s0..s3)
    "heavy_percent": 20,        # % request nặng (còn lại là nhẹ)
    "light_min": 6,             # Thời gian xử lý request nhẹ (ms), phân phối đều
    "light_max": 16,
    "heavy_min": 61,            # Thời gian xử lý request nặng (ms), phân phối đều
    "heavy_max": 149,
    "num_slow_servers": 1,      # Số server yếu, lấy từ cuối lên (1 -> s3; 2 -> s3, s2)
    "slow_factor": 2,           # Hệ số chậm của server yếu (×2)
    "sticky_percent": 25,       # % request đến từ 1 IP cố định (sticky client)
    "sticky_ip": "10.0.0.99",
    "num_clients": 50,          # Số client khác (IP ngẫu nhiên trong nhóm này)
    "arrival_rate": 96,         # Tốc độ đến trung bình (req/s)
    "seed": 42,
    "overload_threshold": 5,    # Quá tải khi số kết nối mở >= ngưỡng
}

# Giới hạn hợp lệ cho từng tham số số: (min, max, kiểu)
PARAM_LIMITS = {
    "num_requests": (1, 20000, int),
    "num_servers": (2, 6, int),
    "heavy_percent": (0, 100, float),
    "light_min": (0.1, 10000, float),
    "light_max": (0.1, 10000, float),
    "heavy_min": (0.1, 10000, float),
    "heavy_max": (0.1, 10000, float),
    "num_slow_servers": (0, 5, int),
    "slow_factor": (1, 20, float),
    "sticky_percent": (0, 100, float),
    "num_clients": (1, 250, int),
    "arrival_rate": (1, 10000, float),
    "seed": (0, 10**9, int),
    "overload_threshold": (1, 1000, int),
}


def slow_factors(params):
    """Trả về list hệ số chậm cho từng server.

    params có "factors" (cụm thật, admin chỉnh từng server) thì dùng luôn; không thì server yếu là các server cuối.
    """
    if params.get("factors"):
        return list(params["factors"])
    n = params["num_servers"]
    k = min(params["num_slow_servers"], n - 1)  # luôn giữ ít nhất 1 server bình thường
    return [params["slow_factor"] if i >= n - k else 1 for i in range(n)]


# ===================== Hệ thống thật =====================
import os  # noqa: E402

# 4 Web Server thật. s3 là server yếu: mọi request xử lý lâu gấp đôi.
# Đổi BASE_PORT bằng biến môi trường nếu không mở được cổng 80 (VD: Linux không có sudo).
BASE_PORT = int(os.environ.get("LB_BASE_PORT", 80))
CLUSTER = [
    {"name": "s0", "port": BASE_PORT + 0, "slow_factor": 1},
    {"name": "s1", "port": BASE_PORT + 1, "slow_factor": 1},
    {"name": "s2", "port": BASE_PORT + 2, "slow_factor": 1},
    {"name": "s3", "port": BASE_PORT + 3, "slow_factor": 2},
]
SERVER_HOST = "127.0.0.1"


def parse_servers(items):
    """Danh sách Web Server LB sẽ chia tải, dạng "host:port" (VD: 192.168.1.20:8001).

    Dùng khi 4 Web Server chạy trên máy khác: python -m backend.main --servers 192.168.1.20:8001 ...
    Hệ số chậm không khai ở đây: LB hỏi chính Web Server qua GET /health.
    """
    cluster = []
    for i, item in enumerate(items):
        host, _, port = item.strip().rpartition(":")
        if not host or not port.isdigit():
            raise ValueError("Sai địa chỉ server '%s', cần dạng host:port" % item)
        cluster.append({"name": "s%d" % i, "host": host, "port": int(port), "slow_factor": 1})
    return cluster


def lan_ip():
    """IP của máy này trong mạng LAN (không gửi gói tin nào, chỉ hỏi hệ điều hành route ra ngoài)."""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
        except OSError:
            return "127.0.0.1"
MIN_SERVERS = 2
MAX_SERVERS = 6
SLOW_FACTOR_CHOICES = [1, 1.5, 2, 3, 4, 5]   # hệ số chậm admin chọn được cho từng server


def server_port(index):
    """Cổng của server thứ index (server thêm từ trang admin cũng theo quy tắc này)."""
    return BASE_PORT + index

# LB_HOST=0.0.0.0 để máy khác cùng mạng Wi-Fi gửi request tới LB (VD: http://192.168.1.23:8080).
# Trang admin luôn chỉ mở ở 127.0.0.1 để không lộ ra mạng.
LB_HOST = os.environ.get("LB_HOST", "127.0.0.1")
LB_PORT = int(os.environ.get("LB_PORT", 8080))        # cổng nhận traffic của client
LB_URL = "http://127.0.0.1:%d" % LB_PORT              # địa chỉ client trên chính máy này dùng để gọi LB
ADMIN_HOST = "127.0.0.1"
ADMIN_PORT = int(os.environ.get("ADMIN_PORT", 5050))  # trang admin (5000 hay bị AirPlay chiếm trên macOS)

ADMIN_USERNAME = os.environ.get("LB_ADMIN_USER", "admin")
ADMIN_PASSWORD = os.environ.get("LB_ADMIN_PASSWORD", "admin123")
SESSION_HOURS = 8

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "lb.db")

HEALTH_INTERVAL = 1.0   # giây, LB kiểm tra sức khỏe server
PUSH_INTERVAL = 0.1     # giây, LB đẩy trạng thái lên trang admin qua WebSocket


def cluster_params():
    """Tham số server của cụm thật, dạng giống DEFAULT_PARAMS để chạy mô phỏng đối chiếu.

    slow_factors() lấy server yếu từ cuối lên, nên cụm thật cũng phải đặt server yếu ở cuối.
    """
    factors = [s["slow_factor"] for s in CLUSTER]
    slow = [f for f in factors if f != 1]
    return {
        "num_servers": len(CLUSTER),
        "num_slow_servers": len(slow),
        "slow_factor": slow[0] if slow else DEFAULT_PARAMS["slow_factor"],
    }
