// Vẽ sơ đồ "Load Balancer → các server" trên Canvas.
//  - PanelBase: vẽ cổng LB, ô server, hàng đợi, thanh kết nối mở, chấm request bay.
//  - AlgoPanel: 1 sơ đồ thuật toán, cập nhật theo thời gian thực từ WebSocket.

const CANVAS_W = 560;
const CANVAS_H = 290;
const GATE = { x: CANVAS_W / 2 - 64, y: 12, w: 128, h: 34 };
const BOX_BOTTOM = 272;
const BOX_W = 86;
const BOX_H = 104;
const SLOW_SCALE = 0.75;   // server yếu vẽ nhỏ hơn
const BAR_W = 8;
const DOT_R = 4.5;
const MAX_QUEUE_DOTS = 12; // số chấm tối đa vẽ trong ô, còn lại ghi "+k"

class PanelBase {
  // slowFactors: hệ số chậm từng server (1 = bình thường)
  constructor(container, name, color, slowFactors) {
    this.name = name;
    this.color = color;
    this.factors = slowFactors;
    this.buildDom(container);
    this.computeLayout();
  }

  buildDom(container) {
    const panel = document.createElement("div");
    panel.className = "sim-panel";
    panel.style.setProperty("--algo-color", this.color);
    panel.innerHTML =
      '<div class="sim-head">' +
      '  <span class="name"></span>' +
      '  <span class="info mono"></span>' +
      "</div>" +
      "<canvas></canvas>";
    this.nameEl = panel.querySelector(".name");
    this.nameEl.textContent = this.name;
    this.infoEl = panel.querySelector(".info");

    this.canvas = panel.querySelector("canvas");
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = CANVAS_W * dpr;
    this.canvas.height = CANVAS_H * dpr;
    this.ctx = this.canvas.getContext("2d");
    this.ctx.scale(dpr, dpr);
    container.appendChild(panel);
    this.el = panel;
  }

  // Tính vị trí ô của từng server (chia đều theo chiều ngang)
  computeLayout() {
    const n = this.factors.length;
    const slotW = CANVAS_W / n;
    const scaleAll = Math.min(1, (slotW - 26) / BOX_W); // nhiều server thì thu nhỏ
    this.boxes = [];
    for (let i = 0; i < n; i++) {
      const s = scaleAll * (this.factors[i] !== 1 ? SLOW_SCALE : 1);
      const w = BOX_W * s;
      const h = BOX_H * s;
      const cx = slotW * (i + 0.5) - (BAR_W + 6) / 2;
      this.boxes.push({ x: cx - w / 2, y: BOX_BOTTOM - h, w: w, h: h, cx: cx });
    }
  }

