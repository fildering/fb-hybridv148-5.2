import cron from "node-cron";
import express from "express";
import puppeteer from "puppeteer";
import { google } from "googleapis";

// -------------------- ENV (รองรับชื่อเดิม + ชื่อที่ท่านฟิวส์ตั้งใน Railway) --------------------
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "*/15 * * * *";
const RUN_ON_START = (process.env.RUN_ON_START || process.env.RUN_ON_START || "true").toLowerCase() === "true";
const TZ = process.env.TZ || "Asia/Bangkok";

// Google Sheets vars (Railway ของท่านฟิวส์ใช้ GOOGLE_SHEET_ID / GOOGLE_CREDENTIALS)
const SHEET_ID = process.env.SHEET_ID || process.env.GOOGLE_SHEET_ID || "";
const SHEET_NAME = process.env.SHEET_NAME || "Raw";

// Group URLs (Railway ใช้ GROUP_URLS ตรงแล้ว)
const RAW_GROUP_URLS = process.env.GROUP_URLS || "";
const GROUP_URLS = RAW_GROUP_URLS
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Cookies (Railway ของท่านฟิวส์ใช้ COOKIES_JSON)
const COOKIES_JSON =
  process.env.COOKIES_JSON ||
  process.env.FB_COOKIE_JSON ||
  process.env.FB_COOKIE ||
  "";

// Optional knobs (เผื่อท่านฟิวส์มีอยู่แล้วใน Railway)
const MAX_POSTS_PER_GROUP = Number(process.env.MAX_POSTS_PER_GROUP || 10);
const SCROLL_LOOPS = Number(process.env.SCROLL_LOOPS || 0);
const SCROLL_PAUSE_MS = Number(process.env.SCROLL_PAUSE_MS || 800);
const SKIP_PINNED = (process.env.SKIP_PINNED || "false").toLowerCase() === "true";

function log(...args) {
  console.log(...args);
}

