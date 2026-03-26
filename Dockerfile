# เปลี่ยนมาใช้ v1 ที่มีหน้า Dashboard ให้รีโมทจอได้
FROM browserless/chrome:latest

ENV PORT=3000
# ยืดเวลา Session ให้จอไม่ดับ เผื่อใช้เวลาแก้ Captcha นาน (10 นาที)
ENV CONNECTION_TIMEOUT=600000 

# แยกห้องให้บอทมาอยู่ที่โฟลเดอร์ /bot
WORKDIR /bot
COPY package*.json ./
RUN npm install
COPY index.js ./
COPY start.sh ./

# กันเหนียวเรื่องบรรทัดเว้นวรรคเผื่อสร้างไฟล์จาก windows
RUN sed -i 's/\r$//' start.sh
RUN chmod +x start.sh

EXPOSE 3000

CMD ["./start.sh"]
