"""Lưu lịch sử các lượt chạy thật vào SQLite (thư viện chuẩn, không cần cài thêm)."""

import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime

from backend.config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at   TEXT NOT NULL,
    finished_at  TEXT,
    algorithm    TEXT NOT NULL,
    params       TEXT NOT NULL,
    status       TEXT NOT NULL,   -- running / done / failed
    error        TEXT,
    errors       INTEGER DEFAULT 0,
    metrics      TEXT,            -- số liệu đo thật
    sim_metrics  TEXT,            -- số liệu mô phỏng cùng bộ request để đối chiếu
    assignments  TEXT,            -- log từng request
    events       TEXT,            -- ARRIVAL/FINISH theo thời gian (để phát lại)
    schedule     TEXT             -- [[t_ms, thuật toán], ...] nếu đổi thuật toán giữa lượt chạy
);
"""

JSON_FIELDS = ("params", "metrics", "sim_metrics", "assignments", "events", "schedule")


@contextmanager
def connect():
    """Mở kết nối, tự commit (hoặc rollback khi lỗi) rồi đóng."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def init():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with connect() as conn:
        conn.executescript(SCHEMA)
        # DB tạo từ phiên bản cũ chưa có cột schedule
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(runs)")]
        if "schedule" not in cols:
            conn.execute("ALTER TABLE runs ADD COLUMN schedule TEXT")
        # Lượt chạy còn "running" là do lần trước tắt chương trình giữa chừng
        conn.execute("UPDATE runs SET status='failed', error='Chương trình bị tắt khi đang chạy' "
                     "WHERE status='running'")


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def create_run(algorithm, params):
    with connect() as conn:
        cur = conn.execute("INSERT INTO runs (created_at, algorithm, params, status) VALUES (?, ?, ?, 'running')",
                           (now(), algorithm, json.dumps(params)))
        return cur.lastrowid


def finish_run(run_id, status, error, metrics, sim_metrics, assignments, events, errors, schedule):
    with connect() as conn:
        conn.execute(
            "UPDATE runs SET finished_at=?, status=?, error=?, metrics=?, sim_metrics=?, "
            "assignments=?, events=?, errors=?, schedule=? WHERE id=?",
            (now(), status, error, json.dumps(metrics), json.dumps(sim_metrics),
             json.dumps(assignments), json.dumps(events), errors, json.dumps(schedule), run_id))


def _decode(row, fields):
    out = dict(row)
    for f in fields:
        if f in out:
            out[f] = json.loads(out[f]) if out[f] else None
    return out


def list_runs(limit=100):
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, created_at, finished_at, algorithm, params, status, error, errors, metrics, sim_metrics, "
            "schedule "
            "FROM runs ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [_decode(r, JSON_FIELDS) for r in rows]


def get_run(run_id):
    with connect() as conn:
        row = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
    return _decode(row, JSON_FIELDS) if row else None


def delete_run(run_id):
    with connect() as conn:
        return conn.execute("DELETE FROM runs WHERE id=? AND status!='running'", (run_id,)).rowcount
