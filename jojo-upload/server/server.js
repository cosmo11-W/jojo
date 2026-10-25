// jojo ตัวทดลอง: เซิร์ฟเวอร์ที่ล็อกอิน BigSeller แทนพนักงานแต่ละคน (แบบ B — ไม่ต้องพึ่งอะตอมมิค/คอมในร้าน)
// แต่ละคนล็อกอินด้วยบัญชีย่อย BigSeller ของตัวเอง → เซิร์ฟเวอร์เปิดเบราว์เซอร์ซ่อน (Edge/Chromium) ต่อคน
// เก็บแค่ล็อกอินในหน่วยความจำ ไม่เก็บรหัสผ่าน · ตัวทดลองนี้อ่านอย่างเดียว ไม่เขียนอะไรลง BigSeller
//
// รัน: npm start              (BigSeller จริง)
//      npm run mock           (ข้อมูลจำลอง ไม่แตะ BigSeller)
// ตั้งค่า: JOJO_PORT (5600) · JOJO_HOST (127.0.0.1 = เข้าได้จากเครื่องนี้เท่านั้น) · JOJO_BROWSER (msedge / chromium)
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = 'https://www.bigseller.com';
const PORT = +process.env.JOJO_PORT || 5600;
const HOST = process.env.JOJO_HOST || '127.0.0.1';
const MOCK = !!process.env.JOJO_MOCK;
const SESSION_MS = 12 * 60 * 60 * 1000; // ล็อกอินหมดอายุใน 12 ชม. ต้องล็อกอินใหม่
const NOT_LOGGED_IN = 'ล็อกอิน BigSeller หมดอายุ — ล็อกอินใหม่';

// ---------- เบราว์เซอร์ซ่อน (1 ตัว แยก context ต่อคน = คุกกี้ไม่ปนกัน) ----------
let browserP = null;
function browser() {
  if (!browserP) {
    const { chromium } = require('playwright-core');
    const channel = process.env.JOJO_BROWSER || 'msedge';
    browserP = chromium.launch(channel === 'chromium' ? { headless: true } : { channel, headless: true });
    browserP.catch(() => { browserP = null; });
  }
  return browserP;
}

// token (คุกกี้ jj ของมือถือ) → { user, ctx, at }
const sessions = new Map();
const newToken = () => crypto.randomBytes(24).toString('base64url');

function sessionOf(req) {
  const m = /(?:^|;\s*)jj=([^;]+)/.exec(req.headers.cookie || '');
  const s = m && sessions.get(m[1]);
  if (!s) return null;
  if (Date.now() - s.at > SESSION_MS) { endSession(m[1]); return null; }
  return { token: m[1], ...s };
}
function endSession(token) {
  const s = sessions.get(token);
  sessions.delete(token);
  if (s && s.ctx) s.ctx.close().catch(() => {});
}

// เรียกหลังบ้าน BigSeller ด้วยคุกกี้ของคนนั้น · ทุกคำขอต้องมี header clientType: 1 · code 2001 = ไม่ได้ล็อกอิน
async function bsApi(ctx, p, { form, json, referer } = {}) {
  const r = await ctx.request.fetch(BASE + p, {
    method: form || json ? 'POST' : 'GET',
    headers: { Accept: 'application/json, text/plain, */*', clientType: '1', Referer: referer || BASE + '/web/index.htm',
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : json ? { 'Content-Type': 'application/json' } : {}) },
    data: form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : undefined
  });
  let j;
  try { j = await r.json(); } catch { throw Object.assign(new Error(NOT_LOGGED_IN), { auth: true }); }
  if (j.code === 2001) throw Object.assign(new Error(NOT_LOGGED_IN), { auth: true });
  if (j.code !== 0) throw new Error('BigSeller: ' + (j.msg || j.message || 'ผิดพลาด') + ' (code ' + j.code + ')');
  return j.data;
}

// ---------- ล็อกอิน: กรอกหน้าเว็บ BigSeller จริงในเบราว์เซอร์ซ่อน ----------
// เบราว์เซอร์ใหม่ BigSeller ถามรหัสยืนยันกราฟิก (captcha) + ต้องติ๊กยอมรับเงื่อนไข → ล็อกอิน 2 ขั้น:
//   1) /api/login/start  เปิดหน้าล็อกอิน ส่งรูป captcha ให้คนกรอกเองบนมือถือ
//   2) /api/login        กรอกชื่อ/รหัส/captcha (+ติ๊กยอมรับเมื่อคนติ๊กเอง) แล้วเข้าสู่ระบบ — ไม่ผ่านจะได้รูป captcha ใหม่ ลองต่อได้
const pending = new Map(); // loginId → { ctx, page, at } (หน้าล็อกอินที่รอคนกรอก หมดอายุ 5 นาที)
const PENDING_MS = 5 * 60 * 1000;
const MOCK_CAPTCHA = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="108" height="33"><rect width="108" height="33" fill="#eee"/><text x="14" y="24" font-size="20" font-family="monospace" fill="#555">A7K2</text></svg>');

async function captchaOf(page, prev) {
  // ช่องรหัสยืนยันมีก่อน แต่รูปโหลดตามมาทีหลัง (บางทีต้องคลิกช่องก่อนรูปถึงขึ้น)
  const input = page.locator('input[name="picVerificationCode"]');
  if (!(await input.isVisible().catch(() => false))) return null;
  const img = page.locator('img.comb-code-img');
  try { await img.waitFor({ state: 'visible', timeout: 5000 }); }
  catch { await input.click().catch(() => {}); await img.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {}); }
  for (let i = 0; i < 20; i++) {
    const src = await img.getAttribute('src').catch(() => null);
    if (src && src !== prev) return src;
    await page.waitForTimeout(150);
  }
  return await img.getAttribute('src').catch(() => null);
}
setInterval(() => { for (const [id, p] of pending) if (Date.now() - p.at > PENDING_MS) { pending.delete(id); p.ctx && p.ctx.close().catch(() => {}); } }, 60000).unref();

// BigSeller แจ้งเหตุล็อกอินไม่ผ่านเป็นกล่อง "หมายเหตุ" (el-message-box) ที่ค้างบังทั้งหน้า
// → อ่านข้อความไว้บอกผู้ใช้ แล้วปิดกล่อง (กดปุ่มในกล่อง/Escape) ก่อนกรอกรอบใหม่
async function dismissDialogs(page) {
  const texts = [];
  for (let i = 0; i < 3; i++) {
    const box = page.locator('.el-message-box:visible').first();
    if (!(await box.count())) break;
    texts.push((await box.locator('.el-message-box__message').innerText({ timeout: 2000 }).catch(() => '')).trim());
    const btn = box.locator('.el-message-box__btns button').last();
    if (await btn.count()) await btn.click({ timeout: 3000 }).catch(() => {});
    else await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
  }
  return texts.filter(Boolean).join(' ');
}

