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
const TZ = process.env.TZ || "Asia/Bangkok";
const MAX_SCROLL_ATTEMPTS = 25; // กันเหนียว ไถไม่เกิน 25 รอบถ้าหาของเก่าไม่เจอจริงๆ

const randomDelay = (min, max) => new Promise(res => setTimeout(res, Math.floor(Math.random() * (max - min + 1) + min)));

function log(emoji, message) {
  const now = new Date().toLocaleString("th-TH", { timeZone: TZ });
  console.log(`[${now}] ${emoji} ${message}`);
}

async function notifyDiscord(message, screenshotBuffer = null) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const form = new FormData();
    form.append("content", `📢 **FB Smart Scraper Alert**\n${message}`);
    if (screenshotBuffer) form.append("file", screenshotBuffer, { filename: "alert.png", contentType: "image/png" });
    await axios.post(DISCORD_WEBHOOK_URL, form, { headers: { ...form.getHeaders() }, timeout: 30000 });
  } catch (e) { log("❌", `Discord Error: ${e.message}`); }
}

async function getExistingLinks(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!C:C` });
    return res.data.values ? res.data.values.flat() : [];
  } catch (e) { return []; }
}

async function runJob() {
  log("🚀", "--- เริ่มต้นงานแบบ Smart Scroll (ไถจนกว่าจะเจอของเก่า) ---");
  let browser;
  try {
    const rawAuth = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS;
    const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(rawAuth), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    const sheets = google.sheets({ version: "v4", auth });

    const existingLinksArray = await getExistingLinks(sheets);
    const lastSavedLink = existingLinksArray.length > 0 ? existingLinksArray[existingLinksArray.length - 1] : null;
    const existingLinksSet = new Set(existingLinksArray);
    
    log("📊", lastSavedLink ? `ลิงก์ล่าสุดที่ต้องหาให้เจอ: ${lastSavedLink.slice(0, 50)}...` : "ไม่พบข้อมูลเดิม จะไถตามมาตรฐาน");

    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--incognito"] });
    const page = await browser.newPage();
    await page.setUserAgent(process.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0");

    if (COOKIES_JSON) {
      const cookies = JSON.parse(COOKIES_JSON.replace(/[\u0000-\u001F\u007F-\u009F]/g, ""));
      await page.setCookie(...cookies.map(c => ({ ...c, domain: c.domain || ".facebook.com", path: c.path || "/" })));
    }

    let allRows = [];
    for (const url of GROUP_URLS) {
      log("🌐", `ตรวจสอบกลุ่ม: ${url}`);
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
      await randomDelay(4000, 6000);

      if (page.url().includes("checkpoint") || !!(await page.$('input[name="pass"]'))) {
        const screen = await page.screenshot();
        await notifyDiscord(`ติดด่านที่กลุ่ม: ${url}`, screen);
        return; 
      }

      let foundOldPost = false;
      let attempts = 0;

      log("🖱️", "กำลังเริ่มไถแบบ Smart Scroll...");
      while (!foundOldPost && attempts < MAX_SCROLL_ATTEMPTS) {
        attempts++;
        await page.evaluate(() => window.scrollBy(0, 1000 + Math.random() * 500));
        await randomDelay(2500, 4000);

        // เช็คว่าเจอลิงก์เก่าหรือยัง
        const currentLinks = await page.$$eval("a[href*='/posts/'], a[href*='/permalink/']", (links) => links.map(l => l.href.split('?')[0]));
        
        if (lastSavedLink && currentLinks.includes(lastSavedLink.split('?')[0])) {
          log("🎯", `เจอโพสต์เดิมที่เคยเก็บแล้วในรอบที่ ${attempts}! หยุดไถทันที`);
          foundOldPost = true;
        } else {
          if (attempts % 3 === 0) log("  ↳", `ไถไปแล้ว ${attempts} รอบยังไม่เจอของเก่า...`);
        }
      }

      // ดึงข้อมูลโพสต์ทั้งหมดที่เจอ
      const posts = await page.$$eval("div[role='article']", (articles) => {
        return articles.map(a => {
          const linkEl = a.querySelector("a[href*='/posts/'], a[href*='/permalink/']");
          const link = linkEl ? linkEl.href.split('?')[0] : "";
          const author = (a.querySelector("h3 span a, strong a, span[dir='auto'] a")?.innerText || "Unknown").trim();
          const text = (a.querySelector('div[dir="auto"], div.x1iorvi4')?.innerText || "").trim();
          return { link, author, text };
        });
      });

      const newPosts = posts.filter(p => p.link && p.text.length > 5 && !existingLinksSet.has(p.link));
      log("📥", `เจอโพสต์ใหม่ทั้งหมด ${newPosts.length} รายการ`);
      
      newPosts.forEach(p => {
        allRows.push([new Date().toLocaleString("th-TH", { timeZone: TZ }), url, p.link, p.author, "", p.text]);
        existingLinksSet.add(p.link); 
      });
    }

    if (allRows.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:Z`,
        valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
        requestBody: { values: allRows },
      });
      log("✅", `บันทึกของใหม่ ${allRows.length} รายการเรียบร้อย!`);
    } else {
      log("😴", "ไม่มีของใหม่จริงๆ รอบนี้");
    }

  } catch (e) { log("❌", `Error: ${e.message}`); }
  finally { if (browser) await browser.close(); log("🏁", "--- จบงาน ---"); }
}

const app = express();
app.listen(process.env.PORT || 8080, () => {
  cron.schedule(process.env.CRON_SCHEDULE || "*/20 * * * *", runJob);
  if (process.env.RUN_ON_START === "true") runJob();
});
