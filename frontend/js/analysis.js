// Bảng tổng hợp và nhận xét tự sinh cho kết quả mô phỏng 4 thuật toán
// (dùng ở phần "Phân tích chi tiết" của trang Tổng quan).

// ---------- Bảng tổng hợp ----------

function renderTable(data) {
  const algos = data.algorithms;
  const n = data.params.num_servers;
  // Các cột số liệu: càng nhỏ càng tốt
  const cols = [
    { field: "makespan", title: "Makespan", sub: "ms", digits: 1 },
    { field: "avg_wait", title: "Chờ TB", sub: "Avg wait, ms", digits: 1 },
    { field: "avg_response", title: "Phản hồi TB", sub: "Avg response, ms", digits: 1 },
    { field: "p95_response", title: "p95", sub: "ms", digits: 1 },
    { field: "overload_total", title: "Quá tải", sub: "Overload, lần", digits: 0 },
    { field: "overload_time_total", title: "Thời gian quá tải", sub: "ms (cộng các server)", digits: 0 },
  ];
  const metricsOf = (a) => {
    const m = data.results[a.key].metrics;
    m.overload_time_total = m.overload_time.reduce((x, y) => x + y, 0);
    return m;
  };

  let html = "<thead><tr><th>Thuật toán</th>";
  cols.forEach((c) => {
    html += "<th>" + c.title + '<span class="sub">' + c.sub + "</span></th>";
  });
  const slow = slowServers(data.params);
  for (let i = 0; i < n; i++) {
    const tag = slow.indexOf(i) >= 0 ? " ×" + data.params.slow_factor : "";
    html += "<th>% s" + i + '<span class="sub">request' + tag + "</span></th>";
  }
  html += "</tr></thead><tbody>";

  const best = {};
  cols.forEach((c) => {
    best[c.field] = Math.min.apply(null, algos.map((a) => metricsOf(a)[c.field]));
  });

  algos.forEach((a) => {
    const m = metricsOf(a);
    html += '<tr><td><span class="swatch" style="background:' + cssVar("--algo-" + a.key) + '"></span>' + a.name + "</td>";
    cols.forEach((c) => {
      const isBest = m[c.field] === best[c.field];
      html += "<td" + (isBest ? ' class="best"' : "") + ">" + fmt(m[c.field], c.digits) + "</td>";
    });
    for (let i = 0; i < n; i++) html += "<td>" + fmt(m.request_pct[i]) + "%</td>";
    html += "</tr>";
  });
  html += "</tbody>";
  document.getElementById("result-table").innerHTML = html;
}

// ---------- Nhận xét tự sinh ----------

function renderAnalysis(data) {
  const p = data.params;
  const slow = slowServers(p);
  const R = data.results;
  const sName = (list) => list.map((i) => "s" + i).join(", ");
  const sum = (arr, idx) => idx.reduce((acc, i) => acc + arr[i], 0);

  // Câu số liệu chung cho 1 thuật toán
  function facts(key) {
    const m = R[key].metrics;
    let parts = [];
    if (slow.length) {
      parts.push(sName(slow) + " (server yếu) nhận " + fmt(sum(m.request_pct, slow)) +
        "% request, chiếm " + fmt(sum(m.busy_pct, slow)) + "% thời gian xử lý");
    } else {
      const maxIdx = m.request_pct.indexOf(Math.max.apply(null, m.request_pct));
      parts.push("server nhận nhiều nhất là s" + maxIdx + " (" + fmt(m.request_pct[maxIdx]) + "% request)");
    }
    const overTime = m.overload_time.reduce((a, b) => a + b, 0);
    parts.push(m.overload_total === 0
      ? "không lần nào quá tải"
      : "quá tải " + m.overload_total + " lần (tổng " + fmt(overTime, 0) + " ms ở trạng thái quá tải)");
    parts.push("makespan " + fmt(m.makespan, 0) + " ms, chờ TB " + fmt(m.avg_wait) + " ms");
    return parts.join("; ") + ".";
  }

  const stickyServer = data.sticky_server;
  const ipm = R.iphash.metrics;
  const stickyNote = ipm.sticky_total > 0
    ? " Toàn bộ " + ipm.sticky_distribution[stickyServer] + "/" + ipm.sticky_total + " request của " +
      p.sticky_ip + " vào s" + stickyServer +
      (slow.indexOf(stickyServer) >= 0 ? " — đúng server yếu nên dồn tải nặng." : ".")
    : " Không có sticky client trong lần chạy này.";

  const theory = {
    rr: "Chỉ đếm lượt, không biết server nào chậm hay đang bận nên server yếu vẫn nhận phần bằng nhau.",
    lc: "Server chậm giữ kết nối lâu hơn nên tự động ít được chọn (tự né server chậm).",
    iphash: "Ưu tiên giữ session (session stickiness) hơn cân bằng tải: cùng IP luôn vào cùng server dù server đó đang quá tải.",
    lrt: "Đo response time thực tế nên phát hiện và bù trừ server yếu; nhưng dùng trung bình 10 request gần nhất nên phản ứng hơi trễ, có thể dồn tải theo đợt.",
  };

  let html = "<ul>";
  data.algorithms.forEach((a) => {
    html += '<li><span class="algo-name" style="color:' + cssVar("--algo-" + a.key) + '">' + a.name + ":</span> " +
      escapeHtml(facts(a.key)) + (a.key === "iphash" ? escapeHtml(stickyNote) : "") +
      '<br><span class="theory">→ ' + theory[a.key] + "</span></li>";
  });
  html += "</ul>";

  // Tổng kết: tốt nhất / kém nhất theo response TB và độ chênh lệch
  const byResp = data.algorithms.slice().sort((x, y) => R[x.key].metrics.avg_response - R[y.key].metrics.avg_response);
  const bestA = byResp[0];
  const worstA = byResp[byResp.length - 1];
  const bestV = R[bestA.key].metrics.avg_response;
  const worstV = R[worstA.key].metrics.avg_response;
  const ratio = bestV > 0 ? worstV / bestV : 1;
  let summary = "<p><b>Tổng kết:</b> phản hồi TB tốt nhất là " + bestA.name + " (" + fmt(bestV) + " ms), kém nhất là " +
    worstA.name + " (" + fmt(worstV) + " ms)";
  summary += ratio >= 2 ? ", gấp " + fmt(ratio) + " lần." : ", chênh " + fmt((ratio - 1) * 100, 0) + "%.";
  if (ratio < 1.25) {
    summary += " Các thuật toán cho kết quả gần như nhau vì hệ thống gần đồng nhất (request đều, server như nhau, không client tập trung).";
  } else {
    summary += " Hệ thống không đồng nhất nên chọn thuật toán ảnh hưởng rõ rệt đến hiệu năng.";
  }
  summary += "</p>";

  document.getElementById("analysis-text").innerHTML = summary + html;
}
