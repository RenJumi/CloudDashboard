// test-proxy.js
const { SocksProxyAgent } = require('socks-proxy-agent');
const fetch = require('node-fetch');

const agent = new SocksProxyAgent('socks5://42.1.99.56:7969');

async function testProxy() {
    try {
        const response = await fetch('https://api.ipify.org?format=json', { agent });
        const data = await response.json();
        console.log('✅ Proxy hoạt động! IP:', data.ip);
    } catch (error) {
        console.log('❌ Proxy không hoạt động:', error.message);
    }
}

testProxy();