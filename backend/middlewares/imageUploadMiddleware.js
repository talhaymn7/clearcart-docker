// middlewares/imageUploadMiddleware.js
import multer from 'multer';
import path from 'path';

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'user_uploads/');
    },
    filename: function (req, file, cb) {
        try {
            // Token doğrulaması zaten authenticateToken'da yapıldı
            const userId = req.user?.id;
            if (!userId) throw new Error("userId alınamadı");

            const timestamp = Date.now();
            const randomNum = Math.floor(1000 + Math.random() * 9000);
            const fileName = `feedback_${userId}_${timestamp}_${randomNum}${path.extname(file.originalname) || '.jpg'}`;

            cb(null, fileName);
        } catch (err) {
            console.warn("⚠️ userId çözülemedi, anon ismi veriliyor:", err.message);
            const timestamp = Date.now();
            const fallbackName = `anon_feedback_${timestamp}_${Math.floor(Math.random() * 10000)}.jpg`;
            cb(null, fallbackName);
        }
    }
});

const upload = multer({ storage });

export default upload;
