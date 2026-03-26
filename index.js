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

    // 🔥 เชื่อมต่อไปยังพอร์ต 3000 (หน้าจอ Docker)
    browser = await puppeteer.connect({
      browserWSEndpoint: `ws://localhost:3000?--window-size=1280,900`,
      defaultViewport: null
    });

    const page = await browser.newPage();
    
    if (COOKIES_JSON) {
      try {
        const cookies = JSON.parse(COOKIES_JSON);
        await page.setCookie(...cookies);
      } catch (e) { log("⚠️", "Cookie JSON ผิดรูปแบบ"); }
    }

    for (const url of GROUP_URLS) {
      log("🌐", `กำลังตรวจสอบกลุ่ม: ${url}`);
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

      const postsCount = await page.evaluate(() => document.querySelectorAll("div[role='article']").length);
      
      if (postsCount === 0) {
        log("🛑", "ตรวจพบหน้ากั้น! พี่รีโมทเข้าหน้าหลักเพื่อกดให้ผ่านได้เลย (บอทจะรอ 2 นาที)...");
        // จอดรอให้พี่ฟิวส์จัดการ (จิ้มเองในจอรีโมท)
        await new Promise(res => setTimeout(res, 120000)); 
      }

      log("✅", "พร้อมทำงานต่อ...");
      // ... (โค้ดดึงข้อมูลลง Sheets เหมือนเดิม) ...
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

// รันหน้าสถานะไว้ที่พอร์ต 8080 เพื่อไม่ให้ทับกับหน้าจอรีโมท (Port 3000)
app.get("/", (req, res) => {
  res.send("Bot Control System is Running on Port 8080");
});

// 🔥 บังคับให้ Express รันที่พอร์ต 8080 เสมอ
app.listen(8080, "0.0.0.0", () => {
  log("📶", "Express Server แยกไปรันที่ Port: 8080 (หลบทางให้หน้าจอรีโมท)");
  
  cron.schedule("*/20 * * * *", runJob);

  if (process.env.RUN_ON_START === "true") {
    runJob();
  }
});
