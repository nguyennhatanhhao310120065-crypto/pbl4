"""Load Balancer thật: reverse proxy HTTP chuyển tiếp request tới 4 Web Server.

- Nhận traffic ở LB_PORT, chọn server bằng 1 trong 4 thuật toán của backend.algorithms
  (đúng các class mà engine mô phỏng dùng), chuyển tiếp request và trả phản hồi về client.
- IP client lấy từ header X-Forwarded-For (client mô phỏng nhiều IP trên cùng 1 máy),
  không có thì lấy địa chỉ kết nối.
- Request mang header X-Run-Id của lượt chạy đang hoạt động được ghi log đầy đủ để
  tính số liệu giống hệt bản mô phỏng (makespan, % workload, chờ TB, quá tải).
- Mọi request (kể cả không thuộc lượt chạy) được ghi vào "trace" 20 giây gần nhất. Mỗi
  ADVICE_INTERVAL giây, backend.advisor mô phỏng 4 thuật toán trên chính trace đó và
  đề xuất thuật toán tốt hơn nếu thuật toán đang dùng gây tắc nghẽn.
- Admin chỉnh cụm server khi đang chạy: đổi hệ số chậm, bật / tắt, thêm / bớt server (server thêm mới
  do LB tự khởi động tiến trình Web Server). Thuật toán chỉ chọn trong các server đang bật.
- Mỗi request cũng được đưa vào 4 cụm server ảo (backend.shadow) để trang admin vẽ cả 4 sơ đồ
  thuật toán cùng lúc: sơ đồ của thuật toán đang chạy dùng số liệu thật, 3 sơ đồ còn lại là mô phỏng.
"""

import asyncio
import json
import sys
import time
from collections import deque
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime

import aiohttp
from aiohttp import web

from backend import advisor, db
from backend.algorithms import ALGORITHMS, Scheduled, make_algorithm
from backend.config import (API_VERSION, CLUSTER, HEALTH_INTERVAL, MAX_SERVERS, MIN_SERVERS, PUSH_INTERVAL, SERVER_HOST,
                            SLOW_FACTOR_CHOICES, server_port)
from backend.generator import generate_requests
from backend.history import History
from backend.metrics import compute_metrics
from backend.shadow import Shadows
from backend.simulator import RECENT_WINDOW, simulate

ALGO_NAMES = {cls.key: cls.name for cls in ALGORITHMS}


class ClusterError(Exception):
    """Không chỉnh được cụm server (lỗi do người dùng hoặc server không phản hồi)."""

# Header không được chuyển tiếp qua proxy (hop-by-hop) hoặc do aiohttp tự tính lại
HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
    "trailers", "transfer-encoding", "upgrade", "host", "content-length", "content-encoding",
}
MAX_PENDING_EVENTS = 5000
ADVICE_INTERVAL = 2.0   # giây giữa 2 lần mô phỏng đề xuất
MAX_SWITCH_LOG = 20


def simulate_run(requests, schedule, params):
    """Mô phỏng 1 lượt chạy thật với đúng lịch đổi thuật toán (chạy ở tiến trình riêng)."""
    return simulate(requests, Scheduled(schedule), params)


class ServerState:
    """Trạng thái 1 server nhìn từ phía LB. Có cùng giao diện với simulator.Server
    (open_connections, avg_recent_rt) để dùng chung code thuật toán."""

    def __init__(self, index, cfg):
        self.index = index
        self.name = cfg["name"]
        self.port = cfg["port"]
        self.slow_factor = cfg["slow_factor"]
        self.base_url = "http://%s:%d" % (SERVER_HOST, cfg["port"])
        self.open_connections = 0              # request đã chuyển tới, chưa có phản hồi
        self.recent_rt = deque(maxlen=RECENT_WINDOW)
        self.done = 0
        self.errors = 0
        self.up = None                          # None = chưa kiểm tra lần nào
        self.enabled = True                     # admin tắt thì LB không gửi request mới tới
        self.process = None                     # tiến trình Web Server do LB khởi động (server thêm từ trang admin)

    def avg_recent_rt(self, default):
        if not self.recent_rt:
            return default
        return sum(self.recent_rt) / len(self.recent_rt)

    def snapshot(self):
        return {
            "name": self.name,
            "port": self.port,
            "slow_factor": self.slow_factor,
            "up": self.up,
            "enabled": self.enabled,
            "open": self.open_connections,
            "done": self.done,
            "errors": self.errors,
            "avg_rt": round(self.avg_recent_rt(0), 2),
        }


