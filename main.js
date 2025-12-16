// main.js - Electron Main Process
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const http = require('http');
const https = require('https');

let mainWindow;
let serverProcess;
let passwordWindow;
let appStarted = false; // Ana uygulamanın birden fazla kez başlatılmasını engelle

// ================================
// ŞİFRE KONTROL MEKANİZMASI
// ================================

const PASSWORD_URL = 'https://www.m3.com.tr/gamepass.txt';

// AppData/Roaming/<AppName>/saved_password.dat yolu
function getPasswordFilePath() {
  const userDataPath = app.getPath('userData'); // Windows: C:\Users\<user>\AppData\Roaming\<AppName>
  return path.join(userDataPath, 'saved_password.dat');
}

// Uzaktaki şifreyi indir
function fetchRemotePassword() {
  return new Promise((resolve, reject) => {
    https
      .get(PASSWORD_URL, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          resolve(data.trim()); // Örn: "m32005"
        });
      })
      .on('error', (err) => {
        reject(err);
      });
  });
}

// Kayıtlı şifreyi oku (varsa)
function readSavedPassword() {
  const filePath = getPasswordFilePath();
  if (fsSync.existsSync(filePath)) {
    return fsSync.readFileSync(filePath, 'utf8').trim();
  }
  return null;
}

// Uygulama ikonu
const APP_ICON = path.join(__dirname, 'app_icon.ico');

// Kayıtlı şifreyi kaydet
function savePassword(password) {
  const filePath = getPasswordFilePath();
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  fsSync.writeFileSync(filePath, password, 'utf8');
}
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
    icon: APP_ICON,
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

// Şifre soran pencere
function createPasswordWindow() {
  passwordWindow = new BrowserWindow({
    width: 800,
    height: 600,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Şifre Girişi',
    icon: APP_ICON,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  passwordWindow.loadFile('password.html');

  passwordWindow.on('closed', () => {
    passwordWindow = null;
  });
}

// Ana uygulama başlatma (server + ana pencere)
function startMainApp() {
  if (appStarted) {
    return;
  }
  appStarted = true;

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
      // macOS'ta dock'tan tekrar açıldığında ana uygulamayı başlat
      if (appStarted) {
      createWindow();
      } else {
        startAppWithPasswordCheck();
      }
    }
  });
}

// Uygulama başlarken önce şifre durumunu kontrol et
async function startAppWithPasswordCheck() {
  try {
    const saved = readSavedPassword();
    const remote = await fetchRemotePassword();

    // Daha önce kaydedilmiş şifre var ve uzaktaki ile aynıysa direkt aç
    if (saved && saved === remote) {
      startMainApp();
    } else {
      createPasswordWindow();
    }
  } catch (err) {
    // İnternete ulaşılamazsa veya hata olursa güvenlik için şifre sor
    console.error('Şifre kontrolü sırasında hata:', err);
    createPasswordWindow();
  }
}

// Uygulama hazır olduğunda
app.whenReady().then(startAppWithPasswordCheck);

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

// Renderer'dan gelen şifreyi kontrol et
ipcMain.on('check-password', async (event, enteredPassword) => {
  try {
    const remote = await fetchRemotePassword();

    if (enteredPassword && enteredPassword.trim() === remote) {
      // Doğru şifre
      savePassword(enteredPassword.trim());

      if (passwordWindow) {
        passwordWindow.close();
      }

      startMainApp();

      event.reply('check-password-result', { success: true });
    } else {
      // Yanlış şifre
      event.reply('check-password-result', { success: false, message: 'Hatalı şifre' });
    }
  } catch (err) {
    console.error('Şifre doğrulama hatası:', err);
    event.reply('check-password-result', { success: false, message: 'Bağlantı hatası' });
  }
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
