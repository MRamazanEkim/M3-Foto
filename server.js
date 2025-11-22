// server.js
const express = require("express");
const multer = require("multer");
const path = require("path");
const cors = require("cors");
const fs = require("fs");
const crypto = require("crypto");

const app = express();

// -----------------------
// CONFIG
// -----------------------
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/uploads"; // Persistent Disk
const MAX_FILE_SIZE_MB = 10 * 1024 * 1024; // 10 MB

// -----------------------
// MIDDLEWARE
// -----------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// Ensure upload directory exists (Render Persistent Disk creates it but we double-check)
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// -----------------------
// MULTER STORAGE (LOCAL)
// -----------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const rnd = Date.now() + "-" + crypto.randomBytes(4).toString("hex");
    cb(null, rnd + path.extname(file.originalname));
  }
});

const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const fileFilter = (req, file, cb) => {
  if (!allowedTypes.includes(file.mimetype))
    return cb(new Error("Yalnızca resim dosyası yüklenebilir"));
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE_MB }
});

// -----------------------
// ROUTES
// -----------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "upload.html"));
});

// Handle photo upload (local only)
app.post("/upload", upload.single("photo"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "Dosya yüklenmedi" });
  }
  return res.json({
    ok: true,
    url: `${getBaseUrl(req)}/uploads/${req.file.filename}`
  });
});

// List all uploaded photos
app.get("/photos", (req, res) => {
  try {
    if (!fs.existsSync(UPLOAD_DIR)) return res.json([]);

    const files = fs.readdirSync(UPLOAD_DIR);

    const items = files.map(f => {
      const filePath = path.join(UPLOAD_DIR, f);
      const stats = fs.statSync(filePath);
      return {
        url: `${getBaseUrl(req)}/uploads/${f}`,
        file: f,
        lastModified: stats.mtime.toISOString()
      };
    });

    return res.json(items);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Foto silme (tüm fotoğrafları toplu silme) - /uploads'tan ÖNCE tanımlanmalı
app.delete("/delete_all", (req, res) => {
  try {
    console.log('DELETE /delete_all çağrıldı');
    
    if (!fs.existsSync(UPLOAD_DIR)) {
      return res.json({ ok: true, message: "Zaten hiç fotoğraf yok" });
    }

    const files = fs.readdirSync(UPLOAD_DIR);
    console.log(`${files.length} fotoğraf silinecek`);

    files.forEach(f => {
      const filePath = path.join(UPLOAD_DIR, f);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Silindi: ${f}`);
      }
    });

    return res.json({ ok: true, message: "Tüm fotoğraflar silindi" });
  } catch (err) {
    console.error('Delete all error:', err);
    return res.status(500).json({ ok: false, error: "Toplu silme hatası: " + err.message });
  }
});

// Serve uploaded files (static middleware en sona alındı - route'lardan sonra)
app.use("/uploads", express.static(UPLOAD_DIR));

// Render Health Check
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "healthy",
    timestamp: new Date().toISOString(),
    persistentDisk: UPLOAD_DIR
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Endpoint bulunamadı" });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: err.message });
});

// -----------------------
// UTIL
// -----------------------
function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  return `${proto}://${req.get("host")}`;
}

// -----------------------
// START SERVER
// -----------------------
const PORT = process.env.PORT || 3000;
// Render'da 0.0.0.0, local development'te localhost
const HOST = process.env.NODE_ENV === 'production' ? "0.0.0.0" : "localhost";

app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  console.log(`Upload dir: ${UPLOAD_DIR}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
