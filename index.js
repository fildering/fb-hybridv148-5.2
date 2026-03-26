import cron from "node-cron";
import puppeteer from "puppeteer";
import { google } from "googleapis";

const SHEET_ID = process.env.SHEET_ID || "";
const GROUP_URLS = (process.env.GROUP_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
const COOKIES_JSON = process.env.COOKIES_JSON || "";
const TZ = "Asia/Bangkok";

// สร้างลิงก์หน้า Dashboard ของ Browserless
const PUBLIC_URL = process.env.RAILWAY_PUBLIC_DOMAIN 
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` 
  : "http://localhost:3000";

const log = (emoji, message) => console.log(`[${new Date().toLocaleString("th-TH", { timeZone: TZ })}] ${emoji} ${message}`);

async function runJob() {
  log("🚀", "--- เริ่มงานกวาดข้อมูล ---");
  let browser;
  try {
    const rawAuth = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS;
    let auth, sheets;
    if (rawAuth) {
        auth = new google.auth.GoogleAuth({ credentials: JSON.parse(rawAuth), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
        sheets = google.sheets({ version: "v4", auth });
    }

    // ไม่ต้องใส่ keepalive แล้ว เพราะ v1 จัดการให้เอง
    browser = await puppeteer.connect({
      browserWSEndpoint: `ws://localhost:3000?--window-size=1280,900`,
      defaultViewport: null
    });

    const page = await browser.newPage();
    if (COOKIES_JSON) {
        await page.setCookie(...JSON.parse(COOKIES_JSON));
        log("🍪", "โหลดคุกกี้เรียบร้อย");
    }

    for (const url of GROUP_URLS) {
      log("🌐", `ตรวจสอบกลุ่ม: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await new Promise(res => setTimeout(res, 5000));

      try {
        const postsCount = await page.evaluate(() => document.querySelectorAll("div[role='article']").length);
        
        if (postsCount === 0) {
          const currentTitle = await page.title();
          log("🛑", `บอทติดหน้ากั้นของ Facebook! (สถานะ: ${currentTitle})`);
          log("👉", `คลิกเข้า Dashboard เพื่อรีโมทแก้ปัญหา: ${PUBLIC_URL}`);
          log("📺", "วิธีใช้: เข้าลิงก์ด้านบน -> กดแท็บ 'Sessions' -> กดไอคอนรูป 👁️ (View) หรือ 📺 เพื่อดูจอสด");
          log("⏳", "บอทเปิดจอรอไว้ให้ 5 นาที เข้าไปกดแก้ Checkpoint ได้เลยครับ...");
          
          // รอ 5 นาที ให้คุณเข้าไปแก้บนจอ
          await new Promise(res => setTimeout(res, 300000)); 
          
          log("🔄", "หมดเวลา 5 นาทีแล้ว บอทจะเริ่มทำงานต่อ...");
        } else {
          log("✅", `เจอโพสต์จำนวน ${postsCount} โพสต์ ลุยงานต่อ...`);
          // ใส่โค้ดดูดข้อมูลต่อตรงนี้
        }
      } catch (err) {
        log("⚠️", `อ่านหน้าเว็บไม่ได้: ${err.message}`);
      }
    }
  } catch (e) { 
      log("💀", e.message); 
  } finally { 
      if (browser) await browser.disconnect(); 
      log("🏁", "จบงานรอบนี้"); 
  }
}

log("🤖", "Bot Ready! รอเวลาทำงาน...");
cron.schedule("*/20 * * * *", runJob);
if (process.env.RUN_ON_START === "true") runJob();
