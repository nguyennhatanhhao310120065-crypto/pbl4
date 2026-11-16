"""Trang admin: đăng nhập, mô phỏng 4 thuật toán, điều khiển LB thật, chạy client, xem kết quả.

Chạy chung tiến trình (cùng event loop) với Load Balancer nên đọc/ghi trực tiếp trạng thái LB.
"""

import asyncio
import csv
import hmac
import io
import json
import os
import secrets
import socket
import sys
import time

from aiohttp import WSMsgType, web

from backend import db
from backend.algorithms import ALGORITHMS, ip_to_server
from backend.config import (ADMIN_PASSWORD, ADMIN_USERNAME, CLUSTER, DEFAULT_PARAMS, LB_HOST, LB_PORT, LB_URL,
                            PARAM_LIMITS, SESSION_HOURS, cluster_params)
from backend.generator import generate_requests
from backend.simulator import run_all
from backend.load_balancer import ALGO_NAMES, simulate_run

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(ROOT, "frontend")
COOKIE = "lb_session"
PUBLIC_PATHS = {"/login.html", "/api/login"}
PUBLIC_PREFIXES = ("/css/", "/js/")

sessions = {}  # token -> hạn dùng (time.time())
LB_KEY = web.AppKey("lb")


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


async def read_json(request):
    try:
        return await request.json()
    except (ValueError, UnicodeDecodeError):
        return {}


def error(msg, status=400):
    return web.json_response({"error": msg}, status=status)


# ---------- Đăng nhập ----------

def current_session(request):
    token = request.cookies.get(COOKIE)
    exp = sessions.get(token) if token else None
    if exp is None or exp < time.time():
        sessions.pop(token, None)
        return None
    return token


@web.middleware
async def auth_middleware(request, handler):
    path = request.path
    if path in PUBLIC_PATHS or path.startswith(PUBLIC_PREFIXES) or current_session(request):
        return await handler(request)
    if path.startswith("/api/") or path == "/ws":
        return error("Chưa đăng nhập", 401)
    raise web.HTTPFound("/login.html")


@web.middleware
async def error_middleware(request, handler):
    try:
        return await handler(request)
    except ParamError as exc:
        return error(str(exc))


async def login(request):
    data = await read_json(request)
    user_ok = hmac.compare_digest(str(data.get("username", "")).encode(), ADMIN_USERNAME.encode())
    pass_ok = hmac.compare_digest(str(data.get("password", "")).encode(), ADMIN_PASSWORD.encode())
    if not (user_ok and pass_ok):
        await asyncio.sleep(0.5)  # làm chậm dò mật khẩu
        return error("Sai tên đăng nhập hoặc mật khẩu", 401)
    token = secrets.token_urlsafe(32)
    sessions[token] = time.time() + SESSION_HOURS * 3600
    resp = web.json_response({"username": ADMIN_USERNAME})
    resp.set_cookie(COOKIE, token, max_age=SESSION_HOURS * 3600, httponly=True, samesite="Lax", path="/")
    return resp


async def logout(request):
    sessions.pop(request.cookies.get(COOKIE), None)
    resp = web.json_response({"ok": True})
    resp.del_cookie(COOKIE, path="/")
    return resp


async def me(request):
    return web.json_response({"username": ADMIN_USERNAME})


# ---------- Trang ----------

def page(name):
    async def handler(request):
        return web.FileResponse(os.path.join(FRONTEND_DIR, name))
    return handler


async def index(request):
    raise web.HTTPFound("/dashboard.html")


# ---------- Cấu hình ----------

