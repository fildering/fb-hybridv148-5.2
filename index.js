import cron from "node-cron";
import puppeteer from "puppeteer";
import { google } from "googleapis";

const SHEET_ID = process.env.SHEET_ID || "";
const GROUP_URLS = (process.env.GROUP_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
const COOKIES_JSON = process.env.COOKIES_JSON || "";
const TZ = "Asia/Bangkok";

const log = (emoji, message) => console.log(`[${new Date().toLocaleString("th-TH", { timeZone: TZ })}] ${emoji} ${message}`);

async function runJob() {
  log("🚀", "--- เริ่มงานกวาดข้อมูล ---");
  let browser;
  try {
    const rawAuth = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS;
    if (rawAuth) {
        const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(rawAuth), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
        google.sheets({ version: "v4", auth });
    }

    browser = await puppeteer.connect({
      browserWSEndpoint: `ws://localhost:3000?--window-size=1280,900`,
      defaultViewport: null
    });

    const page = await browser.newPage();
    
    // โหลดคุกกี้เก่า (ถ้ามี)
    if (COOKIES_JSON) {
        await page.setCookie(...JSON.parse(COOKIES_JSON));
    }

    // ----------------------------------------------------
    // ระบบ Auto-Login
    // ----------------------------------------------------
    log("🔑", "ตรวจสอบสถานะการล็อกอิน Facebook...");
    await page.goto("https://www.facebook.com", { waitUntil: "domcontentloaded" });
    await new Promise(res => setTimeout(res, 3000));

    // เช็คว่ามีช่องให้กรอกอีเมลไหม ถ้ามีแปลว่ายังไม่ได้ล็อกอิน
    const emailInput = await page.$('#email');
    if (emailInput) {
        log("🤖", "บอทกำลังพิมพ์อีเมลและรหัสผ่านเพื่อล็อกอิน...");
        if (!process.env.FB_EMAIL || !process.env.FB_PASS) {
            log("❌", "ล้มเหลว! คุณยังไม่ได้ใส่ FB_EMAIL หรือ FB_PASS ในหน้า Variables ของ Railway");
            throw new Error("Missing Login Credentials");
        }
        
        await page.type('#email', process.env.FB_EMAIL, { delay: 50 });
        await page.type('#pass', process.env.FB_PASS, { delay: 50 });
        await page.click('[name="login"]');
        
        log("⏳", "กดเข้าสู่ระบบแล้ว กำลังรอ Facebook โหลด...");
        await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => log("⚠️", "รอหน้าเว็บโหลดนานเกินไป (อาจจะติดขัดเล็กน้อย)"));
        await new Promise(res => setTimeout(res, 5000));
        
        const currentUrl = await page.url();
        if (currentUrl.includes('checkpoint') || currentUrl.includes('challenge')) {
            log("🛑", "งานเข้า! Facebook สงสัยว่าบอทเป็นแฮกเกอร์ เลยติดหน้า Checkpoint (ยืนยันตัวตน) ครับ");
        } else {
            log("✅", "ล็อกอินสำเร็จ! เตรียมลุยกลุ่ม...");
        }
    } else {
        log("🆗", "ล็อกอินค้างไว้อยู่แล้ว ลุยต่อได้เลย!");
    }
    // ----------------------------------------------------

    for (const url of GROUP_URLS) {
      log("🌐", `ตรวจสอบกลุ่ม: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await new Promise(res => setTimeout(res, 5000));

      try {
        const postsCount = await page.evaluate(() => document.querySelectorAll("div[role='article']").length);
        
        if (postsCount === 0) {
          const currentTitle = await page.title();
          log("🛑", `บอทติดหน้ากั้นในกลุ่ม! (สถานะ: ${currentTitle})`);
        } else {
          log("✅", `เจอโพสต์จำนวน ${postsCount} โพสต์`);
          // เดี๋ยวเรามาใส่โค้ดดูดข้อมูลต่อตรงนี้
        }
      } catch (err) {
        log("⚠️", `อ่านหน้าเว็บไม่ได้: ${err.message}`);
      }
    }
  } catch (e) { 
      log("💀", e.message); 
  } finally { 
      if (browser) await browser.disconnect(); 
      log("🏁", "จบงานรอบนี้ รอเวลารอบต่อไป..."); 
  }
}

log("🤖", "Bot Ready! รอเวลาทำงาน...");
cron.schedule("*/20 * * * *", runJob);
if (process.env.RUN_ON_START === "true") runJob();
