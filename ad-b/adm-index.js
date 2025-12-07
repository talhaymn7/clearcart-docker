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

// PostgreSQL Pool yapısını parçala
const { Pool } = pkg;

// .env dosyasındaki değişkenleri yükle
dotenv.config();

// ES Module içinde __dirname tanımlaması
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Express uygulamasını başlat
const app = express();
const PORT = process.env.PORT;

// 📁 Fotoğraf Yükleme Klasör Kontrolü
const productPhotoUploadsDir = path.join(__dirname, 'product-photos');
if (!fs.existsSync(productPhotoUploadsDir)) {
  fs.mkdirSync(productPhotoUploadsDir, { recursive: true });
  console.log('📁 product-photos klasörü yoktu, oluşturuldu.');
}

// JSON verilerini işlemek için middleware
app.use(express.json());

// ==========================================
// 🛡️ Middleware: Admin Kimlik Doğrulama
// ==========================================
function authenticateAdmin(req, res, next) {
  /* Nginx tarafında 'Authorization' başlığı Basic Auth için kullanıldığından,
     JWT token'ı taşımak için özel 'x-auth-token' başlığını kullanıyoruz.
  */
  const token = req.headers['x-auth-token'];

  if (!token) {
    return res.status(401).json({ error: 'Erişim reddedildi. Token eksik.' });
  }

  try {
    // 1. Token'ı doğrula (security.js)
    const user = verifyJWT(token);

    // 2. Doğrulanan kullanıcı bilgisini request nesnesine ekle.
    // Artık sonraki aşamalarda req.user.email diyerek erişebiliriz.
    req.user = user;

    next(); // Bir sonraki fonksiyona geç
  } catch (err) {
    return res.status(403).json({ error: 'Geçersiz Token.' });
  }
}

// ==========================================
// 🗄️ Veritabanı Bağlantısı
// ==========================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// ==========================================
// 📝 Akıllı Loglama Fonksiyonu (Audit Log)
// ==========================================
/*
   Bu fonksiyon, admin panelindeki kritik işlemleri veritabanına kaydeder.
   Email adresini şu öncelik sırasına göre otomatik bulur:
   1. req.user.email (Giriş yapmış kullanıcı)
   2. req.body.email (Login denemesi yapan kullanıcı)
   3. 'Unknown User' (Tespit edilemezse)
*/
async function logAdminAction(req, actionType, details) {
  try {
    // IP adresini al (Proxy arkasındaysa x-forwarded-for, yoksa remoteAddress)
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    const endpoint = req.originalUrl || req.url;

    // Email bulma mantığı
    const email = req.user?.email || req.body?.email || 'Unknown User';

    // Veritabanına log kaydını ekle
    await pool.query(
      'INSERT INTO admin_audit_logs (admin_email, action_type, endpoint, details, ip_address) VALUES ($1, $2, $3, $4, $5)',
      [email, actionType, endpoint, details, ip]
    );

    // Konsola da bilgi bas
    console.log(`📝 LOG: [${actionType}] ${email} - ${endpoint}`);
  } catch (e) {
    // Loglama hatası ana akışı bozmamalı, sadece konsola yazdırıyoruz.
    console.error('❌ Loglama hatası:', e.message);
  }
}

/*
   🔑 Şifreleme Yardımcı Fonksiyonları
*/
async function hashpassword(password) {
  const saltRount = 12;
  const hashed = await bcyrpt.hash(password, saltRount);
  return hashed;
}
async function arePassordsMatch(enteredPassword, dbPassword) {
  return await bcyrpt.compare(enteredPassword, dbPassword);
}

// ==================================================================
// 🚀 ENDPOINTS (Hepsi /admin/v1/ ile başlar)
// ==================================================================


app.use((req, res, next) => {
  console.log(`📡 GELEN İSTEK: ${req.method} ${req.url}`);
  next();
});



// 1️⃣ Bağlantı Kontrolü
app.get('/admin/v1/ad-connection', authenticateAdmin, (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'ClearCart Admin Backend is working!'
  });
});