def lan_ip():
    """IP của máy trong mạng LAN (không gửi gói tin nào, chỉ hỏi hệ điều hành route ra ngoài)."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
        except OSError:
            return "127.0.0.1"


def cluster_info():
    return {
        "servers": CLUSTER,
        "params": cluster_params(),
        "lb_url": LB_URL,
        "lan_url": ("http://%s:%d" % (lan_ip(), LB_PORT)) if LB_HOST == "0.0.0.0" else None,
    }


async def api_defaults(request):
    return web.json_response({"defaults": DEFAULT_PARAMS, "cluster": cluster_info()})


# ---------- Mô phỏng theo tham số (trang Mô phỏng) ----------

def simulate_all(params):
    requests_list, results = run_all(params)
    return {
        "params": params,
        "requests": requests_list,
        "sticky_server": ip_to_server(params["sticky_ip"], params["num_servers"]),
        "algorithms": [{"key": c.key, "name": c.name} for c in ALGORITHMS],
        "results": results,
    }


def sticky_compare(params):
    """Chạy 2 lần: không sticky (0%) và sticky theo params, chỉ trả metrics."""
    out = {}
    for label, p in (("without", dict(params, sticky_percent=0)), ("with", params)):
        _, results = run_all(p)
        out[label] = {key: res["metrics"] for key, res in results.items()}
    return {"params": params, "results": out}


async def api_simulate(request):
    params = parse_params(await read_json(request))
    return web.json_response(await request.app[LB_KEY].in_pool(simulate_all, params))


async def api_sticky_compare(request):
    params = parse_params(await read_json(request))
    return web.json_response(await request.app[LB_KEY].in_pool(sticky_compare, params))


async def api_export_csv(request):
    params = parse_params(dict(request.query))
    data = await request.app[LB_KEY].in_pool(simulate_all, params)
    rows = []
    for cls in ALGORITHMS:
        rows.extend(csv_rows(cls.name, data["requests"], data["results"][cls.key]["assignments"]))
    return csv_response(rows, CSV_HEADER, "lb_sim_seed%d.csv" % params["seed"])


def csv_response(rows, header, filename):
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(header)
    writer.writerows(rows)
    return web.Response(
        text="﻿" + buf.getvalue(),  # BOM để Excel đọc đúng UTF-8
        content_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=%s" % filename},
    )


CSV_HEADER = ["algorithm", "request_id", "client_ip", "kind", "base_service_ms", "server",
              "arrival_ms", "start_ms", "finish_ms", "service_ms", "wait_ms", "response_ms"]


def csv_rows(algo_name, requests_list, assignments):
    by_id = {r["id"]: r for r in requests_list}
    for a in assignments:
        r = by_id[a["request_id"]]
        yield [algo_name, a["request_id"], r["client_ip"], r["kind"], r["base_service_time"],
               "s%d" % a["server"], a["arrival"], a["start"], a["finish"], a["service_time"],
               a["wait"], a["response"]]


# ---------- Load Balancer ----------

async def api_lb_state(request):
    return web.json_response(request.app[LB_KEY].state())


async def api_lb_algorithm(request):
    data = await read_json(request)
    try:
        request.app[LB_KEY].set_algorithm(str(data.get("algorithm", "")))
    except ValueError as exc:
        return error(str(exc))
    except RuntimeError as exc:
        return error(str(exc), 409)
    return web.json_response(request.app[LB_KEY].state())


async def api_lb_reset(request):
    lb = request.app[LB_KEY]
    if lb.run and lb.run.status in ("running", "saving"):
        return error("Đang có lượt chạy", 409)
    lb.reset_counters()
    return web.json_response(lb.state())


async def api_advisor_snapshot(request):
    """Mô phỏng chi tiết 4 thuật toán trên traffic thật 20 s gần nhất (phát lại, biểu đồ, nhận xét)."""
    data = await request.app[LB_KEY].snapshot()
    if data is None:
        return error("Chưa đủ traffic trong 20 giây gần nhất (cần ít nhất 20 request)", 409)
    return web.json_response(data)


async def ws_handler(request):
    lb = request.app[LB_KEY]
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    await ws.send_str(json.dumps(dict(lb.state(), type="state", events=[])))
    lb.subscribers.add(ws)
    try:
        async for msg in ws:
            if msg.type == WSMsgType.ERROR:
                break
    finally:
        lb.subscribers.discard(ws)
    return ws


# ---------- Lượt chạy thật ----------

def run_params(raw):
    """Tham số request lấy từ người dùng, tham số server lấy theo cụm server thật."""
    params = parse_params(raw)
    params.update(cluster_params())
    return params


async def api_runs_list(request):
    runs = db.list_runs()
    return web.json_response({"runs": runs, "algorithms": ALGO_NAMES})


async def api_runs_start(request):
    lb = request.app[LB_KEY]
    data = await read_json(request)
    algorithm = str(data.get("algorithm") or lb.algo_key)
    if algorithm not in {c.key for c in ALGORITHMS}:
        return error("Không có thuật toán: %s" % algorithm)
    params = run_params(data.get("params"))
    down = [s.name for s in lb.servers if not s.up]
    if down:
        return error("Server chưa chạy: %s" % ", ".join(down), 409)
    if lb.run and lb.run.status in ("running", "saving"):
        return error("Đang có lượt chạy khác", 409)

    run_id = db.create_run(algorithm, params)
    run = lb.begin_run(run_id, algorithm, params)
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "backend.client",
        "--lb", LB_URL,
        "--run-id", str(run_id),
        "--params-json", json.dumps(params),
        cwd=ROOT, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    asyncio.get_running_loop().create_task(lb.watch_client(run, process))
    return web.json_response({"run": run.summary()})


def get_run_or_404(request):
    try:
        run_id = int(request.match_info["id"])
    except ValueError:
        raise web.HTTPNotFound()
    run = db.get_run(run_id)
    if not run:
        raise web.HTTPNotFound()
    return run


async def api_run_detail(request):
    run = get_run_or_404(request)
    run["requests"] = generate_requests(run["params"])
    run["algorithm_name"] = ALGO_NAMES[run["algorithm"]]
    if not run["schedule"]:
        run["schedule"] = [[0.0, run["algorithm"]]]  # lượt chạy cũ / không đổi thuật toán
    if run["metrics"]:
        # Mô phỏng lại đúng bộ request + lịch đổi thuật toán để phát lại song song với log thật
        run["sim"] = await request.app[LB_KEY].in_pool(simulate_run, run["requests"], run["schedule"], run["params"])
    run["sticky_server"] = ip_to_server(run["params"]["sticky_ip"], run["params"]["num_servers"])
    return web.json_response(run)


async def api_run_delete(request):
    run = get_run_or_404(request)
    if not db.delete_run(run["id"]):
        return error("Không xóa được lượt đang chạy", 409)
    return web.json_response({"ok": True})


async def api_run_csv(request):
    run = get_run_or_404(request)
    name = " → ".join(ALGO_NAMES[k] for _, k in (run["schedule"] or [[0, run["algorithm"]]]))
    rows = list(csv_rows(name, generate_requests(run["params"]), run["assignments"] or []))
    return csv_response(rows, CSV_HEADER, "lb_run%d.csv" % run["id"])


def make_admin_app(lb):
    app = web.Application(middlewares=[auth_middleware, error_middleware])
    app[LB_KEY] = lb
    r = app.router
    r.add_get("/", index)
    for name in ("login.html", "dashboard.html", "simulation.html", "runs.html"):
        r.add_get("/" + name, page(name))
    r.add_static("/css/", os.path.join(FRONTEND_DIR, "css"))
    r.add_static("/js/", os.path.join(FRONTEND_DIR, "js"))

    r.add_post("/api/login", login)
    r.add_post("/api/logout", logout)
    r.add_get("/api/me", me)

    r.add_get("/api/defaults", api_defaults)
    r.add_post("/api/simulate", api_simulate)
    r.add_post("/api/sticky-compare", api_sticky_compare)
    r.add_get("/api/export.csv", api_export_csv)

    r.add_get("/api/lb", api_lb_state)
    r.add_post("/api/lb/algorithm", api_lb_algorithm)
    r.add_post("/api/lb/reset", api_lb_reset)
    r.add_get("/api/advisor/snapshot", api_advisor_snapshot)
    r.add_get("/ws", ws_handler)

    r.add_get("/api/runs", api_runs_list)
    r.add_post("/api/runs", api_runs_start)
    r.add_get("/api/runs/{id}", api_run_detail)
    r.add_delete("/api/runs/{id}", api_run_delete)
    r.add_get("/api/runs/{id}/export.csv", api_run_csv)
    return app
