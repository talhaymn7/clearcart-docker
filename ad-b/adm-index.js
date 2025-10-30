import express from 'express';
import multer from 'multer';
import dotenv from 'dotenv';
import path, { resolve } from 'path';
import { fileURLToPath } from 'url';
import bcyrpt from 'bcrypt';
import fs from 'fs';
import { execFile } from 'child_process';
import pkg from 'pg';
import { SERVER_PUBLIC_KEY, signJWT, verifyJWT } from './security.js';

const { Pool } = pkg;

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT;

const productPhotoUploadsDir = path.join(__dirname, 'product-photos');

if (!fs.existsSync(productPhotoUploadsDir)) {
  fs.mkdirSync(productPhotoUploadsDir, { recursive: true });
  console.log('📁 product-photos klasörü yoktu, oluşturuldu.')
}

app.use(express.json());

// Checking Connection 
app.get('/ad-connection', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'ClearCart Admin Backend is working!'
  });
});

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
async function hashpassword(password) {
  const saltRount = 12;
  const hashed = await bcyrpt.hash(password, saltRount);
  return hashed;
}
async function arePassordsMatch(enteredPassword, dbPassword) {
  return await bcyrpt.compare(enteredPassword, dbPassword);
}

/*
===== Register Endpointi
*/
app.post('/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'E-posta ya da şifre girilmedi. Lütfen tekrar deneyin.' })
    }

    const { rows } = await pool.query(
      'SELECT * FROM adm_users WHERE email = $1 LIMIT 1',
      [email]
    );
    const user = rows[0];

    if (!user) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    }

    const isMatch = await arePassordsMatch(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Şifre yanlış.' });
    }

    const token = signJWT({ email, id: user.id }, { expiresIn: '1d' });

    await pool.query(
      'UPDATE adm_users SET jwt_token = $1 WHERE id = $2',
      [token, user.id]
    );

    return res.status(200).json({
      message: 'Giriş Başarılı',
      jwt: token,
    });
  }
  catch (e) {
    console.error('❌ Login Hatası:', e);
    return res.status(500).json({ error: 'Sunucu hatası yaşandı. Daha fazla bilgi için logları kontrol edin.' });
  }
});

/*
==== Changing Password Endpoint
*/
app.post('/admin/change-password', async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(401).json({ error: 'Mevcut şifrenizi ya da yeni şifrenizi girmeniz gerekmektedir.' });
    }

    if (new_password.length < 6) {
      return res.status(400).json({ error: 'Yeni şifre en az 6 karakterli olmalıdır.' });
    }

    if (new_password === current_password) {
      return res.status(400).json({ error: 'Yeni şifre, eski şifreyle aynı olamaz.' });
    }

    const email = req.user.email;

    const { rows } = await pool.query(
      'SELECT id, password FROM adm_users WHERE email = $1 LIMIT 1'
      [email]
    );

    const user = rows[0];

    if (!user) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    }

    const isMatch = await arePassordsMatch(current_password, user.password);

    if (!isMatch) {
      return res.status(401).json({ error: 'Mevcut şifre yanlış.' });
    }

    const hashedPassword = hashpassword(new_password);
    await pool.query('UPDATE adm_users SET password = $1 WHERE email = $2', [
      hashedPassword,
      email,
    ]);
    const newToken = signJWT({ email, id: user.id }, { expiresIn: '7d' });
    await pool.query('UPDATE adm_users SET jwt_token = $1 WHERE email = $2', [
      newToken,
      email,
    ]);

    return res.status(200).json({
      message: 'Şifre değiştirme başarılı.',
      jwtToken: newToken
    });
  } catch (e) {
    console.error('❌ Şifre değiştirme hatası: ', e);
    return res.status(500).json({ message: 'Şifre değiştirilirken bir hata oldu. Lütfen logları kontrol edin.' });
  }
});
/*
==== Alerjen listeleme
*/
app.get('/admin/list-all-allergens', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name FROM allergens ORDER BY id ASC');

    return res.json({ allergens: rows });
  } catch (e) {
    console.error('❌ Alerjen listesi çekme sorunu: ', e);
    return res.status(500).json({ error: 'Alerjen çekilirken bir hata oldu, logları kontrol edin.' });
  }
});
// ==============================================
// 🔹 Alerjen Arama Endpoint
// ==============================================
app.get('/admin/search-allergens', async (req, res) => {
  try {
    const searchQuery = req.query.q || '';
    const likePattern = `%${searchQuery}%`;

    // 1️⃣ PostgreSQL sorgusu (ILIKE → case-insensitive arama)
    const { rows } = await pool.query(
      'SELECT id, name FROM allergens WHERE name ILIKE $1 ORDER BY id ASC',
      [likePattern]
    );

    // 2️⃣ JSON olarak döndür
    return res.json({ allergens: rows });
  } catch (err) {
    console.error('❌ Alerjen arama hatası:', err);
    return res.status(500).json({ error: 'Sunucu hatası' });
  }
});

/*
==== Alerjen Ekleme
*/
app.post('/admin/add-allergen', async (req, res) => {
  try {
    const { name, description } = req.body;
    try {
      await pool.query(
        'INSERT INTO allergens (name, description) VALUES ($1,$2)'
        [name, description]
      );
    } catch (e) {
      console.error('❌ Alerjen ekleme hatası: ', e)
    }
    return res.status(200).json({ message: 'Alerjen başarıyla eklendi.' });

  } catch (e) {
    console.error('❌ Alerjen eklenemedi: ', e);
    return res.status(500).json({ message: 'Alerjen eklenemedi, log kontrolü yapın.' });
  }
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

app.post('/admin/add-product-without-photo', async (req, res) => {

  const { name, brand, description } = req.body;
  try {
    await pool.query(
      'INSERT INTO products (name,brand,description) VALUES ($1,$2,$3)'
      [name, brand, description]
    );
    return res.status(200).json({ message: 'Yeni ürün başarıyla eklendi.' });
  } catch (e) {
    console.error('❌ Resimsiz ürün ekleme hatası: ', e);
    return res.status(500).json({ message: 'Resimsiz ürün ekleme hatası, log kontrolü sağlayın.' });
  }
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

