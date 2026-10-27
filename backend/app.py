"""Flask app: API mô phỏng + phục vụ luôn frontend.

Chạy: python backend/app.py  rồi mở http://127.0.0.1:5000
"""

import csv
import io
import os
import sys

# Cho phép chạy trực tiếp "python backend/app.py": thêm thư mục gốc vào sys.path
# để import được package "backend".
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from flask import Flask, Response, jsonify, request, send_from_directory  # noqa: E402

from backend.algorithms import ALGORITHMS, ip_to_server  # noqa: E402
from backend.config import DEFAULT_PARAMS, PARAM_LIMITS  # noqa: E402
from backend.simulator import run_all  # noqa: E402

FRONTEND_DIR = os.path.join(ROOT, "frontend")

app = Flask(__name__, static_folder=None)


class ParamError(Exception):
    pass


def parse_params(raw):
    """Gộp input của người dùng với DEFAULT_PARAMS và kiểm tra hợp lệ."""
    raw = raw or {}
    params = dict(DEFAULT_PARAMS)
    for key, (lo, hi, typ) in PARAM_LIMITS.items():
        if key not in raw or raw[key] in ("", None):
            continue
        try:
            value = typ(float(raw[key]))
        except (TypeError, ValueError):
            raise ParamError("Tham số '%s' phải là số" % key)
        if not (lo <= value <= hi):
            raise ParamError("Tham số '%s' phải nằm trong [%s, %s]" % (key, lo, hi))
        params[key] = value

    if "sticky_ip" in raw and str(raw["sticky_ip"]).strip():
        params["sticky_ip"] = str(raw["sticky_ip"]).strip()

    if params["light_min"] > params["light_max"]:
        raise ParamError("Thời gian nhẹ: min phải <= max")
    if params["heavy_min"] > params["heavy_max"]:
        raise ParamError("Thời gian nặng: min phải <= max")
    if params["num_slow_servers"] >= params["num_servers"]:
        raise ParamError("Số server yếu phải nhỏ hơn số server")
    return params


@app.errorhandler(ParamError)
def handle_param_error(err):
    return jsonify({"error": str(err)}), 400


# ---------- Frontend ----------

@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/css/<path:filename>")
def css(filename):
    return send_from_directory(os.path.join(FRONTEND_DIR, "css"), filename)


@app.route("/js/<path:filename>")
def js(filename):
    return send_from_directory(os.path.join(FRONTEND_DIR, "js"), filename)


# ---------- API ----------

@app.route("/api/defaults")
def api_defaults():
    return jsonify(DEFAULT_PARAMS)


@app.route("/api/simulate", methods=["POST"])
def api_simulate():
    params = parse_params(request.get_json(silent=True))
    requests_list, results = run_all(params)
    return jsonify({
        "params": params,
        "requests": requests_list,
        "sticky_server": ip_to_server(params["sticky_ip"], params["num_servers"]),
        "algorithms": [{"key": c.key, "name": c.name} for c in ALGORITHMS],
        "results": results,
    })


@app.route("/api/sticky-compare", methods=["POST"])
def api_sticky_compare():
    """Chạy 2 lần: không sticky (0%) và sticky theo params, chỉ trả metrics."""
    params = parse_params(request.get_json(silent=True))
    no_sticky = dict(params, sticky_percent=0)
    out = {}
    for label, p in (("without", no_sticky), ("with", params)):
        _, results = run_all(p)
        out[label] = {key: res["metrics"] for key, res in results.items()}
    return jsonify({"params": params, "results": out})


@app.route("/api/export.csv")
def api_export_csv():
    params = parse_params(request.args.to_dict())
    requests_list, results = run_all(params)
    by_id = {r["id"]: r for r in requests_list}

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["algorithm", "request_id", "client_ip", "kind", "base_service_ms",
                     "server", "arrival_ms", "start_ms", "finish_ms",
                     "service_ms", "wait_ms", "response_ms"])
    for cls in ALGORITHMS:
        for a in results[cls.key]["assignments"]:
            r = by_id[a["request_id"]]
            writer.writerow([cls.name, a["request_id"], r["client_ip"], r["kind"],
                             r["base_service_time"], "s%d" % a["server"], a["arrival"],
                             a["start"], a["finish"], a["service_time"], a["wait"],
                             a["response"]])
    return Response(
        "﻿" + buf.getvalue(),  # BOM để Excel đọc đúng UTF-8
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=lb_log_seed%d.csv" % params["seed"]},
    )


if __name__ == "__main__":
    # macOS: AirPlay Receiver có thể chiếm cổng 5000 -> cho đổi cổng bằng biến PORT
    port = int(os.environ.get("PORT", 5000))
    app.run(host="127.0.0.1", port=port, debug=False)
