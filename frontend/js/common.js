// Hàm dùng chung cho mọi trang admin: gọi API, định dạng số, màu, thanh điều hướng.

// Đọc màu từ biến CSS (:root) để canvas, Chart.js và CSS dùng chung 1 bảng màu.
// Cache lại vì getComputedStyle khá chậm khi gọi mỗi khung hình.
const colorCache = {};
function cssVar(name) {
  if (!(name in colorCache)) {
    colorCache[name] = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  return colorCache[name];
}

// Định dạng số kiểu Việt Nam: 25,0
function fmt(x, digits) {
  const d = digits === undefined ? 1 : digits;
  return Number(x).toLocaleString("vi-VN", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Server yếu là các server cuối (giống backend config.slow_factors)
function slowServers(params) {
  const n = params.num_servers;
  const k = Math.min(params.num_slow_servers, n - 1);
  const list = [];
  for (let i = n - k; i < n; i++) list.push(i);
  return list;
}

function setStatus(el, text, isError) {
  el.className = "status" + (isError ? " error" : "");
  el.textContent = text;
}

const Api = {
  async request(url, options) {
    const res = await fetch(url, options);
    if (res.status === 401 && url !== "/api/login") {
      window.location.href = "/login.html";
      throw new Error("Chưa đăng nhập");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || ("Lỗi máy chủ (" + res.status + ")"));
    }
    return data;
  },

  get(url) {
    return this.request(url);
  },

  post(url, body) {
    return this.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  },

  del(url) {
    return this.request(url, { method: "DELETE" });
  },

  // Link tải CSV mô phỏng theo tham số: truyền params qua query string
  csvUrl(params) {
    const query = new URLSearchParams();
    Object.keys(params).forEach((k) => query.set(k, params[k]));
    return "/api/export.csv?" + query.toString();
  },

};

// Kết nối WebSocket nhận trạng thái LB (~10 lần/giây), tự nối lại khi mất kết nối.
function connectLive(onMessage, onStatus) {
  let ws;
  function open() {
    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    ws = new WebSocket(proto + location.host + "/ws");
    ws.onopen = () => onStatus && onStatus(true);
    ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
    ws.onclose = () => {
      if (onStatus) onStatus(false);
      setTimeout(open, 1500);
    };
  }
  open();
}

// Thanh điều hướng: đánh dấu trang hiện tại + nút đăng xuất
document.addEventListener("DOMContentLoaded", () => {
  const path = location.pathname;
  document.querySelectorAll(".nav a").forEach((a) => {
    if (a.getAttribute("href") === path) a.classList.add("active");
  });
  const out = document.getElementById("btn-logout");
  if (out) {
    out.addEventListener("click", async () => {
      await Api.post("/api/logout").catch(() => {});
      window.location.href = "/login.html";
    });
  }
});
