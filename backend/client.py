"""Chương trình client: sinh bộ request (cùng generator với bản mô phỏng) và bắn vào LB
đúng theo thời điểm đến đã sinh (~96 req/s, phân phối Poisson).

Chạy tay:   python -m backend.client --seed 42
Trang admin tự gọi chương trình này khi bấm "Chạy thật" (kèm --run-id để LB ghi log).

Mỗi request: GET {lb}/work với header
  X-Forwarded-For : IP client mô phỏng (25% là sticky IP)
  X-Work-Ms       : thời gian xử lý gốc (ms) của request
  X-Request-Kind  : light / heavy
  X-Request-Id    : số thứ tự request
  X-Run-Id        : mã lượt chạy (nếu có)
"""

import argparse
import asyncio
import json
import statistics
import sys
import time

import aiohttp

from backend.config import DEFAULT_PARAMS, LB_URL
from backend.generator import generate_requests


def log_line(r, ok, server, status, total_ms, body):
    """1 dòng kết quả của 1 request: số thứ tự, thời điểm gửi, IP, loại, server xử lý, thời gian."""
    kind = "nặng" if r["kind"] == "heavy" else "nhẹ"
    if not ok:
        return "#%-4d t=%7.1f ms  GET /work  %-14s %-4s → %-4s LỖI %s" % (
            r["id"] + 1, r["arrival_time"], r["client_ip"], kind, server, status)
    try:
        info = json.loads(body)
        detail = "chờ %7.1f ms  xử lý %6.1f ms" % (info["wait_ms"], info["service_ms"])
    except (ValueError, KeyError, TypeError):
        detail = ""
    return "#%-4d t=%7.1f ms  GET /work  %-14s %-4s → %-4s HTTP %s  phản hồi %7.1f ms  (%s)" % (
        r["id"] + 1, r["arrival_time"], r["client_ip"], kind, server, status, total_ms, detail)


async def send_all(lb_url, requests, run_id, verbose=True):
    loop = asyncio.get_running_loop()
    results = []

    async with aiohttp.ClientSession(connector=aiohttp.TCPConnector(limit=0),
                                     timeout=aiohttp.ClientTimeout(total=120)) as session:
        t0 = loop.time() + 0.2  # chừa 0.2s để tạo xong các task

        async def one(r):
            await asyncio.sleep(max(0.0, t0 + r["arrival_time"] / 1000.0 - loop.time()))
            headers = {
                "X-Forwarded-For": r["client_ip"],
                "X-Work-Ms": str(r["base_service_time"]),
                "X-Request-Kind": r["kind"],
                "X-Request-Id": str(r["id"]),
            }
            if run_id is not None:
                headers["X-Run-Id"] = str(run_id)
            sent = time.perf_counter()
            body = b""
            try:
                async with session.get(lb_url + "/work", headers=headers) as resp:
                    body = await resp.read()
                    ok = resp.status == 200
                    status = resp.status
                    server = resp.headers.get("X-Upstream-Server", "?")
            except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
                ok, server, status = False, "?", "(%s)" % exc
            ms = (time.perf_counter() - sent) * 1000.0
            results.append({"id": r["id"], "ok": ok, "server": server, "ms": ms})
            if verbose:
                print(log_line(r, ok, server, status, ms, body), flush=True)

        await asyncio.gather(*(one(r) for r in requests))
    return results


def main():
    ap = argparse.ArgumentParser(description="Client sinh request gửi tới Load Balancer")
    ap.add_argument("--lb", default=LB_URL, help="Địa chỉ Load Balancer")
    ap.add_argument("--run-id", type=int, default=None)
    ap.add_argument("--params-json", default=None, help="Tham số dạng JSON (ghi đè mặc định)")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--num-requests", type=int, default=None)
    ap.add_argument("--quiet", action="store_true", help="Không in kết quả từng request, chỉ in tổng kết")
    args = ap.parse_args()

    params = dict(DEFAULT_PARAMS)
    if args.params_json:
        params.update(json.loads(args.params_json))
    if args.seed is not None:
        params["seed"] = args.seed
    if args.num_requests is not None:
        params["num_requests"] = args.num_requests

    requests = generate_requests(params)
    print("Gửi %d request tới %s (seed %s, ~%s req/s)..." % (
        len(requests), args.lb, params["seed"], params["arrival_rate"]), flush=True)
    results = asyncio.run(send_all(args.lb.rstrip("/"), requests, args.run_id, verbose=not args.quiet))
    print()

    ok = [r for r in results if r["ok"]]
    print("Thành công %d/%d, lỗi %d" % (len(ok), len(results), len(results) - len(ok)))
    if ok:
        print("Phản hồi TB phía client: %.1f ms" % statistics.mean(r["ms"] for r in ok))
        counts = {}
        for r in ok:
            counts[r["server"]] = counts.get(r["server"], 0) + 1
        print("Phân bố: " + ", ".join("%s=%d" % kv for kv in sorted(counts.items())))
    sys.exit(0 if len(ok) == len(results) else 1)


if __name__ == "__main__":
    main()
