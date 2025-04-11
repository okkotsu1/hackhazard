const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn, exec } = require('child_process');
const os = require('os');

let serverProcess;
let scanningProcess; // to hold reference to the Python scanning process
let scanningPID; // to store the PID of the Python process

function startServer() {
  // Spawns your Express server
  serverProcess = spawn('node', ['server.js'], {
    cwd: __dirname,
    shell: true,
    stdio: 'inherit'
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  // Load the landing page or directly the sender page if you prefer.
  win.loadURL('http://localhost:3000/index.html'); // your main selection page that leads to sender/receiver
}

app.whenReady().then(() => {
  // Start backend server first.
  startServer();
  createWindow();
  
  // Set up IPC handlers for scanning actions:
  ipcMain.handle('startScanning', (event, subtaskId) => {
    if (scanningProcess) {
      console.log("Scanning already in progress.");
      return "Scanning already in progress.";
    }
    // Spawn the Python script with an argument for the subtaskID.
    scanningProcess = spawn('python', ['push_ocr_data.py', '--subtaskID', subtaskId], {
      cwd: __dirname,
      shell: true,
      stdio: 'inherit'
    });
    
    scanningPID = scanningProcess.pid;
    console.log("Started scanning for subtask:", subtaskId, "with PID:", scanningPID);
    
    // Handle process exit
    scanningProcess.on('exit', (code) => {
      console.log(`Scanning process exited with code ${code}`);
      scanningProcess = null;
      scanningPID = null;
    });
    
    return "Started scanning";
  });
  
  ipcMain.handle('stopScanning', () => {
    if (scanningProcess && scanningPID) {
      // Use a platform-specific approach to kill the process tree
      if (process.platform === 'win32') {
        // On Windows, use taskkill to kill the process tree
        exec(`taskkill /F /T /PID ${scanningPID}`, (error) => {
          if (error) {
            console.error(`Failed to kill process tree: ${error}`);
          } else {
            console.log("Successfully terminated scanning process tree");
          }
        });
      } else {
        // On Unix-like systems, we would use a different approach
        // For example: exec(`pkill -P ${scanningPID}`);
        scanningProcess.kill('SIGINT'); // Try to send SIGINT (equivalent to Ctrl+C)
      }
      
      scanningProcess = null;
      console.log("Stopped scanning.");
      return "Stopped scanning";
    }
    return "No scanning process running.";
  });
  
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (serverProcess) serverProcess.kill();
    
    // Ensure we properly clean up the scanning process
    if (scanningProcess && scanningPID) {
      if (process.platform === 'win32') {
        exec(`taskkill /F /T /PID ${scanningPID}`);
      } else {
        scanningProcess.kill('SIGINT');
      }
    }
    
    app.quit();
  }
});
