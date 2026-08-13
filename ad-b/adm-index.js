import express from 'express';
import multer from 'multer';
import dotenv from 'dotenv';
import path, { resolve } from 'path';
import { fileURLToPath } from 'url';
import bcyrpt from 'bcrypt';
import fs from 'fs';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'crypto';
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

app.use(helmet());

// Nginx arkasında çalışıyoruz: istemcinin uydurduğu X-Forwarded-For'a değil,
// yalnızca bir önceki proxy'nin eklediği değere güven.
app.set('trust proxy', 1);

// JSON verilerini işlemek için middleware
app.use(express.json({ limit: '1mb' }));

// Ürün fotoğrafları herkese açık (katalog görselleri).
// nosniff + attachment ile, klasöre bir şekilde HTML/SVG düşerse tarayıcıda çalıştırılamaz.
const staticImageOptions = {
    index: false,
    dotfiles: 'deny',
    setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    },
};

app.use('/product-photos', express.static(path.join(__dirname, 'product-photos'), staticImageOptions));


// ==========================================
// 🛡️ Middleware: Admin Kimlik Doğrulama
// ==========================================
async function authenticateAdmin(req, res, next) {
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

    /* 2. İmzanın geçerli olması TEK BAŞINA yeterli değil.
       Kullanıcı backend'i ile aynı anahtar çifti kullanılacak şekilde deploy edilirse,
       sıradan bir kullanıcı token'ı da geçerli imzaya sahip olur. Bu yüzden token'ın
       admin rolü taşıdığını ve hesabın adm_users'ta hâlâ var olduğunu doğruluyoruz. */
    if (user.role !== 'admin') {
      return res.status(403).json({ error: 'Bu işlem için yetkiniz yok.' });
    }

    const { rows } = await pool.query(
      'SELECT id, email FROM adm_users WHERE id = $1 AND email = $2 LIMIT 1',
      [user.id, user.email]
    );
    if (rows.length === 0) {
      return res.status(403).json({ error: 'Bu işlem için yetkiniz yok.' });
    }

    // 3. Doğrulanan kullanıcı bilgisini request nesnesine ekle.
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
    /* IP adresi: 'trust proxy' ayarlı olduğu için req.ip, istemcinin uydurabildiği
       ham X-Forwarded-For yerine yalnızca güvenilen proxy'nin eklediği değeri verir. */
    const ip = req.ip || req.socket.remoteAddress || null;
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
/* Kullanıcı bulunamadığında da bcrypt.compare çalıştırıp yanıt süresini eşitlemek için
   kullanılan sabit hash. Karşılığı olan bir şifre yok, hiçbir zaman eşleşmez. */
const DUMMY_BCRYPT_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEe.7PLXhVUAqTLNBVMPHZ5LWJcAf1kXTGa';

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

// ==========================================
// 🔒 Toplu Yetkilendirme
// ==========================================
/* /admin/v1 altındaki HER uç varsayılan olarak kimlik doğrulaması ister.
   Daha önce yetkilendirme her endpoint'e tek tek ekleniyordu ve 11 tanesinde unutulmuştu
   (içerik silme, fotoğraf silme ve kimliksiz dosya yükleme dahil). Beyaz liste yaklaşımı,
   yeni eklenen bir ucun yanlışlıkla açıkta kalmasını imkânsız kılar. */
const PUBLIC_ADMIN_PATHS = new Set(['/admin/v1/login']);

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Çok fazla giriş denemesi. Lütfen bir süre sonra tekrar deneyin.' },
});

