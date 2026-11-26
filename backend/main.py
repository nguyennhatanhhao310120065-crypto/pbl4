"""Tiến trình Load Balancer + trang admin (cùng 1 event loop).

Chạy trên 1 máy (4 Web Server ở chính máy này, cổng 80–83):
    python -m backend.main

Chạy nhiều máy (4 Web Server ở máy 192.168.1.20, client ở máy khác gửi tới máy này):
    python -m backend.main --host 0.0.0.0 --servers 192.168.1.20:8001 192.168.1.20:8002 \\
                                             192.168.1.20:8003 192.168.1.20:8004

  - Load Balancer nhận traffic ở cổng 8080 (LB_PORT)
  - Trang admin tại http://127.0.0.1:5050 (chỉ mở trên chính máy này)
"""

import argparse
import asyncio

from aiohttp import web

from backend import db
from backend.admin import make_admin_app
from backend.config import ADMIN_HOST, ADMIN_PORT, LB_HOST, LB_PORT, lan_ip, parse_servers
from backend.load_balancer import LoadBalancer, make_proxy_app


async def serve(host, port, cluster):
    db.init()
    lb = LoadBalancer(cluster=cluster, verbose=True)
    lb.lan_url = ("http://%s:%d" % (lan_ip(), port)) if host == "0.0.0.0" else None
    await lb.start()

    runners = []
    for app, h, p in ((make_proxy_app(lb), host, port), (make_admin_app(lb), ADMIN_HOST, ADMIN_PORT)):
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        await web.TCPSite(runner, h, p).start()
        runners.append(runner)
    print("Load Balancer : http://127.0.0.1:%d" % port, flush=True)
    if host == "0.0.0.0":
        print("  máy client gửi tới: http://%s:%d" % (lan_ip(), port), flush=True)
    print("Trang admin   : http://%s:%d" % (ADMIN_HOST, ADMIN_PORT), flush=True)
    print("Chia tải cho  : " + ", ".join("%s=%s:%d" % (s.name, s.host, s.port) for s in lb.servers), flush=True)
    try:
        await asyncio.Event().wait()
    finally:
        await lb.stop()
        for runner in runners:
            await runner.cleanup()


def main():
    ap = argparse.ArgumentParser(description="Load Balancer + trang admin")
    ap.add_argument("--host", default=LB_HOST, help="0.0.0.0 để máy khác gửi request tới (mặc định %s)" % LB_HOST)
    ap.add_argument("--servers", nargs="+", metavar="HOST:PORT",
                    help="Địa chỉ các Web Server (mặc định 4 server ở chính máy này)")
    args = ap.parse_args()
    try:
        cluster = parse_servers(args.servers) if args.servers else None
    except ValueError as exc:
        ap.error(str(exc))
    try:
        asyncio.run(serve(args.host, LB_PORT, cluster))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
