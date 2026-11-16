// Trang Tổng quan: điều khiển LB, đánh giá & đề xuất thuật toán từ traffic thật,
// lưu lượng trực tiếp, bảng server, phân tích chi tiết.

let livePanel = null;
let lastState = null;
let algoSelectTouched = false; // người dùng đang chọn thì không ghi đè ô chọn
let snapPlayer = null;

const THRESHOLD_DEFAULT = 5;

function threshold(state) {
  return state.run ? state.run.overload_threshold : THRESHOLD_DEFAULT;
}

function algoName(state, key) {
  const a = state.algorithms.find((x) => x.key === key);
  return a ? a.name : key;
}

// ---------- Điều khiển ----------

function renderControl(state) {
  const sel = document.getElementById("algo-select");
  if (!sel.options.length) state.algorithms.forEach((a) => sel.add(new Option(a.name, a.key)));
  if (!algoSelectTouched) sel.value = state.algorithm;
  document.getElementById("st-total").textContent = state.total;
  document.getElementById("st-errors").textContent = state.errors;
  document.getElementById("st-open").textContent = state.servers.reduce((a, s) => a + s.open, 0);
  const run = state.run;
  const runEl = document.getElementById("st-run");
  if (run && run.status === "running") {
    runEl.innerHTML = '<a href="/runs.html?run=' + run.id + '">#' + run.id + ": " + run.completed + "/" + run.total + "</a>";
  } else {
    runEl.textContent = "Không có";
  }
  const busy = !!(run && (run.status === "running" || run.status === "saving"));
  document.getElementById("btn-reset-counters").disabled = busy;
  document.getElementById("btn-quick-run").disabled = busy;
}

async function applyAlgorithm(key) {
  const status = document.getElementById("lb-status");
  try {
    const st = await Api.post("/api/lb/algorithm", { algorithm: key });
    algoSelectTouched = false;
    document.getElementById("algo-select").value = st.algorithm;
    setStatus(status, "Đã chuyển sang " + st.algorithm_name + ". Request mới dùng thuật toán này.");
    onState(Object.assign({}, lastState, st, { events: [] }));
  } catch (err) {
    setStatus(status, "Lỗi: " + err.message, true);
  }
}

async function quickRun() {
  const status = document.getElementById("qr-status");
  const count = Number(document.getElementById("qr-count").value);
  try {
    const res = await Api.post("/api/runs", { algorithm: lastState.algorithm, params: { num_requests: count } });
    setStatus(status, "Đã bắt đầu lượt đo #" + res.run.id + " (" + count + " request).");
  } catch (err) {
    setStatus(status, "Lỗi: " + err.message, true);
  }
}

// ---------- Đánh giá & đề xuất ----------

function overloadedServers(state) {
  const th = threshold(state);
  return state.servers.filter((s) => s.open >= th);
}

