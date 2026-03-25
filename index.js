import cron from "node-cron";
import express from "express";
import puppeteer from "puppeteer";
import { google } from "googleapis";
import axios from "axios";
import FormData from "form-data";

// -------------------- Configuration --------------------
const SHEET_ID = process.env.SHEET_ID || process.env.GOOGLE_SHEET_ID || "";
const SHEET_NAME = process.env.SHEET_NAME || "Raw";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const COOKIES_JSON = process.env.COOKIES_JSON || "";
const GROUP_URLS = (process.env.GROUP_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
const SCROLL_LOOPS = parseInt(process.env.SCROLL_LOOPS) || 5;
const TZ = process.env.TZ || "Asia/Bangkok";

const randomDelay = (min, max) => new Promise(res => setTimeout(res, Math.floor(Math.random() * (max - min + 1) + min)));

function log(emoji, message) {
  const now = new Date().toLocaleString("th-TH", { timeZone: TZ });
  console.log(`[${now}] ${emoji} ${message}`);
}

// --- ระบบแจ้งเตือน Discord (เน้นส่งรูปให้สำเร็จก่อนปิด Browser) ---
async function notifyDiscord(message, screenshotBuffer = null) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const form = new FormData();
    form.append("content", `📢 **FB Scraper Alert**\n${message}`);
    if (screenshotBuffer) {
      form.append("file", screenshotBuffer, { filename: "alert.png", contentType: "image/png" });
    }
    await axios.post(DISCORD_WEBHOOK_URL, form, { 
      headers: { ...form.getHeaders() },
      timeout: 30000 
    });
    log("📸", "ส่งรูปหลักฐานไป Discord เรียบร้อย");
  } catch (e) { log("❌", `Discord Error: ${e.message}`); }
}

// --- ฟังก์ชันดึง Link ทั้งหมดจาก Sheets มาเช็คซ้ำ ---
async function getExistingLinks(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!C:C`,
    });
    const links = res.data.values ? res.data.values.flat() : [];
    log("📊", `อ่าน Sheets สำเร็จ: ตรวจพบลิงก์เดิมทั้งหมด ${links.length} รายการ`);
    return new Set(links);
  } catch (e) { 
    log("⚠️", `ยังอ่าน Sheets ไม่ได้ (อาจจะยังไม่มีข้อมูล): ${e.message}`);
    return new Set(); 
  }
}

async function runJob() {
  log("🚀", "--- เริ่มต้นการทำงาน (Full Version: Log + Stealth + Dedupe) ---");
  let browser;
  try {
    const rawAuth = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS;
    const auth = new google.auth.GoogleAuth({ 
      credentials: JSON.parse(rawAuth), 
      scopes: ["https://www.googleapis.com/auth/spreadsheets"] 
    });
    const sheets = google.sheets({ version: "v4", auth });

    const existingLinks = await getExistingLinks(sheets);
    
    browser = await puppeteer.launch({ 
      headless: "new", 
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--incognito", "--disable-blink-features=AutomationControlled"] 
    });
    
    const page = await browser.newPage();
    await page.setUserAgent(process.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0");

    if (COOKIES_JSON) {
      const cookies = JSON.parse(COOKIES_JSON.replace(/[\u0000-\u001F\u007F-\u009F]/g, ""));
      await page.setCookie(...cookies.map(c => ({ ...c, domain: c.domain || ".facebook.com", path: c.path || "/" })));
      log("🍪", "โหลด Cookie เรียบร้อย");
    }

    let allRows = [];
    for (const url of GROUP_URLS) {
      log("🌐", `กำลังเข้าตรวจสอบกลุ่ม: ${url}`);
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
      await randomDelay(4000, 6000);

      // ตรวจสอบหน้าด่าน
      if (page.url().includes("checkpoint") || !!(await page.$('input[name="pass"]'))) {
        log("🚨", "ติดด่านตรวจ Facebook! กำลังแคปภาพส่ง Discord...");
        const screen = await page.screenshot();
        await notifyDiscord(`บอทติดด่านที่กลุ่ม: ${url}\nรบกวนพี่ฟิวส์เช็ค Cookie ใน Railway ด้วยครับ`, screen);
        await randomDelay(5000, 8000); // รอให้ส่งรูปเสร็จ
        return; 
      }

      log("🖱️", `กำลังไถหน้าจอหาโพสต์ (ตั้งไว้ ${SCROLL_LOOPS} รอบ)`);
      for (let i = 0; i < SCROLL_LOOPS; i++) {
        await page.evaluate(() => window.scrollBy(0, 800 + Math.random() * 400));
        await randomDelay(2500, 4000);
        if ((i + 1) % 2 === 0 || i + 1 === SCROLL_LOOPS) log("  ↳", `Scroll Loop: ${i + 1}/${SCROLL_LOOPS} ...`);
      }

      // --- ส่วนดึงข้อมูล (Selector ปรับปรุงใหม่ให้มองเห็นโพสต์ได้ดีขึ้น) ---
      const posts = await page.$$eval("div[role='article'], div[data-ad-preview='subject'], div.x1yzt60o", (articles) => {
        return articles.map(a => {
          const linkEl = a.querySelector("a[href*='/posts/'], a[href*='/permalink/'], a[href*='comment_id']");
          const link = linkEl ? linkEl.href.split('?')[0] : ""; // ตัดพวกพารามิเตอร์ต่อท้ายออกเพื่อให้เช็คซ้ำแม่นขึ้น
          
          const authorEl = a.querySelector("h3 span a, strong a, span[dir='auto'] a");
          const author = authorEl ? authorEl.innerText.trim() : "Unknown";
          
          const textEl = a.querySelector('div[dir="auto"], div.x1iorvi4, div.x1y1aw1k');
          const text = textEl ? textEl.innerText.trim() : "";
          
          return { link, author, text };
        });
      });

      const newPosts = posts.filter(p => p.link && p.text.length > 5 && !existingLinks.has(p.link));
      log("📥", `ผลลัพธ์: เจอทั้งหมด ${posts.length} โพสต์ | เป็นโพสต์ใหม่ ${newPosts.length} โพสต์`);
      
      newPosts.forEach(p => {
        allRows.push([new Date().toLocaleString("th-TH", { timeZone: TZ }), url, p.link, p.author, "", p.text]);
        existingLinks.add(p.link); 
      });
      await randomDelay(3000, 5000);
    }

    if (allRows.length > 0) {
      log("📝", `กำลังบันทึก ${allRows.length} โพสต์ใหม่ลง Google Sheets...`);
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A:Z`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: allRows },
      });
      log("✅", "บันทึกข้อมูลสำเร็จ!");
    } else {
      log("😴", "รอบนี้ไม่มีโพสต์ใหม่ที่ยังไม่เคยเก็บ");
    }

  } catch (e) { log("❌", `เกิดข้อผิดพลาด: ${e.message}`); }
  finally { if (browser) await browser.close(); log("🏁", "--- จบการทำงานรอบนี้ ---"); }
}

const app = express();
app.get("/", (req, res) => res.send("Bot is running..."));
app.listen(process.env.PORT || 8080, () => {
  log("🤖", "บอทเปิดใช้งานแล้ว (เวอร์ชัน Full Reports)");
  cron.schedule(process.env.CRON_SCHEDULE || "*/20 * * * *", runJob);
  if (process.env.RUN_ON_START === "true") runJob();
});
