// Smart Car Parking System - backend (v2)
// Demo backend using db.json as a simple file-based database.
//
// Flow:
//   Book  : create payment (bKash/Nagad QR, vehicle no. = reference) -> confirm -> slot booked -> exit code
//   Exit  : enter slot number + exit code (both must match) -> (fine due? create fine payment -> confirm) -> complete -> slot free
//   Timer : starts at booking. After the booked time ends, overtime starts and the fine grows
//           by `ratePer30Min` for every started 30 minutes of overtime.

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, "db.json");
const PAYMENT_WINDOW_MS = 5 * 60 * 1000; // QR is valid for 5 minutes, slot is held meanwhile

// ---- AI (Claude) : Robo assistant ----
// Set ANTHROPIC_API_KEY to switch it on. Without it Robo uses a built-in rule engine.
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const ROBO_MODEL = process.env.ROBO_MODEL || "claude-haiku-4-5-20251001"; // fast chat model

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- DB helpers ----------
function readDB() {
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  db.settings = Object.assign(
    { ratePer30Min: 100, bkashNumber: "01700-000000", nagadNumber: "01800-000000" },
    db.settings
  );
  db.history = db.history || [];
  return db;
}
function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf-8");
}

// ---------- small helpers ----------
const rnd = (n) => crypto.randomBytes(n).toString("hex");
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars, no I/O/0/1

function calcPrice(minutes, rate) {
  return minutes <= 0 ? 0 : Math.ceil(minutes / 30) * rate;
}
function newId(list) {
  return list.length ? Math.max(...list.map((x) => x.id)) + 1 : 1;
}
function newExitCode(db) {
  let code;
  do {
    code = Array.from(crypto.randomBytes(6), (b) => CODE_CHARS[b % 32]).join("");
  } while (db.slots.some((s) => s.guestToken === code));
  return code;
}
function normVehicle(v) {
  return String(v || "").trim().toUpperCase().replace(/\s+/g, " ");
}
function validVehicle(v) {
  return /^[A-Z0-9\u0980-\u09FF\- ]{4,25}$/.test(v);
}
const BN_DIGITS = "০১২৩৪৫৬৭৮৯";
const squash = (v) =>
  String(v || "")
    .replace(/[০-৯]/g, (d) => BN_DIGITS.indexOf(d))
    .toUpperCase()
    .replace(/[\s-]/g, "");
const sameVehicle = (a, b) => squash(a) === squash(b);

function freeSlot(slot) {
  slot.status = "free";
  slot.ownerType = null;
  slot.userId = null;
  slot.guestToken = null; // the exit code lives in this field
  slot.vehicleNo = null;
  slot.entryTime = null;
  slot.durationMin = null;
  slot.expiryTime = null;
  slot.finePaid = 0;
  slot.guestKey = null; // secret that proves who owns a guest booking
  slot.historyId = null;
}

// Slot number AND exit code must both match the same booking (case-insensitive code).
function slotByIdAndCode(db, slotId, code) {
  code = String(code || "").trim().toUpperCase();
  const slot = db.slots.find((s) => s.id === Number(slotId));
  if (!slot || slot.status !== "occupied" || !slot.guestToken || !code) return null;
  const a = Buffer.from(slot.guestToken.toUpperCase());
  const b = Buffer.from(code);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? slot : null;
}
const MISMATCH = "Slot number and exit code do not match. Check both and try again.";

// Only the owner may exit / pay the fine for a car:
//  - registered booking -> only that signed-in account
//  - guest booking      -> only the browser that made the booking (holds the guest key)
function ownerError(req, db, slot) {
  if (slot.ownerType === "user") {
    const user = getUser(req, db);
    if (!user) return "This car was booked from a registered account. Sign in with that account to exit.";
    if (user.id !== slot.userId) return "This car belongs to another account. Only its owner can exit it.";
    return null;
  }
  const key = String(req.body.guestKey || "");
  const a = Buffer.from(String(slot.guestKey || ""));
  const b = Buffer.from(key);
  if (!slot.guestKey || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return "This car was booked as a guest from another device or browser. Only that guest can exit it.";
  }
  return null;
}

