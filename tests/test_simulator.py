"""Vài test đơn giản. Chạy: python -m unittest discover tests"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.algorithms import LeastResponseTime, RoundRobin, ip_to_server  # noqa: E402
from backend.config import DEFAULT_PARAMS  # noqa: E402
from backend.generator import generate_requests  # noqa: E402
from backend.metrics import count_overloads  # noqa: E402
from backend.simulator import Server, run_all, simulate  # noqa: E402


class TestGenerator(unittest.TestCase):
    def test_same_seed_same_requests(self):
        a = generate_requests(DEFAULT_PARAMS)
        b = generate_requests(DEFAULT_PARAMS)
        self.assertEqual(a, b)
        self.assertEqual(len(a), 300)

    def test_sticky_does_not_change_arrivals(self):
        # Đổi % sticky chỉ đổi IP, thời điểm đến và loại request giữ nguyên
        a = generate_requests(DEFAULT_PARAMS)
        b = generate_requests(dict(DEFAULT_PARAMS, sticky_percent=0))
        self.assertEqual([r["arrival_time"] for r in a], [r["arrival_time"] for r in b])
        self.assertEqual([r["kind"] for r in a], [r["kind"] for r in b])


class TestSimulator(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.requests, cls.results = run_all(DEFAULT_PARAMS)

    def test_deterministic(self):
        _, again = run_all(DEFAULT_PARAMS)
        for key in self.results:
            self.assertEqual(self.results[key]["metrics"], again[key]["metrics"])

    def test_round_robin_equal_split(self):
        self.assertEqual(self.results["rr"]["metrics"]["request_count"], [75, 75, 75, 75])

    def test_ip_hash_sticky_one_server(self):
        dist = self.results["iphash"]["metrics"]["sticky_distribution"]
        target = ip_to_server(DEFAULT_PARAMS["sticky_ip"], DEFAULT_PARAMS["num_servers"])
        self.assertEqual(dist[target], sum(dist))

    def test_slow_server_gets_less_with_lc_lrt(self):
        rr = self.results["rr"]["metrics"]["request_pct"][3]
        self.assertLess(self.results["lc"]["metrics"]["request_pct"][3], rr)
        self.assertLessEqual(self.results["lrt"]["metrics"]["request_pct"][3], 20)

    def test_fifo_single_worker(self):
        # Mỗi server xử lý 1 request 1 lúc, theo đúng thứ tự đến (FIFO)
        for res in self.results.values():
            by_server = {}
            for a in res["assignments"]:
                self.assertGreaterEqual(a["start"], a["arrival"])
                by_server.setdefault(a["server"], []).append(a)
            for items in by_server.values():
                items.sort(key=lambda a: a["arrival"])
                for prev, cur in zip(items, items[1:]):
                    self.assertGreaterEqual(cur["start"] + 1e-6, prev["finish"])

    def test_slow_factor_applied(self):
        by_id = {r["id"]: r for r in self.requests}
        for a in self.results["rr"]["assignments"]:
            factor = 2 if a["server"] == 3 else 1
            self.assertAlmostEqual(a["service_time"], by_id[a["request_id"]]["base_service_time"] * factor, places=2)

    def test_uniform_preset_close(self):
        params = dict(DEFAULT_PARAMS, heavy_percent=0, num_slow_servers=0, sticky_percent=0)
        _, res = run_all(params)
        makespans = [r["metrics"]["makespan"] for r in res.values()]
        self.assertLess(max(makespans) / min(makespans), 1.05)


class TestHelpers(unittest.TestCase):
    def test_overload_counts_only_crossing_up(self):
        events = [{"server": 0, "open_connections_after": x} for x in [3, 5, 6, 7, 4, 5, 2]]
        self.assertEqual(count_overloads(events, 1, 5), [2])

    def test_lrt_prefers_fast_server_when_idle(self):
        fast, slow = Server(0, 1), Server(1, 2)
        fast.recent_rt.extend([10, 10])
        slow.recent_rt.extend([30, 30])
        # Cả 2 đều rảnh (0 kết nối) nhưng vẫn phân biệt được nhờ (open + 1)
        self.assertEqual(LeastResponseTime().choose({}, [slow, fast], 0), 1)

    def test_simulate_small(self):
        params = dict(DEFAULT_PARAMS, num_servers=2, num_slow_servers=0)
        reqs = [
            {"id": 0, "arrival_time": 0, "client_ip": "a", "kind": "light", "base_service_time": 10},
            {"id": 1, "arrival_time": 1, "client_ip": "b", "kind": "light", "base_service_time": 10},
            {"id": 2, "arrival_time": 2, "client_ip": "c", "kind": "light", "base_service_time": 10},
        ]
        res = simulate(reqs, RoundRobin(), params)
        a = res["assignments"]
        self.assertEqual([x["server"] for x in a], [0, 1, 0])
        self.assertEqual(a[2]["start"], 10)   # chờ request 0 xong
        self.assertEqual(a[2]["wait"], 8)
        self.assertEqual(res["metrics"]["makespan"], 20)


class TestApi(unittest.TestCase):
    def setUp(self):
        from backend.app import app
        self.client = app.test_client()

    def test_invalid_param(self):
        r = self.client.post("/api/simulate", json={"heavy_percent": 150})
        self.assertEqual(r.status_code, 400)
        self.assertIn("error", r.get_json())

    def test_simulate_ok(self):
        r = self.client.post("/api/simulate", json={"num_requests": 50})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(set(r.get_json()["results"]), {"rr", "lc", "iphash", "lrt"})


if __name__ == "__main__":
    unittest.main()
