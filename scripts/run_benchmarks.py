import os
import subprocess
import time
import sqlite3

# Define paths
DROPBOX_HOT_FILE = "/Users/leyangloh/Library/CloudStorage/Dropbox-GaTech/Le Yang Loh/Sural_AudioMoths/High_elevation/PSH1/3_06_2024_29_06_2024/20240603_040000.WAV"
DROPBOX_COLD_FILE = "/Users/leyangloh/Library/CloudStorage/Dropbox-GaTech/Le Yang Loh/Sural_AudioMoths/High_elevation/PSH1/3_06_2024_29_06_2024/20240603_050000.WAV"
SEAGATE_FILE = "/Volumes/Seagate/Sural_AudioMoths/Mid_elevation/PSM1/M1/26_05_2024_24_07_2024/20240526_040000.WAV"

DB_DIR = "test_output/benchmarks"
os.makedirs(DB_DIR, exist_ok=True)

tests = [
    {
        "name": "Dropbox (Hot - Cached SSD)",
        "file": DROPBOX_HOT_FILE,
        "db": os.path.join(DB_DIR, "dropbox_hot.db")
    },
    {
        "name": "Dropbox (Cold - On-Demand Download)",
        "file": DROPBOX_COLD_FILE,
        "db": os.path.join(DB_DIR, "dropbox_cold.db")
    },
    {
        "name": "Seagate HDD (External USB)",
        "file": SEAGATE_FILE,
        "db": os.path.join(DB_DIR, "seagate_hdd.db")
    }
]

def run_benchmark(test):
    print(f"\n==================================================")
    print(f"Running benchmark: {test['name']}")
    print(f"File: {test['file']}")
    print(f"==================================================")
    
    # Remove existing db to ensure clean run
    if os.path.exists(test['db']):
        os.remove(test['db'])
        
    start_time = time.time()
    
    cmd = [
        "cargo", "run", "-p", "batch-core", "--bin", "batch", "--",
        "--input", test['file'],
        "--db", test['db'],
        "--device", "mps"
    ]
    
    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as e:
        print(f"Error running benchmark for {test['name']}: {e}")
        return None
        
    wall_time = time.time() - start_time
    
    # Read elapsed_ms from database
    try:
        conn = sqlite3.connect(test['db'])
        cursor = conn.cursor()
        cursor.execute("SELECT elapsed_ms FROM files LIMIT 1;")
        row = cursor.fetchone()
        elapsed_ms = row[0] if row else 0
        conn.close()
    except Exception as e:
        print(f"Failed to read database: {e}")
        elapsed_ms = 0
        
    return {
        "wall_time": wall_time,
        "elapsed_ms": elapsed_ms
    }

results = {}
for test in tests:
    # Check if file exists first
    if not os.path.exists(test['file']):
        print(f"\n[Warning] File does not exist, skipping: {test['file']}")
        continue
        
    res = run_benchmark(test)
    if res:
        results[test['name']] = res

# Display comparison results
print("\n" + "="*80)
print(f"{'Benchmark Location':<35} | {'Wall Time (s)':<15} | {'Pipeline I/O (s)':<18} | {'Throughput (MB/s)':<18}")
print("="*80)

FILE_SIZE_MB = 86.4

for name, res in results.items():
    wall_s = res['wall_time']
    io_s = res['elapsed_ms'] / 1000.0
    throughput = FILE_SIZE_MB / io_s if io_s > 0 else 0
    print(f"{name:<35} | {wall_s:<15.2f} | {io_s:<18.2f} | {throughput:<18.2f}")
print("="*80)
