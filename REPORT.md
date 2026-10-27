# BÁO CÁO ĐỒ ÁN: MÔ PHỎNG CƠ CHẾ CÂN BẰNG TẢI

## 1. Mục đích

- Cài đặt và so sánh 4 thuật toán cân bằng tải: **Round Robin (RR), Least Connections (LC),
  IP Hash, Least Response Time (LRT)**.
- Cho cả 4 thuật toán chạy trên **cùng một bộ 300 request** (cùng seed) bằng mô phỏng sự kiện rời rạc,
  để mọi khác biệt về kết quả chỉ đến từ thuật toán.
- Chứng minh bằng số liệu: khi hệ thống **không đồng nhất** (request nặng/nhẹ, server yếu,
  client tập trung), các thuật toán cho kết quả khác nhau rõ rệt; khi hệ thống **đồng nhất**,
  chúng gần như giống nhau.

## 2. Mô hình mô phỏng và giả định

### 2.1 Vì sao dùng mô phỏng sự kiện rời rạc (DES)

Trạng thái hệ thống chỉ thay đổi tại 2 loại thời điểm: khi request **đến** (ARRIVAL) và khi server
**xử lý xong** (FINISH). DES dùng hàng đợi ưu tiên (`heapq`) chứa các sự kiện, mỗi vòng lặp lấy
sự kiện sớm nhất ra xử lý và nhảy thẳng đồng hồ tới thời điểm đó. Cách này:

- chính xác tới từng phần nghìn ms, không phụ thuộc bước thời gian;
- **tất định (deterministic)**: cùng seed → kết quả y hệt (đã kiểm tra bằng test);
- chạy 4 thuật toán × 300 request mất vài mili giây.

Quy tắc khi 2 sự kiện trùng thời điểm: **FINISH xử lý trước ARRIVAL** — server vừa xong việc được
tính là đã giảm kết nối trước khi load balancer ra quyết định mới. Thêm một số thứ tự (`seq`) vào
phần tử heap để thứ tự luôn ổn định.

### 2.2 Bộ request

| Tham số | Giá trị |
|---|---|
| Số request | 300 |
| Nhẹ / nặng | 80% / 20%; nhẹ: đều 6–16 ms; nặng: đều 61–149 ms |
| Tốc độ đến | Poisson, trung bình 96 req/s: khoảng cách `rng.expovariate(96/1000)` ms |
| Sticky client | 25% request từ `10.0.0.99`, còn lại chọn ngẫu nhiên trong 50 IP `192.168.1.1–50` |
| Seed | 42, dùng `random.Random(seed)` riêng (không dùng random toàn cục) |

Mỗi request rút đủ 5 số ngẫu nhiên theo **thứ tự cố định** (khoảng cách đến, sticky?, client, nặng?,
thời gian xử lý). Nhờ vậy khi đổi % sticky thì thời điểm đến và loại request **không đổi**, chỉ IP đổi —
phép so sánh "có/không sticky client" là công bằng.

### 2.3 Mô hình server

- 4 server s0–s3; **s3 là server yếu**, mọi request qua s3 có thời gian xử lý ×2.
- Mỗi server có **1 worker, hàng đợi FIFO**: xử lý 1 request tại 1 thời điểm, các request còn lại chờ.
- **Kết nối mở** = đang xử lý + đang chờ.
- `response = finish − arrival`, `wait = start − arrival`.
- **Quá tải**: số kết nối mở ≥ 5. "Số lần quá tải" đếm lúc **vượt lên** ngưỡng (từ < 5 sang ≥ 5).
  Ngoài ra có thêm chỉ số **thời gian quá tải** (tổng ms server ở trạng thái ≥ ngưỡng), lý do ở mục 5.1.

### 2.4 Công thức Least Response Time đã chỉnh

`score = avg_rt × (open_connections + 1)`, chọn score nhỏ nhất.

