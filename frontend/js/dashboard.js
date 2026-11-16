// Trang admin (1 trang duy nhất): chọn thuật toán, gửi request, đánh giá & đề xuất,
// 4 sơ đồ thuật toán cùng lúc, bảng so sánh, bảng Web Server.

const THRESHOLD_DEFAULT = 5;
const EXPECTED_API = 5; // = API_VERSION trong backend/config.py

let lastState = null;
let algoSelectTouched = false; // người dùng đang chọn thì không ghi đè ô chọn
const panels = {};              // key thuật toán -> AlgoPanel

function threshold(state) {
  return state.run ? state.run.overload_threshold : THRESHOLD_DEFAULT;
}

function algoName(state, key) {
  const a = state.algorithms.find((x) => x.key === key);
  return a ? a.name : key;
}

function runBusy(state) {
  const run = state.run;
  return !!(run && (run.status === "running" || run.status === "saving"));
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
  const running = !!(run && run.status === "running");
  document.getElementById("st-run").textContent = running ? run.completed + " / " + run.total
    : run && run.status === "saving" ? "Đang lưu…" : "Không";
  const progress = document.getElementById("progress");
  progress.hidden = !running;
  if (running) document.getElementById("progress-bar").style.width = (100 * run.completed / run.total) + "%";

  const busy = runBusy(state);
  document.getElementById("btn-reset-counters").disabled = busy;
  document.getElementById("btn-start").disabled = busy;
}

// source = "advice" khi bấm nút chuyển trên sơ đồ tối ưu nhất (ghi vào lịch sử là "Theo đề xuất")
async function applyAlgorithm(key, source) {
  const status = document.getElementById("lb-status");
  try {
    const st = await Api.post("/api/lb/algorithm", { algorithm: key, source: source || "manual" });
    algoSelectTouched = false;
    document.getElementById("algo-select").value = st.algorithm;
    setStatus(status, "Đã chuyển sang " + st.algorithm_name + ". Request mới dùng thuật toán này.");
    onState(Object.assign({}, lastState, st, { events: [] }));
  } catch (err) {
    setStatus(status, "Lỗi: " + err.message, true);
  }
}

async function startRun() {
  const status = document.getElementById("run-status");
  const params = Settings.read();
  try {
    const res = await Api.post("/api/runs", { algorithm: lastState.algorithm, params: params });
    setStatus(status, "Đang gửi " + res.run.total + " request bằng " + algoName(lastState, res.run.algorithm) +
      ". Có thể đổi thuật toán bất cứ lúc nào trong lúc gửi.");
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
  const live = document.getElementById("adv-live");

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
    sub.textContent = runBusy(state)
      ? "Đang chờ đủ 20 request đầu tiên của lượt gửi này để so sánh 4 thuật toán…"
      : "Cần ít nhất 20 request. Bấm Bắt đầu gửi ở trên để hệ thống so sánh 4 thuật toán trên chính các request đó.";
    return;
  }

  const rows = adv.rows;
  const cur = rows.find((r) => r.key === adv.current);
  const best = rows[0];
  const curName = algoName(state, adv.current);

  if (best.key === adv.current) {
    box.dataset.level = "ok";
    tag.textContent = "Ổn định";
    title.textContent = curName + " đang là thuật toán tối ưu nhất";
    sub.textContent = "Trong 4 thuật toán, " + curName + " cho thời gian chờ TB thấp nhất trên " + adv.count +
      " request thật vừa qua. Không cần đổi.";
  } else if (adv.suggest) {
    box.dataset.level = over.length ? "bad" : "warn";
    tag.textContent = over.length ? "Phát hiện tắc nghẽn" : "Có thuật toán tốt hơn";
    title.textContent = "Nên chuyển sang " + best.name;
    sub.innerHTML = "Mô phỏng trên " + adv.count + " request thật vừa qua: chờ TB với <b>" + escapeHtml(curName) +
      "</b> là <b>" + fmtMs(cur.avg_wait) + "</b>, với <b>" + escapeHtml(best.name) + "</b> chỉ còn <b>" +
      fmtMs(best.avg_wait) + "</b> (giảm " + fmt(adv.gain_pct, 0) + "%). Bấm nút trên sơ đồ được đánh dấu " +
      "<b>TỐI ƯU NHẤT</b> để chuyển.";
  } else {
    box.dataset.level = "ok";
    tag.textContent = "Ổn định";
    title.textContent = curName + " vẫn phù hợp với traffic hiện tại";
    sub.textContent = best.name + " tốt nhất nhưng chỉ hơn " + fmtMs(adv.gain_ms) +
      " chờ TB, chưa đáng để đổi. Vẫn có thể chuyển bằng nút trên sơ đồ của nó.";
  }
}

// ---------- 4 sơ đồ thuật toán ----------

