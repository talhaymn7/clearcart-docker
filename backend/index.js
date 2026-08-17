import express from 'express';
import { OAuth2Client } from 'google-auth-library';
import multer from 'multer';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import fs from 'fs';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import upload, { ALLOWED_IMAGE_EXTENSIONS, safeImageExtension } from './middlewares/imageUploadMiddleware.js';
import { execFile } from 'child_process';
import pkg from 'pg';
import { generateKeyPairSync, randomUUID } from 'crypto';
import { SERVER_PUBLIC_KEY, signJWT, verifyJWT } from './security.js';

const { Pool } = pkg;

// .env dosyasını yükle
dotenv.config();

// __dirname ve __filename tanımı (ESM için özel olarak böyle yapılır)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Express app ve ayarlar
const app = express();
const PORT = process.env.PORT;

// 📁 user_uploads klasörü yoksa oluştur
const uploadsDir = path.join(__dirname, 'user_uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log('📁 user_uploads klasörü oluşturuldu.');
}
app.use(helmet());
app.use(express.json({ limit: '100kb' })); // JSON body parse

// 🚦 Brute-force koruması: kimlik doğrulama uçları için sıkı, genel trafik için gevşek limit
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Çok fazla deneme yapıldı. Lütfen bir süre sonra tekrar deneyin.' },
});
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(generalLimiter);

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID); // Google Console'dan aldığın CLIENT_ID

app.get('/auth/public-key', (_req, res) => {
  res.type('text/plain').send(SERVER_PUBLIC_KEY);
});

// ⚠️ user_uploads ARTIK statik olarak sunulmuyor.
// Kullanıcı görselleri kimlik doğrulamalı /user_uploads/feedback/:file ucundan,
// yalnızca dosyanın sahibine servis edilir (aşağıya bak).

// Database Bağlantısı
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

/* Kullanıcı bulunamadığında da bcrypt.compare çalıştırıp yanıt süresini eşitlemek için
   kullanılan sabit hash. Karşılığı olan bir şifre yok, hiçbir zaman eşleşmez. */
const DUMMY_BCRYPT_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEe.7PLXhVUAqTLNBVMPHZ5LWJcAf1kXTGa';

//      Password Hashing Kodu:
async function hashPassword(password) {
  const saltRound = 12;
  const hashed = await bcrypt.hash(password, saltRound);
  return hashed;
}
async function arePasswordMatch(enteredPassword, dbPassword) {
  return await bcrypt.compare(enteredPassword, dbPassword);
}

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Clear Cart API is running!'
  });
});
// 📸 Multer ayarları (feedback görselleri için)
const feedbackStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const feedbackDir = path.join(__dirname, 'user_uploads', 'feedback');
    if (!fs.existsSync(feedbackDir)) {
      fs.mkdirSync(feedbackDir, { recursive: true });
    }
    cb(null, feedbackDir);
  },
  filename: (req, file, cb) => {
    // Uzantı beyaz listeden seçilir; originalname'e asla güvenilmez.
    cb(null, `feedback_${randomUUID()}${safeImageExtension(file.originalname)}`);
  },
});

// Sadece izin verilen uzantıdaki görsellere izin ver.
// Not: mimetype tamamen istemci kontrolünde olduğu için tek başına yeterli değil,
// bu yüzden uzantı da beyaz listeye karşı doğrulanıyor.
const feedbackUpload = multer({
  storage: feedbackStorage,
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Yalnızca görsel yüklenebilir.'));
    }
    if (!ALLOWED_IMAGE_EXTENSIONS.includes(path.extname(file.originalname).toLowerCase())) {
      return cb(new Error('Desteklenmeyen dosya uzantısı.'));
    }
    cb(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }, // max 5MB
});


