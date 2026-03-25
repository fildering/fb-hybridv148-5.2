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
const SCROLL_COUNT = 15; // จำนวนรอบการไถหน้าจอ

const randomDelay = (min, max) => new Promise(res => setTimeout(res, Math.floor(Math.random() * (max - min + 1) + min)));

function log(emoji, message) {
  const now = new Date().toLocaleString("th-TH", { timeZone: TZ });
  console.log(`[${now}] ${emoji} ${message}`);
}

// ฟังก์ชันดึงข้อมูลจาก Sheets พร้อมโชว์ Log การเทียบข้อมูล
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

    // ดึง 200 ลิงก์ล่าสุดมาตัดหางพารามิเตอร์ (?mibextid...) เพื่อใช้เช็คซ้ำ
    const links = res.data.values.slice(-200).map(r => r[0] ? r[0].split('?')[0] : "").filter(Boolean);
    
    log("📊", `โหลดข้อมูลจาก Sheets สำเร็จ: พบโพสต์ล่าสุด ${links.length} รายการมาเทียบซ้ำ`);
    
    return new Set(links);
  } catch (e) { 
    log("⚠️", `ดึงข้อมูลเก่าจาก Sheets ไม่สำเร็จ: ${e.message}`);
    return new Set(); 
  }
}

async function runJob() {
  log
