// computeEmbeddingsAndBuildIndex.js
import fs from 'fs/promises';
import path from 'path';
import fsSync from 'fs';
import { execSync } from 'child_process';
import { createClient } from '@libsql/client';
import dotenv from 'dotenv';
import pkg from 'hnswlib-node';
dotenv.config();

const { HierarchicalNSW } = pkg;

const db = createClient({
  url: process.env.TURSO_DB_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const dim = 1000;
const maxItems = 5000;
const PHOTOS_DIR = path.join('product_photos');
const INDEX_PATH = path.join('vector_data', 'product_index.bin');
const PYTHON_SCRIPT = 'cc-ai.py';

function getProductId(filename) {
  const num = parseInt(filename.split('_')[0], 10);
  return isNaN(num) ? null : num;
}

function runPythonOnImage(imagePath) {
  try {
    const result = execSync(`python3 ${PYTHON_SCRIPT} "${imagePath}"`, { encoding: 'utf-8' });
    const json = JSON.parse(result);

    // Eğer sadece barkod döndüyse embedding yoktur, bu dosyayı atla
    if (json.barcode && !json.image_embedding) {
      throw new Error("Sadece barkod bulundu, embedding yok → atlandı");
    }

    if (!json.image_embedding) {
      throw new Error("JSON içinde 'image_embedding' bulunamadı");
    }

    return json.image_embedding;
  } catch (err) {
    console.error(`❌ [PYTHON] ${path.basename(imagePath)} → ${err.message}`);
    throw err;
  }
}


function averageEmbeddings(embeddings) {
  const len = embeddings[0].length;
  const sum = new Array(len).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < len; i++) sum[i] += emb[i];
  }
  return sum.map(v => v / embeddings.length);
}

export async function updateProductEmbeddingsAndBuildIndex() {
  console.log('🔄 [1/3] Embedding çıkarımı başlatılıyor...');
  const files = await fs.readdir(PHOTOS_DIR).catch(() => []);
  if (files.length === 0) {
    console.warn(`⚠️ Klasörde görsel bulunamadı: ${PHOTOS_DIR}`);
    return;
  }

  const productMap = {};

  for (const file of files) {
    const fullPath = path.join(PHOTOS_DIR, file);
    const productId = getProductId(file);
    if (!productId) {
      console.warn(`⛔ Dosya adı geçersiz, atlanıyor: ${file}`);
      continue;
    }

    try {
      const embedding = runPythonOnImage(fullPath);
      if (!productMap[productId]) productMap[productId] = [];
      productMap[productId].push(embedding);
      console.log(`✅ [PY] ${file} işlendi`);
    } catch (err) {
      console.warn(`❌ [PY FAIL] ${file} → işlem atlandı`);
    }
  }

  if (Object.keys(productMap).length === 0) {
    console.warn("⛔ Hiçbir ürün için geçerli embedding çıkarılamadı.");
    return;
  }

  console.log('🧠 [2/3] Embedding ortalaması hesaplanıyor ve DB güncelleniyor...');
  const index = new HierarchicalNSW('cosine', dim);
  index.initIndex(maxItems);

  let updated = 0;

  for (const [productId, embeddings] of Object.entries(productMap)) {
    try {
      const avg = averageEmbeddings(embeddings);
      const jsonStr = JSON.stringify(avg);

      await db.execute({
        sql: `UPDATE products SET embedding = ? WHERE id = ?`,
        args: [jsonStr, productId],
      });

      index.addPoint(avg, parseInt(productId));
      updated++;

      console.log(`🔁 ID ${productId} → embedding güncellendi ve index'e eklendi`);
    } catch (err) {
      console.warn(`❌ DB FAIL (ID: ${productId}): ${err.message}`);
    }
  }

  console.log('📦 [3/3] ANN index dosyası yazılıyor...');
  if (!fsSync.existsSync('vector_data')) await fs.mkdir('vector_data', { recursive: true });

  index.writeIndexSync(INDEX_PATH);
  console.log(`🎯 ANN index yazıldı → ${INDEX_PATH} (${updated} ürün)`);

  if (updated === 0) {
    console.warn("⚠️ Dikkat: ANN index oluşturuldu ama hiçbir ürün güncellenmedi.");
  } else {
    console.log('✅ Embedding ve index oluşturma işlemi tamamlandı.\n');
  }
}