- `avg_rt` = trung bình response time của **10 request hoàn thành gần nhất** trên server.
- Server chưa hoàn thành request nào: `avg_rt = 1 ms` để server mới vẫn được thử.
- Dùng `(open + 1)` thay cho công thức gốc `avg_rt × open`: với công thức gốc, mọi server đang rảnh
  đều có score = 0, thuật toán không phân biệt được server nhanh/chậm và luôn chọn s0.

## 3. Mô tả 4 thuật toán

| Thuật toán | Cách chọn server | Thông tin dùng |
|---|---|---|
| Round Robin | Lần lượt s0 → s1 → s2 → s3 → s0… | Không xét trạng thái |
| Least Connections | Server có ít kết nối mở nhất | Số kết nối hiện tại |
| IP Hash | `int(md5(ip).hexdigest(), 16) % 4` | Chỉ IP client |
| Least Response Time | `avg_rt × (open + 1)` nhỏ nhất | Response time gần đây + kết nối |

Hòa điểm thì chọn server có index nhỏ nhất. IP Hash dùng MD5 thay vì `hash()` của Python vì
`hash()` của chuỗi bị ngẫu nhiên hóa mỗi lần chạy chương trình (PYTHONHASHSEED).

**Sticky IP `10.0.0.99` rơi vào s3** (`md5 % 4 = 3`) — đúng server yếu. Đây là trường hợp xấu nhất
cho IP Hash, và nó xảy ra do giá trị băm chứ không do chọn số.

## 4. Số liệu thực tế (seed 42)

### 4.1 Thống kê bộ request

| Chỉ số | Đề bài | Thực tế seed 42 |
|---|---|---|
| Tỷ lệ request nặng | 20% | **19,0%** |
| Tỷ lệ sticky client | 25% | **27,7%** (83/300) |
| Tốc độ đến | ~96 req/s | **90,9 req/s** (300 request trong 3300,5 ms) |
| Thời gian xử lý gốc TB | ~29,8 ms (lý thuyết) | 28,64 ms |
| Số IP khác nhau | tối đa 51 | 49 (48 IP thường + sticky IP) |

Sai lệch là do **dao động ngẫu nhiên của mẫu nhỏ (300 request)**, không phải lỗi bộ sinh. Ví dụ với
p = 0,25 và n = 300, độ lệch chuẩn của tỷ lệ sticky là √(0,25·0,75/300) ≈ 2,5%, nên 27,7% nằm trong
khoảng ±1,1σ. Số liệu được **giữ nguyên, không chỉnh seed cho đẹp**.

Tải hệ thống: năng lực xử lý ≈ 3/28,64 + 1/57,28 ≈ 0,122 req/ms = 122 req/s, tốc độ đến 90,9 req/s
→ **mức tải tổng ≈ 74%**. Hệ thống đủ sức nếu chia đúng, nhưng s3 chỉ chịu được ≈ 17,5 req/s.

### 4.2 Bảng tổng hợp

| Thuật toán | Makespan (ms) | Chờ TB (ms) | Phản hồi TB (ms) | p95 (ms) | Quá tải (lần) | % s0 | % s1 | % s2 | % s3 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Round Robin | 4988,5 | 298,2 | 335,1 | 1713,5 | 18 | 25,0 | 25,0 | 25,0 | 25,0 |
| Least Connections | **3397,6** | **20,4** | **52,5** | **170,6** | **0** | 34,7 | 23,3 | 29,0 | 13,0 |
| IP Hash | 8743,0 | 1048,1 | 1091,2 | 4754,3 | 8 | 23,3 | 21,3 | 14,0 | 41,3 |
| Least Response Time | 3858,5 | 57,3 | 90,2 | 264,9 | 15 | 26,0 | 33,3 | 27,0 | 13,7 |

### 4.3 Chi tiết theo server

