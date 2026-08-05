const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const mineflayer = require("mineflayer");
const {
  pathfinder,
  Movements,
  goals: { GoalBlock },
} = require("mineflayer-pathfinder");

// ==========================================
// KHỞI TẠO WEB SERVER
// ==========================================
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const PORT = 25982;
app.use(express.static("public"));

let botData = {
  username: "Chưa kết nối",
  status: "Offline",
  health: 0,
  food: 0,
  position: "0, 0, 0",
  uptime: "0s",
  reconnects: 0,
  lastKickReason: "N/A",
};

server.listen(PORT, () => {
  console.log(`🌐 Web Server: http://localhost:${PORT}`);
});

// ==========================================
// CẤU HÌNH BOT
// ==========================================
const VERSIONS_TO_TRY = ["1.21.1"];
let versionIndex = 0;

function getCurrentVersion() {
  return VERSIONS_TO_TRY[versionIndex % VERSIONS_TO_TRY.length];
}

const BASE_CONFIG = {
  host: "donutsmp.net",
  port: 25565,
  username: "kmloveyaie5E2N7@outlook.com",
  auth: "microsoft",
  disableChatSigning: true,
  checkTimeoutInterval: 120000,
  keepAlive: true,
  connectTimeout: 90000,
  hideErrors: false,
  logErrors: true,
};

let bot = null;
let isStoppedPermanently = false;
let botIntervals = [];
let reconnectTimer = null;
let autoSellRunning = false;

// ==========================================
// RECONNECT STATE MACHINE
// ==========================================
let consecutiveFails = 0;
let lastDisconnectTime = 0;

function getReconnectDelay(reason) {
  const now = Date.now();
  const timeSinceLastDC = now - lastDisconnectTime;
  lastDisconnectTime = now;

  if (timeSinceLastDC < 30000) {
    consecutiveFails++;
  } else {
    consecutiveFails = 0;
  }

  const base = 25000;
  const backoff = Math.min(consecutiveFails * 20000, 120000);
  const jitter = Math.random() * 10000;
  let delay = base + backoff + jitter;

  if (!reason) return delay;
  const r = reason.toLowerCase();

  if (
    r.includes("socketclosed") ||
    r.includes("econnreset") ||
    r.includes("etimedout")
  ) {
    versionIndex++;
    log(`🔁 Thử version khác: ${getCurrentVersion()}`);
    return Math.max(delay, 30000 + Math.random() * 15000);
  }
  if (r.includes("invalid sequence")) {
    return Math.max(delay, 90000 + Math.random() * 30000);
  }
  if (r.includes("kicked") || r.includes("you have been kicked")) {
    return Math.max(delay, 60000 + Math.random() * 60000);
  }
  if (
    r.includes("disconnect.quitting") ||
    r.includes("stopped by user")
  ) {
    return 3000;
  }

  return delay;
}

// ==========================================
// HELPERS
// ==========================================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearBotIntervals() {
  botIntervals.forEach((id) => clearInterval(id));
  botIntervals = [];
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function log(msg) {
  const time = new Date().toLocaleTimeString("vi-VN");
  const full = `[${time}] ${msg}`;
  console.log(full);
  io.emit("log", full);
}

// ==========================================
// ANTI-AFK
// ==========================================
function humanLook() {
  if (!bot?.entity || isStoppedPermanently) return;
  try {
    const yaw = (Math.random() - 0.5) * Math.PI;
    const pitch = (Math.random() - 0.5) * 0.4;
    bot.look(yaw, pitch, false);
  } catch (_) {}
}

function humanSneak() {
  if (!bot?.entity || isStoppedPermanently) return;
  try {
    bot.setControlState("sneak", true);
    setTimeout(() => {
      if (bot) bot.setControlState("sneak", false);
    }, 500 + Math.random() * 500);
  } catch (_) {}
}

// ==========================================
// AUTOSELL - VIẾT LẠI HOÀN TOÀN
// ==========================================