// 2️⃣ Public Key Paylaşımı (Frontend şifreleme için)
app.get('/admin/v1/auth/public-key', authenticateAdmin, (_req, res) => {
  res.type('text/plain').send(SERVER_PUBLIC_KEY);
});

// 3️⃣ Statik Dosya Sunumu (Fotoğraflar için)
// Not: Statik dosyalar genelde versiyonlanmaz ama tutarlılık için ekledik.
app.use('/admin/v1/product-photos', express.static(path.join(__dirname, 'product-photos')));


/*
   👤 GİRİŞ İŞLEMLERİ (Login)
*/
app.post('/admin/v1/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validasyon
    if (!email || !password) {
      return res.status(400).json({ error: 'E-posta ya da şifre girilmedi.' })
    }

    // Kullanıcıyı veritabanında ara
    const { rows } = await pool.query(
      'SELECT * FROM adm_users WHERE email = $1 LIMIT 1',
      [email]
    );
    const user = rows[0];

    // Kullanıcı yoksa
    if (!user) {
      await logAdminAction(req, 'LOGIN_FAILED', 'Kullanıcı bulunamadı: ' + email);
      return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    }

    // Şifre kontrolü
    const isMatch = await arePassordsMatch(password, user.password);
    if (!isMatch) {
      await logAdminAction(req, 'LOGIN_FAILED', 'Yanlış şifre denemesi.');
      return res.status(401).json({ error: 'Şifre yanlış.' });
    }

    // Token oluştur
    const token = signJWT({ email, id: user.id }, '1d');
    const isJWTtrue = verifyJWT(token);

    if (isJWTtrue) {
      // Token'ı DB'ye kaydet (Oturum yönetimi için)
      await pool.query(
        'UPDATE adm_users SET jwt_token = $1 WHERE id = $2',
        [token, user.id]
      );

      await logAdminAction(req, 'LOGIN_SUCCESS', 'Başarılı giriş yapıldı.');

      return res.status(200).json({
        message: 'Giriş Başarılı',
        jwt: token,
      });
    }
  }
  catch (e) {
    console.error('❌ Login Hatası:', e);
    await logAdminAction(req, 'LOGIN_ERROR', `Sistem hatası: ${e.message}`);
    return res.status(500).json({ error: 'Sunucu hatası yaşandı.' });
  }
});

/*
   🔐 ŞİFRE DEĞİŞTİRME
*/
app.post('/admin/v1/change-password', authenticateAdmin, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    const email = req.user.email; // Token'dan gelen email

    // Validasyonlar
    if (!current_password || !new_password) {
      return res.status(401).json({ error: 'Eksik bilgi.' });
    }
    if (new_password.length < 6) {
      return res.status(400).json({ error: 'Yeni şifre en az 6 karakterli olmalıdır.' });
    }
    if (new_password === current_password) {
      return res.status(400).json({ error: 'Yeni şifre eskisiyle aynı olamaz.' });
    }

    // Kullanıcıyı bul
    const { rows } = await pool.query(
      'SELECT id, password FROM adm_users WHERE email = $1 LIMIT 1',
      [email]
    );
    const user = rows[0];

    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });

    // Mevcut şifreyi doğrula
    const isMatch = await arePassordsMatch(current_password, user.password);
    if (!isMatch) return res.status(401).json({ error: 'Mevcut şifre yanlış.' });

    // Yeni şifreyi hashle ve kaydet
    const hashedPassword = await hashpassword(new_password);
    await pool.query('UPDATE adm_users SET password = $1 WHERE email = $2', [hashedPassword, email]);

    // Güvenlik için token'ı yenile
    const newToken = signJWT({ email, id: user.id }, '7d');
    await pool.query('UPDATE adm_users SET jwt_token = $1 WHERE email = $2', [newToken, email]);

    await logAdminAction(req, 'RESET_PASSWORD', 'Şifre değiştirildi.');

    return res.status(200).json({
      message: 'Şifre değiştirme başarılı.',
      jwtToken: newToken
    });
  } catch (e) {
    console.error('❌ Şifre değiştirme hatası: ', e);
    await logAdminAction(req, 'RESET_PASSWORD_ERROR', `Hata: ${e.message}`);
    return res.status(500).json({ message: 'Sunucu hatası.' });
  }
});

