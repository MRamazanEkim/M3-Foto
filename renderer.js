// renderer.js - Electron Renderer Process
let photos = [];
let currentPageIndex = 0; // Hangi 15'lik grubu gösteriyoruz
let slideInterval;
let serverUrl = '';
const PHOTOS_PER_PAGE = 15; // Her sayfada 15 fotoğraf
const MAX_PHOTOS = 300; // En fazla 300 foto (20 slayt)

// Ayarlar
let settings = {
  bgImage: null,
  bgColor: '#000000',
  qrCodeImage: null, // Özel QR kod görüntüsü (base64 veya data URL)
  slideInterval: 10, // Slayt geçiş süresi (saniye cinsinden, default: 10 sn)
  qrTextTop: '', // QR kod üst yazısı
  qrTextBottom: '' // QR kod alt yazısı
};

// Slayt geçiş süresini al (saniyeden milisaniyeye çevir)
function getSlideInterval() {
  // Önce settings'ten al, yoksa default 10
  let seconds = settings.slideInterval;
  
  // Eğer undefined, null, veya geçersiz bir değerse default kullan
  if (seconds === undefined || seconds === null || isNaN(seconds)) {
    seconds = 10;
    settings.slideInterval = 10; // Default değeri ayarla
  }
  
  // Min 10, max 35 saniye kontrolü - değer aralık dışındaysa düzelt
  if (seconds < 10 || seconds > 35) {
    seconds = Math.max(10, Math.min(35, seconds));
    settings.slideInterval = seconds; // Düzeltilmiş değeri ayarla
    // localStorage'ı da güncelle
    try {
      localStorage.setItem('m3foto_settings', JSON.stringify(settings));
    } catch (e) {
      console.error('localStorage güncelleme hatası:', e);
    }
  }
  
  const ms = seconds * 1000;
  console.log(`[getSlideInterval] settings.slideInterval=${settings.slideInterval}, clamped=${seconds}, returning ${ms}ms`);
  return ms; // Milisaniyeye çevir
}

// Blob URL'leri temizle (memory leak önleme)
function revokeBlobURLs() {
  photos.forEach(url => {
    if (url && url.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {
        // Zaten iptal edilmiş olabilir
      }
    }
  });
}

// Sunucu URL'ini al
async function initialize() {
  try {
    if (window.electronAPI) {
      // Electron üzerinden ayarlanmış URL
      serverUrl = await window.electronAPI.getServerUrl();
    } else {
      // Fallback: localStorage veya sabit config
      serverUrl = localStorage.getItem('serverUrl') || 
                  (window.SERVER_URL || 'https://m3fotodepo.com');
    }

    console.log('🚀 Uygulama başlatılıyor...');
    console.log('📡 Server URL:', serverUrl);

    // QR kod veya sabit PNG QR ekle
    generateQRCode();
    
    // QR kod yazılarını güncelle
    updateQRTexts();

    // Önce cache'den hızlı başlangıç (eğer varsa)
    const cacheLoaded = await loadFromCache();
    if (cacheLoaded && photos.length > 0) {
      console.log('⚡ Cache\'den hızlı başlangıç yapıldı');
      // Slideshow zaten başlatıldı (loadFromCache içinde)
    }

    // Fotoğrafları sunucudan yükle (cache'yi güncelleyecek)
    await loadPhotos();

    // Her 10 saniyede bir foto güncelle (cache kontrolü ile)
    setInterval(loadPhotos, 10000);
    
    // Uygulama kapanırken blob URL'leri ve cache'i temizle
    let isCleaningUp = false;
    
    const cleanupCache = async () => {
      if (isCleaningUp) return; // Tekrar çağrılmasını önle
      isCleaningUp = true;
      
      console.log('🚪 Uygulama kapatılıyor, cache temizleniyor...');
      
      try {
        // Blob URL'leri temizle
        revokeBlobURLs();
        
        // Cache'i temizle
        await clearAllCachedPhotos();
      } catch (error) {
        console.error('Cache temizleme hatası:', error);
      }
    };
    
    // beforeunload event'i (uygulama kapatılırken)
    window.addEventListener('beforeunload', () => {
      // Async işlemleri navigator.sendBeacon veya sync olarak çalıştır
      cleanupCache();
    });
    
    // pagehide event'i (sayfa gizlendiğinde - daha güvenilir)
    window.addEventListener('pagehide', (event) => {
      // persisted false ise sayfa tamamen kapanıyor
      if (!event.persisted) {
        cleanupCache();
      }
    });
    
    // visibilitychange event'i (ek olarak)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        // Sayfa gizlendi, cleanup yapabiliriz
        cleanupCache();
      }
    });
  } catch (error) {
    console.error('❌ Initialization error:', error);
    // Hata durumunda cache'den yüklemeyi dene
    await loadFromCache();
  }
}


// ============================================
// INDEXEDDB CACHE MECHANISM
// ============================================
const DB_NAME = 'm3foto-db';
const DB_VERSION = 1;
const STORE_PHOTOS = 'photos';
const STORE_METADATA = 'metadata';

// IndexedDB'yi aç
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => {
      console.error('IndexedDB açılamadı:', request.error);
      reject(request.error);
    };
    
    request.onsuccess = () => {
      resolve(request.result);
    };
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      
      // Fotoğraf verileri için store
      if (!db.objectStoreNames.contains(STORE_PHOTOS)) {
        const photoStore = db.createObjectStore(STORE_PHOTOS, { keyPath: 'id' });
        photoStore.createIndex('url', 'url', { unique: true });
        photoStore.createIndex('lastModified', 'lastModified', { unique: false });
        console.log('IndexedDB: photos store oluşturuldu');
      }
      
      // Metadata için store (son update zamanı vb.)
      if (!db.objectStoreNames.contains(STORE_METADATA)) {
        db.createObjectStore(STORE_METADATA, { keyPath: 'key' });
        console.log('IndexedDB: metadata store oluşturuldu');
      }
    };
  });
}

// Fotoğrafı IndexedDB'de kontrol et
async function getCachedPhoto(photoUrl) {
  try {
    const db = await openDB();
    const transaction = db.transaction([STORE_PHOTOS], 'readonly');
    const store = transaction.objectStore(STORE_PHOTOS);
    const index = store.index('url');
    
    return new Promise((resolve, reject) => {
      const request = index.get(photoUrl);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => {
        console.error('Cache okuma hatası:', request.error);
        resolve(null);
      };
    });
  } catch (error) {
    console.error('getCachedPhoto hatası:', error);
    return null;
  }
}

// Cache'den fotoğraf blob'unu al (blob URL döndürür)
async function getCachedPhotoBlob(photoUrl) {
  try {
    const cached = await getCachedPhoto(photoUrl);
    if (cached && cached.blob) {
      // Blob URL oluştur
      return URL.createObjectURL(cached.blob);
    }
    return null;
  } catch (error) {
    console.error('getCachedPhotoBlob hatası:', error);
    return null;
  }
}

