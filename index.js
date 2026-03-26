import cron from "node-cron";
import express from "express";
import puppeteer from "puppeteer";
import { google } from "googleapis";

// -------------------- Config --------------------
const SHEET_ID = process.env.SHEET_ID || "";
const SHEET_NAME = process.env.SHEET_NAME || "Raw";
const GROUP_URLS = (process.env.GROUP_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
const COOKIES_JSON = process.env.COOKIES_JSON || "";
const TZ = "Asia/Bangkok";
const SCROLL_COUNT = 15; // จำนวนรอบที่ไถหน้าจอลงล่าง

const log = (emoji, message) => console.log(`[${new Date().toLocaleString("th-TH", { timeZone: TZ })}] ${emoji} ${message}`);
const randomDelay = (min, max) => new Promise(res => setTimeout(res, Math.floor(Math.random() * (max - min + 1) + min)));

// ฟังก์ชันดึงข้อมูลล่าสุดจาก Sheets เพื่อเช็คซ้ำ
async function getRecentContents(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!F:F` });
    if (!res.data.values) return new Set();
    return new Set(res.data.values.flat().map(c => c ? c.trim() : "").filter(Boolean));
  } catch (e) { return new Set(); }
}

async function runJob() {
  log("🚀", "--- เริ่มงาน: Hybrid Scraper (ไถเอง + พี่กดเอง) ---");
  let browser;
  try {
    const rawAuth = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS;
    const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(rawAuth), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    const sheets = google.sheets({ version: "v4", auth });
    const existingContents = await getRecentContents(sheets);

    // 🔥 เชื่อมต่อไปยังหน้าจอ Docker (Port 3000)
    browser = await puppeteer.connect({
      browserWSEndpoint: `ws://localhost:3000?--window-size=1280,900`,
      defaultViewport: null
    });

    const page = await browser.newPage();
    if (COOKIES_JSON) {
      await page.setCookie(...JSON.parse(COOKIES_JSON));
    }

    let allRows = [];
    for (const url of GROUP_URLS) {
      log("🌐", `ตรวจสอบกลุ่ม: ${url}`);
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
      await randomDelay(5000, 7000);

      // --- 🛠️ ส่วนเช็คหน้ากั้น (ถ้า 0 โพสต์ พี่รีโมทเข้าไปกดเอง) ---
      const postsCount = await page.evaluate(() => document.querySelectorAll("div[role='article']").length);
      if (postsCount === 0) {
        log("🛑", "ตรวจพบหน้ากั้น! บอทจะจอดรอ 2 นาที ให้พี่เปิด /debugger ไปกดให้ผ่าน...");
        await new Promise(res => setTimeout(res, 120000)); 
      }

      log("✅", "เริ่มกระบวนการไถหน้าจอ (Auto Scroll & Expand)...");

      // --- 🛠️ ส่วนไถหน้าจออัตโนมัติ (Scraping Logic) ---
      for (let i = 1; i <= SCROLL_COUNT; i++) {
        await page.evaluate(() => window.scrollBy(0, 1000));
        const clicked = await page.evaluate(async () => {
          const keywords = ["ดูเพิ่มเติม", "ความคิดเห็นเพิ่มเติม", "การตอบกลับ", "ดูเพิ่ม"];
          const btns = Array.from(document.querySelectorAll('div[role="button"], span')).filter(el => keywords.some(k => el.innerText.includes(k)));
          btns.forEach(b => b.click());
          return btns.length;
        });
        await randomDelay(3000, 4000);
        log(" ↳", `ไถรอบที่ ${i}: [กางปุ่มเพิ่ม: ${clicked}]`);
      }

      // ดึงข้อมูลโพสต์และ Clean คำขยะ
      const finalPosts = await page.$$eval("div[role='article']", (articles) => {
        return articles.map(a => {
          const link = a.querySelector("a[href*='/posts/'], a[href*='/permalink/']")?.href.split('?')[0] || "";
          const author = a.querySelector("h3 span a, strong a")?.innerText.trim() || "Unknown";
          let txt = a.innerText.trim();
          const junk = ["ถูกใจ", "แชร์", "ตอบกลับ", "ส่ง", "เขียนความคิดเห็น..."];
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

    // บันทึกลง Google Sheets
    if (allRows.length > 0) {
      await sheets.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:A`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values: allRows } });
      log("✅", `บันทึกข้อมูลใหม่สำเร็จ ${allRows.length} รายการ`);
    }

  } catch (e) { log("💀", `Error: ${e.message}`); }
  finally { if (browser) await browser.disconnect(); log("🏁", "จบงานรอบนี้"); }
}

// -------------------- Express Server --------------------
const app = express();
app.get("/", (req, res) => res.send("<h1>Bot Active</h1><p>เข้าดูหน้าจอกดรหัสได้ที่ <a href='/debugger'>/debugger</a></p>"));
app.listen(process.env.PORT || 3000, () => {
  log("📶", `Server standby on port ${process.env.PORT || 3000}`);
  cron.schedule("*/20 * * * *", runJob); // รันทุก 20 นาที
  if (process.env.RUN_ON_START === "true") runJob();
});
