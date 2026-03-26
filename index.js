import cron from "node-cron";
import puppeteer from "puppeteer";
import { google } from "googleapis";

const SHEET_ID = process.env.SHEET_ID || "";
const GROUP_URLS = (process.env.GROUP_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
const COOKIES_JSON = process.env.COOKIES_JSON || "";
const TZ = "Asia/Bangkok";

// สร้างลิงก์เข้าหน้า Debugger รีโมทหน้าจอ (ใช้ /debugger/ แทน /sessions)
const PUBLIC_URL = process.env.RAILWAY_PUBLIC_DOMAIN 
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` 
  : "http://localhost:3000";
const DEBUGGER_URL = `${PUBLIC_URL}/debugger/`;

const log = (emoji, message) => console.log(`[${new Date().toLocaleString("th-TH", { timeZone: TZ })}] ${emoji} ${message}`);

async function runJob() {
  log("🚀", "--- เริ่มงานโหมดรีโมท (Interactive Mode) ---");
  let browser;
  try {
    const rawAuth = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS;
    
    // เช็คว่ามี Credentials ก่อน ค่อยพยายามต่อ Google Sheets 
    let auth, sheets;
    if (rawAuth) {
        auth = new google.auth.GoogleAuth({ credentials: JSON.parse(rawAuth), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
        sheets = google.sheets({ version: "v4", auth });
    }

    // เกาะไปที่หน้าจอ Browserless
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
      
      // รอโหลดโครงสร้างเว็บให้เสร็จ
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

      // รอ Facebook เรนเดอร์ชัวร์ๆ 5 วินาที
      await new Promise(res => setTimeout(res, 5000));

      try {
        const postsCount = await page.evaluate(() => document.querySelectorAll("div[role='article']").length);
        
        if (postsCount === 0) {
          const currentUrl = await page.url();
          log("🛑", "หน้ากั้น! บอทหาโพสต์ไม่เจอ (อาจจะติด Login, Checkpoint หรือคุกกี้หลุด)");
          log("🔗", `บอทกำลังติดอยู่ที่ URL: ${currentUrl}`);
          
          // แจ้งลิงก์ Debugger ให้คลิกง่ายๆ จากใน Log
          log("👉", `คลิกที่นี่เพื่อเข้าไปรีโมทแก้ปัญหา: ${DEBUGGER_URL}`);
          log("⏳", "บอทจะเปิดจอรอไว้ 5 นาที! ให้คุณเข้าไปพิมพ์ Login หรือแก้ปัญหาให้เสร็จ...");
          
          // รอ 5 นาที (300,000 ms) ให้เวลาคนเข้าไปกดแก้
          await new Promise(res => setTimeout(res, 300000)); 
          
          log("🔄", "ครบ 5 นาทีแล้ว บอทจะเริ่มทำงานต่อจากหน้าจอที่คุณแก้งานทิ้งไว้...");
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