/**
 * Slot mapping trong Minecraft inventory (mineflayer):
 *
 * Window slots khi GUI đang mở (ví dụ GUI sell có 54 slots):
 *   - Slot 0..53  : các ô trong GUI (chest/sell UI)
 *   - Slot 54..80 : inventory của player (9 hàng trên, không tính hotbar)
 *   - Slot 81..89 : hotbar (slot 81=hotbar[0], ..., slot 89=hotbar[8])
 *
 * Hotbar slot 0,1,2 (bấm phím 1,2,3) = window slot 81,82,83 → BỎ QUA
 *
 * Khi KHÔNG có GUI (inventory thường):
 *   - slot 36..44 = hotbar[0..8]  → bỏ slot 36,37,38 (phím 1,2,3)
 *   - slot 9..35  = inventory chính
 *
 * Chiến lược: dùng shift+click (button=1, mode=1) để move item nhanh vào GUI.
 * Mineflayer clickWindow(slot, button, mode):
 *   - mode=0, button=0 → left click bình thường
 *   - mode=1, button=0 → shift + left click (move toàn bộ stack)
 */

// Slot inventory PLAYER trong window đang mở (GUI có bất kỳ kích thước)
// guiSize = số slot của GUI (thường 54 cho double chest, 27 cho single, v.v.)
function getPlayerInventorySlotsInWindow(guiSize) {
  // Sau GUI slots: 27 ô inventory + 9 ô hotbar
  const invStart = guiSize;       // slot đầu inventory chính
  const hotbarStart = guiSize + 27; // slot đầu hotbar

  const slots = [];

  // Inventory chính (không phải hotbar)
  for (let i = invStart; i < invStart + 27; i++) {
    slots.push(i);
  }

  // Hotbar — BỎ QUA slot 0,1,2 (phím 1,2,3)
  for (let i = hotbarStart + 3; i < hotbarStart + 9; i++) {
    slots.push(i);
  }

  return slots;
}

// Lấy display name string từ item (customName là NBT object trong mineflayer)
function getItemDisplayName(item) {
  if (!item) return "";
  try {
    // customName là nbt object: { type: 'compound', value: { text: { value: '...' } } }
    // hoặc JSON string tùy version
    if (item.customName) {
      if (typeof item.customName === "string") {
        // Có thể là JSON text component
        try {
          const parsed = JSON.parse(item.customName);
          return (parsed.text || parsed.translate || JSON.stringify(parsed)).toLowerCase();
        } catch (_) {
          return item.customName.toLowerCase();
        }
      }
      // NBT object — thử lấy value đệ quy
      if (typeof item.customName === "object") {
        const str = JSON.stringify(item.customName);
        return str.toLowerCase();
      }
    }
    // displayName thường là plain string an toàn
    if (item.displayName && typeof item.displayName === "string") {
      return item.displayName.toLowerCase();
    }
    return (item.name || "").toLowerCase();
  } catch (_) {
    return (item.name || "").toLowerCase();
  }
}

// Tìm slot của nút Sell trong GUI
function findSellButtonSlot(window, guiSize) {
  // Ảnh GUI cho thấy: GUI 54 slot (6 hàng x 9), nút Sell ở slot 53 (góc dưới phải)
  // Thử slot cố định trước cho nhanh
  const PRIMARY_SELL_SLOTS = [53, 49, 44, 45, 40, 26, 8];
  for (const s of PRIMARY_SELL_SLOTS) {
    if (s >= guiSize) continue; // Chỉ xét slot trong GUI, không phải inventory player
    const item = window.slots[s];
    if (!item) continue;
    const name = getItemDisplayName(item);
    if (
      name.includes("sell") ||
      name.includes("bán") ||
      name.includes("click to sell") ||
      name.includes("confirm") ||
      name.includes("xác nhận") ||
      name.includes("lime") // lime_stained_glass_pane = nút xanh lá trong ảnh
    ) {
      log(`🔍 Tìm thấy nút Sell tại slot ${s}: "${item.name}" | name: "${name}"`);
      return s;
    }
  }

  // Fallback: scan toàn bộ GUI, tìm lime_stained_glass_pane hoặc keyword
  for (let i = 0; i < guiSize; i++) {
    const item = window.slots[i];
    if (!item) continue;
    const name = getItemDisplayName(item);
    const itemName = (item.name || "").toLowerCase();
    if (
      itemName.includes("lime_stained_glass") ||
      name.includes("sell") ||
      name.includes("click to sell") ||
      name.includes("6.9k") || name.includes("$")
    ) {
      log(`🔍 Scan tìm thấy nút Sell tại slot ${i}: "${item.name}"`);
      return i;
    }
  }

  // Hardcode slot 53 làm last resort (dựa trên ảnh GUI bạn cung cấp)
  log(`⚠️ Không scan được nút Sell — hardcode slot 53 (dựa trên ảnh GUI)`);
  return 53;
}

