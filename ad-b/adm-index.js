import express from 'express';
import multer from 'multer';
import dotenv from 'dotenv';
import path, { resolve } from 'path';
import {fileURLToPath} from 'url';
import bcyrpt from 'bcrypt';
import fs from 'fs';
import upload from './middlewares/imageUploadMiddleware.js';
import { execFile } from 'child_process';
import pkg from 'pg';
import { generateKeyPairSync } from 'crypto';
import { SERVER_PUBLIC_KEY, signJWT, verifyJWT } from './security.js';
import { stderr } from 'process';
import { rejects } from 'assert';

const { Pool } = pkg;

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT;

const productPhotoUploadsDir = path.join(__dirname, 'product-photos');

if(!fs.existsSync(productPhotoUploadsDir)){
    fs.mkdirSync(productPhotoUploadsDir, {recursive: true});
    console.log('📁 product-photos klasörü yoktu, oluşturuldu.')
}

app.use(express.json());


/*
==== Server Public Key'ini Paylaşma Fonksiyonu
*/
app.get('/auth/public-key', (_req, res) => {
    res.type('text/plain').send(SERVER_PUBLIC_KEY);
});

app.use('/product-photos', express.static(path.join(__dirname, 'product-photos')));

/*
==== Database Bağlantısı
*/
const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});


/*
==== Password Hashleme ve Kontrol Fonksiyonları
*/
async function hashpassword(password){
    const saltRount = 12;
    const hashed = await bcyrpt.hash(password,saltRount);
    return hashed;
}
async function arePassordsMatch(enteredPassword, dbPassword){
    return await bcyrpt.compare(enteredPassword,dbPassword);
}


// Checking Connection 
app.get('/ad-connection', (req,res) => {
    res.status(200).json({
        status: 'ok',
        message: 'ClearCart Admin Backend is working!'
    });
});

// Dosya yükleme ayarı (çoklu fotoğraf için)
const productStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "product-photos");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // ID Flutter’dan ya da backend’den gelecek
    const productId = req.body.product_id || req.params.id || "temp";
    const ext = path.extname(file.originalname);
    const randomSuffix = Math.floor(Math.random() * 10000);
    cb(null, `${productId}_${randomSuffix}${ext}`);
  },
});

// Middleware oluştur
const uploadProductPhotos = multer({
  storage: productStorage,
  limits: { files: 10 }, // max 10 foto
});

app.post("/admin/add-product", uploadProductPhotos.array("photos", 10), async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, brand, description } = req.body;
    const photos = req.files;

    if (!name || !brand || photos.length === 0) {
      return res.status(400).json({ error: "Eksik bilgi veya fotoğraf yüklenmedi." });
    }

    // 1️⃣ Yeni ID oluştur (en son ürün ID'sinden +1)
    const lastIdResult = await client.query("SELECT MAX(id) AS last_id FROM products");
    const newId = (lastIdResult.rows[0].last_id || 0) + 1;

    // 2️⃣ Ürünü ekle
    await client.query(
      "INSERT INTO products (id, name, brand, description) VALUES ($1, $2, $3, $4)",
      [newId, name, brand, description]
    );

    // 3️⃣ Fotoğrafları yeniden adlandır ve kaydet
    const photoPaths = [];
    for (const file of photos) {
      const ext = path.extname(file.originalname);
      const randomSuffix = Math.floor(Math.random() * 10000);
      const newFileName = `${newId}_${randomSuffix}${ext}`; // <- düzeltildi
      const newPath = path.join(__dirname, "product-photos", newFileName);
      fs.renameSync(file.path, newPath);
      photoPaths.push(newPath);
    }

    // 4️⃣ cc-ai.py çağrısı (Promise tabanlı)
    const runPython = (imgPath) => {
      return new Promise((resolve, reject) => {
        execFile("python3", ["cc-ai.py", imgPath], (error, stdout, stderr) => {
          if (error) return reject(stderr);
          try {
            const output = JSON.parse(stdout);
            resolve(output);
          } catch (err) {
            reject(err);
          }
        });
      });
    };

    // 5️⃣ Tüm fotoğrafları işle
    const embeddingResults = [];
    for (const imgPath of photoPaths) {
      const result = await runPython(imgPath);

      // Barkod varsa ürün tablosuna kaydet
      if (result.barcode) {
        await client.query("UPDATE products SET barcode=$1 WHERE id=$2", [result.barcode, newId]);
      } else {
        embeddingResults.push(result);
      }
    }

    // 6️⃣ Ortalama embedding, RGB ve histogram hesapla
    if (embeddingResults.length > 0) {
      const avg = (arrays) =>
        arrays[0].map((_, i) => arrays.reduce((sum, arr) => sum + arr[i], 0) / arrays.length);

      const avgEmbedding = avg(embeddingResults.map((r) => r.image_embedding));
      const avgRGB = avg(embeddingResults.map((r) => r.mean_rgb));
      const avgHist = avg(embeddingResults.map((r) => r.histogram));

      await client.query(
        `UPDATE products
         SET embedding=$1, mean_rgb=$2, histogram=$3
         WHERE id=$4`,
        [avgEmbedding, avgRGB, avgHist, newId]
      );
    }

    // 7️⃣ Başarılı yanıt
    res.json({
      message: "✅ Ürün başarıyla eklendi ve embedding işlendi.",
      product_id: newId,
      photo_count: photoPaths.length,
    });
  } catch (err) {
    console.error("❌ Hata:", err);
    res.status(500).json({ error: "Ürün ekleme sırasında bir hata oluştu." });
  } finally {
    client.release();
  }
});