  drawGate() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = cssVar("--surface-2");
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1.5;
    roundRect(ctx, GATE.x, GATE.y, GATE.w, GATE.h, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = cssVar("--text");
    ctx.font = "600 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Load Balancer", GATE.x + GATE.w / 2, GATE.y + GATE.h / 2);
  }

  // queue: danh sách request {kind, client_ip} đang nằm trong server (chấm đầu là đang xử lý)
  // down: true = mất kết nối, "off" = admin đã tắt server (vẽ mờ, nét đứt)
  // overloadedOverride: true/false để tự quyết ô có đỏ không (sơ đồ lịch sử), bỏ trống = theo open >= threshold
  drawServer(i, open, done, queue, threshold, stickyIp, down, overloadedOverride) {
    const ctx = this.ctx;
    const b = this.boxes[i];
    const off = down === "off";
    const overloaded = overloadedOverride === undefined ? open >= threshold : overloadedOverride;
    const danger = cssVar("--danger");
    ctx.globalAlpha = off ? 0.45 : 1;

    // Ô server: chuyển đỏ khi quá tải
    ctx.fillStyle = overloaded ? "rgba(229, 72, 77, 0.35)" : off ? cssVar("--bg") : cssVar("--surface-2");
    ctx.strokeStyle = overloaded || (down && !off) ? danger : off ? cssVar("--text-muted") : cssVar("--border");
    ctx.lineWidth = overloaded ? 2 : 1;
    if (down) ctx.setLineDash([4, 3]);
    roundRect(ctx, b.x, b.y, b.w, b.h, 8);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);

    // Nhãn tên server + hệ số chậm
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillStyle = cssVar("--text-2");
    ctx.fillText("s" + i, b.x + 7, b.y + 6);
    if (this.factors[i] !== 1) {
      ctx.textAlign = "right";
      ctx.fillStyle = cssVar("--req-heavy");
      ctx.fillText("×" + this.factors[i], b.x + b.w - 7, b.y + 6);
    }

    // Số request đã xử lý xong (server tắt ghi "TẮT", mất kết nối ghi "LỖI")
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = off ? cssVar("--text-2") : down ? danger : cssVar("--text");
    const label = off ? "TẮT" : down ? "LỖI" : String(done);
    ctx.font = "700 " + Math.round(b.h * (down ? 0.2 : 0.26)) + "px system-ui, sans-serif";
    ctx.fillText(label, b.cx, b.y + b.h * 0.42);

    const r = 3;
    const perRow = Math.max(1, Math.floor((b.w - 10) / (r * 2 + 3)));
    queue.slice(0, MAX_QUEUE_DOTS).forEach((req, k) => {
      const row = Math.floor(k / perRow);
      const col = k % perRow;
      const x = b.x + 8 + r + col * (r * 2 + 3);
      const y = b.y + b.h * 0.68 + row * (r * 2 + 3);
      this.drawDot(x, y, req, stickyIp, r);
    });
    if (queue.length > MAX_QUEUE_DOTS) {
      ctx.font = "600 10px system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.fillStyle = cssVar("--text-2");
      ctx.fillText("+" + (queue.length - MAX_QUEUE_DOTS), b.x + b.w - 5, b.y + b.h - 9);
    }

    // Thanh dọc = số kết nối mở. Thang đo = 2 lần ngưỡng để vạch ngưỡng nằm giữa.
    const barX = b.x + b.w + 6;
    const scaleMax = Math.max(threshold * 2, 4);
    const fillH = Math.min(open / scaleMax, 1) * b.h;
    ctx.fillStyle = cssVar("--bg");
    ctx.strokeStyle = cssVar("--border");
    ctx.lineWidth = 1;
    roundRect(ctx, barX, b.y, BAR_W, b.h, 3);
    ctx.fill();
    ctx.stroke();
    if (fillH > 0) {
      ctx.fillStyle = overloaded ? danger : cssVar("--ok");
      roundRect(ctx, barX, b.y + b.h - fillH, BAR_W, fillH, 3);
      ctx.fill();
    }
    // Vạch ngưỡng quá tải
    const ty = b.y + b.h - (threshold / scaleMax) * b.h;
    ctx.strokeStyle = cssVar("--text-muted");
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(barX - 2, ty);
    ctx.lineTo(barX + BAR_W + 2, ty);
    ctx.stroke();
    ctx.setLineDash([]);
    // Số kết nối mở ghi trên đầu thanh
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = overloaded ? danger : cssVar("--text-2");
    ctx.fillText(String(open), barX + BAR_W / 2, b.y - 3);
    ctx.globalAlpha = 1;
  }

  // Chấm bay từ cổng xuống ô server, p = tiến độ 0..1
  drawFlying(server, p, req, stickyIp) {
    const ease = 1 - Math.pow(1 - p, 2);
    const b = this.boxes[server];
    const x0 = GATE.x + GATE.w / 2;
    const y0 = GATE.y + GATE.h;
    this.drawDot(x0 + (b.cx - x0) * ease, y0 + (b.y - 4 - y0) * ease, req, stickyIp);
  }

  // Chấm trắng = nhẹ, cam = nặng, viền tím = sticky client
  drawDot(x, y, req, stickyIp, radius) {
    const ctx = this.ctx;
    const r = radius || DOT_R;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = req.kind === "heavy" ? cssVar("--req-heavy") : cssVar("--req-light");
    ctx.fill();
    if (req.client_ip === stickyIp) {
      ctx.lineWidth = r > 3 ? 2 : 1.5;
      ctx.strokeStyle = cssVar("--sticky");
      ctx.stroke();
    }
  }
}

