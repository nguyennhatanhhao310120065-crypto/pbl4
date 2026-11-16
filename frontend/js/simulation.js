// Vẽ khung "Load Balancer → các server" trên Canvas.
//  - SimPanel : phát lại (replay) 1 lượt chạy từ log events/assignments (mô phỏng hoặc chạy thật).
//               Trạng thái tại thời điểm t được tính lại hoàn toàn từ log nên tua tới/lui luôn đúng.
//  - LivePanel: vẽ trạng thái LB thật theo thời gian thực từ WebSocket.
//  - Player   : 1 đồng hồ chung điều khiển nhiều SimPanel chạy song song.

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
  drawServer(i, open, done, queue, threshold, stickyIp, down) {
    const ctx = this.ctx;
    const b = this.boxes[i];
    const overloaded = open >= threshold;
    const danger = cssVar("--danger");

    // Ô server: chuyển đỏ khi quá tải
    ctx.fillStyle = overloaded ? "rgba(229, 72, 77, 0.35)" : cssVar("--surface-2");
    ctx.strokeStyle = overloaded || down ? danger : cssVar("--border");
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

    // Số request đã xử lý xong (server mất kết nối thì ghi "OFF")
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = down ? danger : cssVar("--text");
    ctx.font = "700 " + Math.round(b.h * 0.26) + "px system-ui, sans-serif";
    ctx.fillText(down ? "OFF" : String(done), b.cx, b.y + b.h * 0.42);

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

function factorsFromParams(params) {
  const slow = slowServers(params);
  const out = [];
  for (let i = 0; i < params.num_servers; i++) out.push(slow.indexOf(i) >= 0 ? params.slow_factor : 1);
  return out;
}

// data: { params, requests, results: { [key]: { assignments, events, metrics } } }
class SimPanel extends PanelBase {
  constructor(container, algo, data, title) {
    super(container, title || algo.name, cssVar("--algo-" + algo.key), factorsFromParams(data.params));
    this.params = data.params;
    this.result = data.results[algo.key];
    this.requests = data.requests;
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
    const st = this.stateAt(t);
    const totalDone = st.done.reduce((a, b) => a + b, 0);
    const total = this.result.assignments.length;
    let info = "t = " + t.toFixed(0) + " ms · Xong " + totalDone + "/" + total;
    if (totalDone === total) info += " ✓";
    this.infoEl.textContent = info;

    this.drawGate();
    const n = this.params.num_servers;
    const queues = [];
    for (let i = 0; i < n; i++) queues.push([]);
    const flying = [];
    for (const a of this.result.assignments) {
      if (a.arrival > t) continue;
      if (t - a.arrival < flySim) flying.push(a);
      else if (t < a.finish) queues[a.server].push(this.requests[a.request_id]);
    }
    for (let i = 0; i < n; i++) {
      this.drawServer(i, st.open[i], st.done[i], queues[i], this.params.overload_threshold, this.params.sticky_ip, false);
    }
    for (const a of flying) {
      this.drawFlying(a.server, (t - a.arrival) / flySim, this.requests[a.request_id], this.params.sticky_ip);
    }
  }
}

// Trạng thái LB thật. Gọi update(msg) với mỗi tin WebSocket "state".
class LivePanel extends PanelBase {
  constructor(container, servers) {
    super(container, "Load Balancer thật", cssVar("--primary"), servers.map((s) => s.slow_factor));
    this.inflight = new Map(); // id -> {s, kind, client_ip, at}
    this.state = null;
    this.FLY_MS = 250;
    const loop = () => {
      this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  update(msg) {
    this.state = msg;
    if (msg.algorithm_name) {
      this.nameEl.textContent = msg.algorithm_name;
      this.el.style.setProperty("--algo-color", cssVar("--algo-" + msg.algorithm));
      this.color = cssVar("--algo-" + msg.algorithm);
    }
    const now = performance.now();
    for (const e of msg.events || []) {
      if (e.e === "a") this.inflight.set(e.id, { s: e.s, kind: e.k, client_ip: e.ip, at: now });
      else this.inflight.delete(e.id);
    }
    // Phòng mất sự kiện "f" (VD: tab bị ẩn lâu): bỏ request treo quá 2 phút
    for (const [id, r] of this.inflight) if (now - r.at > 120000) this.inflight.delete(id);
  }

  draw() {
    if (!this.state) return;
    const run = this.state.run;
    const threshold = run ? run.overload_threshold : 5;
    const stickyIp = run ? run.sticky_ip : null;
    const now = performance.now();
    const servers = this.state.servers;
    this.infoEl.textContent = "Tổng " + this.state.total + " request · lỗi " + this.state.errors;

    this.drawGate();
    const queues = servers.map(() => []);
    const flying = [];
    for (const r of this.inflight.values()) {
      if (now - r.at < this.FLY_MS) flying.push(r);
      else queues[r.s].push(r);
    }
    servers.forEach((s, i) => {
      this.drawServer(i, s.open, s.done, queues[i], threshold, stickyIp, s.up === false);
    });
    for (const r of flying) this.drawFlying(r.s, (now - r.at) / this.FLY_MS, r, stickyIp);
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

// Bộ điều khiển phát lại: 1 đồng hồ chung cho các khung trong root.
// root chứa: .js-play .js-pause .js-reset .js-end .js-speed .js-timeline .js-timeline-label .js-grid
class Player {
  constructor(root) {
    this.root = root;
    this.panels = [];
    this.t = 0;
    this.endT = 0;
    this.playing = false;
    this.lastTs = null;
    const q = (c) => root.querySelector(c);
    q(".js-play").addEventListener("click", () => this.play());
    q(".js-pause").addEventListener("click", () => this.pause());
    q(".js-reset").addEventListener("click", () => this.reset());
    q(".js-end").addEventListener("click", () => this.skipToEnd());
    const speedEl = q(".js-speed");
    this.speed = Number(speedEl.value);
    speedEl.addEventListener("change", () => {
      this.speed = Number(speedEl.value);
      this.render();
    });
    this.slider = q(".js-timeline");
    this.slider.addEventListener("input", () => {
      this.t = (Number(this.slider.value) / 1000) * this.endT;
      this.render();
    });
    this.label = q(".js-timeline-label");
    this.grid = q(".js-grid");
  }

  // items: [{algo, data, title?}] — mỗi item 1 khung
  load(items) {
    this.pause();
    this.grid.innerHTML = "";
    this.panels = items.map((it) => new SimPanel(this.grid, it.algo, it.data, it.title));
    // Đồng hồ chạy tới khi khung chậm nhất xong
    this.endT = Math.max.apply(null, this.panels.map((p) => p.result.metrics ? p.result.metrics.makespan : 0));
    this.t = 0;
    this.render();
  }

  // Thời gian bay của chấm tính theo thời gian mô phỏng sao cho mắt người
  // luôn thấy khoảng ~0.25s thật, nhưng không quá dài khi tua nhanh.
  flyDuration() {
    return Math.min(150, Math.max(20, 250 * this.speed));
  }

  render() {
    const fly = this.flyDuration();
    this.panels.forEach((p) => p.draw(this.t, fly));
    this.slider.value = this.endT ? Math.round((this.t / this.endT) * 1000) : 0;
    this.label.textContent = this.t.toFixed(0) + " / " + this.endT.toFixed(0) + " ms";
  }

  play() {
    if (!this.panels.length || this.playing) return;
    if (this.t >= this.endT) this.t = 0;
    this.playing = true;
    this.lastTs = null;
    requestAnimationFrame((ts) => this.tick(ts));
  }

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
  }

  pause() {
    this.playing = false;
  }

  reset() {
    this.pause();
    this.t = 0;
    this.render();
  }

  skipToEnd() {
    this.pause();
    this.t = this.endT;
    this.render();
  }
}

// HTML của bộ điều khiển phát lại (dùng ở trang Mô phỏng và Chạy thật)
function playerHtml() {
  return '' +
    '<div class="player">' +
    '  <button type="button" class="btn-primary js-play">Phát (Play)</button>' +
    '  <button type="button" class="btn-ghost js-pause">Tạm dừng (Pause)</button>' +
    '  <button type="button" class="btn-ghost js-reset">Chạy lại (Reset)</button>' +
    '  <button type="button" class="btn-ghost js-end">Tới cuối (Skip to end)</button>' +
    '  <label class="speed">Tốc độ (Speed)' +
    '    <select class="js-speed">' +
    '      <option value="0.1">0.1×</option><option value="0.25">0.25×</option>' +
    '      <option value="0.5" selected>0.5×</option><option value="1">1× (real-time)</option>' +
    '      <option value="2">2×</option><option value="5">5×</option><option value="10">10×</option>' +
    "    </select>" +
    "  </label>" +
    "</div>" +
    '<div class="timeline">' +
    '  <input type="range" class="js-timeline" min="0" max="1000" value="0" step="1" aria-label="Thời gian">' +
    '  <span class="mono js-timeline-label">0 / 0 ms</span>' +
    "</div>" +
    '<div class="sim-grid js-grid"></div>';
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
    "</ul>";
}
