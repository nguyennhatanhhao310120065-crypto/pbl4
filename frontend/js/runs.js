// Trang Chạy thật: bắt đầu lượt chạy, theo dõi tiến độ, xem lịch sử và đối chiếu thật / mô phỏng.

let livePanel = null;
let player = null;
let compareChart = null;
let algoNames = {};
let shownRunId = null;
let activeRunId = null;
const handledRuns = new Set(); // tránh xử lý "lượt chạy xong" 2 lần (tin run_finished + tin state)

const SERVER_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"];

const STATUS_TEXT = {
  running: '<span class="badge">Đang chạy</span>',
  done: '<span class="badge ok">Hoàn thành</span>',
  failed: '<span class="badge bad">Lỗi</span>',
};

// "Round Robin → Least Connections" nếu đã đổi thuật toán giữa lượt chạy
function scheduleName(r) {
  const sched = r.schedule && r.schedule.length ? r.schedule : [[0, r.algorithm]];
  return sched.map((x) => algoNames[x[1]]).join(" → ");
}

function slowPct(m, params) {
  return slowServers(params).reduce((acc, i) => acc + m.request_pct[i], 0);
}

// ---------- Lịch sử ----------

async function loadRuns() {
  const res = await Api.get("/api/runs");
  algoNames = res.algorithms;
  let html = "<thead><tr><th>#</th><th>Bắt đầu</th><th>Thuật toán</th><th>Seed</th><th>Trạng thái</th>" +
    "<th>Makespan<span class=\"sub\">thật / mô phỏng, ms</span></th>" +
    "<th>Chờ TB<span class=\"sub\">thật / mô phỏng, ms</span></th>" +
    "<th>% server yếu<span class=\"sub\">thật / mô phỏng</span></th>" +
    "<th>Quá tải<span class=\"sub\">thật / mô phỏng</span></th><th></th></tr></thead><tbody>";
  if (!res.runs.length) {
    html += '<tr><td colspan="10" class="empty">Chưa có lượt chạy nào.</td></tr>';
  }
  res.runs.forEach((r) => {
    const m = r.metrics;
    const s = r.sim_metrics;
    const pair = (f, d) => (m && s ? fmt(m[f], d) + " / " + fmt(s[f], d) : "–");
    const slow = slowServers(r.params).length && m && s
      ? fmt(slowPct(m, r.params)) + "% / " + fmt(slowPct(s, r.params)) + "%" : "–";
    html += "<tr><td>" + r.id + "</td><td>" + escapeHtml(r.created_at) + "</td><td>" + escapeHtml(scheduleName(r)) +
      "</td><td>" + r.params.seed + "</td><td>" + STATUS_TEXT[r.status] +
      (r.error ? ' <span class="hint-inline" title="' + escapeHtml(r.error) + '">' + escapeHtml(r.error) + "</span>" : "") +
      "</td><td>" + pair("makespan", 0) + "</td><td>" + pair("avg_wait", 1) + "</td><td>" + slow +
      "</td><td>" + pair("overload_total", 0) + "</td><td class=\"row-actions\">" +
      (r.status !== "running" && m ? '<button type="button" class="btn-ghost btn-sm" data-view="' + r.id + '">Xem</button>' : "") +
      (r.status !== "running" ? '<button type="button" class="btn-ghost btn-sm" data-del="' + r.id + '">Xóa</button>' : "") +
      "</td></tr>";
  });
  const table = document.getElementById("runs-table");
  table.innerHTML = html + "</tbody>";
  table.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => showRun(Number(b.dataset.view))));
  table.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => deleteRun(Number(b.dataset.del))));
}

async function deleteRun(id) {
  try {
    await Api.del("/api/runs/" + id);
    if (shownRunId === id) document.getElementById("detail").hidden = true;
    await loadRuns();
  } catch (err) {
    setStatus(document.getElementById("status"), "Lỗi: " + err.message, true);
  }
}

