import sys
from PIL import Image, ExifTags
import os
import numpy as np
from rembg import remove
import onnxruntime as ort
import json
import cv2
from pyzbar.pyzbar import decode

#Barkod tarama fonksiyonu
def read_barcode_from_image(image_path):
    img = cv2.imread(image_path)
    barcodes = decode(img)
    if barcodes:
        for barcode in barcodes:
            barcode_data = barcode.data.decode("utf-8")
            return barcode_data
    else:
        return None

# Giriş parametresi (görsel path)
image_path = sys.argv[1]

# EXIF düzeltme(Dikey-yatay doğrulama)
image = Image.open(image_path)
try:
    for orientation in ExifTags.TAGS.keys():
        if ExifTags.TAGS[orientation] == 'Orientation':
            break
    exif = image._getexif()
    if exif is not None:
        orientation_value = exif.get(orientation, None)
        if orientation_value == 3:
            image = image.rotate(180, expand=True)
        elif orientation_value == 6:
            image = image.rotate(270, expand=True)
        elif orientation_value == 8:
            image = image.rotate(90, expand=True)
except (AttributeError, KeyError, IndexError):
    pass

# Önce barkod kontrolu yap. barkod varsa barkod üzerinde aramayı yoğunlaştır.
barcode_result = read_barcode_from_image(image_path)

if barcode_result is not None:
    # Barkod bulunduysa JSON döndür ve çık
    print(json.dumps({
        "barcode": barcode_result,
        "mean_rgb": None,
        "histogram": None,
        "image_embedding": None
    }))
    sys.exit(0)
 
        
# RGB'ye çevir
image = image.convert("RGB")

# Arka planı kaldır
image = remove(image)

# RGBA maskeyle çalış
rgba = image.convert("RGBA")
np_image = np.array(rgba)
alpha_mask = np_image[:, :, 3] > 0
rgb_pixels = np_image[:, :, :3][alpha_mask]

# Ortalama renk
mean_rgb = rgb_pixels.mean(axis=0).tolist()

# Histogram
r_hist = np.histogram(rgb_pixels[:, 0], bins=8, range=(0, 256))[0]
g_hist = np.histogram(rgb_pixels[:, 1], bins=8, range=(0, 256))[0]
b_hist = np.histogram(rgb_pixels[:, 2], bins=8, range=(0, 256))[0]
histogram = np.concatenate([r_hist, g_hist, b_hist]).tolist()

# EfficientNet-B4 ONNX modelini yükle
model_path = "models/efficientnet_b4_Opset17.onnx"
ort_session = ort.InferenceSession(model_path)

# Embedding için ön işleme
image_for_model = image.convert("RGB").resize((380, 380))
input_array = np.array(image_for_model).astype(np.float32) / 255.0
input_array = np.transpose(input_array, (2, 0, 1))  # HWC -> CHW
input_array = np.expand_dims(input_array, axis=0)

# Model input/output isimleri
input_name = ort_session.get_inputs()[0].name
output_name = ort_session.get_outputs()[0].name

# Embedding çıkar
ort.set_default_logger_severity(3)  # uyarı & info mesajlarını bastır
embedding = ort_session.run([output_name], {input_name: input_array})[0]
embedding_list = embedding.flatten().tolist()

# JSON olarak çıktı
print(json.dumps({
    "mean_rgb": mean_rgb,
    "histogram": histogram,
    "image_embedding": embedding_list
}))