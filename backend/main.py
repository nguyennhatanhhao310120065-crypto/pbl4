"""Tiến trình Load Balancer + trang admin (cùng 1 event loop).

Chạy:  python -m backend.main
  - Load Balancer nhận traffic tại http://127.0.0.1:8080
  - Trang admin tại http://127.0.0.1:5050
4 Web Server phải được chạy riêng (python -m backend.web_server ...) hoặc dùng run.py để chạy tất cả.
"""

import asyncio

from aiohttp import web

from backend import db
from backend.admin import lan_ip, make_admin_app
from backend.config import ADMIN_HOST, ADMIN_PORT, CLUSTER, LB_HOST, LB_PORT, cluster_params, slow_factors
from backend.load_balancer import LoadBalancer, make_proxy_app


def check_cluster():
    # Bản mô phỏng coi server yếu là các server cuối, cùng hệ số -> cụm thật phải giống vậy
    factors = [s["slow_factor"] for s in CLUSTER]
    if factors != slow_factors(cluster_params()):
        raise SystemExit("CLUSTER trong config.py: server yếu phải nằm cuối và cùng hệ số chậm")


async def serve():
    check_cluster()
    db.init()
    lb = LoadBalancer()
    await lb.start()

    runners = []
    for app, host, port in ((make_proxy_app(lb), LB_HOST, LB_PORT), (make_admin_app(lb), ADMIN_HOST, ADMIN_PORT)):
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        await web.TCPSite(runner, host, port).start()
        runners.append(runner)
    print("Load Balancer : http://127.0.0.1:%d" % LB_PORT, flush=True)
    if LB_HOST == "0.0.0.0":
        print("  máy khác cùng mạng: http://%s:%d" % (lan_ip(), LB_PORT), flush=True)
    print("Trang admin   : http://%s:%d" % (ADMIN_HOST, ADMIN_PORT), flush=True)
    try:
        await asyncio.Event().wait()
    finally:
        await lb.stop()
        for runner in runners:
            await runner.cleanup()


def main():
    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
