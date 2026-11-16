"""Test hệ thống thật: Web Server, Load Balancer, client, trang admin.
Chạy trên các cổng ngẫu nhiên nên không cần tắt hệ thống đang chạy.
Chạy: python -m unittest discover tests
"""

import asyncio
import os
import socket
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import aiohttp  # noqa: E402
from aiohttp.test_utils import TestClient, TestServer  # noqa: E402

from backend import admin, advisor, db  # noqa: E402
from backend.client import send_all  # noqa: E402
from backend.config import ADMIN_PASSWORD, ADMIN_USERNAME, DEFAULT_PARAMS, cluster_params  # noqa: E402
from backend.generator import generate_requests  # noqa: E402
from backend.load_balancer import LoadBalancer, make_proxy_app  # noqa: E402
from backend.simulator import run_all  # noqa: E402
from backend.web_server import Worker, make_app  # noqa: E402


async def start_cluster(factors):
    """Chạy các Web Server trên cổng ngẫu nhiên, trả về (servers, base_urls)."""
    servers = []
    for i, f in enumerate(factors):
        srv = TestServer(make_app(Worker("s%d" % i, 0, f)), host="127.0.0.1")
        await srv.start_server()
        servers.append(srv)
    return servers


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def start_cluster_processes(factors):
    """Chạy mỗi Web Server ở 1 tiến trình riêng như khi chạy thật. Trả về (processes, urls)."""
    procs, urls = [], []
    for i, f in enumerate(factors):
        port = free_port()
        procs.append(await asyncio.create_subprocess_exec(
            sys.executable, "-m", "backend.web_server", "--name", "s%d" % i, "--port", str(port),
            "--slow-factor", str(f), cwd=ROOT, stdout=asyncio.subprocess.DEVNULL))
        urls.append("http://127.0.0.1:%d" % port)
    async with aiohttp.ClientSession() as s:
        for url in urls:
            for _ in range(100):
                try:
                    async with s.get(url + "/health") as r:
                        if r.status == 200:
                            break
                except aiohttp.ClientError:
                    await asyncio.sleep(0.05)
    return procs, urls


async def make_lb(urls, algorithm="rr"):
    lb = LoadBalancer(algorithm)
    for state, url in zip(lb.servers, urls):
        state.base_url = url
    await lb.start()
    proxy = TestServer(make_proxy_app(lb), host="127.0.0.1")
    await proxy.start_server()
    return lb, proxy


async def wait_saved(lb):
    # Số liệu + mô phỏng đối chiếu được tính ở tiến trình riêng rồi mới lưu DB
    for _ in range(200):
        if lb.run.status in ("done", "failed"):
            return
        await asyncio.sleep(0.05)
    raise AssertionError("Lượt chạy không lưu xong")


class TestWebServer(unittest.IsolatedAsyncioTestCase):
    async def test_fifo_single_worker(self):
        # 3 request 30 ms gửi cùng lúc -> xử lý lần lượt, request sau chờ request trước
        (srv,) = await start_cluster([1])
        async with aiohttp.ClientSession() as s:
            async def one(i):
                await asyncio.sleep(i * 0.003)  # giữ thứ tự đến
                async with s.get(srv.make_url("/work"), headers={"X-Work-Ms": "30"}) as r:
                    return await r.json()
            res = await asyncio.gather(*(one(i) for i in range(3)))
        await srv.close()
        for r in res:
            self.assertAlmostEqual(r["service_ms"], 30, delta=3)
        waits = [r["wait_ms"] for r in res]
        self.assertLess(waits[0], 3)
        self.assertGreater(waits[1], 20)
        self.assertGreater(waits[2], waits[1] + 20)

    async def test_slow_factor(self):
        (srv,) = await start_cluster([2])
        async with aiohttp.ClientSession() as s:
            async with s.get(srv.make_url("/work"), headers={"X-Work-Ms": "10"}) as r:
                data = await r.json()
            async with s.get(srv.make_url("/work")) as r:
                self.assertEqual(r.status, 400)
        await srv.close()
        self.assertAlmostEqual(data["service_ms"], 20, delta=3)


