import cron from "node-cron";
import express from "express";
import puppeteer from "puppeteer";
import { google } from "googleapis";
import axios from "axios";
import FormData from "form-data";
import { authenticator } from "otplib"; // ⚠️ ต้องลงแพ็คเกจนี้ด้วยนะพี่

// -------------------- Config --------------------
const SHEET_ID = process.env.SHEET_ID || "";
const SHEET_NAME = process.env.SHEET_NAME || "Raw";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const COOKIES_JSON = process.env.COOKIES_JSON || "";
const GROUP_URLS = (process.env.GROUP_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
const TZ = "Asia/Bangkok";
const SCROLL_COUNT = 15; 

// --- 🔑 Credentials สำหรับกู้ชีพ ---
const PASS_VAL = process.env.FB_PASS_OVERRIDE || "";
const TWO_FA_SECRET = process.env.FB_2FA_SECRET || ""; // Secret Key จากเฟซบุ๊ก

const log = (emoji, message) => console.log(`[${new Date().toLocaleString("th-TH", { timeZone: TZ })}] ${emoji} ${message}`);
const randomDelay = (min, max) => new Promise(res => setTimeout(res, Math.floor(Math.random() * (max - min + 1) + min)));

function isPeakTime() {
  const hour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(new Date()));
  return hour >= 8 || hour === 0; 
}

async function notifyDiscord(message, screenshotBuffer = null) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const form = new FormData();
    form.append("content", `📢 **FB Scraper Report**\n${message}`);
    if (screenshotBuffer) form.append("file", screenshotBuffer, { filename: "screen.png", contentType: "image/png" });
    await axios.post(DISCORD_WEBHOOK_URL, form, { headers: { ...form.getHeaders() }, timeout: 30000 });
  } catch (e) { log("❌", "Discord Notify Error"); }
}

