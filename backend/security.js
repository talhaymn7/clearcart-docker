// ================================
// 🔐 Clear Cart Security Module
// Handles JWT (RS256) & RSA Decryption
// ================================
import fs from 'fs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import path from 'path';

// -------------------------------
// 🔧 Anahtar yolları (Docker env'den veya local fallback)
// -------------------------------
const PRIV_PATH = process.env.JWT_PRIVATE_KEY_PATH || path.resolve('./keys/private.pem');
const PUB_PATH  = process.env.JWT_PUBLIC_KEY_PATH  || path.resolve('./keys/public.pem');

// -------------------------------
// 🔐 Anahtarları oku
// -------------------------------
let privateKey, publicKey;

try {
  privateKey = fs.readFileSync(PRIV_PATH, 'utf8');
  publicKey = fs.readFileSync(PUB_PATH, 'utf8');
  console.log(`🔑 Security keys loaded from ${PRIV_PATH} / ${PUB_PATH}`);
} catch (err) {
  console.error('❌ Failed to load RSA keys:', err.message);
  privateKey = null;
  publicKey = null;
}

// -------------------------------
// 🔸 JWT Functions (RS256)
// -------------------------------
export function signJwt(payload, expiresIn = '7d') {
  if (!privateKey) throw new Error('Private key not loaded');
  return jwt.sign(payload, privateKey, { algorithm: 'RS256', expiresIn });
}

export function verifyJwt(token) {
  if (!publicKey) throw new Error('Public key not loaded');
  return jwt.verify(token, publicKey, { algorithms: ['RS256'] });
}

// -------------------------------
// 🔸 RSA Decryption (for client-encrypted data)
// Client sends `enc:<base64>` → backend decrypts with private key
// -------------------------------
export function decryptBase64WithPrivateKey(encryptedBase64) {
  if (!privateKey) throw new Error('Private key not loaded');
  try {
    const buffer = Buffer.from(encryptedBase64, 'base64');
    const decrypted = crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      buffer
    );
    return decrypted.toString('utf8');
  } catch (err) {
    console.error('❌ RSA decrypt error:', err.message);
    throw new Error('RSA decrypt failed');
  }
}

// -------------------------------
// 🔸 Middleware: Şifreli alanları otomatik çöz
// örn: decryptFieldsMiddleware(['email', 'password'])
// -------------------------------
export function decryptFieldsMiddleware(fieldNames = []) {
  return (req, res, next) => {
    try {
      if (!req.body) return next();
      for (const field of fieldNames) {
        const val = req.body[field];
        if (typeof val === 'string' && val.startsWith('enc:')) {
          const b64 = val.slice(4);
          req.body[field] = decryptBase64WithPrivateKey(b64);
        }
      }
      next();
    } catch (e) {
      console.error('❌ decryptFieldsMiddleware error:', e.message);
      res.status(400).json({ error: 'Şifre çözme başarısız' });
    }
  };
}

// -------------------------------
// 🔸 Public Key Endpoint Helper
// (frontend / client public key alabilsin)
// -------------------------------
export function getPublicKey() {
  if (!publicKey) throw new Error('Public key not loaded');
  return publicKey;
}

export const SERVER_PUBLIC_KEY = publicKey;
export { signJwt as signJWT, verifyJwt as verifyJWT };