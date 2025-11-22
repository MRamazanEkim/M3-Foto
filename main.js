// main.js - Electron Main Process
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let mainWindow;
let serverProcess;

// Config dosyasını yükle (varsa)
let serverConfig = null;
const configPath = path.join(__dirname, 'config.js');
if (fs.existsSync(configPath)) {
  try {
    serverConfig = require(configPath);
  } catch (err) {
    console.error('Config dosyası yüklenemedi:', err);
  }
}

// Express sunucusunu başlat
function startServer() {
  const serverPath = path.join(__dirname, 'server.js');
  serverProcess = spawn('node', [serverPath], {
    cwd: __dirname,
    env: { ...process.env, PORT: process.env.PORT || 3000 }
  });

  serverProcess.stdout.on('data', (data) => {
    console.log(`Server: ${data}`);
  });

  serverProcess.stderr.on('data', (data) => {
    console.error(`Server Error: ${data}`);
  });

  serverProcess.on('close', (code) => {
    console.log(`Server process exited with code ${code}`);
  });
}

// Ana pencereyi oluştur
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    fullscreen: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    autoHideMenuBar: true,
    frame: true
  });

  mainWindow.loadFile('index.html');

  // Geliştirme için DevTools (production'da kaldırılabilir)
  // mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Uygulama hazır olduğunda
app.whenReady().then(() => {
  // Eğer remote server URL'i varsa local server başlatma
  const hasRemoteServer = (serverConfig && serverConfig.SERVER_URL) || 
                          process.env.RENDER_URL || 
                          process.env.SERVER_URL;
  
  if (!hasRemoteServer) {
    startServer();
    // Sunucunun başlaması için kısa bir gecikme
    setTimeout(() => {
      createWindow();
    }, 2000);
  } else {
    // Remote server kullanılıyorsa hemen pencereyi oluştur
    createWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Tüm pencereler kapatıldığında
app.on('window-all-closed', () => {
  if (serverProcess) {
    serverProcess.kill();
  }
  
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Uygulama kapatılırken
app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill();
  }
});

// IPC: Sunucu URL'ini al
ipcMain.handle('get-server-url', async () => {
  // Öncelik sırası: config.js > environment variable > localhost
  if (serverConfig && serverConfig.SERVER_URL) {
    return serverConfig.SERVER_URL;
  }
  
  // Render'da deploy edilmişse RENDER_URL kullan, yoksa localhost
  const renderUrl = process.env.RENDER_URL || process.env.SERVER_URL;
  if (renderUrl) {
    return renderUrl;
  }
  
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}`;
});
