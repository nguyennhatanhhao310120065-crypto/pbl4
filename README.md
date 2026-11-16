# Hệ thống cân bằng tải (Load Balancing) — mô phỏng + chạy thật

So sánh 4 thuật toán **Round Robin, Least Connections, IP Hash, Least Response Time**:

1. **Load Balancer thật** chuyển tiếp request HTTP tới 4 Web Server thật (s3 chậm gấp đôi).
2. LB ghi lại **chính các request thật** trong 20 giây gần nhất. Mỗi 2 giây, hệ thống **mô phỏng
   (Discrete-Event Simulation) cả 4 thuật toán trên đúng chuỗi request đó** và xếp hạng theo thời gian chờ TB.
3. Khi thuật toán đang dùng kém hơn rõ rệt (tắc nghẽn), trang admin **đề xuất thuật toán tốt hơn**;
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
- Mô phỏng 4 thuật toán trên các request của lượt gửi gần nhất (mỗi lần bấm **Bắt đầu gửi**, bảng so sánh và 4 sơ đồ
  bắt đầu lại từ đầu; gửi xong vẫn giữ kết quả. Chưa gửi lần nào thì dùng traffic 20 giây gần nhất) → bảng so sánh
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

Terminal in ra địa chỉ dạng `http://192.168.x.x:8080` để gửi cho máy khác (trang admin cũng hiện địa chỉ này).
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
| **Trang admin (1 trang duy nhất)** | Chọn thuật toán bằng tay (ô chọn + **Áp dụng**); gửi request (số lượng + tham số theo đề); **Đánh giá & đề xuất**; **4 sơ đồ thuật toán cùng lúc**; bảng so sánh 4 thuật toán; bảng Web Server có **chỉnh hệ số chậm, bật / tắt, thêm / bớt server** |

**4 sơ đồ cùng lúc:** mỗi request đi qua LB được đưa vào cả 4 sơ đồ. Sơ đồ của thuật toán đang chạy vẽ bằng số liệu
thật của LB (viền trắng đậm, nhãn **ĐANG CHẠY**); 3 sơ đồ còn lại là mô phỏng trực tiếp trên cùng luồng request
(`backend/shadow.py`: server ảo 1 worker + hàng đợi FIFO, giống hệt engine mô phỏng). Thuật toán có chờ TB thấp nhất
trong 20 giây gần nhất được viền xanh phát sáng, nhãn **TỐI ƯU NHẤT**, kèm nút **Chuyển sang …** (nhấp nháy khi
đề xuất nên đổi). Có thể đổi thuật toán bất cứ lúc nào, kể cả khi đang gửi request.

**Lịch sử chuyển thuật toán** (số liệu thật, `backend/history.py`): mỗi lần đổi thuật toán mở 1 giai đoạn mới
(ghi rõ chọn tay hay theo đề xuất). Mỗi giai đoạn là 1 sơ đồ Load Balancer cho thấy LB đã chia request cho các server
thế nào: đường nối LB → server dày theo % request, số request mỗi server, chờ TB, hàng đợi lớn nhất và thời gian quá tải
từng server. Đổi thuật toán thì thêm sơ đồ mới bên cạnh (giai đoạn 1 → giai đoạn 2), kèm dòng tóm tắt (VD: Round Robin →
Least Connections, chờ TB 924 ms → 74 ms, giảm 92%) và bảng so sánh các giai đoạn. Request, hàng đợi và quá tải được tính
cho thuật toán đã chia request đó, nên hàng đợi thuật toán cũ để lại không bị tính cho thuật toán mới. Lịch sử giữ trong
bộ nhớ (30 giai đoạn gần nhất), mất khi tắt chương trình.

**Chỉnh cụm server** (bảng Web Server):
- Đổi hệ số chậm (×1 … ×5) và bật / tắt từng server ngay cả khi đang gửi request. Server tắt không nhận request mới
  (thuật toán chỉ chọn trong các server đang bật), request đang xử lý vẫn trả về. Phải còn ít nhất 1 server bật.
- Thêm / bớt server (2–6 server) khi không gửi request. Server thêm mới dùng cổng `LB_BASE_PORT + số thứ tự`
  (mặc định 84, 85); LB tự khởi động tiến trình Web Server nếu cổng đó chưa có server, và tắt nó khi bớt.
- Mô phỏng trực tiếp (3 sơ đồ) và phần đề xuất luôn tính theo cụm server hiện tại.

Ký hiệu trong khung: chấm trắng = request nhẹ, chấm cam = request nặng, viền tím = sticky client,
số trong ô = request đã xong, thanh dọc = số kết nối mở (vạch đứt = ngưỡng), ô đỏ = quá tải, ô nhỏ "×2" = server yếu, ô mờ "TẮT" = server đang tắt.

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
│   ├── history.py        # Lịch sử chạy thật theo từng giai đoạn thuật toán
│   ├── shadow.py         # Mô phỏng trực tiếp 4 thuật toán trên luồng request thật (4 sơ đồ)
│   ├── client.py         # Client sinh request
│   ├── admin.py          # Trang admin + API
│   ├── db.py             # SQLite lưu lượt chạy (data/lb.db)
│   └── main.py           # Tiến trình LB + admin
├── frontend/
│   ├── login.html, dashboard.html
│   ├── css/style.css
│   └── js/ common.js, settings.js, simulation.js, history.js, dashboard.js
├── tests/                # test_simulator.py, test_system.py
├── README.md
└── REPORT.md             # Báo cáo phân tích
```