// IndexedDB'deki eski fotoğrafları sil (FIFO - First In First Out)
async function deleteOldestCachedPhotos(keepCount = MAX_PHOTOS) {
  try {
    const db = await openDB();
    const transaction = db.transaction([STORE_PHOTOS], 'readwrite');
    const store = transaction.objectStore(STORE_PHOTOS);
    
    // Tüm fotoğrafları al
    const request = store.getAll();
    const allPhotos = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    
    if (allPhotos.length <= keepCount) {
      return; // Limit aşılmamış, silme gerek yok
    }
    
    // cachedAt tarihine göre sırala (en eski önce - FIFO)
    allPhotos.sort((a, b) => {
      const dateA = new Date(a.cachedAt || a.lastModified || 0);
      const dateB = new Date(b.cachedAt || b.lastModified || 0);
      return dateA - dateB; // En eski önce
    });
    
    // En eski fotoğrafları sil (limit aşanlar)
    const photosToDelete = allPhotos.slice(0, allPhotos.length - keepCount);
    
    for (const photo of photosToDelete) {
      // Blob URL'i varsa temizle
      if (photo.blob) {
        // photos array'inde bu fotoğrafın blob URL'i varsa bul ve temizle
        const blobUrl = photos.find(url => {
          if (url.startsWith('blob:')) {
            try {
              // Blob URL'den blob'u al ve karşılaştır
              // Not: Bu çok pahalı olabilir, daha iyi bir yöntem kullanılmalı
              return false; // Şimdilik sadece photos array'inden kaldır
            } catch (e) {
              return false;
            }
          }
          return false;
        });
      }
      
      // IndexedDB'den sil
      await new Promise((resolve, reject) => {
        const deleteRequest = store.delete(photo.id);
        deleteRequest.onsuccess = () => resolve();
        deleteRequest.onerror = () => reject(deleteRequest.error);
      });
    }
    
    if (photosToDelete.length > 0) {
      console.log(`🗑️ ${photosToDelete.length} eski fotoğraf silindi (FIFO - limit: ${MAX_PHOTOS})`);
    }
  } catch (error) {
    console.error('❌ Eski fotoğrafları silme hatası:', error);
  }
}