async function autoSell(currentBot) {
  if (autoSellRunning) {
    log("⚠️ AutoSell đang chạy rồi, bỏ qua");
    return;
  }
  autoSellRunning = true;
  log("🚀 AutoSell bắt đầu vòng lặp...");

  while (!isStoppedPermanently && bot === currentBot) {
    try {
      // ── 1. Chờ ngẫu nhiên 12-18 giây giữa các lần sell ──
      const waitMs = 12000 + Math.random() * 6000;
      log(`⏳ Chờ ${(waitMs / 1000).toFixed(1)}s trước lần sell tiếp theo...`);
      await sleep(waitMs);

      if (isStoppedPermanently || bot !== currentBot) break;

      // ── 2. Kiểm tra xem có item nào cần bán không (bỏ hotbar 0,1,2) ──
      const allItems = currentBot.inventory.items();
      // items() trả về items với slot theo inventory thường (slot 36-44 = hotbar)
      // Bỏ hotbar slot 36, 37, 38 (tương ứng phím 1, 2, 3)
      const itemsToSell = allItems.filter((item) => {
        // hotbar slot trong inventory window (không có GUI): 36,37,38,...,44
        if (item.slot === 36 || item.slot === 37 || item.slot === 38) return false;
        return true;
      });

      if (itemsToSell.length === 0) {
        log("📭 Không có item nào để bán (bỏ qua lần này)");
        continue;
      }

      log(`🎒 Có ${itemsToSell.length} loại item cần bán`);

      // ── 3. Gửi lệnh /sell ──
      log("💬 Gửi lệnh /sell...");
      currentBot.chat("/sell");

      // ── 4. Chờ GUI mở (tối đa 8 giây) ──
      let sellWindow;
      try {
        sellWindow = await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("GUI không mở sau 8s — server có thể không hỗ trợ /sell GUI")),
            8000
          );
          currentBot.once("windowOpen", (w) => {
            clearTimeout(timer);
            resolve(w);
          });
        });
      } catch (e) {
        log(`⚠️ ${e.message}`);
        log("💡 Thử fallback: /sell all");
        currentBot.chat("/sell all");
        await sleep(3000);
        continue;
      }

      log(`📦 GUI Sell mở! Kích thước: ${sellWindow.slots.length} slots`);
      await sleep(600); // Chờ GUI render xong

      const guiSize = sellWindow.slots.length - 36; // GUI slot count (tổng - 36 player slots)
      const playerSlots = getPlayerInventorySlotsInWindow(guiSize);

      log(`📋 Sẽ move item từ ${playerSlots.length} slot (bỏ hotbar 1,2,3)`);

      // ── 5. Shift+click từng item từ inventory vào GUI ──
      let moved = 0;
      for (const slotIndex of playerSlots) {
        if (isStoppedPermanently || bot !== currentBot) break;

        const item = sellWindow.slots[slotIndex];
        if (!item) continue;

        try {
          // mode=1 (shift-click) tự động move toàn bộ stack sang GUI
          await currentBot.clickWindow(slotIndex, 0, 1);
          log(`  ↳ Shift-click slot ${slotIndex}: ${item.name} x${item.count}`);
          moved++;
          await sleep(120 + Math.random() * 80); // Giả lập người thật
        } catch (e) {
          log(`  ⚠️ Lỗi click slot ${slotIndex} (${item.name}): ${e.message}`);
        }
      }

      log(`✅ Đã move ${moved} stack vào GUI`);
      await sleep(500);

      // ── 6. Tìm và click nút Sell ──
      // Refresh window sau khi move
      const currentWindow = currentBot.currentWindow;
      if (!currentWindow) {
        log("⚠️ GUI đã đóng trước khi kịp click Sell");
        continue;
      }

      const sellSlot = findSellButtonSlot(currentWindow, guiSize);
      if (sellSlot === null) {
        log("⚠️ Không tìm được nút Sell! Log tất cả slot của GUI để debug:");
        for (let i = 0; i < Math.min(currentWindow.slots.length, guiSize); i++) {
          const it = currentWindow.slots[i];
          if (it) log(`  Slot ${i}: ${it.name} | displayName: ${it.displayName || "?"}`);
        }
        currentBot.closeWindow(currentWindow);
        continue;
      }

      log(`🖱️ Click nút Sell tại slot ${sellSlot}...`);
      try {
        await currentBot.clickWindow(sellSlot, 0, 0);
      } catch (e) {
        log(`⚠️ Lỗi click nút Sell: ${e.message}`);
      }

      await sleep(1000);

      // ── 7. Đóng GUI ──
      try {
        if (currentBot.currentWindow) {
          currentBot.closeWindow(currentBot.currentWindow);
        }
      } catch (_) {}

      log("✅ AutoSell hoàn thành một chu kỳ!");
    } catch (e) {
      log(`❌ AutoSell lỗi nghiêm trọng: ${e.message}`);
      try {
        if (currentBot.currentWindow) currentBot.closeWindow(currentBot.currentWindow);
      } catch (_) {}
      await sleep(15000);
    }
  }

  autoSellRunning = false;
  log("🛑 AutoSell đã dừng");
}

