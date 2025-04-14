// main.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn, exec } = require('child_process');

let serverProcess;
let scanningProcess;
let scanningPID;

function startServer() {
    serverProcess = spawn('node', ['server.js'], {
        cwd: __dirname,
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
    win.loadURL('http://localhost:3000/index.html');
}

app.whenReady().then(() => {
    startServer();
    createWindow();

    ipcMain.handle('startScanning', (event, taskId, subtaskId, criteria) => {
        if (scanningProcess) {
            console.log("Scanning already in progress.");
            return { success: false, message: "Scanning already in progress." };
        }

        try {
            // Decode criteria in case it was URL-encoded
            const decodedCriteria = decodeURIComponent(criteria);
            
            // Validate inputs
            if (!taskId || !subtaskId || !decodedCriteria) {
                console.error("Invalid scanning parameters:", { taskId, subtaskId, criteria });
                return { success: false, message: "Invalid parameters for scanning" };
            }
            
            scanningProcess = spawn('python', [
                'push_ocr_data.py',
                '--taskID', taskId.toString(),
                '--subtaskID', subtaskId.toString(),
                '--criteria', decodedCriteria
            ], {
                cwd: __dirname,
                stdio: 'inherit'
            });
            
            scanningPID = scanningProcess.pid;
            console.log(`Started scanning for Task ${taskId}, Subtask ${subtaskId} (PID ${scanningPID})`);

            scanningProcess.on('error', (err) => {
                console.error(`Failed to start scanning process: ${err}`);
                scanningProcess = null;
                scanningPID = null;
            });

            scanningProcess.on('exit', (code) => {
                console.log(`Scanning process exited with code ${code}`);
                scanningProcess = null;
                scanningPID = null;
            });
            
            return { success: true, message: "Started scanning" };
        } catch (error) {
            console.error("Error starting scanning:", error);
            return { success: false, message: `Error: ${error.message}` };
        }
    });

    ipcMain.handle('stopScanning', () => {
        if (scanningProcess && scanningPID) {
            if (process.platform === 'win32') {
                exec(`taskkill /F /T /PID ${scanningPID}`, (error) => {
                    if (error) console.error(`Failed to kill process tree: ${error}`);
                    else console.log("Successfully terminated scanning process tree");
                });
            } else {
                scanningProcess.kill('SIGINT');
            }
            
            scanningProcess = null;
            scanningPID = null;
            console.log("Stopped scanning.");
            return { success: true, message: "Stopped scanning" };
        }
        
        return { success: false, message: "No scanning process running." };
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        if (serverProcess) serverProcess.kill();
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