async function startLogin() {
  const loginId = newToken();
  if (MOCK) { pending.set(loginId, { ctx: null, page: null, at: Date.now() }); return { loginId, captcha: MOCK_CAPTCHA }; }
  const ctx = await (await browser()).newContext({ locale: 'th-TH' });
  try {
    const page = await ctx.newPage();
    await page.goto(BASE + '/login.htm', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('input[name="password"]').waitFor({ timeout: 20000 });
    pending.set(loginId, { ctx, page, at: Date.now() });
    return { loginId, captcha: await captchaOf(page) };
  } catch (e) { await ctx.close().catch(() => {}); throw e; }
}

async function newCaptcha(loginId) {
  const p = pending.get(loginId);
  if (!p) throw new Error('หน้าล็อกอินหมดอายุ — กดเข้าสู่ระบบใหม่');
  if (MOCK) return MOCK_CAPTCHA;
  const prev = await p.page.locator('img.comb-code-img').getAttribute('src').catch(() => null);
  await p.page.locator('button.comb-code').click().catch(() => {});
  return captchaOf(p.page, prev);
}

async function finishLogin({ loginId, username, password, captcha, agree }) {
  const p = pending.get(loginId);
  // หน้าค้างจากก่อนเซิร์ฟเวอร์รีสตาร์ต/เกิน 5 นาที → หน้าจอเปิดหน้าล็อกอินใหม่เอง (ไม่ได้รูปรหัสกลับไป)
  if (!p) return { fail: 'หน้าล็อกอินหมดอายุ — เปิดใหม่ให้แล้ว กรอกรหัสยืนยันในรูปใหม่', captcha: null };
  if (!agree) throw new Error('ติ๊กยอมรับเงื่อนไขของ BigSeller ก่อน');
  if (MOCK) {
    if (String(captcha).toUpperCase() !== 'A7K2') return { fail: 'รหัสยืนยันกราฟิกไม่ถูก (โหมดทดลอง: A7K2)', captcha: MOCK_CAPTCHA };
    pending.delete(loginId);
    return { user: username, ctx: null };
  }
  const { page, ctx } = p;
  const failWith = async (msg, prevCaptcha) => { p.at = Date.now(); return { fail: msg, captcha: await captchaOf(page, prevCaptcha) }; };
  let prevCaptcha = null;
  try {
    await dismissDialogs(page); // กล่องแจ้งเตือนจากรอบก่อนที่ค้างอยู่
    await page.locator('input[name="account"]').fill(username, { timeout: 5000 });
    await page.locator('input[name="password"]').fill(password, { timeout: 5000 });
    const code = page.locator('input[name="picVerificationCode"]');
    if (await code.isVisible().catch(() => false)) await code.fill(String(captcha || ''), { timeout: 5000 });
    const box = page.locator('input.el-checkbox__original[type="checkbox"]').first();
    if (await box.count() && !(await box.isChecked())) await page.locator('label.el-checkbox').first().click({ timeout: 5000 });
    prevCaptcha = await page.locator('img.comb-code-img').getAttribute('src').catch(() => null);
    await page.locator('input[name="password"]').press('Enter', { timeout: 5000 });
  } catch (e) {
    console.error('login fill', e.message);
    return failWith('หน้าล็อกอิน BigSeller ไม่ตอบสนอง ลองใหม่อีกครั้ง', prevCaptcha);
  }
  // สำเร็จ = ออกจากหน้า login แล้วเรียกหลังบ้านได้จริง · ไม่ผ่าน = อ่านข้อความเตือนของหน้า แล้วส่งรูป captcha ใหม่ให้ลองต่อ
  // ข้อความเตือนของ BigSeller (el-message) ขึ้นแค่ 2–3 วิแล้วหาย → ดักอ่านทุก 0.3 วิ ระหว่างรอหน้าเปลี่ยน (สูงสุด 15 วิ)
  let msg = '';
  for (let t = 0; t < 50 && /login/i.test(page.url()); t++) {
    const seen = (await page.locator('.el-message:visible, .el-message-box:visible .el-message-box__message, .el-form-item__error:visible').allInnerTexts().catch(() => [])).join(' ').trim();
    if (seen) { msg = seen; break; }
    await page.waitForTimeout(300);
  }
  if (/login/i.test(page.url())) {
    await page.screenshot({ path: path.join(__dirname, 'debug-login-fail.png') }).catch(() => {});
    console.error('login fail:', msg || '(ไม่มีข้อความ)');
    await dismissDialogs(page);
    return failWith('ล็อกอินไม่ผ่าน' + (msg ? ': ' + msg : ' — เช็กชื่อผู้ใช้ รหัสผ่าน และรหัสยืนยัน'), prevCaptcha);
  }
  // ออกจากหน้า login แล้วแต่คุกกี้อาจยังไม่พร้อม → รอหน้าโหลดเสร็จแล้วลองเรียกหลังบ้านซ้ำ 4 ครั้ง (รวม ~8 วิ)
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  let lastErr = null;
  for (let i = 0; i < 4; i++) {
    try { await bsApi(ctx, '/api/v1/inventory/inout/list/wareHouseNameNewList.json'); lastErr = null; break; }
    catch (e) { lastErr = e; await page.waitForTimeout(2000); }
  }
  if (lastErr) {
    // เก็บหน้าที่ BigSeller พาไปหลังล็อกอินไว้ดูสาเหตุ (เช่น หน้ายืนยันอุปกรณ์ใหม่)
    const landed = page.url();
    const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 1500);
    await page.screenshot({ path: path.join(__dirname, 'debug-login-after.png') }).catch(() => {});
    try { fs.writeFileSync(path.join(__dirname, 'debug-login-after.json'), JSON.stringify({ at: new Date().toISOString(), landed, error: lastErr.message, cookies: (await ctx.cookies()).map(c => c.name + '@' + c.domain), text }, null, 1)); } catch { /* ข้าม */ }
    console.error('login: หลังล็อกอินเรียกหลังบ้านไม่ได้', landed, lastErr.message);
    pending.delete(loginId);
    await ctx.close().catch(() => {});
    return { fail: 'ล็อกอินผ่านหน้า BigSeller แล้ว แต่ BigSeller ยังไม่ให้เข้าระบบ (ไปที่ ' + landed.replace(BASE, '') + ') — บันทึกหน้าไว้ให้ตรวจแล้ว ลองอีกครั้ง', captcha: null };
  }
  pending.delete(loginId);
  await page.close().catch(() => {});
  return { user: username, ctx };
}

// ---------- ค้นหาสต็อก ----------
const MOCK_STOCK = {
  skus: [
    { sku: 'WA-242PLACL30-V1-7L', title: 'เสื้อโปโล WARRIX ไซซ์ 7L', img: '', gtins: ['8859527508948'] },
    { sku: 'WA-242PLACL30-V1-6L', title: 'เสื้อโปโล WARRIX ไซซ์ 6L', img: '', gtins: [] }
  ],
  stock: [
    { warehouse: 'ออนไลน์', sku: 'WA-242PLACL30-V1-7L', total: 31, available: 27, shelves: [{ name: 'ในบ้าน', zone: 'หยิบ', qty: 12 }, { name: 'K-11', zone: 'เก็บ K', qty: 0 }, { name: 'H-02', zone: 'เก็บ H', qty: 19 }] },
    { warehouse: 'ออนไลน์', sku: 'WA-242PLACL30-V1-6L', total: 0, available: 0, shelves: [] }
  ],
  raw: null
};

// ชื่อช่องข้อมูลของ BigSeller ยังไม่ได้ยืนยันกับบัญชีจริง → อ่านหลายชื่อที่เป็นไปได้ และส่งข้อมูลดิบไปให้ดูด้วย
const pick = (o, ...ks) => { for (const k of ks) if (o && o[k] != null && o[k] !== '') return o[k]; return null; };
const toGtins = (r) => [...new Set([].concat(r.gtinCodeList || [], String(r.gtinCode || r.gtin || '').split(/[,\s]+/)).map(String).map(s => s.trim()).filter(Boolean))];
// คลังที่ไม่ต้องแสดงในหน้าค้นสต็อก (เจ้าของสั่ง 24 ต.ค.)
const HIDE_WAREHOUSES = ['s', 'TIKTOK'];
// ชั้น "ในบ้าน" (โซนหยิบ) = ของที่เปิดขายอยู่ → ไม่แสดงเป็นแถว แต่ขึ้นป้าย "เปิดขาย" แทน (เจ้าของสั่ง 24 ต.ค.)
const SELL_SHELF = 'ในบ้าน';
// shelfVoList ของ codeWithExtraInfo: { shelfName, zoneName, available, onhand } (ยืนยันกับบัญชีจริง 24 ต.ค.) · คลัง FBS ส่งแถวว่าง (shelfName null) มา → ตัดทิ้ง
function shelvesOf(r) {
  return (r.shelfVoList || [])
    .filter(s => s && s.shelfName)
    .map(s => ({ name: s.shelfName, zone: s.zoneName || '', qty: s.available, onhand: s.onhand }));
}