// ===========================
// 🔹 Kullanıcı Kayıt Endpoint
// ===========================
app.post('/register', authLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // 0️⃣ Girdi doğrulama
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Ad, e-posta ve şifre zorunludur.' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Şifre en az 8 karakter olmalıdır.' });
    }
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Geçerli bir e-posta adresi giriniz.' });
    }

    // 1️⃣ E-posta kontrolü
    const { rows: existing } = await pool.query(
      'SELECT id FROM default_users WHERE email = $1 LIMIT 1',
      [email]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Bu e-posta adresi zaten kayıtlı.' });
    }

    // 2️⃣ Şifre hashle
    const hashedPassword = await hashPassword(password);

    // 3️⃣ Kullanıcıyı DB’ye ekle (jwt_token ve public_key NULL)
    const insertQuery = `
      INSERT INTO default_users 
      (name, email, password, isemailapproved, subscription_type, jwt_token, public_key, date_of_birth, gender)
      VALUES ($1, $2, $3, false, 1, NULL, NULL, NULL, NULL)
      RETURNING id;
    `;
    const { rows: inserted } = await pool.query(insertQuery, [name, email, hashedPassword]);
    const userId = inserted[0]?.id;

    // 4️⃣ Kullanıcıya özel RSA key çifti üret
    const keyDir = process.env.CLIENT_KEYS_DIR || path.join(__dirname, 'client_keys');
    if (!fs.existsSync(keyDir)) fs.mkdirSync(keyDir, { recursive: true });

    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    // Public key’i DB’ye yaz
    await pool.query('UPDATE default_users SET public_key = $1 WHERE id = $2', [publicKey, userId]);

    // Private key’i volume’a kaydet (ör: /run/secrets/client_keys/5_private.pem)
    const privateKeyPath = path.join(keyDir, `${userId}_private.pem`);
    fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });

    console.log(`🔐 RSA anahtar çifti oluşturuldu: user=${userId}`);

    // 5️⃣ Kullanıcı JWT oluştur
    const token = signJWT({ email, id: userId }, '7d' );

    // 6️⃣ Token’ı DB’ye yaz
    await pool.query('UPDATE default_users SET jwt_token = $1 WHERE id = $2', [token, userId]);

    console.log(`🟢 Yeni kullanıcı: ${email} (id=${userId})`);

    return res.status(201).json({
      message: '✅ Kayıt Başarılı!',
      jwt: token,
      id: userId
    });
  } catch (e) {
    console.error('❌ Register Hatası:', e);
    return res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ===========================
// 🔹 Kullanıcı Giriş Endpoint
// ===========================
app.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    // 1️⃣ Basit kontroller
    if (!email || !password) {
      return res.status(400).json({ error: 'E-posta ve şifre zorunludur.' });
    }

    // 2️⃣ Kullanıcıyı bul (PostgreSQL sorgusu)
    const { rows } = await pool.query(
      'SELECT * FROM default_users WHERE email = $1 LIMIT 1',
      [email]
    );
    const user = rows[0];

    /* 3️⃣ Kimlik doğrulama.
       Kullanıcının var olup olmadığı, Google hesabı olup olmadığı ve şifrenin yanlış olması
       AYNI cevabı döndürür — aksi halde hangi e-postaların kayıtlı olduğu dışarıdan öğrenilebilir.
       Kullanıcı yoksa da bcrypt.compare çalıştırılır ki yanıt süresi bilgi sızdırmasın. */
    let isMatch = false;
    if (user?.password) {
      isMatch = await arePasswordMatch(password, user.password);
    } else {
      await arePasswordMatch(password, DUMMY_BCRYPT_HASH); // timing eşitleme
    }

    if (!isMatch) {
      return res.status(401).json({ error: 'E-posta veya şifre hatalı.' });
    }

    // 4️⃣ E-posta onayı kontrolü (yalnızca şifre doğrulandıktan sonra)
    if (!user.isemailapproved) {
      return res.status(401).json({
        error: 'Hesabınız onaylanmamış. Lütfen e-posta adresinizi doğrulayın.',
      });
    }

    // 6️⃣ Token oluştur
    const token = signJWT({ email, id: user.id }, '7d' );


    // 7️⃣ Veritabanında token güncelle
    await pool.query('UPDATE default_users SET jwt_token = $1 WHERE id = $2', [
      token,
      user.id,
    ]);

    // 8️⃣ Profil eksik mi?
    const needsProfile =
      !user.phone_number || !user.date_of_birth || !user.gender;

    // 9️⃣ Başarı yanıtı
    return res.status(200).json({
      message: 'Giriş Başarılı',
      jwt: token,
      needs_profile: needsProfile,
    });
  } catch (e) {
    console.error('❌ Login Hatası:', e);
    return res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// =======================================
// 🔹 Kullanıcı Şifre Değiştirme Endpoint
// =======================================
app.post('/change-password', authLimiter, authenticateToken, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    // 1️⃣ Basit kontroller
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Mevcut ve yeni şifre zorunludur.' });
    }
    if (typeof new_password !== 'string' || new_password.length < 8) {
      return res.status(400).json({ error: 'Yeni şifre en az 8 karakter olmalı.' });
    }
    if (new_password === current_password) {
      return res.status(400).json({ error: 'Yeni şifre, mevcut şifreden farklı olmalı.' });
    }

    // 2️⃣ Kimliği doğrulanmış kullanıcı bilgisi (JWT'den)
    const email = req.user.email;

    // 3️⃣ PostgreSQL’den kullanıcıyı çek
    const { rows } = await pool.query(
      'SELECT id, email, password FROM default_users WHERE email = $1 LIMIT 1',
      [email]
    );
    const user = rows[0];

    if (!user) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    }

    // 4️⃣ Google hesabı mı?
    if (!user.password) {
      return res.status(400).json({
        error: 'Bu hesap Google ile oluşturulmuş. Şifre değişikliği desteklenmiyor.',
      });
    }

    // 5️⃣ Mevcut şifre doğru mu?
    const isMatch = await arePasswordMatch(current_password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Mevcut şifre yanlış.' });
    }

    // 6️⃣ Yeni şifreyi hashle
    const hashedPassword = await hashPassword(new_password);

    // 7️⃣ Şifreyi güncelle
    await pool.query('UPDATE default_users SET password = $1 WHERE email = $2', [
      hashedPassword,
      email,
    ]);

    // 8️⃣ Yeni JWT oluştur
    const newToken = signJWT({ email, id: user.id },  '7d' );


    // 9️⃣ Token’ı güncelle
    await pool.query('UPDATE default_users SET jwt_token = $1 WHERE email = $2', [
      newToken,
      email,
    ]);

    // 🔟 Başarılı yanıt
    return res
      .status(200)
      .json({ message: 'Şifreniz başarıyla değiştirildi.', jwt: newToken });
  } catch (e) {
    console.error('❌ /change-password hatası:', e);
    return res.status(500).json({ error: 'Sunucu hatası' });
  }
});

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'] || req.headers['x-access-token'];
  if (!authHeader) return res.status(401).json({ error: 'Token eksik' });

  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  try {
    const decoded = verifyJWT(token);
    req.user = decoded;
    next();
  } catch (err) {
    console.error('❌ Token doğrulama hatası:', err.message);
    return res.status(403).json({ error: 'Geçersiz veya süresi dolmuş token' });
  }
}

