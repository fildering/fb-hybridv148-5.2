import cron from "node-cron";
import puppeteer from "puppeteer";
import { google } from "googleapis";

const SHEET_ID = process.env.SHEET_ID || "";
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

    // เกาะไปที่หน้าจอ Browserless
    browser = await puppeteer.connect({
      browserWSEndpoint: `ws://localhost:3000?--window-size=1280,900`,
      defaultViewport: null
    });

    const page = await browser.newPage();
    if (COOKIES_JSON) await page.setCookie(...JSON.parse(COOKIES_JSON));

    for (const url of GROUP_URLS) {
      log("🌐", `ตรวจสอบกลุ่ม: ${url}`);
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

      const postsCount = await page.evaluate(() => document.querySelectorAll("div[role='article']").length);
      if (postsCount === 0) {
        log("🛑", "หน้ากั้น! บอทจอดรอ 2 นาที พี่เข้าไปจิ้มใน /debugger ได้เลย...");
        await new Promise(res => setTimeout(res, 120000)); 
      }
      log("✅", "ลุยงานต่อ...");
      // ใส่โค้ดดูดข้อมูลต่อตรงนี้
    }
  } catch (e) { log("💀", e.message); } 
  finally { if (browser) await browser.disconnect(); log("🏁", "จบงาน"); }
}

log("🤖", "Bot Ready! รอเวลาทำงาน...");
cron.schedule("*/20 * * * *", runJob);
if (process.env.RUN_ON_START === "true") runJob();