/*
   🌾 ALERJEN İŞLEMLERİ (Listeleme, Arama, Ekleme, Detay)
*/

// Tümünü Listele
app.get('/admin/v1/allergens/list-all-allergens', authenticateAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name FROM allergens ORDER BY id ASC');

    await logAdminAction(req, 'LIST_ALLERGENS', 'Tüm alerjenler listelendi.');
    return res.json({ allergens: rows });
  } catch (e) {
    console.error('❌ Alerjen listesi hatası: ', e);
    await logAdminAction(req, 'LIST_ALLERGEN_ERROR', e.message);
    return res.status(500).json({ error: 'Sunucu hatası.' });
  }
});

// Arama Yap
app.get('/admin/v1/allergens/search-allergens', authenticateAdmin, async (req, res) => {
  try {
    const searchQuery = req.query.q || '';
    const likePattern = `%${searchQuery}%`; // ILIKE için pattern

    const { rows } = await pool.query(
      'SELECT id, name FROM allergens WHERE name ILIKE $1 ORDER BY id ASC',
      [likePattern]
    );

    await logAdminAction(req, 'SEARCH_ALLERGEN', `Aranan: ${searchQuery}`);
    return res.json({ allergens: rows });
  } catch (err) {
    console.error('❌ Alerjen arama hatası:', err);
    await logAdminAction(req, 'SEARCH_ALLERGEN_ERROR', err.message);
    return res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// Yeni Ekle
app.post('/admin/v1/allergens/add-allergen', authenticateAdmin, async (req, res) => {
  try {
    const { name, description } = req.body;

    await pool.query(
      'INSERT INTO allergens (name, description) VALUES ($1,$2)',
      [name, description]
    );

    await logAdminAction(req, 'ADD_ALLERGEN', `Eklenen: ${name}`);
    return res.status(200).json({ message: 'Alerjen başarıyla eklendi.' });

  } catch (e) {
    console.error('❌ Alerjen eklenemedi: ', e);
    await logAdminAction(req, 'ADD_ALLERGEN_ERROR', e.message);
    return res.status(500).json({ message: 'Alerjen eklenemedi.' });
  }
});

// Detay Getir
app.get('/admin/v1/allergens/:id/full-info', authenticateAdmin, async (req, res) => {
  const allergenId = req.params.id;
  try {
    const allergenIdQuery = 'SELECT a.name, a.description FROM allergens a WHERE a.id = $1';
    const { rows: allergenRows } = await pool.query(allergenIdQuery, [allergenId]);

    if (allergenRows.length === 0) {
      return res.status(400).json({ error: 'Alerjen bulunamadı.' });
    }

    await logAdminAction(req, 'ALLERGEN_DETAILS', `Detay görüntülendi ID: ${allergenId}`);

    return res.status(200).json({
      id: allergenId,
      name: allergenRows[0].name,
      description: allergenRows[0].description,
    })

  } catch (e) {
    await logAdminAction(req, 'ALLERGEN_DETAILS_ERROR', e.message);
    console.error('❌ Alerjen detay hatası:', e);
    return res.status(500).json({ error: 'Sunucu hatası' });
  }
});

/*
   🛍️ ÜRÜN İŞLEMLERİ (Fotoğraflı ve Fotoğrafsız)
*/

// Multer Ayarları (Fotoğraf yükleme için)
const productStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "product-photos");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // ID henüz belli olmayabilir, geçici isim verip sonra düzelteceğiz
    const productId = req.body.product_id || req.params.id || "temp";
    const ext = path.extname(file.originalname);
    const randomSuffix = Math.floor(Math.random() * 10000);
    cb(null, `${productId}_${randomSuffix}${ext}`);
  },
});

const uploadProductPhotos = multer({
  storage: productStorage,
  limits: { files: 10 }, // Maksimum 10 fotoğraf
});

