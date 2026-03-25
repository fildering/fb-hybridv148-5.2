import cron from "node-cron";
import express from "express";
import puppeteer from "puppeteer";
import { google } from "googleapis";
import axios from "axios";
import FormData from "form-data";

// -------------------- Config --------------------
const SHEET_ID = process.env.SHEET_ID || process.env.GOOGLE_SHEET_ID || "";
const SHEET_NAME = process.env.SHEET_NAME || "Raw";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const COOKIES_JSON = process.env.COOKIES_JSON || "";
const GROUP_URLS = (process.env.GROUP_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
const TZ = "Asia/Bangkok";
const MAX_SCROLL_ATTEMPTS = 35; 

const randomDelay = (min, max) => new Promise(res => setTimeout(res, Math.floor(Math.random() * (max - min + 1) + min)));

function log(emoji, message) {
  const now = new Date().toLocaleString("th-TH", { timeZone: TZ });
  console.log(`[${now}] ${emoji} ${message}`);
}

async function getRecentLinks(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:C` });
    if (!res.data.values) return { set: new Set(), lastLink: null };
    const now = new Date();
    const yesterday = new Date(now.setDate(now.getDate() - 1)).setHours(0,0,0,0);
    
    const rows = res.data.values.filter(row => {
      try {
        const [d, m, y] = row[0].split(' ')[0].split('/').map(Number);
        return new Date(y, m-1, d) >= yesterday;
      } catch(e) { return true; }
    });

    const links = rows.map(r => r[2] ? r[2].split('?')[0] : "").filter(Boolean);
    return { 
      set: new Set(links), 
      lastLink: links.length > 0 ? links[links.length - 1] : null 
    };
  } catch (e) { return { set: new Set(), lastLink: null }; }
}

async function runJob() {
  log("🚀", "--- เริ่มงาน (Smart Scroll + Link Cleaner + Expand) ---");
  let browser;
  try {
    const rawAuth = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS;
    const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(rawAuth), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    const sheets = google.sheets({ version: "v4", auth });

    const { set: existingLinks, lastLink } = await getRecentLinks(sheets);
    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--incognito"] });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0");

    if (COOKIES_JSON) {
      const cookies = JSON.parse(COOKIES_JSON.replace(/[\u0000-\u001F\u007F-\u009F]/g, ""));
      await page.setCookie(...cookies.map(c => ({ ...c, domain: c.domain || ".facebook.com", path: c.path || "/" })));
    }

    let allRows = [];
    for (const url of GROUP_URLS) {
      log("🌐", `ตรวจสอบกลุ่ม: ${url}`);
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
      await randomDelay(4000, 6000);

      let attempts = 0;
      let foundOld = false;

      while (!foundOld && attempts < MAX_SCROLL_ATTEMPTS) {
        attempts++;
        await page.evaluate(() => window.scrollBy(0, 1000));
        await randomDelay(2500, 4000);

        // 1. ปิด Pop-up และ กางคอมเมนต์
        await page.evaluate(async () => {
          const closeBtns = document.querySelectorAll('div[aria-label="ปฏิเสธ"], div[aria-label="Close"], div[aria-label="ปิด"]');
          closeBtns.forEach(b => b.click());
          
          const btns = Array.from(document.querySelectorAll('span, div[role="button"]'))
            .filter(el => el.innerText.includes("ดูความคิดเห็น") || el.innerText.includes("ดูเพิ่ม"));
          for (const btn of btns) {
            btn.click();
            await new Promise(r => setTimeout(r, 1000));
          }
        });

        // 2. เช็คว่าเจอของเก่าหรือยัง (แบบตัดหางลิงก์)
        const currentLinks = await page.$$eval("a[href*='/posts/'], a[href*='/permalink/']", ls => ls.map(l => l.href.split('?')[0]));
        if (lastLink && currentLinks.includes(lastLink)) {
          log("🎯", `เจอโพสต์เดิมในรอบที่ ${attempts} หยุดไถทันที`);
          foundOld = true;
        }
        if (attempts % 5 === 0) log("  ↳", `ไถรอบที่ ${attempts}...`);
      }

      const posts = await page.$$eval("div[role='article']", (articles) => {
        return articles.map(a => {
          const linkEl = a.querySelector("a[href*='/posts/'], a[href*='/permalink/']");
          let link = linkEl ? linkEl.href.split('?')[0] : "";
          if (link.endsWith('/')) link = link.slice(0, -1);
          
          const author = (a.querySelector("h3 span a, strong a, span[dir='auto'] a")?.innerText || "Unknown").trim();
          const text = (a.querySelector('div[dir="auto"], div.x1iorvi4')?.innerText || "").trim();
          return { link, author, text };
        });
      });

      const newPosts = posts.filter(p => p.link && p.text.length > 5 && !existingLinks.has(p.link));
      log("📥", `เจอใหม่ ${newPosts.length} รายการ`);
      
      newPosts.forEach(p => {
        allRows.push([new Date().toLocaleString("th-TH", { timeZone: TZ }), url, p.link, p.author, "", p.text]);
        existingLinks.add(p.link);
      });
    }

    if (allRows.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:Z`,
        valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
        requestBody: { values: allRows },
      });
      log("✅", `บันทึกเรียบร้อย ${allRows.length} รายการ`);
    }
  } catch (e) { log("❌", e.message); }
  finally { if (browser) await browser.close(); log("🏁", "จบงาน"); }
}

const app = express();
app.get("/", (req, res) => res.send("Active"));
app.listen(process.env.PORT || 8080, () => {
  cron.schedule(process.env.CRON_SCHEDULE || "*/20 * * * *", runJob);
  if (process.env.RUN_ON_START === "true") runJob();
});