// overtime + fine calculation
function fineInfo(slot, rate, now) {
  const overtimeMs = Math.max(0, now - slot.expiryTime);
  const fine = Math.ceil(overtimeMs / 60000 / 30) * rate;
  const paid = slot.finePaid || 0;
  return { overtimeMs, fine, finePaid: paid, due: Math.max(0, fine - paid) };
}

function describe(slot, rate, now, withCode) {
  const f = fineInfo(slot, rate, now);
  const out = {
    slotId: slot.id,
    vehicleNo: slot.vehicleNo || null,
    entryTime: slot.entryTime,
    expiryTime: slot.expiryTime,
    durationMin: slot.durationMin,
    ...f,
    now,
  };
  if (withCode) out.exitCode = slot.guestToken;
  return out;
}

// ---------- in-memory state ----------
const sessions = new Map(); // token -> userId
const payments = new Map(); // paymentId -> payment
const holds = new Map(); // slotId -> { paymentId, vehicleNo, until }
const failedTries = new Map(); // ip -> { count, resetAt }
const rateBuckets = new Map(); // "kind:ip" -> [timestamps]

function limited(req, kind, max, windowMs = 60000) {
  const key = kind + ":" + req.ip;
  const t = Date.now();
  const arr = (rateBuckets.get(key) || []).filter((x) => t - x < windowMs);
  arr.push(t);
  rateBuckets.set(key, arr);
  return arr.length > max;
}

// ---------- parking history ----------
// One record per parking visit: created when the booking is paid, updated on fine / exit.
function newHistory(db, slot, p, now, trxId) {
  const rec = {
    id: newId(db.history),
    slotId: slot.id,
    vehicleNo: slot.vehicleNo,
    userId: p.userId || null,
    ownerType: slot.ownerType,
    bookedMin: slot.durationMin,
    entryTime: slot.entryTime,
    expiryTime: slot.expiryTime,
    exitTime: null,
    status: "parked",
    bookingAmount: p.amount,
    bookingMethod: p.method,
    finePaid: 0,
    overtimeMin: 0,
    payments: [{ kind: "booking", amount: p.amount, method: p.method, trxId, at: now }],
    events: [{ type: "entry", at: now, text: `Booked slot ${slot.id} for ${slot.durationMin} min` }],
  };
  db.history.push(rec);
  return rec;
}
const recOf = (db, slot) => (slot.historyId ? db.history.find((h) => h.id === slot.historyId) : null);

// History is private: admins see every vehicle, a signed-in user sees only their own bookings.
function visibleHistory(db, user) {
  if (!user) return null;
  return user.isAdmin ? db.history : db.history.filter((h) => h.userId === user.id);
}

setInterval(() => {
  const t = Date.now();
  for (const [k, arr] of rateBuckets) if (!arr.some((x) => t - x < 60000)) rateBuckets.delete(k);
}, 60000);

function getUser(req, db) {
  const id = sessions.get(req.headers["x-token"]);
  return id ? db.users.find((u) => u.id === id) : null;
}
function blocked(req) {
  const t = failedTries.get(req.ip);
  return !!t && t.resetAt > Date.now() && t.count >= 10;
}
function recordFail(req) {
  const t = failedTries.get(req.ip);
  if (!t || t.resetAt <= Date.now()) failedTries.set(req.ip, { count: 1, resetAt: Date.now() + 60000 });
  else t.count++;
}
const TOO_MANY = { error: "Too many wrong attempts. Please wait a minute and try again." };

setInterval(() => {
  const now = Date.now();
  for (const [id, p] of payments) if (now > p.expiresAt + 60000) payments.delete(id);
  for (const [sid, h] of holds) if (h.until <= now) holds.delete(sid);
}, 30000);

// ---------- public slots (NO exit codes are exposed here) ----------
app.get("/api/slots", (req, res) => {
  const db = readDB();
  const now = Date.now();
  const slots = db.slots.map((s) => {
    const h = holds.get(s.id);
    const status = s.status === "occupied" ? "occupied" : h && h.until > now ? "held" : "free";
    return {
      id: s.id,
      status,
      entryTime: status === "occupied" ? s.entryTime : null,
      expiryTime: status === "occupied" ? s.expiryTime : null,
      durationMin: status === "occupied" ? s.durationMin : null,
    };
  });
  res.json({ now, slots, ratePer30Min: db.settings.ratePer30Min });
});

