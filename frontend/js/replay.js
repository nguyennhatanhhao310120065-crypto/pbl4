// Tua lại & chỉnh tốc độ cho 4 sơ đồ thuật toán.
//  - Recorder: ghi mọi request (lúc đến, lúc xong, server, IP) của lượt gửi hiện tại trên cả 4 sơ đồ,
//    theo thời điểm thật t (ms) do backend gắn vào từng sự kiện.
//  - Player: 3 cách xem
//      trực tiếp          : vẽ theo thời gian thực như cũ.
//      tua theo thời gian : vẽ trạng thái tại thời điểm ảo vt, vt chạy theo tốc độ (0,1× = chậm 10 lần).
//      từng request một   : mỗi lần chỉ 1 request bay từ LB xuống server, đáp xong mới tới request kế tiếp.
//                           Cả 4 sơ đồ cùng chiếu đúng request đó; trạng thái server là trạng thái thật
//                           tại lúc request đó tới LB.

const FLY_V = 250;            // ms ảo chấm bay từ Load Balancer xuống server (tua theo thời gian)
const STEP_MS = 140;          // ms thật cho 1 request ở 1× (chế độ từng request một)
const STEP_FLY = 0.75;        // phần đầu của mỗi bước là chấm bay, phần còn lại là chấm đã đáp
const STALE_MS = 120000;      // request không nhận được sự kiện "xong" sau 2 phút thì bỏ (mất sự kiện)
const MAX_RECORDED = 200000;  // số request tối đa ghi lại mỗi sơ đồ
const SPEEDS = [0.05, 0.1, 0.25, 0.5, 1, 2];

function fmtSpeed(s) {
  return String(s).replace(".", ",") + "×";
}

