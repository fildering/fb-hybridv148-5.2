#!/bin/bash
# 1. รันตัวหน้าจอไว้เบื้องหลัง (Port 3000)
cd /usr/src/app
npm start &

# 2. รอระบบหน้าจอพร้อม (เพิ่มเป็น 20 วินาทีให้ชัวร์)
sleep 20

# 3. รันบอท (Port 8080)
cd /bot
node index.js
