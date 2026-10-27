// Vẽ 4 khung mô phỏng trên Canvas và phát lại (replay) theo 1 đồng hồ chung.
// Trạng thái tại thời điểm t được tính lại hoàn toàn từ events/assignments,
// nên tua tới/lui bất kỳ lúc nào cũng đúng, không cần gọi lại API.

// Đọc màu từ biến CSS (:root) để canvas và CSS dùng chung 1 bảng màu.
// Cache lại vì getComputedStyle khá chậm khi gọi mỗi khung hình.
const colorCache = {};
function cssVar(name) {
  if (!(name in colorCache)) {
    colorCache[name] = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  return colorCache[name];
}

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

class SimPanel {
  constructor(container, algo, data) {
    this.key = algo.key;
    this.name = algo.name;
    this.params = data.params;
    this.result = data.results[algo.key];
    this.requests = data.requests;
    this.color = cssVar("--algo-" + algo.key);

    // Server yếu là các server cuối (giống backend config.slow_factors)
    const n = this.params.num_servers;
    const k = Math.min(this.params.num_slow_servers, n - 1);
    this.isSlow = [];
    for (let i = 0; i < n; i++) this.isSlow.push(i >= n - k);

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
    panel.querySelector(".name").textContent = this.name;
    this.infoEl = panel.querySelector(".info");

    this.canvas = panel.querySelector("canvas");
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = CANVAS_W * dpr;
    this.canvas.height = CANVAS_H * dpr;
    this.ctx = this.canvas.getContext("2d");
    this.ctx.scale(dpr, dpr);
    container.appendChild(panel);
  }

  // Tính vị trí ô của từng server (chia đều theo chiều ngang)
  computeLayout() {
    const n = this.params.num_servers;
    const slotW = CANVAS_W / n;
    const scaleAll = Math.min(1, (slotW - 26) / BOX_W); // nhiều server thì thu nhỏ
    this.boxes = [];
    for (let i = 0; i < n; i++) {
      const s = scaleAll * (this.isSlow[i] ? SLOW_SCALE : 1);
      const w = BOX_W * s;
      const h = BOX_H * s;
      const cx = slotW * (i + 0.5) - (BAR_W + 6) / 2;
      this.boxes.push({ x: cx - w / 2, y: BOX_BOTTOM - h, w: w, h: h, cx: cx });
    }
  }

  // Trạng thái server tại thời điểm t, tính từ log events
  stateAt(t) {
    const n = this.params.num_servers;
    const open = new Array(n).fill(0);
    const done = new Array(n).fill(0);
    for (const e of this.result.events) {
      if (e.t > t) break; // events đã được sắp xếp theo thời gian
      open[e.server] = e.open_connections_after;
      if (e.type === "FINISH") done[e.server] += 1;
    }
    return { open: open, done: done };
  }

  draw(t, flySim) {
    const ctx = this.ctx;
    const threshold = this.params.overload_threshold;
    const st = this.stateAt(t);
    const totalDone = st.done.reduce((a, b) => a + b, 0);
    const total = this.requests.length;

    // Thông tin trên đầu khung
    let info = "t = " + t.toFixed(0) + " ms · Xong " + totalDone + "/" + total;
    if (totalDone === total) info += " ✓";
    this.infoEl.textContent = info;

    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // Cổng vào (load balancer)
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

    // Request đang ở trong từng server (đang xử lý + chờ), theo thứ tự đến
    const inServer = this.params.num_servers;
    const queues = [];
    for (let i = 0; i < inServer; i++) queues.push([]);
    const flying = [];
    for (const a of this.result.assignments) {
      if (a.arrival > t) continue;
      if (t - a.arrival < flySim) flying.push(a);
      else if (t < a.finish) queues[a.server].push(a);
    }

    for (let i = 0; i < inServer; i++) {
      this.drawServer(i, st.open[i], st.done[i], queues[i], threshold);
    }

    // Chấm bay từ cổng xuống ô server
    for (const a of flying) {
      const p = (t - a.arrival) / flySim;
      const ease = 1 - Math.pow(1 - p, 2);
      const b = this.boxes[a.server];
      const x0 = GATE.x + GATE.w / 2;
      const y0 = GATE.y + GATE.h;
      const x = x0 + (b.cx - x0) * ease;
      const y = y0 + (b.y - 4 - y0) * ease;
      this.drawDot(x, y, this.requests[a.request_id]);
    }
  }

  drawServer(i, open, done, queue, threshold) {
    const ctx = this.ctx;
    const b = this.boxes[i];
    const overloaded = open >= threshold;
    const danger = cssVar("--danger");

    // Ô server: chuyển đỏ khi quá tải
    ctx.fillStyle = overloaded ? "rgba(229, 72, 77, 0.35)" : cssVar("--surface-2");
    ctx.strokeStyle = overloaded ? danger : cssVar("--border");
    ctx.lineWidth = overloaded ? 2 : 1;
    roundRect(ctx, b.x, b.y, b.w, b.h, 8);
    ctx.fill();
    ctx.stroke();

    // Nhãn tên server + hệ số chậm
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillStyle = cssVar("--text-2");
    ctx.fillText("s" + i, b.x + 7, b.y + 6);
    if (this.isSlow[i]) {
      ctx.textAlign = "right";
      ctx.fillStyle = cssVar("--req-heavy");
      ctx.fillText("×" + this.params.slow_factor, b.x + b.w - 7, b.y + 6);
    }

    // Số request đã xử lý xong
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = cssVar("--text");
    ctx.font = "700 " + Math.round(b.h * 0.26) + "px system-ui, sans-serif";
    ctx.fillText(String(done), b.cx, b.y + b.h * 0.42);

    // Các chấm nhỏ = request đang trong server (chấm đầu là đang xử lý)
    const r = 3;
    const perRow = Math.max(1, Math.floor((b.w - 10) / (r * 2 + 3)));
    const shown = queue.slice(0, MAX_QUEUE_DOTS);
    shown.forEach((a, k) => {
      const row = Math.floor(k / perRow);
      const col = k % perRow;
      const x = b.x + 8 + r + col * (r * 2 + 3);
      const y = b.y + b.h * 0.68 + row * (r * 2 + 3);
      this.drawDot(x, y, this.requests[a.request_id], r);
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
  }

  // Chấm trắng = nhẹ, cam = nặng, viền tím = sticky client
  drawDot(x, y, req, radius) {
    const ctx = this.ctx;
    const r = radius || DOT_R;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = req.kind === "heavy" ? cssVar("--req-heavy") : cssVar("--req-light");
    ctx.fill();
    if (req.client_ip === this.params.sticky_ip) {
      ctx.lineWidth = r > 3 ? 2 : 1.5;
      ctx.strokeStyle = cssVar("--sticky");
      ctx.stroke();
    }
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

// Bộ điều khiển phát lại: 1 đồng hồ chung cho cả 4 khung
const Simulation = {
  panels: [],
  t: 0,
  endT: 0,
  speed: 0.5,
  playing: false,
  lastTs: null,

  init() {
    document.getElementById("btn-play").addEventListener("click", () => this.play());
    document.getElementById("btn-pause").addEventListener("click", () => this.pause());
    document.getElementById("btn-reset").addEventListener("click", () => this.reset());
    document.getElementById("btn-end").addEventListener("click", () => this.skipToEnd());
    const speedEl = document.getElementById("speed");
    this.speed = Number(speedEl.value);
    speedEl.addEventListener("change", () => {
      this.speed = Number(speedEl.value);
      this.render();
    });
    this.slider = document.getElementById("timeline");
    this.slider.addEventListener("input", () => {
      this.t = (Number(this.slider.value) / 1000) * this.endT;
      this.render();
    });
    this.label = document.getElementById("timeline-label");
  },

  load(data) {
    this.pause();
    const grid = document.getElementById("sim-grid");
    grid.innerHTML = "";
    this.panels = data.algorithms.map((algo) => new SimPanel(grid, algo, data));
    // Đồng hồ chạy tới khi thuật toán chậm nhất xong
    this.endT = Math.max.apply(null, this.panels.map((p) => p.result.metrics.makespan));
    this.t = 0;
    this.render();
  },

  // Thời gian bay của chấm tính theo thời gian mô phỏng sao cho mắt người
  // luôn thấy khoảng ~0.25s thật, nhưng không quá dài khi tua nhanh.
  flyDuration() {
    return Math.min(150, Math.max(20, 250 * this.speed));
  },

  render() {
    const fly = this.flyDuration();
    this.panels.forEach((p) => p.draw(this.t, fly));
    this.slider.value = this.endT ? Math.round((this.t / this.endT) * 1000) : 0;
    this.label.textContent = this.t.toFixed(0) + " / " + this.endT.toFixed(0) + " ms";
  },

  play() {
    if (!this.panels.length || this.playing) return;
    if (this.t >= this.endT) this.t = 0;
    this.playing = true;
    this.lastTs = null;
    requestAnimationFrame((ts) => this.tick(ts));
  },

  tick(ts) {
    if (!this.playing) return;
    // 1 ms thật × tốc độ = số ms mô phỏng trôi qua (1× là real-time)
    if (this.lastTs !== null) this.t += (ts - this.lastTs) * this.speed;
    this.lastTs = ts;
    if (this.t >= this.endT) {
      this.t = this.endT;
      this.playing = false;
    }
    this.render();
    if (this.playing) requestAnimationFrame((t2) => this.tick(t2));
  },

  pause() {
    this.playing = false;
  },

  reset() {
    this.pause();
    this.t = 0;
    this.render();
  },

  skipToEnd() {
    this.pause();
    this.t = this.endT;
    this.render();
  },
};