function renderAdvisor(state) {
  const adv = state.advice;
  const box = document.getElementById("advisor");
  const title = document.getElementById("adv-title");
  const sub = document.getElementById("adv-sub");
  const tag = document.getElementById("adv-tag");
  const btn = document.getElementById("btn-switch");
  const wrap = document.getElementById("adv-table-wrap");
  const foot = document.getElementById("adv-foot");
  const live = document.getElementById("adv-live");

  // Dòng trạng thái trực tiếp: server nào đang quá tải
  const over = overloadedServers(state);
  live.innerHTML = over.length
    ? "Hiện tại: " + over.map((s) => "<b>" + s.name + "</b> " + s.open + " kết nối mở").join(", ") +
      " (ngưỡng quá tải " + threshold(state) + ")"
    : "Hiện tại: không server nào quá tải.";
  live.className = "advisor-live" + (over.length ? " bad" : "");

  if (!adv) {
    box.dataset.level = "idle";
    tag.textContent = "Đánh giá & đề xuất";
    title.textContent = "Chưa đủ traffic để đánh giá";
    sub.textContent = "Cần ít nhất 20 request trong 20 giây gần nhất. Gửi traffic tới Load Balancer " +
      "(trang Chạy thật hoặc lệnh python -m backend.client) để hệ thống mô phỏng 4 thuật toán trên chính traffic đó.";
    btn.hidden = true;
    wrap.hidden = true;
    foot.textContent = "";
    return;
  }

  const rows = adv.rows;
  const cur = rows.find((r) => r.key === adv.current);
  const best = rows[0];
  const curName = algoName(state, adv.current);

  if (adv.suggest) {
    box.dataset.level = over.length ? "bad" : "warn";
    tag.textContent = over.length ? "Phát hiện tắc nghẽn" : "Có thuật toán tốt hơn";
    title.textContent = "Đề xuất chuyển sang " + best.name;
    sub.innerHTML = "Mô phỏng trên " + adv.count + " request thật vừa qua: chờ TB với <b>" + escapeHtml(curName) +
      "</b> là <b>" + fmt(cur.avg_wait) + " ms</b>, với <b>" + escapeHtml(best.name) + "</b> chỉ còn <b>" +
      fmt(best.avg_wait) + " ms</b> (giảm " + fmt(adv.gain_pct, 0) + "%).";
    btn.hidden = false;
    btn.textContent = "Chuyển sang " + best.name;
    btn.dataset.algo = best.key;
  } else {
    box.dataset.level = "ok";
    tag.textContent = "Ổn định";
    title.textContent = curName + " đang phù hợp với traffic hiện tại";
    sub.textContent = best.key === adv.current
      ? "Trong 4 thuật toán, " + curName + " cho thời gian chờ TB thấp nhất trên " + adv.count + " request thật vừa qua."
      : "Thuật toán tốt nhất (" + best.name + ") chỉ hơn " + fmt(adv.gain_ms) + " ms chờ TB, chưa đáng để đổi.";
    btn.hidden = true;
  }

  // Bảng so sánh: thanh ngang theo chờ TB để nhìn nhanh
  const maxWait = Math.max.apply(null, rows.map((r) => r.avg_wait)) || 1;
  const slowLabel = adv.slow_servers.map((i) => "s" + i).join(", ") || "server yếu";
  let html = "<thead><tr><th>Thuật toán</th><th class=\"bar-col\">Chờ TB<span class=\"sub\">mô phỏng, ms</span></th>" +
    "<th>p95 phản hồi<span class=\"sub\">ms</span></th><th>Hàng đợi lớn nhất</th>" +
    "<th>% vào " + slowLabel + "<span class=\"sub\">server yếu</span></th><th>Quá tải<span class=\"sub\">lần</span></th>" +
    "<th></th></tr></thead><tbody>";
  rows.forEach((r, i) => {
    const tags = (r.key === adv.current ? '<span class="pill">đang dùng</span>' : "") +
      (i === 0 ? '<span class="pill ok">tốt nhất</span>' : "");
    const w = Math.max(2, (100 * r.avg_wait) / maxWait);
    html += "<tr" + (r.key === adv.current ? ' class="current"' : "") + "><td>" +
      '<span class="swatch" style="background:' + cssVar("--algo-" + r.key) + '"></span>' + r.name + tags + "</td>" +
      '<td class="bar-col"><div class="hbar"><span style="width:' + w + "%;background:" + cssVar("--algo-" + r.key) +
      '"></span></div><b>' + fmt(r.avg_wait) + "</b></td><td>" + fmt(r.p95_response, 0) + "</td><td>" + r.max_open +
      "</td><td>" + fmt(r.slow_pct) + "%</td><td>" + r.overload_total + "</td><td>" +
      (r.key !== adv.current ? '<button type="button" class="btn-ghost btn-sm" data-algo="' + r.key + '">Dùng</button>' : "") +
      "</td></tr>";
  });
  document.getElementById("adv-table").innerHTML = html + "</tbody>";
  wrap.hidden = false;

  let footText = "Mô phỏng " + adv.count + " request thật trong " + fmt(adv.duration_ms / 1000) +
    " giây gần nhất · cập nhật " + adv.updated_at + ".";
  if (adv.real && adv.real.avg_wait !== null) {
    footText += " Đo thật trong cùng khoảng: chờ TB " + fmt(adv.real.avg_wait) + " ms (" + adv.real.completed +
      " request đã xong, " + adv.real.pending + " đang chờ).";
  }
  foot.textContent = footText;
}

// ---------- Bảng server ----------

