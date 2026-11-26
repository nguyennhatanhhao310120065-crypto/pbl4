// Trang admin (1 trang duy nhất): chọn thuật toán, đánh giá & đề xuất,
// 4 sơ đồ thuật toán cùng lúc, bảng so sánh, bảng Web Server.

const THRESHOLD_DEFAULT = 5;

let lastState = null;
const panels = {};              // key thuật toán -> AlgoPanel

function threshold(state) {
  return state.run ? state.run.overload_threshold : THRESHOLD_DEFAULT;
}

function runBusy(state) {
  const run = state.run;
  return !!(run && (run.status === "running" || run.status === "saving"));
}

// ---------- Điều khiển ----------

function renderControl(state) {
  // Ô chọn thuật toán cho Load Balancer thật (khóa khi đang gửi)
  const sel = document.getElementById("algo-select");
  if (!sel.options.length) state.algorithms.forEach((a) => sel.add(new Option(a.name, a.key)));
  if (document.activeElement !== sel) sel.value = state.algorithm;
  sel.disabled = runBusy(state);
  document.getElementById("st-total").textContent = state.total;
  document.getElementById("st-errors").textContent = state.errors;
  document.getElementById("st-open").textContent = state.servers.reduce((a, s) => a + s.open, 0);
  document.getElementById("btn-reset-counters").disabled = runBusy(state);
}

// Đổi thuật toán của Load Balancer thật (chỉ khi không gửi): request sau đó được chia theo thuật toán này
async function applyAlgorithm(key) {
  const status = document.getElementById("lb-status");
  try {
    const st = await Api.post("/api/lb/algorithm", { algorithm: key });
    setStatus(status, "Load Balancer dùng " + st.algorithm_name + ".");
    onState(Object.assign({}, lastState, st, { events: [] }));
  } catch (err) {
    setStatus(status, "Lỗi: " + err.message, true);
    document.getElementById("algo-select").value = lastState.algorithm;
  }
}

// ---------- Nhận xét thuật toán ----------

function renderAdvisor(state) {
  const adv = state.advice;
  document.getElementById("advisor").dataset.level = adv ? "ok" : "idle";
  document.getElementById("adv-title").textContent = adv
    ? "★ " + adv.rows[0].name + " tối ưu nhất" : "Nhận xét thuật toán";
}

// ---------- 4 sơ đồ thuật toán ----------

