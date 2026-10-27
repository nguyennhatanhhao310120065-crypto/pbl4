// Vẽ 3 biểu đồ bằng Chart.js. Mỗi lần chạy lại thì hủy chart cũ rồi tạo mới.

// Màu theo thứ tự cố định cho server s0..s5 (đã kiểm tra phân biệt được với người mù màu)
const SERVER_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"];

const Charts = {
  instances: {},
  data: null,       // kết quả /api/simulate
  sticky: null,     // kết quả /api/sticky-compare
  workloadMode: "request",
  stickyMetric: "makespan",

  init() {
    Chart.defaults.color = cssVar("--text-2");
    Chart.defaults.borderColor = cssVar("--border");
    Chart.defaults.font.family = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
    Chart.defaults.plugins.tooltip.backgroundColor = "#000000e6";
    Chart.defaults.plugins.legend.labels.boxWidth = 12;
    Chart.defaults.maintainAspectRatio = false;

    this.bindTabs("tabs-workload", (btn) => {
      this.workloadMode = btn.dataset.mode;
      this.drawWorkload();
    });
    this.bindTabs("tabs-sticky", (btn) => {
      this.stickyMetric = btn.dataset.metric;
      this.drawStickyCompare();
    });
  },

  bindTabs(id, onChange) {
    const box = document.getElementById(id);
    box.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        box.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        if (this.data) onChange(btn);
      });
    });
  },

  render(data, sticky) {
    this.data = data;
    this.sticky = sticky;
    this.drawWorkload();
    this.drawMakespanWait();
    this.drawStickyCompare();
    this.drawStickyDist();
  },

  make(id, config) {
    if (this.instances[id]) this.instances[id].destroy();
    this.instances[id] = new Chart(document.getElementById(id), config);
  },

  // Tên dài thì tách 2 dòng để nhãn trục x không bị xoay chéo
  algoNames() {
    return this.data.algorithms.map((a) => {
      if (a.name.length <= 12) return a.name;
      const cut = a.name.indexOf(" ", 5);
      return cut > 0 ? [a.name.slice(0, cut), a.name.slice(cut + 1)] : a.name;
    });
  },

  algoColors() {
    return this.data.algorithms.map((a) => cssVar("--algo-" + a.key));
  },

  serverLabels() {
    const labels = [];
    for (let i = 0; i < this.data.params.num_servers; i++) labels.push("s" + i);
    return labels;
  },

  // Kiểu cột dùng chung: bo góc ở đầu cột, khe hở nhỏ giữa các cột
  barStyle(color) {
    return {
      backgroundColor: color,
      borderRadius: 4,
      borderSkipped: "start",
      categoryPercentage: 0.75,
      barPercentage: 0.9,
    };
  },

  axisTitle(text) {
    return { display: true, text: text, color: cssVar("--text-muted") };
  },

  // Biểu đồ 1: % workload mỗi server, nhóm theo thuật toán
  drawWorkload() {
    const field = this.workloadMode === "request" ? "request_pct" : "busy_pct";
    const algos = this.data.algorithms;
    const datasets = this.serverLabels().map((label, i) =>
      Object.assign({
        label: label,
        data: algos.map((a) => this.data.results[a.key].metrics[field][i]),
      }, this.barStyle(SERVER_COLORS[i]))
    );
    this.make("chart-workload", {
      type: "bar",
      data: { labels: this.algoNames(), datasets: datasets },
      options: {
        scales: {
          y: { beginAtZero: true, title: this.axisTitle("% " + (this.workloadMode === "request" ? "số request" : "thời gian xử lý")) },
          x: { grid: { display: false } },
        },
        plugins: {
          tooltip: { callbacks: { label: (c) => c.dataset.label + ": " + c.parsed.y.toFixed(1) + "%" } },
          legend: { position: "top" },
        },
      },
    });
  },

  // Biểu đồ 2: 2 biểu đồ nhỏ cạnh nhau (không dùng 2 trục y trên cùng 1 biểu đồ)
  drawMakespanWait() {
    const algos = this.data.algorithms;
    const single = (id, field, title) => {
      this.make(id, {
        type: "bar",
        data: {
          labels: this.algoNames(),
          datasets: [Object.assign({
            label: title,
            data: algos.map((a) => this.data.results[a.key].metrics[field]),
          }, this.barStyle(this.algoColors()))],
        },
        options: {
          plugins: {
            legend: { display: false },
            title: { display: true, text: title, color: cssVar("--text") },
            tooltip: { callbacks: { label: (c) => c.parsed.y.toFixed(1) + " ms" } },
          },
          scales: {
            y: { beginAtZero: true, title: this.axisTitle("ms") },
            x: { grid: { display: false } },
          },
        },
      });
    };
    single("chart-makespan", "makespan", "Makespan (ms)");
    single("chart-wait", "avg_wait", "Thời gian chờ TB (Avg wait, ms)");
  },

  // Biểu đồ 3a: so sánh có / không sticky client
  drawStickyCompare() {
    const algos = this.data.algorithms;
    const metric = this.stickyMetric;
    const pct = this.sticky.params.sticky_percent;
    const series = [
      { label: "Không sticky (0%)", src: this.sticky.results.without, color: cssVar("--text-muted") },
      { label: "Có sticky (" + pct + "%)", src: this.sticky.results.with, color: cssVar("--sticky") },
    ];
    this.make("chart-sticky-compare", {
      type: "bar",
      data: {
        labels: this.algoNames(),
        datasets: series.map((s) => Object.assign({
          label: s.label,
          data: algos.map((a) => s.src[a.key][metric]),
        }, this.barStyle(s.color))),
      },
      options: {
        plugins: {
          title: {
            display: true,
            color: cssVar("--text"),
            text: (metric === "makespan" ? "Makespan" : "Thời gian chờ TB (Avg wait)") + " (ms)",
          },
          tooltip: { callbacks: { label: (c) => c.dataset.label + ": " + c.parsed.y.toFixed(1) + " ms" } },
        },
        scales: {
          y: { beginAtZero: true, title: this.axisTitle("ms") },
          x: { grid: { display: false } },
        },
      },
    });
  },

  // Biểu đồ 3b: request của sticky IP rơi vào server nào (cột chồng)
  drawStickyDist() {
    const algos = this.data.algorithms;
    const datasets = this.serverLabels().map((label, i) => ({
      label: label,
      data: algos.map((a) => this.data.results[a.key].metrics.sticky_distribution[i]),
      backgroundColor: SERVER_COLORS[i],
      borderColor: cssVar("--surface"),
      borderWidth: 1,
      categoryPercentage: 0.6,
    }));
    this.make("chart-sticky-dist", {
      type: "bar",
      data: { labels: this.algoNames(), datasets: datasets },
      options: {
        plugins: {
          title: {
            display: true,
            color: cssVar("--text"),
            text: "Request của " + this.data.params.sticky_ip + " theo server",
          },
          tooltip: { callbacks: { label: (c) => c.dataset.label + ": " + c.parsed.y + " request" } },
        },
        scales: {
          x: { stacked: true, grid: { display: false } },
          y: { stacked: true, beginAtZero: true, title: this.axisTitle("số request") },
        },
      },
    });
  },
};
