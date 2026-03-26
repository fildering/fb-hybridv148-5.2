FROM ghcr.io/browserless/chromium:latest

# ตั้งค่าให้ไม่ต้องถามรหัสผ่านเวลาเข้าหน้าเว็บรีโมท (เพื่อความไว)
ENV SCREEN_WIDTH=1280
ENV SCREEN_HEIGHT=900
ENV SCREEN_DEPTH=24
ENV ENABLE_REBOOT=false
ENV PREBOOT_CHROME=true
ENV CONNECTION_TIMEOUT=300000

# ก๊อปปี้ไฟล์งานของเราเข้าไป
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .

# เปิด Port สำหรับหน้าจอรีโมทและ API
EXPOSE 3000

CMD ["npm", "start"]