// Fotoğrafı IndexedDB'ye kaydet (DUPLICATE ve VERSIYON KONTROLÜ İLE)
async function cachePhoto(photoData) {
  try {
    // Önce kontrol et - zaten var mı?
    const existing = await getCachedPhoto(photoData.url);
    
    if (existing) {
      // Versiyon kontrolü - lastModified değişmiş mi?
      const existingLastModified = existing.lastModified || '';
      const newLastModified = photoData.lastModified || '';
      
      if (existingLastModified === newLastModified && existing.blob) {
        console.log('✓ Fotoğraf zaten cache\'de ve güncel, tekrar indirilmedi:', photoData.url);
        return existing; // Tekrar indirme, mevcut olanı döndür
      } else {
        console.log('⚠ Fotoğraf güncellenmiş, yeniden indiriliyor:', photoData.url);
        console.log('  Eski:', existingLastModified, '-> Yeni:', newLastModified);
        // Güncelleme varsa üzerine yaz
      }
    } else {
      console.log('📥 Yeni fotoğraf indiriliyor:', photoData.url);
    }
    
    // Fotoğrafı indir (Blob olarak)
    const response = await fetch(photoData.url);
    if (!response.ok) {
      throw new Error(`Fotoğraf indirilemedi: ${response.status} ${response.statusText}`);
    }
    
    const blob = await response.blob();
    
    // IndexedDB'ye kaydet
    const db = await openDB();
    const transaction = db.transaction([STORE_PHOTOS], 'readwrite');
    const store = transaction.objectStore(STORE_PHOTOS);
    
    // Unique ID oluştur (URL'den)
    const photoId = photoData.url.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 200);
    
    const photoRecord = {
      id: photoId,
      url: photoData.url,
      blob: blob,
      lastModified: photoData.lastModified || new Date().toISOString(),
      cachedAt: new Date().toISOString()
    };
    
    await new Promise((resolve, reject) => {
      const request = store.put(photoRecord);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    
    // 300 limit kontrolü - en eski fotoğrafları sil (FIFO)
    await deleteOldestCachedPhotos(MAX_PHOTOS);
    
    console.log('✓ Fotoğraf cache\'lendi:', photoData.url, `(${Math.round(blob.size / 1024)}KB)`);
    return photoRecord;
  } catch (error) {
    console.error('❌ Cache kaydetme hatası:', error, 'URL:', photoData.url);
    return null;
  }
}

// Offline durumunda cache'den yükle
async function loadFromCache() {
  try {
    console.log('🔄 Offline mod: Cache\'den fotoğraflar yükleniyor...');
    const db = await openDB();
    const transaction = db.transaction([STORE_PHOTOS], 'readonly');
    const store = transaction.objectStore(STORE_PHOTOS);
    
    const request = store.getAll();
    const cachedPhotos = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    
    if (cachedPhotos && cachedPhotos.length > 0) {
      // Son değiştirilme tarihine göre sırala (en yeni önce)
      cachedPhotos.sort((a, b) => {
        const dateA = new Date(a.lastModified || a.cachedAt || 0);
        const dateB = new Date(b.lastModified || b.cachedAt || 0);
        return dateB - dateA;
      });
      
      // 300 limit: En fazla 300 foto göster
      const limitedCachedPhotos = cachedPhotos.slice(0, MAX_PHOTOS);
      if (cachedPhotos.length > MAX_PHOTOS) {
        console.log(`⚠ Cache'de ${cachedPhotos.length} fotoğraf var, ilk ${MAX_PHOTOS} fotoğraf gösterilecek`);
      }
      
      // Blob URL'lere dönüştür
      photos = limitedCachedPhotos.map(photo => {
        if (photo.blob) {
          return URL.createObjectURL(photo.blob);
        }
        return photo.url; // Fallback
      }).filter(url => url !== null);
      
      console.log('✓ Offline mod: Cache\'den', photos.length, 'fotoğraf yüklendi');
      
      // UI güncelle
      const photoCountEl = document.getElementById('photo-count');
      if (photoCountEl) {
        photoCountEl.textContent = photos.length;
      }
      
      const loadingEl = document.getElementById('loading');
      if (loadingEl) {
        loadingEl.style.display = 'none';
      }
      
      const noPhotosEl = document.getElementById('no-photos');
      if (noPhotosEl) {
        noPhotosEl.style.display = 'none';
      }
      
      const slideshowEl = document.getElementById('slideshow');
      if (slideshowEl) {
        slideshowEl.style.display = 'block';
      }
      
      // Slideshow'u başlat
      if (photos.length > 0) {
        currentPageIndex = 0;
        startSlideshow();
      }
      
      return true;
    } else {
      console.log('⚠ Cache\'de fotoğraf yok');
      return false;
    }
  } catch (error) {
    console.error('❌ Cache\'den yükleme hatası:', error);
    return false;
  }
}

// Cache metadata'yı güncelle
async function updateCacheMetadata(key, value) {
  try {
    const db = await openDB();
    const transaction = db.transaction([STORE_METADATA], 'readwrite');
    const store = transaction.objectStore(STORE_METADATA);
    
    await new Promise((resolve, reject) => {
      const request = store.put({ key: key, value: value });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('Metadata güncelleme hatası:', error);
  }
}

// Cache metadata'yı oku
async function getCacheMetadata(key) {
  try {
    const db = await openDB();
    const transaction = db.transaction([STORE_METADATA], 'readonly');
    const store = transaction.objectStore(STORE_METADATA);
    
    return new Promise((resolve) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const result = request.result;
        resolve(result ? result.value : null);
      };
      request.onerror = () => resolve(null);
    });
  } catch (error) {
    console.error('Metadata okuma hatası:', error);
    return null;
  }
}

// Tüm cache'lenmiş fotoğrafları sil (uygulama kapanırken)
async function clearAllCachedPhotos() {
  try {
    console.log('🗑️ Tüm cache\'lenmiş fotoğraflar siliniyor...');
    
    const db = await openDB();
    const transaction = db.transaction([STORE_PHOTOS], 'readwrite');
    const store = transaction.objectStore(STORE_PHOTOS);
    
    // Tüm fotoğrafları sil
    const request = store.clear();
    
    await new Promise((resolve, reject) => {
      request.onsuccess = () => {
        console.log('✓ Tüm cache\'lenmiş fotoğraflar silindi');
        resolve();
      };
      request.onerror = () => {
        console.error('❌ Cache temizleme hatası:', request.error);
        reject(request.error);
      };
    });
    
    // Metadata'yı da temizle
    const metadataTransaction = db.transaction([STORE_METADATA], 'readwrite');
    const metadataStore = metadataTransaction.objectStore(STORE_METADATA);
    await new Promise((resolve, reject) => {
      const metadataRequest = metadataStore.clear();
      metadataRequest.onsuccess = () => resolve();
      metadataRequest.onerror = () => reject(metadataRequest.error);
    });
    
    // Blob URL'leri de temizle
    revokeBlobURLs();
    
    console.log('✓ IndexedDB tamamen temizlendi');
    return true;
  } catch (error) {
    console.error('❌ Cache temizleme hatası:', error);
    return false;
  }
}

// ============================================
// QR Kod görüntüsünü yükle (frame.png veya özel görüntü)
// ============================================
function generateQRCode() {
  const qrContainer = document.getElementById('qr-code');
  if (!qrContainer) {
    console.error('QR kod container bulunamadı!');
    return;
  }
  
  const img = document.createElement('img');
  img.alt = 'QR Code';
  img.style.width = '100%';
  img.style.height = 'auto';
  img.style.display = 'block';
  img.style.maxWidth = '100%';
  
  // Önce ayarlardan özel QR kod görüntüsünü kontrol et
  if (settings.qrCodeImage) {
    // Özel QR kod görüntüsü kullan
    img.src = settings.qrCodeImage;
    console.log('Özel QR kod görüntüsü yükleniyor (ayarlardan)');
  } else {
    // Varsayılan frame.png kullan
    // Electron'da path düzeltmesi
    if (window.location.protocol === 'file:') {
      // Electron file protocol kullanıyor
      const imgPath = window.location.pathname.replace(/\\/g, '/');
      const basePath = imgPath.substring(0, imgPath.lastIndexOf('/'));
      img.src = `${basePath}/frame.png`;
    } else {
      // Web browser (Live Server)
      img.src = 'frame.png';
    }
    
    img.onerror = function() {
      console.error('frame.png yüklenemedi, tekrar deneniyor...');
      // Alternatif path dene
      img.src = './frame.png';
    };
    
    console.log('Varsayılan QR kod görüntüsü yükleniyor (frame.png)');
  }
  
  // Container'ı temizle ve img'i ekle
  qrContainer.innerHTML = '';
  qrContainer.appendChild(img);
}

// Fotoğrafları sunucudan yükle (IndexedDB cache ile)
async function loadPhotos() {
  try {
    console.log('📡 Fotoğraflar sunucudan yükleniyor, server URL:', serverUrl);
    
    const response = await fetch(`${serverUrl}/photos`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
      mode: 'cors',
      credentials: 'omit'
    });
    
    if (!response.ok) {
      console.error(`❌ HTTP error! status: ${response.status}, statusText: ${response.statusText}`);
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    console.log('✓ Fotoğraf listesi alındı, toplam:', data.length);
    
    if (Array.isArray(data) && data.length > 0) {
      // Son yüklenen fotoğraflar önce gösterilsin (tarihe göre sıralama)
      const sortedData = data.sort((a, b) => {
        const dateA = a.lastModified ? new Date(a.lastModified) : new Date(0);
        const dateB = b.lastModified ? new Date(b.lastModified) : new Date(0);
        return dateB - dateA;
      });
      
      // Fotoğraf URL'lerini normalize et
      const photoDataList = sortedData.map(photo => {
        let url = null;
        if (photo.url && photo.url.startsWith('http')) {
          url = photo.url;
        } else if (photo.url && photo.url.startsWith('/')) {
          url = `${serverUrl}${photo.url}`;
        } else if (photo.file) {
          url = `${serverUrl}/uploads/${photo.file}`;
        }
        
        if (url) {
          return {
            url: url,
            lastModified: photo.lastModified || new Date().toISOString()
          };
        }
        return null;
      }).filter(item => item !== null);
      
      console.log('📋 İşlenecek fotoğraf sayısı:', photoDataList.length);
      
      // 300 limit: En fazla 300 foto göster (20 slayt)
      const limitedPhotoDataList = photoDataList.slice(0, MAX_PHOTOS);
      if (photoDataList.length > MAX_PHOTOS) {
        console.log(`⚠ Fotoğraf sayısı limit aştı (${photoDataList.length}), ilk ${MAX_PHOTOS} fotoğraf gösterilecek`);
      }
      
      // Fotoğrafları cache'den veya internetten yükle
      photos = [];
      const cachePromises = [];
      
      for (let i = 0; i < limitedPhotoDataList.length; i++) {
        const photoData = limitedPhotoDataList[i];
        
        // Önce cache'de kontrol et
        const cachedBlobUrl = await getCachedPhotoBlob(photoData.url);
        
        if (cachedBlobUrl) {
          // Cache'den kullan - hemen göster
          photos.push(cachedBlobUrl);
        } else {
          // Cache yoksa, önce normal URL ile göster (kullanıcı bekletme)
          photos.push(photoData.url);
          
          // Arka planda cache'le (non-blocking)
          const cachePromise = cachePhoto(photoData).then((cached) => {
            if (cached && cached.blob) {
              // Cache'lendikten sonra blob URL ile değiştir
              const index = photos.indexOf(photoData.url);
              if (index !== -1) {
                const blobUrl = URL.createObjectURL(cached.blob);
                photos[index] = blobUrl;
                
                // Eğer bu fotoğraf şu anda gösteriliyorsa sayfayı güncelle
                const currentPage = Math.floor(index / PHOTOS_PER_PAGE);
                if (currentPage === currentPageIndex) {
                  showPhotoPage(currentPageIndex);
                }
              }
            }
          }).catch(err => {
            console.error('Cache hatası (görmezden geliniyor):', err);
          });
          
          cachePromises.push(cachePromise);
        }
      }
      
      // Tüm cache işlemlerinin tamamlanmasını bekle (arka planda)
      Promise.all(cachePromises).then(() => {
        console.log('✓ Tüm fotoğraflar cache\'lendi');
        updateCacheMetadata('lastUpdate', new Date().toISOString());
        
        // Cache'de 300'ü aşan eski fotoğrafları sil (FIFO)
        deleteOldestCachedPhotos(MAX_PHOTOS).then(() => {
          console.log(`✓ Cache limit kontrolü tamamlandı (max: ${MAX_PHOTOS} fotoğraf)`);
        });
      });
      
      console.log('📸 Fotoğraf listesi hazır:', photos.length, 'fotoğraf');
      console.log('  - Cache\'den:', photos.filter(url => url.startsWith('blob:')).length);
      console.log('  - İnternetten:', photos.filter(url => !url.startsWith('blob:')).length);
      
      // Fotoğraf sayısını güncelle
      const photoCountEl = document.getElementById('photo-count');
      if (photoCountEl) {
        photoCountEl.textContent = photos.length;
      }
      
      // Loading'i gizle ve içeriğini temizle, slideshow'u göster
      const loadingEl = document.getElementById('loading');
      if (loadingEl) {
        loadingEl.style.display = 'none';
        loadingEl.innerHTML = '<p>Fotoğraflar yükleniyor...</p>'; // Orijinal haline döndür
      }
      
      const noPhotosEl = document.getElementById('no-photos');
      if (noPhotosEl) {
        noPhotosEl.style.display = 'none';
      }
      
      const slideshowEl = document.getElementById('slideshow');
      if (slideshowEl) {
        slideshowEl.style.display = 'block';
      }
      
      // Eğer yeni fotoğraflar varsa slideshow'u başlat/yeniden başlat
      if (photos.length > 0) {
        const totalPages = Math.ceil(photos.length / PHOTOS_PER_PAGE);
        
        // Eğer slideshow çalışmıyorsa başlat
        if (!slideInterval) {
          console.log('Slideshow ilk kez başlatılıyor...');
          currentPageIndex = 0;
          startSlideshow();
        } else {
          // Slideshow zaten çalışıyorsa timer'ı BOZMADAN sadece fotoğraf listesini güncelle
          // showPhotoPage çağrılmamalı çünkü bu timer'ı etkiler ve sayfa değişikliğini tetikler
          console.log('Slideshow devam ediyor, sadece fotoğraf listesi güncellendi (timer korunuyor, sayfa değişmiyor)');
          
          // Eğer mevcut sayfa index'i toplam sayfa sayısından büyükse veya eşitse düzelt
          if (currentPageIndex >= totalPages) {
            console.log(`Sayfa index (${currentPageIndex + 1}) toplam sayfa sayısından (${totalPages}) büyük, sıfırlanıyor`);
            currentPageIndex = 0;
            // Timer'ı koru, sadece mevcut sayfayı göster
            showPhotoPage(currentPageIndex);
          }
          // Aksi halde hiçbir şey yapma - timer devam etsin, mevcut sayfa gösterilsin
        }
      }
    } else {
      // Fotoğraf yoksa
      const loadingEl = document.getElementById('loading');
      if (loadingEl) {
        loadingEl.style.display = 'none';
        loadingEl.innerHTML = '<p>Fotoğraflar yükleniyor...</p>'; // Orijinal haline döndür
      }
      
      const slideshowEl = document.getElementById('slideshow');
      if (slideshowEl) {
        slideshowEl.style.display = 'none';
      }
      
      const noPhotosEl = document.getElementById('no-photos');
      if (noPhotosEl) {
        noPhotosEl.style.display = 'block';
      }
      
      const photoCountEl = document.getElementById('photo-count');
      if (photoCountEl) {
        photoCountEl.textContent = '0';
      }
      
      stopSlideshow();
    }
  } catch (error) {
    console.error('❌ Sunucuya bağlanılamadı:', error);
    
    // Offline durumunda cache'den yükle
    const cacheLoaded = await loadFromCache();
    
    if (!cacheLoaded) {
      // Cache'de de yoksa hata göster
      const loadingEl = document.getElementById('loading');
      if (loadingEl) {
        loadingEl.style.display = 'block';
        loadingEl.innerHTML = '<p style="color: red;">Sunucuya bağlanılamadı</p><p style="color: #999; font-size: 14px; margin-top: 10px;">Cache\'de fotoğraf bulunamadı</p>';
      }
      
      const slideshowEl = document.getElementById('slideshow');
      if (slideshowEl) {
        slideshowEl.style.display = 'none';
      }
      
      const noPhotosEl = document.getElementById('no-photos');
      if (noPhotosEl) {
        noPhotosEl.style.display = 'none';
      }
    } else {
      // Cache'den yüklendi, başarı mesajı göster
      const loadingEl = document.getElementById('loading');
      if (loadingEl) {
        loadingEl.style.display = 'block';
        loadingEl.innerHTML = '<p style="color: orange;">Offline mod</p><p style="color: #999; font-size: 14px; margin-top: 10px;">Cache\'den fotoğraflar gösteriliyor</p>';
        setTimeout(() => {
          if (loadingEl) loadingEl.style.display = 'none';
        }, 2000);
      }
    }
  }
}

// Slideshow'u başlat
function startSlideshow() {
  if (photos.length === 0) return;
  
  // Eğer slideshow zaten çalışıyorsa durdur (setTimeout için clearTimeout kullan)
  if (slideInterval) {
    clearTimeout(slideInterval);
    clearInterval(slideInterval); // Emin olmak için her ikisini de temizle
    slideInterval = null;
  }
  
  // Toplam sayfa sayısını hesapla
  const totalPages = Math.ceil(photos.length / PHOTOS_PER_PAGE);
  
  // İlk sayfayı göster
  currentPageIndex = 0;
  showPhotoPage(0);
  
  // Otomatik geçişi başlat (sadece birden fazla sayfa varsa)
  if (totalPages > 1) {
    // Her sayfa için tam 5 saniye bekle
    scheduleNextPage();
  }
}

// Bir sonraki sayfaya geçmeyi planla
function scheduleNextPage() {
  console.log(`🔧 scheduleNextPage() çağrıldı`);
  
  // Mevcut timer'ı temizle
  if (slideInterval) {
    console.log(`🧹 Mevcut timer temizleniyor: ${slideInterval}`);
    clearTimeout(slideInterval);
    clearInterval(slideInterval); // Her ihtimale karşı
    slideInterval = null;
  }
  
  const totalPages = Math.ceil(photos.length / PHOTOS_PER_PAGE);
  
  if (totalPages <= 1) {
    console.log('⚠️ Tek sayfa var, otomatik geçiş yapılmayacak');
    return;
  }
  
  const nextPageIndex = (currentPageIndex + 1) % totalPages;
  
  // getSlideInterval() fonksiyonunu çağır ve değeri al
  console.log(`🔍 getSlideInterval() çağrılıyor... settings.slideInterval=${settings.slideInterval}`);
  const intervalMs = getSlideInterval();
  const intervalSeconds = intervalMs / 1000;
  
  console.log(`📄 Sayfa ${currentPageIndex + 1}/${totalPages} gösteriliyor, tam ${intervalSeconds} saniye (${intervalMs}ms) sonra sayfa ${nextPageIndex + 1}'e geçilecek`);
  
  // Ayarlanan süre sonra bir sonraki sayfaya geç (timer'ı kaydet)
  console.log(`⏰ setTimeout kuruluyor: ${intervalMs}ms (${intervalSeconds} saniye)`);
  slideInterval = setTimeout(() => {
    console.log(`⏰ [TIMER ÇALIŞTI] ${intervalSeconds} saniye geçti!`);
    
    // Timer çalıştığında tekrar kontrol et
    const totalPages = Math.ceil(photos.length / PHOTOS_PER_PAGE);
    if (totalPages <= 1) {
      console.log(`⚠️ [TIMER] Tek sayfa var, iptal ediliyor`);
      slideInterval = null;
      return;
    }
    
    const nextPageIndex = (currentPageIndex + 1) % totalPages;
    
    console.log(`🔄 [TIMER] Sayfa değişiyor: ${currentPageIndex + 1} -> ${nextPageIndex + 1} (toplam ${totalPages} sayfa)`);
    
    // Sayfa değiştir
    showPhotoPage(nextPageIndex);
    
    // Timer'ı null yap (showPhotoPage içinde currentPageIndex güncellenir)
    slideInterval = null;
    
    // Bir sonraki sayfa geçişini planla (döngüsel - her zaman devam et)
    scheduleNextPage();
  }, intervalMs); // Her sayfa için ayarlanan süre kadar
  
  console.log(`✅ Timer başarıyla kuruldu: ${intervalMs}ms (${intervalSeconds}s) - Timer ID: ${slideInterval}`);
  console.log(`📌 settings.slideInterval değeri: ${settings.slideInterval}`);
}

// Slideshow'u durdur
function stopSlideshow() {
  if (slideInterval) {
    console.log(`🛑 stopSlideshow() çağrıldı - Timer ID: ${slideInterval}`);
    // setInterval veya setTimeout olabilir
    clearInterval(slideInterval);
    clearTimeout(slideInterval);
    slideInterval = null;
    console.log(`✅ Timer durduruldu ve null yapıldı`);
  } else {
    console.log(`ℹ️ stopSlideshow() çağrıldı ama timer zaten null`);
  }
}

// Belirli bir sayfadaki fotoğrafları göster (15'lik grup)
function showPhotoPage(pageIndex) {
  if (photos.length === 0) return;
  
  const totalPages = Math.ceil(photos.length / PHOTOS_PER_PAGE);
  if (pageIndex < 0 || pageIndex >= totalPages) return;
  
  const gridContainer = document.getElementById('photo-grid');
  if (!gridContainer) return;
  
  // currentPageIndex'i hemen güncelle (böylece timer doğru çalışır)
  currentPageIndex = pageIndex;
  
  // Grid'i geçici olarak gizle (fade out) - smooth transition
  gridContainer.classList.remove('active');
  
  // Fade out tamamlandıktan sonra içeriği değiştir
  setTimeout(() => {
    // Container'ı temizle
    gridContainer.innerHTML = '';
    
    // Bu sayfa için fotoğrafları al
    const startIndex = pageIndex * PHOTOS_PER_PAGE;
    const endIndex = Math.min(startIndex + PHOTOS_PER_PAGE, photos.length);
    const pagePhotos = photos.slice(startIndex, endIndex);
    
    // Her fotoğraf için grid item oluştur
    pagePhotos.forEach((photoUrl, index) => {
      const photoItem = document.createElement('div');
      photoItem.className = 'photo-item';
      // Staggered animation - her fotoğraf sırayla belirsin (daha akıcı)
      photoItem.style.animationDelay = `${index * 0.02}s`;
      
      const img = document.createElement('img');
      img.src = photoUrl;
      img.alt = `Fotoğraf ${startIndex + index + 1}`;
      img.loading = 'eager'; // Hızlı yükleme için
      
      img.onerror = function() {
        console.error('Error loading image:', photoUrl);
        // Hatalı fotoğraf için placeholder göster
        photoItem.innerHTML = '<div class="photo-placeholder">Fotoğraf yüklenemedi</div>';
      };
      
      photoItem.appendChild(img);
      gridContainer.appendChild(photoItem);
    });
    
    // 15'ten az fotoğraf varsa boş placeholder ekle
    for (let i = pagePhotos.length; i < PHOTOS_PER_PAGE; i++) {
      const emptyItem = document.createElement('div');
      emptyItem.className = 'photo-item';
      emptyItem.innerHTML = '<div class="photo-placeholder"></div>';
      emptyItem.style.animationDelay = `${(pagePhotos.length + i) * 0.02}s`;
      gridContainer.appendChild(emptyItem);
    }
    
    // Grid'i tekrar göster (fade in) - smooth transition
    // requestAnimationFrame ile bir sonraki frame'de göstermek daha akıcı
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        gridContainer.classList.add('active');
      });
    });
    
    console.log(`Sayfa ${pageIndex + 1}/${totalPages} gösteriliyor (${startIndex + 1}-${endIndex} arası fotoğraflar, toplam ${photos.length} fotoğraf)`);
  }, 350); // Fade out için yeterli süre (transition süresiyle uyumlu)
}