async function stockSearch(ctx, q) {
  if (MOCK) {
    const up = q.toUpperCase();
    for (const st of MOCK_STOCK.stock) {
      const sell = st.shelves.find(h => h.name === SELL_SHELF);
      if (sell) { st.selling = +sell.qty || 0; st.shelves = st.shelves.filter(h => h !== sell); }
    }
    return { ...MOCK_STOCK, skus: MOCK_STOCK.skus.filter(s => s.sku.includes(up) || s.title.toUpperCase().includes(up) || s.gtins.includes(q)) };
  }
  // 1) หา SKU Merchant ที่ตรงคำค้น (ช่องค้นเดียวกับหน้า SKU Merchant ของเว็บ)
  const md = await bsApi(ctx, '/api/v1/inventory/merchant/pageList.json', {
    referer: BASE + '/web/inventory/merchant/index.htm',
    // searchType 'skuName' = ช่องค้น SKU ของหน้า SKU Merchant (ชื่อเดียวกับที่อะตอมมิคใช้) · 'sku' ไม่กรอง ได้รายการล่าสุดมาแทน (ทดสอบ 24 ต.ค.)
    form: { orderBy: 'updateTime', desc: '1', fullCid: '', isGroup: '', pageNo: '1', pageSize: '50', searchType: 'skuName',
      inquireType: '0', searchContent: q, multipleUnitsFlag: '', expiryDateFlag: '', serialNumberOpenFlag: '', openDistribution: '', queryDistribution: '1' }
  });
  const rows = ((md && (md.page || md).rows) || []);
  // กรองซ้ำเอง: เก็บเฉพาะที่ SKU / ชื่อ / บาร์โค้ด มีคำค้นอยู่จริง
  const up = q.toUpperCase();
  const all = rows.map(r => ({ sku: r.sku || '', title: r.title || r.skuName || '', img: r.imgUrl || r.image || '', gtins: toGtins(r) }));
  const skus = all.filter(s => s.sku.toUpperCase().includes(up) || s.title.toUpperCase().includes(up) || s.gtins.some(g => g.includes(q)));

  // 2) สต็อก + ตำแหน่งในแต่ละคลัง (ช่องสแกน SKU ของหน้า Stock-In ของเว็บ)
  let whs = [];
  try { whs = await bsApi(ctx, '/api/v1/inventory/inout/list/wareHouseNameNewList.json'); } catch (e) { if (e.auth) throw e; }
  const leaves = [];
  const walk = (a) => (Array.isArray(a) ? a : []).forEach(w => { if (w && Array.isArray(w.childList) && w.childList.length) walk(w.childList); else if (w) leaves.push({ id: w.id ?? w.warehouseId ?? w.value, name: w.name ?? w.warehouseName ?? String(w.id) }); });
  walk(whs);
  for (let i = leaves.length - 1; i >= 0; i--) if (HIDE_WAREHOUSES.includes(leaves[i].name)) leaves.splice(i, 1);
  const stock = [];
  let rawSample = null;
  const rawRows = [];
  for (const w of leaves) {
    let d;
    try {
      d = await bsApi(ctx, '/api/v1/inventory/scan/merchant/codeWithExtraInfo.json', {
        referer: BASE + '/web/inventory/inout/list/add/page.htm?inoutType=out',
        form: { isQueryWarehouseSku: '', scanInoutType: 'out', warehouseId: w.id, searchType: '0', searchContent: q, queryDistribution: 1, costCurrency: '' }
      });
    } catch (e) { if (e.auth) throw e; continue; }
    for (const r of (d && d.list) || []) {
      if (!rawSample) rawSample = r;
      if (rawRows.length < 12) rawRows.push({ warehouse: w.name, row: r });
      // คลังที่ไม่มีของและไม่มีชั้นวาง (เช่น FBS) ไม่ต้องแสดง
      const shelves = shelvesOf(r);
      if (!r.onhand && !r.available && !shelves.length) continue;
      stock.push({ warehouse: w.name, sku: pick(r, 'sku', 'merchantSku') || '', total: r.onhand ?? 0, available: r.available ?? 0, shelves });
    }
  }
  // 3) สต็อกแยกทุกชั้นวาง: หน้า "สต็อกตามคลัง" ของเว็บ (wms/shelfZonePageList) ค้น SKU ตรงตัว (inquireType 2)
  //    แถว: { shelfName, zoneName, warehouseName, sku, onhand, allocated, available } (ยืนยัน 24 ต.ค.)
  //    hideZeroStockSku false = เอาชั้นที่เหลือ 0 มาด้วย (หน้าจอขีดฆ่าว่าหมด ตามที่เจ้าของสั่ง)
  const shelfRaw = [];
  for (const s of skus.slice(0, 5)) {
    let d;
    try {
      d = await bsApi(ctx, '/api/v1/inventory/wms/shelfZonePageList.json', {
        referer: BASE + '/web/inventory/warehouseInventory.htm',
        form: { zoneId: '', repleteState: '', hideZeroStockSku: 'false', shelfType: '', openFlag: 'false', pageNo: 1, pageSize: 100, orderBy: '', desc: '', searchType: 'sku', inquireType: 2, searchContent: s.sku }
      });
    } catch (e) { if (e.auth) throw e; shelfRaw.push({ sku: s.sku, error: e.message }); continue; }
    const srows = ((d && d.rows) || []).filter(r => String(r.sku).toUpperCase() === s.sku.toUpperCase() && !HIDE_WAREHOUSES.includes(r.warehouseName));
    shelfRaw.push({ sku: s.sku, totalSize: d && d.totalSize, sample: srows.slice(0, 3) });
    if (!srows.length) continue;
    // แทนที่ชั้นวางจาก codeWithExtraInfo (ได้แค่ชั้นหลัก) ด้วยรายการครบทุกชั้น
    for (const st of stock.filter(x => x.sku.toUpperCase() === s.sku.toUpperCase())) st.shelves = [];
    for (const r of srows) {
      let st = stock.find(x => x.sku.toUpperCase() === s.sku.toUpperCase() && x.warehouse === r.warehouseName);
      if (!st) stock.push(st = { warehouse: r.warehouseName, sku: s.sku, total: 0, available: 0, shelves: [] });
      st.shelves.push({ name: r.shelfName, zone: r.zoneName || '', qty: r.available ?? 0, onhand: r.onhand ?? 0 });
    }
    for (const st of stock) st.shelves.sort((a, b) => (b.qty || 0) - (a.qty || 0));
  }
  for (const st of stock) {
    const sell = st.shelves.find(h => h.name === SELL_SHELF);
    st.selling = sell ? +sell.qty || 0 : 0;
    st.shelves = st.shelves.filter(h => h.name !== SELL_SHELF);
  }

  // เก็บข้อมูลดิบลงไฟล์ในเครื่อง ไว้ให้ Claude อ่านเพื่อปรับชื่อช่อง (ผู้ใช้ไม่ต้องคัดลอกเอง)
  try { fs.writeFileSync(path.join(__dirname, 'debug-stock.json'), JSON.stringify({ at: new Date().toISOString(), q, merchantSample: rows.find(r => skus.some(s => s.sku === r.sku)) || rows[0] || null, rawRows, shelfRaw, warehouses: leaves }, null, 1)); } catch { /* ข้าม */ }
  return { skus, stock, raw: { merchantReturned: rows.length, merchantMatched: skus.length, merchantSample: rows.find(r => skus.some(s => s.sku === r.sku)) || rows[0] || null, stockSample: rawSample, stockRows: stock.length, warehouses: leaves } };
}

