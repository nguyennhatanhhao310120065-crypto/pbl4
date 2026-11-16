"""Chạy toàn bộ hệ thống bằng 1 lệnh: 4 Web Server + Load Balancer + trang admin.

    python run.py

Ctrl+C để tắt tất cả.
"""

import subprocess
import sys
import time

from backend.config import CLUSTER


def main():
    procs = []
    try:
        for s in CLUSTER:
            procs.append(subprocess.Popen([
                sys.executable, "-m", "backend.web_server",
                "--name", s["name"], "--port", str(s["port"]), "--slow-factor", str(s["slow_factor"]),
            ]))
        time.sleep(0.5)
        for p in procs:
            if p.poll() is not None:
                raise SystemExit("Một Web Server không khởi động được (cổng bị chiếm hoặc thiếu quyền?)")
        lb = subprocess.Popen([sys.executable, "-m", "backend.main"])
        procs.append(lb)
        lb.wait()
    except KeyboardInterrupt:
        pass
    finally:
        for p in procs:
            if p.poll() is None:
                p.terminate()
        for p in procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()


if __name__ == "__main__":
    main()
