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
const MAX_SCROLL_ATTEMPTS = 15; // ลดลงมาหน่อยเพื่อเซฟ RAM ไม่ให้บอทปลิว

const randomDelay = (min, max) => new Promise(res => setTimeout(res, Math.floor(Math.random() * (max - min + 1) + min)));

function log(emoji, message) {
  const now = new Date().toLocaleString("th-TH", { timeZone: TZ });
  console.log(`[${now}] ${emoji} ${message}`);
}

async function notifyError(message) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await axios.post(DISCORD_WEBHOOK_URL, { content: `⚠️ **บอทพัง!**\n🚨 ${message}` });
  } catch (e) { log("❌", "Discord Error"); }
}

async function getExistingContents(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!F:F` });
    if (!res.data.values) return { set: new Set(), lastContent: null };
    const contents = res.data.values.flat().map(c => c ? c.trim() : "").filter(Boolean);
    return { set: new Set(contents), lastContent: contents.length > 0 ? contents[contents.length - 1] : null };
  } catch (e) { return { set: new Set(), lastContent: null }; }
}

async function runJob() {
  log("🚀", "--- เริ่มรันเวอร์ชัน Stability (ป้องกัน Context Destroyed) ---");
  let browser;
  try {
    const rawAuth = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS;
    const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(rawAuth), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    const sheets = google.sheets({ version: "v4", auth });
    const { set: existingContents, lastContent } = await getExistingContents(sheets);
    
    browser = await puppeteer.launch({ 
      headless: "new", 
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] 
    });
    
    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(60000);
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0");

    if (COOKIES_JSON) {
      const cookies = JSON.parse(COOKIES_JSON.replace(/[\u0000-\u001F\u007F-\u009F]/g, ""));
      await page.setCookie(...cookies.map(c => ({ ...c, domain: c.domain || ".facebook.com", path: c.path || "/" })));
    }

    let allRows = [];
    for (const url of GROUP_URLS) {
      log("🌐", `ตรวจสอบกลุ่ม: ${url}`);
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await randomDelay(5000, 8000);

        let attempts = 0;
        let foundOldContent = false;

        while (!foundOldContent && attempts < MAX_SCROLL_ATTEMPTS) {
          attempts++;
          await page.evaluate(() => window.scrollBy(0, 1000));
          await randomDelay(3000, 5000);

          // เช็คว่า Context ยังอยู่ไหมก่อนจะกดกางเม้น
          try {
            await page.evaluate(() => {
              const btns = Array.from(document.querySelectorAll('span, div[role="button"]'))
                .filter(el => el.innerText.includes("ดูความคิดเห็น") || el.innerText.includes("ดูเพิ่ม"));
              if (btns.length > 0) btns[0].click(); 
            });
          } catch (e) { log("⚠️", "หน้าเว็บขยับ/รีเฟรช ข้ามการกางเม้นรอบนี้"); }

          const pageContents = await page.$$eval("div[role='article']", (articles) => articles.map(a => (a.innerText || "").trim()));
          if (lastContent && pageContents.includes(lastContent)) {
            log("🎯", `เจอของเดิมรอบที่ ${attempts}! หยุดไถ`);
            foundOldContent = true;
          } else if (attempts % 5 === 0) log("  ↳", `ไถรอบที่ ${attempts}...`);
        }

        // ดึงข้อมูล (เพิ่ม Error Handling)
        const posts = await page.$$eval("div[role='article'], div.x1yzt60o, div.x1iorvi4", (articles) => {
          return articles.map(a => {
            const linkEl = a.querySelector("a[href*='/posts/'], a[href*='/permalink/']");
            let link = linkEl ? linkEl.href.split('?')[0] : "";
            const author = (a.querySelector("h3 span a, strong a")?.innerText || "Unknown").trim();
            return { link, author, text: (a.innerText || "").trim() };
          });
        });

        const newPosts = posts.filter(p => p.text.length > 10 && !existingContents.has(p.text));
        log("📥", `กลุ่มนี้: [ใหม่ ${newPosts.length}] | [ซ้ำ ${posts.length - newPosts.length}] | [รวมที่เห็น ${posts.length}]`);
        
        newPosts.forEach(p => {
          allRows.push([new Date().toLocaleString("th-TH", { timeZone: TZ }), url, p.link, p.author, "", p.text]);
          existingContents.add(p.text);
        });
      } catch (err) { log("❌", `ข้ามกลุ่ม ${url} เนื่องจากหน้าเว็บรวน`); }
    }

    if (allRows.length > 0) {
      await sheets.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:Z`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values: allRows } });
      log("✅", `อัปเดต ${allRows.length} รายการ`);
    }

  } catch (e) { await notifyError(`บอทตาย: ${e.message}`); }
  finally { if (browser) await browser.close(); log("🏁", "จบงาน"); }
}

const app = express();
app.listen(process.env.PORT || 8080, () => {
  cron.schedule(process.env.CRON_SCHEDULE || "*/20 * * * *", runJob);
  if (process.env.RUN_ON_START === "true") runJob();
});
