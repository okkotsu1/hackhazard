// main.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let serverProcess;
let scanningProcess; // to hold reference to the Python scanning process

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
    scanningProcess = spawn('python', ['push_data.py', '--subtaskID', subtaskId], {
      cwd: __dirname,
      shell: true,
      stdio: 'inherit'
    });
    console.log("Started scanning for subtask:", subtaskId);
    return "Started scanning";
  });
  
  ipcMain.handle('stopScanning', () => {
    if (scanningProcess) {
      scanningProcess.kill();
      console.log("Stopped scanning.");
      scanningProcess = null;
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
    if (scanningProcess) scanningProcess.kill();
    app.quit();
  }
});
