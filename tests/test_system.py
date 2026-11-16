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
from backend.shadow import Shadows  # noqa: E402
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

    async def test_disable_and_slow_factor(self):
        # Tắt s0 -> Round Robin chỉ xoay vòng s1..s3; đổi s1 thành ×3 -> Web Server xử lý lâu gấp 3
        lb, proxy = await make_lb(self.urls, "rr")
        lb.set_enabled(0, False)
        await lb.set_slow_factor(1, 3)
        seen, service = [], {}
        async with aiohttp.ClientSession() as s:
            for _ in range(6):
                async with s.get(proxy.make_url("/work"), headers={"X-Work-Ms": "10"}) as r:
                    name = r.headers["X-Upstream-Server"]
                    seen.append(name)
                    service[name] = (await r.json())["service_ms"]
        with self.assertRaises(Exception):
            for i in (1, 2, 3):
                lb.set_enabled(i, False)  # tắt nốt server cuối cùng còn bật -> lỗi
        self.assertEqual(lb.cluster_params()["factors"], [1, 3, 1, 2])
        snap = lb.shadows.snapshot()["lc"]
        self.assertFalse(snap[0]["enabled"])
        await lb.stop()
        await proxy.close()
        self.assertEqual(seen, ["s1", "s2", "s3"] * 2)
        self.assertAlmostEqual(service["s1"], 30, delta=5)

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


class TestShadow(unittest.TestCase):
    def test_matches_simulator(self):
        # Mô phỏng trực tiếp trên luồng request phải chia server giống hệt engine mô phỏng
        params = dict(DEFAULT_PARAMS, **cluster_params())
        reqs, results = run_all(params)
        shadows = Shadows([1, 1, 1, 2])
        events = []
        for r in reqs:
            shadows.on_request(r["arrival_time"], r["id"], r["base_service_time"], r["client_ip"], r["kind"],
                               None, events.append)
        shadows.advance(float("inf"), events.append)
        for key, res in results.items():
            got = {e["id"]: e["s"] for e in events if e["g"] == key and e["e"] == "a"}
            self.assertEqual(got, {a["request_id"]: a["server"] for a in res["assignments"]}, key)
            self.assertEqual(sum(1 for e in events if e["g"] == key and e["e"] == "f"), len(reqs))

    def test_disabled_server_gets_nothing(self):
        shadows = Shadows([1, 1, 1])
        shadows.set_enabled(1, False)
        events = []
        for i in range(30):
            shadows.on_request(i * 1.0, i, 5.0, "ip%d" % i, "light", None, events.append)
        self.assertNotIn(1, set(e["s"] for e in events if e["e"] == "a"))
        shadows.add_server(2)
        shadows.on_request(100.0, 99, 5.0, "x", "light", None, events.append)
        self.assertEqual(len(shadows.snapshot()["rr"]), 4)
        shadows.remove_last()
        self.assertEqual(len(shadows.snapshot()["rr"]), 3)

    def test_current_algorithm_not_emitted(self):
        shadows = Shadows([1, 2])
        events = []
        shadows.on_request(0.0, 1, 10.0, "1.1.1.1", "light", "rr", events.append)
        self.assertEqual(sorted(e["g"] for e in events), ["iphash", "lc", "lrt"])
        snap = shadows.snapshot()
        self.assertEqual(sum(s["open"] for s in snap["rr"]), 1)  # vẫn được mô phỏng, chỉ không phát sự kiện


