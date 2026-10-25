// jojo (มือถือ): หน้านี้มาจากอะตอมมิคบนคอม — ข้อมูลทั้งหมดถามผ่านอะตอมมิค (jojo.js ฝั่งคอม)
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (ms) => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
  const when = (ms) => new Date(ms).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const msg = (el, t, err) => { $(el).textContent = t || ''; $(el).classList.toggle('err', !!err); };
  async function api(p, opt) {
    const r = await fetch(p, { cache: 'no-store', ...opt });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && p !== '/api/pair') { showPair(); throw new Error('ยังไม่ได้จับคู่'); }
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    return j;
  }

  // ---- จับคู่ ----
  function showPair() { $('app').hidden = true; $('pair').hidden = false; }
  $('pairForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    msg('pairMsg', 'กำลังจับคู่…');
    try { await api('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: $('pin').value.trim() }) }); start(); }
    catch (er) { msg('pairMsg', er.message, true); }
  });
  // QR จากอะตอมมิคมี #pin=xxxxxx → ใส่ให้เลย
  const hashPin = (location.hash.match(/pin=(\d{6})/) || [])[1];
  if (hashPin) { $('pin').value = hashPin; history.replaceState(null, '', location.pathname); }

  async function start() {
    try {
      const me = await api('/api/me');
      $('pair').hidden = true; $('app').hidden = false;
      $('host').textContent = 'อะตอมมิค · ' + me.host;
      search('');
      $('lkTrack').focus();
    } catch (e) {
      if (!$('pair').hidden && hashPin) $('pairForm').requestSubmit();
    }
  }

  // ---- แท็บ ----
  let tab = 'pgLock';
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
    tab = b.dataset.pg;
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('.page').forEach(p => { p.hidden = p.id !== tab; });
    if (tab === 'pgCam') loadCams(); else stopGrid();
  }));

  // ---- สินค้า ----
  let seq = 0;
  async function search(q, fromScan) {
    const my = ++seq;
    try {
      const r = await api('/api/sku?q=' + encodeURIComponent(q));
      if (my !== seq) return;
      $('skuInfo').textContent = r.total ? `ข้อมูลสินค้า ${r.total.toLocaleString()} รายการ · ${when(r.at)}` : 'ยังไม่มีข้อมูลสินค้า กด โหลดใหม่จาก BigSeller';
      if (!q) { $('skuList').innerHTML = ''; msg('skuMsg', 'พิมพ์ค้น หรือกด 📷 สแกน ถ่ายรูปบาร์โค้ด'); return; }
      msg('skuMsg', r.count ? `เจอ ${r.count} รายการ${r.count > r.rows.length ? ` (แสดง ${r.rows.length})` : ''}` : (fromScan ? `ไม่พบสินค้าที่มีบาร์โค้ด ${q}` : 'ไม่พบสินค้า'), !r.count);
      const k = q.toUpperCase();
      $('skuList').innerHTML = r.rows.map(x => `<div class="sku${x.gtins.some(g => g.toUpperCase() === k) || x.sku.toUpperCase() === k ? ' hit' : ''}">
        ${x.img ? `<img src="${esc(x.img)}" loading="lazy" alt="" referrerpolicy="no-referrer">` : '<div class="noimg"></div>'}
        <div class="t"><div class="s">${esc(x.sku)}</div><div class="n">${esc(x.title)}${x.isGroup ? ' · ชุดสินค้า' : ''}</div>
        <div class="chips">${x.gtins.length ? x.gtins.map(g => `<span class="chip">${esc(g)}</span>`).join('') : '<span class="chip none">ยังไม่มี GTIN</span>'}</div></div></div>`).join('');
    } catch (e) { if (my === seq) msg('skuMsg', e.message, true); }
  }
  let typing = null;
  $('q').addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(() => search($('q').value.trim()), 250); });
  $('searchForm').addEventListener('submit', (e) => { e.preventDefault(); $('q').blur(); search($('q').value.trim()); });
  $('reload').addEventListener('click', async () => {
    msg('skuMsg', 'กำลังโหลดสินค้าทั้งหมดจาก BigSeller (ผ่านคอม) อาจใช้เวลา 1-2 นาที…');
    try { const r = await api('/api/sku/reload', { method: 'POST' }); msg('skuMsg', `โหลดแล้ว ${r.total.toLocaleString()} รายการ`); search($('q').value.trim()); }
    catch (e) { msg('skuMsg', e.message, true); }
  });

  // ---- ตัวสแกน: กล้องสดเท่านั้น (ไม่ถ่ายรูป) — มือถือเปิดกล้องได้เฉพาะหน้า https (ลิงก์ https ของ jojo) หรือ localhost ----
  // onCode(code) คืน true = พอแล้ว ปิดกล้อง · คืน false = สแกนต่อไปเรื่อย ๆ (ยิงสินค้าหลายชิ้น)
  let scanCb = null, lastCode = '', lastAt = 0;
  const httpsUrl = () => `https://${location.hostname}:${+location.port + 3}${location.pathname}`;
  // อ่านเฟรมจากกล้องเองทุก 150 มิลลิวินาที (โหมดต่อเนื่องของ ZXing ไม่เรียก callback ในบางเครื่อง)
  let stream = null, timer = null;
  const frame = document.createElement('canvas');
  const mfr = new ZXing.MultiFormatReader();
  mfr.setHints(new Map([[ZXing.DecodeHintType.TRY_HARDER, true]]));
  function closeScanner() {
    clearTimeout(timer); timer = null;
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; $('scanVideo').srcObject = null;
    $('scanner').hidden = true; $('scanner').className = 'scanner'; scanCb = null;
  }
  function scanFail(t) { $('scanMsg').innerHTML = t; }
  function tick() {
    if (!stream || !scanCb) return;
    const v = $('scanVideo');
    if (v.videoWidth) {
      frame.width = v.videoWidth; frame.height = v.videoHeight;
      frame.getContext('2d', { willReadFrequently: true }).drawImage(v, 0, 0);
      let code = '';
      try { code = mfr.decode(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.HTMLCanvasElementLuminanceSource(frame)))).getText(); } catch { /* เฟรมนี้ไม่เจอบาร์โค้ด */ }
      const now = Date.now();
      if (code && !(code === lastCode && now - lastAt < 1500)) {   // บาร์โค้ดเดิมค้างหน้ากล้อง ไม่นับซ้ำ
        lastCode = code; lastAt = now;
        if (scanCb(code)) return closeScanner();   // ผล (ถูก/ผิด) ขึ้นบนแถบกล้องผ่าน note()
      }
    }
    timer = setTimeout(tick, 150);
  }
  async function openScanner(onCode, title) {
    scanCb = onCode;
    $('scanner').hidden = false;
    $('scanMsg').textContent = title || 'เล็งบาร์โค้ดให้อยู่ในกรอบ';
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return scanFail(`หน้านี้เปิดกล้องไม่ได้ (ไม่ใช่ https) — <a href="${httpsUrl()}">เปิด jojo แบบ https</a> แล้วสแกนใหม่`);
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      if (!scanCb) return closeScanner();   // กดปิดระหว่างรออนุญาตกล้อง
      $('scanVideo').srcObject = stream;
      await $('scanVideo').play();
      tick();
    } catch (e) {
      if (stream) stream.getTracks().forEach(t => t.stop());
      stream = null;
      scanFail(/NotAllowed|Permission/i.test(e && e.name) ? 'ไม่ได้อนุญาตให้ใช้กล้อง — กดรูปแม่กุญแจข้างที่อยู่เว็บ แล้วอนุญาตกล้อง' : /NotFound|Overconstrained/i.test(e && e.name) ? 'ไม่พบกล้องในเครื่องนี้' : 'เปิดกล้องไม่ได้: ' + esc(e && (e.message || e.name)));
    }
  }
  $('scanClose').addEventListener('click', closeScanner);
  const beep = (ok) => {
    try { navigator.vibrate && navigator.vibrate(ok ? 60 : [120, 60, 120]); } catch { /* ข้าม */ }
    try {
      const a = beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)());
      const o = a.createOscillator(), g = a.createGain();
      o.frequency.value = ok ? 1200 : 300; g.gain.value = 0.15; o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + (ok ? 0.08 : 0.3));
    } catch { /* ข้าม */ }
  };
  // ข้อความของหน้าที่เปิดอยู่
  // ระหว่างเปิดกล้อง: ขึ้นผลบนแถบกล้องด้วย (ข้อความในหน้าโดนกล้องบัง)
  const note = (t, kind) => {
    if (!$('scanner').hidden && t) { $('scanMsg').textContent = t; $('scanner').className = 'scanner ' + (kind || ''); }
    if (tab === 'pgSku') return msg('skuMsg', t, kind === 'err');
    if (tab === 'pgGtin') { $('gtMsg').innerHTML = t ? esc(t) : ''; $('gtMsg').className = 'note ' + (kind || ''); return; }
    $('lkMsg').textContent = t || ''; $('lkMsg').className = 'note ' + (kind || '');
  };
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-scan]'); if (!b) return;
    const k = b.dataset.scan;
    if (k === 'sku') openScanner(code => { $('q').value = code; search(code, true); return true; });
    if (k === 'gtin') openScanner(code => { gtinOpen(code); return true; }, 'สแกนบาร์โค้ดสินค้าที่จะเพิ่ม');
    if (k === 'track' || k === 'item') openScanner(lockCode, order ? 'สแกนสินค้า (สแกนต่อได้เรื่อย ๆ)' : 'สแกนเลขพัสดุ แล้วสแกนสินค้าต่อได้เลย');
  });

  // ---- ล็อกออเดอร์ ----
  // (คัดลอกจากหน้า QC ของอะตอมมิค shell/bsqc.js) เครื่องยิงบลูทูธตอนแป้นมือถือเป็นภาษาไทย

  // ยิงตอนแป้นพิมพ์เป็นภาษาไทย → สแกนเนอร์พิมพ์ออกมาเป็นตัวไทย (เช่น TH266 = ธ็/ุุ) แปลงกลับเป็นปุ่มภาษาอังกฤษ (แป้นเกษมณี)
  const TH_KEYS = {
    'ๅ': '1', '/': '2', '-': '3', 'ภ': '4', 'ถ': '5', 'ุ': '6', 'ึ': '7', 'ค': '8', 'ต': '9', 'จ': '0', 'ข': '-', 'ช': '=',
    'ๆ': 'q', 'ไ': 'w', 'ำ': 'e', 'พ': 'r', 'ะ': 't', 'ั': 'y', 'ี': 'u', 'ร': 'i', 'น': 'o', 'ย': 'p', 'บ': '[', 'ล': ']', 'ฃ': '\\',
    'ฟ': 'a', 'ห': 's', 'ก': 'd', 'ด': 'f', 'เ': 'g', '้': 'h', '่': 'j', 'า': 'k', 'ส': 'l', 'ว': ';', 'ง': "'",
    'ผ': 'z', 'ป': 'x', 'แ': 'c', 'อ': 'v', 'ิ': 'b', 'ื': 'n', 'ท': 'm', 'ม': ',', 'ใ': '.', 'ฝ': '/',
    '+': '!', '๑': '@', '๒': '#', '๓': '$', '๔': '%', 'ู': '^', '฿': '&', '๕': '*', '๖': '(', '๗': ')', '๘': '_', '๙': '+',
    '๐': 'Q', '"': 'W', 'ฎ': 'E', 'ฑ': 'R', 'ธ': 'T', 'ํ': 'Y', '๊': 'U', 'ณ': 'I', 'ฯ': 'O', 'ญ': 'P', 'ฐ': '{', ',': '}', 'ฅ': '|',
    'ฤ': 'A', 'ฆ': 'S', 'ฏ': 'D', 'โ': 'F', 'ฌ': 'G', '็': 'H', '๋': 'J', 'ษ': 'K', 'ศ': 'L', 'ซ': ':', '.': '"',
    '(': 'Z', ')': 'X', 'ฉ': 'C', 'ฮ': 'V', 'ฺ': 'B', '์': 'N', '?': 'M', 'ฒ': '<', 'ฬ': '>', 'ฦ': '?'
  };
  // แปลงเฉพาะเมื่อมีตัวไทยปน (แปลว่ายิงตอนแป้นเป็นภาษาไทย) — ตัวอย่างเช่น '/' '-' ก็มาจากปุ่ม 2, 3 ของแป้นไทย
  const fixThaiLayout = (s) => /[฀-๿]/.test(s) ? [...s].map(ch => TH_KEYS[ch] ?? ch).join('') : s;
  const norm = (s) => String(s || '').toUpperCase().replace(/[\s\-_.]/g, '');
  let order = null, busy = false;
  const done = () => !!order && order.items.every(i => i.scanned >= i.qty);
  function drawOrder(flashSku) {
    $('lkOrder').hidden = !order; $('lkAct').hidden = !order;
    if (!order) { $('lkCard').innerHTML = ''; return; }
    const tot = order.items.reduce((s, i) => s + i.qty, 0), got = order.items.reduce((s, i) => s + Math.min(i.scanned, i.qty), 0);
    $('lkCard').innerHTML = `<div class="lk-head"><div><small>เลขพัสดุ</small><b>${esc(order.trackingNo)}</b> <small>${esc(order.shippingMethod)}</small></div>
      <span class="lk-count${got >= tot ? ' done' : ''}">สแกนแล้ว ${got} / ${tot} ชิ้น</span></div>` +
      order.items.map(i => `<div class="lk-item${i.scanned >= i.qty ? ' full' : ''}${i.merchantSku === flashSku ? ' flash' : ''}">
        ${i.image ? `<img src="${esc(i.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<div class="noimg"></div>'}
        <div class="t"><div class="s">${esc(i.merchantSku || i.productCode)}</div><div class="n">${i.subFrom ? `<span class="sub">แทน ${esc(i.subFrom)}</span> ` : ''}${esc(i.name)}</div></div>
        <span class="q">${i.scanned} / ${i.qty}</span></div>`).join('');
    $('lkConfirm').disabled = !done() || busy;
  }
  async function loadOrder(t) {
    t = String(t || '').trim();
    if (!t || busy) return;
    busy = true; order = null; drawOrder();
    note('กำลังดึงออเดอร์ ' + t + ' จาก BigSeller…', 'info');
    try {
      const r = await api('/api/lock/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trackingNo: t }) });
      const items = (r.items || []).filter(i => i.qty > 0).map(i => ({ ...i, scanned: 0 }));
      if (!items.length) throw new Error('ออเดอร์นี้ไม่มีสินค้าให้สแกน (BigSeller ยังจัดสรรสต็อกไม่เสร็จ?)');
      order = { ...r, items };
      beep(true);
      note(`ดึงออเดอร์ ${order.trackingNo} แล้ว (${items.length} รายการ${r.subN ? ` · มีสินค้าทดแทน ${r.subN} รายการ` : ''}) สแกนสินค้าให้ครบ${r.subWarn ? ' · ⚠️ ' + r.subWarn : ''}`, r.subWarn ? 'info' : 'ok');
      setTimeout(() => $('lkItem').focus(), 50);
    } catch (e) { beep(false); note('❌ ' + e.message, 'err'); $('lkTrack').select(); }
    busy = false; drawOrder();
  }
  function scanItem(code) {
    if (!order) return;
    const c = norm(code);
    const it = order.items.find(i => norm(i.merchantSku) === c || norm(i.productCode) === c || (i.gtins || []).some(g => norm(g) === c));
    if (!it) { beep(false); note(`❌ [${code}] ไม่อยู่ในออเดอร์นี้`, 'err'); return offerGtin(code); }
    if (it.scanned >= it.qty) { beep(false); return note(`⚠️ ${it.merchantSku} ครบจำนวนแล้ว`, 'err'); }
    it.scanned++; beep(true);
    note(done() ? '✅ ครบแล้ว กด ยืนยัน ล็อกออเดอร์' : `👍 ${it.merchantSku} (${it.scanned}/${it.qty})`, 'ok');
    drawOrder(it.merchantSku);
  }
  // กล้องเดียวยิงต่อเนื่อง: ยังไม่มีออเดอร์ = เลขพัสดุ → ดึงออเดอร์ แล้วโค้ดถัดไป = สินค้า · ครบแล้วปิดกล้อง (ไปกด ยืนยัน)
  function lockCode(code) {
    if (busy) return false;   // กำลังดึงออเดอร์ ไม่นับ
    if (!order) { $('lkTrack').value = code; loadOrder(code); return false; }
    if (norm(code) === norm(order.trackingNo)) return false;   // ป้ายพัสดุยังอยู่หน้ากล้อง ไม่นับเป็นสินค้า
    scanItem(code);
    return done();
  }
  // ---- เพิ่ม GTIN ----
  let gtCode = '', gtSeq = 0;
  const gtOk = (c) => /^[A-Za-z0-9-]{4,40}$/.test(c);
  // จากหน้า ล็อกออเดอร์: บาร์โค้ดไม่ตรง → ปุ่ม "ผูก GTIN นี้" (ใต้ข้อความ ตอนกล้องปิด)
  function offerGtin(code) {
    if (!gtOk(code)) return;
    const b = document.createElement('button');
    b.className = 'btn small gt-offer'; b.type = 'button';
    b.textContent = `➕ ผูกบาร์โค้ด ${code} ให้สินค้าในออเดอร์`;
    b.addEventListener('click', () => gtinOpen(code, order ? order.items.map(i => i.merchantSku) : []));
    $('lkMsg').appendChild(b);
  }
  async function gtinOpen(code, skus) {
    code = fixThaiLayout(String(code || '').trim());
    if (tab !== 'pgGtin') document.querySelector('[data-pg=pgGtin]').click();
    $('gtCode').value = code; gtCode = code;
    $('gtOwner').innerHTML = ''; $('gtList').innerHTML = ''; $('gtPick').hidden = true;
    if (!code) return note('');
    if (!gtOk(code)) return note('บาร์โค้ดนี้ใช้เป็น GTIN ไม่ได้ (ตัวอักษร/ตัวเลข 4-40 ตัว)', 'err');
    try {
      const r = await api('/api/sku?q=' + encodeURIComponent(code));
      const own = r.rows.filter(x => x.gtins.some(g => g.toUpperCase() === code.toUpperCase()));
      if (own.length) {
        beep(true);
        note(`บาร์โค้ด ${code} ผูกกับสินค้านี้แล้ว`, 'ok');
        $('gtOwner').innerHTML = own.map(skuCard).join('');
        return;
      }
      note(`บาร์โค้ด ${code} ยังไม่ได้ผูกกับ SKU ไหน — เลือก SKU ด้านล่าง`, 'info');
      $('gtPick').hidden = false;
      $('gtSku').value = '';
      if (skus && skus.length) {   // มาจากออเดอร์: แสดงสินค้าในออเดอร์ให้เลือกเลย
        const rows = [];
        for (const s of skus) { const x = (await api('/api/sku?q=' + encodeURIComponent(s))).rows.find(y => y.sku.toUpperCase() === String(s).toUpperCase()); if (x) rows.push(x); }
        drawPick(rows, 'สินค้าในออเดอร์');
      } else $('gtSku').focus();
    } catch (e) { note('❌ ' + e.message, 'err'); }
  }
  const skuCard = (x, pick) => `<div class="sku">
    ${x.img ? `<img src="${esc(x.img)}" loading="lazy" alt="" referrerpolicy="no-referrer">` : '<div class="noimg"></div>'}
    <div class="t"><div class="s">${esc(x.sku)}</div><div class="n">${esc(x.title)}</div>
    <div class="chips">${x.gtins.length ? x.gtins.map(g => `<span class="chip">${esc(g)}</span>`).join('') : '<span class="chip none">ยังไม่มี GTIN</span>'}</div>
    ${pick ? `<button class="btn small gt-add" type="button" data-gt-add="${esc(x.id)}" data-gt-sku="${esc(x.sku)}">🏷️ ผูก ${esc(gtCode)}</button>` : ''}</div></div>`;
  function drawPick(rows, head) {
    $('gtList').innerHTML = (head ? `<div class="lbl">${esc(head)}</div>` : '') + (rows.length ? rows.map(x => skuCard(x, true)).join('') : '<div class="msg">ไม่พบ SKU</div>');
  }
  let gtTyping = null;
  $('gtSku').addEventListener('input', () => {
    clearTimeout(gtTyping);
    gtTyping = setTimeout(async () => {
      const q = $('gtSku').value.trim(), my = ++gtSeq;
      if (!q) return drawPick([], '');
      try { const r = await api('/api/sku?q=' + encodeURIComponent(q)); if (my === gtSeq) drawPick(r.rows.slice(0, 30), ''); } catch (e) { note('❌ ' + e.message, 'err'); }
    }, 250);
  });
  $('gtSkuForm').addEventListener('submit', (e) => { e.preventDefault(); $('gtSku').blur(); });
  $('gtCodeForm').addEventListener('submit', (e) => { e.preventDefault(); gtinOpen($('gtCode').value); });
  $('gtList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-gt-add]'); if (!b || busy) return;
    if (!confirm(`ผูกบาร์โค้ด ${gtCode} ให้ ${b.dataset.gtSku} ใน BigSeller?`)) return;
    busy = true; b.disabled = true;
    note(`กำลังบันทึก GTIN ${gtCode} ให้ ${b.dataset.gtSku} ใน BigSeller… (ประมาณ 10 วิ)`, 'info');
    try {
      const r = await api('/api/gtin/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skuId: b.dataset.gtAdd, gtin: gtCode }) });
      beep(true);
      note(`✅ ผูก ${gtCode} ให้ ${r.sku} แล้ว${r.already ? ' (มีอยู่แล้ว)' : ''} — สแกนสินค้านี้ผ่านได้เลย`, 'ok');
      $('gtPick').hidden = true; $('gtList').innerHTML = '';
      $('gtOwner').innerHTML = skuCard({ id: b.dataset.gtAdd, sku: r.sku, title: '', img: '', gtins: r.gtins });
      if (order) order.items.forEach(i => { if (i.merchantSku.toUpperCase() === r.sku.toUpperCase()) i.gtins = [...new Set([...(i.gtins || []), gtCode])]; });   // ออเดอร์ที่ค้างอยู่ สแกนต่อได้เลย
    } catch (er) { beep(false); note('❌ ' + er.message, 'err'); b.disabled = false; }
    busy = false;
  });

  $('lkTrackForm').addEventListener('submit', (e) => { e.preventDefault(); loadOrder(fixThaiLayout($('lkTrack').value)); });
  $('lkItemForm').addEventListener('submit', (e) => { e.preventDefault(); const v = fixThaiLayout($('lkItem').value.trim()); $('lkItem').value = ''; if (v) scanItem(v); });
  function resetLock() { order = null; drawOrder(); $('lkTrack').value = ''; $('lkItem').value = ''; $('lkTrack').focus(); }
  $('lkCancel').addEventListener('click', () => { if (!order || confirm('ยกเลิกออเดอร์นี้? (ยังไม่ได้ล็อก)')) { resetLock(); note(''); } });
  const lockLog = [];
  $('lkConfirm').addEventListener('click', async () => {
    if (!done() || busy) return;
    busy = true; drawOrder();
    const t = order.trackingNo;
    note('กำลังล็อกออเดอร์ ' + t + ' ใน BigSeller…', 'info');
    try {
      const r = await api('/api/lock/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        trackingNo: t, orderId: order.orderId, shippingMethod: order.shippingMethod,
        items: order.items.map(i => ({ sku: i.merchantSku || i.productCode, qty: i.qty }))
      }) });
      lockLog.unshift({ t, ok: r.ok, at: Date.now() });
      beep(r.ok);
      const sheet = r.sheet && r.sheet !== 'ok' ? ` · Google Sheet: ${r.sheet}` : '';
      busy = false;
      if (r.ok) { resetLock(); note(`🔒 ${t} ล็อกแล้ว (ตรวจสอบแล้วใน BigSeller)${sheet}`, 'ok'); }
      else note(`⚠️ BigSeller ไม่รับ: ${r.msg}${sheet}`, 'err');
    } catch (e) { beep(false); note('❌ ' + e.message, 'err'); }
    busy = false; drawOrder();
    $('lkLog').innerHTML = lockLog.slice(0, 20).map(x => `<div class="r"><b>${esc(x.t)}</b><span class="${x.ok ? '' : 'bad'}">${x.ok ? '🔒 ล็อกแล้ว' : 'ไม่สำเร็จ'} · ${new Date(x.at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}</span></div>`).join('');
  });

  // ---- กล้อง ----
  let camsCache = [];
  function stopGrid() { $('camList').querySelectorAll('img').forEach(i => i.removeAttribute('src')); }
  async function loadCams() {
    msg('camMsg', 'กำลังโหลดรายชื่อกล้อง…');
    try {
      camsCache = (await api('/api/cams')).cams;
      msg('camMsg', camsCache.length ? 'แตะกล้องเพื่อดูเต็มจอ / ดูย้อนหลัง' : 'ยังไม่มีกล้อง — เปิดกล้องหรือบันทึกกล้องเครื่องอื่นในหน้า กล้อง CCTV ของอะตอมมิค');
      $('camList').innerHTML = camsCache.map(c => `<button class="cam" type="button" data-cam="${esc(c.id)}"><img alt="" src="/cam/${encodeURIComponent(c.id)}/live?t=${Date.now()}"><span>${esc(c.label)}</span></button>`).join('');
    } catch (e) { msg('camMsg', e.message, true); }
  }
  let cur = null, clips = [];
  $('camList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cam]'); if (!b) return;
    cur = camsCache.find(c => c.id === b.dataset.cam); if (!cur) return;
    stopGrid();
    $('camView').hidden = false; $('cvTitle').textContent = cur.label;
    const d = new Date(); $('cvDate').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    showLive(); loadClips();
  });
  function showLive() {
    $('cvVideo').pause(); $('cvVideo').removeAttribute('src'); $('cvVideo').hidden = true;
    $('cvLive').hidden = false; $('cvLive').src = `/cam/${encodeURIComponent(cur.id)}/live?t=${Date.now()}`;
    $('cvClips').querySelectorAll('.clip.on').forEach(x => x.classList.remove('on'));
  }
  async function loadClips() {
    const [y, m, d] = $('cvDate').value.split('-').map(Number);
    if (!y) return;
    const from = new Date(y, m - 1, d).getTime(), to = from + 864e5 - 1;
    msg('cvMsg', 'กำลังโหลดคลิปย้อนหลัง…'); $('cvClips').innerHTML = '';
    try {
      clips = ((await api(`/cam/${encodeURIComponent(cur.id)}/clips?from=${from}&to=${to}`)).clips || []).sort((a, b) => b.start - a.start);
      msg('cvMsg', clips.length ? `${clips.length} คลิป (ล่าสุดอยู่บน) · กล้องอัดเฉพาะตอนมีการเคลื่อนไหว` : 'ไม่มีคลิปวันนี้');
      $('cvClips').innerHTML = clips.map((c, i) => `<button class="clip" type="button" data-clip="${i}"><b>${hhmm(c.start)}</b><small>${Math.max(1, Math.round((c.end - c.start) / 1000))} วิ</small></button>`).join('');
    } catch (e) { msg('cvMsg', e.message, true); }
  }
  $('cvClips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-clip]'); if (!b) return;
    const c = clips[+b.dataset.clip];
    $('cvClips').querySelectorAll('.clip').forEach(x => x.classList.toggle('on', x === b));
    $('cvLive').removeAttribute('src'); $('cvLive').hidden = true;
    const v = $('cvVideo'); v.hidden = false; v.src = `/cam/${encodeURIComponent(cur.id)}/clip/${encodeURIComponent(c.name)}`; v.play().catch(() => {});
    window.scrollTo({ top: 0, behavior: 'smooth' }); $('camView').scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('cvLiveBtn').addEventListener('click', showLive);
  $('cvDate').addEventListener('change', loadClips);
  $('cvBack').addEventListener('click', () => {
    $('cvLive').removeAttribute('src'); $('cvVideo').pause(); $('cvVideo').removeAttribute('src');
    $('camView').hidden = true; loadCams();
  });
  // สลับไปแอพอื่น → หยุดภาพสด (ประหยัดเน็ต/แบต)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopGrid(); $('cvLive').removeAttribute('src'); }
    else if (!$('camView').hidden && !$('cvLive').hidden && cur) showLive();
    else if (tab === 'pgCam' && $('camView').hidden) loadCams();
  });

  start().then(() => { if ($('app').hidden) showPair(); });
})();
