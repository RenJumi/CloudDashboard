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
// DonutSMP dùng Velocity proxy — chấp nhận mọi version 1.20+
// Thử lần lượt các version nếu bị reject
// ==========================================
const VERSIONS_TO_TRY = ["1.21.4", "1.21.1", "1.20.4", "1.20.1"];
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

  if (r.includes("socketclosed") || r.includes("econnreset") || r.includes("etimedout")) {
    // socketClosed ngay lập tức → thử version khác
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
  if (r.includes("disconnect.quitting") || r.includes("stopped by user")) {
    return 3000;
  }

  return delay;
}

// ==========================================
// HELPERS
// ==========================================
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

function occasionalWalk() {
  if (!bot?.entity || isStoppedPermanently) return;
  try {
    const movements = new Movements(bot);
    movements.canDig = false;
    movements.allow1by1towers = false;
    bot.pathfinder.setMovements(movements);

    const angle = Math.random() * Math.PI * 2;
    const dist = 1 + Math.random() * 2;
    const tx = Math.floor(bot.entity.position.x + Math.cos(angle) * dist);
    const tz = Math.floor(bot.entity.position.z + Math.sin(angle) * dist);
    const ty = Math.floor(bot.entity.position.y);

    bot.pathfinder.setGoal(new GoalBlock(tx, ty, tz));

    setTimeout(() => {
      if (bot) {
        bot.pathfinder.setGoal(null);
        bot.clearControlStates();
      }
    }, 1500 + Math.random() * 1500);
  } catch (_) {}
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
// Mineflayer tự xử lý: keep_alive, teleport_confirm, position
// TUYỆT ĐỐI không gửi lại các packet này
// ==========================================
function setupBotEvents(currentBot) {
  currentBot.loadPlugin(pathfinder);

  // ---- DEBUG: theo dõi kết nối TCP ----
  currentBot._client.on("connect", () => {
    log("🔌 TCP connected — đang handshake...");
  });

  // ---- LOGIN ----
  currentBot.on("login", () => {
    log(`✅ Bot ${currentBot.username} đã đăng nhập! (version: ${getCurrentVersion()})`);
    botData.username = currentBot.username;
    botData.status = "Online";
    consecutiveFails = 0;
    // Reset về version đầu vì version này hoạt động
    versionIndex = VERSIONS_TO_TRY.indexOf(getCurrentVersion());
    if (versionIndex < 0) versionIndex = 0;
  });

  // ---- SPAWN ----
  currentBot.once("spawn", () => {
    log("🎮 Bot đã xuất hiện trong thế giới!");
    currentBot.clearControlStates();

    // Đợi 35s trước khi bật anti-afk
    setTimeout(() => {
      if (isStoppedPermanently || !bot) return;
      log("⏱️ Bắt đầu các hành vi nền...");

      // Look mỗi 20-40s
      const lookInterval = setInterval(() => {
        if (!isStoppedPermanently) humanLook();
      }, 20000 + Math.random() * 20000);
      botIntervals.push(lookInterval);

      // Sneak mỗi 60-120s
      const sneakInterval = setInterval(() => {
        if (!isStoppedPermanently) humanSneak();
      }, 60000 + Math.random() * 60000);
      botIntervals.push(sneakInterval);

      // Walk 1-2 block mỗi 90-150s (60% xác suất)
      const walkInterval = setInterval(() => {
        if (!isStoppedPermanently && Math.random() > 0.4) occasionalWalk();
      }, 90000 + Math.random() * 60000);
      botIntervals.push(walkInterval);

      // Uptime
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

      log("✅ Bot đang chạy nền ổn định");
    }, 35000);
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

  // ---- MESSAGE ----
  currentBot.on("message", (jsonMsg) => {
    const msg = jsonMsg.toString();
    if (
      msg.toLowerCase().includes("kick") ||
      msg.toLowerCase().includes("banned")
    ) {
      log(`⚠️ Server message: ${msg}`);
      botData.lastKickReason = msg.substring(0, 80);
    }
  });

  // ---- DEATH ----
  currentBot.on("death", () => {
    log("💀 Bot đã chết! Đang respawn...");
    try { currentBot.respawn(); } catch (_) {}
  });

  // ---- KICKED: log lý do chi tiết trước khi END fire ----
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
    clearBotIntervals();
    if (isStoppedPermanently) return;
    const delay = getReconnectDelay(reasonStr);
    log(
      `⏳ Thử lại sau ${Math.round(delay / 1000)}s ` +
      `(fail liên tiếp: ${consecutiveFails}, next version: ${getCurrentVersion()})`
    );
    reconnectTimer = setTimeout(createBot, delay);
  });

  // ---- ERROR ----
  currentBot.on("error", (err) => {
    log(`⚠️ Lỗi: ${err.message}`);
  });
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
// DASHBOARD (Socket.IO)
// ==========================================
io.on("connection", (socket) => {
  log("🟢 Dashboard đã kết nối");
  socket.emit("botData", botData);

  const interval = setInterval(() => socket.emit("botData", botData), 1000);

  socket.on("stopBot", () => {
    log("🛑 Lệnh DỪNG từ Dashboard");
    isStoppedPermanently = true;
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