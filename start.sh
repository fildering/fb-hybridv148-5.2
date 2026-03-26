#!/bin/bash
# 1. รันระบบหน้าจอ (Browserless) ทิ้งไว้เบื้องหลัง
cd /usr/src/app
npm start &

# 2. รอระบบหน้าจอเปิด 5 วินาที
sleep 5

# 3. รันบอทของเรา
cd /bot
node index.js
