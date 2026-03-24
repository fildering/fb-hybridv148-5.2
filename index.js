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
const GROUP_URLS = RAW_GROUP_URLS
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const COOKIES_JSON =
  process.env.COOKIES_JSON ||
  process.env.FB_COOKIE_JSON ||
  process.env.FB_COOKIE ||
  "";

const MAX_POSTS_PER_GROUP = Number(process.env.MAX_POSTS_PER_GROUP || 10);
const SCROLL_LOOPS = Number(process.env.SCROLL_LOOPS || 0);
const SCROLL_PAUSE_MS = Number(process.env.SCROLL_PAUSE_MS || 800);
const SKIP_PINNED = (process.env.SKIP_PINNED || "false").toLowerCase() === "true";

function log(...args) {
  const now = new Date().toLocaleString("en-GB", { timeZone: TZ });
  console.log(`[${now}]`, ...args);
}

// -------------------- Helper Functions --------------------
function normalizeFacebookGroupUrl(url) {
  try {
    const u = new URL(url);
    u.hostname = "www.facebook.com";
    u.search = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

function normalizePostUrl(url) {
  try {
    const u = new URL(url);
    u.hostname = "www.facebook.com";
    u.search = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

// -------------------- Google Sheets --------------------
async function getSheetsClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS;
  if (!raw) throw new Error("GOOGLE_CREDENTIALS / GOOGLE_SERVICE_ACCOUNT_JSON not set");

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
    const range = `${SHEET_NAME}!A:Z`;

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows },
    });
    log(`✅ Appended ${rows.length} row(s) to Google Sheets`);
  } catch (e) {
    log("❌ Sheets Append Error:", e.message);
  }
}

// -------------------- Puppeteer --------------------
async function launchBrowser() {
  // ปรับปรุง args เพื่อประหยัด RAM และป้องกัน SIGTERM บน Railway
  return puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
      "--single-process", // ช่วยลด RAM ในบางสภาพแวดล้อม
    ],
  });
}

async function newAuthedPage(browser) {
  const page = await browser.newPage();
  
  // ปิดการโหลดรูปภาพเพื่อประหยัด RAM และ Bandwidth
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.resourceType() === 'image' || req.resourceType() === 'font') {
      req.abort();
    } else {
      req.continue();
    }
  });

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );

  if (COOKIES_JSON) {
    try {
      const cookies = JSON.parse(COOKIES_JSON);
      const fixed = (Array.isArray(cookies) ? cookies : []).map((c) => ({
        ...c,
        domain: c.domain || ".facebook.com",
        path: c.path || "/",
      }));
      await page.setCookie(...fixed);
      log("Cookies injected:", fixed.length);
    } catch (e) {
      log("⚠️ Cookie Parse Error:", e.message);
    }
  }
  return page;
}

async function checkLoginStatus(page) {
  await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
  const url = page.url();
  if (url.includes("/login") || url.includes("checkpoint")) {
    return false;
  }
  return true;
}

async function scrapeGroup(page, groupUrl) {
  const url = normalizeFacebookGroupUrl(groupUrl);
  log("Scraping:", url);

  try {
    await page.goto(url, { waitUntil: "networkidle0", timeout: 45000 });
    
    // เลื่อนหน้าจอเล็กน้อยถ้าตั้งค่าไว้
    for (let i = 0; i < SCROLL_LOOPS; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise(r => setTimeout(r, SCROLL_PAUSE_MS));
    }

    const finalUrl = page.url();
    if (finalUrl.includes("/login") || finalUrl.includes("checkpoint")) {
      return { status: "login_required", rows: [] };
    }

    // ดึงข้อมูลโพสต์
    const posts = await page.$$eval("div[role='article']", (articles) => {
      return articles.map(a => {
        const anchors = Array.from(a.querySelectorAll("a")).map(x => x.href);
        const permalink = anchors.find(h => h.includes("/posts/") || h.includes("/permalink/")) || "";
        
        const authorEl = a.querySelector("h3 a, strong a, a[role='link']");
        const author = authorEl ? authorEl.innerText.trim() : "Unknown";
        
        const text = a.innerText.split("\n").slice(2, 6).join(" ").trim(); // กรองเอาแต่เนื้อหาคร่าวๆ
        return { permalink, author, text };
      });
    });

    const cleaned = posts
      .filter(p => p.permalink && p.text.length > 5)
      .slice(0, MAX_POSTS_PER_GROUP);

    return { status: "ok", rows: cleaned };
  } catch (e) {
    log(`❌ Error scraping ${url}:`, e.message);
    return { status: "error", rows: [] };
  }
}

// -------------------- Main Job --------------------
async function runJob() {
  log("🚀 Job Started");
  if (!GROUP_URLS.length) return log("⚠️ No Group URLs found.");

  let browser;
  try {
    browser = await launchBrowser();
    const page = await newAuthedPage(browser);

    const isLoggedIn = await checkLoginStatus(page);
    if (!isLoggedIn) {
      log("❌ Login Required or Checkpoint detected. Please update Cookies.");
      return;
    }

    const allRows = [];
    const nowIso = new Date().toISOString();

    for (const g of GROUP_URLS) {
      const res = await scrapeGroup(page, g);
      if (res.status === "login_required") {
        log("❌ Session expired during job.");
        break;
      }
      
      res.rows.forEach(p => {
        allRows.push([nowIso, g, normalizePostUrl(p.permalink), p.author, "", p.text]);
      });
    }

    await appendRowsToSheet(allRows);
    log("🏁 Job Finished");
  } catch (e) {
    log("❌ Global Job Error:", e.message);
  } finally {
    if (browser) await browser.close();
  }
}

// -------------------- Server & Init --------------------
const app = express();
app.get("/", (req, res) => res.send("Bot is Running"));
app.get("/health", (req, res) => res.json({ status: "ok" }));

const port = process.env.PORT || 8080;
app.listen(port, () => {
  log(`Health server on port ${port}`);
  
  cron.schedule(CRON_SCHEDULE, runJob, { timezone: TZ });
  
  if (RUN_ON_START) runJob();
});
