import cron from "node-cron";
import puppeteer from "puppeteer";
import { google } from "googleapis";

const SHEET_ID = process.env.SHEET_ID || "";
const GROUP_URLS = (process.env.GROUP_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
const COOKIES_JSON = process.env.COOKIES_JSON || "";
const TZ = "Asia/Bangkok";

// ดึง URL ของ Railway อัตโนมัติ (ถ้ามี) เพื่อเอาไว้สร้างลิงก์เข้าดูหน้าจอ /sessions
const PUBLIC_URL = process.env.RAILWAY_PUBLIC_DOMAIN 
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` 
  : "http://localhost:3000";

const log = (emoji, message) => console.log(`[${new Date().toLocaleString("th-TH", { timeZone: TZ })}] ${emoji} ${message}`);

async function runJob() {
  log("🚀", "--- เริ่มงานโหมดรีโมท (Interactive Mode) ---");
  let browser;
  try {
    const rawAuth = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS;
    
    // เช็คว่ามี Credentials ก่อน ค่อยพยายามต่อ Google Sheets (กัน Error ตอนเทสต์แค่บอท)
    let auth, sheets;
    if (rawAuth) {
        auth = new google.auth.GoogleAuth({ credentials: JSON.parse(rawAuth), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
        sheets = google.sheets({ version: "v4", auth });
    }

    // เกาะไปที่หน้าจอ Browserless (เอา keepalive ออกแล้ว เพื่อไม่ให้ Error 400)
    browser = await puppeteer.connect({
      browserWSEndpoint: `ws://localhost:3000?--window-size=1280,900`,
      defaultViewport: null
    });

    const page = await browser.newPage();
    if (COOKIES_JSON) {
        await page.setCookie(...JSON.parse(COOKIES_JSON));
        log("🍪", "โหลดคุกกี้เรียบร้อยแล้ว");
    }

    for (const url of GROUP_URLS) {
      log("🌐", `ตรวจสอบกลุ่ม: ${url}`);
      
      // 1. เปลี่ยนเป็น domcontentloaded เพื่อกันเว็บโหลดไม่จบแล้วแครช
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

      // 2. บังคับรอ 5 วินาที ให้ Facebook โหลดโครงสร้างหน้าเว็บให้เสร็จชัวร์ๆ ก่อน
      log("⏳", "รอ Facebook เรนเดอร์หน้าเว็บ 5 วินาที...");
      await new Promise(res => setTimeout(res, 5000));

      try {
        // 3. ลองดึงจำนวนโพสต์
        const postsCount = await page.evaluate(() => document.querySelectorAll("div[role='article']").length);
        
        if (postsCount === 0) {
          log("🛑", "หน้ากั้น! บอทไม่เจอโพสต์ (อาจติดหน้า Login หรือ Captcha)");
          log("👉", `คลิกที่นี่เพื่อเปิดหน้าจอแก้ปัญหาด้วยมือ: ${PUBLIC_URL}/sessions`);
          log("⏳", "บอทจะจอดรอ 2 นาที ให้คุณเข้าไปจัดการในหน้าจอ...");
          
          // รอ 2 นาที
          await new Promise(res => setTimeout(res, 120000)); 
          
          log("🔄", "ครบ 2 นาทีแล้ว บอทจะประมวลผลข้อมูลต่อ...");
        } else {
          log("✅", `เจอโพสต์จำนวน ${postsCount} โพสต์ ลุยงานต่อ...`);
          // ใส่โค้ดดูดข้อมูลต่อตรงนี้
        }
      } catch (err) {
        log("⚠️", `อ่านหน้าเว็บไม่ได้ (โครงสร้างเว็บอาจถูกเปลี่ยนกะทันหัน): ${err.message}`);
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
