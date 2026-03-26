FROM ghcr.io/browserless/chromium:latest

# ตั้งค่า Environment พื้นฐานภายใน Docker
ENV SCREEN_WIDTH=1280
ENV SCREEN_HEIGHT=900
ENV SCREEN_DEPTH=24
ENV ENABLE_DEBUGGER=true
ENV PREBOOT_CHROME=true
ENV CONNECTION_TIMEOUT=300000
ENV MAX_CONCURRENT_SESSIONS=10

WORKDIR /usr/src/app

# ติดตั้ง Dependencies
COPY package*.json ./
RUN npm install

# ก๊อปปี้โค้ดทั้งหมด
COPY . .

# เปิด Port 3000 สำหรับหน้าจอ Debugger
EXPOSE 3000

CMD ["npm", "start"]
