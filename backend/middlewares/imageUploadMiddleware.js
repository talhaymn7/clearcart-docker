// middlewares/imageUploadMiddleware.js
import multer from 'multer';
import path from 'path';
import { randomUUID } from 'crypto';

// Yüklenen dosyalar diske yazıldığı ve sonradan servis edilebildiği için
// uzantı ASLA originalname'den olduğu gibi alınmaz — beyaz listeye karşı doğrulanır.
// Aksi halde .html/.svg yüklenip aynı origin üzerinden kalıcı XSS'e dönüşebilir.
export const ALLOWED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

export function safeImageExtension(originalName) {
    const ext = path.extname(originalName || '').toLowerCase();
    return ALLOWED_IMAGE_EXTENSIONS.includes(ext) ? ext : '.jpg';
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'user_uploads/');
    },
    filename: function (req, file, cb) {
        // Token doğrulaması zaten authenticateToken'da yapıldı
        const userId = req.user?.id;
        const ext = safeImageExtension(file.originalname);

        if (!userId) {
            console.warn('⚠️ userId çözülemedi, anon ismi veriliyor.');
            return cb(null, `anon_feedback_${randomUUID()}${ext}`);
        }

        // Dosya adı tahmin edilebilir olmamalı: userId + rastgele UUID
        cb(null, `feedback_${userId}_${randomUUID()}${ext}`);
    }
});

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('Yalnızca görsel yüklenebilir.'));
        }
        if (!ALLOWED_IMAGE_EXTENSIONS.includes(path.extname(file.originalname).toLowerCase())) {
            return cb(new Error('Desteklenmeyen dosya uzantısı.'));
        }
        cb(null, true);
    },
    limits: { fileSize: 10 * 1024 * 1024, files: 1 }, // max 10MB, tek dosya
});

export default upload;
