# Hệ thống cân bằng tải (Load Balancing) — mô phỏng + chạy thật

So sánh 4 thuật toán **Round Robin, Least Connections, IP Hash, Least Response Time**:

1. **Load Balancer thật** chuyển tiếp request HTTP tới 4 Web Server thật (s3 chậm gấp đôi).
2. LB ghi lại **chính các request thật** trong 20 giây gần nhất. Mỗi 2 giây, hệ thống **mô phỏng
   (Discrete-Event Simulation) cả 4 thuật toán trên đúng chuỗi request đó** và xếp hạng theo thời gian chờ TB.
3. Khi thuật toán đang dùng kém hơn rõ rệt (tắc nghẽn), trang Tổng quan **đề xuất thuật toán tốt hơn**;
   admin bấm 1 nút để chuyển ngay, kể cả giữa lúc traffic đang chạy.
4. **Client** sinh traffic theo tham số của đề (300 request, 80/20 nhẹ/nặng, 25% sticky, ~96 req/s); mỗi lượt đo
   được lưu lại và đối chiếu với mô phỏng của cùng bộ request và cùng lịch đổi thuật toán.

## Kiến trúc

```
                     ┌──────────────── Tiến trình backend.main ────────────────┐
 Client (HTTP)  ──►  │ Load Balancer  127.0.0.1:8080  ── reverse proxy ──┐     │
 backend.client      │ Trang admin    127.0.0.1:5050  (login, WebSocket) │     │
                     └───────────────────────────────────────────────────┼─────┘
                                                                          ▼
                     Web Server s0 :80   s1 :81   s2 :82   s3 :83 (×2, server yếu)
                     (mỗi server 1 tiến trình: nhận kết nối bất đồng bộ, 1 worker + hàng đợi FIFO)
```

- Mỗi request mang header `X-Work-Ms` (thời gian xử lý gốc); server xử lý trong `X-Work-Ms × hệ số chậm` ms.
- Client mô phỏng nhiều IP bằng header `X-Forwarded-For` (25% từ sticky IP `10.0.0.99`), LB dùng IP này cho IP Hash.
- LB dùng **đúng các class thuật toán** của bản mô phỏng (`backend/algorithms.py`).
- Phần đề xuất (`backend/advisor.py`) chạy ở tiến trình riêng để không làm chậm LB.

### Đề xuất thuật toán từ traffic thật

- Với mỗi request, LB ghi: thời điểm đến, IP client, thời gian xử lý gốc (`X-Work-Ms`; không có thì lấy
  thời gian server đo được quy về server ×1).
- Mô phỏng 4 thuật toán trên chuỗi request của 20 giây gần nhất (bắt đầu từ server rỗng) → bảng so sánh
  chờ TB, p95, hàng đợi lớn nhất, % vào server yếu, số lần quá tải.
- **Đề xuất** khi thuật toán tốt nhất giảm chờ TB ít nhất 30% **và** ít nhất 5 ms so với thuật toán đang dùng
  (tránh đổi qua lại vì chênh lệch nhỏ). Hệ thống không tự đổi; admin bấm **Chuyển sang …**.
- Đổi thuật toán chỉ ảnh hưởng request mới; request đã chuyển tới server vẫn xử lý tiếp ở đó.

## Yêu cầu

- Python 3.9+
- `aiohttp` (thư viện ngoài duy nhất), SQLite có sẵn trong Python
- Trình duyệt có Internet để tải Chart.js từ CDN

## Cài đặt & chạy

```bash
cd load-balancer-sim
python3 -m venv .venv
source .venv/bin/activate             # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python run.py                          # chạy 4 Web Server + Load Balancer + trang admin
```

Mở **http://127.0.0.1:5050**, đăng nhập `admin` / `admin123`
(đổi bằng biến môi trường `LB_ADMIN_USER`, `LB_ADMIN_PASSWORD`). Ctrl+C để tắt tất cả.

> **Cổng 80–83:** trên macOS, user thường chỉ mở được cổng < 1024 khi bind `0.0.0.0`; server tự chuyển sang
> `0.0.0.0` nếu không bind được `127.0.0.1` (LB vẫn gọi `127.0.0.1`). Trên Linux cần `sudo` hoặc đổi cổng:
> `LB_BASE_PORT=8000 python run.py` (server dùng 8000–8003). Các cổng khác: `LB_PORT` (8080), `ADMIN_PORT` (5050).

### Cho máy khác cùng mạng Wi-Fi gửi request

```bash
LB_HOST=0.0.0.0 python run.py
```

Terminal in ra địa chỉ dạng `http://192.168.x.x:8080` để gửi cho máy khác (trang Tổng quan cũng hiện địa chỉ này).
Lần đầu macOS có thể hỏi cho phép kết nối đến: chọn **Cho phép**. Trang admin (5050) vẫn chỉ mở ở `127.0.0.1`.
Không mở LB ra Internet: LB tin header `X-Forwarded-For` nên ai cũng có thể giả IP.

### Chạy từng chương trình riêng

```bash
python -m backend.web_server --name s0 --port 80
python -m backend.web_server --name s1 --port 81
python -m backend.web_server --name s2 --port 82
python -m backend.web_server --name s3 --port 83 --slow-factor 2
python -m backend.main                       # Load Balancer :8080 + admin :5050
python -m backend.client --seed 42           # gửi 300 request vào LB (không ghi thành lượt chạy)
```

