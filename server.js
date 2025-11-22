// server.js
const express = require("express");
const multer = require("multer");
const path = require("path");
const cors = require("cors");
const fs = require("fs");
const crypto = require("crypto");

const USE_S3 = process.env.USE_S3 === "true";

const app = express();

// Middleware
app.use(cors());
app.use(express.json()); // JSON body parser
app.use(express.urlencoded({ extended: true })); // URL encoded body parser
app.use(express.static("public"));

// güvenlik: upload boyutu ve tür kısıtla
const maxFileSize = 10 * 1024 * 1024; // 10 MB

// Multer storage — local fallback (used only if !USE_S3)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = "uploads";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const rnd = Date.now() + "-" + crypto.randomBytes(4).toString("hex");
    cb(null, rnd + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ["image/jpeg","image/png","image/webp","image/gif"];
  if (!allowed.includes(file.mimetype)) return cb(new Error("Yalnızca resim yüklenebilir"), false);
  cb(null, true);
};

const upload = multer({ storage, limits: { fileSize: maxFileSize }, fileFilter });

// If using S3, we will not use multer diskStorage to keep memory low; multer.memoryStorage to get buffer
const uploadMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxFileSize }, fileFilter });

// S3 setup (AWS SDK v3)
let s3Client;
if (USE_S3) {
  const { S3Client, PutObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
  s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
  });
  app.set("s3", { S3Client, PutObjectCommand, ListObjectsV2Command });
}

// Routes
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "upload.html")));

app.post("/upload", USE_S3 ? uploadMemory.single("photo") : upload.single("photo"), async (req, res) => {
  try {
    // Dosya kontrolü
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "Dosya yüklenmedi" });
    }

    if (USE_S3) {
      // upload to S3
      const { PutObjectCommand } = app.get("s3");
      const bucket = process.env.S3_BUCKET;
      if (!bucket) throw new Error("S3_BUCKET env yok");

      const key = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${path.extname(req.file.originalname)}`;
      const params = {
        Bucket: bucket,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
        ACL: "public-read"
      };

      await s3Client.send(new PutObjectCommand(params));
      const url = `https://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
      return res.json({ ok: true, url });
    } else {
      // local upload done by multer
      return res.json({ ok: true, url: `/uploads/${req.file.filename}` });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Health check endpoint (Render için)
app.get("/health", (req, res) => {
  res.json({ 
    ok: true, 
    status: "healthy",
    timestamp: new Date().toISOString(),
    useS3: USE_S3
  });
});

// /photos endpoint: list photos (absolute URLs)
app.get("/photos", async (req, res) => {
  try {
    if (USE_S3) {
      const { ListObjectsV2Command } = app.get("s3");
      const bucket = process.env.S3_BUCKET;
      const list = await s3Client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000 }));
      const items = (list.Contents || []).map(o => ({
        url: `https://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${o.Key}`,
        key: o.Key,
        lastModified: o.LastModified
      }));
      return res.json(items);
    } else {
      const dir = path.join(__dirname, "uploads");
      if (!fs.existsSync(dir)) return res.json([]);
      const files = fs.readdirSync(dir).map(f => ({
        url: `${getBaseUrl(req)}/uploads/${f}`,
        file: f
      }));
      return res.json(files);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// serve uploads statically (local)
if (!USE_S3) app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", err);
  
  // Multer error handling
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ ok: false, error: "Dosya boyutu 10MB'dan büyük olamaz" });
    }
    return res.status(400).json({ ok: false, error: err.message });
  }
  
  // Generic error handling
  res.status(500).json({ 
    ok: false, 
    error: err.message || "Sunucu hatası" 
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Endpoint bulunamadı" });
});

// Helper
function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  return `${proto}://${req.get("host")}`;
}

// Start
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0"; // Render için 0.0.0.0 gerekli

app.listen(PORT, HOST, () => {
  console.log(`Server listening on ${HOST}:${PORT} (USE_S3=${USE_S3})`);
  console.log(`Health check: http://${HOST}:${PORT}/health`);
});