const Recorder = {
  panels: {},   // key thuật toán -> {reqs: [], byId: Map, sorted}
  order: [],    // mỗi request 1 lần, theo thứ tự tới LB: {id, n, ta}
  orderSorted: true,
  rankById: new Map(), // id -> vị trí trong order (request thứ mấy tới LB)
  lastT: -Infinity,
  synthT: new Map(),   // backend cũ: id -> thời điểm tự gán (cùng 1 request trên 4 sơ đồ dùng chung)
  seenIds: new Set(),
  t0: null,     // thời điểm sự kiện đầu tiên
  tLast: null,  // thời điểm sự kiện mới nhất

  reset() {
    this.panels = {};
    this.order = [];
    this.orderSorted = true;
    this.rankById = new Map();
    this.lastT = -Infinity;
    this.synthT = new Map();
    this.seenIds = new Set();
    this.t0 = null;
    this.tLast = null;
  },

  hasData() {
    return this.t0 !== null;
  },

  add(e, recvNow) {
    // Backend cũ không gửi t: dùng lúc nhận, nhưng giữ đúng thứ tự (cả lô 0,1 giây không bị coi là tới cùng lúc)
    // Cùng 1 request xuất hiện trên cả 4 sơ đồ phải có cùng thời điểm đến, nếu không 3 sơ đồ mô phỏng bị
    // coi là "chưa tới" khi chiếu request đó.
    let t = e.t;
    if (t == null) {
      if (e.e === "a" && this.synthT.has(e.id)) {
        t = this.synthT.get(e.id);
      } else {
        t = Math.max(recvNow, this.lastT + 0.01);
        this.lastT = t;
        if (e.e === "a") this.synthT.set(e.id, t);
      }
    }
    let P = this.panels[e.g];
    if (!P) P = this.panels[e.g] = { reqs: [], byId: new Map(), sorted: true };
    if (e.e === "a") {
      if (P.reqs.length >= MAX_RECORDED) return;
      const n = e.n != null ? e.n : e.id;
      const r = { id: e.id, n: n, s: e.s, k: e.k, ip: e.ip, ta: t, tf: null, ok: true };
      const last = P.reqs[P.reqs.length - 1];
      if (last && last.ta > t) P.sorted = false;
      P.reqs.push(r);
      P.byId.set(e.id, r);
      // Cùng 1 request thật xuất hiện trên cả 4 sơ đồ (cùng id): chỉ ghi 1 lần vào thứ tự chung
      if (!this.seenIds.has(e.id)) {
        this.seenIds.add(e.id);
        const lastO = this.order[this.order.length - 1];
        if (lastO && lastO.ta > t) this.orderSorted = false;
        this.order.push({ id: e.id, n: n, ta: t });
        if (this.orderSorted) this.rankById.set(e.id, this.order.length - 1);
      }
    } else {
      const r = P.byId.get(e.id);
      if (!r) return;
      r.tf = Math.max(t, r.ta);
      r.ok = e.ok !== false;
      P.byId.delete(e.id);
    }
    if (this.t0 === null || t < this.t0) this.t0 = t;
    if (this.tLast === null || t > this.tLast) this.tLast = t;
  },

  orderList() {
    if (!this.orderSorted) {
      this.order.sort((a, b) => a.ta - b.ta);
      this.orderSorted = true;
      this.rankById = new Map(this.order.map((o, i) => [o.id, i]));
    }
    return this.order;
  },

  reqs(key) {
    const P = this.panels[key];
    if (!P) return [];
    if (!P.sorted) {
      P.reqs.sort((a, b) => a.ta - b.ta);
      P.sorted = true;
    }
    return P.reqs;
  },

  // Trạng thái 1 sơ đồ tại thời điểm vt: hàng đợi, chấm đang bay, kết nối mở, số đã xong, dòng bảng IP.
  // opts.flyV: thời gian bay (ms ảo); opts.focusId / focusP: request đang được chiếu (từng request một)
  // và tiến độ bay của nó (0..1, >= 1 là đã đáp); opts.maxRank: chỉ tính các request có thứ tự <= maxRank
  // (request chưa tới lượt thì chưa hiện, kể cả khi cùng thời điểm với request đang chiếu).
  view(key, vt, n, opts) {
    const flyV = opts && opts.flyV != null ? opts.flyV : FLY_V;
    const maxRank = opts && opts.maxRank != null ? opts.maxRank : null;
    if (maxRank !== null) this.orderList(); // cập nhật rankById
    const ranks = this.rankById;
    const later = (r) => maxRank !== null && !(ranks.get(r.id) <= maxRank);
    const focusId = opts ? opts.focusId : null;
    const focusP = opts ? opts.focusP : 1;
    const reqs = this.reqs(key);
    // Từng request một: request nào hiện do số thứ tự quyết định (later), nên nới thêm 50 ms để thời điểm
    // lệch chút ít giữa sơ đồ thật và 3 sơ đồ mô phỏng không làm mất chấm
    const tLimit = maxRank !== null ? vt + 50 : vt;
    let lo = 0, hi = reqs.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (reqs[m].ta <= tLimit) lo = m + 1; else hi = m;
    }
    const end = lo; // số request đã tới LB tính đến vt
    const queues = [], open = [], done = [], recv = [], rows = [];
    for (let i = 0; i < n; i++) { queues.push([]); open.push(0); done.push(0); recv.push(0); rows.push([]); }
    const flying = [];
    let doneTotal = 0;
    let focusServer = null;
    for (let i = 0; i < end; i++) {
      const r = reqs[i];
      if (r.s >= n || later(r)) continue;
      recv[r.s]++;
      const age = vt - r.ta;
      const finished = r.tf !== null && r.tf <= vt;
      if (finished) {
        if (r.ok) done[r.s]++;
        doneTotal++;
      } else if (r.tf === null && age > STALE_MS) {
        continue;
      } else {
        open[r.s]++;
      }
      const dot = { s: r.s, kind: r.k, client_ip: r.ip, n: r.n };
      if (r.id === focusId) {
        focusServer = r.s;
        if (focusP < 1) {
          dot.p = focusP;
          dot.focus = true;
          flying.push(dot);
          continue;
        }
      } else if (flyV > 0 && age < flyV) {
        // Chấm vẫn bay hết đường dù request nhẹ đã xong trước khi chấm tới nơi
        dot.p = age / flyV;
        flying.push(dot);
        continue;
      }
      if (!finished) queues[r.s].push(dot);
    }
    let need = n;
    for (let i = end - 1; i >= 0 && need > 0; i--) {
      const r = reqs[i];
      if (r.s >= n || rows[r.s].length >= IP_ROWS || later(r)) continue;
      rows[r.s].push(r);
      if (rows[r.s].length === IP_ROWS) need--;
    }
    return { end, open, done, recv, queues, flying, rows, doneTotal, focusServer };
  },
};

