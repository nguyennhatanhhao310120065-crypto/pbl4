"""Web Server thật (1 tiến trình = 1 server).

Chạy:  python -m backend.web_server --name s0 --port 80
       python -m backend.web_server --name s3 --port 83 --slow-factor 2

Mô hình xử lý (khớp với engine mô phỏng):
  - Nhận kết nối bất đồng bộ (asyncio, giống nginx): request đang chờ chỉ là
    1 coroutine treo, không chiếm thread.
  - Năng lực xử lý = 1 worker: request vào hàng đợi FIFO, worker lấy lần lượt
    từng request và "xử lý" trong base_ms × slow_factor mili-giây.
  - Không dùng asyncio.Semaphore vì trên Python < 3.11 nó không đảm bảo FIFO
    (request mới có thể chen trước request đang chờ).

API:
  GET /work      header X-Work-Ms = thời gian xử lý gốc (ms). Trả JSON thời gian chờ/xử lý.
  GET /health    trạng thái server.
  POST /config   {"slow_factor": 2} đổi hệ số chậm khi đang chạy (Load Balancer gọi khi admin chỉnh).
                 Request đã vào hàng đợi giữ thời gian xử lý cũ, chỉ request mới dùng hệ số mới.
  GET /          dòng chữ cho biết server nào đã phục vụ (để thử LB trên trình duyệt).
"""

import argparse
import asyncio
import time

from aiohttp import web

from backend.config import SERVER_HOST


# asyncio.sleep trên macOS/Windows thường ngủ lố ~1 ms (đáng kể với request nhẹ 6–16 ms).
# Ngủ tới trước đích SPIN_MARGIN giây rồi chờ bận phần còn lại để thời gian xử lý chính xác.
SPIN_MARGIN = 0.002


async def precise_sleep(seconds):
    end = time.perf_counter() + seconds
    if seconds > SPIN_MARGIN:
        await asyncio.sleep(seconds - SPIN_MARGIN)
    while time.perf_counter() < end:
        pass


class Worker:
    def __init__(self, name, port, slow_factor):
        self.name = name
        self.port = port
        self.slow_factor = slow_factor
        self.queue = None        # tạo trong on_startup để gắn đúng event loop
        self.busy = False
        self.processed = 0

    async def run(self):
        while True:
            fut, service_s = await self.queue.get()
            if fut.cancelled():  # client đã ngắt kết nối khi còn đang chờ
                continue
            self.busy = True
            start = time.perf_counter()
            await precise_sleep(service_s)
            end = time.perf_counter()
            self.busy = False
            self.processed += 1
            if not fut.cancelled():
                fut.set_result((start, end))

    async def handle_work(self, request):
        recv = time.perf_counter()
        try:
            base_ms = float(request.headers.get("X-Work-Ms", ""))
        except ValueError:
            return web.json_response({"error": "Thiếu hoặc sai header X-Work-Ms"}, status=400)
        if not 0 <= base_ms <= 60000:
            return web.json_response({"error": "X-Work-Ms phải trong [0, 60000]"}, status=400)

        fut = asyncio.get_running_loop().create_future()
        self.queue.put_nowait((fut, base_ms * self.slow_factor / 1000.0))
        start, end = await fut
        return web.json_response({
            "server": self.name,
            "port": self.port,
            "request_id": request.headers.get("X-Request-Id"),
            "wait_ms": round((start - recv) * 1000, 3),
            "service_ms": round((end - start) * 1000, 3),
        })

    async def handle_index(self, request):
        # Mở LB trên trình duyệt (http://127.0.0.1:8080) rồi F5 để thấy request được chia cho server nào
        return web.Response(text="Web Server %s (cổng %d, hệ số chậm ×%g) đã xử lý request này.\n"
                                 "Gửi request có tải: GET /work với header X-Work-Ms.\n"
                                 % (self.name, self.port, self.slow_factor))

    async def handle_health(self, request):
        return web.json_response({
            "server": self.name,
            "port": self.port,
            "slow_factor": self.slow_factor,
            "queue": self.queue.qsize() + (1 if self.busy else 0),
            "processed": self.processed,
        })


    async def handle_config(self, request):
        try:
            data = await request.json()
            factor = float(data["slow_factor"])
        except (ValueError, KeyError, TypeError):
            return web.json_response({"error": "Cần JSON {\"slow_factor\": số}"}, status=400)
        if not 0.1 <= factor <= 20:
            return web.json_response({"error": "slow_factor phải trong [0.1, 20]"}, status=400)
        self.slow_factor = factor
        print("[%s] đổi hệ số chậm thành ×%g" % (self.name, factor), flush=True)
        return await self.handle_health(request)


TASK_KEY = web.AppKey("worker_task")


def make_app(worker):
    app = web.Application()
    app.router.add_get("/", worker.handle_index)
    app.router.add_get("/work", worker.handle_work)
    app.router.add_get("/health", worker.handle_health)
    app.router.add_post("/config", worker.handle_config)

    async def on_startup(app):
        worker.queue = asyncio.Queue()
        app[TASK_KEY] = asyncio.get_running_loop().create_task(worker.run())

    async def on_cleanup(app):
        app[TASK_KEY].cancel()

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


async def serve(name, port, slow_factor, host=SERVER_HOST):
    worker = Worker(name, port, slow_factor)
    runner = web.AppRunner(make_app(worker), access_log=None)
    await runner.setup()
    try:
        await web.TCPSite(runner, host, port).start()
    except PermissionError:
        # macOS chỉ cho user thường mở cổng < 1024 khi bind vào mọi địa chỉ (0.0.0.0).
        # LB vẫn gọi tới 127.0.0.1 nên không ảnh hưởng.
        host = "0.0.0.0"
        await web.TCPSite(runner, host, port).start()
    print("[%s] Web Server chạy tại %s:%d, hệ số chậm ×%g" % (name, host, port, slow_factor), flush=True)
    try:
        await asyncio.Event().wait()
    finally:
        await runner.cleanup()


def main():
    ap = argparse.ArgumentParser(description="Web Server cho hệ thống cân bằng tải")
    ap.add_argument("--name", required=True)
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--slow-factor", type=float, default=1.0)
    args = ap.parse_args()
    try:
        asyncio.run(serve(args.name, args.port, args.slow_factor))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
