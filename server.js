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
// AUTOSELL - CHIẾN THUẬT HYBRID (SPEED 2s)
// ==========================================

// Lấy danh sách slot của Player Inventory trong GUI (Dựa trên Donut GUI 54 slot)
function getPlayerSlotsForDonut() {
    const slots = [];
    // Inventory chính (27 slot)
    for (let i = 54; i < 81; i++) slots.push(i);
    // Hotbar (Bỏ qua 3 slot đầu: 81, 82, 83)
    for (let i = 84; i < 90; i++) slots.push(i);
    return slots;
}

// Hàm tìm nút bán (Vẫn giữ logic scan)
function findSellButton(window, maxGuiSlots) {
    if (maxGuiSlots > 53) {
        const item53 = window.slots[53];
        if (item53 && (item53.name?.includes("lime") || item53.displayName?.toLowerCase().includes("sell"))) {
            return 53;
        }
    }
    for (let i = maxGuiSlots - 1; i >= 0; i--) {
        const item = window.slots[i];
        if (item) {
            const name = (item.displayName || item.name || "").toLowerCase();
            if (name.includes("sell") || name.includes("bán") || name.includes("lime")) {
                return i;
            }
        }
    }
    return maxGuiSlots - 1;
}

async function autoSell(currentBot) {
  if (autoSellRunning) return;
  autoSellRunning = true;
  log("🚀 AutoSell Hybrid (Speed 2s) bắt đầu...");

  while (!isStoppedPermanently && bot === currentBot) {
    try {
      // ── 1. DELAY 2.0s - 2.5s (Tốc độ 2 giây) ──
      const waitMs = 2000 + Math.random() * 500; 
      log(`⏳ Chờ ${(waitMs / 1000).toFixed(1)}s (Speed 2s)`);
      await sleep(waitMs);

      if (isStoppedPermanently || bot !== currentBot) break;

      // Kiểm tra đồ
      const itemsToSell = currentBot.inventory.items().filter((item) => {
        return item.slot !== 36 && item.slot !== 37 && item.slot !== 38;
      });

      if (itemsToSell.length === 0) continue;
      log(`🎒 Có ${itemsToSell.length} stack cần bán`);

      // Gửi lệnh
      currentBot.chat("/sell");

      // Chờ GUI mở (Tối đa 3 giây, nếu nhanh thì càng tốt)
      let sellWindow;
      try {
        sellWindow = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Timeout GUI")), 3000);
          currentBot.once("windowOpen", (w) => { clearTimeout(timer); resolve(w); });
        });
      } catch (e) {
        currentBot.chat("/sell all");
        await sleep(1000);
        continue;
      }

      // Rút ngắn thời gian chờ render xuống 100ms (Thay vì 200ms)
      await sleep(100); 

      // Lấy danh sách slot của Player 
      const playerSlots = getPlayerSlotsForDonut();
      
      // Shift-click từng slot (Cực nhanh)
      let moved = 0;
      for (const slotIndex of playerSlots) {
        if (isStoppedPermanently || bot !== currentBot) break;

        const item = sellWindow.slots[slotIndex];
        if (!item) continue; 

        try {
          await currentBot.clickWindow(slotIndex, 0, 1);
          moved++;
          // GIẢM DELAY CLICK xuống 15ms - 25ms
          await sleep(15 + Math.random() * 10); 
        } catch (e) {}
      }

      if (moved === 0) {
          log("⚠️ Không move được stack nào, đóng GUI và thử lại...");
          try { if (currentBot.currentWindow) currentBot.closeWindow(currentBot.currentWindow); } catch (_) {}
          continue;
      }

      log(`✅ Đã move ${moved}/${itemsToSell.length} stack vào GUI`);

      // Tìm và bấm nút bán
      const sellSlot = findSellButton(sellWindow, 54);
      log(`🖱️ Click nút Sell tại slot ${sellSlot}`);
      
      try {
        await currentBot.clickWindow(sellSlot, 0, 0);
        await sleep(400); // Chờ server xác nhận tiền
      } catch (e) {
        log(`⚠️ Lỗi click nút Sell: ${e.message}`);
      }

      // Đóng GUI
      try {
        if (currentBot.currentWindow) currentBot.closeWindow(currentBot.currentWindow);
      } catch (_) {}

      log(`✅ Hoàn thành! ${moved} stack đã được bán.`);

    } catch (e) {
      log(`❌ AutoSell lỗi: ${e.message}`);
      try { if (currentBot.currentWindow) currentBot.closeWindow(currentBot.currentWindow); } catch (_) {}
      await sleep(2000);
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