export function authenticateTokenForFeedback(req, res, next) {
  try {
    const rawHeader = req.headers['authorization'] || req.headers['x-access-token'] || '';

    // "Bearer <token>" → sadece token kısmını ayıkla
    const token = rawHeader.startsWith('Bearer ') ? rawHeader.slice(7) : rawHeader.trim();

    if (!token || token === 'undefined' || typeof token !== 'string') {
      console.log('❌ Token geçersiz veya eksik.');
      return res.status(401).json({ error: 'Geçersiz veya eksik token' });
    }

    // RS256 doğrulama (asymmetric)
    const decoded = verifyJWT(token);

    // Başarılıysa kullanıcıyı req.user’a koy
    req.user = decoded;
    next();
  } catch (err) {
    console.error('❌ Token doğrulama hatası:', err.message);
    return res.status(403).json({ error: 'Token geçersiz veya süresi dolmuş.' });
  }
}

// ======================================
// 🔹 Kullanıcı Token Güncelleme Endpoint
// ======================================
app.patch('/refresh-token', authenticateToken, async (req, res) => {
  try {
    const email = req.user.email;

    // 1️⃣ Kullanıcıyı email üzerinden bul
    const { rows } = await pool.query(
      'SELECT id FROM default_users WHERE email = $1 LIMIT 1',
      [email]
    );

    if (rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: 'Kullanıcı bulunamadı.' });
    }

    const user = rows[0];
    const id = user.id;
    // 2️⃣ Yeni JWT oluştur
    const newToken = signJWT({ email, id }, '7d');


    // 3️⃣ Veritabanında jwt_token alanını güncelle
    await pool.query('UPDATE default_users SET jwt_token = $1 WHERE email = $2', [
      newToken,
      email,
    ]);

    console.log(`🔄 Token yenilendi: ${email}`);

    // 4️⃣ Yanıt döndür
    return res.json({ success: true, token: newToken });
  } catch (err) {
    console.error('❌ Token yenileme hatası:', err);
    return res
      .status(500)
      .json({ success: false, message: 'Sunucu hatası' });
  }
});

