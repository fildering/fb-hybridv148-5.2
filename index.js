import cron from "node-cron";
import express from "express";
import puppeteer from "puppeteer";
import { google } from "googleapis";

// --- Config ---
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

    // 💡 หัวใจสำคัญ: เชื่อมต่อผ่าน WebSocket เพื่อให้ภาพออกหน้าจอ /debugger
    browser = await puppeteer.connect({
      browserWSEndpoint: `ws://localhost:3000?--window-size=1280,900`,
      defaultViewport: null
    });

    const page = await browser.newPage();
    
    if (COOKIES_JSON) {
      const cookies = JSON.parse(COOKIES_JSON);
      await page.setCookie(...cookies);
    }

    for (const url of GROUP_URLS) {
      log("🌐", `กำลังเปิดกลุ่ม: ${url}`);
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

      // เช็คว่าติดหน้ากั้นไหม
      const posts = await page.$$("div[role='article']");
      if (posts.length === 0) {
        log("🛑", "ตรวจพบหน้ากั้น! บอทจะจอดรอ 2 นาที ให้พี่รีโมทเข้าไปกดให้ผ่าน...");
        // จอดรอให้พี่ฟิวส์เข้าไปจัดการในหน้าจอรีโมท
        await new Promise(res => setTimeout(res, 120000)); 
      }

      log("✅", "เข้าหน้ากลุ่มได้แล้ว (หรือพี่กดให้ผ่านแล้ว) เริ่มทำงานต่อ...");
      // ... (โค้ดส่วนไถหน้าจอและบันทึกลง Sheets ใส่ต่อตรงนี้) ...
    }

  } catch (e) { log("💀", `Error: ${e.message}`); }
  finally { if (browser) await browser.disconnect(); log("🏁", "จบงานรอบนี้"); }
}

const app = express();
app.get("/", (req, res) => res.send("System Active - เข้าดูหน้าจอที่ /debugger"));
app.listen(process.env.PORT || 3000, () => {
  cron.schedule("*/20 * * * *", runJob);
  if (process.env.RUN_ON_START === "true") runJob();
});