// Ayarları yükle
function loadSettings() {
  const savedSettings = localStorage.getItem('m3foto_settings');
  if (savedSettings) {
    try {
      const parsed = JSON.parse(savedSettings);
      // Mevcut default değerleri koru, localStorage'dan gelen değerlerle birleştir
      settings = {
        bgImage: parsed.bgImage !== undefined ? parsed.bgImage : settings.bgImage,
        bgColor: parsed.bgColor || settings.bgColor || '#000000',
        qrCodeImage: parsed.qrCodeImage !== undefined ? parsed.qrCodeImage : settings.qrCodeImage,
        slideInterval: parsed.slideInterval !== undefined && parsed.slideInterval !== null ? parsed.slideInterval : settings.slideInterval || 10,
        qrTextTop: parsed.qrTextTop !== undefined ? parsed.qrTextTop : settings.qrTextTop || '',
        qrTextBottom: parsed.qrTextBottom !== undefined ? parsed.qrTextBottom : settings.qrTextBottom || ''
      };
      
      // slideInterval değerini kontrol et ve düzelt (10-35 arası olmalı)
      if (settings.slideInterval < 10 || settings.slideInterval > 35 || isNaN(settings.slideInterval)) {
        console.warn(`⚠️ Geçersiz slideInterval değeri: ${settings.slideInterval}, 10'a sıfırlanıyor`);
        settings.slideInterval = 10;
      }
      
      console.log('📋 Ayarlar yüklendi:', settings);
      console.log(`⏱️ Slayt geçiş süresi: ${settings.slideInterval} saniye`);
      
      applySettings();
    } catch (e) {
      console.error('Settings load error:', e);
    }
  } else {
    console.log('📋 localStorage\'da ayar yok, default değerler kullanılıyor');
  }
}