// ========================================
// 🔹 Kullanıcı Profil Güncelleme Endpoint
// ========================================
app.post('/update-profile', authenticateToken, async (req, res) => {
  try {
    const email = req.user.email;

    // 1️⃣ Mevcut kullanıcı bilgilerini al
    const { rows } = await pool.query(
      'SELECT name, phone_number, date_of_birth, gender FROM default_users WHERE email = $1 LIMIT 1',
      [email]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    }

    const existing = rows[0];

    // 2️⃣ Yeni değer varsa al, yoksa eskisini koru
    const name = req.body.name || existing.name;
    const phone_number = req.body.phone_number || existing.phone_number;
    const date_of_birth = req.body.date_of_birth || existing.date_of_birth;
    const gender =
      req.body.gender !== undefined ? req.body.gender : existing.gender;

    // 3️⃣ Kullanıcıyı güncelle
    await pool.query(
      `
      UPDATE default_users 
      SET name = $1, phone_number = $2, date_of_birth = $3, gender = $4
      WHERE email = $5
      `,
      [name, phone_number, date_of_birth, gender, email]
    );

    console.log(`🟢 Profil güncellendi: ${email}`);

    // 4️⃣ Yanıt döndür
    return res.json({ success: true, message: 'Profil güncellendi ✅' });
  } catch (err) {
    console.error('❌ /update-profile hatası:', err);
    return res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ===================================
// 🔹 Kullanıcı Google Giriş Endpoint
// ===================================
app.post('/auth/google', authLimiter, async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) return res.status(400).json({ error: 'idToken eksik' });

  try {
    // 1️⃣ Google token'ı doğrula
    const ticket = await client.verifyIdToken({
      idToken,
      audience: [
        process.env.GOOGLE_CLIENT_ID,
        process.env.ANDROID_CLIENT_ID_FOR_GOOGLE,
      ],
    });

    const payload = ticket.getPayload();

    /* Google'ın doğrulamadığı bir e-posta ile giriş kabul edilirse,
       aynı e-postayla açılmış klasik (şifreli) hesap devralınabilir. */
    if (payload.email_verified !== true) {
      return res.status(401).json({ error: 'Google hesabınızın e-postası doğrulanmamış.' });
    }

    const email = payload.email;
    const name = payload.name;

    // 2️⃣ Kullanıcı var mı?
    const { rows } = await pool.query(
      'SELECT * FROM default_users WHERE email = $1 LIMIT 1',
      [email]
    );

    let user = rows[0];

    // 3️⃣ Kullanıcı yoksa → oluştur
    if (!user) {
      // Önce kayıt oluştur
      const insertQuery = `
        INSERT INTO default_users 
          (name, email, password, isemailapproved, subscription_type, jwt_token, date_of_birth, gender)
        VALUES ($1, $2, NULL, true, 1, NULL, NULL, NULL)
        RETURNING id
      `;
      const { rows: inserted } = await pool.query(insertQuery, [name, email]);
      const userId = inserted[0].id;

      // Şimdi id + email içeren JWT oluştur
      const token = signJWT({ id: userId, email });

      // Token’ı DB’ye kaydet
      await pool.query('UPDATE default_users SET jwt_token = $1 WHERE id = $2', [token, userId]);

      console.log(`🆕 Yeni Google kullanıcısı oluşturuldu: ${email} (id=${userId})`);

      return res.json({
        message: 'Yeni kullanıcı oluşturuldu',
        jwt: token,
        needs_profile: true,
      });
    }

    // 4️⃣ Kullanıcı varsa → yeni token üret ve güncelle
    const newToken = signJWT({ id: user.id, email });

    await pool.query('UPDATE default_users SET jwt_token = $1 WHERE id = $2', [
      newToken,
      user.id,
    ]);

    console.log(`🔁 Google kullanıcısı giriş yaptı: ${email} (id=${user.id})`);

    // 5️⃣ Profil tamam mı?
    const hasProfile = user.date_of_birth !== null && user.gender !== null;

    return res.json({
      message: 'Giriş başarılı',
      jwt: newToken,
      needs_profile: !hasProfile,
    });
  } catch (err) {
    console.error('❌ Detaylı Google Giriş Hatası:', err.message);
    return res.status(401).json({ error: 'Giriş işlemi başarısız' });
  }
});


// ===========================
// 🔹 Alerjen Listeleme
// ===========================
app.get('/list-all-allergens', async (req, res) => {
  try {
    // 1️⃣ PostgreSQL'den alerjenleri çek
    const { rows } = await pool.query('SELECT id, name FROM allergens ORDER BY id ASC');

    // 2️⃣ JSON formatında döndür
    return res.json({ allergens: rows });
  } catch (e) {
    console.error('❌ Alerjen listesi çekme hatası:', e);
    return res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ==============================================
// 🔹 Kullanıcı Alerjenlerini Listeleme Endpoint
// ==============================================
app.get('/list-user-allergens', authenticateToken, async (req, res) => {
  try {
    const email = req.user.email;

    // 1️⃣ Kullanıcı ID’sini al
    const { rows: userRows } = await pool.query(
      'SELECT id FROM default_users WHERE email = $1 LIMIT 1',
      [email]
    );

    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    }

    const userId = userRows[0].id;

    // 2️⃣ Kullanıcının alerjenlerini al (JOIN ile)
    const query = `
      SELECT a.id, a.name
      FROM user_allergens ua
      JOIN allergens a ON ua.allergen_id = a.id
      WHERE ua.user_id = $1
      ORDER BY a.id;
    `;
    const { rows: allergens } = await pool.query(query, [userId]);

    // 3️⃣ Yanıtı JSON olarak döndür
    return res.json({ allergens });
  } catch (err) {
    console.error('❌ /list-user-allergens hatası:', err);
    return res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ==============================================
// 🔹 Kullanıcı Alerjenlerini Güncelleme Endpoint
// ==============================================
app.post('/update-allergens', authenticateToken, async (req, res) => {
  try {
    const email = req.user.email;
    const { selected_allergen_ids } = req.body;

    // 1️⃣ Gelen veri kontrolü
    if (!Array.isArray(selected_allergen_ids)) {
      return res.status(400).json({ error: 'Geçerli bir alerjen listesi gönderilmedi.' });
    }

    // 2️⃣ Kullanıcı ID’sini al
    const { rows: userRows } = await pool.query(
      'SELECT id FROM default_users WHERE email = $1 LIMIT 1',
      [email]
    );

    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    }

    const userId = userRows[0].id;

    // 3️⃣ Mevcut alerjenleri al
    const { rows: existingRows } = await pool.query(
      'SELECT allergen_id FROM user_allergens WHERE user_id = $1',
      [userId]
    );

    const currentIds = existingRows.map((r) => r.allergen_id);

    // 4️⃣ Eklenecek ve silinecek farkları bul
    const toAdd = selected_allergen_ids.filter((id) => !currentIds.includes(id));
    const toDelete = currentIds.filter((id) => !selected_allergen_ids.includes(id));

    // 5️⃣ Yeni alerjenleri ekle
    for (const allergenId of toAdd) {
      try {
        await pool.query(
          'INSERT INTO user_allergens (user_id, allergen_id) VALUES ($1, $2)',
          [userId, allergenId]
        );
      } catch (err) {
        console.error(`❌ Alerjen eklenemedi (ID=${allergenId}):`, err.message);
      }
    }

    // 6️⃣ Kaldırılan alerjenleri sil
    for (const allergenId of toDelete) {
      try {
        await pool.query(
          'DELETE FROM user_allergens WHERE user_id = $1 AND allergen_id = $2',
          [userId, allergenId]
        );
      } catch (err) {
        console.error(`❌ Alerjen silinemedi (ID=${allergenId}):`, err.message);
      }
    }

    // 7️⃣ Başarılı yanıt
    console.log(`🟢 Alerjenler güncellendi: ${email}`);
    return res.json({
      success: true,
      message: 'Alerjenler güncellendi ✅',
      added: toAdd,
      removed: toDelete,
    });
  } catch (err) {
    console.error('❌ /update-allergens hatası:', err);
    return res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ==============================================
// 🔹 Alerjen Arama Endpoint
// ==============================================
app.get('/search-allergens', async (req, res) => {
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

// ==============================================
// 🔹 Kullanıcı Bilgilerini Listeleme Endpoint
// ==============================================
app.get('/my-informations', authenticateToken, async (req, res) => {
  try {
    const email = req.user.email;

    // 1️⃣ Kullanıcı bilgilerini PostgreSQL'den çek
    const { rows } = await pool.query(
      `
      SELECT
        name,
        email,
        isemailapproved,
        subscription_type,
        phone_number,
        date_of_birth,
        gender
      FROM default_users
      WHERE email = $1
      LIMIT 1
      `,
      [email]
    );

    // 2️⃣ Kullanıcı bulunamadıysa
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    }

    const data = rows[0];

    // 3️⃣ Yanıtı frontend için camelCase formatında döndür
    return res.json({
      name: data.name,
      email: data.email,
      isEmailApproved: data.isemailapproved,
      subscription_type: data.subscription_type,
      phone_number: data.phone_number,
      date_of_birth: data.date_of_birth,
      gender: data.gender,
    });
  } catch (err) {
    console.error('❌ /my-informations hatası:', err);
    return res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ==============================================
// 🔹 Resim Arama Endpoint
// ==============================================
app.post('/products/image-search', authenticateToken, upload.single('image'), async (req, res) => {
  console.log('📥 Yeni görsel arama isteği alındı.');

  const imagePath = req.file?.path;
  if (!imagePath) {
    console.error('❌ Görsel yüklenemedi veya imagePath tanımsız.');
    return res.status(400).json({ error: 'Görsel dosyası alınamadı.' });
  }

  console.log('📸 Görsel yolu:', imagePath);

  // Python dosyasını çalıştır
  execFile('python', ['cc-ai.py', imagePath], async (error, stdout, stderr) => {
    console.log('⚙️ Python script çalıştırıldı...');

    if (error) {
      console.error('🐍 Python hatası:', error);
      console.error('🐍 STDERR:', stderr);
      return res.status(500).json({ error: 'Görsel işlenemedi.' });
    }

    // Çıktının tamamı 1000 boyutlu gömme vektörü içeriyor; loga basmıyoruz.
    console.log(`✅ Python çıktısı alındı (${stdout.length} byte).`);

    try {
      const result = JSON.parse(stdout); // cc-ai.py çıktısı JSON olmalı
      const { image_embedding, mean_rgb, histogram, barcode } = result;

      // 🔹 PostgreSQL RPC eşdeğeri çağrı (search_product fonksiyonu)
      const query = `
        SELECT *
        FROM search_product(
          $1::vector,   -- input_embedding
          $2::vector,   -- input_color
          $3::vector,   -- input_histogram
          $4::text      -- input_barcode
        )
      `;

      /* pgvector girdiyi '[1,2,3]' biçiminde bekler. Diziyi doğrudan verirsek
         node-postgres onu Postgres dizi literali '{1,2,3}' olarak serileştirir
         ve ::vector cast'i "invalid input syntax for type vector" ile patlar. */
      const { rows } = await pool.query(query, [
        JSON.stringify(image_embedding),
        JSON.stringify(mean_rgb),
        JSON.stringify(histogram),
        barcode || null,
      ]);

      console.log('🟢 PostgreSQL fonksiyon sonucu:', rows);

      if (rows && rows.length > 0) {
        const matchedProductId = rows[0].id;

        // 🚀 Arka planda sayacı artır (await ile beklemene gerek yok, kullanıcıyı bekletme)
        pool.query('UPDATE products SET scan_count = scan_count + 1 WHERE id = $1', [matchedProductId])
          .catch(err => console.error('❌ scan_count güncellenirken hata:', err));

        return res.json({
          found: true,
          bestMatch: {
            id: matchedProductId,
            brand: rows[0].brand,
            // ... diğer alanlar
            score: rows[0].similarity_score,
          },
        });
      } else {
        return res.json({ found: false });
      }
    } catch (parseError) {
      console.error('❌ Görsel arama hatası:', parseError.message);
      return res.status(500).json({ error: 'Görsel analizi başarısız oldu.' });
    } finally {
      fs.unlink(imagePath, () => {
        console.log('🧹 Geçici görsel silindi:', imagePath);
      });
    }
  });
});

// ==============================================
// 🔹 Ürün Bilgilerini Listeleme Endpoint
// ==============================================
app.get('/products/:id/full-info', authenticateToken, async (req, res) => {
  const productId = req.params.id;
  const userId = req.user.id;

  try {
    // 1️⃣ Ürünün içeriklerini (ingredients) çek
    const ingredientQuery = `
      SELECT i.name
      FROM product_ingredients pi
      JOIN ingredients i ON pi.ingredient_id = i.id
      WHERE pi.product_id = $1;
    `;
    const { rows: ingredientRows } = await pool.query(ingredientQuery, [productId]);

    const ingredientNames = ingredientRows
      .map((row) => row.name?.toLowerCase())
      .filter(Boolean);

    if (ingredientNames.length === 0) {
      return res.status(404).json({ error: 'Ürüne ait içerik bulunamadı.' });
    }

    // 2️⃣ Kullanıcının alerjenlerini çek
    const allergenQuery = `
      SELECT a.name
      FROM user_allergens ua
      JOIN allergens a ON ua.allergen_id = a.id
      WHERE ua.user_id = $1;
    `;
    const { rows: allergenRows } = await pool.query(allergenQuery, [userId]);

    const allergenNames = allergenRows
      .map((row) => row.name?.toLowerCase())
      .filter(Boolean);

    // 3️⃣ Eşleşen alerjenleri bul
    const matchedAllergens = allergenNames.filter((allergen) =>
      ingredientNames.some((ingredient) => ingredient.includes(allergen))
    );

    // 4️⃣ JSON yanıt oluştur
    const response = {
      hasAllergen: matchedAllergens.length > 0,
      matchedAllergens: matchedAllergens.map((a) => a.toUpperCase()),
      ingredients: ingredientNames.map(
        (name) => name.charAt(0).toUpperCase() + name.slice(1)
      ),
    };

    console.log(`🧾 Ürün (${productId}) için alerjen kontrolü yapıldı, kullanıcı ${userId}`);
    return res.json(response);
  } catch (err) {
    console.error('❌ Ürün alerjen kontrol hatası:', err);
    return res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ==============================================
// 🔹 Feedback Gönderme Endpoint
// ==============================================
app.post('/send-feedback', authenticateTokenForFeedback, feedbackUpload.single('image'), async (req, res) => {
  try {
    const email = req.user.email;

    // 1️⃣ Kullanıcı ID’sini al
    const { rows: userRows } = await pool.query(
      'SELECT id FROM default_users WHERE email = $1 LIMIT 1',
      [email]
    );
    if (userRows.length === 0)
      return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });

    const userId = userRows[0].id;

    const { topic, message } = req.body;
    if (!topic || !message) {
      return res.status(400).json({ error: 'Konu ve mesaj zorunludur.' });
    }

    // 2️⃣ Feedback DB kaydı oluştur (önce görsel olmadan)
    const insertQuery = `
      INSERT INTO user_feedback (user_id, subject, message, image_url, created_at)
      VALUES ($1, $2, $3, NULL, NOW())
      RETURNING id;
    `;
    const { rows: feedbackRows } = await pool.query(insertQuery, [userId, topic, message]);
    const feedbackId = feedbackRows[0]?.id;

    // 3️⃣ Görsel varsa doğru isimle yeniden adlandır
    let imageUrl = null;
    if (req.file) {
      // Uzantı beyaz listeden, dosya adı tahmin edilemez olacak şekilde rastgele üretilir.
      const extension = safeImageExtension(req.file.originalname);
      const newFileName = `feedback_${feedbackId}-${userId}-${randomUUID()}${extension}`;

      // Eski path: user_uploads/feedback/feedback_173995xxx.jpg
      const oldPath = req.file.path;
      const newPath = path.join(path.dirname(oldPath), newFileName);

      // fs.renameSync ile dosyayı yeniden adlandır
      fs.renameSync(oldPath, newPath);

      imageUrl = `/user_uploads/feedback/${newFileName}`;

      // DB'de image_url alanını güncelle
      await pool.query('UPDATE user_feedback SET image_url = $1 WHERE id = $2', [imageUrl, feedbackId]);
    }

    console.log(`🟢 Feedback kaydedildi (ID=${feedbackId}, User=${userId}) - ${email}`);

    // 4️⃣ Başarılı yanıt
    return res.json({
      success: true,
      message: 'Geri bildirim gönderildi ✅',
      feedback_id: feedbackId,
      user_id: userId,
      image_url: imageUrl,
    });
  } catch (err) {
    console.error('❌ /send-feedback hatası:', err);
    return res.status(500).json({ error: 'Sunucu hatası' });
  }
});



// ==============================================
// 🔹 Feedback Görseli Servis Etme (sahiplik kontrollü)
// ==============================================
/* Eskiden bu klasör express.static ile herkese açıktı. Artık yalnızca görselin
   sahibi kendi feedback'inin görselini görebiliyor. */
app.get('/user_uploads/feedback/:filename', authenticateToken, async (req, res) => {
  try {
    const filename = path.basename(req.params.filename); // dizin geçişini engelle
    const imageUrl = `/user_uploads/feedback/${filename}`;

    const { rows } = await pool.query(
      'SELECT id FROM user_feedback WHERE image_url = $1 AND user_id = $2 LIMIT 1',
      [imageUrl, req.user.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Görsel bulunamadı.' });
    }

    const filePath = path.join(__dirname, 'user_uploads', 'feedback', filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Görsel bulunamadı.' });
    }

    // Tarayıcının dosyayı HTML/JS olarak yorumlamasını engelle
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    return res.sendFile(filePath);
  } catch (err) {
    console.error('❌ Feedback görseli servis hatası:', err);
    return res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ==============================================
// 🔹 Merkezi Hata Yakalayıcı
// ==============================================
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

app.listen(PORT, () => {
  console.log(`✅ Sunucu ${PORT} portunda başarıyla başlatıldı ve istekleri dinliyor.`);
});