// ---------- Chi tiết 1 lượt chạy ----------

function renderCompare(run, sim) {
  const m = run.metrics;
  const n = run.params.num_servers;
  const slow = slowServers(run.params);
  const rows = [
    ["Makespan (ms)", "makespan", 1],
    ["Thời gian chờ TB (ms)", "avg_wait", 1],
    ["Phản hồi TB (ms)", "avg_response", 1],
    ["Phản hồi p95 (ms)", "p95_response", 1],
    ["Số lần quá tải", "overload_total", 0],
  ];
  let html = "<thead><tr><th>Chỉ số</th><th>Chạy thật</th><th>Mô phỏng</th><th>Chênh lệch</th></tr></thead><tbody>";
  const line = (label, a, b, d, unit) => {
    const diff = b ? ((a - b) / b) * 100 : 0;
    html += "<tr><td>" + label + "</td><td>" + fmt(a, d) + unit + "</td><td>" + fmt(b, d) + unit + "</td><td>" +
      (b ? (diff >= 0 ? "+" : "") + fmt(diff) + "%" : "–") + "</td></tr>";
  };
  rows.forEach((r) => line(r[0], m[r[1]], sim[r[1]], r[2], ""));
  for (let i = 0; i < n; i++) {
    line("% request s" + i + (slow.indexOf(i) >= 0 ? " (yếu ×" + run.params.slow_factor + ")" : ""),
      m.request_pct[i], sim.request_pct[i], 1, "%");
  }
  document.getElementById("compare-table").innerHTML = html + "</tbody>";

  const labels = [];
  for (let i = 0; i < n; i++) labels.push("s" + i);
  if (compareChart) compareChart.destroy();
  compareChart = new Chart(document.getElementById("chart-compare"), {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        { label: "Chạy thật", data: m.request_pct, backgroundColor: cssVar("--algo-" + run.algorithm), borderRadius: 4 },
        { label: "Mô phỏng", data: sim.request_pct, backgroundColor: cssVar("--text-muted"), borderRadius: 4 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      plugins: { tooltip: { callbacks: { label: (c) => c.dataset.label + ": " + c.parsed.y.toFixed(1) + "%" } } },
      scales: {
        y: { beginAtZero: true, title: { display: true, text: "% số request", color: cssVar("--text-muted") } },
        x: { grid: { display: false } },
      },
    },
  });
}

async function showRun(id) {
  try {
    const run = await Api.get("/api/runs/" + id);
    if (!run.metrics) return;
    shownRunId = id;
    const algo = { key: run.algorithm, name: run.algorithm_name };
    const title = scheduleName(run);
    const switched = run.schedule.length > 1;

    document.getElementById("detail").hidden = false;
    document.getElementById("detail-title").textContent = "Lượt #" + run.id + " · " + title;
    document.getElementById("detail-csv").href = "/api/runs/" + run.id + "/export.csv";
    document.getElementById("detail-note").textContent =
      run.params.num_requests + " request, seed " + run.params.seed + ", " + run.params.arrival_rate +
      " req/s · bắt đầu " + run.created_at + (run.error ? " · " + run.error : "") +
      ". Thời gian chờ thật gồm cả chờ hàng đợi server lẫn độ trễ mạng/proxy (~1 ms)." +
      (switched ? " Đổi thuật toán lúc: " + run.schedule.slice(1).map((x) => fmt(x[0] / 1000) + " s → " +
        algoNames[x[1]]).join(", ") + "; bản mô phỏng đối chiếu đổi đúng các thời điểm này." : "");

    renderCompare(run, run.sim.metrics);
    const realData = {
      params: run.params,
      requests: run.requests,
      results: { [run.algorithm]: { assignments: run.assignments, events: run.events, metrics: run.metrics } },
    };
    const simData = { params: run.params, requests: run.requests, results: { [run.algorithm]: run.sim } };
    player.load([
      { algo: algo, data: realData, title: title + " — chạy thật" },
      { algo: algo, data: simData, title: title + " — mô phỏng" },
    ]);
    document.getElementById("detail").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    setStatus(document.getElementById("status"), "Lỗi: " + err.message, true);
  }
}