// 1 sơ đồ thuật toán trên trang Tổng quan, cập nhật theo thời gian thực từ WebSocket.
// Sơ đồ của thuật toán đang chạy vẽ bằng số liệu LB thật, 3 sơ đồ còn lại vẽ bằng cụm server ảo
// (mô phỏng trực tiếp trên cùng luồng request). Sự kiện được gửi kèm "g" = thuật toán của sơ đồ.
class AlgoPanel extends PanelBase {
  constructor(container, algo, slowFactors) {
    super(container, algo.name, cssVar("--algo-" + algo.key), slowFactors);
    this.key = algo.key;
    this.inflight = new Map(); // id -> {s, kind, client_ip, at}
    this.servers = slowFactors.map(() => ({ open: 0, done: 0, up: null }));
    this.threshold = 5;
    this.stickyIp = null;
    this.FLY_MS = 250;

    // Thêm nhãn trạng thái + nút chuyển vào phần đầu sơ đồ
    this.tagsEl = document.createElement("span");
    this.tagsEl.className = "sim-tags";
    this.nameEl.after(this.tagsEl);
    this.foot = document.createElement("div");
    this.foot.className = "sim-foot";
    this.foot.innerHTML = '<span class="sim-wait"></span>' +
      '<button type="button" class="btn-primary btn-switch" hidden></button>';
    this.waitEl = this.foot.querySelector(".sim-wait");
    this.switchBtn = this.foot.querySelector(".btn-switch");
    this.switchBtn.dataset.algo = algo.key;
    this.el.appendChild(this.foot); // dưới canvas: 4 sơ đồ luôn thẳng hàng dù có nút hay không
  }

  // Số server hoặc hệ số chậm thay đổi (admin chỉnh cụm server): tính lại vị trí các ô
  setFactors(factors) {
    if (factors.join() === this.factors.join()) return;
    this.factors = factors.slice();
    this.computeLayout();
  }

  addEvent(e, now) {
    if (e.e === "a") this.inflight.set(e.id, { s: e.s, kind: e.k, client_ip: e.ip, at: now });
    else this.inflight.delete(e.id);
  }

  // Phòng mất sự kiện "f" (VD: tab bị ẩn lâu): bỏ request treo quá 2 phút
  dropStale(now) {
    for (const [id, r] of this.inflight) if (now - r.at > 120000) this.inflight.delete(id);
  }

  draw() {
    const now = performance.now();
    this.drawGate();
    const queues = this.servers.map(() => []);
    const flying = [];
    for (const r of this.inflight.values()) {
      if (now - r.at < this.FLY_MS) flying.push(r);
      else if (queues[r.s]) queues[r.s].push(r);
    }
    const n = Math.min(this.servers.length, this.boxes.length);
    for (let i = 0; i < n; i++) {
      const s = this.servers[i];
      const status = s.enabled === false ? "off" : s.up === false;
      this.drawServer(i, s.open, s.done, queues[i], this.threshold, this.stickyIp, status);
    }
    // Server vừa bị bớt: bỏ qua chấm còn bay tới nó
    for (const r of flying) {
      if (r.s < n) this.drawFlying(r.s, (now - r.at) / this.FLY_MS, r, this.stickyIp);
    }
  }
}