// ---------- 1 ล็อกออเดอร์ (ย้ายมาจากอะตอมมิค bsqc.js + jojo.js) ----------
// สแกนเลขพัสดุ → ออเดอร์จากหน้า "สแกนและตรวจสอบ" ของ BigSeller → ยิงสินค้าครบ → ยืนยัน = "ตรวจสอบแล้ว" ใน BigSeller
// การยืนยันเขียนลง BigSeller จริง → ปิดไว้จนกว่าจะตั้ง JOJO_WRITE=1 (เจ้าของสั่งเปิดเอง)
const WRITE = process.env.JOJO_WRITE === '1';
const MOCK_ORDER = {
  trackingNo: 'TEST001', orderId: '0', packageNo: '', shippingMethod: 'ทดสอบ', packages: [], note: '',
  items: [
    { merchantSku: 'WA-242PLACL30-V1-7L', productCode: '', gtins: ['8859527508948'], name: 'WARRIX', image: '', qty: 1 },
    { merchantSku: '010245-ดำแดง-L', productCode: '', gtins: ['0102451030003'], name: 'GRAND SPORT', image: '', qty: 2 }
  ]
};

// หน้า "สแกนและตรวจสอบ" (ทั้งเมนูคำสั่งซื้อและ WMS Wave) · คำตอบห่อ 2 ชั้น: j.data = ผลสแกน (code/msg ของตัวเอง), j.data.data = ออเดอร์
async function scanOrder(ctx, trackingNo) {
  const r = await ctx.request.get(BASE + '/api/v1/order/v2/scanTrackingNo.json?' + new URLSearchParams({ trackingNo, providerGrepId: '' }), {
    headers: { Accept: 'application/json, text/plain, */*', clientType: '1', Referer: BASE + '/web/order/scanToInspection.htm' }
  });
  let j;
  try { j = await r.json(); } catch { throw Object.assign(new Error(NOT_LOGGED_IN), { auth: true }); }
  if (j.code === 2001) throw Object.assign(new Error(NOT_LOGGED_IN), { auth: true });
  if (j.code !== 0) throw new Error(j.msg || 'ผิดพลาด (code ' + j.code + ')');
  const res = j.data || {};
  if (res.code && res.code !== 0) throw new Error(res.msg || res.defaultMsg || res.platformMsg || 'ผิดพลาด (code ' + res.code + ')');
  const d = res.data || {};
  const items = (d.skuVos || []).concat(d.groupSkuVos || []).map(v => ({
    merchantSku: v.merchantSku || '', productCode: v.productCode || '', gtins: (v.gtinCodeList || []).map(String).filter(Boolean),
    name: v.skuName || v.title || v.productName || '', image: v.image || '',
    qty: +v.quantity || 0 // 0 = BigSeller ยังจัดสรรสต็อกไม่เสร็จ (หน้า BigSeller ก็ไม่ให้ยิง)
  }));
  if (!items.length) try { fs.writeFileSync(path.join(__dirname, 'debug-lock.json'), JSON.stringify({ at: new Date().toISOString(), trackingNo, response: j }, null, 1)); } catch { /* ข้าม */ }
  return { trackingNo: d.trackingNo || trackingNo, orderId: d.orderId || '', packageNo: d.packageNo || '', shippingMethod: d.shippingMethod || '', note: res.msg || '', items };
}

// GTIN ของแต่ละ SKU จาก SKU Merchant (ออเดอร์มักไม่มี GTIN มาด้วย)
async function gtinsOfSku(ctx, sku) {
  const md = await bsApi(ctx, '/api/v1/inventory/merchant/pageList.json', {
    referer: BASE + '/web/inventory/merchant/index.htm',
    form: { orderBy: 'updateTime', desc: '1', fullCid: '', isGroup: '', pageNo: '1', pageSize: '20', searchType: 'skuName', inquireType: '0', searchContent: sku, multipleUnitsFlag: '', expiryDateFlag: '', serialNumberOpenFlag: '', openDistribution: '', queryDistribution: '1' }
  });
  const row = ((md && (md.page || md).rows) || []).find(r => String(r.sku).toUpperCase() === String(sku).toUpperCase());
  return row ? toGtins(row) : [];
}

// สินค้าทดแทน: บรรทัดใต้ "RRQC" ใน "หมายเหตุสำหรับการบริการลูกค้า" (รูปแบบเจ้าของกำหนด — ห้ามเปลี่ยนชื่อ RRQC)
//   CDL17-BK-L,3 >CDL17-YL-L,1 CDL17-YL-XL,1 ≠ CDL17-BK-L,1   = เปลี่ยนเป็น YL-L 1 + YL-XL 1 และตัดออก 1
const PAIR = '([^\\s,>≠]+),(\\d+)';
const SUB_LINE_RE = new RegExp('^\\s*(?:' + PAIR + '\\s*>\\s*((?:[^\\s,>≠]+,\\d+\\s*)+))?(?:≠\\s*' + PAIR + ')?\\s*$');
function parseSubs(text) {
  const lines = String(text || '').split(/\r?\n/), out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toUpperCase() !== 'RRQC') continue;
    for (let j = i + 1; j < lines.length; j++) {
      const x = SUB_LINE_RE.exec(lines[j]);
      if (!x || !(x[1] || x[4])) break;
      if (x[1]) for (const p of x[3].trim().split(/\s+/)) { const [sku, q] = p.split(','); out.push({ type: 'replace', oldSku: x[1], qty: +q, newSku: sku }); }
      if (x[4]) out.push({ type: 'cut', oldSku: x[4], qty: +x[5], newSku: '' });
    }
  }
  return out;
}
async function remarkSubs(ctx, orderId) {
  const d = await bsApi(ctx, '/api/v1/order/detail.json?' + new URLSearchParams({ id: String(orderId), viewBuyerMessage: 'false' }), { referer: BASE + '/web/order/index.htm' });
  const o = (d && (d.orderDetail || d)) || {};
  const remarks = o.orderRemarksList || [];
  const cs = (remarks.find(x => x && +x.remaType === 1) || {}).content || '';
  return { subs: parseSubs(cs), remarks };
}
const normCode = (s) => String(s || '').toUpperCase().replace(/[\s\-_.]/g, '');
function applySubs(subs, items) {
  let n = 0;
  items = items.map(i => ({ ...i }));
  for (const s of subs) {
    const k = normCode(s.oldSku);
    const it = items.find(i => !i.subFrom && i.qty > 0 && (normCode(i.merchantSku) === k || normCode(i.productCode) === k));
    if (!it) continue;
    const q = Math.min(+s.qty || it.qty, it.qty);
    it.qty -= q; n++;
    if (s.type !== 'replace') continue;
    const code = String(s.newSku || '').trim().toUpperCase();
    items.push({ merchantSku: code, productCode: '', gtins: /^\d{8,14}$/.test(code) ? [code] : [], name: it.name || '', image: '', qty: q, subFrom: it.merchantSku || it.productCode, needGtin: true });
  }
  return { items: items.filter(i => i.qty > 0), n };
}

async function lockScan(ctx, trackingNo) {
  if (MOCK) return { ...MOCK_ORDER, trackingNo, subN: 0, subWarn: '', canWrite: true };
  const o = await scanOrder(ctx, trackingNo);
  let items = o.items, subN = 0, subWarn = '';
  if (o.orderId) {
    try { const sb = applySubs((await remarkSubs(ctx, o.orderId)).subs, items); items = sb.items; subN = sb.n; }
    catch (e) { if (e.auth) throw e; subWarn = 'อ่านหมายเหตุสินค้าทดแทนไม่ได้ — ตรวจตามออเดอร์เดิม'; }
  }
  // เติม GTIN จาก SKU Merchant ทีละ SKU (ไม่เกิน 15 ตัว)
  for (const it of items.slice(0, 15)) {
    const sku = it.merchantSku || it.productCode;
    if (!sku) continue;
    try { it.gtins = [...new Set([...(it.gtins || []), ...(await gtinsOfSku(ctx, sku))])]; } catch (e) { if (e.auth) throw e; }
    delete it.needGtin;
  }
  return { ...o, items, subN, subWarn, canWrite: WRITE };
}

