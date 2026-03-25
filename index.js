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
const SCROLL_COUNT = 20; // เพิ่มรอบไถหน่อยเพื่อให้กางคอมเมนต์ได้ทั่วถึง

const log = (emoji, message) => console.log(`[${new Date().toLocaleString("th-TH", { timeZone: TZ })}] ${emoji} ${message}`);

// ดึง "เนื้อหาโพสต์" (คอลัมน์ F) ล่าสุด 200 รายการมาเทียบ
async function getRecentContents(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({ 
      spreadsheetId: SHEET_ID, 
      range: `${SHEET_NAME}!F:F` 
    });
    if (!res.data.values) return new Set();
    // เก็บเนื้อหา 200 อันล่าสุดไว้ใน Set เพื่อการเช็คที่รวดเร็ว
    const contents = res.data.values.slice(-200).map(r => r[0] ? r[0].trim() : "").filter(Boolean);
    log("📊", `โหลดเนื้อหาเก่าจาก Sheets มาเทียบซ้ำแล้ว ${contents.length} รายการ`);
    return new Set(contents);
  } catch (e) { 
    log("⚠️", "ดึงข้อมูลเก่าไม่สำเร็จ");
    return new Set(); 
  }
}

async function runJob() {
  log("🚀", "--- เริ่มรันโหมดตรวจจับความเคลื่อนไหว (Content-Based) ---");
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
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

      for (let i = 0; i < SCROLL_COUNT; i++) {
        await page.evaluate(() => window.scrollBy(0, 1200));
        await page.evaluate(async () => {
          // ปิด Pop-up และกางเม้น (กางให้หมดเพื่อให้เนื้อหาเปลี่ยนบอทจะได้เห็น)
          const btns = Array.from(document.querySelectorAll('span, div[role="button"]'))
            .filter(el => el.innerText.includes("ดูความคิดเห็น") || el.innerText.includes("ดูเพิ่ม"));
          btns.forEach(b => b.click());
        });
        await new Promise(r => setTimeout(r, 3000));
        if (i % 5 === 0) log(" ↳", `ไถหน้าจอครั้งที่ ${i}/${SCROLL_COUNT}...`);
      }

      const posts = await page.$$eval("div[role='article']", (articles) => {
        return articles.map(a => {
          const linkEl = a.querySelector("a[href*='/posts/'], a[href*='/permalink/']");
          let link = linkEl ? linkEl.href.split('?')[0] : "";
          const author = (a.querySelector("h3 span a, strong a, span[dir='auto'] a")?.innerText || "Unknown").trim();
          
          // 🔥 จุดสำคัญ: ดึงเนื้อหาทั้งหมดในก้อนโพสต์ (รวมคอมเมนต์ที่กางแล้ว)
          const fullText = (a.innerText || "").trim(); 
          
          return { link, author, text: fullText };
        });
      });

      // กรองโดยใช้ Text เทียบ (ถ้ามีคนเม้นเพิ่ม fullText จะเปลี่ยน บอทจะถือเป็นโพสต์ใหม่)
      const newPosts = posts.filter(p => p.text.length > 5 && !existingContents.has(p.text));
      log("📥", `เจอความเคลื่อนไหวใหม่ ${newPosts.length} รายการ (จากทั้งหมด ${posts.length} โพสต์)`);
      
      newPosts.forEach(p => {
        allRows.push([new Date().toLocaleString("th-TH", { timeZone: TZ }), url, p.link, p.author, "", p.text]);
        existingContents.add(p.text);
      });
    }

    if (allRows.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:A`,
        valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
        requestBody: { values: allRows },
      });
      log("✅", `อัปเดตข้อมูลใหม่ ${allRows.length} รายการสำเร็จ!`);
    }
  } catch (e) { log("❌", e.message); }
  finally { if (browser) await browser.close(); log("🏁", "จบงาน"); }
}

const app = express();
app.get("/", (req, res) => res.send("Content-Check Bot Active"));
app.listen(process.env.PORT || 8080, () => {
  cron.schedule(process.env.CRON_SCHEDULE || "*/20 * * * *", runJob);
  if (process.env.RUN_ON_START === "true") runJob();
});