const Player = {
  mode: "live",      // "live" | "replay"
  stepMode: true,    // true = từng request một (mặc định: mỗi lượt gửi tự chiếu lần lượt), false = theo thời gian
  playing: true,
  speed: 1,
  vt: null,          // thời điểm ảo đang xem (tua theo thời gian; null = chờ request đầu tiên)
  k: 0,              // request đang chiếu (từng request một), chỉ số trong Recorder.orderList()
  phase: 0,          // tiến độ trong bước hiện tại (0..1)
  trail: true,
  lastFrame: null,
  dragging: false,
  panels: null,      // {key: AlgoPanel}
  isRunActive: () => false,

  init(panels, isRunActive) {
    this.panels = panels;
    this.isRunActive = isRunActive;
    this.el = {
      bar: document.getElementById("replay-bar"),
      live: document.getElementById("rp-live"),
      modes: document.getElementById("rp-modes"),
      restart: document.getElementById("rp-restart"),
      play: document.getElementById("rp-play"),
      next: document.getElementById("rp-next"),
      slider: document.getElementById("rp-slider"),
      time: document.getElementById("rp-time"),
      speeds: document.getElementById("rp-speeds"),
      trail: document.getElementById("rp-trail"),
    };
    const e = this.el;
    e.speeds.innerHTML = '<span class="label">Tốc độ</span>' + SPEEDS.map((s) =>
      '<button type="button" class="btn-sm rp-speed" data-speed="' + s + '">' + fmtSpeed(s) + "</button>").join("");
    e.speeds.addEventListener("click", (ev) => {
      const b = ev.target.closest(".rp-speed");
      if (b) this.setSpeed(Number(b.dataset.speed));
    });
    e.modes.addEventListener("click", (ev) => {
      const b = ev.target.closest(".rp-mode");
      if (b) this.setStepMode(b.dataset.mode === "step");
    });
    e.live.addEventListener("click", () => this.goLive());
    e.restart.addEventListener("click", () => this.restart());
    e.play.addEventListener("click", () => this.togglePlay());
    e.next.addEventListener("click", () => this.stepBy(1));
    e.trail.addEventListener("change", () => { this.trail = e.trail.checked; });
    e.slider.addEventListener("pointerdown", () => { this.dragging = true; });
    window.addEventListener("pointerup", () => { this.dragging = false; });
    e.slider.addEventListener("input", () => this.seek(Number(e.slider.value) / 1000));
    this.updateUi(true);
  },

  each(fn) {
    Object.values(this.panels).forEach(fn);
  },

  // ---------- Điều khiển ----------

  enterReplay(playing) {
    if (this.mode === "live") {
      this.mode = "replay";
      this.each((p) => p.beginReplay());
    }
    this.playing = playing;
    this.updateUi(true);
  },

  goLive() {
    if (this.mode === "replay") {
      this.mode = "live";
      this.each((p) => p.endReplay());
    }
    this.speed = 1;
    this.playing = true;
    this.updateUi(true);
  },

  // Từng request một: luôn chiếu từ request đầu tiên của lượt gửi; tua theo thời gian: chậm lại từ lúc này
  setStepMode(step) {
    if (this.mode === "live") {
      this.stepMode = step;
      if (!step) return this.updateUi(true); // trực tiếp vốn là theo thời gian
      if (this.speed >= 1) this.speed = 0.25;
      this.k = 0;
      this.phase = 0;
      this.enterReplay(true);
      return;
    }
    if (step === this.stepMode) return;
    this.stepMode = step;
    if (step) {
      // Đổi sang từng request: bắt đầu từ request đang xem
      const order = Recorder.orderList();
      const vt = this.vt === null ? -Infinity : this.vt;
      let k = 0;
      while (k + 1 < order.length && order[k + 1].ta <= vt) k++;
      this.k = k;
      this.phase = 0;
    } else {
      const cur = Recorder.orderList()[this.k];
      this.vt = cur ? cur.ta : null;
    }
    this.each((p) => p.resetReplayCache());
    this.updateUi(true);
  },

  setSpeed(s) {
    if (this.mode === "live") {
      if (s >= 1) return; // trực tiếp luôn là 1×; nhanh hơn chỉ dùng khi tua lại
      this.speed = s;
      if (this.stepMode) {
        this.k = 0;
        this.phase = 0;
      } else {
        // Chậm lại từ ngay lúc này; chưa có request thì chờ request đầu tiên rồi chiếu chậm từ đó
        this.vt = Recorder.hasData() ? Recorder.tLast : null;
      }
      this.enterReplay(true);
      return;
    }
    this.speed = s;
    this.playing = true;
    this.updateUi(true);
  },

  togglePlay() {
    if (this.mode === "live") {
      if (!Recorder.hasData()) return;
      // Đứng hình tại lúc này
      if (this.stepMode) {
        this.k = Math.max(0, Recorder.orderList().length - 1);
        this.phase = 1;
      } else {
        this.vt = Recorder.tLast;
      }
      this.enterReplay(false);
      return;
    }
    if (this.playing) {
      this.playing = false;
    } else {
      if (this.atEnd() && !this.isRunActive()) {
        // Đã tới cuối: phát lại từ đầu
        this.k = 0;
        this.phase = 0;
        this.vt = Recorder.t0;
      }
      this.playing = true;
    }
    this.updateUi(true);
  },

  atEnd() {
    if (!Recorder.hasData()) return false;
    if (this.stepMode) return this.k >= Recorder.orderList().length - 1 && this.phase >= 1;
    return this.vt !== null && this.vt >= Recorder.tLast;
  },

  // Request kế tiếp / trước đó (từng request một), dừng phát để xem kỹ
  stepBy(d) {
    if (!Recorder.hasData()) return;
    const len = Recorder.orderList().length;
    if (!this.stepMode) this.setStepMode(true);
    if (this.mode === "live") this.enterReplay(false);
    this.k = Math.max(0, Math.min(len - 1, this.k + d));
    this.phase = 0;
    this.playing = false;
    this.stepping = true; // vẫn cho chấm bay hết đường rồi mới đứng
    this.updateUi(true);
  },

  restart() {
    if (!Recorder.hasData()) return;
    if (this.mode === "live" && this.speed >= 1) this.speed = 0.25; // tua lại từ đầu mặc định chiếu chậm
    this.k = 0;
    this.phase = 0;
    this.vt = Recorder.t0;
    this.enterReplay(true);
  },

  seek(frac) {
    if (!Recorder.hasData()) return;
    if (this.stepMode) {
      const len = Recorder.orderList().length;
      this.k = Math.round(frac * (len - 1));
      this.phase = this.playing && this.mode === "replay" ? 0 : 1;
    } else {
      this.vt = Recorder.t0 + frac * (Recorder.tLast - Recorder.t0);
    }
    if (this.mode === "live") this.enterReplay(false);
    this.each((p) => p.resetReplayCache());
    this.updateUi(true);
  },

  // Lượt gửi mới: chiếu từ request đầu tiên của lượt mới. Đang chọn "Từng request một" thì tự vào chế độ này
  // (kể cả đang xem trực tiếp) để người xem thấy LB chia lần lượt từng request.
  onNewRecording() {
    if (this.mode === "live" && this.stepMode) {
      if (this.speed >= 1) this.speed = 0.25;
      this.k = 0;
      this.phase = 0;
      this.enterReplay(true);
    }
    if (this.mode === "replay") {
      this.vt = null;
      this.k = 0;
      this.phase = 0;
      this.playing = true;
      this.each((p) => p.resetReplayCache());
    }
    this.updateUi(true);
  },

  // ---------- Mỗi khung hình ----------

  tick(now) {
    const dt = this.lastFrame === null ? 0 : Math.min(now - this.lastFrame, 250);
    this.lastFrame = now;
    if (this.mode !== "replay") return;
    if (this.stepMode) this.tickStep(dt);
    else this.tickTime(dt);
  },

  tickStep(dt) {
    const len = Recorder.orderList().length;
    if (!len || this.dragging) return;
    const stepLen = STEP_MS / this.speed;
    if (this.stepping) {
      // Bấm "request kế tiếp": chạy hết 1 bước rồi đứng
      this.phase = Math.min(1, this.phase + dt / stepLen);
      if (this.phase >= 1) this.stepping = false;
      return;
    }
    if (!this.playing) return;
    this.phase += dt / stepLen;
    while (this.phase >= 1) {
      if (this.k + 1 < len) {
        this.k++;
        this.phase -= 1;
      } else {
        this.phase = 1;
        if (!this.isRunActive()) {
          this.playing = false;
          this.updateUi(true);
        }
        break;
      }
    }
  },

  tickTime(dt) {
    if (this.vt === null) {
      if (Recorder.hasData()) this.vt = Recorder.t0;
      return;
    }
    if (!this.playing || this.dragging) return;
    this.vt += dt * this.speed;
    const end = Recorder.tLast;
    if (this.vt >= end) {
      this.vt = end;
      if (this.isRunActive()) {
        if (this.speed >= 1) this.goLive(); // đã đuổi kịp thực tế
      } else {
        this.playing = false;
        this.updateUi(true);
      }
    }
  },

  current() {
    return Recorder.orderList()[this.k] || null;
  },

  draw() {
    if (this.mode !== "replay") {
      this.each((p) => p.draw());
      return;
    }
    const now = performance.now();
    this.each((p) => p.flushLive(now)); // vẫn dọn request trực tiếp đã xong trong lúc tua
    if (this.stepMode) {
      const cur = this.current();
      if (!cur) {
        this.each((p) => p.drawAt(-Infinity, false));
        return;
      }
      const opts = { flyV: 0, focusId: cur.id, focusP: Math.min(1, this.phase / STEP_FLY), maxRank: this.k };
      this.each((p) => p.drawAt(cur.ta, this.trail, opts));
    } else {
      const vt = this.vt === null ? -Infinity : this.vt;
      this.each((p) => p.drawAt(vt, this.trail));
    }
  },

  // ---------- Giao diện ----------

  updateUi(force) {
    const e = this.el;
    if (!e) return;
    const now = performance.now();
    if (!force && now - (this.lastUi || 0) < 60) return;
    this.lastUi = now;

    const has = Recorder.hasData();
    const live = this.mode === "live";
    const step = this.stepMode && !live;
    const order = Recorder.orderList();
    const span = has ? Recorder.tLast - Recorder.t0 : 0;
    const cur = this.current();

    e.bar.dataset.mode = this.mode;
    e.live.classList.toggle("on", live);
    e.live.textContent = live ? "● Trực tiếp" : "Về trực tiếp";
    e.modes.querySelectorAll(".rp-mode").forEach((b) => {
      b.classList.toggle("on", (b.dataset.mode === "step") === this.stepMode);
    });
    const playingNow = live || this.playing;
    e.play.textContent = playingNow ? "⏸" : "▶";
    e.play.setAttribute("aria-label", playingNow ? "Tạm dừng" : "Phát");
    e.play.disabled = !has && live;
    e.restart.disabled = !has;
    e.next.disabled = !has;
    e.slider.disabled = !has;

    let frac, label;
    if (step) {
      frac = order.length > 1 ? this.k / (order.length - 1) : 0;
      label = cur ? "Request " + (this.k + 1) + " / " + order.length : "Request 0 / 0";
    } else {
      const vt = live ? Recorder.tLast : this.vt;
      const pos = has && vt !== null ? Math.max(0, vt - Recorder.t0) : 0;
      frac = span > 0 ? pos / span : (live ? 1 : 0);
      label = fmt(pos / 1000, 3) + " / " + fmt(span / 1000, 3) + " s";
    }
    if (!this.dragging) e.slider.value = Math.round(1000 * frac);
    e.time.textContent = label;

    e.speeds.querySelectorAll(".rp-speed").forEach((b) => {
      const s = Number(b.dataset.speed);
      b.classList.toggle("on", s === (live ? 1 : this.speed));
      b.disabled = live && s > 1;
      b.title = live && s > 1 ? "Chỉ dùng khi tua lại" : (this.stepMode
        ? "Mỗi request mất " + fmt(STEP_MS / s / 1000, 2) + " giây" : "");
    });

  },
};
