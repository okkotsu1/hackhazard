import sqlite3
import requests
import argparse
from datetime import datetime
from apscheduler.schedulers.background import BackgroundScheduler
import time
import os
import subprocess

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

# Global variable to hold the Screenpipe process reference.
screenpipe_process = None

def start_screenpipe():
    """Starts the screenpipe process and stores the reference globally."""
    global screenpipe_process
    # Launch screenpipe; this assumes that "screenpipe" is available in the PATH.
    try:
        screenpipe_process = subprocess.Popen(["screenpipe"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        print("Screenpipe started successfully.")
    except Exception as e:
        print("Failed to start screenpipe:", e)

def stop_screenpipe():
    """Stops the screenpipe process if it is running."""
    global screenpipe_process
    if screenpipe_process:
        screenpipe_process.terminate()
        screenpipe_process.wait()  # Ensure it terminates.
        print("Screenpipe stopped.")
        screenpipe_process = None
    else:
        print("Screenpipe was not running.")

def read_last_frame_id():
    if not os.path.exists(MARKER_FILE):
        return 0
    try:
        with open(MARKER_FILE, "r") as f:
            return int(f.read().strip())
    except ValueError:
        return 0

def update_last_frame_id(new_last):
    with open(MARKER_FILE, "w") as f:
        f.write(str(new_last))

def fetch_new_ocr_data():
    last_id = read_last_frame_id()
    conn = sqlite3.connect(SQLITE_DB_PATH)
    cursor = conn.cursor()
    query = "SELECT frame_id, text FROM ocr_text WHERE frame_id > ?"
    cursor.execute(query, (last_id,))
    rows = cursor.fetchall()
    conn.close()
    return rows

def push_data():
    new_rows = fetch_new_ocr_data()
    if not new_rows:
        print("No new OCR data to send.")
        return
    max_frame_id = max(row[0] for row in new_rows)
    # Filter: send only every 5th frame.
    filtered_rows = [row for row in new_rows if row[0] % 5 == 0]
    if not filtered_rows:
        print("No rows matching every 5th frame found; updating marker.")
        update_last_frame_id(max_frame_id)
        return
    data_list = [{"frame_id": frame_id, "data": text} for frame_id, text in filtered_rows]
    payload = {
        "senderId": SENDER_ID,
        "taskId": TASK_ID,
        "subtaskId": SUBTASK_ID,  # Identify which subtask this OCR data belongs to.
        "timestamp": datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        "data": data_list
    }
    try:
        response = requests.post(SERVER_UPLOAD_URL, json=payload)
        response.raise_for_status()
        try:
            print("Server response:", response.json())
        except ValueError:
            print("Unable to decode JSON response. Raw response:")
            print(response.text)
        update_last_frame_id(max_frame_id)
    except requests.exceptions.RequestException as e:
        print("Error sending data:", e)

if __name__ == "__main__":
    # Start Screenpipe automatically.
    start_screenpipe()
    
    # Set up a scheduler to push OCR data every 5 minutes.
    scheduler = BackgroundScheduler()
    scheduler.add_job(push_data, 'interval', minutes=5)
    scheduler.start()
    print(f"Sender OCR Uploader started for subtask {SUBTASK_ID}. Uploading OCR data every 5 minutes...")
    
    try:
        while True:
            time.sleep(1)
    except (KeyboardInterrupt, SystemExit):
        print("Stopping sender OCR uploader...")
        scheduler.shutdown()
        # Stop the Screenpipe process along with the script.
        stop_screenpipe()
        print("Sender OCR uploader stopped.")
