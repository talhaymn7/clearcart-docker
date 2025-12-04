#!/bin/bash

# Python virtual environment oluştur
python3 -m venv venv

# Ortamı aktive et
source venv/bin/activate

# pip güncelle ve paketleri yükle
pip install --upgrade pip
pip install -r requirements.txt

# Node.js paketlerini yükle
npm install