// ==========================================
// TỰ ĐỘNG ĂN KHI ĐÓI
// ==========================================
async function eatFood(currentBot) {
  const foodItems = [
    "cooked_beef",
    "bread",
    "cooked_chicken",
    "cooked_porkchop",
    "golden_apple",
  ];
  for (const foodName of foodItems) {
    const itemDef = currentBot.registry?.itemsByName?.[foodName];
    if (!itemDef) continue;
    const item = currentBot.inventory?.findInventoryItem(itemDef.id);
    if (item) {
      try {
        await currentBot.equip(item, "hand");
        await currentBot.consume();
        log(`🍖 Đã ăn ${foodName}`);
        break;
      } catch (_) {}
    }
  }
}

// ==========================================
// TẠO BOT
// ==========================================
function createBot() {
  if (isStoppedPermanently) return;

  if (bot) {
    try { bot.removeAllListeners(); } catch (_) {}
    try { bot._client?.removeAllListeners(); } catch (_) {}
    bot = null;
  }
  autoSellRunning = false;
  clearBotIntervals();
  clearReconnectTimer();

  const version = getCurrentVersion();
  log(`🔄 Đang khởi tạo bot (version: ${version})...`);
  botData.status = "Connecting...";

  const config = { ...BASE_CONFIG, version };

  try {
    bot = mineflayer.createBot(config);
    setupBotEvents(bot);
  } catch (err) {
    log(`❌ Lỗi tạo bot: ${err.message}`);
    reconnectTimer = setTimeout(createBot, 30000);
  }
}

