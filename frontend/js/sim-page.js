// Trang Mô phỏng: chạy 4 thuật toán trên cùng bộ request sinh theo tham số, xếp hạng,
// rồi đưa thuật toán tối ưu nhất vào Load Balancer thật.

let player = null;
let cluster = null;   // cấu hình cụm server thật (từ /api/defaults)
let lastData = null;

// ---------- Xếp hạng & áp dụng cho LB thật ----------

// Tiêu chí: thời gian chờ TB thấp nhất; bằng nhau thì xét makespan, rồi số lần quá tải.
function rankAlgorithms(data) {
  const R = data.results;
  return data.algorithms.slice().sort((x, y) => {
    const a = R[x.key].metrics;
    const b = R[y.key].metrics;
    return (a.avg_wait - b.avg_wait) || (a.makespan - b.makespan) || (a.overload_total - b.overload_total);
  });
}

// Tham số server của mô phỏng có khớp với cụm server thật không?
function matchesCluster(params) {
  const c = cluster.params;
  return params.num_servers === c.num_servers && params.num_slow_servers === c.num_slow_servers &&
    (c.num_slow_servers === 0 || Number(params.slow_factor) === Number(c.slow_factor));
}

function renderRanking(data) {
  const ranked = rankAlgorithms(data);
  const best = ranked[0];
  let html = "<thead><tr><th>Hạng</th><th>Thuật toán</th><th>Chờ TB<span class=\"sub\">ms</span></th>" +
    "<th>Makespan<span class=\"sub\">ms</span></th><th>Quá tải<span class=\"sub\">lần</span></th></tr></thead><tbody>";
  ranked.forEach((a, i) => {
    const m = data.results[a.key].metrics;
    html += "<tr" + (i === 0 ? ' class="winner"' : "") + "><td>#" + (i + 1) + "</td><td>" +
      '<span class="swatch" style="background:' + cssVar("--algo-" + a.key) + '"></span>' + a.name +
      "</td><td>" + fmt(m.avg_wait) + "</td><td>" + fmt(m.makespan, 0) + "</td><td>" + m.overload_total + "</td></tr>";
  });
  document.getElementById("rank-table").innerHTML = html + "</tbody>";
  document.getElementById("best-name").textContent = best.name;

  const btn = document.getElementById("btn-apply");
  const only = document.getElementById("btn-apply-only");
  const note = document.getElementById("apply-note");
  note.className = "status";
  only.textContent = "Áp dụng " + best.name + " cho LB";
  btn.textContent = "Áp dụng & chạy đo " + data.requests.length + " request";
  btn.dataset.algo = best.key;
  only.dataset.algo = best.key;
  const ok = matchesCluster(data.params);
  btn.disabled = !ok;
  only.disabled = !ok;
  if (ok) {
    note.textContent = "\"Áp dụng cho LB\": mọi request tới " + cluster.lb_url + " từ giờ dùng " + best.name +
      ". \"Chạy đo\": áp dụng rồi cho client gửi đúng bộ request này (seed " + data.params.seed + ") để kiểm chứng.";
  } else {
    const c = cluster.params;
    note.textContent = "Tham số server khác cụm server thật (" + c.num_servers + " server, " + c.num_slow_servers +
      " server yếu ×" + c.slow_factor + "). Đặt lại tham số server để áp dụng cho LB thật.";
  }
}

async function applyOnly() {
  const btn = document.getElementById("btn-apply-only");
  const note = document.getElementById("apply-note");
  try {
    const st = await Api.post("/api/lb/algorithm", { algorithm: btn.dataset.algo });
    setStatus(note, "Load Balancer đã chuyển sang " + st.algorithm_name + ". Mọi request mới tới " + cluster.lb_url + " dùng thuật toán này.");
  } catch (err) {
    setStatus(note, "Lỗi: " + err.message, true);
  }
}

async function applyBest() {
  const btn = document.getElementById("btn-apply");
  const note = document.getElementById("apply-note");
  btn.disabled = true;
  try {
    const res = await Api.post("/api/runs", { algorithm: btn.dataset.algo, params: lastData.params });
    window.location.href = "/runs.html?run=" + res.run.id;
  } catch (err) {
    setStatus(note, "Lỗi: " + err.message, true);
    btn.disabled = false;
  }
}

// ---------- Luồng chạy ----------

async function runSimulation() {
  const btn = document.getElementById("btn-run");
  const status = document.getElementById("status");
  const params = Settings.read();
  btn.disabled = true;
  setStatus(status, "Đang chạy mô phỏng…");
  try {
    const [data, sticky] = await Promise.all([
      Api.post("/api/simulate", params),
      Api.post("/api/sticky-compare", params),
    ]);
    lastData = data;
    player.load(data.algorithms.map((a) => ({ algo: a, data: data })));
    renderTable(data);
    renderRanking(data);
    Charts.render(data, sticky);
    renderAnalysis(data);
    document.getElementById("btn-csv").href = Api.csvUrl(data.params);
    setStatus(status, "Xong: " + data.requests.length + " request, seed " + data.params.seed + ". Bấm Phát ở phần dưới.");
  } catch (err) {
    setStatus(status, "Lỗi: " + err.message, true);
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const live = document.getElementById("live-player");
  live.innerHTML = playerHtml() + legendHtml();
  player = new Player(live);
  Charts.init();
  document.getElementById("btn-apply").addEventListener("click", applyBest);
  document.getElementById("btn-apply-only").addEventListener("click", applyOnly);
  try {
    const res = await Api.get("/api/defaults");
    cluster = res.cluster;
    Settings.init(res.defaults);
    // Chỉ gắn nút Run sau khi form đã có giá trị mặc định
    document.getElementById("btn-run").addEventListener("click", runSimulation);
    await runSimulation();
  } catch (err) {
    setStatus(document.getElementById("status"), "Không kết nối được backend: " + err.message, true);
  }
});