// ยิงครบ → "ตรวจสอบแล้ว" ใน BigSeller (source 3 = หน้า WMS) — เขียนจริง
async function lockConfirm(ctx, user, b) {
  if (!WRITE && !MOCK) return { ok: false, msg: 'ยังปิดการบันทึกลง BigSeller จริงอยู่ (ตัวทดลอง) — ตั้ง JOJO_WRITE=1 เมื่อพร้อมใช้จริง' };
  let ok = true, msg = '';
  if (!MOCK) {
    try {
      const d = await bsApi(ctx, '/api/v1/order/v2/scanVerifySuccess.json', { json: { orderId: b.orderId, source: 3 }, referer: BASE + '/web/order/scanToInspection.htm' });
      ok = +(d && d.successNum) > 0;
      msg = ok ? '' : (d && (d.msg || d.defaultMsg || d.platformMsg || (d.errors || []).map(x => (x && (x.msg || x.errorMsg)) || x).filter(Boolean).join(', '))) || 'BigSeller ไม่รับผลตรวจ';
    } catch (e) { if (e.auth) throw e; ok = false; msg = e.message.replace(/^BigSeller: /, ''); }
  }
  // บันทึกในเครื่อง (ใคร ล็อกอะไร เมื่อไหร่) — แทน qc-bigseller.json ของอะตอมมิค
  const rec = { at: new Date().toISOString(), by: user, trackingNo: b.trackingNo, orderId: String(b.orderId), shippingMethod: b.shippingMethod || '', ok, msg,
    items: (Array.isArray(b.items) ? b.items : []).slice(0, 200).map(i => ({ sku: String(i.sku || '').slice(0, 80), qty: +i.qty || 0 })) };
  try { fs.appendFileSync(path.join(__dirname, 'lock-log.jsonl'), JSON.stringify(rec) + '\n'); } catch { /* ข้าม */ }
  return { ok, msg };
}

// ---------- 2 ของค้าง: ออเดอร์ที่มีหมายเหตุ C/P (ยังไม่ออก = กำลังจัดส่ง · ออกแล้ว = จัดส่งแล้ว) ----------
// วันที่ในหมายเหตุ (เช่น Nut.24.10) = วันสั่งของ → ของมาวันถัดไป (เจ้าของกำหนด 24 ต.ค.)
// remaType: 1 = หมายเหตุสำหรับการบริการลูกค้า (C) ยืนยันแล้ว · ตัวอื่นยังเดา → เก็บดิบไว้ใน debug-backorders.json
const REMARK_LETTER = { 0: 'S', 1: 'C', 2: 'P', 3: 'L', 4: 'P' };
function remarkDate(text) {
  const m = /(\d{1,2})[./-](\d{1,2})(?![\d])/.exec(String(text || ''));
  if (!m) return null;
  const now = new Date(), d = new Date(now.getFullYear(), +m[2] - 1, +m[1]);
  if (d - now > 60 * 864e5) d.setFullYear(d.getFullYear() - 1); // ข้ามปี
  d.setDate(d.getDate() + 1); // ของมาวันถัดไป
  return d.getTime();
}
const MOCK_BACKORDERS = () => {
  const day = 864e5, t = new Date(); t.setHours(0, 0, 0, 0);
  const fmt = (ms) => { const d = new Date(ms); return d.getDate() + '.' + (d.getMonth() + 1); };
  return [
    { id: 1, orderNo: 'SPX2510220031', trackingNo: 'TH0000000031', shipping: 'Flash', remarks: [{ k: 'C', text: 'Nut.' + fmt(+t - 2 * day) + ' No.AB,XL' }, { k: 'P', text: 'no AB-XL' }] },
    { id: 2, orderNo: 'SPX2510240042', trackingNo: 'TH0000000042', shipping: 'J&T', remarks: [{ k: 'C', text: 'Nut.' + fmt(+t) + ' No.AA,L' }, { k: 'P', text: 'no AA-L' }] }
  ];
};
async function backorders(ctx, tab) {
  let list;
  if (MOCK) list = tab === 'shipped' ? [] : MOCK_BACKORDERS();
  else {
    const d = await bsApi(ctx, '/api/v1/order/new/pageList.json', {
      referer: BASE + '/web/order/index.htm?status=' + (tab === 'shipped' ? 'shipped' : 'processing'),
      json: { pageNo: 1, pageSize: 100, status: tab === 'shipped' ? 'shipped' : 'processing', historyOrder: 0, days: '', inquireType: 0, searchType: '', searchContent: '', isFilterEvalationOrder: true, pageView: 1, nonHomePage: 1 }
    });
    const rows = ((d && (d.page || (d.data && d.data.page))) || {}).rows || [];
    try { fs.writeFileSync(path.join(__dirname, 'debug-backorders.json'), JSON.stringify({ at: new Date().toISOString(), tab, n: rows.length, keys: Object.keys(rows[0] || {}), sample: rows.slice(0, 2) }, null, 1)); } catch { /* ข้าม */ }
    list = [];
    for (const r of rows) {
      let rem = r.orderRemarksList || r.remarkList || null;
      if (!rem && list.length < 40) { // รายการไม่มีหมายเหตุมาด้วย → อ่านจากรายละเอียดออเดอร์ (ไม่เกิน 40 ออเดอร์)
        try { const o = await bsApi(ctx, '/api/v1/order/detail.json?' + new URLSearchParams({ id: String(r.id), viewBuyerMessage: 'false' }), { referer: BASE + '/web/order/index.htm' }); rem = ((o && (o.orderDetail || o)) || {}).orderRemarksList || []; }
        catch (e) { if (e.auth) throw e; rem = []; }
      }
      const remarks = (rem || []).filter(x => x && x.content).map(x => ({ k: REMARK_LETTER[+x.remaType] || String(x.remaType), text: String(x.content) }));
      if (!remarks.some(x => x.k === 'C' || x.k === 'P')) continue;
      list.push({ id: r.id, orderNo: r.platformOrderId || r.orderNo || '', trackingNo: r.trackingNo || '', shipping: r.shippingMethod || r.logisticsName || '', remarks });
    }
  }
  const now = Date.now();
  return list.map(o => {
    const eta = remarkDate((o.remarks.find(x => x.k === 'C') || o.remarks[0] || {}).text);
    return { ...o, eta, overdue: tab !== 'shipped' && eta && eta < now - 864e5 };
  }).sort((a, b) => (a.eta || 9e15) - (b.eta || 9e15));
}

