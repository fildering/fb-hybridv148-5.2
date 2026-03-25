import cron from "node-cron";
import express from "express";
import puppeteer from "puppeteer";
import { google } from "googleapis";
import axios from "axios";
import FormData from "form-data";

// -------------------- Configuration --------------------
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "*/20 * * * *";
const RUN_ON_START = (process.env.RUN_ON_START || "true").toLowerCase() === "true";
const TZ = process.env.TZ || "Asia/Bangkok";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || ""; 

const SHEET_ID = process.env.SHEET_ID || process.env.GOOGLE_SHEET_ID || "";
const SHEET_NAME = process.env.SHEET_NAME || "Raw";
const GROUP_URLS = (process.env.GROUP_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
const COOKIES_JSON = process.env.COOKIES_JSON || "";

const randomDelay = (min = 2000, max = 5000) => {
  const ms = Math.floor(Math.random() * (max - min + 1) + min);
  return new Promise(res => setTimeout(res, ms));
};

function log(...args) {
  const now = new Date().toLocaleString("en-GB", { timeZone: TZ });
  console.log(`[${now}]`, ...args);
}

// --- ระบบแจ้งเตือน Discord แบบแนบรูป ---
async function notifyDiscord(message, screenshotBuffer = null) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const form = new FormData();
    form.append("content", `🚨 **FB Bot Alert**\n> ${message}`);
    if (screenshotBuffer) {
      form.append("file", screenshotBuffer, { filename: "status.png", contentType: "image/png" });
    }
    await axios.post(DISCORD_WEBHOOK_URL, form, { headers: { ...form.getHeaders() } });
    log("📸 ส่งแจ้งเตือนพร้อมรูปไป Discord แล้ว");
  } catch (e) { log("❌ Discord Error:", e.message); }
}

async function launchBrowser() {
  return puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--incognito", "--disable-blink-features=AutomationControlled"]
  });
}

async function scrapeGroup(page, groupUrl) {
  log("🔍 กำลังเข้ากลุ่ม:", groupUrl);
  try {
    await page.goto(groupUrl, { waitUntil: "networkidle2", timeout: 60000 });
    await randomDelay(3000, 5000); 

    // เช็คหน้าด่าน Checkpoint/Login
    const isLocked = await page.evaluate(() => {
      return window.location.href.includes("checkpoint") || !!document.querySelector('input[name="pass"]');
    });

    if (isLocked) {
      log("⚠️ ติดด่านตรวจ! กำลังแคปหน้าจอ...");
      const screen = await page.screenshot();
      await notifyDiscord(`ติดหน้ายืนยันตัวตนที่กลุ่ม: ${groupUrl}`, screen);
      
      // พยายามกดปุ่มทะลวงด่าน
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('div[role="button"], button'))
          .filter(b => b.innerText.includes("ดำเนินการต่อ") || b.innerText.includes("Continue"));
        if (btns.length > 0) btns[0].click();
      });
      await randomDelay(5000, 8000);
      return { status: "checkpoint", rows: [] };
    }

    // --- พฤติกรรมสุ่ม (Scroll & Expand) ---
    await page.evaluate(() => window.scrollBy(0, 500 + Math.random() * 500));
    await randomDelay(2000, 4000);
    
    // กางคอมเมนต์ (สุ่มคลิก)
    await page.evaluate(() => {
      const more = Array.from(document.querySelectorAll('span')).find(s => s.innerText.includes("ดูความคิดเห็น"));
      if (more) more.click();
    });
    await randomDelay(3000, 5000);

    // ดึงข้อมูลโพสต์
    const posts = await page.$$eval("div[role='article']", (articles) => {
      return articles.map(a => {
        const link = a.querySelector("a[href*='/posts/'], a[href*='/permalink/']")?.href || "";
        const author = (a.querySelector("h3 span a")?.innerText || "Unknown").trim();
        const text = (a.querySelector('div[dir="auto"]')?.innerText || "").slice(0, 5000);
        return { link, author, text };
      });
    });

    return { status: "ok", rows: posts.filter(p => p.link && p.text.length > 5) };
  } catch (e) {
    const errScreen = await page.screenshot().catch(() => null);
    await notifyDiscord(`Error ระหว่างทำงาน: ${e.message}`, errScreen);
    return { status: "error", rows: [] };
  }
}

async function runJob() {
  log("🚀 เริ่มต้นการทำงานแบบ Stealth Mode");
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    const ua = process.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0";
    await page.setUserAgent(ua);
    log("👤 ใช้ User-Agent:", ua.slice(0, 50) + "...");

    if (COOKIES_JSON) {
      const cookies = JSON.parse(COOKIES_JSON.replace(/[\u0000-\u001F\u007F-\u009F]/g, ""));
      await page.setCookie(...cookies.map(c => ({ ...c, domain: c.domain || ".facebook.com", path: c.path || "/" })));
    }

    let allRows = [];
    const nowIso = new Date().toISOString();
    
    for (const g of GROUP_URLS) {
      const res = await scrapeGroup(page, g);
      res.rows.forEach(p => allRows.push([nowIso, g, p.link, p.author, "", p.text]));
      if (res.status === "checkpoint") break;
      await randomDelay(4000, 8000);
    }

    // --- ส่วนแก้ไข: บันทึกลง Sheets เฉพาะเมื่อมีข้อมูลเท่านั้น เพื่อกัน Error ---
    if (allRows.length > 0 && SHEET_ID) {
      const rawAuth = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS;
      const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(rawAuth), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
      const sheets = google.sheets({ version: "v4", auth });
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A:Z`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: allRows },
      });
      log(`✅ บันทึกข้อมูลเรียบร้อย ${allRows.length} รายการ`);
    } else {
      log("⚠️ ไม่มีข้อมูลใหม่ให้บันทึก (อาจติดหน้าด่านหรือไม่มีโพสต์ใหม่)");
    }
  } catch (e) { log("❌ Global Error:", e.message); }
  finally { if (browser) await browser.close(); log("🏁 จบการทำงานรอบนี้"); }
}

const app = express();
app.get("/", (req, res) => res.send("Bot Active"));
app.listen(process.env.PORT || 8080, () => {
  cron.schedule(CRON_SCHEDULE, runJob, { timezone: TZ });
  if (RUN_ON_START) runJob();
});