Gửi thử 1 request: `curl -H "X-Work-Ms: 10" http://127.0.0.1:8080/work`

### Mô phỏng theo tham số trên terminal

```bash
python -m backend.generator           # thống kê bộ request
python -m backend.simulator           # bảng số liệu 4 thuật toán (seed 42)
python -m backend.simulator uniform   # preset "Hệ thống đồng nhất"
python -m unittest discover tests     # chạy test (gồm cả test hệ thống thật)
```

## Trang admin

| Trang | Chức năng |
|---|---|
| **Tổng quan** | Đổi thuật toán; **Đánh giá & đề xuất** (mô phỏng 4 thuật toán trên traffic thật, nút chuyển); khung lưu lượng trực tiếp; biểu đồ hàng đợi 60 giây (vạch dọc = lúc đổi thuật toán); bảng server; **Phân tích chi tiết**: phát lại 4 thuật toán song song, bảng kết quả, biểu đồ workload / makespan / chờ TB / sticky client, nhận xét, khuyến nghị |
| **Mô phỏng** | Theo đề: chỉnh tham số / preset (mặc định 300 request, seed 42), chạy 4 thuật toán song song trên cùng bộ request, xếp hạng, nút **Áp dụng cho LB** và **Áp dụng & chạy đo**, biểu đồ, nhận xét, CSV |
| **Chạy thật** | Sinh traffic bằng client (chọn thuật toán + tham số), tiến độ, lịch sử lượt đo, đối chiếu thật vs mô phỏng (cùng lịch đổi thuật toán), phát lại song song, CSV |

Ký hiệu trong khung: chấm trắng = request nhẹ, chấm cam = request nặng, viền tím = sticky client,
số trong ô = request đã xong, thanh dọc = số kết nối mở (vạch đứt = ngưỡng), ô đỏ = quá tải, ô nhỏ "×2" = server yếu.

## Số liệu của lượt chạy thật

LB ghi log mọi request có header `X-Run-Id` của lượt đang chạy:

- `arrival` / `finish`: lúc LB nhận request / trả phản hồi (ms, tính từ mốc 0 của bộ request).
- `service_time`: thời gian xử lý do server đo.
- `wait = response − service_time`: gồm thời gian chờ hàng đợi server **và** độ trễ mạng/proxy (~1 ms).
- Makespan, % workload, chờ TB, số lần quá tải tính bằng cùng hàm `backend/metrics.py` như bản mô phỏng.

## API (cần đăng nhập, trừ `/api/login`)

| Method | Đường dẫn | Mô tả |
|---|---|---|
| POST | `/api/login`, `/api/logout` | Đăng nhập / đăng xuất (cookie phiên) |
| GET | `/api/defaults` | Tham số mặc định + cấu hình cụm server |
| POST | `/api/simulate` | Mô phỏng 4 thuật toán theo tham số |
| POST | `/api/sticky-compare` | Mô phỏng có / không sticky client |
| GET | `/api/export.csv?...` | Log CSV mô phỏng theo tham số |
| GET | `/api/advisor/snapshot` | Mô phỏng chi tiết 4 thuật toán trên traffic thật 20 s gần nhất |
| GET | `/api/lb` | Trạng thái LB |
| POST | `/api/lb/algorithm` | Đổi thuật toán `{"algorithm": "rr"\|"lc"\|"iphash"\|"lrt"}` |
| POST | `/api/lb/reset` | Đặt lại bộ đếm |
| GET | `/ws` | WebSocket trạng thái LB (~10 lần/giây) + tin `advice` (mỗi 2 giây) |
| GET / POST | `/api/runs` | Lịch sử / bắt đầu lượt chạy thật `{"algorithm", "params"}` |
| GET / DELETE | `/api/runs/{id}` | Chi tiết / xóa lượt chạy |
| GET | `/api/runs/{id}/export.csv` | Log CSV lượt chạy thật |

## Cấu trúc thư mục

```
load-balancer-sim/
├── run.py                # Chạy toàn bộ hệ thống
├── backend/
│   ├── config.py         # Tham số mô phỏng + cấu hình cụm server, cổng, tài khoản admin
│   ├── generator.py      # Sinh bộ request (dùng chung cho mô phỏng và client)
│   ├── algorithms.py     # 4 thuật toán (dùng chung cho mô phỏng và LB thật)
│   ├── simulator.py      # Engine DES (heapq)
│   ├── metrics.py        # Tính số liệu
│   ├── web_server.py     # Web Server thật
│   ├── load_balancer.py  # Load Balancer thật (reverse proxy)
│   ├── advisor.py        # Mô phỏng trên traffic thật + đề xuất thuật toán
│   ├── client.py         # Client sinh request
│   ├── admin.py          # Trang admin + API
│   ├── db.py             # SQLite lưu lượt chạy (data/lb.db)
│   └── main.py           # Tiến trình LB + admin
├── frontend/
│   ├── login.html, dashboard.html, simulation.html, runs.html
│   ├── css/style.css
│   └── js/ common.js, settings.js, simulation.js, charts.js, analysis.js, sim-page.js, dashboard.js, runs.js
├── tests/                # test_simulator.py, test_system.py
├── README.md
└── REPORT.md             # Báo cáo phân tích
```
