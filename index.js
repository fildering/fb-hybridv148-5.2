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
    // 🔥 ต่อเข้าหน้าจอหลัก
    browser = await puppeteer.connect({
      browserWSEndpoint: `ws://localhost:3000?--window-size=1280,900`,
      defaultViewport: null
    });

    const page = await browser.newPage();
    if (COOKIES_JSON) {
      await page.setCookie(...JSON.parse(COOKIES_JSON));
    }

    for (const url of GROUP_URLS) {
      log("🌐", `เปิดกลุ่ม: ${url}`);
      await page.goto(url, { waitUntil: "networkidle2" });

      const posts = await page.$$("div[role='article']");
      if (posts.length === 0) {
        log("🛑", "ติดหน้ากั้น! พี่รีโมทเข้าไปกดใน /debugger ได้เลย (รอ 2 นาที)");
        await new Promise(res => setTimeout(res, 120000)); 
      }
      log("✅", "ลุยงานต่อ...");
    }
  } catch (e) { log("💀", e.message); }
  finally { if (browser) await browser.disconnect(); }
}

// ---------------------------------------------------------
// 💡 ส่วนของ Express (วางไว้ล่างสุด)
// ---------------------------------------------------------
const app = express();
// ไม่ต้องดักหน้าแรกเยอะ ปล่อยให้ระบบ Docker คุม /debugger เอง
app.get("/status", (req, res) => res.send("Bot is running"));

app.listen(8080, () => { // 👈 ให้ Express ไปใช้พอร์ต 8080 แทน 3000 ไม่ให้แย่งกัน
  log("📡", "Express Server standby on port 8080");
  cron.schedule("*/20 * * * *", runJob);
  if (process.env.RUN_ON_START === "true") runJob();
});