| Thuật toán | % thời gian xử lý s0/s1/s2/s3 | Utilization s0/s1/s2/s3 | Thời gian quá tải s3 (ms) | Kết nối mở tối đa s3 |
|---|---|---|---:|---:|
| Round Robin | 21,1 / 16,5 / 17,7 / **44,7** | 47% / 37% / 39% / **99%** | 4383 | 35 |
| Least Connections | 27,8 / 29,5 / 20,8 / 21,9 | 79% / 84% / 59% / 62% | 0 | 3 |
| IP Hash | 13,0 / 9,5 / 10,4 / **67,2** | 19% / 14% / 15% / **99%** | 7883 | 70 |
| Least Response Time | 24,3 / 28,6 / 21,2 / 25,9 | 62% / 73% / 54% / 66% | 632 | 7 |

Số lần vượt ngưỡng theo server: RR [8, 5, 3, 2], LC [0, 0, 0, 0], IP Hash [6, 1, 0, 1], LRT [4, 5, 4, 2].

### 4.4 Ảnh hưởng sticky client

| Thuật toán | Makespan không sticky | Makespan sticky 25% | Makespan sticky 50% | Chờ TB không sticky | Chờ TB sticky 25% | Chờ TB sticky 50% |
|---|---:|---:|---:|---:|---:|---:|
| Round Robin | 4988,5 | 4988,5 | 4988,5 | 298,2 | 298,2 | 298,2 |
| Least Connections | 3397,6 | 3397,6 | 3397,6 | 20,4 | 20,4 | 20,4 |
| IP Hash | 4224,9 | 8743,0 | **10607,4** | 147,1 | 1048,1 | **1951,7** |
| Least Response Time | 3858,5 | 3858,5 | 3858,5 | 57,3 | 57,3 | 57,3 |

Phân bố 83 request của `10.0.0.99` (sticky 25%): RR [26, 19, 19, 19], LC [34, 16, 20, 13],
**IP Hash [0, 0, 0, 83]**, LRT [25, 29, 18, 11].

### 4.5 Kiểm tra với các seed khác (độ ổn định của kết luận)

| Seed | RR makespan / %s3 | LC makespan / %s3 | IP Hash makespan / %s3 | LRT makespan / %s3 |
|---|---|---|---|---|
| 1 | 3600 / 25,0 | 3287 / 14,7 | 6289 / 39,3 | 3445 / 13,0 |
| 2 | 5173 / 25,0 | 3473 / 15,0 | 9849 / 44,7 | 3546 / 17,0 |
| 3 | 5164 / 25,0 | 3282 / 15,3 | 7258 / 38,0 | 3246 / 8,3 |
| 4 | 5799 / 25,0 | 3679 / 13,7 | 8629 / 41,3 | 3733 / 11,3 |
| 5 | 4614 / 25,0 | 3238 / 12,3 | 7900 / 38,7 | 3333 / 7,3 |

Thứ hạng giữ nguyên qua các seed: LC và LRT tốt nhất (makespan sát nhau, LRT nhỉnh hơn ở seed 3), RR ở giữa, IP Hash kém nhất. RR luôn chia s3 đúng 25%.

## 5. Phân tích từng thuật toán

### 5.1 Round Robin

s3 nhận đúng 25% request (75/300) dù chậm gấp đôi. s3 nhận ≈ 22,7 req/s trong khi chỉ xử lý được
≈ 17,5 req/s → **mức tải của s3 ≈ 130% > 100%**, hàng đợi s3 tăng liên tục suốt thời gian request đến
(tối đa 35 kết nối mở), utilization s3 = 99% trong khi s0–s2 chỉ 37–47%. Makespan 4988 ms là do
s3 phải "trả nợ" hàng đợi sau khi request cuối đã đến (3300 ms).

**Lưu ý về chỉ số quá tải:** tổng số lần vượt ngưỡng của RR là 18 — **nhiều nhất trong 4 thuật toán**,
đúng tiêu chí đề. Nhưng riêng s3 chỉ vượt ngưỡng **2 lần**, ít hơn s0 (8 lần). Lý do: s3 vượt ngưỡng
sớm và **nằm trên ngưỡng gần như liên tục 4383 ms**, nên chỉ được đếm 2 lần; còn s0 dao động quanh
ngưỡng nhiều lần nhưng mỗi lần rất ngắn (tổng 300 ms). Vì "đếm lần vượt ngưỡng" không phản ánh mức
độ nghiêm trọng, đồ án bổ sung chỉ số **thời gian quá tải**.

