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

const SHEET_ID = process.env.SHEET_ID || "";
const SHEET_NAME = process.env.SHEET_NAME || "Raw";
const GROUP_URLS = (process.env.GROUP_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
const COOKIES_JSON = process.env.COOKIES_JSON || "";

// ฟังก์ชันสุ่มเวลารอ (Human-like Delay)
const randomDelay = (min = 2000, max = 5000) => {
  const ms = Math.floor(Math.random() * (max - min + 1) + min);
  return new Promise(res => setTimeout(res, ms));
};

function log(...args) {
  const now = new Date().toLocaleString("en-GB", { timeZone: TZ });
  console.log(`[${now}]`, ...args);
}

// --- ระบบแจ้งเตือน Discord แบบส่งรูป Screenshot ---
async function notifyDiscord(message, screenshotBuffer = null) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const form = new FormData();
    form.append("content", `🚨 **FB Bot Status Update**\n> ${message}`);
    
    if (screenshotBuffer) {
      form.append("file", screenshotBuffer, {
        filename: "error-screenshot.png",
        contentType: "image/png",
      });
    }

    await axios.post(DISCORD_WEBHOOK_URL, form, {
      headers: { ...form.getHeaders() },
    });
    log("📸 ส่งการแจ้งเตือน (พร้อมรูป) ไปที่ Discord เรียบร้อย");
  } catch (e) { log("❌ Discord Error:", e.message); }
}

// -------------------- Puppeteer --------------------
async function launchBrowser() {
  return puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--incognito",
      "--disable-blink-features=AutomationControlled",
    ],
  });
}

async function scrapeGroup(page, groupUrl) {
  log("🔍 กำลังเข้ากลุ่ม:", groupUrl);
  try {
    await page.goto(groupUrl, { waitUntil: "networkidle2", timeout: 60000 });
    await randomDelay(3000, 6000); 

    // ตรวจสอบหน้าด่าน Checkpoint/Login
    const isErrorPage = await page.evaluate(() => {
      return window.location.href.includes("checkpoint") || 
             window.location.href.includes("login") || 
             !!document.querySelector('input[name="pass"]');
    });

    if (isErrorPage) {
      log("⚠️ ติดด่านตรวจ! กำลังแคปหน้าจอส่ง Discord...");
      const screen = await page.screenshot({ fullPage: false });
      await notifyDiscord(`บอทติดด่านที่กลุ่ม: ${groupUrl}\nเช็ครูปด้านล่างแล้วอัปเดต Cookie ใหม่ครับพี่ฟิวส์`, screen);
      return { status: "login_required", rows: [] };
    }

    // 1. ไถหน้าจอแบบสุ่ม
    await page.evaluate(() => window.scrollBy(0, 500 + Math.random() * 500));
    await randomDelay(2000, 4000);

    // 2. ปลดล็อก All Comments
    await page.evaluate(async () => {
      const filterBtn = Array.from(document.querySelectorAll('div[role="button"]'))
        .find(b => b.innerText.includes("เกี่ยวข้อง") || b.innerText.includes("Relevant"));
      if (filterBtn) {
        filterBtn.click();
        await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
        const allOpt = Array.from(document.querySelectorAll('div[role="menuitem"], span'))
          .find(s => s.innerText.includes("คอมเมนต์ทั้งหมด") || s.innerText.includes("All comments"));
        if (allOpt) allOpt.click();
      }
    });
    await randomDelay(3000, 5000);

    // 3. กางคอมเมนต์ย่อย (สุ่มจังหวะ)
    for (let j = 0; j < 3; j++) {
      await page.evaluate(() => {
        const more = Array.from(document.querySelectorAll('span'))
          .filter(s => s.innerText.includes("ดูความคิดเห็น") || s.innerText.includes("View more comments"));
        if (more.length > 0) more[Math.floor(Math.random() * more.length)].click();
      });
      await randomDelay(1500, 3000);
    }

    // 4. คลิก "ดูเพิ่มเติม" ในเนื้อหา
    await page.evaluate(() => {
      const seeMore = Array.from(document.querySelectorAll('div[role="button"], span[role="button"]'))
        .filter(b => b.innerText === "ดูเพิ่มเติม" || b.innerText === "See more");
      seeMore.forEach(b => b.click());
    });
    await randomDelay(4000, 6000);

    // 5. ดึงข้อมูล (Deep Scrape)
    const posts = await page.$$eval("div[role='article']", (articles) => {
      return articles.map(a => {
        const anchors = Array.from(a.querySelectorAll("a")).map(x => x.href);
        const link = anchors.find(h => h.includes("/posts/") || h.includes("/permalink/") || h.includes("comment_id")) || "";
        const author = (a.querySelector("h3 a, strong a, a[role='link'] span")?.innerText || "Unknown").trim();
        const contentEls = Array.from(a.querySelectorAll('div[dir="auto"] span, div[data-ad-preview="message"] span'));
        let text = contentEls.map(el => el.innerText.trim()).filter(t => t.length > 0).join(" ");
        return { link, author, text: text.replace(/ดูเพิ่มเติม|See more/g, "").trim().slice(0, 10000) };
      });
    });

    return { status: "ok", rows: posts.filter(p => p.link && p.text.length > 5).slice(0, 100) };
  } catch (e) {
    const errScreen = await page.screenshot().catch(() => null);
    await notifyDiscord(`❌ เกิด Error ที่กลุ่ม ${groupUrl}: ${e.message}`, errScreen);
    return { status: "error", rows: [] };
  }
}

async function runJob() {
  log("🚀 เริ่มต้นงานแบบ Stealth Mode");
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    
    const customUA = process.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
    await page.setUserAgent(customUA);

    if (COOKIES_JSON) {
      const cleanJson = COOKIES_JSON.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
      const cookies = JSON.parse(cleanJson);
      await page.setCookie(...cookies.map(c => ({ ...c, domain: c.domain || ".facebook.com", path: c.path || "/" })));
    }

    const allRows = [];
    const nowIso = new Date().toISOString();
    
    // สุ่มลำดับกลุ่มเพื่อความเนียน
    const shuffledGroups = GROUP_URLS.sort(() => Math.random() - 0.5);

    for (const g of shuffledGroups) {
      const res = await scrapeGroup(page, g);
      if (res.status === "login_required") break; // หยุดถ้าติดด่าน (รูปส่งไปแล้วในฟังก์ชัน)
      res.rows.forEach(p => allRows.push([nowIso, g, p.link, p.author, "", p.text]));
      await randomDelay(3000, 7000); 
    }

    if (allRows.length > 0) {
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
      log(`✅ บันทึกเรียบร้อย ${allRows.length} รายการ`);
    }
  } catch (e) { 
    log("❌ Global Error:", e.message);
  } finally { if (browser) await browser.close(); log("🏁 จบการทำงานรอบนี้"); }
}

const app = express();
app.get("/", (req, res) => res.send("Bot Active"));
app.listen(process.env.PORT || 8080, () => {
  cron.schedule(CRON_SCHEDULE, runJob, { timezone: TZ });
  if (RUN_ON_START) runJob();
});
