# Mô phỏng cơ chế cân bằng tải (Load Balancing Simulation)

So sánh 4 thuật toán **Round Robin, Least Connections, IP Hash, Least Response Time**
trên cùng 1 bộ 300 request bằng mô phỏng sự kiện rời rạc (Discrete-Event Simulation),
có dashboard web phát lại 4 thuật toán song song.

> **Ghi chú:** đồ án dùng **mô phỏng** thay cho Web Server thật. 4 server s0–s3 là server ảo
> trong engine Python, không mở socket, không gửi request mạng thật.

## Yêu cầu

- Python 3.9+ (đã chạy thử trên 3.9.6; đề yêu cầu 3.10+ cũng chạy được)
- Flask (thư viện ngoài duy nhất)
- Trình duyệt có Internet để tải Chart.js từ CDN

## Cài đặt & chạy

```bash
cd load-balancer-sim
python3 -m venv .venv                 # (khuyến nghị) tạo môi trường ảo
source .venv/bin/activate             # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python backend/app.py
```

Mở **http://127.0.0.1:5000**.

> macOS: AirPlay Receiver có thể chiếm cổng 5000 (lỗi 403). Dùng đúng địa chỉ `127.0.0.1`
> thay vì `localhost`, hoặc đổi cổng: `PORT=5050 python backend/app.py`.

Chạy trên terminal (không cần web):

```bash
python -m backend.generator           # thống kê bộ request
python -m backend.simulator           # bảng số liệu 4 thuật toán (seed 42)
python -m backend.simulator uniform   # preset "Hệ thống đồng nhất"
python -m unittest discover tests     # chạy test
```

## Cách dùng giao diện

1. **Thiết lập:** chỉnh tham số hoặc chọn preset → bấm **Chạy mô phỏng (Run)**.
2. **Mô phỏng trực tiếp:** bấm **Phát (Play)**; đổi tốc độ 0.1×–10×; kéo thanh timeline để tua.
3. **Kết quả:** xem bảng tổng hợp (ô xanh = tốt nhất), 3 biểu đồ; bấm **Tải log CSV** để lấy log chi tiết.
4. **Nhận xét:** đọc nhận xét tự sinh và bảng khuyến nghị.

Ký hiệu trong khung mô phỏng: chấm trắng = request nhẹ, chấm cam = request nặng, viền tím = sticky client,
số trong ô = request đã xong, thanh dọc = số kết nối mở (vạch đứt = ngưỡng), ô đỏ = quá tải,
ô nhỏ có nhãn "×2" = server yếu.

## API

| Method | Đường dẫn | Mô tả |
|---|---|---|
| GET | `/api/defaults` | Tham số mặc định |
| POST | `/api/simulate` | Chạy 4 thuật toán; trả `params, requests, results{rr,lc,iphash,lrt}` |
| POST | `/api/sticky-compare` | Chạy với sticky 0% và sticky theo params, trả metrics |
| GET | `/api/export.csv?seed=42&...` | Log CSV từng request của 4 thuật toán |

Lỗi tham số trả HTTP 400 với `{"error": "..."}`.

## Cấu trúc thư mục

```
load-balancer-sim/
├── backend/
│   ├── app.py            # Flask: API + phục vụ frontend
│   ├── config.py         # DEFAULT_PARAMS
│   ├── generator.py      # Sinh 300 request
│   ├── algorithms.py     # 4 thuật toán
│   ├── simulator.py      # Engine DES (heapq)
│   └── metrics.py        # Tính số liệu
├── frontend/
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── api.js        # Gọi API
│       ├── settings.js   # Form tham số, preset
│       ├── simulation.js # Vẽ Canvas + replay
│       ├── charts.js     # Chart.js
│       └── main.js       # Bảng, nhận xét, luồng chạy
├── tests/test_simulator.py
├── requirements.txt
├── README.md
└── REPORT.md
```
