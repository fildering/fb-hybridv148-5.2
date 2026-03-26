import cron from "node-cron";
import express from "express";
import puppeteer from "puppeteer";
import { google } from "googleapis";

// -------------------- Config --------------------
const SHEET_ID = process.env.SHEET_ID || "";
const SHEET_NAME = process.env.SHEET_NAME || "Raw";
const GROUP_URLS = (process.env.GROUP_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
const COOKIES_JSON = process.env.COOKIES_JSON || "";
const TZ = "Asia/Bangkok";

const log = (emoji, message) => console.log(`[${new Date().toLocaleString("th-TH", { timeZone: TZ })}] ${emoji} ${message}`);

async function runJob() {
  log("🚀", "--- เริ่มงานโหมดรีโมท (Interactive Mode) ---");
  let browser;
  try {
    const rawAuth = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS;
    const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(rawAuth), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    const sheets = google.sheets({ version: "v4", auth });

    // 🔥 เชื่อมต่อผ่าน WebSocket เพื่อส่งภาพออกหน้าจอ /debugger (Port 3000)
    browser = await puppeteer.connect({
      browserWSEndpoint: `ws://localhost:3000?--window-size=1280,900`,
      defaultViewport: null
    });

    const page = await browser.newPage();
    
    // ใส่ Cookies ถ้ามี
    if (COOKIES_JSON) {
      try {
        const cookies = JSON.parse(COOKIES_JSON);
        await page.setCookie(...cookies);
      } catch (e) { log("⚠️", "Cookie JSON ผิดรูปแบบ"); }
    }

    for (const url of GROUP_URLS) {
      log("🌐", `กำลังตรวจสอบกลุ่ม: ${url}`);
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

      // เช็คว่าติดหน้ากั้น (0 โพสต์) ไหม
      const postsCount = await page.evaluate(() => document.querySelectorAll("div[role='article']").length);
      
      if (postsCount === 0) {
        log("🛑", "ตรวจพบหน้ากั้น! บอทจะจอดรอ 2 นาที ให้พี่รีโมทเข้าไปกดใน /debugger ได้เลย...");
        // จอดรอให้พี่ฟิวส์จัดการ (จิ้มเองในจอรีโมท)
        await new Promise(res => setTimeout(res, 120000)); 
      }

      log("✅", "เข้าหน้ากลุ่มได้แล้ว! เริ่มดูดข้อมูล...");
      // ... (ส่วนการ Scroll และดึงข้อมูลลง Sheets ใส่ต่อตรงนี้ได้เลย) ...
    }

  } catch (e) { 
    log("💀", `Error: ${e.message}`); 
  } finally { 
    if (browser) await browser.disconnect(); 
    log("🏁", "จบงานรอบนี้"); 
  }
}

// -------------------- Express Server --------------------
const app = express();

// หน้าแรกเช็คสถานะ
app.get("/", (req, res) => {
  res.send(`
    <body style="font-family:sans-serif; text-align:center; padding-top:50px;">
      <h1>🤖 Bot Status: Active</h1>
      <p>เข้าดูหน้าจอรีโมทเพื่อกดรหัสผ่าน/OTP ได้ที่ปุ่มด้านล่าง:</p>
      <a href="/debugger" style="padding:10px 20px; background:#007bff; color:white; text-decoration:none; border-radius:5px;">ไปหน้าจอรีโมท (Debugger)</a>
    </body>
  `);
});

// 🔥 ล็อค Port ให้ตรงกับ Railway Variables (3000)
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  log("📶", `Express Server รันอยู่ที่ Port: ${PORT}`);
  
  // ตั้งตารางเวลา (ทุก 20 นาที)
  cron.schedule("*/20 * * * *", () => {
    runJob();
  });

  // รันทันทีถ้าตั้ง RUN_ON_START = true
  if (process.env.RUN_ON_START === "true") {
    runJob();
  }
});
