import cron from "node-cron";
import express from "express";
import puppeteer from "puppeteer";
import { google } from "googleapis";
import axios from "axios";

// -------------------- Configuration --------------------
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "*/15 * * * *";
const RUN_ON_START = (process.env.RUN_ON_START || "true").toLowerCase() === "true";
const TZ = process.env.TZ || "Asia/Bangkok";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || ""; 

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

// --- ระบบแจ้งเตือน Discord ---
async function notifyDiscord(message) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await axios.post(DISCORD_WEBHOOK_URL, { 
      content: `🚨 **FB Bot Status Update**\n> ${message}` 
    });
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

// ระบบทะลวงหน้าด่าน (ดำเนินการต่อในชื่อ...)
async function handleLoginCheck(page) {
  const url = page.url();
  if (url.includes("checkpoint") || url.includes("login")) {
    log("⚠️ เจอหน้ายืนยันตัวตน กำลังพยายามกดปุ่มทะลวงด่าน...");
    try {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('div[role="button"], button'))
          .filter(b => b.innerText.includes("ดำเนินการต่อ") || b.innerText.includes("Continue") || b.innerText.includes("เข้าสู่ระบบ") || b.innerText.includes("Log In"));
        if (btns.length > 0) btns[0].click();
      });
      await new Promise(r => setTimeout(r, 5000)); 
    } catch (e) { log("❌ Bypass failed:", e.message); }
  }
}

async function scrapeGroup(page, groupUrl) {
  log("Scraping:", groupUrl);
  try {
    await page.goto(groupUrl, { waitUntil: "networkidle2", timeout: 60000 });
    await handleLoginCheck(page);

    // 1. ไถหน้าจอ
    for (let i = 0; i < SCROLL_LOOPS; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise(r => setTimeout(r, 2000));
    }

    // 2. ปลดล็อก All Comments และกางคอมเมนต์ใส่นัว
    await page.evaluate(async () => {
      // เปลี่ยน Filter เป็น All Comments
      const filterBtn = Array.from(document.querySelectorAll('div[role="button"]'))
        .find(b => b.innerText.includes("เกี่ยวข้อง") || b.innerText.includes("Relevant"));
      if (filterBtn) {
        filterBtn.click();
        await new Promise(r => setTimeout(r, 1500));
        const allOpt = Array.from(document.querySelectorAll('div[role="menuitem"], span'))
          .find(s => s.innerText.includes("คอมเมนต์ทั้งหมด") || s.innerText.includes("All comments"));
        if (allOpt) allOpt.click();
        await new Promise(r => setTimeout(r, 2000));
      }
      
      // กด "ดูความคิดเห็นเพิ่มเติม" 3 รอบ (เพิ่มได้ถ้าดราม่าเยอะ)
      for (let j = 0; j < 3; j++) {
        const more = Array.from(document.querySelectorAll('span'))
          .filter(s => s.innerText.includes("ดูความคิดเห็น") || s.innerText.includes("View more comments"));
        more.forEach(m => m.click());
        await new Promise(r => setTimeout(r, 1500));
      }
    });

    // 3. คลิก "ดูเพิ่มเติม" (See More) ในทุกก้อนเนื้อหา
    await page.evaluate(() => {
      const seeMore = Array.from(document.querySelectorAll('div[role="button"], span[role="button"]'))
        .filter(b => b.innerText === "ดูเพิ่มเติม" || b.innerText === "See more");
      seeMore.forEach(b => b.click());
    });
    await new Promise(r => setTimeout(r, 4000)); // รอกางเนื้อหายาวๆ

    // 4. ดึงข้อมูลแบบเจาะลึกและกันข้อความซ้ำ
    const posts = await page.$$eval("div[role='article']", (articles) => {
      return articles.map(a => {
        const anchors = Array.from(a.querySelectorAll("a")).map(x => x.href);
        const link = anchors.find(h => h.includes("/posts/") || h.includes("/permalink/") || h.includes("comment_id")) || "";
        const author = (a.querySelector("h3 a, strong a, a[role='link'] span")?.innerText || 
                       a.querySelector("h3 a, strong a, a[role='link']")?.innerText || "Unknown").trim();
        
        // ดึงจาก span ชั้นในสุดเพื่อให้ได้ข้อความครบถ้วน
        const deepContentEls = Array.from(a.querySelectorAll('div[dir="auto"] span, div[data-ad-preview="message"] span'));
        let text = deepContentEls.map(el => el.innerText.trim()).filter(t => t.length > 0).join(" ");
        
        // Fallback ถ้า span ไม่เจอ
        if (text.length < 5) {
          text = Array.from(a.querySelectorAll('div[dir="auto"]')).map(el => el.innerText.trim()).sort((x, y) => y.length - x.length)[0] || "";
        }

        return { link, author, text: text.replace(/ดูเพิ่มเติม|See more/g, "").trim().slice(0, 10000) };
      });
    });

    if (page.url().includes("/login") || page.url().includes("checkpoint")) return { status: "login_required", rows: [] };

    return { status: "ok", rows: posts.filter(p => p.link && p.text.length > 5).slice(0, 150) };
  } catch (e) { return { status: "error", rows: [] }; }
}

async function runJob() {
  log("🚀 Job Started");
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
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
        await notifyDiscord(`⚠️ **Cookies หมดอายุ หรือ ติดด่านตรวจ**\nกลุ่ม: ${g}\nรีบอัปเดต Cookies ชุดใหม่ใน Railway ด่วนครับพี่ฟิวส์!`);
        break;
      }
      res.rows.forEach(p => allRows.push([nowIso, g, p.link, p.author, "", p.text]));
    }
    await appendRowsToSheet(allRows);
    log("🏁 Job Finished");
  } catch (e) { 
    log("❌ Global Error:", e.message);
    await notifyDiscord(`❌ **บอทพังชั่วคราว:** ${e.message}`);
  } finally { if (browser) await browser.close(); }
}

const app = express();
app.get("/", (req, res) => res.send("Bot Active"));
app.listen(process.env.PORT || 8080, () => {
  log(`Server Active`);
  cron.schedule(CRON_SCHEDULE, runJob, { timezone: TZ });
  if (RUN_ON_START) runJob();
});