// ---------- 3 เพิ่ม GTIN ----------
// ใครใช้บาร์โค้ดนี้อยู่: ช่อง "สแกน/ป้อน SKU Merchant/GTIN" ของหน้า Stock-In (ค้นได้ทั้ง SKU และ GTIN)
async function gtinOwner(ctx, code) {
  if (MOCK) return code === '8859527508948' ? [] : [];
  const d = await bsApi(ctx, '/api/v1/inventory/scan/merchant/codeWithExtraInfo.json', {
    referer: BASE + '/web/inventory/inout/list/add/page.htm?inoutType=out',
    form: { isQueryWarehouseSku: '', scanInoutType: 'out', warehouseId: 48660, searchType: '0', searchContent: code, queryDistribution: 1, costCurrency: '' }
  });
  return ((d && d.list) || []).filter(r => toGtins(r).includes(code)).map(r => ({ id: r.skuId, sku: r.sku, title: r.title || '', gtins: toGtins(r) }));
}
async function skuSearch(ctx, q) {
  if (MOCK) return MOCK_STOCK.skus.filter(s => s.sku.includes(q.toUpperCase())).map((s, i) => ({ id: i + 1, isGroup: 0, ...s }));
  const md = await bsApi(ctx, '/api/v1/inventory/merchant/pageList.json', {
    referer: BASE + '/web/inventory/merchant/index.htm',
    form: { orderBy: 'updateTime', desc: '1', fullCid: '', isGroup: '', pageNo: '1', pageSize: '50', searchType: 'skuName', inquireType: '0', searchContent: q, multipleUnitsFlag: '', expiryDateFlag: '', serialNumberOpenFlag: '', openDistribution: '', queryDistribution: '1' }
  });
  const up = q.toUpperCase();
  return (((md && (md.page || md).rows) || [])).filter(r => String(r.sku).toUpperCase().includes(up))
    .map(r => ({ id: r.id, isGroup: +r.isGroup || 0, sku: r.sku, title: r.title || '', img: r.imgUrl || '', brand: (r.brandNames || [])[0] || '', gtins: toGtins(r) }));
}
// ผูก GTIN: เปิดหน้าแก้ SKU ของ BigSeller แบบซ่อน แล้วให้หน้าบันทึกเอง (วิธีเดียวกับอะตอมมิค bsqc.addGtin — ห้ามประกอบข้อมูล SKU ส่งเอง)
async function gtinAdd(ctx, { skuId, sku, isGroup, gtin }) {
  gtin = String(gtin || '').trim();
  if (!/^[A-Za-z0-9-]{4,40}$/.test(gtin)) throw new Error('บาร์โค้ดใช้เป็น GTIN ไม่ได้: ' + gtin);
  if (!WRITE && !MOCK) return { ok: false, msg: 'ยังปิดการบันทึกลง BigSeller จริงอยู่ (ตัวทดลอง) — ตั้ง JOJO_WRITE=1 เมื่อพร้อมใช้จริง' };
  if (MOCK) return { ok: true, sku, gtins: [gtin] };
  const own = await gtinOwner(ctx, gtin);
  if (own.length && !own.some(o => String(o.id) === String(skuId))) return { ok: false, msg: 'บาร์โค้ดนี้ผูกกับ ' + own[0].sku + ' อยู่แล้ว' };
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE}/web/inventory/merchant/editPage.htm?skuId=${encodeURIComponent(skuId)}&isGroup=${isGroup ? 1 : 0}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    let r = null;
    for (let i = 0; i < 60 && !r; i++) {
      await page.waitForTimeout(500);
      r = await page.evaluate(async ({ sku, gtin }) => {
        let vm = null;
        for (const el of document.querySelectorAll('*')) { const v = el.__vue__; if (v && typeof v.getSaveData === 'function' && v.filter && v.filter.sku) { vm = v; break; } }
        if (!vm) return null;
        if (vm.pageType !== 'edit' || String(vm.filter.sku) !== sku) return { err: 'หน้าแก้ SKU ไม่ตรงกับ ' + sku };
        const cur = String(vm.filter.gtinCode || '').split(',').map(s => s.trim()).filter(Boolean);
        if (!cur.includes(gtin)) cur.push(gtin);
        vm.filter.gtinCode = cur.join(',');
        const body = vm.getSaveData();
        try {
          const res = await vm.$http.inventory.inventoryMerchantEdit(body);
          if (res && res.code === 3) return { err: res.msg || 'BigSeller ไม่รับ' };
          return { ok: true, gtins: body.gtinCodeList };
        } catch (e) { return { err: String((e && (e.msg || e.message)) || e) }; }
      }, { sku: String(sku), gtin }).catch(e => ({ err: String(e.message || e) }));
    }
    if (!r) return { ok: false, msg: 'เปิดหน้าแก้ SKU ของ BigSeller ไม่สำเร็จ' };
    if (r.err) return { ok: false, msg: r.err };
    return { ok: true, sku, gtins: r.gtins };
  } finally { await page.close().catch(() => {}); }
}

// ---------- 6 งานมอบหมาย = แผนย้ายสินค้าของ BigSeller (อ่านอย่างเดียว) ----------
async function movingPlans(ctx, state) {
  if (MOCK) return { rows: [], keys: [] };
  const d = await bsApi(ctx, '/api/v1/inventory/movingPlan/pageList.json', {
    referer: BASE + '/web/inventory/movingGoods/index.htm',
    form: { pageNo: 1, pageSize: 50, warehouseId: 48660, beginDate: '', endDate: '', days: '', searchType: 'sku', inquireType: 2, searchContent: '', orderBy: 'createTime', desc: 1, state: state || 0 }
  });
  const rows = (d && d.rows) || [];
  if (rows.length) try { fs.writeFileSync(path.join(__dirname, 'debug-movingplan.json'), JSON.stringify({ at: new Date().toISOString(), sample: rows.slice(0, 2) }, null, 1)); } catch { /* ข้าม */ }
  return { rows, keys: Object.keys(rows[0] || {}) };
}

// ---------- ชั้นวาง (กล่อง): ของในกล่อง + แบรนด์ ----------
const brandOf = (sku, brands) => (brands && brands[0]) || (/^WA-/i.test(sku) ? 'WARRIX' : /^\d{5,6}-/.test(sku) ? 'GRAND SPORT' : /^TT/i.test(sku) ? 'EGO' : '?');
// รุ่น: WA-242PLACL30-V1-7L → WA-242PLACL30 (ตัดสี-ไซซ์) · 010245-ดำแดง-L → 010245
const modelOf = (sku) => { const p = String(sku).split('-'); return /^\d{5,6}$/.test(p[0]) ? p[0] : p.slice(0, Math.max(1, p.length - 2)).join('-'); };
const MOCK_SHELVES = {
  'H-01-05-05 PP': [{ sku: 'WA-242PLACL30-V1-7L', qty: 3 }, { sku: 'WA-242PLACL30-AE-7L', qty: 10 }],
  'H-02-04-13 PP': [{ sku: 'WA-242PLACL30-YW-7L', qty: 4 }, { sku: 'WA-203PLACL01-O3-3L', qty: 2 }],
  'C-12-01': [{ sku: '010245-ดำแดง-L', qty: 6 }],
  'ในบ้าน': [{ sku: 'WA-242PLACL30-V1-7L', qty: 0 }]
};
async function shelfContents(ctx, name) {
  if (MOCK) {
    const items = MOCK_SHELVES[name];
    if (!items) throw new Error('ไม่พบชั้นวาง ' + name);
    return { name, zone: /^ในบ้าน/.test(name) ? 'หยิบ' : 'เก็บ', items: items.map(i => ({ ...i, brand: brandOf(i.sku) })) };
  }
  const d = await bsApi(ctx, '/api/v1/inventory/shelf/pageList.json', {
    referer: BASE + '/web/inventory/shelf/index.htm',
    form: { pageNo: 1, pageSize: 20, warehouseId: 48660, searchType: 'shelf', searchContent: name, status: '', zoneType: '', zoneId: '' }
  });
  const row = ((d && d.rows) || []).find(r => String(r.name).toUpperCase() === name.toUpperCase());
  if (!row) throw new Error('ไม่พบชั้นวาง ' + name + ' ในคลังออนไลน์');
  return { name: row.name, zone: row.zoneName || '', state: row.state, items: (row.shelfSkuVoList || []).filter(x => x && x.skuName).map(x => ({ sku: x.skuName, qty: x.skuOnHand ?? 0, brand: brandOf(x.skuName) })) };
}
// ทุกชั้นวางที่มี SKU นี้ (ข้อมูลเดียวกับหน้าค้นสต็อก)
async function shelvesOfSku(ctx, sku) {
  if (MOCK) return Object.entries(MOCK_SHELVES).flatMap(([n, items]) => items.filter(i => i.sku === sku).map(i => ({ name: n, zone: /^ในบ้าน/.test(n) ? 'หยิบ' : 'เก็บ', available: i.qty, brand: brandOf(sku) })));
  const d = await bsApi(ctx, '/api/v1/inventory/wms/shelfZonePageList.json', {
    referer: BASE + '/web/inventory/warehouseInventory.htm',
    form: { zoneId: '', repleteState: '', hideZeroStockSku: 'true', shelfType: '', openFlag: 'false', pageNo: 1, pageSize: 100, orderBy: '', desc: '', searchType: 'sku', inquireType: 2, searchContent: sku }
  });
  return ((d && d.rows) || []).filter(r => String(r.sku).toUpperCase() === String(sku).toUpperCase() && !HIDE_WAREHOUSES.includes(r.warehouseName))
    .map(r => ({ name: r.shelfName, zone: r.zoneName || '', available: r.available ?? 0, brand: brandOf(sku, r.brandNames) }));
}

