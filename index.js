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
const TZ = "Asia/Bangkok";
const MAX_SCROLL_ATTEMPTS = 35; // ขยับให้เยอะขึ้นนิดหน่อยเพราะต้องเผื่อกางคอมเมนต์

const randomDelay = (min, max) => new Promise(res => setTimeout(res, Math.floor(Math.random() * (max - min + 1) + min)));

function log(emoji, message) {
  const now = new Date().toLocaleString("th-TH", { timeZone: TZ });
  console.log(`[${now}] ${emoji} ${message}`);
}

async function notifyDiscord(message, screenshotBuffer = null) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const form = new FormData();
    form.append("content", `📢 **FB Mega Scraper Alert**\n${message}`);
    if (screenshotBuffer) form.append("file", screenshotBuffer, { filename: "alert.png", contentType: "image/png" });
    await axios.post(DISCORD_WEBHOOK_URL, form, { headers: { ...form.getHeaders() }, timeout: 30000 });
  } catch (e) { log("❌", `Discord Error: ${e.message}`); }
}

// --- ฟังก์ชันดึงเฉพาะโพสต์ของ เมื่อวาน และ วันนี้ มาเช็คซ้ำ ---
async function getRecentLinks(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({ 
      spreadsheetId: SHEET_ID, 
      range: `${SHEET_NAME}!A:C` 
    });
    if (!res.data.values) return new Set();

    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    const recentLinks = res.data.values
      .filter(row => {
        if (!row[0]) return false;
        try {
          const [datePart] = row[0].split(' ');
          const [d, m, y] = datePart.split('/').map(Number);
          const rowDate = new Date(y, m - 1, d);
          return rowDate >= yesterday;
        } catch (e) { return true; }
      })
      .map(row => row[2]);

    log("📊", `โหลดข้อมูลจาก Sheets: พบโพสต์ล่าสุด (เมื่อวาน-วันนี้) ${recentLinks.length} รายการ`);
    return new Set(recentLinks);
  } catch (e) { 
    log("⚠️", `อ่าน Sheets ไม่สำเร็จ: ${e.message}`);
    return new Set(); 
  }
}

async function runJob() {
  log("🚀", "--- เริ่มต้นงาน (Mega Scraper v2: กางเม้น + ปิด Pop-up + เช็คของใหม่) ---");
  let browser;
  try {
    const rawAuth = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS;
    const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(rawAuth), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    const sheets = google.sheets({ version: "v4", auth });

    const existingLinks = await getRecentLinks(sheets);
    
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
      log("🌐", `ตรวจสอบกลุ่ม: ${url}`);
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
      await randomDelay(4000, 6000);

      // --- 1. Cleanup UI: ปิดหน้าต่างกวนใจก่อนเริ่ม ---
      await page.evaluate(() => {
        const closeBtns = Array.from(document.querySelectorAll('div[aria-label="ปฏิเสธ"], div[aria-label="Close"], div[aria-label="ปิด"], [role="button"] i.x1b0dc9'));
        closeBtns.forEach(btn => btn?.parentElement?.click() || btn?.click());
      });

      if (page.url().includes("checkpoint") || !!(await page.$('input[name="pass"]'))) {
        log("🚨", "ติดด่านตรวจ! แคปภาพแจ้งเตือน...");
        const screen = await page.screenshot();
        await notifyDiscord(`บอทติดด่านที่กลุ่ม: ${url}`, screen);
        return; 
      }

      let attempts = 0;
      let reachOldZone = false;

      log("🖱️", "กำลังไถหน้าจอ + กางคอมเมนต์ (สุ่มจังหวะคลิก)...");
      while (!reachOldZone && attempts < MAX_SCROLL_ATTEMPTS) {
        attempts++;
        await page.evaluate(() => window.scrollBy(0, 1200));
        await randomDelay(3000, 5000);

        // --- 2. Mega Expand: กดกางคอมเมนต์ทุกปุ่มที่เห็น ---
        await page.evaluate(async () => {
          const btns = Array.from(document.querySelectorAll('span, div[role="button"]'))
            .filter(el => el.innerText.includes("ดูความคิดเห็น") || el.innerText.includes("ดูเพิ่ม") || el.innerText.includes("View more comments"));
          for (const btn of btns) {
            btn.click();
            await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000)); // สุ่มเวลาระหว่างคลิก 1.5-3.5 วิ
          }
        });

        // --- 3. Time-Check: เจอโพสต์เก่า 2 วันขึ้นไป ให้หยุดไถ ---
        reachOldZone = await page.evaluate(() => {
          const timeEls = Array.from(document.querySelectorAll('a[aria-label*="วัน"]'));
          return timeEls.some(el => {
            const label = el.getAttribute('aria-label') || "";
            return label.includes('2 วัน') || label.includes('3 วัน') || label.includes('ปี');
          });
        });
        
        if (attempts % 5 === 0) log("  ↳", `ไถรอบที่ ${attempts}... กำลังกวาดเนื้อหา`);
      }

      const posts = await page.$$eval("div[role='article']", (articles) => {
        return articles.map(a => {
          const linkEl = a.querySelector("a[href*='/posts/'], a[href*='/permalink/']");
          const link = linkEl ? linkEl.href.split('?')[0] : "";
          const author = (a.querySelector("h3 span a, strong a, span[dir='auto'] a")?.innerText || "Unknown").trim();
          const text = (a.querySelector('div[dir="auto"], div.x1iorvi4')?.innerText || "").trim();
          return { link, author, text };
        });
      });

      const newPosts = posts.filter(p => p.link && p.text.length > 5 && !existingLinks.has(p.link));
      log("📥", `สรุปกลุ่มนี้: เจอใหม่ ${newPosts.length} รายการ (สแกนรวม ${posts.length} โพสต์)`);
      
      newPosts.forEach(p => {
        allRows.push([new Date().toLocaleString("th-TH", { timeZone: TZ }), url, p.link, p.author, "", p.text]);
        existingLinks.add(p.link);
      });
      await randomDelay(3000, 6000);
    }

    if (allRows.length > 0) {
      log("📝", `กำลังบันทึก ${allRows.length} รายการลง Google Sheets...`);
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:Z`,
        valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
        requestBody: { values: allRows },
      });
      log("✅", "บันทึกสำเร็จ!");
    } else {
      log("😴", "รอบนี้ไม่มีโพสต์ใหม่ที่น่าสนใจ");
    }

  } catch (e) { log("❌", `Error: ${e.message}`); }
  finally { if (browser) await browser.close(); log("🏁", "--- จบการทำงานรอบนี้ ---"); }
}

const app = express();
app.get("/", (req, res) => res.send("Mega Scraper is active..."));
app.listen(process.env.PORT || 8080, () => {
  log("🤖", "บอทเปิดตัวฉบับเต็มรูปแบบ (Mega Scraper Online)");
  cron.schedule(process.env.CRON_SCHEDULE || "*/20 * * * *", runJob);
  if (process.env.RUN_ON_START === "true") runJob();
});