// Ayarları uygula
function applySettings() {
  const body = document.body;
  const slideshowSection = document.querySelector('.slideshow-section');
  
  if (!body) return;
  
  // Arkaplan rengi (varsayılan siyah)
  const bgColor = settings.bgColor || '#000000';
  
  // Arkaplan fotoğrafı varsa body'ye uygula (tüm ekranı kapsasın)
  if (settings.bgImage) {
    body.style.backgroundImage = `url(${settings.bgImage})`;
    body.style.backgroundSize = 'cover';
    body.style.backgroundPosition = 'center';
    body.style.backgroundRepeat = 'no-repeat';
    body.style.backgroundColor = bgColor; // Renk fallback olarak
  } else {
    body.style.backgroundImage = 'none';
    body.style.backgroundColor = bgColor;
  }
  
  // Slideshow section'ı transparant yap (arkaplan görünsün)
  if (slideshowSection) {
    slideshowSection.style.backgroundColor = 'transparent';
    slideshowSection.style.backgroundImage = 'none';
  }
  
  // UI güncelleme
  const bgColorInput = document.getElementById('bg-color-input');
  const bgColorText = document.getElementById('bg-color-text');
  if (bgColorInput) {
    bgColorInput.value = bgColor;
  }
  if (bgColorText) {
    bgColorText.value = bgColor;
  }
  
  // Slayt geçiş süresi UI güncelleme
  const slideIntervalSlider = document.getElementById('slide-interval-slider');
  const slideIntervalInput = document.getElementById('slide-interval-input');
  const slideIntervalValue = settings.slideInterval || 10;
  
  if (slideIntervalSlider) {
    slideIntervalSlider.value = slideIntervalValue;
  }
  if (slideIntervalInput) {
    slideIntervalInput.value = slideIntervalValue;
  }
  
  // QR kod yazıları UI güncelleme (input field'ları güncelleme, değerleri gösterme)
  // Input field'lar boş kalacak, sadece ekrandaki text alanları güncellenecek
  // Kullanıcı yeni yazı girmek istediğinde input'a yazacak
  
  updateBgImagePreview();
  
  // QR kod yazılarını güncelle (ekrandaki text alanlarını)
  updateQRTexts();
}

