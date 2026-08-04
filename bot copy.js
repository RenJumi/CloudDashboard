const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const Movements = require('mineflayer-pathfinder').Movements;

// ===== CẤU HÌNH DONUTSMP =====
const config = {
    host: 'donutsmp.net',
    port: 25565,
    username: 'kmloveyaie5E2N7@outlook.com', // THAY BẰNG EMAIL CỦA BẠN
    auth: 'microsoft',
    version: '1.21.11',
    disableChatSigning: true,
    checkTimeoutInterval: 120000,
    keepAlive: true,
    connectTimeout: 60000,
    profiles: {
        default: {
            client: {
                brand: 'vanilla'
            }
        }
    },
    hideErrors: false,
    logErrors: true,
    versionCheck: false,
    skipValidation: false
};

let bot = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;

// ===== HÀM KHỞI TẠO BOT =====
function createBot() {
    if (bot) {
        bot.removeAllListeners();
        bot = null;
    }
    
    console.log('🔄 Đang khởi tạo bot với xác thực Microsoft...');
    bot = mineflayer.createBot(config);
    setupBotEvents(bot);
    return bot;
}

// ===== HÀM THIẾT LẬP SỰ KIỆN =====
function setupBotEvents(bot) {
    // Load pathfinder
    bot.loadPlugin(pathfinder);
    
    // ===== SỰ KIỆN ĐĂNG NHẬP =====
    bot.on('login', () => {
        console.log(`✅ Bot ${bot.username} đã đăng nhập với tài khoản Microsoft!`);
        console.log(`🌐 Đang kết nối vào DonutSMP...`);
        reconnectAttempts = 0;
    });

    // ===== SỰ KIỆN XÁC THỰC =====
    bot.on('session', () => {
        console.log('🔑 Phiên xác thực Microsoft đã được thiết lập!');
    });

    // ===== SỰ KIỆN VÀO GAME (CHỈ MỘT LẦN DUY NHẤT) =====
    bot.once('spawn', () => {
        console.log('🎮 Bot đã xuất hiện trong DonutSMP!');
        
        // === BẮT ĐẦU HÀNH VI NGAY LẬP TỨC ===
        
        // 1. Di chuyển nhẹ ngay khi vào (quan trọng)
        setTimeout(() => {
            if (!bot || !bot.entity) return;
            bot.setControlState('forward', true);
            setTimeout(() => {
                if (!bot) return;
                bot.setControlState('forward', false);
                // Quay đầu
                try {
                    bot.look(Math.PI / 4, 0, true);
                } catch (err) {}
            }, 500);
        }, 1000);
        
        // 2. Nói chào sau 3 giây
        setTimeout(() => {
            if (bot && bot.chat) {
                bot.chat('Xin chào! Mình mới vào!');
            }
        }, 3000);
        
        // 3. Bắt đầu các hành vi định kỳ
        startSimulateBehavior();
    });

    // ===== HÀNH VI GIẢ LẬP =====
    function startSimulateBehavior() {
        // Di chuyển ngẫu nhiên mỗi 5-8 giây
        setInterval(() => {
            if (!bot || !bot.entity) return;
            try {
                const directions = ['forward', 'back', 'left', 'right'];
                const dir = directions[Math.floor(Math.random() * directions.length)];
                bot.setControlState(dir, true);
                setTimeout(() => {
                    if (!bot) return;
                    bot.setControlState(dir, false);
                }, 800 + Math.random() * 1200);
            } catch (err) {}
        }, 5000 + Math.random() * 3000);
        
        // Nhảy ngẫu nhiên mỗi 3-8 giây
        setInterval(() => {
            if (!bot) return;
            if (Math.random() > 0.5) {
                bot.setControlState('jump', true);
                setTimeout(() => {
                    if (bot) bot.setControlState('jump', false);
                }, 200);
            }
        }, 3000 + Math.random() * 5000);
        
        // Nói chuyện mỗi 20-40 giây
        setInterval(() => {
            if (bot && bot.chat) {
                const msgs = [
                    'Xin chào mọi người!',
                    'Chơi vui quá!',
                    'Có ai chơi cùng không?',
                    'Mình đang khám phá server!',
                    'Server đông vui nhỉ?'
                ];
                bot.chat(msgs[Math.floor(Math.random() * msgs.length)]);
            }
        }, 20000 + Math.random() * 20000);
    }

    // ===== XỬ LÝ TIN NHẮN =====
    bot.on('message', (message) => {
        try {
            const msg = message.toString();
            console.log(`💬 Server: ${msg}`);
            
            if (msg.toLowerCase().includes('bot') || 
                msg.toLowerCase().includes('are you real') ||
                msg.toLowerCase().includes('verify')) {
                setTimeout(() => {
                    if (bot && bot.chat) {
                        bot.chat('Mình là người thật mà!');
                    }
                }, 1000 + Math.random() * 1000);
            }
        } catch (err) {}
    });

    // ===== LẤY DỮ LIỆU SỨC KHỎE =====
    bot.on('health', () => {
        if (bot && bot.entity && bot.entity.position) {
            global.botData = {
                health: bot.health,
                food: bot.food,
                position: `${bot.entity.position.x.toFixed(2)}, ${bot.entity.position.y.toFixed(2)}, ${bot.entity.position.z.toFixed(2)}`
            };
        }
    });

    // ===== XỬ LÝ LỖI =====
    bot.on('error', (err) => {
        console.log(`❌ Lỗi bot: ${err.message}`);
        
        if (err.message && err.message.includes('Invalid username or password')) {
            console.log('🔑 Sai tài khoản hoặc mật khẩu! Vui lòng kiểm tra lại.');
            process.exit(1);
        }
        
        if (err.message && err.message.includes('encryption')) {
            console.log('🔐 Lỗi mã hóa xác thực. Đang thử lại...');
        }
    });

    // ===== XỬ LÝ NGẮT KẾT NỐI =====
    bot.on('end', (reason) => {
        console.log(`🔴 Bot ngắt kết nối. Lý do: ${reason || 'Không rõ'}`);
        
        if (reason && reason.includes('socketClosed')) {
            reconnectAttempts++;
            console.log(`🚫 Server đá bot (lần ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
            
            if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                const delay = reconnectAttempts * 15000;
                console.log(`🔄 Thử lại sau ${delay/1000} giây...`);
                setTimeout(createBot, delay);
            } else {
                console.log('❌ Đã thử quá nhiều lần. Dừng lại.');
            }
        } else if (reason && reason.includes('encryption')) {
            console.log('🔐 Lỗi mã hóa, thử lại sau 20 giây...');
            setTimeout(createBot, 20000);
        } else {
            console.log('🔄 Thử kết nối lại sau 15 giây...');
            setTimeout(createBot, 15000);
        }
    });
}

// ===== HÀM GỬI LỆNH CHAT =====
function sendChatCommand(command) {
    if (bot && bot.chat) {
        bot.chat(command);
        console.log(`📢 Bot gửi: ${command}`);
        return true;
    }
    return false;
}

// ===== KHỞI TẠO BOT =====
createBot();

module.exports = { bot, sendChatCommand };