import cron from "node-cron";
import express from "express";
import puppeteer from "puppeteer";
import { google } from "googleapis";
import axios from "axios";

// -------------------- Config --------------------
const SHEET_ID = process.env.SHEET_ID || "";
const SHEET_NAME = process.env.SHEET_NAME || "Raw";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const COOKIES_JSON = process.env.COOKIES_JSON || "";
const GROUP_URLS = (process.env.GROUP_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
const TZ = "Asia/Bangkok";
const SCROLL_COUNT = 20; 

const log = (emoji, message) => console.log(`[${new Date().toLocaleString("th-TH", { timeZone: TZ })}] ${emoji} ${message}`);
const randomDelay = (min, max) => new Promise(res => setTimeout(res, Math.floor(Math.random() * (max - min + 1) + min)));

// --- แจ้งเตือน Discord เฉพาะตอนบอทมีปัญหา ---
async function notifyError(message) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await axios.post(DISCORD_WEBHOOK_URL, {
      content: `⚠️ **บอทมีปัญหา!**\n🚨 รายละเอียด: ${message}\n⏰ เวลา: ${new Date().toLocaleString("th-TH", { timeZone: TZ })}`
    });
  } catch (e) { log("❌", `Discord Error: ${e.message}`); }
}

async function getRecentContents(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({ 
      spreadsheetId: SHEET_ID, 
      range: `${SHEET_NAME}!F:F` 
    });
    if (!res.data.values) return new Set();
    // ดึง 200 รายการล่าสุดมาเทียบเนื้อหา (Content-Based)
    const contents = res.data.values.slice(-200).map(r => r[0] ? r[0].trim() : "").filter(Boolean);
    log("📊", `โหลดข้อมูลเก่ามาเทียบซ้ำแล้ว ${contents.length} รายการ`);
    return new Set(contents);
  } catch (e) { return new Set(); }
}

async function runJob() {
  log("🚀", "--- เริ่มทำงาน (Full System: สุ่มไถ + สรุปยอด + แจ้งเตือนเฉพาะตอนตาย) ---");
  let browser;
  try {
    const rawAuth = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS;
    const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(rawAuth), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    const sheets = google.sheets({ version: "v4", auth });
    const existingContents = await getRecentContents(sheets);
    
    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0");

    if (COOKIES_JSON) {
      const cookies = JSON.parse(COOKIES_JSON.replace(/[\u0000-\u001F\u007F-\u009F]/g, ""));
      await page.setCookie(...cookies.map(c => ({ ...c, domain: c.domain || ".facebook.com", path: c.path || "/" })));
    }

    let allRows = [];
    for (const url of GROUP_URLS) {
      log("🌐", `ตรวจสอบกลุ่ม: ${url}`);
      try {
        const response = await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
        if (page.url().includes("checkpoint") || response.status() >= 400) {
          throw new Error(`ติดด่านตรวจหรือเข้าหน้าเว็บไม่ได้`);
        }

        // ระบบสุ่มไถหน้าจอ และกางคอมเมนต์
        for (let i = 0; i < SCROLL_COUNT; i++) {
          const scrollDistance = Math.floor(Math.random() * (1200 - 800 + 1) + 800); // สุ่มระยะไถ 800-1200
          await page.evaluate((dist) => window.scrollBy(0, dist), scrollDistance);
          
          await page.evaluate(() => {
            // ปิด Pop-up กวนใจ
            const closeBtns = document.querySelectorAll('div[aria-label="ปฏิเสธ"], div[aria-label="ปิด"]');
            closeBtns.forEach(b => b.click());
            // กางคอมเมนต์
            const btns = Array.from(document.querySelectorAll('span, div[role="button"]'))
              .filter(el => el.innerText.includes("ดูความคิดเห็น") || el.innerText.includes("ดูเพิ่ม"));
            if (btns.length > 0) btns[0].click(); 
          });

          await randomDelay(2000, 4500); // สุ่มเวลารอ 2-4.5 วิ
          if (i % 5 === 0) log(" ↳", `ไถและกวาดเม้นรอบที่ ${i}/${SCROLL_COUNT}...`);
        }

        const posts = await page.$$eval("div[role='article'], div.x1yzt60o, div.x1iorvi4", (articles) => {
          return articles.map(a => {
            const linkEl = a.querySelector("a[href*='/posts/'], a[href*='/permalink/']");
            let link = linkEl ? linkEl.href.split('?')[0] : "";
            const author = (a.querySelector("h3 span a, strong a, span[dir='auto'] a")?.innerText || "Unknown").trim();
            const fullText = (a.innerText || "").trim(); // กวาดเนื้อหาทั้งหมด
            return { link, author, text: fullText };
          });
        });

        const newEntries = posts.filter(p => p.text.length > 10 && !existingContents.has(p.text));
        
        // --- 📊 สรุป Log รายกลุ่ม ---
        const duplicateCount = posts.length - newEntries.length;
        log("📥", `กลุ่มนี้: [พบใหม่ ${newEntries.length}] | [ซ้ำ ${duplicateCount}] | [รวมที่เห็น ${posts.length}]`);

        newEntries.forEach(p => {
          allRows.push([new Date().toLocaleString("th-TH", { timeZone: TZ }), url, p.link, p.author, "", p.text]);
          existingContents.add(p.text);
        });
      } catch (err) {
        log("❌", `ผิดพลาดในกลุ่ม ${url}: ${err.message}`);
        await notifyError(`กลุ่ม ${url} มีปัญหา: ${err.message}`);
      }
    }

    if (allRows.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:A`,
        valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
        requestBody: { values: allRows },
      });
      log("✅", `บันทึกข้อมูลใหม่สำเร็จ ${allRows.length} รายการ`);
    }

  } catch (e) { 
    log("💀", `บอทหยุดทำงาน: ${e.message}`);
    await notifyError(`บอทหยุดทำงานกะทันหัน: ${e.message}`);
  } finally { 
    if (browser) await browser.close(); 
    log("🏁", "จบการทำงานรอบนี้");
  }
}

const app = express();
app.get("/", (req, res) => res.send("Full Smart Bot Active"));
app.listen(process.env.PORT || 8080, () => {
  log("🤖", "Server Online (Stable Full Mode)");
  cron.schedule(process.env.CRON_SCHEDULE || "*/20 * * * *", runJob);
  if (process.env.RUN_ON_START === "true") runJob();
});