function renderServers(state) {
  const th = threshold(state);
  let html = "<thead><tr><th>Server</th><th>Địa chỉ</th><th>Hệ số chậm</th><th>Trạng thái</th>" +
    "<th>Kết nối mở<span class=\"sub\">đang xử lý + chờ</span></th><th>Đã xử lý</th><th>Lỗi</th>" +
    "<th>Phản hồi TB<span class=\"sub\">10 request gần nhất, ms</span></th></tr></thead><tbody>";
  state.servers.forEach((s) => {
    const health = s.up === null ? '<span class="badge">Đang kiểm tra</span>'
      : s.up ? '<span class="badge ok">Hoạt động</span>' : '<span class="badge bad">Mất kết nối</span>';
    html += "<tr><td>" + s.name + "</td><td class=\"mono\">127.0.0.1:" + s.port + "</td><td>×" + s.slow_factor +
      "</td><td>" + health + "</td><td" + (s.open >= th ? ' class="over"' : "") + ">" + s.open + "</td><td>" + s.done +
      "</td><td>" + s.errors + "</td><td>" + fmt(s.avg_rt) + "</td></tr>";
  });
  document.getElementById("server-table").innerHTML = html + "</tbody>";
}

// ---------- Phân tích chi tiết ----------

async function loadSnapshot() {
  const btn = document.getElementById("btn-snapshot");
  const status = document.getElementById("snap-status");
  btn.disabled = true;
  setStatus(status, "Đang mô phỏng 4 thuật toán trên traffic vừa qua…");
  try {
    const data = await Api.get("/api/advisor/snapshot");
    document.getElementById("snap-body").hidden = false;
    snapPlayer.load(data.algorithms.map((a) => ({ algo: a, data: data })));
    renderTable(data);
    Charts.render(data, data.sticky);
    renderAnalysis(data);
    setStatus(status, "Đã phân tích " + data.requests.length + " request thật (" +
      fmt(data.requests[data.requests.length - 1].arrival_time / 1000) + " giây traffic). Bấm Phát để xem 4 thuật toán xử lý song song.");
  } catch (err) {
    setStatus(status, err.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Luồng dữ liệu ----------

let lastSlowRender = 0;
function onState(msg) {
  lastState = msg;
  if (!livePanel) livePanel = new LivePanel(document.getElementById("live-box"), msg.servers);
  livePanel.update(msg);
  renderControl(msg);
  // Bảng cập nhật 4 lần/giây là đủ đọc
  const now = performance.now();
  if (now - lastSlowRender > 250) {
    renderServers(msg);
    renderAdvisor(msg);
    lastSlowRender = now;
  }
}

function onMessage(msg) {
  if (msg.type === "state") onState(msg);
  else if (msg.type === "advice" && lastState) {
    lastState.advice = msg.advice;
    renderAdvisor(lastState);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("legend").innerHTML = legendHtml();
  const snapBox = document.getElementById("snap-player");
  snapBox.innerHTML = playerHtml() + legendHtml();
  snapPlayer = new Player(snapBox);
  Charts.init();

  const sel = document.getElementById("algo-select");
  sel.addEventListener("change", () => { algoSelectTouched = true; });
  document.getElementById("btn-algo").addEventListener("click", () => applyAlgorithm(sel.value));
  document.getElementById("btn-switch").addEventListener("click", (ev) => applyAlgorithm(ev.target.dataset.algo));
  document.getElementById("adv-table").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-algo]");
    if (b) applyAlgorithm(b.dataset.algo);
  });
  document.getElementById("btn-reset-counters").addEventListener("click", async () => {
    try {
      await Api.post("/api/lb/reset");
      setStatus(document.getElementById("lb-status"), "Đã đặt lại bộ đếm");
    } catch (err) {
      setStatus(document.getElementById("lb-status"), "Lỗi: " + err.message, true);
    }
  });
  document.getElementById("btn-snapshot").addEventListener("click", loadSnapshot);
  document.getElementById("btn-quick-run").addEventListener("click", quickRun);

  const defaults = await Api.get("/api/defaults");
  document.getElementById("lb-url").textContent = "Load Balancer nhận traffic tại " + defaults.cluster.lb_url +
    (defaults.cluster.lan_url ? " · máy khác cùng mạng Wi-Fi: " + defaults.cluster.lan_url : "");

  const badge = document.getElementById("ws-status");
  connectLive(onMessage, (ok) => {
    badge.className = "badge " + (ok ? "ok" : "bad");
    badge.textContent = ok ? "Trực tiếp" : "Mất kết nối…";
  });
});