// QR kod yazılarını güncelle
function updateQRTexts() {
  const qrTextTopEl = document.getElementById('qr-text-top');
  const qrTextBottomEl = document.getElementById('qr-text-bottom');
  
  if (qrTextTopEl) {
    qrTextTopEl.textContent = settings.qrTextTop || '';
  }
  
  if (qrTextBottomEl) {
    qrTextBottomEl.textContent = settings.qrTextBottom || '';
  }
}

// Arkaplan fotoğrafı önizlemesini güncelle
function updateBgImagePreview() {
  const preview = document.getElementById('bg-image-preview');
  if (!preview) return;
  
  if (settings.bgImage) {
    preview.innerHTML = `<img src="${settings.bgImage}" alt="Arkaplan">`;
    preview.classList.remove('empty');
  } else {
    preview.innerHTML = '';
    preview.classList.add('empty');
  }
}

// QR kod görüntüsü önizlemesini güncelle
function updateQRCodePreview() {
  const preview = document.getElementById('qr-image-preview');
  if (!preview) return;
  
  if (settings.qrCodeImage) {
    preview.innerHTML = `<img src="${settings.qrCodeImage}" alt="QR Kod">`;
    preview.classList.remove('empty');
  } else {
    preview.innerHTML = '';
    preview.classList.add('empty');
  }
}

// Ayarları kaydet
function saveSettings() {
  localStorage.setItem('m3foto_settings', JSON.stringify(settings));
  applySettings();
  // QR kod görüntüsü değişmişse güncelle
  updateQRCodePreview();
  // QR kod yazılarını güncelle
  updateQRTexts();
  if (settings.qrCodeImage !== undefined) {
    generateQRCode();
  }
}

// Tüm fotoğrafları sil (sunucudan ve cache'den)
async function deleteAllPhotos() {
  try {
    console.log('🗑️ Tüm fotoğraflar siliniyor...');
    
    // Butonu devre dışı bırak (çift tıklamayı önle)
    const deleteBtn = document.getElementById('delete-all-photos');
    if (deleteBtn) {
      deleteBtn.disabled = true;
      deleteBtn.textContent = '⏳ Siliniyor...';
    }
    
    // /delete_all endpoint'ini çağır (tüm fotoğrafları tek seferde sil)
    const deleteUrl = `${serverUrl}/delete_all`;
    console.log('🗑️ DELETE isteği gönderiliyor:', deleteUrl);
    console.log('📡 Server URL:', serverUrl);
    
    const response = await fetch(deleteUrl, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
      mode: 'cors',
      credentials: 'omit'
    });
    
    console.log('📡 Response status:', response.status, response.statusText);
    
    // Response body'yi bir kez oku (text veya json olabilir)
    const responseText = await response.text();
    console.log('📡 Response body:', responseText);
    
    let result;
    try {
      result = JSON.parse(responseText);
    } catch (e) {
      // JSON değilse text olarak kullan
      result = { ok: false, error: responseText || 'Bilinmeyen hata' };
    }
    
    if (!response.ok) {
      console.error('❌ HTTP error! status:', response.status, 'body:', result);
      throw new Error(`HTTP error! status: ${response.status}, statusText: ${response.statusText}, error: ${result.error || result.message || 'Endpoint bulunamadı'}`);
    }
    
    if (!result.ok) {
      throw new Error(result.error || 'Fotoğraflar silinemedi');
    }
    
    console.log('✓ Tüm fotoğraflar sunucudan silindi');
    
    // Local cache'i de temizle
    await clearAllCachedPhotos();
    
    // Fotoğraf listesini temizle
    photos = [];
    revokeBlobURLs();
    stopSlideshow();
    
    // UI'ı güncelle
    const photoCountEl = document.getElementById('photo-count');
    if (photoCountEl) {
      photoCountEl.textContent = '0';
    }
    
    const slideshowEl = document.getElementById('slideshow');
    if (slideshowEl) {
      slideshowEl.style.display = 'none';
    }
    
    const noPhotosEl = document.getElementById('no-photos');
    if (noPhotosEl) {
      noPhotosEl.style.display = 'block';
    }
    
    const loadingEl = document.getElementById('loading');
    if (loadingEl) {
      loadingEl.style.display = 'none';
    }
    
    // Başarı mesajı göster
    alert('✓ Tüm fotoğraflar başarıyla silindi');
    
    // Butonu tekrar etkinleştir
    if (deleteBtn) {
      deleteBtn.disabled = false;
      deleteBtn.textContent = '🗑️ Tüm Fotoğrafları Sil';
    }
    
    // Fotoğrafları yeniden yükle (sunucudan yeni durumu al - boş liste dönecek)
    await loadPhotos();
    
  } catch (error) {
    console.error('❌ Tüm fotoğrafları silme hatası:', error);
    alert('Fotoğraflar silinirken bir hata oluştu: ' + (error.message || error));
    
    // Butonu tekrar etkinleştir
    const deleteBtn = document.getElementById('delete-all-photos');
    if (deleteBtn) {
      deleteBtn.disabled = false;
      deleteBtn.textContent = '🗑️ Tüm Fotoğrafları Sil';
    }
  }
}