### 5.2 Least Connections

Tốt nhất ở mọi chỉ số với seed 42: không lần nào quá tải, chờ TB 20,4 ms. s3 chỉ nhận 13,0% request
nhưng chiếm 21,9% thời gian xử lý — gần đúng tỷ lệ năng lực của s3 (17,5/122 ≈ 14% số request).
LC **tự né server chậm** mà không cần biết hệ số chậm: request trên s3 xử lý lâu hơn nên giữ kết nối
lâu hơn, làm số kết nối mở của s3 cao hơn và s3 ít được chọn. Thông tin dùng (số kết nối) là
**tức thời**, không có độ trễ.

### 5.3 IP Hash

Toàn bộ 83/83 request của `10.0.0.99` vào s3 — đúng server yếu. s3 nhận 41,3% request, chiếm 67,2%
thời gian xử lý, mức tải s3 ≈ 2,1 lần năng lực; tối đa 70 kết nối mở, quá tải liên tục 7883 ms. Makespan
8743 ms, gấp 2,6 lần LC. Số lần quá tải chỉ là 8 (ít hơn RR) vì cùng lý do ở 5.1: s3 nằm trên ngưỡng
suốt thời gian chạy.

Ngay cả **không có sticky client**, IP Hash vẫn kém (makespan 4225 ms, 24 lần quá tải — nhiều nhất)
vì 50 IP băm không đều và thuật toán không xét trạng thái server. Khi tăng sticky lên 50%, makespan
tăng lên 10607 ms. Kết luận: IP Hash **ưu tiên giữ session (session stickiness) hơn cân bằng tải**;
nó chỉ phù hợp khi bắt buộc giữ phiên và lượng client đủ lớn, phân tán.

### 5.4 Least Response Time

s3 nhận 13,7% request (≤ 20%, đạt tiêu chí), chiếm 25,9% thời gian xử lý — LRT **phát hiện và bù trừ
server yếu** vì response time trên s3 luôn cao hơn. Tuy vậy LRT **kém hơn LC** trong lần chạy này
(chờ TB 57,3 so với 20,4 ms; 15 lần quá tải so với 0). Nguyên nhân:

1. `avg_rt` chỉ cập nhật khi có request **hoàn thành**, và là trung bình của 10 request gần nhất →
   thông tin bị **trễ**. Trong khoảng giữa 2 lần hoàn thành, nhiều request liên tiếp có thể dồn vào
   cùng server "đang có avg_rt đẹp" (hiệu ứng bầy đàn), làm kết nối mở tăng vọt rồi mới giảm.
2. `avg_rt` đã bao gồm thời gian chờ (đã phản ánh hàng đợi), lại nhân thêm `(open + 1)` → hàng đợi bị
   tính 2 lần, score dao động mạnh.
3. Giá trị khởi tạo 1 ms làm các request đầu tiên dồn vào server chưa có số liệu.

Qua 5 seed khác, makespan của LRT sát LC và có lúc tốt hơn (seed 3), nên có thể kết luận LRT và LC ở cùng nhóm tốt, còn
LC ổn định hơn trong mô hình này.

### 5.5 So với kỳ vọng của đề

| Tiêu chí | Kết quả | Đạt |
|---|---|---|
| Cùng seed → kết quả y hệt | Có test `test_deterministic` | ✔ |
| RR: s3 ~25%, quá tải nhiều nhất | 25,0%; 18 lần (nhiều nhất), s3 quá tải 4383 ms | ✔ (xem chú thích 5.1) |
| LC, LRT: % s3 giảm rõ, LRT ≤ ~20% | LC 13,0%, LRT 13,7% | ✔ |
| IP Hash: sticky IP vào đúng 1 server | 83/83 vào s3 | ✔ |
| Preset đồng nhất: 4 thuật toán gần như nhau | Xem mục 6 | ✔ |

