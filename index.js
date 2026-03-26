import cron from "node-cron";
import express from "express";
import puppeteer from "puppeteer";
import { google } from "googleapis";

const SHEET_ID = process.env.SHEET_ID || "";
const GROUP_URLS = (process.env.GROUP_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
const COOKIES_JSON = process.env.COOKIES_JSON || "";

const log = (emoji, message) => console.log(`[${new Date().toLocaleString("th-TH")}] ${emoji} ${message}`);

async function runJob() {
  log("🚀", "--- เริ่มงานโหมดรีโมท (Interactive Mode) ---");
  let browser;
  try {
    // เชื่อมต่อไปยังเบราว์เซอร์ที่มีหน้าจอในตัว Docker เอง
    browser = await puppeteer.launch({
      headless: false, // 💡 ต้องเป็น false เพื่อให้พี่มองเห็นหน้าจอ
      args: ["--no-sandbox", "--window-size=1280,900"]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    if (COOKIES_JSON) {
      const cookies = JSON.parse(COOKIES_JSON);
      await page.setCookie(...cookies);
    }

    for (const url of GROUP_URLS) {
      log("🌐", `เปิดกลุ่ม: ${url}`);
      await page.goto(url, { waitUntil: "networkidle2" });

      // --- 🛑 จุดพักรอพี่ฟิวส์ ---
      // ถ้าบอทนับโพสต์ได้ 0 มันจะหยุดรอ 1 นาที เพื่อให้พี่รีโมทเข้าไปกด
      const posts = await page.$$("div[role='article']");
      if (posts.length === 0) {
        log("⚠️", "ติดหน้ากั้น! พี่ฟิวส์มีเวลา 2 นาทีในการรีโมทเข้าไปกดให้ผ่าน...");
        await new Promise(res => setTimeout(res, 120000)); // รอนิ่งๆ 2 นาที
      }

      // ... (โค้ดส่วนไถงานและบันทึก Sheets เหมือนเดิม) ...
      log("✅", "เริ่มดึงข้อมูล...");
    }
  } catch (e) { log("💀", e.message); }
  finally { if (browser) await browser.close(); }
}

// ตั้ง Server หน้าบ้าน
const app = express();
app.get("/", (req, res) => res.send("บอทรันอยู่... เข้าดูหน้าจอได้ที่ Port 3000/debugger"));
app.listen(process.env.PORT || 8080, () => {
  cron.schedule("*/20 * * * *", runJob);
});