// 7 ยุบกล่อง: ตรวจ 2 กล่อง (แบรนด์เดียวกัน = ยุบได้) + ไกด์แนะนำ (รุ่นเดียวกันก่อน) — การย้ายจริงยังไม่มีคำสั่ง BigSeller
async function mergeCheck(ctx, a, b) {
  const [A, B] = await Promise.all([shelfContents(ctx, a), shelfContents(ctx, b)]);
  const brands = new Set([...A.items, ...B.items].filter(i => i.qty > 0).map(i => i.brand));
  const models = (s) => new Set(s.items.map(i => modelOf(i.sku)));
  const sameModel = [...models(A)].some(m => models(B).has(m));
  return { a: A, b: B, sameBrand: brands.size <= 1, brands: [...brands], sameModel };
}

// 8+9 เช็กโซนหยิบ → หาของมาเติม: C- ก่อน → K- → H- (H- ยกทั้งกล่อง) · ไม่มีเลย → รอสั่ง (เจ้าของกำหนด 24 ต.ค.)
const REORDER = path.join(__dirname, MOCK ? 'reorder-mock.json' : 'reorder.json');
const readReorder = () => { try { return JSON.parse(fs.readFileSync(REORDER, 'utf8')); } catch { return []; } };
async function refillPlan(ctx, shelfName, user) {
  const box = await shelfContents(ctx, shelfName);
  const plans = [];
  for (const it of box.items.slice(0, 8)) {
    const where = (await shelvesOfSku(ctx, it.sku)).filter(s => s.name !== box.name && s.available > 0);
    let src = null;
    for (const p of ['C-', 'K-', 'H-']) { src = where.filter(s => s.name.toUpperCase().startsWith(p)).sort((x, y) => y.available - x.available)[0]; if (src) break; }
    let whole = null;
    if (src && src.name.toUpperCase().startsWith('H-')) { try { whole = (await shelfContents(ctx, src.name)).items; } catch (e) { if (e.auth) throw e; } }
    plans.push({ sku: it.sku, brand: it.brand, from: src ? src.name : null, available: src ? src.available : 0, wholeBox: whole });
  }
  // ไม่มีที่ไหนเลย → รายการรอสั่ง (ข้อ 10) เก็บในไฟล์ของเซิร์ฟเวอร์
  const missing = plans.filter(p => !p.from);
  if (missing.length) {
    const list = readReorder();
    for (const m of missing) if (!list.some(x => x.sku === m.sku && !x.orderedAt)) list.unshift({ sku: m.sku, brand: m.brand, box: box.name, by: user, at: Date.now(), orderedAt: null });
    fs.writeFileSync(REORDER, JSON.stringify(list.slice(0, 300), null, 1));
  }
  return { box, plans };
}

