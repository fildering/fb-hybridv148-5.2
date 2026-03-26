FROM ghcr.io/browserless/chromium:latest

ENV ENABLE_DEBUGGER=true
ENV PORT=3000

# แยกห้องให้บอทมาอยู่ที่โฟลเดอร์ /bot (จะได้ไม่ทับระบบหน้าจอ)
WORKDIR /bot
COPY package*.json ./
RUN npm install
COPY index.js ./
COPY start.sh ./

# กันเหนียวเรื่องบรรทัดเว้นวรรคเผื่อสร้างไฟล์จาก Windows
RUN sed -i 's/\r$//' start.sh
RUN chmod +x start.sh

EXPOSE 3000

# สั่งรันไฟล์ start.sh
CMD ["./start.sh"]
