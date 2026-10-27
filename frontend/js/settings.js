// Form tham số + preset. Đọc/ghi giá trị theo thuộc tính name của input.

const Settings = {
  defaults: null,
  form: null,

  // Preset chỉ ghi đè vài tham số, phần còn lại lấy từ mặc định
  presets: {
    default: {},
    // Không request nặng, không server yếu, không sticky -> 4 thuật toán gần như nhau
    uniform: { heavy_percent: 0, num_slow_servers: 0, sticky_percent: 0 },
    sticky: { sticky_percent: 50 },
  },

  init(defaults) {
    this.defaults = defaults;
    this.form = document.getElementById("param-form");
    this.fill(defaults);

    document.querySelectorAll("[data-preset]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const preset = this.presets[btn.dataset.preset] || {};
        this.fill(Object.assign({}, this.defaults, preset));
      });
    });
    document.getElementById("btn-defaults").addEventListener("click", () => {
      this.fill(this.defaults);
    });
  },

  fill(values) {
    Object.keys(values).forEach((key) => {
      const input = this.form.elements[key];
      if (input) input.value = values[key];
    });
  },

  // Đọc form -> object params. Ô trống thì bỏ qua (backend dùng mặc định).
  read() {
    const params = {};
    Array.from(this.form.elements).forEach((input) => {
      if (!input.name || input.value === "") return;
      params[input.name] = input.type === "number" ? Number(input.value) : input.value.trim();
    });
    return params;
  },
};