class TestLoadBalancer(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = db.DB_PATH
        db.DB_PATH = os.path.join(self.tmp.name, "test.db")
        db.init()
        self.procs, self.urls = await start_cluster_processes([1, 1, 1, 2])

    async def asyncTearDown(self):
        for p in self.procs:
            p.terminate()
            await p.wait()
        db.DB_PATH = self.old_db
        self.tmp.cleanup()

    async def test_round_robin_proxy(self):
        lb, proxy = await make_lb(self.urls, "rr")
        seen = []
        async with aiohttp.ClientSession() as s:
            for _ in range(8):
                async with s.get(proxy.make_url("/work"), headers={"X-Work-Ms": "1"}) as r:
                    self.assertEqual(r.status, 200)
                    seen.append(r.headers["X-Upstream-Server"])
        await lb.stop()
        await proxy.close()
        self.assertEqual(seen, ["s0", "s1", "s2", "s3"] * 2)

    async def test_iphash_sticky(self):
        lb, proxy = await make_lb(self.urls, "iphash")
        seen = set()
        async with aiohttp.ClientSession() as s:
            for _ in range(5):
                async with s.get(proxy.make_url("/work"),
                                 headers={"X-Work-Ms": "1", "X-Forwarded-For": "10.0.0.99"}) as r:
                    seen.add(r.headers["X-Upstream-Server"])
        await lb.stop()
        await proxy.close()
        self.assertEqual(len(seen), 1)

    async def test_full_run_matches_simulation(self):
        # Lượt chạy thật nhỏ: LB ghi log đầy đủ, số liệu gần với mô phỏng
        lb, proxy = await make_lb(self.urls, "rr")
        params = dict(DEFAULT_PARAMS, num_requests=60, **cluster_params())
        run_id = db.create_run("lc", params)
        run = lb.begin_run(run_id, "lc", params)
        await send_all(str(proxy.make_url("")).rstrip("/"), run.requests, run_id)
        await wait_saved(lb)
        await lb.stop()
        await proxy.close()

        saved = db.get_run(run_id)
        self.assertEqual(saved["status"], "done")
        self.assertEqual(len(saved["assignments"]), 60)
        m, sim = saved["metrics"], saved["sim_metrics"]
        self.assertEqual(sum(m["request_count"]), 60)
        for a in saved["assignments"]:
            self.assertAlmostEqual(a["response"], a["wait"] + a["service_time"], delta=0.01)
        # Thời gian xử lý đo thật ≈ thời gian gốc × hệ số chậm của server đã nhận request.
        base = {r["id"]: r["base_service_time"] for r in run.requests}
        factors = [1, 1, 1, 2]
        errs = [abs(a["service_time"] - base[a["request_id"]] * factors[a["server"]]) for a in saved["assignments"]]
        self.assertLess(sum(errs) / len(errs), 1.0)
        # Makespan của 60 request phụ thuộc request cuối rơi vào server nào nên chỉ so sánh lỏng
        self.assertAlmostEqual(m["makespan"], sim["makespan"], delta=sim["makespan"] * 0.25)

    async def test_switch_mid_run_is_recorded(self):
        # Đổi RR -> LC giữa lượt chạy: lượt chạy ghi lịch đổi, mô phỏng đối chiếu đổi đúng lúc đó
        lb, proxy = await make_lb(self.urls, "rr")
        params = dict(DEFAULT_PARAMS, num_requests=80, **cluster_params())
        run_id = db.create_run("rr", params)
        run = lb.begin_run(run_id, "rr", params)
        task = asyncio.ensure_future(send_all(str(proxy.make_url("")).rstrip("/"), run.requests, run_id))
        await asyncio.sleep(0.5)
        lb.set_algorithm("lc")
        await task
        await wait_saved(lb)
        await lb.stop()
        await proxy.close()
        saved = db.get_run(run_id)
        self.assertEqual(saved["status"], "done")
        self.assertEqual([k for _, k in saved["schedule"]], ["rr", "lc"])
        self.assertGreater(saved["schedule"][1][0], 0)


class TestAdvisor(unittest.TestCase):
    def trace_from_generator(self, n):
        reqs = generate_requests(dict(DEFAULT_PARAMS, num_requests=n))
        return [{"t": r["arrival_time"] / 1000.0, "ip": r["client_ip"], "base": r["base_service_time"],
                 "kind": r["kind"]} for r in reqs]

    def test_suggests_better_algorithm_when_congested(self):
        # Traffic theo đề + đang dùng Round Robin -> đề xuất Least Connections
        res = advisor.analyze(self.trace_from_generator(300), "rr", {"avg_wait": None})
        self.assertTrue(res["suggest"])
        self.assertEqual(res["best"], "lc")
        self.assertEqual(res["count"], 300)

    def test_trace_matches_parameter_simulation(self):
        # Trace dựng lại từ đúng bộ request của generator -> kết quả giống hệt mô phỏng theo tham số
        trace = self.trace_from_generator(300)
        res = advisor.analyze(trace, "lc", {"avg_wait": None})
        _, results = run_all(dict(DEFAULT_PARAMS, **cluster_params()))
        by_key = {r["key"]: r for r in res["rows"]}
        for k in ("rr", "lc", "iphash", "lrt"):
            self.assertAlmostEqual(by_key[k]["avg_wait"], results[k]["metrics"]["avg_wait"], places=2)
        self.assertFalse(res["suggest"])  # đang dùng thuật toán tốt nhất

    def test_no_suggestion_without_load(self):
        trace = [{"t": i * 0.05, "ip": "1.1.1.1", "base": 0.0, "kind": "light"} for i in range(30)]
        self.assertFalse(advisor.analyze(trace, "rr", {"avg_wait": None})["suggest"])

    def test_unknown_service_uses_mean(self):
        trace = [{"t": 0, "ip": "a", "base": 10.0, "kind": "light"}, {"t": 0.01, "ip": "b", "base": None, "kind": "light"}]
        self.assertEqual(advisor.build_requests(trace)[1]["base_service_time"], 10.0)


class TestAdmin(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.lb = LoadBalancer()
        await self.lb.start()
        self.client = TestClient(TestServer(admin.make_admin_app(self.lb)))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        await self.lb.stop()

    async def login(self):
        r = await self.client.post("/api/login", json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD})
        self.assertEqual(r.status, 200)

    async def test_requires_login(self):
        r = await self.client.get("/api/lb")
        self.assertEqual(r.status, 401)
        r = await self.client.get("/dashboard.html", allow_redirects=False)
        self.assertEqual(r.status, 302)
        r = await self.client.post("/api/login", json={"username": "admin", "password": "sai"})
        self.assertEqual(r.status, 401)

    async def test_switch_algorithm_and_snapshot(self):
        await self.login()
        r = await self.client.post("/api/runs", json={"params": {"heavy_percent": 150}})
        self.assertEqual(r.status, 400)
        r = await self.client.post("/api/simulate", json={"heavy_percent": 150})
        self.assertEqual(r.status, 400)
        r = await self.client.post("/api/simulate", json={"num_requests": 50})
        self.assertEqual(r.status, 200)
        self.assertEqual(set((await r.json())["results"]), {"rr", "lc", "iphash", "lrt"})
        r = await self.client.post("/api/sticky-compare", json={"num_requests": 50})
        self.assertEqual(set((await r.json())["results"]), {"without", "with"})
        r = await self.client.get("/api/advisor/snapshot")
        self.assertEqual(r.status, 409)  # chưa có traffic
        r = await self.client.post("/api/lb/algorithm", json={"algorithm": "lrt"})
        self.assertEqual((await r.json())["algorithm"], "lrt")
        r = await self.client.post("/api/lb/algorithm", json={"algorithm": "xyz"})
        self.assertEqual(r.status, 400)


if __name__ == "__main__":
    unittest.main()
