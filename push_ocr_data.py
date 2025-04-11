import sqlite3
import requests
from datetime import datetime
from apscheduler.schedulers.background import BackgroundScheduler
import time
import os

# Configuration
SENDER_ID = "sender123"  # Change as needed
TASK_ID = 1              # Update based on the task assigned to this sender
SQLITE_DB_PATH = r"C:\Users\shiva\.screenpipe\db.sqlite"
SERVER_UPLOAD_URL = "http://localhost:3000/api/upload"
MARKER_FILE = "last_frame_id.txt"

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
        print("No new data to send.")
        return
    # Determine highest frame_id to update the marker
    max_frame_id = max(row[0] for row in new_rows)
    # Filter only every 5th frame (frame_id divisible by 5)
    filtered_rows = [row for row in new_rows if row[0] % 5 == 0]
    if not filtered_rows:
        print("No rows matching every 5th frame condition found; updating marker anyway.")
        update_last_frame_id(max_frame_id)
        return
    
    data_list = [{"frame_id": frame_id, "data": text} for frame_id, text in filtered_rows]
    payload = {
        "senderId": SENDER_ID,
        "taskId": TASK_ID,
        "timestamp": datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        "data": data_list
    }
    
    try:
        response = requests.post(SERVER_UPLOAD_URL, json=payload)
        response.raise_for_status()
        try:
            result = response.json()
            print("Server response:", result)
        except ValueError:
            print("Unable to decode JSON. Raw response:", response.text)
        update_last_frame_id(max_frame_id)
    except requests.exceptions.RequestException as e:
        print("Error sending data:", e)

if __name__ == "__main__":
    scheduler = BackgroundScheduler()
    # Schedule push_data to run every 5 minutes.
    scheduler.add_job(push_data, 'interval', minutes=1)
    scheduler.start()
    print("Sender script started. Uploading OCR data every 5 minutes...")
    try:
        # Keep the script running indefinitely.
        while True:
            time.sleep(1)
    except (KeyboardInterrupt, SystemExit):
        scheduler.shutdown()
        print("Sender script stopped.")
