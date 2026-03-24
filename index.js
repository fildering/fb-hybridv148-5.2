import cron from "node-cron";
import express from "express";
import puppeteer from "puppeteer";
import { google } from "googleapis";
import axios from "axios"; // เพิ่มตัวนี้เพื่อส่ง Discord (อย่าลืมเช็คใน package.json)

// -------------------- Configuration --------------------
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "*/15 * * * *";
const RUN_ON_START = (process.env.RUN_ON_START || "true").toLowerCase() === "true";
const TZ = process.env.TZ || "Asia/Bangkok";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || ""; // ใส่ URL Webhook ใน Railway

const SHEET_ID = process.env.SHEET_ID || process.env.GOOGLE_SHEET_ID || "";
const SHEET_NAME = process.env.SHEET_NAME || "Raw";
const GROUP_URLS = (process.env.GROUP_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
const COOKIES_JSON = process.env.COOKIES_JSON || "";

const MAX_POSTS_PER_GROUP = Number(process.env.MAX_POSTS_PER_GROUP || 10);
const SCROLL_LOOPS = Number(process.env.SCROLL_LOOPS || 1); 
const SCROLL_PAUSE_MS = Number(process.env.SCROLL_PAUSE_MS || 2000);

function log(...args) {
  const now = new Date().toLocaleString("en-GB", { timeZone: TZ });
  console.log(`[${now}]`, ...args);
}

// --- ฟังก์ชันแจ้งเตือน Discord ---
async function notifyDiscord(message) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await axios.post(DISCORD_WEBHOOK_URL, { content: `🚨 **FB Bot Alert:** ${message}` });
  } catch (e) { log("❌ Discord Notify Error:", e.message); }
}

// -------------------- Google Sheets --------------------
async function appendRowsToSheet(rows) {
  if (!SHEET_ID || !rows.length) return;
  try {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS;
    const key = JSON.parse(raw);
    const auth = new google.auth.GoogleAuth({ credentials: key, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:Z`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows },
    });
    log(`✅ Appended ${rows.length} row(s) to Sheets`);
  } catch (e) { log("❌ Sheets Error:", e.message); }
}

// -------------------- Puppeteer --------------------
async function launchBrowser() {
  return puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote", "--single-process"],
  });
}

async function handleLoginCheck(page) {
  const url = page.url();
  // เช็คหน้าต่าง "ดำเนินการต่อในชื่อ..." (แบบที่พี่แคปมา)
  if (url.includes("checkpoint") || url.includes("login")) {
    log("⚠️ Detected login/checkpoint page. Trying to bypass...");
    try {
      await page.evaluate(() => {
        // ลองหาปุ่ม "ดำเนินการต่อ" หรือ "Log In"
        const btns = Array.from(document.querySelectorAll('div[role="button"], button'))
          .filter(b => b.innerText.includes("ดำเนินการต่อ") || b.innerText.includes("Continue") || b.innerText.includes("Log In"));
        if (btns.length > 0) btns[0].click();
      });
      await new Promise(r => setTimeout(r, 5000)); // รอดูผลลัพธ์
    } catch (e) { log("❌ Bypass failed:", e.message); }
  }
}

async function scrapeGroup(page, groupUrl) {
  log("Scraping:", groupUrl);
  try {
    await page.goto(groupUrl, { waitUntil: "networkidle2", timeout: 60000 });
    
    await handleLoginCheck(page); // ลองทะลวงด่านก่อน

    if (page.url().includes("/login") || page.url().includes("checkpoint")) {
      return { status: "login_required", rows: [] };
    }

    for (let i = 0; i < SCROLL_LOOPS; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise(r => setTimeout(r, SCROLL_PAUSE_MS));
    }

    // คลิก ดูเพิ่มเติม
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('div[role="button"]')).filter(b => b.innerText === "ดูเพิ่มเติม" || b.innerText === "See more");
      btns.forEach(b => b.click());
    });
    await new Promise(r => setTimeout(r, 2000));

    const posts = await page.$$eval("div[role='article']", (articles) => {
      return articles.map(a => {
        const anchors = Array.from(a.querySelectorAll("a")).map(x => x.href);
        const permalink = anchors.find(h => h.includes("/posts/") || h.includes("/permalink/")) || "";
        const author = (a.querySelector("h3 a, strong a, a[role='link']")?.innerText || "Unknown").trim();
        const contentEl = a.querySelector('div[data-ad-preview="message"]');
        let text = contentEl ? contentEl.innerText.trim() : (Array.from(a.querySelectorAll('div[dir="auto"]')).map(el => el.innerText.trim()).sort((x, y) => y.length - x.length)[0] || "");
        return { permalink, author, text: text.replace(/ดูเพิ่มเติม|See more/g, "").trim().slice(0, 5000) };
      });
    });

    return { status: "ok", rows: posts.filter(p => p.permalink && p.text.length > 2).slice(0, MAX_POSTS_PER_GROUP) };
  } catch (e) { return { status: "error", rows: [] }; }
}

async function runJob() {
  log("🚀 Job Started");
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    // ปรับ User-Agent ให้เนียน (ก๊อปจากเครื่องพี่มาเปลี่ยนตรงนี้ได้ครับ)
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

    if (COOKIES_JSON) {
      const cleanJson = COOKIES_JSON.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
      const cookies = JSON.parse(cleanJson);
      await page.setCookie(...cookies.map(c => ({ ...c, domain: c.domain || ".facebook.com", path: c.path || "/" })));
    }

    const allRows = [];
    const nowIso = new Date().toISOString();
    for (const g of GROUP_URLS) {
      const res = await scrapeGroup(page, g);
      if (res.status === "login_required") {
        await notifyDiscord(`Session expired/Checkpoint detected! ด่านตรวจเด้งที่กลุ่ม: ${g}`);
        break;
      }
      res.rows.forEach(p => allRows.push([nowIso, g, p.permalink, p.author, "", p.text]));
    }
    await appendRowsToSheet(allRows);
    log("🏁 Job Finished");
  } catch (e) { 
    log("❌ Global Error:", e.message);
    await notifyDiscord(`บอท Error: ${e.message}`);
  } finally { if (browser) await browser.close(); }
}

const app = express();
app.get("/", (req, res) => res.send("Bot Active"));
app.listen(process.env.PORT || 8080, () => {
  log(`Server Active`);
  cron.schedule(CRON_SCHEDULE, runJob, { timezone: TZ });
  if (RUN_ON_START) runJob();
});
