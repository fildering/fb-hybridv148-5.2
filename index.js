import cron from "node-cron";
import express from "express";
import puppeteer from "puppeteer";
import { google } from "googleapis";

// -------------------- Config --------------------
const SHEET_ID = process.env.SHEET_ID || "";
const SHEET_NAME = process.env.SHEET_NAME || "Raw";
const COOKIES_JSON = process.env.COOKIES_JSON || "";
const GROUP_URLS = (process.env.GROUP_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
const TZ = "Asia/Bangkok";
const SCROLL_COUNT = 15; 

const randomDelay = (min, max) => new Promise(res => setTimeout(res, Math.floor(Math.random() * (max - min + 1) + min)));

function log(emoji, message) {
  const now = new Date().toLocaleString("th-TH", { timeZone: TZ });
  console.log(`[${now}] ${emoji} ${message}`);
}

async function getRecentLinks(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({ 
      spreadsheetId: SHEET_ID, 
      range: `${SHEET_NAME}!C:C` 
    });
    
    if (!res.data.values || res.data.values.length === 0) {
      log("📊", "ไม่พบข้อมูลเดิมใน Sheets (จะเริ่มเก็บใหม่ทั้งหมด)");
      return new Set();
    }

    const links = res.data.values.slice(-200).map(r => r[0] ? r[0].split('?')[0] : "").filter(Boolean);
    log("📊", `โหลดข้อมูลจาก Sheets สำเร็จ: พบโพสต์ล่าสุด ${links.length} รายการมาเทียบซ้ำ`);
    return new Set(links);
  } catch (e) { 
    log("⚠️", `ดึงข้อมูลเก่าไม่สำเร็จ: ${e.message}`);
    return new Set(); 
  }
}

async function runJob() {
  log("🚀", "--- เริ่มรันบอทเวอร์ชัน Full Expand (Fixed Error) ---");
  let browser;
  try {
    const rawAuth = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS;
    const auth = new google.auth.GoogleAuth({ 
      credentials: JSON.parse(rawAuth), 
      scopes: ["https://www.googleapis.com/auth/spreadsheets"] 
    });
    const sheets = google.sheets({ version: "v4", auth });
    const existingLinks = await getRecentLinks(sheets);
    
    browser = await puppeteer.launch({ 
        headless: "new", 
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] 
    });
    
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

    if (COOKIES_JSON) {
      const cookies = JSON.parse(COOKIES_JSON.replace(/[\u0000-\u001F\u007F-\u009F]/g, ""));
      await page.setCookie(...cookies.map(c => ({ ...c, domain: c.domain || ".facebook.com", path: c.path || "/" })));
      log("🍪", "โหลด Cookie เรียบร้อย");
    }

    let allRows = [];
    for (const url of GROUP_URLS) {
      log("🌐", `เข้าตรวจสอบกลุ่ม: ${url}`);
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
      await randomDelay(4000, 6000);

      for (let i = 0; i < SCROLL_COUNT; i++) {
        await page.evaluate(() => window.scrollBy(0, 1200));
        await randomDelay(2500, 4000);

        await page.evaluate(async () => {
          const closeBtns = document.querySelectorAll('div[aria-label="ปฏิเสธ"], div[aria-label="Close"], div[aria-label="ปิด"]');
          closeBtns.forEach(b => b.click());
          const btns = Array.from(document.querySelectorAll('span, div[role="button"]'))
            .filter(el => el.innerText.includes("ดูความคิดเห็น") || el.innerText.includes("ดูเพิ่ม") || el.innerText.includes("View more comments"));
          for (const btn of btns) {
            btn.click();
            await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
          }
        });
        if (i % 5 === 0) log(" ↳", `ไถและกวาดเม้นครั้งที่ ${i}/${SCROLL_COUNT}...`);
      }

      const posts = await page.$$eval("div[role='article'], div.x1yzt60o, div.x1iorvi4", (articles) => {
        return articles.map(a => {
          const linkEl = a.querySelector("a[href*='/posts/'], a[href*='/permalink/'], a[aria-label*='นาที'], a[aria-label*='ชั่วโมง']");
          let link = linkEl ? linkEl.href.split('?')[0] : "";
          if (link.endsWith('/')) link = link.slice(0, -1);
          const author = (a.querySelector("h3 span a, strong a, span[dir='auto'] a")?.innerText || "Unknown").trim();
          const text = (a.querySelector('div[dir="auto"], div.x1iorvi4, div.x1y1aw1k')?.innerText || "").trim();
          return { link, author, text };
        });
      });

      const newPosts = posts.filter(p => p.link && p.text.length > 5 && !existingLinks.has(p.link));
      log("📥", `พบโพสต์ใหม่ ${newPosts.length} รายการ`);
      newPosts.forEach(p => {
        allRows.push([new Date().toLocaleString("th-TH", { timeZone: TZ }), url, p.link, p.author, "", p.text]);
        existingLinks.add(p.link);
      });
    }

    if (allRows.length > 0) {
      log("📝", `บันทึก ${allRows.length} รายการลง Sheets...`);
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:A`,
        valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
        requestBody: { values: allRows },
      });
      log("✅", "สำเร็จ!");
    } else {
      log("😴", "ไม่มีของใหม่");
    }
  } catch (e) { log("❌", "Error: " + e.message); }
  finally { if (browser) await browser.close(); log("🏁", "จบงาน"); }
}

const app = express();
app.get("/", (req, res) => res.send("Active"));
app.listen(process.env.PORT || 8080, () => {
  log("🤖", "Server Online");
  cron.schedule(process.env.CRON_SCHEDULE || "*/20 * * * *", runJob);
  if (process.env.RUN_ON_START === "true") runJob();
});
