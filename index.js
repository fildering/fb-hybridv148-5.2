import cron from "node-cron";
import express from "express";
import puppeteer from "puppeteer";
import { google } from "googleapis";
import axios from "axios";
import FormData from "form-data";

// -------------------- Config --------------------
const SHEET_ID = process.env.SHEET_ID || "";
const SHEET_NAME = process.env.SHEET_NAME || "Raw";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const COOKIES_JSON = process.env.COOKIES_JSON || "";
const GROUP_URLS = (process.env.GROUP_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
const TZ = "Asia/Bangkok";
const SCROLL_COUNT = 15; 

const log = (emoji, message) => console.log(`[${new Date().toLocaleString("th-TH", { timeZone: TZ })}] ${emoji} ${message}`);
const randomDelay = (min, max) => new Promise(res => setTimeout(res, Math.floor(Math.random() * (max - min + 1) + min)));

// --- เช็คช่วงเวลา Peak Time ---
function isPeakTime() {
  const hour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(new Date()));
  return hour >= 8 || hour === 0; 
}

async function notifyDiscord(message, screenshotBuffer = null) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const form = new FormData();
    form.append("content", `📢 **FB Scraper Alert**\n${message}`);
    if (screenshotBuffer) form.append("file", screenshotBuffer, { filename: "alert.png", contentType: "image/png" });
    await axios.post(DISCORD_WEBHOOK_URL, form, { headers: { ...form.getHeaders() }, timeout: 30000 });
  } catch (e) { log("❌", "Discord Notify Error"); }
}

async function getRecentContents(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!F:F` });
    if (!res.data.values) return new Set();
    return new Set(res.data.values.flat().map(c => c ? c.trim() : "").filter(Boolean));
  } catch (e) { return new Set(); }
}

async function runJob() {
  log("🚀", "--- เริ่มงาน: Full Feature Mode ---");
  let browser;
  try {
    const rawAuth = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS;
    const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(rawAuth), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    const sheets = google.sheets({ version: "v4", auth });
    const existingContents = await getRecentContents(sheets);
    
    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0");

    if (COOKIES_JSON) {
      const cookies = JSON.parse(COOKIES_JSON.replace(/[\u0000-\u001F\u007F-\u009F]/g, ""));
      await page.setCookie(...cookies.map(c => ({ ...c, domain: c.domain || ".facebook.com", path: c.path || "/" })));
    }

    let allRows = [];
    for (const url of GROUP_URLS) {
      log("🌐", `ตรวจสอบกลุ่ม: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await randomDelay(7000, 10000); // รอโหลดหน้าแรกให้ชัวร์

      // 🔥 ฟีเจอร์: เจอ 0 แล้วหยุด + ส่งรูป
      const initPostCount = await page.evaluate(() => document.querySelectorAll("div[role='article']").length);
      if (initPostCount === 0) {
        log("🚨", "หาโพสต์ไม่เจอ (0 โพสต์)! หยุดรันและส่งรูปแจ้งเตือน");
        const screen = await page.screenshot();
        await notifyDiscord(`🆘 ตรวจพบ 0 โพสต์ที่กลุ่ม: ${url}\nสันนิษฐานว่าติดหน้ากั้น/Cookie หลุด`, screen);
        return; 
      }

      for (let i = 1; i <= SCROLL_COUNT; i++) {
        await page.evaluate(() => window.scrollBy(0, 1000));
        
        // ฟีเจอร์: กางปุ่มทุกประเภท
        const clicked = await page.evaluate(async () => {
          const keywords = ["ดูเพิ่มเติม", "See more", "ความคิดเห็นเพิ่มเติม", "การตอบกลับ", "ดูเพิ่ม"];
          const btns = Array.from(document.querySelectorAll('div[role="button"], span')).filter(el => keywords.some(k => el.innerText.includes(k)));
          btns.forEach(b => b.click());
          return btns.length;
        });

        await randomDelay(2500, 3500);
        const currentPosts = await page.$$eval("div[role='article']", (articles) => articles.map(a => a.innerText.trim()));
        const newOnScreen = currentPosts.filter(p => p.length > 10 && !existingContents.has(p)).length;
        log("📑", `รอบที่ ${i}/${SCROLL_COUNT}: [กางปุ่ม: ${clicked}] | [พบใหม่หน้าจอนี้: ${newOnScreen}] | [ซ้ำ: ${currentPosts.length - newOnScreen}]`);
      }

      // ฟีเจอร์: ดึงข้อมูล + Clean ขยะ UI
      const finalPosts = await page.$$eval("div[role='article']", (articles) => {
        return articles.map(a => {
          const link = a.querySelector("a[href*='/posts/'], a[href*='/permalink/']")?.href.split('?')[0] || "";
          const author = a.querySelector("h3 span a, strong a")?.innerText.trim() || "Unknown";
          let txt = a.innerText.trim();
          const junk = ["ถูกใจ", "แชร์", "ตอบกลับ", "ส่ง", "เขียนความคิดเห็น...", "ดูความคิดเห็นเพิ่มเติม"];
          junk.forEach(w => { const regex = new RegExp(`^${w}$|^${w}\\n|\\n${w}$|\\n${w}\\n`, 'gm'); txt = txt.replace(regex, "\n"); });
          return { link, author, text: txt.replace(/\n\s*\n/g, '\n').trim() };
        });
      });

      const newToSave = finalPosts.filter(p => p.text.length > 10 && !existingContents.has(p.text));
      newToSave.forEach(p => {
        allRows.push([new Date().toLocaleString("th-TH", { timeZone: TZ }), url, p.link, p.author, "", p.text]);
        existingContents.add(p.text);
      });
    }

    if (allRows.length > 0) {
      await sheets.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:A`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values: allRows } });
      log("✅", `บันทึกข้อมูลใหม่ ${allRows.length} รายการ`);
    }
  } catch (e) { log("💀", `Error: ${e.message}`); }
  finally { if (browser) await browser.close(); log("🏁", "จบงาน"); }
}

const app = express();
app.get("/", (req, res) => res.send("Active"));
app.listen(process.env.PORT || 8080, () => {
  // ฟีเจอร์: Dynamic Schedule
  cron.schedule(process.env.CRON_SCHEDULE || "*/20 * * * *", () => {
    if (isPeakTime()) { runJob(); } 
    else if (new Date().getMinutes() < 20) { runJob(); } 
    else { log("💤", "ช่วง Off-Peak: ข้ามรอบนี้"); }
  });
  if (process.env.RUN_ON_START === "true") runJob();
});