// ---------- PAYMENTS (bKash / Nagad QR) ----------
app.post("/api/payments/create", (req, res) => {
  const { purpose, method, slotId, durationMin, code } = req.body;
  let vehicleNo = normVehicle(req.body.vehicleNo);

  const db = readDB();
  const now = Date.now();
  const rate = db.settings.ratePer30Min;
  const user = getUser(req, db);
  let amount;
  const meta = {};

  if (purpose === "recharge") {
    // Wallet top-up: registered users only, bKash/Nagad QR only (can't recharge the wallet with the wallet).
    if (!user) return res.status(401).json({ error: "Please sign in to recharge your wallet" });
    if (!["bkash", "nagad"].includes(method)) return res.status(400).json({ error: "Choose bKash or Nagad" });
    const amt = Math.floor(Number(req.body.amount));
    if (!(amt >= 50 && amt <= 100000)) return res.status(400).json({ error: "Enter an amount between ৳50 and ৳100000" });
    amount = amt;
    vehicleNo = user.phone; // used as the payment reference shown on the QR
    meta.userId = user.id;
  } else if (purpose === "book") {
    if (!["bkash", "nagad", "wallet"].includes(method)) return res.status(400).json({ error: "Choose bKash, Nagad or Wallet" });
    if (!validVehicle(vehicleNo)) return res.status(400).json({ error: "Enter your vehicle number (min 4 characters). It is used as the payment reference." });
    const slot = db.slots.find((s) => s.id === Number(slotId));
    if (!slot) return res.status(404).json({ error: "Slot not found" });
    if (slot.status !== "free") return res.status(400).json({ error: "This slot is already occupied" });
    const dur = Math.floor(Number(durationMin));
    if (!(dur >= 1 && dur <= 1440)) return res.status(400).json({ error: "Duration must be between 1 and 1440 minutes" });
    const h = holds.get(slot.id);
    if (h && h.until > now && !sameVehicle(h.vehicleNo, vehicleNo)) {
      return res.status(400).json({ error: "Another driver is paying for this slot. Try again in a few minutes." });
    }
    if (db.slots.some((s) => s.status === "occupied" && s.vehicleNo && sameVehicle(s.vehicleNo, vehicleNo))) {
      return res.status(400).json({ error: "This vehicle already has an active booking" });
    }
    amount = calcPrice(dur, rate);
    if (method === "wallet") {
      if (!user) return res.status(401).json({ error: "Please sign in to pay from your wallet" });
      if ((user.balance || 0) < amount) return res.status(400).json({ error: "Insufficient wallet balance. Please recharge your wallet." });
    }
    meta.slotId = slot.id;
    meta.durationMin = dur;
  } else if (purpose === "fine") {
    if (!["bkash", "nagad", "wallet"].includes(method)) return res.status(400).json({ error: "Choose bKash, Nagad or Wallet" });
    if (blocked(req)) return res.status(429).json(TOO_MANY);
    const slot = slotByIdAndCode(db, slotId, code);
    if (!slot) { recordFail(req); return res.status(404).json({ error: MISMATCH }); }
    const oe = ownerError(req, db, slot);
    if (oe) return res.status(403).json({ error: oe });
    vehicleNo = slot.vehicleNo || ""; // taken from the booking - the driver does not type it at payment
    const f = fineInfo(slot, rate, now);
    if (f.due <= 0) return res.status(400).json({ error: "There is no fine to pay" });
    amount = f.due;
    if (method === "wallet") {
      if (!user) return res.status(401).json({ error: "Please sign in to pay from your wallet" });
      if ((user.balance || 0) < amount) return res.status(400).json({ error: "Insufficient wallet balance. Please recharge your wallet." });
    }
    meta.slotId = slot.id;
    meta.code = slot.guestToken;
  } else {
    return res.status(400).json({ error: "Invalid payment purpose" });
  }

  const id = rnd(6);
  // Payment reference = the payment ID (recharge uses the account phone). No vehicle number at payment.
  const reference = purpose === "recharge" ? vehicleNo : id.toUpperCase();
  const payment = {
    id, purpose, method, amount, vehicleNo,
    userId: user ? user.id : null,
    status: "pending", createdAt: now, expiresAt: now + PAYMENT_WINDOW_MS,
    ...meta,
  };
  payments.set(id, payment);
  if (purpose === "book") holds.set(meta.slotId, { paymentId: id, vehicleNo, until: payment.expiresAt });

  if (method === "wallet") {
    // Internal balance transfer — no QR to scan, /confirm settles it instantly.
    return res.json({ paymentId: id, method, amount, wallet: true, expiresAt: payment.expiresAt, now });
  }

  const merchant = method === "bkash" ? db.settings.bkashNumber : db.settings.nagadNumber;
  // Unique per payment: merchant + amount + reference (vehicle no.) + payment id
  const qrPayload = `${method}://pay?merchant=${merchant}&amount=${amount}&ref=${encodeURIComponent(reference)}&pid=${id}`;

  res.json({ paymentId: id, method, amount, merchant, reference, qrPayload, expiresAt: payment.expiresAt, now });
});

