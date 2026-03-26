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
const SCROLL_COUNT = 15; 

const log = (emoji, message) => console.log(`[${new Date().toLocaleString("th-TH", { timeZone: TZ })}] ${emoji} ${message}`);
const randomDelay = (min, max) => new Promise(res => setTimeout(res, Math.floor(Math.random() * (max - min + 1) + min)));

async function getRecentContents(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!F:F` });
    if (!res.data.values) return new Set();
    return new Set(res.data.values.flat().map(c => c ? c.trim() : "").filter(Boolean));
  } catch (e) { return new Set(); }
}

async function runJob() {
  log("🚀", "--- เริ่มงาน: Full Hybrid Scraper (Auto-Rescue + Remote) ---");
  let browser;
  let retryCount = 0;
  const maxRetries = 5;

  while (retryCount < maxRetries) {
    try {
      browser = await puppeteer.connect({
        browserWSEndpoint: `ws://127.0.0.1:3000?--window-size=1280,900`,
        defaultViewport: null
      });
      log("📡", "เชื่อมต่อหน้าจอสำเร็จ!");
      break; 
    } catch (err) {
      retryCount++;
      log("⏳", `รอหน้าจอพร้อม (รอบที่ ${retryCount}/${maxRetries})...`);
      await new Promise(res => setTimeout(res, 5000));
    }
  }

  if (!browser) return log("💀", "เชื่อมต่อหน้าจอไม่ได้ หยุดงาน");

  try {
    const rawAuth = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS;
    const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(rawAuth), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    const sheets = google.sheets({ version: "v4", auth });
    const existingContents = await getRecentContents(sheets);
    const page = await browser.newPage();

    if (COOKIES_JSON) {
      try { await page.setCookie(...JSON.parse(COOKIES_JSON)); } catch (e) { log("⚠️", "Cookie ผิดรูปแบบ"); }
    }

    let allRows = [];
    for (const url of GROUP_URLS) {
      log("🌐", `ตรวจสอบกลุ่ม: ${url}`);
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
      await randomDelay(5000, 8000);

      // --- 🛠️ ส่วนกู้ชีพ: พยายามกด Continue เองก่อนจอดรอ ---
      let postsCount = await page.evaluate(() => document.querySelectorAll("div[role='article']").length);
      
      if (postsCount === 0) {
        log("🔍", "ไม่พบโพสต์... พยายามแก้หน้ากั้น Continue อัตโนมัติ");
        const autoClicked = await page.evaluate(() => {
          const keywords = ["Continue", "ดำเนินการต่อ", "ใช่", "ตกลง"];
          const btns = Array.from(document.querySelectorAll('div[role="button"], span, a, button'));
          const target = btns.find(b => keywords.some(k => b.innerText.includes(k)));
          if (target) { target.click(); return true; }
          return false;
        });

        if (autoClicked) {
          log("🖱️", "บอทกดปุ่มให้แล้ว! รอโหลด 15 วินาที...");
          await randomDelay(15000, 20000);
          postsCount = await page.evaluate(() => document.querySelectorAll("div[role='article']").length);
        }
      }

      // --- 🛑 ถ้ายัง 0 โพสต์อยู่ ให้พี่รีโมทเข้ามาจิ้มเอง ---
      if (postsCount === 0) {
        log("🛑", "ยังติดหน้ากั้น! บอทจะจอดรอ 2 นาที ให้พี่เปิด /debugger ไปกดเอง...");
        await new Promise(res => setTimeout(res, 120000)); 
      }

      log("✅", "เริ่มกระบวนการไถหน้าจอ...");
      for (let i = 1; i <= SCROLL_COUNT; i++) {
        await page.evaluate(() => window.scrollBy(0, 1000));
        const clicked = await page.evaluate(async () => {
          const keywords = ["ดูเพิ่มเติม", "ความคิดเห็นเพิ่มเติม", "การตอบกลับ", "ดูเพิ่ม"];
          const btns = Array.from(document.querySelectorAll('div[role="button"], span')).filter(el => keywords.some(k => el.innerText.includes(k)));
          btns.forEach(b => b.click());
          return btns.length;
        });
        await randomDelay(3000, 4000);
        log(" ↳", `ไถรอบที่ ${i}: [กางปุ่ม: ${clicked}]`);
      }

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

      const newItems = finalPosts.filter(p => p.text.length > 10 && !existingContents.has(p.text));
      newItems.forEach(p => {
        allRows.push([new Date().toLocaleString("th-TH", { timeZone: TZ }), url, p.link, p.author, "", p.text]);
        existingContents.add(p.text);
      });
    }

    if (allRows.length > 0) {
      await sheets.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:A`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values: allRows } });
      log("✅", `บันทึกข้อมูลใหม่ ${allRows.length} รายการ`);
    }
  } catch (e) { log("💀", `Error: ${e.message}`); }
  finally { if (browser) await browser.disconnect(); log("🏁", "จบงาน"); }
}

const app = express();
app.get("/", (req, res) => res.send("<h1>Bot Active</h1><p>เข้าดูหน้าจอกดรหัสได้ที่ <a href='/debugger'>/debugger</a></p>"));
app.listen(8080, "0.0.0.0", () => {
  log("📶", "ตัวควบคุมบอท Standby ที่ Port 8080");
  cron.schedule("*/20 * * * *", runJob);
  if (process.env.RUN_ON_START === "true") runJob();
});