function buildPanels(state) {
  const grid = document.getElementById("algo-grid");
  const factors = state.servers.map((s) => s.slow_factor);
  panelFactors = factors.join();
  state.algorithms.forEach((a) => {
    const p = new AlgoPanel(grid, a, factors);
    p.switchBtn.addEventListener("click", () => applyAlgorithm(a.key, "advice"));
    panels[a.key] = p;
  });
  const loop = () => {
    Object.values(panels).forEach((p) => p.draw());
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
  for (const e of state.events || []) {
    const p = panels[e.g];
    if (p) p.addEvent(e, now);
  }
  const th = threshold(state);
  const sticky = state.run ? state.run.sticky_ip : null;
  const shadows = state.shadows || {};
  for (const key in panels) {
    const p = panels[key];
    p.dropStale(now);
    p.threshold = th;
    p.stickyIp = sticky;
    if (key === state.algorithm) {
      p.servers = state.servers;
    } else if (shadows[key]) {
      p.servers = shadows[key].map((s, i) => ({
        open: s.open, done: s.done, enabled: s.enabled,
        up: state.servers[i] ? state.servers[i].up : null,
      }));
    }
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
    p.el.classList.toggle("is-urgent", isBest && !isCurrent && !!adv.suggest);

    let tags = "";
    if (isCurrent) tags += '<span class="mark mark-current">Đang chạy</span>';
    if (isBest) tags += '<span class="mark mark-best">★ Tối ưu nhất</span>';
    if (p.tagsEl.innerHTML !== tags) p.tagsEl.innerHTML = tags;

    const done = p.servers.reduce((a, s) => a + s.done, 0);
    const row = byKey[key];
    p.waitEl.innerHTML = (isCurrent ? "<b>Số liệu thật</b>" : "Mô phỏng") + " · xong " + done + "<br>" + (row
      ? "Chờ TB (mô phỏng lượt gửi này): <b>" + fmtMs(row.avg_wait) + "</b> · quá tải " + row.overload_total + " lần"
      : "Chờ TB: chưa đủ traffic");

    const showSwitch = isBest && !isCurrent;
    p.switchBtn.hidden = !showSwitch;
    if (showSwitch) p.switchBtn.textContent = "Chuyển sang " + algoName(state, key);
  }
}

// ---------- Bảng so sánh ----------

function renderCompare(state) {
  const adv = state.advice;
  const wrap = document.getElementById("adv-table-wrap");
  const foot = document.getElementById("adv-foot");
  document.getElementById("adv-empty").hidden = !!adv;
  if (!adv) {
    wrap.hidden = true;
    foot.textContent = "";
    return;
  }
  const rows = adv.rows;
  const maxWait = Math.max.apply(null, rows.map((r) => r.avg_wait)) || 1;
  const slowLabel = adv.slow_servers.join(", ") || "server yếu";
  let html = "<thead><tr><th>Thuật toán</th><th class=\"bar-col\">Chờ TB<span class=\"sub\">mô phỏng</span></th>" +
    "<th>p95 phản hồi</th><th>Hàng đợi lớn nhất</th>" +
    "<th>% vào " + slowLabel + "<span class=\"sub\">server yếu</span></th><th>Quá tải<span class=\"sub\">lần</span></th>" +
    "</tr></thead><tbody>";
  rows.forEach((r, i) => {
    const tags = (r.key === state.algorithm ? '<span class="pill">đang chạy</span>' : "") +
      (i === 0 ? '<span class="pill ok">tối ưu nhất</span>' : "");
    const w = Math.max(2, (100 * r.avg_wait) / maxWait);
    html += "<tr" + (r.key === state.algorithm ? ' class="current"' : "") + "><td>" +
      '<span class="swatch" style="background:' + cssVar("--algo-" + r.key) + '"></span>' + r.name + tags + "</td>" +
      '<td class="bar-col"><div class="hbar"><span style="width:' + w + "%;background:" + cssVar("--algo-" + r.key) +
      '"></span></div><b>' + fmtMs(r.avg_wait) + "</b></td><td>" + fmtMs(r.p95_response, 0) + "</td><td>" + r.max_open +
      "</td><td>" + fmt(r.slow_pct) + "%</td><td>" + r.overload_total + "</td></tr>";
  });
  document.getElementById("adv-table").innerHTML = html + "</tbody>";
  wrap.hidden = false;

  const run = state.run;
  let footText;
  if (run && adv.scope && adv.scope.run_id === run.id) {
    const sending = run.status === "running";
    footText = "Mô phỏng " + adv.count + " request của lượt gửi #" + run.id +
      (sending ? " (đang gửi " + run.completed + "/" + run.total + ")" : " (đã gửi xong, giữ kết quả tới lượt gửi sau)") +
      " · cập nhật " + adv.updated_at + ".";
  } else {
    footText = "Mô phỏng " + adv.count + " request thật trong " + fmt(adv.duration_ms / 1000) +
      " giây gần nhất · cập nhật " + adv.updated_at + ".";
  }
  if (adv.real && adv.real.avg_wait !== null) {
    footText += " Đo thật trong cùng khoảng: chờ TB " + fmtMs(adv.real.avg_wait) + " (" + adv.real.completed +
      " request đã xong, " + adv.real.pending + " đang chờ).";
  }
  foot.textContent = footText;
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
  document.getElementById("version-warn").hidden = (msg.api || 0) >= EXPECTED_API;
  // Lượt gửi mới: xóa các chấm còn sót của lượt trước trên 4 sơ đồ (cụm ảo đã được làm mới ở backend)
  const runId = msg.run ? msg.run.id : null;
  if (runId !== lastRunId) {
    if (lastRunId !== null || runId !== null) Object.values(panels).forEach((p) => p.inflight.clear());
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

  const sel = document.getElementById("algo-select");
  sel.addEventListener("change", () => { algoSelectTouched = true; });
  document.getElementById("btn-algo").addEventListener("click", () => applyAlgorithm(sel.value));
  document.getElementById("btn-start").addEventListener("click", startRun);
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
  Settings.init(defaults.defaults);
  document.getElementById("lb-url").textContent = "Load Balancer nhận traffic tại " + defaults.cluster.lb_url +
    (defaults.cluster.lan_url ? " · máy khác cùng mạng Wi-Fi: " + defaults.cluster.lan_url : "");

  const badge = document.getElementById("ws-status");
  connectLive(onMessage, (ok) => {
    badge.className = "badge " + (ok ? "ok" : "bad");
    badge.textContent = ok ? "Trực tiếp" : "Mất kết nối…";
  });
});