app.post("/api/payments/:id/confirm", (req, res) => {
  const p = payments.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Payment session not found" });
  if (p.status === "paid") return res.json(p.result); // idempotent

  const now = Date.now();
  if (p.status !== "pending" || now > p.expiresAt) {
    if (p.purpose === "book") { const h = holds.get(p.slotId); if (h && h.paymentId === p.id) holds.delete(p.slotId); }
    p.status = "expired";
    return res.status(400).json({ error: "Payment session expired. Please generate a new QR." });
  }

  // TODO (production): verify the transaction with the bKash / Nagad merchant API here
  // (query payment by paymentId / trxID + amount + reference) BEFORE going on.
  // In this demo the "I have paid" button is trusted.

  const db = readDB();
  const trxId = "TX" + rnd(4).toUpperCase();
  let result;

  if (p.purpose === "book") {
    const slot = db.slots.find((s) => s.id === p.slotId);
    const h = holds.get(p.slotId);
    if (!slot || slot.status !== "free") return res.status(400).json({ error: "Slot was taken. Contact staff for a refund." });
    if (h && h.paymentId !== p.id && h.until > now) return res.status(400).json({ error: "Slot is reserved by another payment" });

    let payingUser = null;
    if (p.method === "wallet") {
      payingUser = db.users.find((u) => u.id === p.userId);
      if (!payingUser) return res.status(401).json({ error: "Please sign in to pay from your wallet" });
      if ((payingUser.balance || 0) < p.amount) return res.status(400).json({ error: "Insufficient wallet balance. Please recharge your wallet." });
    }

    slot.status = "occupied";
    slot.ownerType = p.userId ? "user" : "guest";
    slot.userId = p.userId;
    slot.guestToken = newExitCode(db); // exit code
    slot.vehicleNo = p.vehicleNo;
    slot.entryTime = now; // timer starts NOW
    slot.durationMin = p.durationMin;
    slot.expiryTime = now + p.durationMin * 60 * 1000;
    slot.finePaid = 0;
    if (payingUser) payingUser.balance = (payingUser.balance || 0) - p.amount;
    // guest bookings get a secret key kept only in the guest's browser; without it nobody can exit the car
    slot.guestKey = p.userId ? null : rnd(16);
    const rec = newHistory(db, slot, p, now, trxId);
    slot.historyId = rec.id;
    writeDB(db);
    holds.delete(p.slotId);

    result = {
      purpose: "book", slotId: slot.id, exitCode: slot.guestToken, vehicleNo: p.vehicleNo,
      amount: p.amount, method: p.method, trxId,
      entryTime: slot.entryTime, expiryTime: slot.expiryTime, durationMin: slot.durationMin, now,
      balance: payingUser ? payingUser.balance : undefined,
      guestKey: slot.guestKey || undefined,
    };
  } else if (p.purpose === "recharge") {
    const user = db.users.find((u) => u.id === p.userId);
    if (!user) return res.status(401).json({ error: "Please sign in again and retry" });
    user.balance = (user.balance || 0) + p.amount;
    writeDB(db);
    result = { purpose: "recharge", amount: p.amount, method: p.method, trxId, balance: user.balance };
  } else {
    const slot = db.slots.find((s) => s.id === p.slotId && s.status === "occupied" && s.guestToken === p.code);
    if (!slot) return res.status(400).json({ error: "This booking is no longer active" });

    let payingUser = null;
    if (p.method === "wallet") {
      payingUser = db.users.find((u) => u.id === p.userId);
      if (!payingUser) return res.status(401).json({ error: "Please sign in to pay from your wallet" });
      if ((payingUser.balance || 0) < p.amount) return res.status(400).json({ error: "Insufficient wallet balance. Please recharge your wallet." });
    }

    slot.finePaid = (slot.finePaid || 0) + p.amount;
    if (payingUser) payingUser.balance = (payingUser.balance || 0) - p.amount;
    const rec = recOf(db, slot);
    if (rec) {
      rec.finePaid = slot.finePaid;
      rec.payments.push({ kind: "fine", amount: p.amount, method: p.method, trxId, at: now });
      rec.events.push({ type: "fine", at: now, text: `Overtime fine paid: ${p.amount} Tk via ${p.method}` });
    }
    writeDB(db);
    result = { purpose: "fine", code: p.code, amount: p.amount, method: p.method, trxId, balance: payingUser ? payingUser.balance : undefined };
  }

  p.status = "paid";
  p.result = result;
  res.json(result);
});