// ==========================================
// SETUP EVENTS
// ==========================================
function setupBotEvents(currentBot) {
  currentBot.loadPlugin(pathfinder);

  currentBot._client.on("connect", () => {
    log("🔌 TCP connected — đang handshake...");
  });

  // ---- LOGIN ----
  currentBot.on("login", () => {
    log(`✅ Bot ${currentBot.username} đã đăng nhập! (version: ${getCurrentVersion()})`);
    botData.username = currentBot.username;
    botData.status = "Online";
    consecutiveFails = 0;
    versionIndex = VERSIONS_TO_TRY.indexOf(getCurrentVersion());
    if (versionIndex < 0) versionIndex = 0;
  });

  // ---- SPAWN ----
  currentBot.once("spawn", () => {
    log("🎮 Bot đã xuất hiện trong thế giới!");
    currentBot.clearControlStates();

    // Chờ 20 giây sau spawn mới bắt đầu — server cần load đầy đủ
    setTimeout(() => {
      if (isStoppedPermanently || bot !== currentBot) return;

      log("🔁 Khởi động các tính năng nền...");

      // Anti-AFK: nhìn xung quanh
      const lookInterval = setInterval(() => {
        if (!isStoppedPermanently) humanLook();
      }, 20000 + Math.random() * 20000);
      botIntervals.push(lookInterval);

      // Anti-AFK: sneak
      const sneakInterval = setInterval(() => {
        if (!isStoppedPermanently) humanSneak();
      }, 60000 + Math.random() * 60000);
      botIntervals.push(sneakInterval);

      // Uptime counter
      let seconds = 0;
      const uptimeInterval = setInterval(() => {
        if (botData.status === "Online") {
          seconds++;
          const h = Math.floor(seconds / 3600);
          const m = Math.floor((seconds % 3600) / 60);
          const s = seconds % 60;
          botData.uptime = `${h}h ${m}m ${s}s`;
        }
      }, 1000);
      botIntervals.push(uptimeInterval);

      // Bắt đầu AutoSell
      autoSell(currentBot);

      log("✅ Bot đang chạy nền ổn định");
    }, 20000);
  });

  // ---- HEALTH ----
  currentBot.on("health", () => {
    if (!currentBot.entity) return;
    botData.health = Math.floor(currentBot.health ?? 0);
    botData.food = Math.floor(currentBot.food ?? 0);
    botData.position = [
      Math.floor(currentBot.entity.position.x),
      Math.floor(currentBot.entity.position.y),
      Math.floor(currentBot.entity.position.z),
    ].join(", ");
    if (currentBot.food <= 6) eatFood(currentBot);
  });

  // ---- MESSAGE: log chat server để debug GUI/sell ----
  currentBot.on("message", (jsonMsg) => {
    const msg = jsonMsg.toString();
    // Log tất cả message để dễ debug
    if (msg.trim()) log(`💬 Server: ${msg.substring(0, 150)}`);

    if (
      msg.toLowerCase().includes("kick") ||
      msg.toLowerCase().includes("banned")
    ) {
      botData.lastKickReason = msg.substring(0, 80);
    }
  });

  // ---- DEATH ----
  currentBot.on("death", () => {
    log("💀 Bot đã chết! Đang respawn...");
    try { currentBot.respawn(); } catch (_) {}
  });

  // ---- KICKED ----
  currentBot._client.on("kick_disconnect", (packet) => {
    let reason = "kick_disconnect";
    try {
      if (typeof packet.reason === "string") {
        try {
          const parsed = JSON.parse(packet.reason);
          reason = parsed.text || parsed.translate || packet.reason;
          if (parsed.extra) {
            reason += parsed.extra.map((e) => e.text || "").join("");
          }
        } catch (_) {
          reason = packet.reason;
        }
      } else if (packet.reason && typeof packet.reason === "object") {
        reason =
          packet.reason.text ||
          packet.reason.translate ||
          JSON.stringify(packet.reason);
      }
    } catch (_) {
      reason = String(packet.reason);
    }
    log(`🚫 Bị kick: ${reason.substring(0, 200)}`);
    botData.lastKickReason = reason.substring(0, 80);
  });

  // ---- END ----
  currentBot.on("end", (reason) => {
    const reasonStr = String(reason || "Không rõ");
    log(`🔴 Ngắt kết nối: ${reasonStr}`);
    botData.status = "Offline";
    if (!botData.lastKickReason || botData.lastKickReason === "N/A") {
      botData.lastKickReason = reasonStr.substring(0, 80);
    }
    botData.reconnects++;
    autoSellRunning = false;
    clearBotIntervals();
    if (isStoppedPermanently) return;
    const delay = getReconnectDelay(reasonStr);
    log(
      `⏳ Thử lại sau ${Math.round(delay / 1000)}s ` +
      `(fail liên tiếp: ${consecutiveFails})`
    );
    reconnectTimer = setTimeout(createBot, delay);
  });

  // ---- ERROR ----
  currentBot.on("error", (err) => {
    log(`⚠️ Lỗi: ${err.message}`);
  });
}

// ==========================================
// DASHBOARD (Socket.IO)
// ==========================================
io.on("connection", (socket) => {
  log("🟢 Dashboard đã kết nối");
  socket.emit("botData", botData);

  const interval = setInterval(() => socket.emit("botData", botData), 1000);

  socket.on("stopBot", () => {
    log("🛑 Lệnh DỪNG từ Dashboard");
    isStoppedPermanently = true;
    autoSellRunning = false;
    clearReconnectTimer();
    if (bot) {
      try { bot.end("Stopped by user"); } catch (_) {}
      bot = null;
    }
    clearBotIntervals();
    botData.status = "Stopped";
    socket.emit("botData", botData);
  });

  socket.on("startBot", () => {
    log("▶️ Lệnh KHỞI ĐỘNG từ Dashboard");
    isStoppedPermanently = false;
    consecutiveFails = 0;
    versionIndex = 0;
    createBot();
  });

  socket.on("disconnect", () => clearInterval(interval));
});

// ==========================================
// KHỞI CHẠY
// ==========================================
createBot();