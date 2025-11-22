// renderer.js - Electron Renderer Process
let photos = [];
let currentIndex = 0;
let slideInterval;
let serverUrl = '';
const SLIDE_INTERVAL_MS = 5000; // 5 saniye

// Sunucu URL'ini al
async function initialize() {
  try {
    if (window.electronAPI) {
      serverUrl = await window.electronAPI.getServerUrl();
    } else {
      // Fallback: localStorage'dan, env'den veya config'den
      // Önce localStorage kontrol et, yoksa config dosyası, yoksa localhost
      serverUrl = localStorage.getItem('serverUrl') || 
                  (window.SERVER_URL || 'http://localhost:3000');
    }
    
    // Eğer Render'da deploy edilmişse, Render URL'sini kullan
    // Bu URL bir config dosyasından veya environment variable'dan gelecek
    console.log('Server URL:', serverUrl);
    generateQRCode();
    loadPhotos();
    
    // Her 10 saniyede bir fotoğrafları yeniden yükle
    setInterval(loadPhotos, 10000);
  } catch (error) {
    console.error('Initialization error:', error);
  }
}

// QR Kod oluştur
function generateQRCode() {
  const qrContainer = document.getElementById('qr-code');
  const uploadUrl = `${serverUrl}/`;
  
  // QRCode.js kullanarak QR kod oluştur
  QRCode.toCanvas(qrContainer, uploadUrl, {
    width: 250,
    margin: 2,
    color: {
      dark: '#000000',
      light: '#FFFFFF'
    }
  }, function (error) {
    if (error) {
      console.error('QR Code generation error:', error);
      qrContainer.innerHTML = '<p style="color: red;">QR Kod oluşturulamadı</p>';
    }
  });
}

// Fotoğrafları sunucudan yükle
async function loadPhotos() {
  try {
    const response = await fetch(`${serverUrl}/photos`);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (Array.isArray(data) && data.length > 0) {
      // URL'leri düzelt (eğer relative ise absolute yap)
      photos = data.map(photo => {
        if (photo.url && photo.url.startsWith('http')) {
          return photo.url;
        } else if (photo.url && photo.url.startsWith('/')) {
          return `${serverUrl}${photo.url}`;
        } else if (photo.file) {
          return `${serverUrl}/uploads/${photo.file}`;
        }
        return null;
      }).filter(url => url !== null);
      
      // Son yüklenen fotoğraflar önce gösterilsin (tarihe göre sıralama)
      // Eğer lastModified varsa ona göre sırala
      if (data[0] && data[0].lastModified) {
        photos = data
          .sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified))
          .map(photo => {
            if (photo.url && photo.url.startsWith('http')) {
              return photo.url;
            } else if (photo.url && photo.url.startsWith('/')) {
              return `${serverUrl}${photo.url}`;
            }
            return null;
          })
          .filter(url => url !== null);
      }
      
      // Fotoğraf sayısını güncelle
      document.getElementById('photo-count').textContent = photos.length;
      
      // Loading'i gizle, slideshow'u göster
      document.getElementById('loading').style.display = 'none';
      document.getElementById('no-photos').style.display = 'none';
      document.getElementById('slideshow').style.display = 'block';
      
      // Eğer yeni fotoğraflar varsa slideshow'u başlat/yeniden başlat
      if (photos.length > 0) {
        startSlideshow();
      }
    } else {
      // Fotoğraf yoksa
      document.getElementById('loading').style.display = 'none';
      document.getElementById('slideshow').style.display = 'none';
      document.getElementById('no-photos').style.display = 'block';
      document.getElementById('photo-count').textContent = '0';
      stopSlideshow();
    }
  } catch (error) {
    console.error('Error loading photos:', error);
    document.getElementById('loading').innerHTML = '<p style="color: red;">Sunucuya bağlanılamadı</p>';
  }
}

// Slideshow'u başlat
function startSlideshow() {
  if (photos.length === 0) return;
  
  // Eğer slideshow zaten çalışıyorsa durdur
  if (slideInterval) {
    clearInterval(slideInterval);
  }
  
  // İlk fotoğrafı göster
  showPhoto(0);
  
  // Otomatik geçişi başlat
  slideInterval = setInterval(() => {
    currentIndex = (currentIndex + 1) % photos.length;
    showPhoto(currentIndex);
  }, SLIDE_INTERVAL_MS);
}

// Slideshow'u durdur
function stopSlideshow() {
  if (slideInterval) {
    clearInterval(slideInterval);
    slideInterval = null;
  }
}

// Fotoğraf göster
function showPhoto(index) {
  if (index < 0 || index >= photos.length) return;
  
  const slideImage = document.getElementById('slide-image');
  const img = new Image();
  
  img.onload = function() {
    slideImage.src = photos[index];
    slideImage.style.opacity = '0';
    setTimeout(() => {
      slideImage.style.opacity = '1';
    }, 50);
  };
  
  img.onerror = function() {
    console.error('Error loading image:', photos[index]);
    // Hatalı fotoğrafı atla
    currentIndex = (currentIndex + 1) % photos.length;
    if (currentIndex !== index) {
      showPhoto(currentIndex);
    }
  };
  
  img.src = photos[index];
  currentIndex = index;
}

// Uygulama başlatıldığında
document.addEventListener('DOMContentLoaded', initialize);

// Klavye kısayolları (isteğe bağlı)
document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') {
    if (photos.length > 0) {
      currentIndex = (currentIndex - 1 + photos.length) % photos.length;
      showPhoto(currentIndex);
      // Interval'i sıfırla
      if (slideInterval) {
        clearInterval(slideInterval);
        startSlideshow();
      }
    }
  } else if (e.key === 'ArrowRight') {
    if (photos.length > 0) {
      currentIndex = (currentIndex + 1) % photos.length;
      showPhoto(currentIndex);
      // Interval'i sıfırla
      if (slideInterval) {
        clearInterval(slideInterval);
        startSlideshow();
      }
    }
  }
});
