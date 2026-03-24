import cron from "node-cron";
import express from "express";
import puppeteer from "puppeteer";
import { google } from "googleapis";

// -------------------- Configuration --------------------
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "*/15 * * * *";
const RUN_ON_START = (process.env.RUN_ON_START || "true").toLowerCase() === "true";
const TZ = process.env.TZ || "Asia/Bangkok";

const SHEET_ID = process.env.SHEET_ID || process.env.GOOGLE_SHEET_ID || "";
const SHEET_NAME = process.env.SHEET_NAME || "Raw";

const RAW_GROUP_URLS = process.env.GROUP_URLS || "";
const GROUP_URLS = RAW_GROUP_URLS.split(",").map((s) => s.trim()).filter(Boolean);

const COOKIES_JSON = process.env.COOKIES_JSON || process.env.FB_COOKIE_JSON || process.env.FB_COOKIE || "";

const MAX_POSTS_PER_GROUP = Number(process.env.MAX_POSTS_PER_GROUP || 10);
const SCROLL_LOOPS = Number(process.env.SCROLL_LOOPS || 1); 
const SCROLL_PAUSE_MS = Number(process.env.SCROLL_PAUSE_MS || 1000);

function log(...args) {
  const now = new Date().toLocaleString("en-GB", { timeZone: TZ });
  console.log(`[${now}]`, ...args);
}

// -------------------- Google Sheets --------------------
async function getSheetsClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS;
  if (!raw) throw new Error("GOOGLE_CREDENTIALS not set");
  const key = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function appendRowsToSheet(rows) {
  if (!SHEET_ID || !rows.length) return;
  try {
    const sheets = await getSheetsClient();
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

async function newAuthedPage(browser) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (['image', 'font', 'media'].includes(req.resourceType())) { req.abort(); } else { req.continue(); }
  });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
  if (COOKIES_JSON) {
    try {
      const cleanJson = COOKIES_JSON.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
      const cookies = JSON.parse(cleanJson);
      const fixed = (Array.isArray(cookies) ? cookies : []).map((c) => ({ ...c, domain: c.domain || ".facebook.com", path: c.path || "/" }));
      await page.setCookie(...fixed);
      log("✅ Cookies injected:", fixed.length);
    } catch (e) { log("❌ Cookie Error:", e.message); }
  }
  return page;
}

async function scrapeGroup(page, groupUrl) {
  log("Scraping:", groupUrl);
  try {
    await page.goto(groupUrl, { waitUntil: "networkidle2", timeout: 60000 });
    
    // ไถหน้าจอก่อน
    for (let i = 0; i < SCROLL_LOOPS; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise(r => setTimeout(r, SCROLL_PAUSE_MS));
    }

    // --- ส่วนที่เพิ่มเข้ามา: สั่งคลิก "ดูเพิ่มเติม" ทุกโพสต์ ---
    try {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('div[role="button"]'))
          .filter(b => b.innerText === "ดูเพิ่มเติม" || b.innerText === "See more");
        btns.forEach(b => b.click());
      });
      // รอให้เนื้อหากางออก (ใช้เวลาอ้างอิงจาก SCROLL_PAUSE_MS ของคุณ)
      await new Promise(r => setTimeout(r, 2000)); 
    } catch (e) { log("⚠️ See more click error:", e.message); }

    if (page.url().includes("/login") || page.url().includes("checkpoint")) return { status: "login_required", rows: [] };

    const posts = await page.$$eval("div[role='article']", (articles) => {
      return articles.map(a => {
        const anchors = Array.from(a.querySelectorAll("a")).map(x => x.href);
        const permalink = anchors.find(h => h.includes("/posts/") || h.includes("/permalink/")) || "";
        const authorEl = a.querySelector("h3 a, strong a, a[role='link']");
        const author = authorEl ? authorEl.innerText.trim() : "Unknown";
        
        const contentEls = Array.from(a.querySelectorAll('div[data-ad-preview="message"], div[dir="auto"]'));
        const text = contentEls.map(el => el.innerText.trim()).filter(t => t.length > 0).join("\n")
          .replace(/ดูเพิ่มเติม/g, "").replace(/See more/g, "").trim().slice(0, 5000); 

        return { permalink, author, text };
      });
    });

    const cleaned = posts.filter(p => p.permalink && p.text.length > 2).slice(0, MAX_POSTS_PER_GROUP);
    return { status: "ok", rows: cleaned };
  } catch (e) { return { status: "error", rows: [] }; }
}

async function runJob() {
  log("🚀 Job Started");
  let browser;
  try {
    browser = await launchBrowser();
    const page = await newAuthedPage(browser);
    const allRows = [];
    const nowIso = new Date().toISOString();
    for (const g of GROUP_URLS) {
      const res = await scrapeGroup(page, g);
      if (res.status === "login_required") break;
      res.rows.forEach(p => allRows.push([nowIso, g, p.permalink, p.author, "", p.text]));
    }
    await appendRowsToSheet(allRows);
    log("🏁 Job Finished");
  } catch (e) { log("❌ Global Error:", e.message); } finally { if (browser) await browser.close(); }
}

const app = express();
app.get("/", (req, res) => res.send("Bot Active"));
app.listen(process.env.PORT || 8080, () => {
  log(`Server Active`);
  cron.schedule(CRON_SCHEDULE, runJob, { timezone: TZ });
  if (RUN_ON_START) runJob();
});
