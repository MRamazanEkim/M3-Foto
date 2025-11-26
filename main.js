// main.js - Electron Main Process
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const http = require('http');

let mainWindow;
let serverProcess;

// Config dosyasını yükle (varsa)
let serverConfig = null;
const configPath = path.join(__dirname, 'config.js');
if (fsSync.existsSync(configPath)) {
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

  mainWindow.webContents.setZoomFactor(0.75);

  // DevTools'u otomatik açma (ihtiyaç duyulursa F12 ile açılabilir)
  // mainWindow.webContents.openDevTools();
  
  // Console log'ları görmek için
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('Sayfa yüklenemedi:', errorCode, errorDescription);
  });

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
    console.log('Local server başlatılıyor...');
    startServer();
    
    // Sunucunun başlamasını kontrol et
    let serverReady = false;
    let windowCreated = false;
    const checkServer = setInterval(() => {
      const req = http.get('http://localhost:3000/health', (res) => {
        if (res.statusCode === 200) {
          console.log('Server hazır!');
          serverReady = true;
          clearInterval(checkServer);
          if (!windowCreated) {
            windowCreated = true;
            createWindow();
          }
        }
      });
      
      req.on('error', () => {
        // Server henüz hazır değil, devam et
      });
      
      req.setTimeout(500);
      req.on('timeout', () => {
        req.destroy();
      });
    }, 500);
    
    // Maksimum 10 saniye bekle
    setTimeout(() => {
      clearInterval(checkServer);
      if (!windowCreated) {
        console.warn('Server kontrolü tamamlandı, pencereyi açıyoruz...');
        windowCreated = true;
        createWindow();
      }
    }, 10000);
    
    // Fallback: 3 saniye sonra pencereyi aç
    setTimeout(() => {
      if (!windowCreated) {
        windowCreated = true;
        createWindow();
      }
    }, 3000);
  } else {
    // Remote server kullanılıyorsa hemen pencereyi oluştur
    console.log('Remote server kullanılıyor:', hasRemoteServer);
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
app.on('before-quit', async (event) => {
  if (serverProcess) {
    serverProcess.kill();
  }
  
  // Renderer process'e cache temizleme sinyali gönder
  const allWindows = BrowserWindow.getAllWindows();
  for (const win of allWindows) {
    if (win && !win.isDestroyed()) {
      try {
        // Renderer process'e cache temizleme mesajı gönder
        win.webContents.executeJavaScript(`
          if (typeof clearAllCachedPhotos === 'function') {
            clearAllCachedPhotos().catch(err => console.error('Cache temizleme hatası:', err));
          }
        `).catch(err => {
          console.error('Renderer\'a cache temizleme mesajı gönderilemedi:', err);
        });
      } catch (error) {
        console.error('Cache temizleme hatası:', error);
      }
    }
  }
  
  // Kısa bir süre bekle (cache temizleme işleminin tamamlanması için)
  await new Promise(resolve => setTimeout(resolve, 500));
});

// IPC: Sunucu URL'ini al
ipcMain.handle('get-server-url', async () => {
  // Öncelik sırası: config.js > environment variable > m3fotodepo.com > localhost
  if (serverConfig && serverConfig.SERVER_URL) {
    console.log('Server URL (config.js):', serverConfig.SERVER_URL);
    return serverConfig.SERVER_URL;
  }
  
  // Render'da deploy edilmişse RENDER_URL kullan
  const renderUrl = process.env.RENDER_URL || process.env.SERVER_URL;
  if (renderUrl) {
    console.log('Server URL (env):', renderUrl);
    return renderUrl;
  }
  
  // Default: m3fotodepo.com (Render'da deploy edilmiş sunucu)
  const defaultUrl = 'https://m3fotodepo.com';
  console.log('Server URL (default):', defaultUrl);
  return defaultUrl;
  
  // Eğer localhost kullanmak isterseniz yukarıdaki yerine bunu kullanın:
  // const port = process.env.PORT || 3000;
  // const localUrl = `http://localhost:${port}`;
  // console.log('Server URL (localhost):', localUrl);
  // return localUrl;
});

// IPC: Klasör seçme dialog'u
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Fotoğrafları kaydetmek için klasör seçin'
  });
  
  if (result.canceled) {
    return null;
  }
  
  return result.filePaths[0];
});

// IPC: Fotoğraf dosyasını diske yaz
ipcMain.handle('write-photo-file', async (event, filePath, buffer) => {
  try {
    // Buffer'ı Uint8Array'e dönüştür (electron IPC'den gelen buffer'ları handle etmek için)
    let data;
    if (Buffer.isBuffer(buffer)) {
      data = buffer;
    } else if (buffer instanceof ArrayBuffer) {
      data = Buffer.from(buffer);
    } else if (Array.isArray(buffer)) {
      data = Buffer.from(buffer);
    } else {
      data = Buffer.from(buffer);
    }
    
    await fs.writeFile(filePath, data);
    return { success: true };
  } catch (error) {
    console.error('Dosya yazma hatası:', error);
    return { success: false, error: error.message };
  }
});