app.post("/api/payments/:id/cancel", (req, res) => {
  const p = payments.get(req.params.id);
  if (p && p.status === "pending") {
    p.status = "cancelled";
    const h = holds.get(p.slotId);
    if (h && h.paymentId === p.id) holds.delete(p.slotId);
  }
  res.json({ ok: true });
});

// ---------- EXIT (by exit code only) ----------
app.post("/api/exit/check", (req, res) => {
  if (blocked(req)) return res.status(429).json(TOO_MANY);
  const db = readDB();
  const slot = slotByIdAndCode(db, req.body.slotId, req.body.code);
  if (!slot) { recordFail(req); return res.status(404).json({ error: MISMATCH }); }
  const oe = ownerError(req, db, slot);
  if (oe) return res.status(403).json({ error: oe });
  res.json(describe(slot, db.settings.ratePer30Min, Date.now(), false));
});

app.post("/api/exit/complete", (req, res) => {
  if (blocked(req)) return res.status(429).json(TOO_MANY);
  const db = readDB();
  const slot = slotByIdAndCode(db, req.body.slotId, req.body.code);
  if (!slot) { recordFail(req); return res.status(404).json({ error: MISMATCH }); }

  const oe = ownerError(req, db, slot);
  if (oe) return res.status(403).json({ error: oe });

  const now = Date.now();
  const f = fineInfo(slot, db.settings.ratePer30Min, now);
  if (f.due > 0) return res.status(402).json({ error: `Fine of ${f.due} Tk must be paid before exit`, due: f.due });

  const slotId = slot.id;
  const elapsedMinutes = Math.round((now - slot.entryTime) / 60000);
  const rec = recOf(db, slot);
  if (rec) {
    rec.exitTime = now;
    rec.status = "exited";
    rec.overtimeMin = Math.max(0, Math.round(f.overtimeMs / 60000));
    rec.finePaid = slot.finePaid || 0;
    rec.parkedMin = elapsedMinutes;
    rec.events.push({ type: "exit", at: now, text: `Exited slot ${slotId} after ${elapsedMinutes} min` });
  }
  freeSlot(slot);
  writeDB(db);
  res.json({ message: "Gate open. Drive safe!", slotId, elapsedMinutes });
});

