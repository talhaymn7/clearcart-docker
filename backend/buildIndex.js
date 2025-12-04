// buildIndex.js
import fs from 'fs';
import path from 'path';
import pkg from 'hnswlib-node';
import { createClient } from '@libsql/client';
import dotenv from 'dotenv';
dotenv.config();

const { HierarchicalNSW } = pkg;

const db = createClient({
    url: process.env.TURSO_DB_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
});

const dim = 1792;
const maxItems = 5000;
const indexFilePath = path.join('vector_data', 'product_index.bin');

async function buildIndex() {
    const index = new HierarchicalNSW('cosine', dim);
    index.initIndex(maxItems);

    const result = await db.execute(`
        SELECT id, embedding FROM products
        WHERE embedding IS NOT NULL
    `);

    let count = 0;
    for (const row of result.rows) {
        const id = row.id;
        let embedding;
        try {
            embedding = JSON.parse(row.embedding);
        } catch {
            console.warn(`❌ ID ${id} → Geçersiz embedding`);
            continue;
        }

        if (embedding.length !== dim) {
            console.warn(`⚠️ ID ${id} → Beklenen boyut değil (${embedding.length})`);
            continue;
        }

        index.addPoint(embedding, id);
        count++;
    }

    index.writeIndexSync(indexFilePath);
    console.log(`✅ ${count} ürünle ANN index oluşturuldu → ${indexFilePath}`);
}

buildIndex().catch(console.error);
