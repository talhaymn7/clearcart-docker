# =====================================================
# 🧠 BASE: Node.js + Python + ZBar + OpenCV environment
# =====================================================
FROM node:20-slim

# Ortam değişkenleri
ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# -----------------------------------------------------
# 📦 Sistem bağımlılıkları ve build araçları
# -----------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip \
      libzbar0 \
      libgl1 libglib2.0-0 \
      git git-lfs \
      ca-certificates \
      build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# -----------------------------------------------------
# 🐍 Python sanal ortam kurulumu
# -----------------------------------------------------
ENV VENV_PATH=/app/venv
RUN python3 -m venv $VENV_PATH
ENV PATH="$VENV_PATH/bin:${PATH}"

# -----------------------------------------------------
# 📜 Python bağımlılıklarını yükle
# -----------------------------------------------------
COPY requirements.txt ./
RUN pip install --upgrade pip \
 && pip install --no-cache-dir -r requirements.txt

# -----------------------------------------------------
# 📦 Node bağımlılıklarını yükle (native modüller dahil)
# -----------------------------------------------------
COPY package*.json ./
RUN npm install --omit=dev

# -----------------------------------------------------
# 🗂️ Uygulama dosyalarını kopyala
# -----------------------------------------------------
COPY . .

# -----------------------------------------------------
# 🧹 Windows satır sonlarını (CRLF) temizle
# -----------------------------------------------------
RUN sed -i 's/\r$//' start.sh

# -----------------------------------------------------
# RSA Kayıtları oluşturma
# -----------------------------------------------------
RUN mkdir -p /app/keys /app/keys/client_keys
RUN openssl genrsa -out /app/keys/private.pem 2048 && \
    openssl rsa -in /app/keys/private.pem -out /app/keys/public.pem -pubout

    RUN chmod 600 /app/keys/private.pem /app/keys/public.pem
# -----------------------------------------------------
# 🔐 İzinleri ve klasörleri ayarla
# -----------------------------------------------------
RUN chmod +x start.sh \
 && mkdir -p /app/product-photos \
 && chmod -R 777 /app/product-photos

# -----------------------------------------------------
# 🧹 Build araçlarını kaldır (runtime'da gerek yok)
# -----------------------------------------------------
RUN apt-get purge -y --auto-remove build-essential \
 && rm -rf /var/lib/apt/lists/*

RUN mkdir -p ad-b/keys
RUN cd ad-b/keys
RUN openssl genrsa -out private.pem 2048
RUN openssl rsa -in private.pem -pubout -out public.pem
# -----------------------------------------------------
# 🚀 Uygulama başlatma
# -----------------------------------------------------
EXPOSE 10031
CMD ["bash", "start.sh"]