app.get('/admin/v1/products/list-products', authenticateAdmin, async (req,res) => {
  try{
    const {rows} = await pool.query(
      'SELECT * FROM products ORDER BY id DESC');

      await logAdminAction(req,'LIST PRODUCTS',`Toplam ${rows.length} ürün listelendi.`);

      return res.status(200).json({ products: rows});
  } catch(e) {
      await logAdminAction(req, 'LIST PRODUCTS ERROR', `List Productsta hata oluştu: ${e.message}`);
      return res.status(500).json({error: 'Ürün yüklenirken sunucu hatası oluştu.'});
  }
});


// Fotoğrafsız Ürün Ekleme
app.post('/admin/v1/products/add-without-photo', authenticateAdmin, async (req, res) => {
  const { name, brand, description } = req.body;
  try {
    await pool.query(
      'INSERT INTO products (name,brand,description) VALUES ($1,$2,$3)',
      [name, brand, description]
    );

    await logAdminAction(req, 'ADD_PRODUCT_NO_PHOTO', `Ürün: ${name}`);

    return res.status(200).json({ message: 'Yeni ürün başarıyla eklendi.' });
  } catch (e) {
    await logAdminAction(req, 'ADD_PRODUCT_NO_PHOTO_ERROR', e.message);
    console.error('❌ Resimsiz ürün ekleme hatası: ', e);
    return res.status(500).json({ message: 'Hata oluştu.' });
  }
});

// Fotoğraflı Ürün Ekleme ve AI İşleme (Embedding)
app.post('/admin/v1/products/add-with-photo', authenticateAdmin, uploadProductPhotos.array("photos", 10), async (req, res) => {
  // Transaction (işlem bütünlüğü) için client alıyoruz
  const client = await pool.connect();

  try {
    const { name, brand, description } = req.body;
    const photos = req.files;

    if (!name || !brand || photos.length === 0) {
      return res.status(400).json({ error: "Eksik bilgi veya fotoğraf yüklenmedi." });
    }

    // 1️⃣ Yeni ID oluştur (Max ID + 1 mantığı)
    const lastIdResult = await client.query("SELECT MAX(id) AS last_id FROM products");
    const newId = (lastIdResult.rows[0].last_id || 0) + 1;

    // 2️⃣ Ürünü veritabanına ekle
    await client.query(
      "INSERT INTO products (id, name, brand, description) VALUES ($1, $2, $3, $4)",
      [newId, name, brand, description]
    );

    // 3️⃣ Fotoğrafları doğru ID ile yeniden adlandır
    const photoPaths = [];
    for (const file of photos) {
      const ext = path.extname(file.originalname);
      const randomSuffix = Math.floor(Math.random() * 10000);
      const newFileName = `${newId}_${randomSuffix}${ext}`;
      const newPath = path.join(__dirname, "product-photos", newFileName);

      // Dosya ismini değiştir
      fs.renameSync(file.path, newPath);
      photoPaths.push(newPath);
    }

    // 4️⃣ Python Scriptini Çağırma (Embedding için)
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

    // 5️⃣ Tüm fotoğrafları Python ile işle
    const embeddingResults = [];
    for (const imgPath of photoPaths) {
      const result = await runPython(imgPath);

      // Eğer barkod bulduysa veritabanına kaydet
      if (result.barcode) {
        await client.query("UPDATE products SET barcode=$1 WHERE id=$2", [result.barcode, newId]);
      } else {
        // Barkod yoksa görsel verilerini (embedding) topla
        embeddingResults.push(result);
      }
    }

    // 6️⃣ Embeddinglerin Ortalamasını Al ve Kaydet
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

    await logAdminAction(req, 'ADD_PRODUCT_WITH_PHOTO', `Ürün ID: ${newId} - Foto Sayısı: ${photos.length}`);

    res.json({
      message: "✅ Ürün başarıyla eklendi ve embedding işlendi.",
      product_id: newId,
      photo_count: photoPaths.length,
    });

  } catch (err) {
    await logAdminAction(req, 'ADD_PRODUCT_WITH_PHOTO_ERROR', err.message);
    console.error("❌ Hata:", err);
    res.status(500).json({ error: "Ürün ekleme sırasında bir hata oluştu." });
  } finally {
    // Bağlantıyı havuza geri bırak
    client.release();
  }
});

// Sunucuyu Dinle
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Admin Backend ${PORT} portunda ve 0.0.0.0 adresinde dinleniyor.`);
});