function normalizeFacebookGroupUrl(url) {
  try {
    const u = new URL(url);
    u.hostname = "www.facebook.com";
    u.search = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

function normalizePostUrl(url) {
  try {
    const u = new URL(url);
    u.hostname = "www.facebook.com";
    u.search = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

// -------------------- Google Sheets --------------------
async function getSheetsClient() {
  // Railway ของท่านฟิวส์ใช้ GOOGLE_CREDENTIALS (service account json)
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS;
  if (!raw) throw new Error("GOOGLE_CREDENTIALS / GOOGLE_SERVICE_ACCOUNT_JSON not set");

  const key = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function appendRowsToSheet(rows) {
  if (!SHEET_ID) {
    log("⚠️ SHEET_ID/GOOGLE_SHEET_ID not set. Skip append.");
    return;
  }

  const rawCred = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS;
  if (!rawCred) {
    log("⚠️ GOOGLE_CREDENTIALS not set. Skip append.");
    return;
  }

  if (!rows.length) {
    log("No rows to append");
    return;
  }

  const sheets = await getSheetsClient();
  const range = `${SHEET_NAME}!A:Z`;

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });

  log(`✅ Appended ${rows.length} row(s) to Google Sheets`);
}

// -------------------- Puppeteer --------------------
async function launchBrowser() {
  return puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
}

async function newAuthedPage(browser) {
  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );

  await page.setExtraHTTPHeaders({
    "Accept-Language": "th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7",
  });

  if (!COOKIES_JSON) {
    log("⚠️ No COOKIES_JSON/FB_COOKIE_JSON provided");
    return page;
  }

  let cookies;
  try {
    cookies = JSON.parse(COOKIES_JSON);
    if (!Array.isArray(cookies)) throw new Error("cookie json not array");
  } catch (e) {
    throw new Error(`COOKIES_JSON parse error: ${e.message}`);
  }

  const fixed = cookies.map((c) => ({
    ...c,
    domain: c.domain || ".facebook.com",
    path: c.path || "/",
  }));

  await page.setCookie(...fixed);
  log("Cookies injected:", fixed.length);

  return page;
}

async function ensureLoggedIn(page) {
  await page.goto("https://www.facebook.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  const url = page.url();
  if (url.includes("/login") || url.includes("checkpoint")) {
    throw new Error(`Not logged in (redirected): ${url}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function maybeScroll(page) {
  for (let i = 0; i < SCROLL_LOOPS; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(SCROLL_PAUSE_MS);
  }
}


async function scrapeGroup(page, groupUrl) {
  const url = normalizeFacebookGroupUrl(groupUrl);
  log("Scraping group page:", url);

  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  await maybeScroll(page);

  const finalUrl = page.url();
  log("Final URL:", finalUrl);

  const html = await page.content();
  const looksJoin =
    finalUrl.includes("/groups/") &&
    (finalUrl.includes("join") ||
      html.includes("เข้าร่วมกลุ่ม") ||
      html.toLowerCase().includes("join group") ||
      html.toLowerCase().includes("request to join"));

  if (finalUrl.includes("/login") || finalUrl.includes("checkpoint")) {
    return { status: "login_required", rows: [], finalUrl };
  }
  if (looksJoin) {
    return { status: "join_required", rows: [], finalUrl };
  }

  try {
    await page.waitForSelector("div[role='feed']", { timeout: 20000 });
  } catch {}

  const posts = await page.$$eval("div[role='article']", (articles) => {
    const out = [];
    for (const a of articles) {
      const anchors = Array.from(a.querySelectorAll("a"))
        .map((x) => x.href)
        .filter(Boolean);

      let permalink =
        anchors.find((h) => h.includes("/posts/")) ||
        anchors.find((h) => h.includes("/permalink/")) ||
        anchors.find((h) => h.includes("/story.php")) ||
        "";

      const candidates = Array.from(a.querySelectorAll("div, span"))
        .map((el) => (el.innerText || "").trim())
        .filter((t) => t.length >= 30);

      const text =
        candidates.sort((x, y) => y.length - x.length)[0] ||
        (a.innerText || "").trim();

      let author = "";
      const authorEl =
        a.querySelector("h3 a") ||
        a.querySelector("strong a") ||
        a.querySelector("a[role='link']");
      if (authorEl && authorEl.innerText) author = authorEl.innerText.trim();

      let timeText = "";
      const timeEl = a.querySelector("abbr") || a.querySelector("span[aria-label]");
      if (timeEl && timeEl.innerText) timeText = timeEl.innerText.trim();

      out.push({ permalink, author, timeText, text });
    }
    return out;
  });

  // Optional: filter pinned crudely (best-effort)
  let cleaned = posts
    .map((p) => ({
      ...p,
      permalink: p.permalink || "",
      text: (p.text || "").replace(/\s+\n/g, "\n").trim(),
    }))
    .filter((p) => p.permalink && p.text);

  if (SKIP_PINNED) {
    cleaned = cleaned.filter((p) => !p.text.includes("ปักหมุด") && !p.text.toLowerCase().includes("pinned"));
  }

  cleaned = cleaned.slice(0, MAX_POSTS_PER_GROUP);

  const seen = new Set();
  const unique = [];
  for (const p of cleaned) {
    const n = normalizePostUrl(p.permalink);
    if (seen.has(n)) continue;
    seen.add(n);
    unique.push({ ...p, permalink: n });
  }

  return { status: unique.length ? "ok" : "no_posts", rows: unique, finalUrl };
}

// -------------------- Job --------------------
async function runJob() {
  const startedAt = Date.now();
  log("Job start", "TZ:", TZ, "time:", startedAt);
  log("Groups:", GROUP_URLS.length);

  if (!GROUP_URLS.length) {
    log("⚠️ GROUP_URLS empty. Nothing to do.");
    return;
  }

  let browser;
  try {
    browser = await launchBrowser();
    const page = await newAuthedPage(browser);

    await ensureLoggedIn(page);
    log("Facebook session OK");

    const allRowsForSheet = [];
    const nowIso = new Date().toISOString();

    for (const g of GROUP_URLS) {
      const groupUrl = normalizeFacebookGroupUrl(g);
      const res = await scrapeGroup(page, groupUrl);

      if (res.status === "join_required") {
        log("❌ join required:", groupUrl);
        continue;
      }
      if (res.status === "login_required") {
        log("❌ login/checkpoint:", res.finalUrl);
        break;
      }

      log("Group result:", groupUrl, "status:", res.status, "rows:", res.rows.length);

      for (const p of res.rows) {
        allRowsForSheet.push([nowIso, groupUrl, p.permalink, p.author, p.timeText, p.text]);
      }
    }

    await appendRowsToSheet(allRowsForSheet);
    log("Job done. took(ms):", Date.now() - startedAt);
  } catch (e) {
    log("❌ Job error:", e?.message || e);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}

// -------------------- Health Server --------------------
function startHealthServer() {
  const app = express();
  const port = Number(process.env.PORT || 8080);

  app.get("/", (_req, res) => res.status(200).send("ok"));
  app.get("/health", (_req, res) => res.status(200).json({ ok: true, ts: Date.now() }));

  app.listen(port, () => log("health server started PORT:", port));
}

// -------------------- Main --------------------
(function main() {
  log("scheduler init", "CRON_SCHEDULE:", CRON_SCHEDULE, "RUN_ON_START:", RUN_ON_START, "TZ:", TZ);

  startHealthServer();

  cron.schedule(
    CRON_SCHEDULE,
    async () => {
      await runJob();
    },
    { timezone: TZ }
  );

  if (RUN_ON_START) {
    runJob();
  }
})();
