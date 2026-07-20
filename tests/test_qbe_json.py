from __future__ import annotations

import os
import json
import sqlite3
import subprocess
import sys
import numpy as np
import pytest
import soundfile as sf

def test_qbe_json_flag_help():
    # Verify that --json is listed in --help
    proc = subprocess.run(
        [sys.executable, "scripts/query_by_example.py", "--help"],
        capture_output=True, text=True, check=True
    )
    assert "--json" in proc.stdout

def test_qbe_json_output(tmp_path):
    db_path = tmp_path / "test_batch.db"
    wav_path = tmp_path / "test_audio.wav"
    
    # 1. Create a dummy WAV file (3 seconds at 16000Hz)
    sr = 16000
    y = np.zeros(int(3.0 * sr), dtype=np.float32)
    sf.write(str(wav_path), y, sr)
    
    # 2. Setup SQLite DB
    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE sessions (
            id INTEGER PRIMARY KEY,
            output_dir TEXT
        )
    """)
    cursor.execute("""
        CREATE TABLE files (
            id INTEGER PRIMARY KEY,
            path TEXT
        )
    """)
    cursor.execute("""
        CREATE TABLE events (
            id INTEGER PRIMARY KEY,
            session_id INTEGER,
            file_id INTEGER,
            t_start REAL,
            t_end REAL,
            f_low REAL,
            f_high REAL,
            stage_a_conf REAL,
            retained INTEGER
        )
    """)
    
    # Insert session, file, events
    cursor.execute("INSERT INTO sessions (id, output_dir) VALUES (1, ?)", (str(tmp_path),))
    cursor.execute("INSERT INTO files (id, path) VALUES (1, ?)", (str(wav_path),))
    
    # Insert two events: query event and a candidate match event
    cursor.execute("""
        INSERT INTO events (id, session_id, file_id, t_start, t_end, f_low, f_high, stage_a_conf, retained)
        VALUES (1, 1, 1, 0.5, 1.0, 1000.0, 2000.0, 0.8, 1)
    """)
    cursor.execute("""
        INSERT INTO events (id, session_id, file_id, t_start, t_end, f_low, f_high, stage_a_conf, retained)
        VALUES (2, 1, 1, 1.5, 2.0, 1000.0, 2000.0, 0.9, 1)
    """)
    conn.commit()
    conn.close()
    
    # Run query_by_example.py with --json
    proc = subprocess.run([
        sys.executable, "scripts/query_by_example.py",
        "--db", str(db_path),
        "--query-id", "1",
        "--json",
        "--cache-dir", str(tmp_path)
    ], capture_output=True, text=True)
    
    # Since we expect it to print JSON on stdout, let's parse it
    assert proc.returncode == 0, f"QBE failed:\nSTDOUT: {proc.stdout}\nSTDERR: {proc.stderr}"
    
    # Load and assert structure
    results = json.loads(proc.stdout.strip())
    assert isinstance(results, list)
    assert len(results) > 0
    assert results[0]["id"] == 2
    assert "similarity" in results[0]
    assert results[0]["retained"] == 1
