# push_ocr_data.py
import sqlite3
import requests
import argparse
import os
import subprocess
import signal
import sys
import time
from datetime import datetime
from apscheduler.schedulers.background import BackgroundScheduler

# --- CLI args ---
parser = argparse.ArgumentParser(description='OCR Data Uploader for a Subtask')
parser.add_argument('--taskID',    type=int,   required=True, help='ID of the task being processed')
parser.add_argument('--subtaskID', type=int,   required=True, help='ID of the subtask being processed')
parser.add_argument('--criteria',  type=str,   required=True, help='OCR criteria for pass/fail')
args = parser.parse_args()

TASK_ID     = args.taskID
SUBTASK_ID  = args.subtaskID
CRITERIA    = args.criteria
SENDER_ID   = "sender123"
DB_PATH     = r"C:\Users\shiva\.screenpipe\db.sqlite"
UPLOAD_URL  = "http://localhost:3000/api/upload"
MARKER_FILE = "last_frame_id.txt"

screenpipe_process = None
scheduler = None

def signal_handler(sig, frame):
    if scheduler:
        scheduler.shutdown(wait=False)
    stop_screenpipe()
    sys.exit(0)

signal.signal(signal.SIGTERM, signal_handler)
signal.signal(signal.SIGINT, signal_handler)

def start_screenpipe():
    global screenpipe_process
    if screenpipe_process:
        return
    try:
        screenpipe_process = subprocess.Popen(
            'screenpipe',
            creationflags=subprocess.CREATE_NEW_CONSOLE
        )
        print(f"Screenpipe launched (PID {screenpipe_process.pid})")
    except Exception as e:
        print("Failed to start screenpipe:", e)

def stop_screenpipe():
    global screenpipe_process
    if not screenpipe_process:
        return
    try:
        subprocess.run(
            ['taskkill', '/F', '/T', '/PID', str(screenpipe_process.pid)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        print("Screenpipe terminated.")
    except subprocess.CalledProcessError:
        pass
    finally:
        screenpipe_process = None

def read_last_frame_id():
    if not os.path.exists(MARKER_FILE):
        return 0
    try:
        with open(MARKER_FILE, 'r') as f:
            return int(f.read().strip())
    except:
        return 0

def update_last_frame_id(val):
    with open(MARKER_FILE, 'w') as f:
        f.write(str(val))

def fetch_new_ocr_data():
    last = read_last_frame_id()
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("SELECT frame_id, text FROM ocr_text WHERE frame_id > ?", (last,))
    rows = cur.fetchall()
    conn.close()
    return rows

def evaluate_task(filtered_data, criteria):
    # TODO: implement your pass/fail logic here
    return "pass"

def push_result():
    rows = fetch_new_ocr_data()
    if not rows:
        print("No new OCR data.")
        return
    max_id = max(r[0] for r in rows)
    filtered = [r for r in rows if r[0] % 5 == 0]
    result = evaluate_task(filtered, CRITERIA)

    payload = {
        "senderId": SENDER_ID,
        "taskId": TASK_ID,
        "subtaskId": SUBTASK_ID,
        "result": result
    }
    try:
        resp = requests.post(UPLOAD_URL, json=payload)
        resp.raise_for_status()
        try:
            print("Server response:", resp.json())
        except ValueError:
            print("Non-JSON response:", resp.text)
        update_last_frame_id(max_id)
    except requests.RequestException as e:
        print("Error sending result:", e)

if __name__ == "__main__":
    print(f"Starting OCR Uploader for Task {TASK_ID}, Subtask {SUBTASK_ID}...")
    start_screenpipe()
    scheduler = BackgroundScheduler()
    scheduler.add_job(push_result, 'interval', minutes=5)
    scheduler.start()
    print("Uploader started; pushing results every 5 minutes.")
    try:
        while True:
            time.sleep(1)
    except (KeyboardInterrupt, SystemExit):
        scheduler.shutdown(wait=False)
        stop_screenpipe()
        print("Uploader stopped.")
        sys.exit(0)