app.use('/admin/v1', (req, res, next) => {
  const fullPath = req.baseUrl + req.path.replace(/\/$/, '');
  if (PUBLIC_ADMIN_PATHS.has(fullPath)) return next();
  return authenticateAdmin(req, res, next);
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
app.post('/admin/v1/login', adminLoginLimiter, async (req, res) => {
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

    /* Kullanıcının bulunamaması ile şifrenin yanlış olması AYNI cevabı döndürür,
       aksi halde hangi admin e-postalarının geçerli olduğu dışarıdan öğrenilebilir.
       Kullanıcı yoksa da bcrypt çalıştırılır ki yanıt süresi bilgi sızdırmasın. */
    let isMatch = false;
    if (user?.password) {
      isMatch = await arePassordsMatch(password, user.password);
    } else {
      await arePassordsMatch(password, DUMMY_BCRYPT_HASH); // timing eşitleme
    }

    if (!isMatch) {
      await logAdminAction(req, 'LOGIN_FAILED', `Başarısız giriş denemesi: ${email}`);
      return res.status(401).json({ error: 'E-posta veya şifre hatalı.' });
    }

    // Token oluştur — rol bilgisi payload'a yazılır, authenticateAdmin bunu doğrular
    const token = signJWT({ email, id: user.id, role: 'admin' }, '1d');
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
    const newToken = signJWT({ email, id: user.id, role: 'admin' }, '1d');
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

// Alerjen Tümünü Listele
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

// Alerjen Arama Yap
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

// Alerjen Yeni Ekle
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

// Alerjen Detayı Getir
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

// Alerjen Güncelleme
app.put('/admin/v1/allergens/:id/edit', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;
    await pool.query('UPDATE allergens SET name = $1, description = $2 WHERE id = $3', [name, description, id]);
    await logAdminAction(req, 'UPDATE_ALLERGEN', `Alerjen güncellendi: ${name}`);
    res.json({ message: 'Alerjen güncellendi.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// Alerjen Silme
app.delete('/admin/v1/allergens/:id/delete', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM allergens WHERE id = $1', [id]);
    await logAdminAction(req, 'DELETE_ALLERGEN', `Alerjen silindi ID: ${id}`);
    res.json({ message: 'Alerjen silindi.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});


/*
   🛍️ ÜRÜN İŞLEMLERİ (Fotoğraflı ve Fotoğrafsız)
*/

// ==========================================
// 📸 Fotoğraf Yükleme Güvenlik Yardımcıları
// ==========================================
const PRODUCT_PHOTO_DIR = path.join(__dirname, "product-photos");
const ALLOWED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

/* Ürün ID'si dosya adına giriyor. Doğrulanmazsa `..%2F..%2F` içeren bir istek
   path.join sonucunu product-photos dizininin dışına taşır; cc-ai.py gibi
   çalıştırılan bir dosyanın üzerine yazılabilirse uzaktan kod çalıştırmaya dönüşür.
   Bu yüzden ID yalnızca rakamlardan oluşacak şekilde zorlanıyor. */
function safeProductId(rawId) {
  const digits = String(rawId ?? '').replace(/[^0-9]/g, '');
  return digits.length > 0 ? digits : null;
}

// Uzantı beyaz listeden seçilir; originalname'e asla güvenilmez.
function safeImageExtension(originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  return ALLOWED_IMAGE_EXTENSIONS.includes(ext) ? ext : '.jpg';
}

/* İkinci savunma katmanı: üretilen yolun gerçekten product-photos altında
   kaldığını path.resolve ile doğrula. */
function resolveProductPhotoPath(fileName) {
  const target = path.resolve(PRODUCT_PHOTO_DIR, fileName);
  const root = path.resolve(PRODUCT_PHOTO_DIR) + path.sep;
  if (!target.startsWith(root)) {
    throw new Error(`Geçersiz dosya yolu reddedildi: ${fileName}`);
  }
  return target;
}

/* Multer, route handler çalışmadan ÖNCE dosyayı diske yazar. İstek sonradan
   reddedilirse (geçersiz ürün ID'si, eksik alan) bu dosyalar yetim kalır ve
   tekrarlanan geçersiz istekler diski doldurabilir. Her erken dönüşte çağrılır. */
function cleanupUploads(files) {
  for (const file of files || []) {
    fs.unlink(file.path, (err) => {
      if (err && err.code !== 'ENOENT') {
        console.warn('⚠️ Geçici yükleme silinemedi:', file.path, err.message);
      }
    });
  }
}

// Ürün fotoğrafını güvenli adla product-photos altına taşır, yeni dosya adını döndürür.
function storeProductPhoto(file, productId) {
  const fileName = `${productId}_${randomUUID()}${safeImageExtension(file.originalname)}`;
  fs.renameSync(file.path, resolveProductPhotoPath(fileName));
  return fileName;
}

// Multer Ayarları (Fotoğraf yükleme için)
const productStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(PRODUCT_PHOTO_DIR)) fs.mkdirSync(PRODUCT_PHOTO_DIR, { recursive: true });
    cb(null, PRODUCT_PHOTO_DIR);
  },
  filename: (req, file, cb) => {
    /* Geçici ad tamamen rastgele: req.params/req.body'den gelen hiçbir değer
       dosya adına karışmaz. Doğru ad, ürün ID'si kesinleştikten sonra verilir. */
    cb(null, `upload_${randomUUID()}${safeImageExtension(file.originalname)}`);
  },
});

const uploadProductPhotos = multer({
  storage: productStorage,
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Yalnızca görsel yüklenebilir.'));
    }
    if (!ALLOWED_IMAGE_EXTENSIONS.includes(path.extname(file.originalname).toLowerCase())) {
      return cb(new Error('Desteklenmeyen dosya uzantısı.'));
    }
    cb(null, true);
  },
  limits: { files: 10, fileSize: 10 * 1024 * 1024 }, // Maksimum 10 fotoğraf, her biri 10MB
});

app.get('/admin/v1/products/list-products', authenticateAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM products ORDER BY id DESC');

    await logAdminAction(req, 'LIST PRODUCTS', `Toplam ${rows.length} ürün listelendi.`);

    return res.status(200).json({ products: rows });
  } catch (e) {
    await logAdminAction(req, 'LIST PRODUCTS ERROR', `List Productsta hata oluştu: ${e.message}`);
    return res.status(500).json({ error: 'Ürün yüklenirken sunucu hatası oluştu.' });
  }
});


// Fotoğrafsız Ürün Ekleme
app.post('/admin/v1/products/add-without-photo', authenticateAdmin, async (req, res) => {
  const { name, brand, description } = req.body;
  try {
    await pool.query(
      'INSERT INTO products (name,brand,description,scan_count) VALUES ($1,$2,$3,$4)',
      [name, brand, description, 0]
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
// adm-index.js

app.post('/admin/v1/products/add-with-photo', authenticateAdmin, uploadProductPhotos.array("photos", 10), async (req, res) => {
  // Transaction ve devamlılık için client alıyoruz
  const client = await pool.connect();

  try {
    const { name, brand, description } = req.body;
    const photos = req.files;

    // Validasyon
    if (!name || !brand || !photos || photos.length === 0) {
      client.release(); // Hata varsa bağlantıyı hemen bırak
      cleanupUploads(photos);
      return res.status(400).json({ error: "Eksik bilgi veya fotoğraf yüklenmedi." });
    }

    // 1️⃣ Yeni ID oluştur (Max ID + 1 mantığı)
    const lastIdResult = await client.query("SELECT MAX(id) AS last_id FROM products");
    const newId = (lastIdResult.rows[0].last_id || 0) + 1;

    // 2️⃣ Ürünü veritabanına ekle (Henüz embeddingler yok)
    await client.query(
      "INSERT INTO products (id, name, brand, description, scan_count) VALUES ($1, $2, $3, $4, $5)",
      [newId, name, brand, description, 0]
    );

    // 3️⃣ Fotoğrafları doğru ID ile yeniden adlandır
    const photoPaths = [];
    for (const file of photos) {
      photoPaths.push(resolveProductPhotoPath(storeProductPhoto(file, newId)));
    }

    await logAdminAction(req, 'ADD_PRODUCT_WITH_PHOTO', `Ürün ID: ${newId} - Foto Sayısı: ${photos.length}`);

    // 🔥 KRİTİK NOKTA: Cevabı hemen gönderiyoruz!
    res.status(201).json({
      message: "✅ Ürün oluşturuldu, AI analizi arka planda devam ediyor.",
      product_id: newId,
      photo_count: photoPaths.length,
    });

    // =================================================================
    // 🚀 ARKA PLAN İŞLEMLERİ (Fire & Forget)
    // =================================================================
    (async () => {
      try {
        console.log(`🤖 [Arka Plan] AI Analizi Başladı (Ürün ID: ${newId})...`);

        // Python Çağırma Fonksiyonu
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

        // 4️⃣ Tüm fotoğrafları Python ile işle
        const embeddingResults = [];
        for (const imgPath of photoPaths) {
          try {
            const result = await runPython(imgPath);

            // Eğer barkod bulduysa veritabanına kaydet
            if (result.barcode) {
              await client.query("UPDATE products SET barcode=$1 WHERE id=$2", [result.barcode, newId]);
            }
            
            // Görsel verilerini (embedding) topla
            if(result.image_embedding) {
               embeddingResults.push(result);
            }
          } catch (err) {
             console.error(`⚠️ AI Hatası (${path.basename(imgPath)}):`, err);
             // Tek bir resim hata verirse süreci durdurmuyoruz, diğerlerine geçiyoruz.
          }
        }

        // 5️⃣ Embeddinglerin Ortalamasını Al ve Kaydet
        if (embeddingResults.length > 0) {
          const avg = (arrays) =>
            arrays[0].map((_, i) => arrays.reduce((sum, arr) => sum + arr[i], 0) / arrays.length);

          const avgEmbedding = avg(embeddingResults.map((r) => r.image_embedding));
          const avgRGB = avg(embeddingResults.map((r) => r.mean_rgb));
          const avgHist = avg(embeddingResults.map((r) => r.histogram));

          await client.query(
            `UPDATE products
             SET image_embedding=$1::vector, mean_rgb=$2, histogram=$3
             WHERE id=$4`,
            [JSON.stringify(avgEmbedding), avgRGB, avgHist, newId]
          );
          
          console.log(`✅ [Arka Plan] AI Analizi Tamamlandı (Ürün ID: ${newId})`);
        } else {
          console.log(`⚠️ [Arka Plan] Hiçbir resimden embedding üretilemedi (Ürün ID: ${newId})`);
        }

      } catch (bgError) {
        console.error("❌ Arka plan işlem hatası:", bgError);
      } finally {
        // İşimiz bitince veya hata çıkınca client'ı havuza iade ediyoruz.
        client.release();
      }
    })();

  } catch (err) {
    // Ana blokta hata olursa (Cevap gönderilmeden önce)
    console.error("❌ Ürün ekleme hatası:", err);
    
    // Eğer cevap henüz gönderilmediyse hata dön
    if (!res.headersSent) {
      client.release(); // Client'ı burada bırakıyoruz çünkü arka plana hiç giremedik
      res.status(500).json({ error: "Ürün ekleme sırasında bir hata oluştu." });
    }
  }
});

// 🔍 Tek Ürün Detayı Getir
app.get('/admin/v1/products/:id/view', authenticateAdmin, async (req, res) => {
  const productId = req.params.id;

  try {
    // Ürünü ID'ye göre bul
    const { rows } = await pool.query(
      'SELECT id, name, brand, description, barcode FROM products WHERE id = $1',
      [productId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Ürün bulunamadı.' });
    }

    await logAdminAction(req, 'GET_PRODUCT_DETAIL', `Ürün incelendi ID: ${productId}`);

    return res.status(200).json(rows[0]);
  } catch (e) {
    console.error('❌ Ürün detay hatası:', e);
    await logAdminAction(req, 'GET_PRODUCT_DETAIL_ERROR', e.message);
    return res.status(500).json({ error: 'Sunucu hatası.' });
  }
});

// ✏️ Ürün Güncelleme 
app.put('/admin/v1/products/:id/edit', authenticateAdmin, async (req, res) => {
  const productId = req.params.id;
  // Flutter'dan gelen yeni verileri alıyoruz
  const { name, brand, description, barcode } = req.body;

  try {
    // 1. Önce ürün var mı diye kontrol edelim
    const check = await pool.query('SELECT id FROM products WHERE id = $1', [productId]);

    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Düzenlenecek ürün bulunamadı.' });
    }

    // 2. Veritabanında güncelleme (UPDATE) yapalım
    // Eğer null gelirse eski veriyi koru mantığı (COALESCE) veya direkt atama yapılabilir.
    // Burada direkt atama yapıyoruz, Flutter tarafında boşsa null gönderdiğimiz için sorun olmaz.
    await pool.query(
      'UPDATE products SET name = $1, brand = $2, description = $3, barcode = $4 WHERE id = $5',
      [name, brand, description, barcode, productId]
    );

    // 3. Loglama
    await logAdminAction(req, 'UPDATE_PRODUCT', `Ürün güncellendi ID: ${productId}`);

    return res.status(200).json({ message: 'Ürün başarıyla güncellendi.' });
  } catch (e) {
    console.error('❌ Ürün güncelleme hatası:', e);
    await logAdminAction(req, 'UPDATE_PRODUCT_ERROR', e.message);
    return res.status(500).json({ error: 'Sunucu hatası.' });
  }
});

// 📸✏️ FOTOĞRAFLI Ürün Güncelleme (AI Analizi Dahil)
app.put('/admin/v1/products/:id/update-with-photo', authenticateAdmin, uploadProductPhotos.array("photos", 10), async (req, res) => {
  const productId = safeProductId(req.params.id);
  if (!productId) {
    cleanupUploads(req.files);
    return res.status(400).json({ error: 'Geçersiz ürün ID.' });
  }

  const client = await pool.connect();
  const { name, brand, description, barcode } = req.body;
  const photos = req.files;

  console.log(`📸 HIZLI YÜKLEME: ID=${productId}, Foto Sayısı=${photos ? photos.length : 0}`);

  try {
    // 1️⃣ Metin Bilgilerini Güncelle
    await client.query(
      'UPDATE products SET name = $1, brand = $2, description = $3, barcode = $4 WHERE id = $5',
      [name, brand, description, barcode || null, productId]
    );

    if (!photos || photos.length === 0) {
      client.release();
      return res.status(200).json({ message: 'Bilgiler güncellendi.' });
    }

    // 2️⃣ Fotoğrafları Klasöre Taşı (Bu işlem çok hızlıdır)
    const photoPaths = [];
    for (const file of photos) {
      photoPaths.push(resolveProductPhotoPath(storeProductPhoto(file, productId)));
    }

    // 🔥 KRİTİK NOKTA: Kullanıcıyı bekletme, hemen cevap ver!
    res.status(200).json({ 
        message: 'Fotoğraflar yüklendi, AI analizi arka planda başlatıldı.',
        uploaded_count: photoPaths.length
    });

    // 3️⃣ AI İşlemlerini ARKA PLANDA Yap (Kullanıcı cevabı aldıktan sonra burası çalışmaya devam eder)
    // client.release() yapmıyoruz çünkü aşağıda kullanacağız.
    // Ancak Express bağlantısı koptuğu için hata olursa loglara yazacağız.
    
    (async () => {
        try {
            console.log("🤖 AI Analizi arka planda başladı...");
            const runPython = (imgPath) => {
                return new Promise((resolve, reject) => {
                    execFile("python3", ["cc-ai.py", imgPath], (error, stdout, stderr) => {
                        if (error) return reject(stderr);
                        try { resolve(JSON.parse(stdout)); } catch (err) { reject(err); }
                    });
                });
            };

            const embeddingResults = [];
            for (const imgPath of photoPaths) {
                try {
                    const result = await runPython(imgPath);
                    // Eğer yeni barkod bulursa güncelle
                    if (result.barcode) {
                        await client.query("UPDATE products SET barcode=$1 WHERE id=$2 AND (barcode IS NULL OR barcode = '')", [result.barcode, productId]);
                    }
                    if (result.image_embedding) embeddingResults.push(result);
                } catch (err) {
                    console.error(`⚠️ AI Arkaplan Hatası (${path.basename(imgPath)}):`, err);
                }
            }

            // Ortalamaları hesapla ve kaydet
            if (embeddingResults.length > 0) {
                const avg = (arrays) => arrays[0].map((_, i) => arrays.reduce((sum, arr) => sum + arr[i], 0) / arrays.length);
                
                await client.query(
                    `UPDATE products SET image_embedding = $1::vector, mean_rgb = $2, histogram = $3 WHERE id = $4`,
                    [
                        JSON.stringify(avg(embeddingResults.map((r) => r.image_embedding))),
                        avg(embeddingResults.map((r) => r.mean_rgb)),
                        avg(embeddingResults.map((r) => r.histogram)),
                        productId
                    ]
                );
                console.log("✅ AI Analizi ve Veritabanı güncellemesi tamamlandı.");
            }
        } catch (backgroundError) {
            console.error("❌ Arka plan işlem hatası:", backgroundError);
        } finally {
            client.release(); // Bağlantıyı işimiz bitince bırakıyoruz
        }
    })();

  } catch (e) {
    console.error('❌ Hata:', e);
    // Eğer cevap daha önce gönderilmediyse hata dön
    if (!res.headersSent) {
        client.release();
        return res.status(500).json({ error: 'Sunucu hatası.' });
    }
  }
});



// ==================================================
// 🧬 ÜRÜN İÇERİK VE ALERJEN YÖNETİMİ
// ==================================================

// 1. Ürünün İçerik ve Alerjen Bilgilerini Getir
app.get('/admin/v1/products/:id/relations', async (req, res) => {
  const productId = req.params.id;
  try {
    
    const { rows: ingredientRows } = await pool.query(
      `SELECT i.name FROM product_ingredients pi 
       JOIN ingredients i ON pi.ingredient_id = i.id 
       WHERE pi.product_id = $1`,
      [productId]
    );
    const ingredients = ingredientRows.map(r => r.name);

    res.json({ingredients });
  } catch (e) {
    console.error('❌ İlişki getirme hatası:', e);
    res.status(500).json({ error: 'Veriler alınamadı.' });
  }
});

// 2. Ürünün İçerik ve Alerjenlerini Güncelle
app.post('/admin/v1/products/:id/relations', async (req, res) => {
  const client = await pool.connect();
  const productId = req.params.id;
  const { allergenIds, ingredients } = req.body; // ingredients: ["Su", "Şeker"] gibi array gelmeli

  try {
    await client.query('BEGIN');


    // --- B) İÇERİK (INGREDIENTS) GÜNCELLEME ---

    await client.query('DELETE FROM product_ingredients WHERE product_id = $1', [productId]);

    if (ingredients && ingredients.length > 0) {
      for (const name of ingredients) {
        const cleanName = name.trim();
        if(!cleanName) continue;

        // 1. İçerik 'ingredients' tablosunda var mı? Yoksa ekle.
        let ingRes = await client.query('SELECT id FROM ingredients WHERE name = $1', [cleanName]);
        let ingId;

        if (ingRes.rows.length === 0) {
          const insertIng = await client.query(
            'INSERT INTO ingredients (name) VALUES ($1) RETURNING id',
            [cleanName]
          );
          ingId = insertIng.rows[0].id;
        } else {
          ingId = ingRes.rows[0].id;
        }

        // 2. İlişki tablosuna ekle
        await client.query(
          'INSERT INTO product_ingredients (product_id, ingredient_id) VALUES ($1, $2)',
          [productId, ingId]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ message: 'İçerik ve Alerjenler güncellendi.' });

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ İlişki güncelleme hatası:', e);
    res.status(500).json({ error: 'Güncelleme başarısız.' });
  } finally {
    client.release();
  }
});

// ==========================================
// 📨 FEEDBACK LİSTELEME (READ)
// ==========================================
app.get('/admin/v1/feedbacks/list', authenticateAdmin, async (req, res) => {
  try {
    // JOIN SORGUSU: user_feedback ile default_users tablolarını birleştiriyoruz.
    // Not: Kullanıcı tablosunun adı 'default_users', isim kolonu 'name', soyisim 'surname' varsayıldı.
    // Eğer farklıysa (örn: 'users', 'full_name') ona göre düzeltmelisin.
    
    const query = `
      SELECT 
        f.id, 
        f.user_id, 
        f.subject, 
        f.message, 
        f.image_url, 
        f.created_at,
        u.name,  
        u.email
      FROM user_feedback f
      LEFT JOIN default_users u ON f.user_id = u.id
      ORDER BY f.created_at DESC
    `;

    const { rows } = await pool.query(query);

    await logAdminAction(req, 'LIST_FEEDBACK', `Toplam ${rows.length} bildirim listelendi.`);
    
    // Frontend'e daha temiz veri gönderelim
    const formattedRows = rows.map(row => ({
        id: row.id,
        title: row.subject,
        message: row.message,
        imageUrl: row.image_url, // DB'den gelen: /user_uploads/feedback/...
        sender: row.name ? `${row.name}` : row.email, // İsim yoksa email göster
        email: row.email,
        date: row.created_at
    }));

    return res.status(200).json({ feedbacks: formattedRows });
  } catch (e) {
    console.error('❌ Feedback listeleme hatası:', e);
    await logAdminAction(req, 'LIST_FEEDBACK_ERROR', e.message);
    return res.status(500).json({ error: 'Sunucu hatası.' });
  }
});

// ==========================================
// 🖼️ FEEDBACK GÖRSELİ (yetkili erişim)
// ==========================================
/* Kullanıcı görselleri artık statik olarak sunulmuyor. Admin bu uçtan erişir;
   /admin/v1 altında olduğu için toplu yetkilendirmeden geçer. */
app.get('/admin/v1/feedbacks/image/:filename', async (req, res) => {
  try {
    const filename = path.basename(req.params.filename); // dizin geçişini engelle
    const feedbackDir = path.resolve(__dirname, 'user_uploads', 'feedback');
    const filePath = path.resolve(feedbackDir, filename);

    if (!filePath.startsWith(feedbackDir + path.sep) || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Görsel bulunamadı.' });
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    return res.sendFile(filePath);
  } catch (e) {
    console.error('❌ Feedback görseli servis hatası:', e);
    return res.status(500).json({ error: 'Sunucu hatası.' });
  }
});

// ==========================================
// 📊 DASHBOARD İSTATİSTİKLERİ
// ==========================================
app.get('/admin/v1/dashboard/stats', authenticateAdmin, async (req, res) => {
  try {
    // 1. Toplam Ürün Sayısı
    const productCountRes = await pool.query('SELECT COUNT(*) FROM products');
    const totalProducts = parseInt(productCountRes.rows[0].count);

    // 2. Toplam Feedback Sayısı
    const feedbackCountRes = await pool.query('SELECT COUNT(*) FROM user_feedback');
    const totalFeedback = parseInt(feedbackCountRes.rows[0].count);

    // 3. Toplam Alerjen Sayısı 
    const allergenCountRes = await pool.query('SELECT COUNT(*) FROM allergens');
    const totalAllergens = parseInt(allergenCountRes.rows[0].count);

    // 4. En Çok Tarananlar
    const recentProductsRes = await pool.query(
      'SELECT name, scan_count FROM products ORDER BY scan_count DESC LIMIT 5'
    );

    const mostScanned = recentProductsRes.rows.map(p => ({
      name: p.name,
      count: p.scan_count || 0
    }));

    return res.status(200).json({
      total_products: totalProducts,
      total_feedback: totalFeedback,
      total_allergens: totalAllergens, 
      most_scanned: mostScanned
    });

  } catch (e) {
    console.error('❌ Dashboard stats hatası:', e);
    return res.status(500).json({ error: 'İstatistikler alınamadı.' });
  }
});


// ==============================================
// 🔹 Ürün İçin İçerik Listesi ve Durum Kontrolü
// ==============================================
app.get('/admin/v1/products/:id/ingredients', async (req, res) => {
  const productId = req.params.id;
  const searchQuery = req.query.q || ''; // Arama parametresi
  
  try {
    const likePattern = `%${searchQuery}%`;
    
    // SQL Açıklaması:
    // 1. Tüm ingredients tablosunu getirir (veya aramaya göre filtreler).
    // 2. product_ingredients tablosuyla LEFT JOIN yapar.
    // 3. Eğer product_ingredients'te eşleşme varsa (pi.product_id doluysa) is_selected TRUE olur.
    
    const query = `
      SELECT 
        i.id, 
        i.name, 
        CASE WHEN pi.product_id IS NOT NULL THEN true ELSE false END as is_selected
      FROM ingredients i
      LEFT JOIN product_ingredients pi 
        ON i.id = pi.ingredient_id AND pi.product_id = $1
      WHERE i.name ILIKE $2
      ORDER BY is_selected DESC, i.name ASC; 
    `;
    // Not: is_selected DESC ile seçili olanları en üste getiriyoruz.

    const { rows } = await pool.query(query, [productId, likePattern]);

    return res.json({ ingredients: rows });

  } catch (e) {
    console.error('❌ Ürün içerikleri listelenirken hata:', e);
    return res.status(500).json({ error: 'Sunucu hatası: İçerikler çekilemedi.' });
  }
});

// ==============================================
// 🔹 Yeni İçerik (Ingredient) Oluşturma
// ==============================================
app.post('/admin/v1/ingredients/add', async (req, res) => {
  // 1️⃣ İLK KONTROL: Fonksiyona giriyor mu?
  console.log('📥 [İSTEK GELDİ] URL: /admin/v1/ingredients/add');
  console.log('📦 Gelen Body:', req.body);

  const { name, description } = req.body;

  if (!name) {
    console.log('⚠️ Hata: İsim boş geldi.');
    return res.status(400).json({ error: 'İçerik adı zorunludur.' });
  }

  try {
    // Duplicate kontrolü
    const checkQuery = 'SELECT id FROM ingredients WHERE name ILIKE $1';
    const checkResult = await pool.query(checkQuery, [name]);

    if (checkResult.rows.length > 0) {
      console.log('⚠️ Hata: Bu içerik zaten var.');
      return res.status(409).json({ 
        error: 'Bu içerik zaten mevcut.', 
        existingId: checkResult.rows[0].id 
      });
    }

    // Ekleme işlemi
    // DİKKAT: Veritabanında 'description' sütunu var mı? Yoksa hata verir.
    const insertQuery = 'INSERT INTO ingredients (name, description) VALUES ($1, $2) RETURNING id, name';
    const { rows } = await pool.query(insertQuery, [name, description || null]);

    console.log('✅ BAŞARILI: Yeni içerik eklendi, ID:', rows[0].id);

    return res.status(201).json({ 
      message: 'Yeni içerik eklendi.', 
      ingredient: rows[0] 
    });

  } catch (e) {
    console.error('❌ KRİTİK HATA:', e);
    return res.status(500).json({ error: 'Sunucu hatası: İçerik eklenemedi.' });
  }
});

// ==============================================
// 🔹 Ürün İçeriklerini Güncelleme (Many-to-Many)
// ==============================================
app.post('/admin/v1/products/:id/update-ingredients', async (req, res) => {
  const productId = req.params.id;
  const { selected_ingredient_ids } = req.body; // Array of IDs [1, 5, 20]

  if (!Array.isArray(selected_ingredient_ids)) {
    return res.status(400).json({ error: 'Liste formatı geçersiz.' });
  }

  const client = await pool.connect(); // Transaction için client alıyoruz

  try {
    await client.query('BEGIN'); // Transaction Başlat

    // 1. Mevcut bağlı içerikleri çek
    const { rows: existingRows } = await client.query(
      'SELECT ingredient_id FROM product_ingredients WHERE product_id = $1',
      [productId]
    );
    const currentIds = existingRows.map(r => r.ingredient_id);

    // 2. Eklenecek ve Silinecekleri Hesapla
    // Yeni listede olup eskide olmayanlar -> Eklenecek
    const toAdd = selected_ingredient_ids.filter(id => !currentIds.includes(id));
    
    // Eskide olup yeni listede olmayanlar -> Silinecek
    const toDelete = currentIds.filter(id => !selected_ingredient_ids.includes(id));

    // 3. Ekleme İşlemi
    for (const id of toAdd) {
      await client.query(
        'INSERT INTO product_ingredients (product_id, ingredient_id) VALUES ($1, $2)',
        [productId, id]
      );
    }

    // 4. Silme İşlemi
    for (const id of toDelete) {
      await client.query(
        'DELETE FROM product_ingredients WHERE product_id = $1 AND ingredient_id = $2',
        [productId, id]
      );
    }

    await client.query('COMMIT'); // İşlemi onayla
    
    return res.json({ 
      success: true, 
      message: 'İçerikler güncellendi.',
      addedCount: toAdd.length,
      deletedCount: toDelete.length
    });

  } catch (e) {
    await client.query('ROLLBACK'); // Hata varsa geri al
    console.error('❌ İçerik güncelleme hatası:', e);
    return res.status(500).json({ error: 'Sunucu hatası: Güncelleme yapılamadı.' });
  } finally {
    client.release();
  }
});


app.get('/admin/v1/ingredients/search', async (req, res) => {
  try {
    // 1. URL'den sorguyu al (Örn: ?q=şeker)
    const searchQuery = req.query.q || ''; 
    
    // 2. PostgreSQL için arama deseni oluştur (%şeker%)
    const likePattern = `%${searchQuery}%`;

    // 3. Veritabanı sorgusu
    // ILIKE: Büyük/küçük harf duyarsız arama yapar (Şeker = şeker)
    // ORDER BY name ASC: Alfabetik sıralar
    // LIMIT 50: Listeyi çok şişirmemek için en fazla 50 sonuç döndürür
    const { rows } = await pool.query(
      'SELECT id, name FROM ingredients WHERE name ILIKE $1 ORDER BY name ASC LIMIT 50',
      [likePattern]
    );

    // 4. Sonucu Flutter'a gönder
    return res.status(200).json({ ingredients: rows });

  } catch (e) {
    console.error('❌ İçerik arama hatası:', e);
    return res.status(500).json({ error: 'Sunucu hatası: İçerik aranamadı.' });
  }
});

/*
==============================================
✏️ İÇERİK GÜNCELLEME (RENAME)
==============================================
*/
app.put('/admin/v1/ingredients/:id/edit', async (req, res) => {
  const id = req.params.id;
  const { name, description } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'İçerik ismi boş olamaz.' });
  }

  try {
    const updateQuery = `
      UPDATE ingredients 
      SET name = $1, description = $2 
      WHERE id = $3 
      RETURNING *
    `;
    const { rows } = await pool.query(updateQuery, [name, description || null, id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'İçerik bulunamadı.' });
    }

    return res.json({ message: 'İçerik güncellendi.', ingredient: rows[0] });

  } catch (e) {
    console.error('❌ İçerik güncelleme hatası:', e);
    // Eğer isim çakışması olursa (Unique constraint)
    if (e.code === '23505') {
        return res.status(409).json({ error: 'Bu isimde başka bir içerik zaten var.' });
    }
    return res.status(500).json({ error: 'Sunucu hatası.' });
  }
});

/*
==============================================
🗑️ İÇERİK SİLME
==============================================
*/
app.delete('/admin/v1/ingredients/:id/delete', async (req, res) => {
  const id = req.params.id;

  try {
    // Not: Eğer veritabanında "ON DELETE CASCADE" ayarlı değilse ve 
    // bu içerik bir üründe kullanılıyorsa hata verebilir.
    // Şimdilik doğrudan silmeyi deniyoruz.
    
    const deleteQuery = 'DELETE FROM ingredients WHERE id = $1 RETURNING id';
    const { rows } = await pool.query(deleteQuery, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'İçerik bulunamadı veya zaten silinmiş.' });
    }

    return res.json({ message: 'İçerik silindi.', id: id });

  } catch (e) {
    console.error('❌ İçerik silme hatası:', e);
    // Foreign key hatası (başka tabloda kullanılıyor) kodu genellikle '23503'tür
    if (e.code === '23503') {
        return res.status(400).json({ error: 'Bu içerik bazı ürünlerde kullanılıyor, önce oradan kaldırmalısınız.' });
    }
    return res.status(500).json({ error: 'Sunucu hatası.' });
  }
});

/*
==============================================
📸 FOTOĞRAF YÖNETİMİ (GALERİ)
==============================================
*/

// 1. Ürüne ait fotoğrafları listele
app.get('/admin/v1/products/:id/photos', (req, res) => {
  const productId = safeProductId(req.params.id);
  if (!productId) {
    return res.status(400).json({ error: 'Geçersiz ürün ID.' });
  }
  const dir = PRODUCT_PHOTO_DIR;

  fs.readdir(dir, (err, files) => {
    if (err) {
      return res.status(500).json({ error: 'Klasör okunamadı.' });
    }

    // Dosya isimleri "{productId}_..." ile başlayanları filtrele
    const productPhotos = files.filter(file => file.startsWith(`${productId}_`));
    
    // Tam URL'leri oluştur (Backend sunucu adresine göre)
    // Örn: /product-photos/1_2342.jpg
    const photoUrls = productPhotos.map(file => `/product-photos/${file}`);

    res.json({ photos: photoUrls });
  });
});

// 2. Tekil Fotoğraf Silme
app.delete('/admin/v1/products/photos/delete', (req, res) => {
  const { photoName } = req.body; // Örn: "1_5932.jpg" (URL değil, dosya adı)

  if (!photoName) return res.status(400).json({ error: 'Dosya adı gerekli.' });

  // Güvenlik: Sadece dosya adı olduğundan emin ol (dizin geçişi engelleme),
  // ardından çözülen yolun product-photos altında kaldığını doğrula.
  let filePath;
  try {
    filePath = resolveProductPhotoPath(path.basename(photoName));
  } catch (e) {
    console.warn('⚠️', e.message);
    return res.status(400).json({ error: 'Geçersiz dosya adı.' });
  }

  if (fs.existsSync(filePath)) {
    fs.unlink(filePath, async (err) => {
      if (err) return res.status(500).json({ error: 'Silme hatası.' });
      await logAdminAction(req, 'DELETE_PRODUCT_PHOTO', `Silinen: ${path.basename(photoName)}`);
      res.json({ success: true, message: 'Fotoğraf silindi.' });
    });
  } else {
    res.status(404).json({ error: 'Dosya bulunamadı.' });
  }
});

// 3. Mevcut Ürüne Yeni Fotoğraf Ekleme
app.post("/admin/v1/products/:id/add-photo", uploadProductPhotos.array("photos", 5), async (req, res) => {
    const productId = safeProductId(req.params.id);
    if (!productId) {
        cleanupUploads(req.files);
        return res.status(400).json({ error: "Geçersiz ürün ID." });
    }

    const photos = req.files;
    if (!photos || photos.length === 0) {
        return res.status(400).json({ error: "Fotoğraf yüklenmedi." });
    }

    // Dosyaları güvenli adla isimlendir
    for (const file of photos) {
        storeProductPhoto(file, productId);
    }

    await logAdminAction(req, 'ADD_PRODUCT_PHOTO', `Ürün ID: ${productId} - ${photos.length} foto`);

    // Not: Burada Python scripti (embedding) tekrar çalıştırılabilir ama
    // şimdilik sadece galeriye ekliyoruz.
    res.json({ success: true, message: `${photos.length} fotoğraf eklendi.` });
});


// ==========================================
// 🗑️ ÜRÜN SİLME (DELETE)
// ==========================================
app.delete('/admin/v1/products/:id/delete', authenticateAdmin, async (req, res) => {
  const productId = req.params.id;

  try {
    // 1. Ürün var mı kontrol et
    const check = await pool.query('SELECT id FROM products WHERE id = $1', [productId]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Silinecek ürün bulunamadı.' });
    }

    // 2. Ürünü sil
    await pool.query('DELETE FROM products WHERE id = $1', [productId]);

    // 3. Logla
    await logAdminAction(req, 'DELETE_PRODUCT', `Ürün silindi ID: ${productId}`);

    return res.status(200).json({ message: 'Ürün başarıyla silindi.' });
  } catch (e) {
    console.error('❌ Ürün silme hatası:', e);
    await logAdminAction(req, 'DELETE_PRODUCT_ERROR', e.message);
    return res.status(500).json({ error: 'Sunucu hatası.' });
  }
});


// ==========================================
// 🧯 Merkezi Hata Yakalayıcı
// ==========================================
/* Multer'ın reddettiği dosyalar (uzantı/boyut) ve yakalanmamış hatalar buraya düşer.
   İstemciye asla stack trace veya DB detayı gönderilmez. */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError || err?.message?.includes('yüklenebilir') || err?.message?.includes('uzantı')) {
    console.warn('⚠️ Yükleme reddedildi:', err.message);
    return res.status(400).json({ error: 'Dosya yüklenemedi. Yalnızca 10MB altındaki JPG/PNG/WEBP görseller kabul edilir.' });
  }
  console.error('❌ Beklenmeyen hata:', err);
  return res.status(500).json({ error: 'Sunucu hatası' });
});

// Sunucuyu Dinle
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Admin Backend ${PORT} portunda ve 0.0.0.0 adresinde dinleniyor.`);
});