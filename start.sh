#!/bin/bash
# 1. รันตัวหน้าจอไว้เบื้องหลัง (Port 3000)
cd /usr/src/app
npm start &

# 2. รอระบบหน้าจอพร้อม
sleep 10

# 3. รันบอท (Port 8080)
cd /bot
node index.js