async function getRecentContents(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!F:F` });
    if (!res.data.values) return new Set();
    return new Set(res.data.values.flat().map(c => c ? c.trim() : "").filter(Boolean));
  } catch (e) { return new Set(); }
}

async function runJob() {
  log("🚀", "--- เริ่มงาน: Immortal Full Feature Mode ---");
  let browser;
  try {
    const rawAuth = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS;
    const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(rawAuth), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    const sheets = google.sheets({ version: "v4", auth });
    const existingContents = await getRecentContents(sheets);
    
    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0");

    if (COOKIES_JSON) {
      const cookies = JSON.parse(COOKIES_JSON.replace(/[\u0000-\u001F\u007F-\u009F]/g, ""));
      await page.setCookie(...cookies.map(c => ({ ...c, domain: c.domain || ".facebook.com", path: c.path || "/" })));
    }

    let allRows = [];
    for (const url of GROUP_URLS) {
      log("🌐", `ตรวจสอบกลุ่ม: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await randomDelay(8000, 10000);

      // --- 🛠️ STEP 1: กู้ชีพ Continue ---
      const contBtn = await page.evaluateHandle(() => {
        const keywords = ["Continue", "ดำเนินการต่อ", "ใช่", "ตกลง"];
        const btns = Array.from(document.querySelectorAll('div[role="button"], span, a, button'));
        return btns.find(b => keywords.some(k => b.innerText.includes(k)));
      });

      if (contBtn.asElement()) {
        const box = await contBtn.asElement().boundingBox();
        if (box) {
          log("🖱️", "พบหน้ากั้น! กำลังกด Continue...");
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          await randomDelay(12000, 15000);
        }
      }

      // --- 🛠️ STEP 2: กู้ชีพ Password ---
      const passInp = await page.$('input[type="password"], input[name="pass"]');
      if (passInp && PASS_VAL) {
        log("🔑", "พบด่านรหัสผ่าน! กำลังกรอกรหัส...");
        await page.type('input[type="password"]', PASS_VAL);
        await page.keyboard.press('Enter');
        await randomDelay(15000, 18000);
      }

      // --- 🛠️ STEP 3: กู้ชีพ OTP (Auto 2FA) ---
      const otpInp = await page.$('input[name="approvals_code"], input#approvals_code');
      if (otpInp && TWO_FA_SECRET) {
        const token = authenticator.generate(TWO_FA_SECRET.replace(/\s/g, ''));
        log("🔢", `พบด่าน OTP! เจนรหัสให้อัตโนมัติ: ${token}`);
        await page.type('input[name="approvals_code"]', token);
        await page.keyboard.press('Enter');
        await randomDelay(15000, 18000);
      }

      // --- 🛠️ STEP 4: เช็คสถานะหลังแก้ด่าน ---
      const finalCount = await page.evaluate(() => document.querySelectorAll("div[role='article']").length);
      if (finalCount === 0) {
        log("🚨", "ยังมองเห็น 0 โพสต์! หยุดรันและส่งรูป");
        const screen = await page.screenshot();
        await notifyDiscord(`🆘 เข้าไม่ได้ (0 โพสต์) ที่กลุ่ม: ${url}\nลองดูรูปว่าติดด่านไหนเพิ่มครับพี่ฟิวส์`, screen);
        return; 
      }

      // --- 🛠️ STEP 5: ไถงาน & Expand ---
      log("✅", `เข้าได้ปกติ! พบโพสต์ ${finalCount} รายการ เริ่มงาน...`);
      for (let i = 1; i <= SCROLL_COUNT; i++) {
        await page.evaluate(() => window.scrollBy(0, 1000));
        const clicked = await page.evaluate(() => {
          const keywords = ["ดูเพิ่มเติม", "ความคิดเห็นเพิ่มเติม", "การตอบกลับ", "ดูเพิ่ม"];
          const btns = Array.from(document.querySelectorAll('div[role="button"], span')).filter(el => keywords.some(k => el.innerText.includes(k)));
          btns.forEach(b => b.click());
          return btns.length;
        });
        await randomDelay(3000, 4000);
        log(" ↳", `รอบที่ ${i}: [กางปุ่ม: ${clicked}]`);
      }

      const posts = await page.$$eval("div[role='article']", (articles) => {
        return articles.map(a => {
          const link = a.querySelector("a[href*='/posts/'], a[href*='/permalink/']")?.href.split('?')[0] || "";
          const author = a.querySelector("h3 span a, strong a")?.innerText.trim() || "Unknown";
          let txt = a.innerText.trim();
          const junk = ["ถูกใจ", "แชร์", "ตอบกลับ", "ส่ง", "เขียนความคิดเห็น..."];
          junk.forEach(w => { const regex = new RegExp(`^${w}$|^${w}\\n|\\n${w}$|\\n${w}\\n`, 'gm'); txt = txt.replace(regex, "\n"); });
          return { link, author, text: txt.replace(/\n\s*\n/g, '\n').trim() };
        });
      });

      const newToSave = posts.filter(p => p.text.length > 10 && !existingContents.has(p.text));
      newToSave.forEach(p => {
        allRows.push([new Date().toLocaleString("th-TH", { timeZone: TZ }), url, p.link, p.author, "", p.text]);
        existingContents.add(p.text);
      });
    }

    if (allRows.length > 0) {
      await sheets.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:A`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values: allRows } });
      log("✅", `บันทึกใหม่ ${allRows.length} รายการ`);
    }
  } catch (e) { 
    log("💀", e.message);
    const errScreen = await page.screenshot().catch(() => null);
    await notifyDiscord(`บอทพังกลางคัน: ${e.message}`, errScreen);
  } finally { if (browser) await browser.close(); log("🏁", "จบงาน"); }
}

const app = express();
app.get("/", (req, res) => res.send("Active"));
app.listen(process.env.PORT || 8080, () => {
  cron.schedule(process.env.CRON_SCHEDULE || "*/20 * * * *", () => {
    if (isPeakTime()) runJob();
    else if (new Date().getMinutes() < 20) runJob();
  });
  if (process.env.RUN_ON_START === "true") runJob();
});
