# M3 Foto - QR Kod ile Fotoğraf Yükleme ve Slayt Gösterimi

Electron tabanlı bir uygulama. Müşteriler QR kod ile fotoğraf yükler, fotoğraflar Render sunucusunda saklanır ve Electron uygulamasında slayt olarak gösterilir.

## Özellikler

- 📱 QR kod ile mobil fotoğraf yükleme
- 🖼️ Otomatik fotoğraf slayt gösterimi
- ☁️ Render'da sunucu deployment desteği
- 🪣 AWS S3 entegrasyonu (isteğe bağlı)
- 🎨 Modern ve responsive arayüz

## Proje Yapısı

```
M3 Foto/
├── main.js              # Electron main process
├── preload.js           # Context bridge
├── renderer.js          # Renderer process logic
├── index.html           # Electron UI
├── styles.css           # Stil dosyası
├── server.js            # Express sunucusu
├── package.json         # Bağımlılıklar
├── public/
│   └── upload.html      # Mobil yükleme sayfası
├── uploads/             # Yerel fotoğraf depolama (local mode)
└── render.yaml          # Render deployment config
```

## Kurulum

### 1. Bağımlılıkları Yükle

```bash
npm install
```

### 2. Environment Variables

Render'da S3 kullanmak için aşağıdaki environment variable'ları ayarlayın:

- `USE_S3=true`
- `AWS_REGION=your-region`
- `AWS_ACCESS_KEY_ID=your-access-key`
- `AWS_SECRET_ACCESS_KEY=your-secret-key`
- `S3_BUCKET=your-bucket-name`

Eğer local storage kullanacaksanız `USE_S3=false` yapın (Render'da önerilmez, çünkü dosyalar kalıcı olmaz).

### 3. Electron Uygulamasını Başlat

#### Development Mode (Hem sunucu hem Electron)

```bash
npm run dev
```

#### Sadece Electron

```bash
npm start
```

#### Sadece Sunucu

```bash
npm run server
```

## Render'a Deployment

### 1. GitHub Repository'ye Push

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin <your-repo-url>
git push -u origin main
```

### 2. Render'da Web Service Oluştur

1. Render Dashboard'a gidin
2. "New +" > "Web Service" seçin
3. Repository'nizi bağlayın
4. Aşağıdaki ayarları yapın:
   - **Name**: `m3-foto-server`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Plan**: Free veya daha yüksek (S3 kullanıyorsanız)

### 3. Environment Variables Ekleyin

Render Dashboard'da Environment Variables sekmesine gidin ve ekleyin:

```
USE_S3=true
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
S3_BUCKET=your-bucket
PORT=10000
```

### 4. Electron Uygulamasını Yapılandır

Render deploy edildikten sonra, Render size bir URL verecek (örn: `https://m3-foto-server.onrender.com`).

Electron uygulamasını bu URL'e bağlamak için:

**Seçenek 1: Environment Variable**

```bash
# Windows (PowerShell)
$env:RENDER_URL="https://m3-foto-server.onrender.com"
npm start

# macOS/Linux
export RENDER_URL="https://m3-foto-server.onrender.com"
npm start
```

**Seçenek 2: Config Dosyası Oluştur**

`config.js` dosyası oluşturun:

```javascript
module.exports = {
  SERVER_URL: 'https://m3-foto-server.onrender.com'
};
```

Ve `main.js`'de import edin.

**Seçenek 3: HTML'de Script Tag**

`index.html`'e ekleyin:

```html
<script>
  window.SERVER_URL = 'https://m3-foto-server.onrender.com';
</script>
```

## Kullanım

1. Electron uygulamasını başlatın
2. Sağ tarafta QR kod görünecek
3. Müşteriler telefonlarıyla QR kodu okutup fotoğraf yükleyebilir
4. Sol tarafta fotoğraflar otomatik olarak slayt gösterisi halinde görünecek
5. Her 10 saniyede bir yeni fotoğraflar otomatik olarak kontrol edilir

## Klavye Kısayolları

- `←` (Sol ok): Önceki fotoğraf
- `→` (Sağ ok): Sonraki fotoğraf

## Teknik Detaylar

### Sunucu

- **Express.js**: Web sunucusu
- **Multer**: Dosya yükleme
- **AWS S3**: Bulut depolama (Render'da önerilir)
- **CORS**: Cross-origin istekleri için

### Electron

- **Main Process**: Sunucuyu başlatır ve pencereyi yönetir
- **Renderer Process**: UI ve fotoğraf gösterimi
- **QR Code**: QR kod oluşturma (QRCode.js)

### Güvenlik

- Dosya boyutu sınırı: 10MB
- İzin verilen dosya türleri: JPEG, PNG, WebP, GIF
- CORS aktif

## Sorun Giderme

### QR Kod Görünmüyor

- Sunucunun çalıştığından emin olun
- Browser console'da hata olup olmadığını kontrol edin

### Fotoğraflar Yüklenmiyor

- Sunucu URL'sinin doğru olduğundan emin olun
- CORS ayarlarını kontrol edin
- S3 credentials'ları kontrol edin (S3 kullanıyorsanız)

### Fotoğraflar Görünmüyor

- `/photos` endpoint'inin çalıştığını test edin
- Network sekmesinde isteklerin başarılı olduğunu kontrol edin

## Lisans

MIT