// ---------- Lượt chạy mới ----------

function renderProgress(run) {
  const bar = document.getElementById("progress");
  const active = !!(run && (run.status === "running" || run.status === "saving"));
  document.getElementById("btn-start").disabled = active;
  bar.hidden = !active;
  if (active) {
    document.getElementById("progress-bar").style.width = (100 * run.completed / run.total) + "%";
    setStatus(document.getElementById("status"), "Lượt #" + run.id + " (" + scheduleName(run) + "): " +
      (run.status === "saving" ? "đang lưu kết quả…" : run.completed + "/" + run.total + " request"));
  }
}

async function onRunFinished(run) {
  if (handledRuns.has(run.id)) return;
  handledRuns.add(run.id);
  activeRunId = null;
  renderProgress(null);
  setStatus(document.getElementById("status"), "Lượt #" + run.id + (run.status === "done" ? " hoàn thành." : " kết thúc với lỗi."),
    run.status !== "done");
  await loadRuns();
  await showRun(run.id);
}

function onMessage(msg) {
  if (msg.type === "run_finished") {
    onRunFinished(msg.run);
    return;
  }
  if (msg.type !== "state") return;
  if (!livePanel) livePanel = new LivePanel(document.getElementById("live-box"), msg.servers);
  livePanel.update(msg);
  if (msg.run && (msg.run.status === "running" || msg.run.status === "saving")) {
    if (activeRunId !== msg.run.id) {
      activeRunId = msg.run.id;
      loadRuns();
    }
    renderProgress(msg.run);
  } else if (msg.run && msg.run.id === activeRunId && (msg.run.status === "done" || msg.run.status === "failed")) {
    // Lượt chạy xong trong lúc WebSocket đang nối lại -> không nhận được tin run_finished
    onRunFinished(msg.run);
  }
}

async function startRun() {
  const status = document.getElementById("status");
  const btn = document.getElementById("btn-start");
  btn.disabled = true;
  try {
    const res = await Api.post("/api/runs", {
      algorithm: document.getElementById("algo-select").value,
      params: Settings.read(),
    });
    activeRunId = res.run.id;
    renderProgress(res.run);
    await loadRuns();
  } catch (err) {
    setStatus(status, "Lỗi: " + err.message, true);
    btn.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("legend").innerHTML = legendHtml();
  const replay = document.getElementById("replay");
  replay.innerHTML = playerHtml();
  player = new Player(replay);
  Chart.defaults.color = cssVar("--text-2");
  Chart.defaults.borderColor = cssVar("--border");

  try {
    const [defaults, lb] = await Promise.all([Api.get("/api/defaults"), Api.get("/api/lb")]);
    Settings.init(defaults.defaults);
    const c = defaults.cluster;
    document.getElementById("cluster-note").textContent = "Cụm server thật: " +
      c.servers.map((s) => s.name + " (:" + s.port + (s.slow_factor !== 1 ? ", ×" + s.slow_factor : "") + ")").join(", ") +
      " · Load Balancer " + c.lb_url + ".";
    const sel = document.getElementById("algo-select");
    lb.algorithms.forEach((a) => sel.add(new Option(a.name, a.key)));
    sel.value = lb.algorithm;

    document.getElementById("btn-start").addEventListener("click", startRun);
    await loadRuns();
    const q = new URLSearchParams(location.search).get("run");
    const running = lb.run && (lb.run.status === "running" || lb.run.status === "saving");
    if (running) {
      activeRunId = lb.run.id;
      renderProgress(lb.run);
    } else if (q) {
      await showRun(Number(q));
    }
  } catch (err) {
    setStatus(document.getElementById("status"), "Lỗi: " + err.message, true);
  }
  connectLive(onMessage);
});