// Ayarlar panelini aç/kapa
function toggleSettingsPanel() {
  const panel = document.getElementById('settings-panel');
  if (panel) {
    panel.classList.toggle('open');
  }
}

// Ayarlar panelini başlat
function initSettings() {
  loadSettings();
  
  const settingsPanel = document.getElementById('settings-panel');
  const closeBtn = document.getElementById('close-settings');
  const bgImageInput = document.getElementById('bg-image-input');
  const bgImageUploadBtn = document.getElementById('bg-image-upload');
  const bgImageRemoveBtn = document.getElementById('bg-image-remove');
  const bgColorInput = document.getElementById('bg-color-input');
  const bgColorText = document.getElementById('bg-color-text');
  const colorPresets = document.querySelectorAll('.color-preset');
  const qrImageInput = document.getElementById('qr-image-input');
  const qrImageUploadBtn = document.getElementById('qr-image-upload');
  const qrImageRemoveBtn = document.getElementById('qr-image-remove');
  const slideIntervalSlider = document.getElementById('slide-interval-slider');
  const slideIntervalInput = document.getElementById('slide-interval-input');
  const qrTextTopInput = document.getElementById('qr-text-top-input');
  const qrTextTopAddBtn = document.getElementById('qr-text-top-add');
  const qrTextTopRemoveBtn = document.getElementById('qr-text-top-remove');
  const qrTextBottomInput = document.getElementById('qr-text-bottom-input');
  const qrTextBottomAddBtn = document.getElementById('qr-text-bottom-add');
  const qrTextBottomRemoveBtn = document.getElementById('qr-text-bottom-remove');
  
  // CTRL tuşu ile panel açma/kapama
  let ctrlToggleTimer = null;
  
  document.addEventListener('keydown', (e) => {
    // ESC ile kapatma
    if (e.key === 'Escape') {
      if (settingsPanel && settingsPanel.classList.contains('open')) {
        settingsPanel.classList.remove('open');
      }
      return;
    }
    
    // CTRL tuşuna basıldığında (tek başına)
    if (e.key === 'Control' || e.key === 'Meta') {
      // Başka bir tuşla kombinasyon yapılmamışsa
      if (!e.shiftKey && !e.altKey) {
        // Timer'ı temizle
        if (ctrlToggleTimer) {
          clearTimeout(ctrlToggleTimer);
        }
        
        // Kısa bir süre bekle, eğer başka tuş basılmazsa toggle yap
        ctrlToggleTimer = setTimeout(() => {
          // CTRL hala basılı ve başka tuş basılmamışsa
          toggleSettingsPanel();
          ctrlToggleTimer = null;
        }, 150);
      }
      return;
    }
    
    // Eğer CTRL ile birlikte başka bir tuş basılırsa timer'ı iptal et
    if (e.ctrlKey || e.metaKey) {
      if (ctrlToggleTimer) {
        clearTimeout(ctrlToggleTimer);
        ctrlToggleTimer = null;
      }
    }
  });
  
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Control' || e.key === 'Meta') {
      if (ctrlToggleTimer) {
        clearTimeout(ctrlToggleTimer);
        ctrlToggleTimer = null;
      }
    }
  });
  
  // Kapat butonu
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      toggleSettingsPanel();
    });
  }
  
  // Arkaplan fotoğrafı yükleme
  if (bgImageUploadBtn) {
    bgImageUploadBtn.addEventListener('click', () => {
      bgImageInput?.click();
    });
  }
  
  if (bgImageInput) {
    bgImageInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file && file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (event) => {
          settings.bgImage = event.target.result;
          saveSettings();
        };
        reader.readAsDataURL(file);
      }
    });
  }
  
  // Arkaplan fotoğrafı silme
  if (bgImageRemoveBtn) {
    bgImageRemoveBtn.addEventListener('click', () => {
      if (confirm('Arkaplan fotoğrafını silmek istediğinize emin misiniz?')) {
        settings.bgImage = null;
        saveSettings();
      }
    });
  }
  
  // Arkaplan rengi değiştirme
  if (bgColorInput) {
    bgColorInput.addEventListener('input', (e) => {
      settings.bgColor = e.target.value;
      if (bgColorText) {
        bgColorText.value = e.target.value;
      }
      saveSettings();
    });
  }
  
  if (bgColorText) {
    bgColorText.addEventListener('change', (e) => {
      const color = e.target.value;
      if (/^#[0-9A-F]{6}$/i.test(color)) {
        settings.bgColor = color;
        if (bgColorInput) {
          bgColorInput.value = color;
        }
        saveSettings();
      } else {
        alert('Geçersiz renk formatı. #RRGGBB formatında girin (örn: #000000)');
        bgColorText.value = settings.bgColor || '#000000';
      }
    });
  }
  
  // Renk presets
  colorPresets.forEach(preset => {
    preset.addEventListener('click', () => {
      const color = preset.getAttribute('data-color');
      if (color) {
        settings.bgColor = color;
        if (bgColorInput) bgColorInput.value = color;
        if (bgColorText) bgColorText.value = color;
        saveSettings();
      }
    });
  });
  
  // QR kod görüntüsü yükleme
  if (qrImageUploadBtn) {
    qrImageUploadBtn.addEventListener('click', () => {
      qrImageInput?.click();
    });
  }
  
  if (qrImageInput) {
    qrImageInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file && file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (event) => {
          settings.qrCodeImage = event.target.result;
          saveSettings();
          // QR kod görüntüsünü hemen güncelle
          generateQRCode();
        };
        reader.readAsDataURL(file);
      }
    });
  }
  
  // QR kod görüntüsü silme (varsayılana dön)
  if (qrImageRemoveBtn) {
    qrImageRemoveBtn.addEventListener('click', () => {
      if (confirm('QR kod görüntüsünü varsayılana döndürmek istediğinize emin misiniz?')) {
        settings.qrCodeImage = null;
        saveSettings();
        // QR kod görüntüsünü hemen güncelle
        generateQRCode();
      }
    });
  }
  
  // Slayt geçiş süresi slider - gerçek zamanlı güncelleme
  if (slideIntervalSlider) {
    slideIntervalSlider.addEventListener('input', (e) => {
      const value = parseInt(e.target.value);
      console.log(`🔄 Slider değişti: ${value} saniye`);
      
      settings.slideInterval = value;
      if (slideIntervalInput) {
        slideIntervalInput.value = value;
      }
      // localStorage'a kaydet
      localStorage.setItem('m3foto_settings', JSON.stringify(settings));
      console.log(`💾 Ayarlar kaydedildi: slideInterval=${settings.slideInterval}`);
      
      // ÖNEMLİ: Her zaman mevcut timer'ı durdur (tek sayfa olsa bile eski timer çalışıyor olabilir)
      console.log(`⏹️ Mevcut timer durduruluyor... (slideInterval=${slideInterval})`);
      stopSlideshow();
      
      // Slideshow timer'ını hemen yeniden başlat (eğer slideshow çalışıyorsa)
      if (photos.length > 0) {
        const totalPages = Math.ceil(photos.length / PHOTOS_PER_PAGE);
        console.log(`📊 Toplam fotoğraf: ${photos.length}, Toplam sayfa: ${totalPages}`);
        if (totalPages > 1) {
          // Yeni süre ile yeniden başlat
          console.log(`▶️ Yeni timer başlatılıyor... (${value} saniye)`);
          scheduleNextPage();
        } else {
          console.log(`⚠️ Tek sayfa var, timer başlatılmıyor (ama eski timer durduruldu)`);
        }
      } else {
        console.log(`⚠️ Fotoğraf yok, timer başlatılmıyor (ama eski timer durduruldu)`);
      }
      
      console.log(`⏱️ Slayt geçiş süresi değiştirildi: ${value} saniye (${value * 1000}ms)`);
      console.log(`📌 settings.slideInterval şu an: ${settings.slideInterval}`);
    });
  }
  
  // Slayt geçiş süresi input - değişiklik sonrası güncelleme
  if (slideIntervalInput) {
    slideIntervalInput.addEventListener('change', (e) => {
      let value = parseInt(e.target.value);
      // Min 10, max 35 kontrolü
      if (isNaN(value) || value < 10) value = 10;
      if (value > 35) value = 35;
      
      settings.slideInterval = value;
      if (slideIntervalSlider) {
        slideIntervalSlider.value = value;
      }
      slideIntervalInput.value = value; // Düzeltilmiş değeri göster
      
      // localStorage'a kaydet
      localStorage.setItem('m3foto_settings', JSON.stringify(settings));
      
      // Slideshow timer'ını hemen yeniden başlat (eğer slideshow çalışıyorsa)
      if (photos.length > 0) {
        const totalPages = Math.ceil(photos.length / PHOTOS_PER_PAGE);
        if (totalPages > 1) {
          // Mevcut timer'ı durdur
          stopSlideshow();
          // Yeni süre ile yeniden başlat
          scheduleNextPage();
        }
      }
      
      console.log(`⏱️ Slayt geçiş süresi değiştirildi: ${value} saniye (${value * 1000}ms)`);
    });
  }
  
  // QR kod üst yazısı ekleme
  if (qrTextTopAddBtn) {
    qrTextTopAddBtn.addEventListener('click', () => {
      const text = qrTextTopInput ? qrTextTopInput.value.trim() : '';
      settings.qrTextTop = text;
      saveSettings();
      // Input'u temizle
      if (qrTextTopInput) {
        qrTextTopInput.value = '';
      }
    });
  }
  
  // QR kod üst yazısı silme
  if (qrTextTopRemoveBtn) {
    qrTextTopRemoveBtn.addEventListener('click', () => {
      if (confirm('Üst yazıyı silmek istediğinize emin misiniz?')) {
        settings.qrTextTop = '';
        saveSettings();
        // Input'u temizle
        if (qrTextTopInput) {
          qrTextTopInput.value = '';
        }
      }
    });
  }
  
  // QR kod üst yazısı input - Enter tuşu ile ekleme
  if (qrTextTopInput) {
    qrTextTopInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const text = qrTextTopInput.value.trim();
        settings.qrTextTop = text;
        saveSettings();
        // Input'u temizle
        qrTextTopInput.value = '';
      }
    });
  }
  
  // QR kod alt yazısı ekleme
  if (qrTextBottomAddBtn) {
    qrTextBottomAddBtn.addEventListener('click', () => {
      const text = qrTextBottomInput ? qrTextBottomInput.value.trim() : '';
      settings.qrTextBottom = text;
      saveSettings();
      // Input'u temizle
      if (qrTextBottomInput) {
        qrTextBottomInput.value = '';
      }
    });
  }
  
  // QR kod alt yazısı silme
  if (qrTextBottomRemoveBtn) {
    qrTextBottomRemoveBtn.addEventListener('click', () => {
      if (confirm('Alt yazıyı silmek istediğinize emin misiniz?')) {
        settings.qrTextBottom = '';
        saveSettings();
        // Input'u temizle
        if (qrTextBottomInput) {
          qrTextBottomInput.value = '';
        }
      }
    });
  }
  
  // QR kod alt yazısı input - Enter tuşu ile ekleme
  if (qrTextBottomInput) {
    qrTextBottomInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const text = qrTextBottomInput.value.trim();
        settings.qrTextBottom = text;
        saveSettings();
        // Input'u temizle
        qrTextBottomInput.value = '';
      }
    });
  }
  
  // Tüm fotoğrafları sil butonu
  const deleteAllPhotosBtn = document.getElementById('delete-all-photos');
  if (deleteAllPhotosBtn) {
    deleteAllPhotosBtn.addEventListener('click', async () => {
      if (confirm('TÜM fotoğrafları silmek istediğinize emin misiniz?\n\nBu işlem geri alınamaz ve sunucudaki tüm fotoğraflar kalıcı olarak silinecektir!')) {
        await deleteAllPhotos();
      }
    });
  }
  
  updateBgImagePreview();
  updateQRCodePreview();
  updateQRTexts();
}

