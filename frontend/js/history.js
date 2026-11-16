// Lịch sử chuyển thuật toán: mỗi giai đoạn (1 thuật toán) là 1 sơ đồ Load Balancer cho thấy
// LB đã chia request cho các server thế nào. Đổi thuật toán -> thêm 1 sơ đồ mới bên cạnh, nhìn là thấy
// cách chia thay đổi. Sơ đồ của giai đoạn đang chạy cập nhật trực tiếp (tin WebSocket "history" mỗi giây).

const MAX_SEGMENT_PANELS = 6;

const HistoryView = {
  data: null,
  names: {},
  panels: new Map(), // id giai đoạn -> {card, panel}
  SOURCE: { manual: "Chọn tay", advice: "Theo đề xuất", run: "Bắt đầu gửi", start: "Khởi động" },

  init(algorithms) {
    algorithms.forEach((a) => { this.names[a.key] = a.name; });
    document.getElementById("btn-hist-clear").addEventListener("click", async () => {
      try {
        this.update(await Api.post("/api/history/clear"));
      } catch (err) {
        setStatus(document.getElementById("hist-status"), "Lỗi: " + err.message, true);
      }
    });
  },

  name(key) {
    return this.names[key] || key;
  },

  change(prev, cur) {
    if (prev === null || cur === null || prev === undefined || cur === undefined || prev === 0) return null;
    return (100 * (cur - prev)) / prev;
  },

  update(msg) {
    this.data = msg;
    const has = msg.segments.some((s) => s.count > 0);
    document.getElementById("hist-empty").hidden = has;
    document.getElementById("hist-body").hidden = !has;
    if (!has) {
      this.clearPanels();
      return;
    }
    this.renderHeadline();
    this.renderFlow();
    this.renderTable();
  },

  // Giai đoạn có request (giai đoạn đang chạy luôn hiện, kể cả chưa có request)
  shownSegments() {
    const segs = this.data.segments;
    const list = segs.filter((s, i) => s.count > 0 || i === segs.length - 1);
    return list.slice(-MAX_SEGMENT_PANELS);
  },

  // Dòng nổi bật: lần đổi thuật toán gần nhất làm chờ TB thay đổi thế nào
  renderHeadline() {
    const segs = this.data.segments.filter((s) => s.avg_wait !== null);
    const el = document.getElementById("hist-headline");
    if (segs.length < 2) {
      el.className = "hist-headline";
      el.innerHTML = "Đang chạy <b>" + escapeHtml(this.name(this.data.segments[this.data.segments.length - 1].algo)) +
        "</b>. Đổi thuật toán trong lúc gửi request để thấy Load Balancer chia tải khác đi thế nào.";
      return;
    }
    const prev = segs[segs.length - 2];
    const cur = segs[segs.length - 1];
    const pct = this.change(prev.avg_wait, cur.avg_wait);
    const better = pct !== null && pct < 0;
    el.className = "hist-headline " + (better ? "good" : "bad");
    el.innerHTML = (cur.source === "advice" ? "Đổi theo đề xuất: " : "Lần đổi gần nhất: ") +
      "<b>" + escapeHtml(this.name(prev.algo)) + "</b> → <b>" + escapeHtml(this.name(cur.algo)) + "</b>. " +
      "Chờ TB <b>" + fmtMs(prev.avg_wait) + "</b> → <b>" + fmtMs(cur.avg_wait) + "</b>" +
      (pct === null ? "" : " (" + (better ? "giảm " : "tăng ") + fmt(Math.abs(pct), 0) + "%)") +
      ", thời gian quá tải " + fmt(prev.overload_s, 1) + " → " + fmt(cur.overload_s, 1) + " giây.";
  },

  clearPanels() {
    this.panels.forEach((p) => p.card.remove());
    this.panels.clear();
  },

  // Dãy sơ đồ: giai đoạn 1 → giai đoạn 2 → …
  renderFlow() {
    const flow = document.getElementById("hist-flow");
    const shown = this.shownSegments();
    const ids = new Set(shown.map((s) => s.id));
    this.panels.forEach((p, id) => {
      if (!ids.has(id)) {
        p.card.remove();
        this.panels.delete(id);
      }
    });
    const lastId = this.data.segments[this.data.segments.length - 1].id;
    const threshold = this.data.threshold || 5;
    let prev = null;
    shown.forEach((seg, k) => {
      let p = this.panels.get(seg.id);
      if (!p) {
        const card = document.createElement("div");
        card.className = "seg-card";
        card.innerHTML = '<div class="seg-head"><span class="seg-step"></span><span class="seg-meta"></span></div>' +
          '<div class="seg-body"></div><div class="seg-foot"></div>';
        const factors = seg.servers.map((s) => s.factor);
        const panel = new SegmentPanel(card.querySelector(".seg-body"), seg.algo, this.name(seg.algo),
          factors.length ? factors : [1, 1, 1, 1]);
        p = { card: card, panel: panel };
        this.panels.set(seg.id, p);
      }
      flow.appendChild(p.card); // giữ đúng thứ tự thời gian
      const live = seg.id === lastId;
      p.card.classList.toggle("is-live", live);
      p.card.style.setProperty("--algo-color", cssVar("--algo-" + seg.algo));
      p.card.querySelector(".seg-step").textContent = "Giai đoạn " + (k + 1) + (live ? " · đang chạy" : "");
      p.card.querySelector(".seg-meta").textContent = seg.started_at + " – " + (seg.ended_at || "nay") +
        " · " + (this.SOURCE[seg.source] || seg.source);
      p.panel.infoEl.textContent = seg.count + " request";
      if (seg.servers.length) p.panel.draw(seg, threshold);

      const foot = p.card.querySelector(".seg-foot");
      let html = "Chờ TB <b>" + fmtMs(seg.avg_wait) + "</b> · quá tải <b>" + fmt(seg.overload_s, 1) + " giây</b> (" +
        seg.overloads + " lần)";
      const pct = prev ? this.change(prev.avg_wait, seg.avg_wait) : null;
      if (pct !== null) {
        html += ' · <span class="' + (pct < 0 ? "delta-good" : "delta-bad") + '">' +
          (pct < 0 ? "▼ giảm " : "▲ tăng ") + fmt(Math.abs(pct), 0) + "% so với " + escapeHtml(this.name(prev.algo)) + "</span>";
      }
      foot.innerHTML = html;
      if (seg.avg_wait !== null) prev = seg;
    });
  },

  renderTable() {
    const segs = this.data.segments.filter((s) => s.count > 0);
    const serverNames = [];
    segs.forEach((s) => s.servers.forEach((x) => { if (serverNames.indexOf(x.name) < 0) serverNames.push(x.name); }));
    serverNames.sort();
    let html = "<thead><tr><th>Thuật toán</th><th>Thời gian</th><th>Cách đổi</th><th>Request</th>" +
      "<th>Chờ TB</th><th>So với giai đoạn trước</th><th>p95 phản hồi</th>" +
      "<th>Kết nối mở<span class=\"sub\">lớn nhất</span></th><th>Thời gian quá tải<span class=\"sub\">tổng các server</span></th>" +
      "<th>Quá tải<span class=\"sub\">số lần vượt ngưỡng</span></th>" +
      "<th>Chia tải<span class=\"sub\">" + serverNames.join(" / ") + "</span></th></tr></thead><tbody>";
    let prev = null;
    const lastId = this.data.segments[this.data.segments.length - 1].id;
    segs.forEach((s) => {
      const isCur = s.id === lastId;
      const pct = prev ? this.change(prev.avg_wait, s.avg_wait) : null;
      const cmp = pct === null ? "–" : '<span class="' + (pct < 0 ? "delta-good" : "delta-bad") + '">' +
        (pct < 0 ? "▼ giảm " : "▲ tăng ") + fmt(Math.abs(pct), 0) + "%</span>";
      html += "<tr" + (isCur ? ' class="current"' : "") + "><td>" +
        '<span class="swatch" style="background:' + cssVar("--algo-" + s.algo) + '"></span>' + escapeHtml(this.name(s.algo)) +
        (isCur ? '<span class="pill">đang chạy</span>' : "") + "</td><td class=\"mono\">" + s.started_at +
        " – " + (s.ended_at || "nay") + "</td><td>" + (s.source === "advice" ? '<span class="pill ok">Theo đề xuất</span>'
          : escapeHtml(this.SOURCE[s.source] || s.source)) + "</td><td>" + s.count + (s.errors ? " (" + s.errors + " lỗi)" : "") +
        "</td><td><b>" + fmtMs(s.avg_wait) + "</b></td><td>" + cmp + "</td><td>" + fmtMs(s.p95_response, 0) +
        "</td><td>" + s.max_open + "</td><td>" + fmt(s.overload_s, 1) + " giây</td><td>" + s.overloads +
        "</td><td class=\"mono\">" + serverNames.map((k) => fmt(s.per_server[k] || 0, 0) + "%").join(" / ") + "</td></tr>";
      if (s.avg_wait !== null) prev = s;
    });
    document.getElementById("hist-table").innerHTML = html + "</tbody>";
  },
};
