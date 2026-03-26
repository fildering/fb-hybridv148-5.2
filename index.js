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

// 🔥 เก็บ Browser และ Page ไว้ข้างนอกฟังก์ชันเพื่อให้เปิดค้างไว้ได้
let sharedBrowser = null;
let sharedPage = null;

async function getRecentContents(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!F:F` });
    if (!res.data.values) return new Set();
    return new Set(res.data.values.flat().map(c => c ? c.trim() : "").filter(Boolean));
  } catch (e) { return new Set(); }
}

async function runJob() {
  log("🚀", "--- เริ่มงาน: โหมดเปิดค้าง (Persistent) + กำจัด Popup ---");
  
  try {
    // 1. ตรวจสอบการเชื่อมต่อ ถ้าไม่มีหรือหลุดให้ต่อใหม่
    if (!sharedBrowser || !sharedBrowser.isConnected()) {
      log("📡", "กำลังเชื่อมต่อหน้าจอใหม่...");
      sharedBrowser = await puppeteer.connect({
        browserWSEndpoint: `ws://127.0.0.1:3000?--window-size=1280,900`,
        defaultViewport: null
      });
      sharedPage = await sharedBrowser.newPage();
      if (COOKIES_JSON) {
        try { await sharedPage.setCookie(...JSON.parse(COOKIES_JSON)); } catch (e) { log("⚠️", "Cookie ผิดรูปแบบ"); }
      }
    }

    const rawAuth = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS;
    const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(rawAuth), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    const sheets = google.sheets({ version: "v4", auth });
    const existingContents = await getRecentContents(sheets);

    for (const url of GROUP_URLS) {
      log("🌐", `ตรวจสอบกลุ่ม: ${url}`);
      // 2. ใช้การ Reload หน้าเดิมแทนการเปิดใหม่
      await sharedPage.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
      await randomDelay(3000, 5000);

      // --- ส่วนแก้หน้ากั้น Continue อัตโนมัติ ---
      let postsCount = await sharedPage.evaluate(() => document.querySelectorAll("div[role='article']").length);
      if (postsCount === 0) {
        const autoClicked = await sharedPage.evaluate(() => {
          const keywords = ["Continue", "ดำเนินการต่อ", "ใช่", "ตกลง"];
          const btns = Array.from(document.querySelectorAll('div[role="button"], span, a, button'));
          const target = btns.find(b => keywords.some(k => b.innerText.includes(k)));
          if (target) { target.click(); return true; }
          return false;
        });
        if (autoClicked) {
          await randomDelay(15000, 20000);
          postsCount = await sharedPage.evaluate(() => document.querySelectorAll("div[role='article']").length);
        }
      }

      if (postsCount === 0) {
        log("🛑", "ยังติดหน้ากั้น! พี่เปิด /debugger ไปกดแค่ปุ่มเดียวพอนะ (ไม่ต้องใส่รหัส)");
        await new Promise(res => setTimeout(res, 120000)); 
      }

      log("✅", "เริ่มไถหน้าจอพร้อมปิด Popup ขวางทาง...");
      for (let i = 1; i <= SCROLL_COUNT; i++) {
        await sharedPage.evaluate(() => window.scrollBy(0, 1000));
        
        // 🔥 ส่วนกำจัด Popup (ปุ่ม x หรือคำว่า ปิด)
        await sharedPage.evaluate(() => {
          const closeKeywords = ["ปิด", "Close", "Not Now", "ไม่ใช่ตอนนี้"];
          const targets = Array.from(document.querySelectorAll('div[role="button"], span, i, button, [aria-label="ปิด"], [aria-label="Close"]'))
            .filter(el => closeKeywords.some(k => el.innerText?.includes(k) || el.getAttribute("aria-label")?.includes(k)));
          targets.forEach(btn => btn.click());
        });

        // กางปุ่ม ดูเพิ่มเติม
        await sharedPage.evaluate(async () => {
          const keywords = ["ดูเพิ่มเติม", "ความคิดเห็นเพิ่มเติม", "การตอบกลับ", "ดูเพิ่ม"];
          const btns = Array.from(document.querySelectorAll('div[role="button"], span')).filter(el => keywords.some(k => el.innerText.includes(k)));
          btns.forEach(b => b.click());
        });
        
        await randomDelay(2000, 3000);
      }

      const finalPosts = await sharedPage.$$eval("div[role='article']", (articles) => {
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
      let allRows = newItems.map(p => [new Date().toLocaleString("th-TH", { timeZone: TZ }), url, p.link, p.author, "", p.text]);

      if (allRows.length > 0) {
        await sheets.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:A`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values: allRows } });
        log("✅", `บันทึกสำเร็จ ${allRows.length} รายการ`);
      }
    }
  } catch (e) { log("💀", `Error: ${e.message}`); }
  // 🔥 ไม่ใส่ browser.disconnect() เพื่อให้จอค้างไว้รอรอบหน้า
  log("🏁", "จบรอบนี้ (หน้าจอค้างไว้รอรอบถัดไป)");
}

const app = express();
app.get("/", (req, res) => res.send("<h1>Bot Persistent Active</h1><p><a href='/debugger'>ไปหน้าจอรีโมท</a></p>"));
app.listen(8080, "0.0.0.0", () => {
  log("📶", "Standby 8080");
  cron.schedule("*/20 * * * *", runJob);
  if (process.env.RUN_ON_START === "true") runJob();
});