// Sơ đồ 1 giai đoạn trong lịch sử: LB đã chia request của giai đoạn đó cho các server thế nào.
//  - Đường nối LB → server dày theo % request, ghi % trên đường.
//  - Số trong ô = số request server nhận; thanh dọc = hàng đợi lớn nhất (đỏ nếu từng vượt ngưỡng quá tải).
class SegmentPanel extends PanelBase {
  constructor(container, algo, name, factors) {
    super(container, name, cssVar("--algo-" + algo), factors);
    this.algo = algo;
    this.statsEl = document.createElement("div");
    this.statsEl.className = "seg-stats";
    this.el.appendChild(this.statsEl);
  }

  draw(seg, threshold) {
    const factors = seg.servers.map((s) => s.factor);
    if (factors.join() !== this.factors.join()) {
      this.factors = factors;
      this.computeLayout();
    }
    this.drawGate();
    const ctx = this.ctx;
    const x0 = GATE.x + GATE.w / 2;
    const y0 = GATE.y + GATE.h;
    // Đường chia tải (vẽ trước để nằm dưới ô server)
    seg.servers.forEach((s, i) => {
      const b = this.boxes[i];
      if (!b || !s.count) return;
      ctx.strokeStyle = this.color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1.5 + (s.pct / 100) * 22;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x0, y0 + 2);
      ctx.lineTo(b.cx, b.y - 18);
      ctx.stroke();
      ctx.globalAlpha = 1;
      // Nhãn % ở giữa đường
      const mx = x0 + (b.cx - x0) * 0.55;
      const my = y0 + (b.y - 18 - y0) * 0.55;
      const label = fmt(s.pct, 0) + "%";
      ctx.font = "700 12px system-ui, sans-serif";
      const w = ctx.measureText(label).width + 10;
      ctx.fillStyle = cssVar("--bg");
      roundRect(ctx, mx - w / 2, my - 9, w, 18, 9);
      ctx.fill();
      ctx.fillStyle = cssVar("--text");
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, mx, my);
    });
    seg.servers.forEach((s, i) => {
      // Đỏ khi quá tải đáng kể (>= 1 giây), không tô đỏ vì vượt ngưỡng chớp nhoáng
      if (this.boxes[i]) {
        this.drawServer(i, s.max_open, s.count, [], threshold, null, s.enabled === false ? "off" : false,
          s.overload_s >= 1);
      }
    });

    // Chờ TB từng server (HTML dưới sơ đồ)
    this.statsEl.innerHTML = "";
    seg.servers.forEach((s) => {
      const cell = document.createElement("div");
      cell.className = "seg-stat" + (s.overload_s >= 1 ? " over" : "");
      const n = document.createElement("b");
      n.textContent = s.name + (s.factor !== 1 ? " ×" + String(s.factor).replace(".", ",") : "");
      cell.appendChild(n);
      cell.appendChild(document.createTextNode(" chờ " + fmtMs(s.avg_wait, 0) +
        (s.overload_s >= 1 ? " · quá tải " + fmt(s.overload_s, 1) + " giây" : "")));
      this.statsEl.appendChild(cell);
    });
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Chú thích ký hiệu dùng chung
function legendHtml() {
  return '' +
    '<ul class="legend">' +
    '  <li><span class="dot dot-light"></span>Request nhẹ (Light)</li>' +
    '  <li><span class="dot dot-heavy"></span>Request nặng (Heavy)</li>' +
    '  <li><span class="dot dot-sticky"></span>Viền tím: sticky client</li>' +
    '  <li><span class="box-sample">12</span>Số đã xử lý xong (Done)</li>' +
    '  <li><span class="bar-sample"></span>Kết nối mở (Open conn.)</li>' +
    '  <li><span class="box-sample box-over"></span>Quá tải (Overload)</li>' +
    '  <li><span class="box-sample box-small">×2</span>Server yếu (Slow)</li>' +
    '  <li><span class="box-sample box-off">TẮT</span>Server đang tắt</li>' +
    "</ul>";
}