// ---------- สำรวจหน้าชั้นวาง/สต็อกของ BigSeller (อ่านอย่างเดียว ครั้งแรกหลังล็อกอิน) ----------
// ยังไม่รู้ endpoint ของรายการชั้นวาง/สต็อกตามชั้นวาง/สร้างชั้นวาง → เปิดหน้าเว็บเหล่านั้นด้วยล็อกอินของผู้ใช้
// แล้วจดคำขอ /api/ ที่หน้าเรียก (เปิดดูอย่างเดียว ไม่กดปุ่มใด ๆ) ลง debug-discovery.json ให้ Claude อ่าน
async function discover(ctx) {
  const out = { at: new Date().toISOString(), links: [], pages: [] };
  const page = await ctx.newPage();
  const calls = [];
  page.on('response', async (r) => {
    const req = r.request();
    if (!/\/api\//.test(r.url()) || !['xhr', 'fetch'].includes(req.resourceType())) return;
    let body = '';
    try { body = (await r.text()).slice(0, 2500); } catch { /* ข้าม */ }
    calls.push({ url: r.url().replace(BASE, ''), method: req.method(), post: (req.postData() || '').slice(0, 600), body });
  });
  try {
    await page.goto(BASE + '/web/index.htm', { waitUntil: 'networkidle', timeout: 40000 }).catch(() => {});
    // ลิงก์เมนูของหน้าแรก (รอบแรกหาจากข้อความ HTML ไม่เจอ → อ่านจาก href ของทุกลิงก์ที่เรนเดอร์แล้ว) + หน้าที่น่าจะเป็นชั้นวาง/สต็อก
    await page.waitForTimeout(3000);
    const hrefs = await page.$$eval('a[href]', as => as.map(a => a.getAttribute('href'))).catch(() => []);
    const html = await page.content();
    out.links = [...new Set([...hrefs, ...(html.match(/\/web\/[A-Za-z0-9_\/.-]+/g) || [])])]
      .filter(u => u && /shelf|warehouse|inventory|stock|zone/i.test(u)).map(u => u.replace(BASE, '')).sort();
    const guesses = ['/web/warehouse/shelf/index.htm', '/web/warehouse/index.htm', '/web/inventory/index.htm', '/web/inventory/list/index.htm', '/web/warehouse/zone/index.htm'];
    // รอบ 2: รู้แล้วว่าหน้าชั้นวางคือ /web/inventory/shelf/index.htm → ดูหน้านี้ + หน้าย้ายสินค้า + หน้าสต็อกตามคลัง
    const visit = ['/web/inventory/shelf/index.htm', '/web/inventory/movingGoods/index.htm', '/web/inventory/warehouseInventory.htm', '/web/warehouse/warehouseArea/index.htm'];
    void guesses;
    for (const u of visit) {
      calls.length = 0;
      await page.goto(BASE + u, { waitUntil: 'networkidle', timeout: 40000 }).catch(() => {});
      await page.waitForTimeout(1500);
      out.pages.push({ page: u, landed: page.url().replace(BASE, ''), title: await page.title().catch(() => ''), calls: calls.slice(0, 25) });
      // หน้าชั้นวาง: อ่านไฟล์โค้ด (JS) ของหน้าเพื่อหาคำสั่งที่ปุ่มต่าง ๆ ใช้ เช่น เพิ่มชั้นวาง (อ่านไฟล์อย่างเดียว ไม่กดปุ่ม)
      if (/inventory\/shelf\/index/.test(u)) {
        const srcs = await page.$$eval('script[src]', s => s.map(x => x.src)).catch(() => []);
        const found = new Set();
        for (const src of srcs) {
          try {
            const txt = await (await ctx.request.get(src)).text();
            for (const m of txt.match(/["'`]\/api\/v\d\/[A-Za-z0-9_\/]*(?:shelf|Shelf|zone|Zone)[A-Za-z0-9_\/]*\.json/g) || []) found.add(m.slice(1));
          } catch { /* ข้าม */ }
        }
        out.shelfApis = [...found].sort();
      }
    }
  } finally {
    await page.close().catch(() => {});
    fs.writeFileSync(path.join(__dirname, 'debug-discovery.json'), JSON.stringify(out, null, 1));
  }
}

// ---------- เว็บ ----------
const send = (res, code, body, headers = {}) => { res.writeHead(code, { 'Cache-Control': 'no-store', ...headers }); res.end(body); };
const json = (res, code, obj, headers) => send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
const readBody = (req) => new Promise((ok, bad) => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { bad(e); } }); });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg' };

async function onRequest(req, res) {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/login/start' && req.method === 'POST') return json(res, 200, await startLogin());
    if (url.pathname === '/api/login/captcha' && req.method === 'POST') return json(res, 200, { captcha: await newCaptcha((await readBody(req)).loginId) });
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.username || !b.password) return json(res, 400, { error: 'กรอกชื่อผู้ใช้และรหัสผ่าน BigSeller' });
      const s = await finishLogin({ ...b, username: String(b.username).trim(), password: String(b.password) });
      if (s.fail) return json(res, 400, { error: s.fail, captcha: s.captcha });
      const token = newToken();
      sessions.set(token, { ...s, at: Date.now() });
      if (s.ctx && !fs.existsSync(path.join(__dirname, 'debug-discovery.json'))) discover(s.ctx).catch(e => console.error('discover', e.message));
      return json(res, 200, { user: s.user }, { 'Set-Cookie': `jj=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}` });
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      const s = sessionOf(req);
      if (s) endSession(s.token);
      return json(res, 200, { ok: true }, { 'Set-Cookie': 'jj=; Path=/; Max-Age=0' });
    }
    if (url.pathname.startsWith('/api/')) {
      const s = sessionOf(req);
      if (!s) return json(res, 401, { error: 'ยังไม่ได้ล็อกอิน' });
      if (url.pathname === '/api/me') return json(res, 200, { user: s.user, mock: MOCK, canWrite: WRITE || MOCK });
      if (url.pathname === '/api/lock/scan' && req.method === 'POST') {
        const t = String((await readBody(req)).trackingNo || '').trim().toUpperCase();
        if (!t) return json(res, 400, { error: 'ไม่มีเลขพัสดุ' });
        try { return json(res, 200, await lockScan(s.ctx, t)); }
        catch (e) { if (e.auth) { endSession(s.token); return json(res, 401, { error: e.message }); } return json(res, 400, { error: String(e.message).replace(/^BigSeller: /, '') }); }
      }
      // หน้าอื่น ๆ (2,3,6,7,8,9,10) — ข้อผิดพลาด BigSeller ส่งเป็น 400 ข้อความสั้น · ล็อกอินหมด = 401
      const route = async (fn) => {
        try { return json(res, 200, await fn()); }
        catch (e) { if (e.auth) { endSession(s.token); return json(res, 401, { error: e.message }); } return json(res, 400, { error: String(e.message).replace(/^BigSeller: /, '').split('\n')[0].slice(0, 200) }); }
      };
      const qp = (k) => (url.searchParams.get(k) || '').trim();
      if (url.pathname === '/api/backorders') return route(() => backorders(s.ctx, qp('tab')));
      if (url.pathname === '/api/gtin/owner') return route(() => gtinOwner(s.ctx, qp('code')));
      if (url.pathname === '/api/sku/search') return route(() => skuSearch(s.ctx, qp('q')));
      if (url.pathname === '/api/gtin/add' && req.method === 'POST') { const b = await readBody(req); return route(() => gtinAdd(s.ctx, b)); }
      if (url.pathname === '/api/tasks') return route(() => movingPlans(s.ctx, qp('state')));
      if (url.pathname === '/api/shelf') return route(() => shelfContents(s.ctx, qp('name')));
      if (url.pathname === '/api/merge/check') return route(() => mergeCheck(s.ctx, qp('a'), qp('b')));
      if (url.pathname === '/api/refill') return route(() => refillPlan(s.ctx, qp('shelf'), s.user));
      if (url.pathname === '/api/reorder') return route(async () => readReorder());
      if (url.pathname === '/api/reorder/done' && req.method === 'POST') {
        const b = await readBody(req);
        return route(async () => { const l = readReorder(); for (const x of l) if (x.sku === b.sku && !x.orderedAt) { x.orderedAt = Date.now(); x.orderedBy = s.user; } fs.writeFileSync(REORDER, JSON.stringify(l, null, 1)); return l; });
      }
      if (url.pathname === '/api/lock/confirm' && req.method === 'POST') {
        const b = await readBody(req);
        if (!b.trackingNo || !b.orderId) return json(res, 400, { error: 'ข้อมูลออเดอร์ไม่ครบ' });
        try { return json(res, 200, await lockConfirm(s.ctx, s.user, b)); }
        catch (e) { if (e.auth) { endSession(s.token); return json(res, 401, { error: e.message }); } throw e; }
      }
      if (url.pathname === '/api/stock') {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) return json(res, 400, { error: 'พิมพ์ SKU / บาร์โค้ด / ชื่อสินค้า' });
        try { return json(res, 200, await stockSearch(s.ctx, q)); }
        catch (e) { if (e.auth) { endSession(s.token); return json(res, 401, { error: e.message }); } throw e; }
      }
      return json(res, 404, { error: 'ไม่พบ' });
    }
    // ไฟล์หน้าเว็บใน public/
    const file = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^([\\/]\.\.)+/, ''));
    if (!file.startsWith(path.join(__dirname, 'public'))) return send(res, 403, '');
    fs.readFile(file, (err, buf) => err ? send(res, 404, 'ไม่พบ') : send(res, 200, buf, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }));
  } catch (e) {
    // ข้อความจาก Playwright ยาวและอ่านไม่รู้เรื่อง → ส่งแค่บรรทัดแรกให้หน้าจอ ตัวเต็มดูใน log ของเซิร์ฟเวอร์
    console.error(url.pathname, e.message);
    const first = String(e.message || e).split('\n')[0].replace(/\u001b\[[0-9;]*m/g, '').slice(0, 160);
    json(res, 500, { error: /Timeout|locator\./.test(first) ? 'BigSeller ตอบช้าหรือหน้าเว็บเปลี่ยน ลองใหม่อีกครั้ง' : first });
  }
}
http.createServer(onRequest).listen(PORT, HOST, () => console.log(`jojo server ${MOCK ? '(MOCK) ' : ''}http://${HOST}:${PORT}`));

// ---------- https ให้มือถือในวง Wi-Fi (JOJO_LAN=1) ----------
// มือถือเปิดกล้องได้เฉพาะหน้า https และรหัสผ่านไม่ควรวิ่งผ่าน Wi-Fi แบบไม่เข้ารหัส
// ใบรับรอง self-signed อายุ 10 ปี สร้างครั้งเดียวด้วย PowerShell (แบบเดียวกับอะตอมมิค) — ครั้งแรกมือถือเตือน ให้กด ขั้นสูง → ไปต่อ
const CERT = path.join(__dirname, 'cert.pfx'), CERT_PW = path.join(__dirname, 'cert-pw.txt');
function ensureCert() {
  if (fs.existsSync(CERT) && fs.existsSync(CERT_PW)) return Promise.resolve();
  const pw = crypto.randomBytes(16).toString('hex');
  const ps = "$c=New-SelfSignedCertificate -Subject 'CN=jojo' -DnsName 'jojo','localhost' -CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddYears(10) -KeyAlgorithm RSA -KeyLength 2048 -KeyExportPolicy Exportable;" +
    "Export-PfxCertificate -Cert $c -FilePath $env:JJ_FILE -Password (ConvertTo-SecureString -String $env:JJ_PW -Force -AsPlainText) -CryptoAlgorithmOption AES256_SHA256 | Out-Null; Remove-Item $c.PSPath";
  return new Promise((ok, bad) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, env: { ...process.env, JJ_FILE: CERT, JJ_PW: pw } }, (err) => {
    if (err || !fs.existsSync(CERT)) return bad(err || new Error('สร้างใบรับรองไม่สำเร็จ'));
    fs.writeFileSync(CERT_PW, pw);
    ok();
  }));
}
if (process.env.JOJO_LAN === '1') {
  const HTTPS_PORT = +process.env.JOJO_HTTPS_PORT || PORT + 3;
  ensureCert().then(() => {
    https.createServer({ pfx: fs.readFileSync(CERT), passphrase: fs.readFileSync(CERT_PW, 'utf8').trim() }, onRequest)
      .listen(HTTPS_PORT, '0.0.0.0', () => {
        const ips = Object.values(require('os').networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
        console.log('มือถือในวง Wi-Fi เปิด: ' + ips.map(ip => `https://${ip}:${HTTPS_PORT}`).join('  '));
      });
  }).catch(e => console.error('https ใช้ไม่ได้:', e.message));
}