// ---------- Claude helper ----------
async function callClaude({ model, system, messages, max_tokens = 400, temperature = 0.2 }) {
  const r = await fetch(process.env.ANTHROPIC_API_URL || "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, system, messages, max_tokens, temperature }),
    signal: AbortSignal.timeout(25000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || "AI request failed (" + r.status + ")");
  return (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
}

// ---------- HISTORY (signed-in users; admin sees everything) ----------
app.get("/api/history", (req, res) => {
  const db = readDB();
  const user = getUser(req, db);
  if (!user) return res.status(401).json({ error: "Please sign in to see parking history" });
  const now = Date.now();
  const rate = db.settings.ratePer30Min;
  const records = visibleHistory(db, user)
    .slice()
    .sort((a, b) => b.entryTime - a.entryTime)
    .slice(0, 1000)
    .map((h) => {
      const out = { ...h };
      if (h.status === "parked") {
        // live overtime + fine for cars that are still inside
        const ot = Math.max(0, now - h.expiryTime);
        out.overtimeMin = Math.round(ot / 60000);
        out.fineTotal = Math.ceil(ot / 60000 / 30) * rate;
        out.fineDue = Math.max(0, out.fineTotal - (h.finePaid || 0));
      } else {
        out.fineTotal = h.finePaid || 0;
        out.fineDue = 0;
      }
      return out;
    });
  res.json({ scope: user.isAdmin ? "all" : "own", records, now });
});

// ---------- ROBO ASSISTANT ----------
function liveContext(db) {
  const now = Date.now();
  const slots = db.slots.map((s) => {
    const h = holds.get(s.id);
    const status = s.status === "occupied" ? "occupied" : h && h.until > now ? "payment in progress" : "free";
    return { id: s.id, status, freesInMin: status === "occupied" ? Math.max(0, Math.ceil((s.expiryTime - now) / 60000)) : null };
  });
  const free = slots.filter((s) => s.status === "free").map((s) => s.id).sort((a, b) => a - b);
  return { slots, free, nearest: free.length ? free[0] : null, total: slots.length, rate: db.settings.ratePer30Min,
  };
}

function systemPrompt(c) {
  const slotLines = c.slots.map((s) => `Slot ${s.id}: ${s.status}` + (s.freesInMin != null ? ` (booked time ends in about ${s.freesInMin} min)` : "")).join("\n");
  return `You are Robo, the assistant of the SmartPark smart car parking system. You ONLY answer questions about THIS parking system: slots and their live status, the nearest free slot, prices, booking, payment (bKash, Nagad, wallet), wallet recharge, overtime fines, exit and exit code, parking history, and account/security questions about the system.

If the question is about anything else (general knowledge, coding, maths, news, chit-chat beyond a greeting, other companies...), do not answer it. Reply with one short sentence saying you can only help with the SmartPark parking system, and list what you can help with.

LANGUAGE: reply in the language the user wrote in (English, Bangla, or Banglish written in English letters). Plain text only, no markdown, no asterisks. Keep it short and exact (1-4 sentences; a short list is fine when asked for several things).

ACCURACY: use ONLY the facts below. Never invent slots, prices, times or features. If something is not covered, say you do not have that information.

LIVE DATA (right now):
Total slots: ${c.total}. Free slots: ${c.free.length ? c.free.join(", ") : "none"}. Nearest free slot: ${c.nearest ?? "none"}.
${slotLines}
"Nearest" means the lowest-numbered free slot, because slot 1 is closest to the entrance and numbers grow with distance.

SYSTEM FACTS:
- Price: ${c.rate} Tk per 30 minutes; every started 30 minutes is charged (cost = ceil(minutes / 30) x ${c.rate}). Booking length: 1 to 1440 minutes.
- Booking: Parking tab, tap a free slot, choose duration, enter the vehicle number (required), choose bKash, Nagad or Wallet, pay. The timer starts when payment is complete and an exit code is shown.
- bKash/Nagad: a QR code is shown, valid 5 minutes, and the slot is held for that time. Payment reference is the payment ID. No vehicle number is asked at payment.
- Wallet: only for registered users. Recharge from the Wallet tab with bKash or Nagad, from 50 to 100000 Tk. Guests can book and pay by bKash/Nagad but have no wallet or history.
- Overtime fine: after the booked time ends, ${c.rate} Tk for every started 30 minutes. It must be paid (bKash, Nagad or wallet) before the gate opens.
- Exit: Exit tab, enter slot number AND exit code (both must match), verify, pay any fine, then slide to open the gate.
- History tab (signed-in users): list of vehicles; tap a vehicle number to see each visit: slot, entry time, exit time, time parked, booked time, payments, overtime, extra fine. Users see their own vehicles; the administrator sees all.
- Car ownership: a car booked from a registered account can only be exited (and its fine paid) by that same signed-in account. A car booked as a guest can only be exited from the same browser/device that made the booking, never by another guest or account. The exit code alone is not enough.
- Security: exit needs slot number + exit code; too many wrong tries locks the attempt for a minute; the vehicle number is linked to the booking.

PRIVACY: never reveal anyone's exit code, vehicle number, payment details or history. You cannot book, pay or open the gate yourself; explain the steps instead.`;
}

function localAnswer(qRaw, c) {
  const q = qRaw.toLowerCase();
  const has = (re) => re.test(q);
  const rate = c.rate;
  if (has(/^(hi|hello|hey|salam|assalam|assalamu|hola)\b/)) return 'Hi! I am Robo. Ask me about free slots, prices, booking, payment, fines, exit or history.';
  if (has(/thank|dhonnobad|dhonyobad/)) return "You're welcome! Drive safe.";
  if (has(/nearest|closest|near|kase|kache|nikot|free\s*slot|empty|khali|available|kon\s*slot|slot\s*(ase|ache|khali)/)) {
    if (!c.free.length) return "Every slot is full or being paid for right now. Check again in a moment.";
    return `Nearest free slot: #${c.nearest}. Free slots now: ${c.free.join(", ")} (${c.free.length} of ${c.total}).`;
  }
  const mins = q.match(/(\d+)\s*(minutes|minute|mins|min|minit)\b/);
  const hrs = q.match(/(\d+(?:\.\d+)?)\s*(hours|hour|hrs|hr|ghonta|ghanta)\b/);
  if (mins || hrs || has(/\b(cost|price|charge|fee|rate|koto|taka|tk|vara|bill)\b/)) {
    let m = mins ? parseInt(mins[1], 10) : hrs ? Math.round(parseFloat(hrs[1]) * 60) : null;
    if (m && m > 0) return `${m} minute(s) costs ${Math.ceil(m / 30) * rate} Tk (${rate} Tk per started 30 minutes).`;
    return `Parking costs ${rate} Tk for every 30 minutes (a started block counts in full). Tell me the time, e.g. "cost for 90 minutes".`;
  }
  if (has(/\b(history|records?|previous|past|log)\b/)) return "Open the History tab (sign in first). It lists vehicles; tap a vehicle number to see its slot, entry and exit time, time parked, payments and fines. You only see your own vehicles unless you are the administrator.";
  if (has(/\b(fine|overtime|late|extra)\b/)) return `After your booked time ends, ${rate} Tk is added for every started 30 minutes. Pay it by bKash, Nagad or wallet on the Exit page before the gate opens. No vehicle number is needed at payment.`;
  if (has(/\b(exit|leave|gate|bahir|code)\b/)) return "Exit tab: enter your slot number and the exit code from your ticket, verify, clear any fine, then slide to open the gate. Only the owner can exit: a registered account's car needs that same account signed in, and a guest car needs the same device/browser that booked it.";
  if (has(/\b(recharge|wallet|balance)\b/)) return "Wallet tab (registered users): tap Recharge wallet, choose an amount (50 to 100000 Tk), pay with bKash or Nagad. You can then pay bookings and fines from the balance.";
  if (has(/\b(pay|bkash|nagad|qr|payment)\b/)) return "You can pay with bKash or Nagad (scan the QR, valid 5 minutes) or with your wallet if you are signed in. The reference is the payment ID; no vehicle number is needed at payment.";
  if (has(/\b(book|booking|reserve|park|parking)\b/)) return "Parking tab: tap a free slot, choose the duration, enter your vehicle number, pick a payment method and pay. Your timer starts and you get an exit code.";
  if (has(/secur|safe|protect|nirapotta/)) return "Exit needs both slot number and exit code, wrong tries are rate-limited, and only the owner can exit a car: the same account for registered bookings, the same device for guest bookings.";
  return "I can only help with the SmartPark parking system: free/nearest slot, prices, booking, payment, wallet, fines, exit. What would you like to know?";
}

app.post("/api/assistant", async (req, res) => {
  const message = String(req.body.message || "").trim().slice(0, 500);
  if (!message) return res.status(400).json({ error: "Type a question first." });
  if (limited(req, "robo", 25)) return res.status(429).json({ error: "Slow down a little - try again in a minute." });
  const db = readDB();
  const c = liveContext(db);

  if (!ANTHROPIC_KEY) return res.json({ reply: localAnswer(message, c), ai: false });

  // recent turns for context (sanitised, strictly alternating, ending with the new question)
  const hist = (Array.isArray(req.body.history) ? req.body.history : [])
    .filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
    .slice(-8)
    .map((h) => ({ role: h.role, content: h.content.slice(0, 500) }));
  const msgs = [];
  for (const h of [...hist, { role: "user", content: message }]) {
    if (!msgs.length && h.role !== "user") continue;
    if (msgs.length && msgs[msgs.length - 1].role === h.role) msgs[msgs.length - 1].content += "\n" + h.content;
    else msgs.push({ ...h });
  }
  try {
    const reply = await callClaude({ model: ROBO_MODEL, system: systemPrompt(c), messages: msgs, max_tokens: 350 });
    res.json({ reply: reply || localAnswer(message, c), ai: true });
  } catch (e) {
    console.error("Robo AI error:", e.message);
    res.json({ reply: localAnswer(message, c), ai: false });
  }
});

// ---------- REGISTERED USERS ----------
app.post("/api/users/register", (req, res) => {
  const { name, phone, password } = req.body;
  if (!name || !phone || !password) return res.status(400).json({ error: "Please fill in all fields" });
  if (String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

  const db = readDB();
  if (db.users.find((u) => u.phone === String(phone).trim())) return res.status(400).json({ error: "An account already exists with this phone number" });

  const user = { id: newId(db.users), name: String(name).trim(), phone: String(phone).trim(), password: String(password), balance: 0 };
  db.users.push(user);
  writeDB(db);
  res.json({ message: "Account created" });
});

app.post("/api/users/login", (req, res) => {
  const { phone, password } = req.body;
  const db = readDB();
  const user = db.users.find((u) => u.phone === String(phone || "").trim() && u.password === password);
  if (!user) return res.status(401).json({ error: "Incorrect phone or password" });
  const token = rnd(24);
  sessions.set(token, user.id);
  res.json({ token, user: { id: user.id, name: user.name, phone: user.phone, balance: user.balance || 0 } });
});

app.post("/api/users/logout", (req, res) => {
  sessions.delete(req.headers["x-token"]);
  res.json({ ok: true });
});

// Logged-in user: profile + own active parkings (with live fine)
app.get("/api/users/me", (req, res) => {
  const db = readDB();
  const user = getUser(req, db);
  if (!user) return res.status(401).json({ error: "Please sign in" });
  const now = Date.now();
  const slots = db.slots
    .filter((s) => s.status === "occupied" && s.ownerType === "user" && s.userId === user.id)
    .map((s) => describe(s, db.settings.ratePer30Min, now, false));
  res.json({ user: { id: user.id, name: user.name, phone: user.phone, balance: user.balance || 0 }, slots, now });
});

// Demo password reset (verifies only the phone number).
// For production use a real OTP/email flow and hashed passwords.
app.post("/api/users/reset-password", (req, res) => {
  const { phone, newPassword } = req.body;
  if (!phone || !newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: "Enter a valid phone number and a password of at least 6 characters" });
  }
  const db = readDB();
  const user = db.users.find((u) => u.phone === String(phone).trim());
  if (!user) return res.status(404).json({ error: "No account was found with this phone number" });
  user.password = String(newPassword);
  writeDB(db);
  res.json({ message: "Password reset successful. You can now sign in." });
});

app.listen(PORT, () => console.log(`Smart Car Parking server running: http://localhost:${PORT}`));

module.exports = { calcPrice, fineInfo, validVehicle, sameVehicle };