function buildPanels(state) {
  const grid = document.getElementById("algo-grid");
  const factors = state.servers.map((s) => s.slow_factor);
  panelFactors = factors.join();
  state.algorithms.forEach((a) => {
    const p = new AlgoPanel(grid, a, factors);
    panels[a.key] = p;
  });
  // Player (replay.js): trực tiếp thì vẽ như cũ, tua lại thì vẽ trạng thái tại thời điểm đang xem
  Player.init(panels, () => !!(lastState && lastState.run && lastState.run.status === "running"));
  const loop = (now) => {
    Player.tick(now);
    Player.draw();
    Player.updateUi();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

let panelFactors = "";
function updatePanels(state) {
  const now = performance.now();
  // Admin vừa đổi hệ số chậm / thêm / bớt server: vẽ lại vị trí các ô
  const factors = state.servers.map((s) => s.slow_factor);
  if (factors.join() !== panelFactors) {
    panelFactors = factors.join();
    Object.values(panels).forEach((p) => p.setFactors(factors));
  }
  const th = threshold(state);
  const sticky = state.run ? state.run.sticky_ip : null;
  // Gán sticky IP trước khi thêm sự kiện để bảng IP tô đúng màu sticky ngay từ request đầu tiên
  for (const key in panels) panels[key].stickyIp = sticky;
  for (const e of state.events || []) {
    Recorder.add(e, now); // ghi lại để tua lại / chiếu chậm
    const p = panels[e.g];
    if (p) p.addEvent(e, now);
  }
  const shadows = state.shadows || {};
  for (const key in panels) {
    const p = panels[key];
    p.dropStale(now);
    p.threshold = th;
    if (key === state.algorithm) {
      p.servers = state.servers;
    } else if (shadows[key]) {
      p.servers = shadows[key].map((s, i) => ({
        open: s.open, done: s.done, enabled: s.enabled,
        up: state.servers[i] ? state.servers[i].up : null,
      }));
    }
    p.ipTable.setServers(p.servers);
  }
}

// Nhãn đang chạy / tối ưu nhất + nút chuyển (cập nhật 4 lần/giây là đủ)
function renderPanelMarks(state) {
  const adv = state.advice;
  const best = adv ? adv.rows[0].key : null;
  const byKey = {};
  if (adv) adv.rows.forEach((r) => { byKey[r.key] = r; });

  for (const key in panels) {
    const p = panels[key];
    const isCurrent = key === state.algorithm;
    const isBest = key === best;
    p.el.classList.toggle("is-current", isCurrent);
    p.el.classList.toggle("is-best", isBest);

    let tags = "";
    if (isCurrent) tags += '<span class="mark mark-current">Đang chạy</span>';
    if (isBest) tags += '<span class="mark mark-best">★ Tối ưu nhất</span>';
    if (p.tagsEl.innerHTML !== tags) p.tagsEl.innerHTML = tags;

    const row = byKey[key];
    const text = row ? "Chờ TB " + fmtMs(row.avg_wait) + " · quá tải " + row.overload_total : "";
    if (p.waitEl.textContent !== text) p.waitEl.textContent = text;
  }
}

// ---------- Bảng so sánh ----------

function renderCompare(state) {
  const adv = state.advice;
  document.getElementById("adv-empty").hidden = !!adv;
  document.getElementById("adv-table-wrap").hidden = !adv;
  if (!adv) return;
  const rows = adv.rows;
  const maxWait = Math.max.apply(null, rows.map((r) => r.avg_wait)) || 1;
  const slow = adv.slow_servers.join(", ");
  let html = '<thead><tr><th>Thuật toán</th><th class="bar-col">Chờ TB</th><th>p95</th><th>Hàng đợi max</th>' +
    (slow ? "<th>% vào " + escapeHtml(slow) + "</th>" : "") + "<th>Quá tải</th></tr></thead><tbody>";
  rows.forEach((r, i) => {
    const color = cssVar("--algo-" + r.key);
    const w = Math.max(2, (100 * r.avg_wait) / maxWait);
    html += "<tr" + (i === 0 ? ' class="best"' : "") + '><td><span class="swatch" style="background:' + color + '"></span>' +
      (i === 0 ? "★ " : "") + escapeHtml(r.name) + "</td>" +
      '<td class="bar-col"><div class="hbar"><span style="width:' + w + "%;background:" + color + '"></span></div><b>' +
      fmtMs(r.avg_wait) + "</b></td><td>" + fmtMs(r.p95_response, 0) + "</td><td>" + r.max_open + "</td>" +
      (slow ? "<td>" + fmt(r.slow_pct, 0) + "%</td>" : "") + "<td>" + r.overload_total + "</td></tr>";
  });
  document.getElementById("adv-table").innerHTML = html + "</tbody>";
}

// ---------- Bảng server (có ô chỉnh) ----------

// Bảng chỉ dựng lại khi số server đổi; các lần sau chỉ cập nhật chữ, để ô chọn không bị reset khi đang chọn.
let serverTableKey = "";
const LIMITS_DEFAULT = { min_servers: 2, max_servers: 6, factors: [1, 1.5, 2, 3, 4, 5] };

function limits(state) {
  return state.limits || LIMITS_DEFAULT;
}

function buildServerTable(state) {
  const choices = limits(state).factors;
  let html = "<thead><tr><th>Server</th><th>Địa chỉ</th><th>Hệ số chậm</th><th>Bật / tắt</th><th>Trạng thái</th>" +
    "<th>Kết nối mở<span class=\"sub\">đang xử lý + chờ</span></th><th>Đã xử lý</th><th>Lỗi</th>" +
    "<th>Phản hồi TB<span class=\"sub\">10 request gần nhất, ms</span></th></tr></thead><tbody>";
  state.servers.forEach((s, i) => {
    html += '<tr data-row="' + i + '"><td>' + escapeHtml(s.name) + '</td><td class="mono">127.0.0.1:' + s.port + "</td>" +
      '<td><select class="factor-select" data-index="' + i + '" aria-label="Hệ số chậm ' + escapeHtml(s.name) + '">' +
      choices.map((f) => '<option value="' + f + '">×' + String(f).replace(".", ",") + (f === 1 ? " (chuẩn)" : "") + "</option>").join("") +
      "</select></td>" +
      '<td><button type="button" class="btn-sm toggle-server" data-index="' + i + '"></button></td>' +
      '<td class="c-health"></td><td class="c-open"></td><td class="c-done"></td><td class="c-err"></td><td class="c-rt"></td></tr>';
  });
  document.getElementById("server-table").innerHTML = html + "</tbody>";
}

function renderServers(state) {
  const key = state.servers.map((s) => s.name).join();
  if (key !== serverTableKey) {
    buildServerTable(state);
    serverTableKey = key;
  }
  const th = threshold(state);
  const table = document.getElementById("server-table");
  state.servers.forEach((s, i) => {
    const row = table.querySelector('[data-row="' + i + '"]');
    if (!row) return;
    row.classList.toggle("server-off", !s.enabled);
    const sel = row.querySelector(".factor-select");
    if (document.activeElement !== sel && !sel.disabled) sel.value = String(s.slow_factor);
    const btn = row.querySelector(".toggle-server");
    btn.textContent = s.enabled ? "Tắt" : "Bật";
    btn.className = "btn-sm toggle-server " + (s.enabled ? "btn-ghost" : "btn-primary");
    row.querySelector(".c-health").innerHTML = !s.enabled ? '<span class="badge">Đang tắt</span>'
      : s.up === null ? '<span class="badge">Đang kiểm tra</span>'
      : s.up ? '<span class="badge ok">Hoạt động</span>' : '<span class="badge bad">Mất kết nối</span>';
    const open = row.querySelector(".c-open");
    open.textContent = s.open;
    open.className = "c-open" + (s.open >= th ? " over" : "");
    row.querySelector(".c-done").textContent = s.done;
    row.querySelector(".c-err").textContent = s.errors;
    row.querySelector(".c-rt").textContent = fmt(s.avg_rt);
  });

  const n = state.servers.length;
  const busy = runBusy(state);
  const lim = limits(state);
  const add = document.getElementById("btn-add-server");
  const rem = document.getElementById("btn-remove-server");
  add.disabled = busy || n >= lim.max_servers;
  rem.disabled = busy || n <= lim.min_servers;
  add.title = busy ? "Đợi gửi request xong" : n >= lim.max_servers ? "Tối đa " + lim.max_servers + " server" : "";
  rem.title = busy ? "Đợi gửi request xong" : n <= lim.min_servers ? "Tối thiểu " + lim.min_servers + " server" : "";
  rem.textContent = "− Bớt server " + state.servers[n - 1].name;
}

// Gọi API chỉnh cụm server, cập nhật ngay bằng trạng thái trả về
async function clusterAction(promise, okText) {
  const status = document.getElementById("server-status");
  try {
    const st = await promise;
    setStatus(status, okText);
    onState(Object.assign({}, lastState, st, { events: [] }));
  } catch (err) {
    setStatus(status, "Lỗi: " + err.message, true);
    if (lastState) renderServers(lastState); // trả ô chọn về giá trị thật
  }
}

// ---------- Luồng dữ liệu ----------

// Mỗi phần vẽ riêng: 1 phần lỗi không làm các phần khác (nhãn đang chạy / tối ưu nhất…) dừng theo
function renderSlow(state) {
  [renderPanelMarks, renderAdvisor, renderCompare, renderServers].forEach((fn) => {
    try {
      fn(state);
    } catch (err) {
      console.error("[" + fn.name + "]", err);
    }
  });
}

let lastSlowRender = 0;
let pendingHistory = null;
let lastRunId = null;
function onState(msg) {
  lastState = msg;
  // Lượt gửi mới: xóa các chấm còn sót của lượt trước trên 4 sơ đồ (cụm ảo đã được làm mới ở backend)
  const runId = msg.run ? msg.run.id : null;
  if (runId !== lastRunId) {
    if (lastRunId !== null || runId !== null) {
      Object.values(panels).forEach((p) => p.clearRequests());
      Recorder.reset();          // bản ghi tua lại bắt đầu lại cho lượt gửi mới
      if (Object.keys(panels).length) Player.onNewRecording();
    }
    lastRunId = runId;
  }
  if (!Object.keys(panels).length) {
    buildPanels(msg);
    HistoryView.init(msg.algorithms);
    if (pendingHistory) HistoryView.update(pendingHistory);
  }
  updatePanels(msg);
  renderControl(msg);
  const now = performance.now();
  if (now - lastSlowRender > 250) {
    renderSlow(msg);
    lastSlowRender = now;
  }
}

function onMessage(msg) {
  if (msg.type === "state") onState(msg);
  else if (msg.type === "history") {
    if (Object.keys(panels).length) HistoryView.update(msg);
    else pendingHistory = msg; // chưa có tin state đầu tiên (chưa biết tên thuật toán)
  }
  else if (msg.type === "advice" && lastState) {
    lastState.advice = msg.advice;
    renderSlow(lastState);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("legend").innerHTML = legendHtml();

  document.getElementById("algo-select").addEventListener("change", (ev) => applyAlgorithm(ev.target.value));
  document.getElementById("btn-reset-counters").addEventListener("click", async () => {
    try {
      await Api.post("/api/lb/reset");
      setStatus(document.getElementById("lb-status"), "Đã đặt lại bộ đếm");
    } catch (err) {
      setStatus(document.getElementById("lb-status"), "Lỗi: " + err.message, true);
    }
  });

  const serverTable = document.getElementById("server-table");
  serverTable.addEventListener("change", (ev) => {
    const sel = ev.target.closest(".factor-select");
    if (!sel) return;
    const name = lastState.servers[sel.dataset.index].name;
    sel.disabled = true;
    clusterAction(Api.post("/api/servers/" + sel.dataset.index, { slow_factor: Number(sel.value) }),
      "Đã đổi " + name + " thành ×" + sel.value.replace(".", ",") + ". Request mới xử lý theo hệ số này.")
      .finally(() => { sel.disabled = false; sel.blur(); });
  });
  serverTable.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".toggle-server");
    if (!btn) return;
    const s = lastState.servers[btn.dataset.index];
    clusterAction(Api.post("/api/servers/" + btn.dataset.index, { enabled: !s.enabled }),
      (s.enabled ? "Đã tắt " : "Đã bật ") + s.name + (s.enabled ? ": không nhận request mới, request đang xử lý vẫn trả về." : "."));
  });
  document.getElementById("btn-add-server").addEventListener("click", (ev) => {
    ev.target.disabled = true;
    setStatus(document.getElementById("server-status"), "Đang khởi động server mới…");
    clusterAction(Api.post("/api/servers"), "Đã thêm server mới (×1).");
  });
  document.getElementById("btn-remove-server").addEventListener("click", () => {
    const name = lastState.servers[lastState.servers.length - 1].name;
    clusterAction(Api.del("/api/servers"), "Đã bớt " + name + ".");
  });

  const defaults = await Api.get("/api/defaults");
  document.getElementById("lb-url").textContent = "Load Balancer nhận traffic tại " + defaults.cluster.lb_url +
    (defaults.cluster.lan_url ? " · máy khác cùng mạng Wi-Fi: " + defaults.cluster.lan_url : "");

  const badge = document.getElementById("ws-status");
  connectLive(onMessage, (ok) => {
    badge.className = "badge " + (ok ? "ok" : "bad");
    badge.textContent = ok ? "Trực tiếp" : "Mất kết nối…";
  });
});