Điểm lệch so với kỳ vọng thông thường, ghi nhận trung thực: (1) số lần vượt ngưỡng **của riêng s3**
dưới RR không phải nhiều nhất; (2) LRT không tốt hơn LC trong seed 42.

## 6. Điều kiện để 4 thuật toán cho kết quả giống nhau

Preset **"Hệ thống đồng nhất"**: 0% request nặng, không có server yếu, 0% sticky client.

| Thuật toán | Makespan | Chờ TB | Phản hồi TB | p95 | Quá tải |
|---|---:|---:|---:|---:|---:|
| Round Robin | 3308,0 | 0,0 | 10,9 | 15,5 | 0 |
| Least Connections | 3308,0 | 0,0 | 10,9 | 15,5 | 0 |
| IP Hash | 3308,0 | 1,7 | 12,6 | 22,9 | 0 |
| Least Response Time | 3308,0 | 0,0 | 10,9 | 15,5 | 0 |

Makespan giống hệt, phản hồi TB chênh tối đa khoảng 15% (chỉ IP Hash hơi kém). Điều kiện:

1. Request có thời gian xử lý gần bằng nhau (không có request nặng).
2. Các server cùng năng lực.
3. Client phân tán (không có IP chiếm tỷ trọng lớn).
4. Tải đủ thấp để hiếm khi có hàng đợi.

Lưu ý: ở preset này **phân bố request** của LC rất lệch (s0 52,7%, s3 4,0%) vì khi mọi server rảnh,
quy tắc hòa điểm luôn chọn index nhỏ nhất. Điều này **không ảnh hưởng hiệu năng** (chờ TB vẫn 0 ms).

## 7. Khuyến nghị theo bối cảnh

| Bối cảnh hệ thống | Thuật toán nên dùng | Lý do |
|---|---|---|
| Server đồng nhất, request đều nhau | Round Robin | Đơn giản, không cần theo dõi trạng thái, kết quả ngang các thuật toán khác |
| Request dài ngắn khác nhau | Least Connections | Số kết nối phản ánh tức thời việc server đang bận |
| Cần giữ session | IP Hash (hoặc sticky session bằng cookie) | Cùng client luôn về cùng server; chấp nhận lệch tải |
| Server năng lực khác nhau | Least Connections hoặc Least Response Time | Cả hai tự né server yếu; LRT cần cửa sổ đo phù hợp |

## 8. Hạn chế và hướng phát triển

**Hạn chế**

- Mỗi server chỉ có 1 worker FIFO; server thật thường xử lý song song nhiều request.
- Không mô phỏng độ trễ mạng, timeout, retry, server hỏng.
- Load balancer có thông tin trạng thái **tức thời, chính xác** (thực tế phải qua health check).
- Chỉ 300 request → kết quả dao động theo seed (mục 4.5).
- Thời gian xử lý phân phối đều, chưa có phân phối đuôi dài (heavy-tailed).

**Hướng phát triển**

- Server nhiều worker (M/M/c), thêm Weighted Round Robin / Weighted Least Connections.
- Power of Two Choices, Consistent Hashing cho IP Hash.
- Chạy nhiều seed và vẽ khoảng tin cậy.
- Thử nghiệm trên server thật (NGINX/HAProxy) để đối chiếu với mô phỏng.

## 9. Tài liệu tham khảo

1. NGINX Documentation — *HTTP Load Balancing*: https://docs.nginx.com/nginx/admin-guide/load-balancer/http-load-balancer/
2. HAProxy Documentation — *Configuration Manual, `balance` keyword*: https://docs.haproxy.org/
3. AWS — *Elastic Load Balancing User Guide* (routing algorithms): https://docs.aws.amazon.com/elasticloadbalancing/
4. L. M. Leemis, S. K. Park — *Discrete-Event Simulation: A First Course*, Prentice Hall, 2006.
5. Python Documentation — `random`, `heapq`, `hashlib`, `statistics`.
