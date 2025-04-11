import sqlite3
import requests
import argparse
from datetime import datetime
from apscheduler.schedulers.background import BackgroundScheduler
import time
import os
import subprocess
import signal
import sys

# Parse command-line arguments for subtaskID.
parser = argparse.ArgumentParser(description='OCR Data Uploader for a Subtask')
parser.add_argument('--subtaskID', type=int, required=True, help='ID of the subtask being processed')
args = parser.parse_args()
SUBTASK_ID = args.subtaskID

# Configuration
SENDER_ID = "sender123"  # This should match the sender's ID in your system.
TASK_ID = 1              # Update based on the assigned task.
SQLITE_DB_PATH = r"C:\Users\shiva\.screenpipe\db.sqlite"
SERVER_UPLOAD_URL = "http://localhost:3000/api/upload"
MARKER_FILE = "last_frame_id.txt"

# Global variables
screenpipe_process = None
scheduler = None

# Signal handler for graceful shutdown
def signal_handler(sig, frame):
    print(f"Received signal {sig}, shutting down...")
    if scheduler:
        scheduler.shutdown(wait=False)
    stop_screenpipe()
    print("Uploader stopped.")
    sys.exit(0)

# Register signal handlers
signal.signal(signal.SIGTERM, signal_handler)
signal.signal(signal.SIGINT, signal_handler)

def start_screenpipe():
    """Starts screenpipe in a new terminal window."""
    global screenpipe_process
    if screenpipe_process:
        print("Screenpipe is already running.")
        return

    try:
        # Start screenpipe in a new console window
        screenpipe_process = subprocess.Popen(
            'screenpipe',  # Directly call the executable or command
            creationflags=subprocess.CREATE_NEW_CONSOLE  # Create a new terminal window
        )
        print(f"Screenpipe launched in a new terminal window with PID: {screenpipe_process.pid}")
    except Exception as e:
        print("Failed to start screenpipe:", e)

def stop_screenpipe():
    """Forcefully terminates screenpipe and its terminal window."""
    global screenpipe_process
    if not screenpipe_process:
        print("Screenpipe was not running.")
        return

    try:
        # Force kill entire process tree using taskkill (Windows-specific)
        subprocess.run(
            ['taskkill', '/F', '/T', '/PID', str(screenpipe_process.pid)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        print("Terminal window and screenpipe terminated.")
    except subprocess.CalledProcessError as e:
        print(f"Terminal already closed or error terminating: {e}")
    finally:
        screenpipe_process = None

def read_last_frame_id():
    """Reads the last processed frame ID from a marker file."""
    if not os.path.exists(MARKER_FILE):
        return 0
    try:
        with open(MARKER_FILE, "r") as f:
            return int(f.read().strip())
    except ValueError:
        return 0

def update_last_frame_id(new_last):
    """Updates the marker file with the latest processed frame ID."""
    with open(MARKER_FILE, "w") as f:
        f.write(str(new_last))

def fetch_new_ocr_data():
    """Fetches new OCR data from the SQLite database."""
    last_id = read_last_frame_id()
    conn = sqlite3.connect(SQLITE_DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT frame_id, text FROM ocr_text WHERE frame_id > ?", (last_id,))
    rows = cursor.fetchall()
    conn.close()
    return rows

def push_data():
    """Pushes new OCR data to the server."""
    new_rows = fetch_new_ocr_data()
    if not new_rows:
        print("No new OCR data to send.")
        return
    max_frame_id = max(r[0] for r in new_rows)
    
    # Filter data for every 5th frame only
    filtered = [r for r in new_rows if r[0] % 5 == 0]
    
    if not filtered:
        print("No 5th-frame data; updating marker.")
        update_last_frame_id(max_frame_id)
        return

    payload = {
        "senderId": SENDER_ID,
        "taskId": TASK_ID,
        "subtaskId": SUBTASK_ID,
        "timestamp": datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        "data": [{"frame_id": fid, "data": txt} for fid, txt in filtered]
    }
    
    try:
        resp = requests.post(SERVER_UPLOAD_URL, json=payload)
        resp.raise_for_status()
        
        try:
            print("Server response:", resp.json())
        except ValueError:
            print("Non-JSON response:", resp.text)
        
        update_last_frame_id(max_frame_id)
    
    except requests.RequestException as e:
        print("Error sending data:", e)

if __name__ == "__main__":
    print(f"Starting OCR Uploader for subtask {SUBTASK_ID}...")
    
    # Launch Screenpipe
    start_screenpipe()

    # Schedule data pushes every 5 minutes
    scheduler = BackgroundScheduler()
    scheduler.add_job(push_data, 'interval', minutes=5)
    
    scheduler.start()
    
    print(f"OCR Uploader started for subtask {SUBTASK_ID}. Data will push every 5 minutes.")
    print("Press Ctrl+C to stop.")

    try:
        # Keep the main thread alive
        while True:
            time.sleep(1)
    
    except (KeyboardInterrupt, SystemExit):
        print("Shutting down OCR uploader...") 
        
        scheduler.shutdown(wait=False)  # Stop scheduler gracefully
        
        stop_screenpipe()  # Terminate screenpipe and its terminal
        
        print("Uploader stopped.")
        
        sys.exit(0)
