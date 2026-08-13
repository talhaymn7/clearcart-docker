-- ============================================================
-- Clear Cart — Veritabanı Şeması
--
-- Bu dosya PostgreSQL konteyneri İLK KEZ oluşturulurken
-- /docker-entrypoint-initdb.d/ üzerinden otomatik çalışır.
--
-- Mevcut bir postgres_data volume'ü varsa çalışmaz; şemayı
-- sıfırdan kurmak için:  docker compose down -v && docker compose up -d
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ------------------------------------------------------------
-- Kullanıcılar
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS default_users (
    id                SERIAL PRIMARY KEY,
    name              text NOT NULL,
    email             text NOT NULL UNIQUE,
    password          text,              -- Google ile kayıt olanlarda NULL
    isemailapproved   boolean DEFAULT false,
    subscription_type smallint DEFAULT 1,
    phone_number      text,
    date_of_birth     date,
    gender            text,
    jwt_token         text,
    public_key        text
);

CREATE TABLE IF NOT EXISTS adm_users (
    id         SERIAL PRIMARY KEY,
    email      character varying(255) NOT NULL UNIQUE,
    password   character varying(255) NOT NULL,
    jwt_token  text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- Ürün kataloğu
--
-- image_embedding: EfficientNet-B4 (Opset17) ilk çıktısı, 1000 boyut.
-- histogram      : kanal başına 8 kova × 3 kanal = 24 değer.
-- mean_rgb       : 3 değer.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
    id              BIGSERIAL PRIMARY KEY,
    barcode         text,
    brand           text,
    name            text,
    description     text,
    mean_rgb        double precision[],
    histogram       double precision[],
    image_embedding vector(1000),
    scan_count      integer DEFAULT 0
);

CREATE INDEX IF NOT EXISTS products_barcode_idx ON products (barcode);

-- Kosinüs benzerliği için HNSW indeksi (pgvector >= 0.5)
CREATE INDEX IF NOT EXISTS products_embedding_idx
    ON products USING hnsw (image_embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS ingredients (
    id          SERIAL PRIMARY KEY,
    name        text UNIQUE,
    description text
);

CREATE INDEX IF NOT EXISTS ingredients_name_trgm_idx
    ON ingredients USING gin (name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS product_ingredients (
    product_id    bigint  NOT NULL REFERENCES products(id)    ON DELETE CASCADE,
    ingredient_id integer NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
    PRIMARY KEY (product_id, ingredient_id)
);

-- ------------------------------------------------------------
-- Alerjenler
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS allergens (
    id          SERIAL PRIMARY KEY,
    name        text NOT NULL UNIQUE,
    description text
);

CREATE TABLE IF NOT EXISTS user_allergens (
    id          SERIAL PRIMARY KEY,
    user_id     integer NOT NULL REFERENCES default_users(id) ON DELETE CASCADE,
    allergen_id integer NOT NULL REFERENCES allergens(id)     ON DELETE CASCADE,
    created_at  timestamp with time zone DEFAULT now(),
    UNIQUE (user_id, allergen_id)
);

-- ------------------------------------------------------------
-- Geri bildirim ve denetim kaydı
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_feedback (
    id         SERIAL PRIMARY KEY,
    user_id    integer NOT NULL REFERENCES default_users(id) ON DELETE CASCADE,
    subject    text NOT NULL,
    message    text NOT NULL,
    image_url  text,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id          SERIAL PRIMARY KEY,
    admin_email character varying(255) NOT NULL,
    action_type character varying(75)  NOT NULL,
    endpoint    character varying(255),
    details     text,
    ip_address  character varying(50),
    created_at  timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- Ürün arama fonksiyonu
--
-- Backend /products/image-search ucundan şu imzayla çağırır:
--   search_product(embedding::vector, color::vector, histogram::vector, barcode::text)
--
-- Mantık:
--   1) Barkod okunduysa kesin eşleşme döner (skor 1.0).
--   2) Değilse görsel benzerliğe göre sıralar. Skor, gömme vektörü
--      kosinüs benzerliği ağırlıklı olmak üzere renk ve histogram
--      benzerlikleriyle birleştirilir.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION search_product(
    input_embedding vector,
    input_color     vector DEFAULT NULL,
    input_histogram vector DEFAULT NULL,
    input_barcode   text   DEFAULT NULL
)
RETURNS TABLE (
    id               bigint,
    barcode          text,
    brand            text,
    name             text,
    description      text,
    similarity_score double precision
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    -- 1) Barkod eşleşmesi kesin sonuçtur
    IF input_barcode IS NOT NULL AND btrim(input_barcode) <> '' THEN
        RETURN QUERY
        SELECT p.id, p.barcode, p.brand, p.name, p.description, 1.0::double precision
        FROM products p
        WHERE p.barcode = btrim(input_barcode)
        LIMIT 1;

        IF FOUND THEN
            RETURN;
        END IF;
    END IF;

    -- 2) Görsel benzerlik
    RETURN QUERY
    SELECT p.id, p.barcode, p.brand, p.name, p.description,
           (
               0.70 * (1.0 - (p.image_embedding <=> input_embedding))
             + 0.20 * COALESCE(
                   CASE WHEN input_color IS NOT NULL AND p.mean_rgb IS NOT NULL
                        THEN 1.0 - (p.mean_rgb::vector <=> input_color) END, 0.0)
             + 0.10 * COALESCE(
                   CASE WHEN input_histogram IS NOT NULL AND p.histogram IS NOT NULL
                        THEN 1.0 - (p.histogram::vector <=> input_histogram) END, 0.0)
           )::double precision AS similarity_score
    FROM products p
    WHERE p.image_embedding IS NOT NULL
    ORDER BY similarity_score DESC
    LIMIT 5;
END;
$$;