class Run:
    """1 lượt chạy thật: client bắn bộ request sinh từ params vào LB."""

    def __init__(self, run_id, algorithm, params):
        self.id = run_id
        self.algorithm = algorithm
        self.params = params
        self.requests = generate_requests(params)
        self.total = len(self.requests)
        self.t0 = None             # perf_counter ứng với mốc 0 ms của bộ request
        self.assignments = {}      # request_id -> dict giống simulator
        self.events = []           # ARRIVAL / FINISH giống simulator
        self.seen = set()
        self.completed = 0         # số request đã có kết quả (thành công hoặc lỗi)
        self.errors = 0
        self.status = "running"
        self.process = None
        self.schedule = [[0.0, algorithm]]  # [t_ms, thuật toán] — đổi thuật toán giữa lượt chạy

    def rel_ms(self, now):
        return (now - self.t0) * 1000.0

    def summary(self):
        return {
            "id": self.id,
            "algorithm": self.algorithm,
            "schedule": self.schedule,
            "status": self.status,
            "completed": self.completed,
            "total": self.total,
            "errors": self.errors,
            "sticky_ip": self.params["sticky_ip"],
            "overload_threshold": self.params["overload_threshold"],
        }


class LoadBalancer:
    def __init__(self, algorithm="rr"):
        self.servers = [ServerState(i, cfg) for i, cfg in enumerate(CLUSTER)]
        self.algo_key = algorithm
        self.algorithm = make_algorithm(algorithm)
        self.run = None
        self.session = None
        self.subscribers = set()
        self.pending_events = []
        self.seq = 0               # id toàn cục cho mỗi request đi qua LB (dùng cho live view)
        self.total = 0
        self.total_errors = 0
        self.tasks = []
        self.trace = deque()       # request gần nhất cho advisor: {t, ip, base, kind}
        self.trace_seq = 0         # tăng mỗi khi có request mới -> biết trace có thay đổi
        self.trace_gen = 0         # tăng mỗi lượt gửi mới -> bỏ kết quả mô phỏng của lượt cũ đang tính dở
        self.advice = None
        self.switches = deque(maxlen=MAX_SWITCH_LOG)
        self.pool = None
        self.shadows = Shadows([s.slow_factor for s in self.servers])
        self.history = History(algorithm)

    # ---------- Vòng đời ----------

    async def start(self):
        self.session = aiohttp.ClientSession(
            connector=aiohttp.TCPConnector(limit=0),
            timeout=aiohttp.ClientTimeout(total=120),
        )
        # Mô phỏng chạy ở tiến trình riêng: không tranh CPU (GIL) với LB đang chuyển tiếp request
        self.pool = ProcessPoolExecutor(max_workers=1)
        loop = asyncio.get_running_loop()
        self.tasks = [loop.create_task(self.health_loop()), loop.create_task(self.push_loop()),
                      loop.create_task(self.advice_loop())]

    async def stop(self):
        for t in self.tasks:
            t.cancel()
        if self.run and self.run.process and self.run.process.returncode is None:
            self.run.process.kill()
        for s in self.servers:
            if s.process and s.process.returncode is None:
                s.process.terminate()
        for ws in list(self.subscribers):
            await ws.close()
        await self.session.close()
        self.pool.shutdown(wait=False, cancel_futures=True)

    async def in_pool(self, fn, *args):
        return await asyncio.get_running_loop().run_in_executor(self.pool, fn, *args)

    # ---------- Điều khiển ----------

    def set_algorithm(self, key, source="manual"):
        """Đổi thuật toán ngay lập tức. Request đã chuyển tới server vẫn xử lý tiếp ở đó,
        chỉ request mới dùng thuật toán mới. Được phép đổi giữa lượt chạy (khi tắc nghẽn):
        lượt chạy ghi lại thời điểm đổi để mô phỏng đối chiếu đổi đúng như vậy.
        source: "manual" (admin chọn tay) / "advice" (bấm nút theo đề xuất) — ghi vào lịch sử."""
        algorithm = make_algorithm(key)  # ném ValueError nếu sai key
        if key == self.algo_key:
            return
        old = self.algo_key
        self.algorithm = algorithm
        self.algo_key = key
        self.history.start_segment(key, source)
        self.switches.appendleft({"at": datetime.now().strftime("%H:%M:%S"), "from": old, "to": key})
        run = self.run
        if run and run.status == "running":
            t = run.rel_ms(time.perf_counter()) if run.t0 is not None else 0.0
            if t <= 0:
                run.schedule[-1][1] = key   # chưa có request nào: đổi luôn thuật toán ban đầu
            else:
                run.schedule.append([round(t, 3), key])

    # ---------- Cụm server ----------

    def busy(self):
        return bool(self.run and self.run.status in ("running", "saving"))

    def cluster_params(self):
        """Tham số server của cụm hiện tại (mọi server, kể cả đang tắt) cho lượt đo và mô phỏng đối chiếu."""
        factors = [s.slow_factor for s in self.servers]
        slow = [f for f in factors if f != 1]
        return {"num_servers": len(factors), "factors": factors, "num_slow_servers": len(slow),
                "slow_factor": slow[0] if slow else 1}

    def server_at(self, index):
        if not 0 <= index < len(self.servers):
            raise ClusterError("Không có server số %d" % index)
        return self.servers[index]

    async def set_slow_factor(self, index, factor):
        """Đổi hệ số chậm: báo Web Server thật trước, thành công mới cập nhật LB và cụm ảo."""
        server = self.server_at(index)
        if factor not in SLOW_FACTOR_CHOICES:
            raise ClusterError("Hệ số chậm phải là một trong %s" % SLOW_FACTOR_CHOICES)
        try:
            async with self.session.post(server.base_url + "/config", json={"slow_factor": factor},
                                         timeout=aiohttp.ClientTimeout(total=3)) as r:
                if r.status != 200:
                    raise ClusterError("%s từ chối đổi hệ số chậm (mã %d)" % (server.name, r.status))
        except (aiohttp.ClientError, asyncio.TimeoutError):
            raise ClusterError("Không kết nối được %s" % server.name)
        server.slow_factor = factor
        self.shadows.set_factor(index, factor)

    def set_enabled(self, index, enabled):
        server = self.server_at(index)
        if not enabled and sum(1 for s in self.servers if s.enabled and s is not server) == 0:
            raise ClusterError("Phải còn ít nhất 1 server đang bật")
        server.enabled = enabled
        self.shadows.set_enabled(index, enabled)

    async def ping(self, url):
        try:
            async with self.session.get(url + "/health", timeout=aiohttp.ClientTimeout(total=0.5)) as r:
                return r.status == 200
        except (aiohttp.ClientError, asyncio.TimeoutError):
            return False

    async def add_server(self):
        """Thêm server cuối cùng (hệ số ×1). Cổng đã có Web Server chạy sẵn thì dùng lại, không thì tự khởi động."""
        if self.busy():
            raise ClusterError("Đang gửi request, đợi gửi xong rồi thêm server")
        if len(self.servers) >= MAX_SERVERS:
            raise ClusterError("Tối đa %d server" % MAX_SERVERS)
        index = len(self.servers)
        cfg = {"name": "s%d" % index, "port": server_port(index), "slow_factor": 1}
        server = ServerState(index, cfg)
        if not await self.ping(server.base_url):
            server.process = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "backend.web_server", "--name", cfg["name"], "--port", str(cfg["port"]),
                stdout=asyncio.subprocess.DEVNULL)
            for _ in range(40):
                await asyncio.sleep(0.1)
                if server.process.returncode is not None:
                    raise ClusterError("Không khởi động được %s (cổng %d bị chiếm hoặc thiếu quyền?)"
                                       % (cfg["name"], cfg["port"]))
                if await self.ping(server.base_url):
                    break
            else:
                server.process.terminate()
                raise ClusterError("%s không phản hồi sau 4 giây" % cfg["name"])
        server.up = True
        self.servers.append(server)
        self.shadows.add_server(1)
        await self.set_slow_factor(index, 1)  # server chạy sẵn có thể đang ở hệ số khác

    def remove_server(self):
        """Bớt server cuối cùng. Request đang xử lý ở đó vẫn trả về bình thường."""
        if self.busy():
            raise ClusterError("Đang gửi request, đợi gửi xong rồi bớt server")
        if len(self.servers) <= MIN_SERVERS:
            raise ClusterError("Tối thiểu %d server" % MIN_SERVERS)
        if not any(s.enabled for s in self.servers[:-1]):
            raise ClusterError("Phải còn ít nhất 1 server đang bật")
        server = self.servers.pop()
        self.shadows.remove_last()
        if server.process and server.process.returncode is None:
            server.process.terminate()

    def reset_counters(self):
        for s in self.servers:
            s.done = 0
            s.errors = 0
            s.recent_rt.clear()
        self.shadows.reset()
        self.total = 0
        self.total_errors = 0

    def begin_run(self, run_id, algorithm, params):
        """Chuẩn bị lượt chạy. Thuật toán và lịch sử response time được làm mới
        giống như mỗi lượt mô phỏng bắt đầu từ trạng thái sạch."""
        if self.run and self.run.status in ("running", "saving"):
            raise RuntimeError("Đang có lượt chạy khác")
        self.set_algorithm(algorithm)
        self.algorithm = make_algorithm(algorithm)  # luôn bắt đầu từ trạng thái sạch
        self.reset_counters()
        self.history.clear(algorithm, "run")  # mỗi lượt gửi có lịch sử riêng, bắt đầu lại từ giai đoạn 1
        self.run = Run(run_id, algorithm, params)
        # Phần so sánh 4 thuật toán + 4 sơ đồ bắt đầu lại từ đầu cho lượt gửi mới
        self.trace.clear()
        self.trace_seq += 1
        self.trace_gen += 1
        self.shadows = self.new_shadows()
        self.advice = None
        self.broadcast({"type": "advice", "advice": None})
        self.broadcast(self.history_message())
        return self.run

    def new_shadows(self):
        """Cụm ảo sạch (không còn request nào), cùng hệ số chậm và trạng thái bật / tắt với cụm thật."""
        shadows = Shadows([s.slow_factor for s in self.servers])
        for s in self.servers:
            shadows.set_enabled(s.index, s.enabled)
        return shadows

    def state(self):
        return {
            "api": API_VERSION,
            "algorithm": self.algo_key,
            "algorithm_name": ALGO_NAMES[self.algo_key],
            "algorithms": [{"key": c.key, "name": c.name} for c in ALGORITHMS],
            "servers": [s.snapshot() for s in self.servers],
            "total": self.total,
            "errors": self.total_errors,
            "run": self.run.summary() if self.run else None,
            "switches": list(self.switches),
            "advice": self.advice,
            "shadows": self.shadows.snapshot(),
            "limits": {"min_servers": MIN_SERVERS, "max_servers": MAX_SERVERS, "factors": SLOW_FACTOR_CHOICES},
        }

    # ---------- Reverse proxy ----------

    async def handle(self, request):
        now = time.perf_counter()
        fwd = request.headers.get("X-Forwarded-For", "")
        client_ip = fwd.split(",")[0].strip() or request.remote or "0.0.0.0"
        kind = request.headers.get("X-Request-Kind", "light")
        run, req_id = self.match_run(request, now)

        active = [s for s in self.servers if s.enabled]
        if not active:
            return web.json_response({"error": "Không có server nào đang bật"}, status=503)
        # Thuật toán chỉ thấy các server đang bật (Round Robin xoay vòng, IP Hash băm trên số server này)
        server = active[self.algorithm.choose({"client_ip": client_ip}, active, now * 1000.0)]
        idx = server.index
        server.open_connections += 1
        segment = self.history.on_arrival(server.name, now)
        self.seq += 1
        gid = self.seq
        self.total += 1
        algo_key = self.algo_key
        self.emit({"e": "a", "id": gid, "s": idx, "k": kind, "ip": client_ip, "g": algo_key})
        try:
            declared = float(request.headers["X-Work-Ms"])
        except (KeyError, ValueError):
            declared = None
        self.shadows.on_request(now * 1000.0, gid, declared, client_ip, kind, algo_key, self.emit)
        rec = {"t": now, "ip": client_ip, "base": declared, "kind": kind, "wait": None}
        self.add_trace(rec, now)
        if run:
            arrival = run.rel_ms(now)
            run.assignments[req_id] = {"request_id": req_id, "server": idx, "arrival": arrival}
            run.events.append({"t": arrival, "type": "ARRIVAL", "request_id": req_id,
                               "server": idx, "open_connections_after": server.open_connections})

        body = await request.read()
        headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_HEADERS}
        headers["X-Forwarded-For"] = client_ip
        status, resp_headers, resp_body = 502, {}, b""
        try:
            async with self.session.request(request.method, server.base_url + request.path_qs,
                                            headers=headers, data=body) as resp:
                resp_body = await resp.read()
                status = resp.status
                resp_headers = {k: v for k, v in resp.headers.items() if k.lower() not in HOP_HEADERS}
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            resp_body = json.dumps({"error": "Không kết nối được %s: %s" % (server.name, exc)}).encode()
            resp_headers = {"Content-Type": "application/json"}
            server.up = False
        finally:
            server.open_connections -= 1

        end = time.perf_counter()
        ok = status < 500
        response_ms = (end - now) * 1000.0
        if ok:
            server.done += 1
            server.recent_rt.append(response_ms)
        else:
            server.errors += 1
            self.total_errors += 1
        self.emit({"e": "f", "id": gid, "s": idx, "ok": ok, "g": algo_key})
        service = parse_service(resp_body) if ok else None
        if rec["base"] is None:
            # Không khai báo thời gian xử lý: lấy thời gian server đo được, quy về server chuẩn (×1)
            rec["base"] = service / server.slow_factor if service is not None else 0.0
            self.shadows.learn_base(rec["base"])
        rec["wait"] = max(0.0, response_ms - (service or 0.0))
        self.history.on_finish(segment, ok, rec["wait"], response_ms, server.name)
        if run:
            self.record_finish(run, req_id, idx, end, service, server.open_connections)

        resp_headers["X-Upstream-Server"] = server.name
        return web.Response(status=status, body=resp_body, headers=resp_headers)

    def match_run(self, request, now):
        """Request có thuộc lượt chạy đang hoạt động không? Trả (run, request_id)."""
        run = self.run
        if not run or run.status != "running" or request.headers.get("X-Run-Id") != str(run.id):
            return None, None
        try:
            req_id = int(request.headers.get("X-Request-Id", ""))
        except ValueError:
            return None, None
        if not 0 <= req_id < run.total or req_id in run.seen:
            return None, None
        run.seen.add(req_id)
        if run.t0 is None:
            # Mốc 0 = lúc request đầu tiên tới trừ đi thời điểm đến dự kiến của nó
            run.t0 = now - run.requests[req_id]["arrival_time"] / 1000.0
        return run, req_id

    def record_finish(self, run, req_id, idx, end, service, open_after):
        finish = run.rel_ms(end)
        a = run.assignments[req_id]
        if service is None:
            run.errors += 1
            del run.assignments[req_id]
        else:
            # Chờ = toàn bộ thời gian không xử lý (hàng đợi server + mạng + proxy),
            # nên response = wait + service đúng như bản mô phỏng.
            a["finish"] = finish
            a["service_time"] = service
            a["response"] = finish - a["arrival"]
            a["wait"] = max(0.0, a["response"] - service)
            a["start"] = a["arrival"] + a["wait"]
        run.events.append({"t": finish, "type": "FINISH", "request_id": req_id,
                           "server": idx, "open_connections_after": open_after})
        run.completed += 1
        if run.completed == run.total:
            self.finish_run(run)

    def finish_run(self, run, error=None):
        if run.status != "running":
            return
        # Chỉ lấy request đã xử lý xong (request còn dở khi client thoát sớm thì bỏ qua)
        assign = [run.assignments[i] for i in sorted(run.assignments) if "finish" in run.assignments[i]]
        for a in assign:
            for k in ("arrival", "start", "finish", "service_time", "wait", "response"):
                a[k] = round(a[k], 3)
        for e in run.events:
            e["t"] = round(e["t"], 3)

        missing = run.total - run.completed
        if error is None and missing:
            error = "Thiếu %d request (client dừng sớm)" % missing
        if error is None and run.errors:
            error = "%d request lỗi" % run.errors
        final = "done" if not missing and not run.errors else "failed"
        # "saving": đã nhận đủ phản hồi, đang tính số liệu + mô phỏng đối chiếu rồi lưu DB
        run.status = "saving"
        asyncio.get_running_loop().create_task(self.save_run(run, assign, error, final))

    async def save_run(self, run, assign, error, final):
        metrics = None
        if assign:
            ok_ids = set(a["request_id"] for a in assign)
            reqs = [r for r in run.requests if r["id"] in ok_ids]
            events = [e for e in run.events if e["request_id"] in ok_ids]
            metrics = compute_metrics(reqs, assign, events, run.params)
        # Mô phỏng đúng bộ request + đúng lịch đổi thuật toán để đối chiếu với số đo thật
        sim = await self.in_pool(simulate_run, run.requests, run.schedule, run.params)
        db.finish_run(run.id, final, error, metrics, sim["metrics"], assign, run.events,
                      run.errors, run.schedule)
        run.status = final
        self.broadcast({"type": "run_finished", "run": run.summary()})

    async def watch_client(self, run, process):
        """Đợi tiến trình client kết thúc. Client chỉ thoát sau khi nhận đủ phản hồi,
        nên nếu lúc đó lượt chạy chưa xong nghĩa là client bị lỗi giữa chừng."""
        run.process = process
        out, _ = await process.communicate()
        if run.status == "running":
            tail = out.decode("utf-8", "replace").strip().splitlines()[-3:] if out else []
            msg = "Client thoát (mã %s)" % process.returncode
            if tail:
                msg += ": " + " | ".join(tail)
            self.finish_run(run, msg)

    # ---------- Đề xuất thuật toán từ traffic thật ----------

    # Phạm vi so sánh: từ lúc bấm "Bắt đầu gửi" gần nhất (giữ nguyên kết quả sau khi gửi xong,
    # tới lượt gửi sau mới xóa). Chưa gửi lần nào thì dùng traffic 20 giây gần nhất.

    def add_trace(self, rec, now):
        self.trace.append(rec)
        self.trace_seq += 1
        while self.trace and (len(self.trace) > advisor.MAX_TRACE or
                              (self.run is None and now - self.trace[0]["t"] > advisor.WINDOW)):
            self.trace.popleft()

    def trace_window(self):
        if self.run is None:
            now = time.perf_counter()
            while self.trace and now - self.trace[0]["t"] > advisor.WINDOW:
                self.trace.popleft()
        return [dict(r) for r in self.trace]

    @staticmethod
    def real_stats(trace):
        waits = [r["wait"] for r in trace if r["wait"] is not None]
        return {
            "avg_wait": round(sum(waits) / len(waits), 2) if waits else None,
            "completed": len(waits),
            "pending": len(trace) - len(waits),
        }

    def active_cluster(self):
        """(hệ số chậm, tên) của các server đang bật: advisor mô phỏng đúng cụm hiện tại."""
        active = [s for s in self.servers if s.enabled]
        return [s.slow_factor for s in active], [s.name for s in active]

    async def advice_loop(self):
        last_seq = -1
        last_cluster = None
        while True:
            await asyncio.sleep(ADVICE_INTERVAL)
            trace = self.trace_window()
            if len(trace) < advisor.MIN_REQUESTS:
                if self.advice is not None:
                    self.advice = None
                    self.broadcast({"type": "advice", "advice": None})
                continue
            factors, names = self.active_cluster()
            # Không có request mới thì chỉ cần cập nhật khi đổi thuật toán hoặc đổi cụm server
            # (còn request đang chờ thì vẫn tính lại để số "đo thật" cập nhật khi chúng xong)
            if (self.trace_seq == last_seq and self.advice and self.advice["current"] == self.algo_key
                    and last_cluster == (factors, names) and not self.advice["real"]["pending"]):
                continue
            last_seq = self.trace_seq
            last_cluster = (factors, names)
            gen = self.trace_gen
            try:
                result = await self.in_pool(advisor.analyze, trace, self.algo_key, self.real_stats(trace),
                                            factors, names)
            except Exception as exc:  # không để lỗi mô phỏng làm dừng vòng lặp
                print("[advisor] lỗi:", exc, flush=True)
                continue
            if gen != self.trace_gen:
                continue                      # vừa bắt đầu lượt gửi mới trong lúc đang mô phỏng
            result["current"] = self.algo_key  # thuật toán có thể vừa đổi trong lúc mô phỏng
            result["current_name"] = ALGO_NAMES[self.algo_key]
            best = result["best"]
            result["suggest"] = result["suggest"] and best != self.algo_key
            result["updated_at"] = datetime.now().strftime("%H:%M:%S")
            run = self.run
            result["scope"] = {"run_id": run.id, "status": run.status, "completed": run.completed,
                               "total": run.total} if run else None
            self.advice = result
            self.broadcast({"type": "advice", "advice": result})

    async def snapshot(self):
        trace = self.trace_window()
        if len(trace) < advisor.MIN_REQUESTS:
            return None
        return await self.in_pool(advisor.snapshot, trace, self.active_cluster()[0])

    # ---------- Theo dõi ----------

    async def health_loop(self):
        timeout = aiohttp.ClientTimeout(total=max(0.5, HEALTH_INTERVAL / 2))
        while True:
            async def check(s):
                try:
                    async with self.session.get(s.base_url + "/health", timeout=timeout) as r:
                        s.up = r.status == 200
                except (aiohttp.ClientError, asyncio.TimeoutError):
                    s.up = False
            await asyncio.gather(*(check(s) for s in self.servers))
            await asyncio.sleep(HEALTH_INTERVAL)

    def emit(self, event):
        if self.subscribers and len(self.pending_events) < MAX_PENDING_EVENTS:
            self.pending_events.append(event)

    def broadcast(self, msg):
        data = json.dumps(msg)
        for ws in list(self.subscribers):
            if ws.closed:
                self.subscribers.discard(ws)
            else:
                asyncio.ensure_future(self.send(ws, data))

    async def send(self, ws, data):
        try:
            await ws.send_str(data)
        except (ConnectionError, RuntimeError):
            self.subscribers.discard(ws)

    def history_message(self):
        return dict(self.history.snapshot(), type="history")

    async def push_loop(self):
        """Gom sự kiện và đẩy lên trang admin mỗi PUSH_INTERVAL giây (thay vì từng sự kiện).
        Lịch sử thay đổi chậm nên chỉ gửi tối đa 1 lần/giây."""
        sent_version, sent_at = -1, 0.0
        while True:
            await asyncio.sleep(PUSH_INTERVAL)
            now = time.perf_counter()
            # Cụm ảo xử lý xong request theo thời gian, kể cả lúc không có request mới
            self.shadows.advance(now * 1000.0, self.emit)
            self.history.tick(self.servers, self.run.params["overload_threshold"] if self.run else 5)
            if not self.subscribers:
                continue
            if self.history.version != sent_version and now - sent_at >= 1.0:
                sent_version, sent_at = self.history.version, now
                self.broadcast(self.history_message())
            msg = self.state()
            msg["type"] = "state"
            msg["events"] = self.pending_events
            self.pending_events = []
            self.broadcast(msg)


def parse_service(body):
    """Thời gian xử lý (ms) do Web Server trả về trong JSON, None nếu không có."""
    try:
        return float(json.loads(body)["service_ms"])
    except (ValueError, KeyError, TypeError):
        return None


def make_proxy_app(lb):
    app = web.Application(client_max_size=10 * 1024 * 1024)
    app.router.add_route("*", "/{tail:.*}", lb.handle)
    return app
