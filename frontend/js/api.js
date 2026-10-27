// Gọi API backend. Mọi hàm trả về Promise, lỗi ném ra Error có message tiếng Việt.

const Api = {
  async request(url, options) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || ("Lỗi máy chủ (" + res.status + ")"));
    }
    return data;
  },

  getDefaults() {
    return this.request("/api/defaults");
  },

  post(url, params) {
    return this.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  },

  simulate(params) {
    return this.post("/api/simulate", params);
  },

  stickyCompare(params) {
    return this.post("/api/sticky-compare", params);
  },

  // Link tải CSV: truyền params qua query string
  csvUrl(params) {
    const query = new URLSearchParams();
    Object.keys(params).forEach((k) => query.set(k, params[k]));
    return "/api/export.csv?" + query.toString();
  },
};