// Uygulama başlatıldığında
document.addEventListener('DOMContentLoaded', () => {
  console.log('DOM yüklendi');
  
  // Ayarları başlat
  initSettings();
  
  // Uygulamayı başlat (QR kod görüntüsü frame.png olarak yüklenecek)
  initialize();
});

// Klavye kısayolları (slideshow navigasyonu)
document.addEventListener('keydown', (e) => {
  if (photos.length === 0) return;
  
  const totalPages = Math.ceil(photos.length / PHOTOS_PER_PAGE);
  if (totalPages <= 1) return; // Tek sayfa varsa navigasyon yok
  
  if (e.key === 'ArrowLeft') {
    // Önceki sayfa
    currentPageIndex = (currentPageIndex - 1 + totalPages) % totalPages;
    showPhotoPage(currentPageIndex);
    // Timer'ı sıfırla ve yeniden başlat (5 saniye sayacı sıfırlanır)
    if (slideInterval) {
      clearTimeout(slideInterval);
      clearInterval(slideInterval);
    }
    scheduleNextPage();
  } else if (e.key === 'ArrowRight') {
    // Sonraki sayfa
    currentPageIndex = (currentPageIndex + 1) % totalPages;
    showPhotoPage(currentPageIndex);
    // Timer'ı sıfırla ve yeniden başlat (5 saniye sayacı sıfırlanır)
    if (slideInterval) {
      clearTimeout(slideInterval);
      clearInterval(slideInterval);
    }
    scheduleNextPage();
  }
});