class TestHistory(unittest.TestCase):
    def test_segments_per_algorithm(self):
        from backend.history import History
        h = History("rr")
        ref = h.on_arrival("s0", 0.0)
        h.on_finish(ref, True, 100.0, 110.0)
        late = h.on_arrival("s0", 0.5)
        h.start_segment("lc", "advice", 1.0)
        ref2 = h.on_arrival("s1", 1.1)
        h.on_finish(late, True, 50.0, 60.0)   # request của RR xong sau khi đổi vẫn tính cho RR
        h.on_finish(ref2, True, 10.0, 20.0)
        servers = {x["name"]: x for x in h.snapshot()["segments"][0]["servers"]}
        self.assertEqual(servers["s0"]["count"], 2)
        h.start_segment("iphash", "manual", 2.0)   # giai đoạn rỗng sẽ bị bỏ khi đổi tiếp
        h.start_segment("lrt", "manual", 3.0)
        segs = h.snapshot()["segments"]
        self.assertEqual([s["algo"] for s in segs], ["rr", "lc", "lrt"])
        self.assertEqual(segs[0]["avg_wait"], 75.0)
        self.assertEqual(segs[0]["count"], 2)
        self.assertEqual(segs[1]["avg_wait"], 10.0)
        self.assertEqual(segs[1]["source"], "advice")

    def test_queue_counts_only_own_requests(self):
        # Hàng đợi RR để lại không bị tính cho giai đoạn LC
        from backend.history import History
        h = History("rr")
        refs = [h.on_arrival("s3", 0.0) for _ in range(8)]       # RR dồn 8 request vào s3 (>= ngưỡng 5)
        h.start_segment("lc", "advice", 1.0)
        lc = h.on_arrival("s3", 1.1)
        for r in refs:
            h.on_finish(r, True, 1.0, 2.0, "s3")
        h.on_finish(lc, True, 1.0, 2.0, "s3")
        rr_seg, lc_seg = h.snapshot()["segments"]
        self.assertEqual(rr_seg["servers"][0]["max_open"], 8)
        self.assertEqual(rr_seg["overloads"], 1)
        self.assertEqual(lc_seg["servers"][0]["max_open"], 1)
        self.assertEqual(lc_seg["overloads"], 0)


class TestRunScope(unittest.TestCase):
    def test_new_run_resets_comparison(self):
        lb = LoadBalancer("rr")
        for i in range(30):
            lb.add_trace({"t": float(i), "ip": "a", "base": 5.0, "kind": "light", "wait": 1.0}, float(i))
        lb.shadows.on_request(0.0, 1, 5.0, "a", "light", "rr", lambda e: None)
        lb.advice = {"current": "rr"}
        lb.history.on_arrival("s0", 0.0)          # lượt gửi trước có lịch sử Round Robin
        lb.set_enabled(0, False)
        params = dict(DEFAULT_PARAMS, num_requests=10, **cluster_params())
        lb.begin_run(1, "lc", params)
        self.assertEqual(len(lb.trace), 0)
        self.assertIsNone(lb.advice)
        segs = lb.history.snapshot()["segments"]
        self.assertEqual([(x["algo"], x["source"], x["count"]) for x in segs], [("lc", "run", 0)])
        snap = lb.shadows.snapshot()["rr"]
        self.assertEqual(sum(x["open"] for x in snap), 0)
        self.assertFalse(snap[0]["enabled"])       # giữ trạng thái bật / tắt
        # Sau khi gửi xong, kết quả không hết hạn theo 20 giây
        lb.add_trace({"t": 0.0, "ip": "a", "base": 5.0, "kind": "light", "wait": 1.0}, 0.0)
        self.assertEqual(len(lb.trace_window()), 1)


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

    async def test_server_controls(self):
        await self.login()
        r = await self.client.post("/api/servers/0", json={"enabled": False})
        self.assertEqual(r.status, 200)
        self.assertFalse((await r.json())["servers"][0]["enabled"])
        r = await self.client.post("/api/servers/9", json={"enabled": False})
        self.assertEqual(r.status, 409)
        r = await self.client.post("/api/servers/0", json={"slow_factor": 7})
        self.assertEqual(r.status, 409)  # không nằm trong danh sách hệ số cho phép
        r = await self.client.delete("/api/servers")
        self.assertEqual(r.status, 200)
        self.assertEqual(len((await r.json())["servers"]), 3)


if __name__ == "__main__":
    unittest.main()
