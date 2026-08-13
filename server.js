const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const PORT = process.env.PORT || 3000;

// Configurable Company WhatsApp Number (Can be set via env var or admin dashboard)
let COMPANY_CONFIG = {
  botPhone: process.env.WHATSAPP_BOT_PHONE || '', // Set your real WhatsApp number with country code, e.g., '61412345678'
  companyName: 'SmartAttend Reception',
  kioskSecret: process.env.KIOSK_SECRET || 'kiosk_super_secret_key_8899'
};

// --- DATA STORE (In-Memory with persistent structure) ---
let DB = {
  users: [
    { id: 'usr-101', name: 'Alex Johnson', username: 'alex', phone: '+15550192834', department: 'Engineering', shiftStart: '09:00', status: 'OUT' },
    { id: 'usr-102', name: 'Sarah Miller', username: 'sarah', phone: '+15550183742', department: 'Design', shiftStart: '09:00', status: 'IN' }
  ],
  logs: [
    { id: 'log-001', userId: 'usr-102', userName: 'Sarah Miller', eventType: 'CHECK_IN', time: new Date(Date.now() - 4 * 3600 * 1000).toISOString(), method: 'WHATSAPP', isLate: false }
  ],
  usedTokens: new Set()
};

// --- TOTP / DYNAMIC 30s HMAC QR ENGINE ---
function generateTOTP(secret, timeWindowOffset = 0) {
  const timeStep = 30; // 30 seconds
  const currentEpoch = Math.floor(Date.now() / 1000);
  const timeWindow = Math.floor(currentEpoch / timeStep) + timeWindowOffset;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(timeWindow.toString());
  const hash = hmac.digest('hex');
  const code = hash.substring(0, 8).toUpperCase();
  const expiresAt = (timeWindow + 1) * timeStep;
  const secondsRemaining = expiresAt - currentEpoch;
  return { code, timeWindow, expiresAt, secondsRemaining };
}

function verifyTOTP(secret, inputCode) {
  const current = generateTOTP(secret, 0);
  const previous = generateTOTP(secret, -1);
  if (inputCode.toUpperCase() === current.code) return { valid: true, window: current.timeWindow };
  if (inputCode.toUpperCase() === previous.code) return { valid: true, window: previous.timeWindow };
  return { valid: false };
}

function calculateHoursForUser(userId) {
  const userLogs = DB.logs
    .filter(l => l.userId === userId)
    .sort((a, b) => new Date(a.time) - new Date(b.time));

  let totalMinutes = 0;
  let lastInTime = null;

  for (const log of userLogs) {
    if (log.eventType === 'CHECK_IN') {
      lastInTime = new Date(log.time);
    } else if (log.eventType === 'CHECK_OUT' && lastInTime) {
      const diffMs = new Date(log.time) - lastInTime;
      totalMinutes += Math.floor(diffMs / (1000 * 60));
      lastInTime = null;
    }
  }

  if (lastInTime) {
    totalMinutes += Math.floor((new Date() - lastInTime) / (1000 * 60));
  }

  const hours = (totalMinutes / 60).toFixed(1);
  return { minutes: totalMinutes, hours: `${hours} hrs` };
}

// --- HTTP SERVER ---
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- API ROUTING ---

  // 1. Kiosk Token & Bot Phone Configuration
  if (pathname === '/api/kiosk/token' && req.method === 'GET') {
    const totp = generateTOTP(COMPANY_CONFIG.kioskSecret);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      token: totp.code,
      secondsRemaining: totp.secondsRemaining,
      botPhone: COMPANY_CONFIG.botPhone || '61400000000', // Returns configured bot phone
      companyName: COMPANY_CONFIG.companyName
    }));
    return;
  }

  // 2. Set WhatsApp Bot Phone Number (From Admin UI)
  if (pathname === '/api/admin/config' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { botPhone, companyName } = JSON.parse(body);
        if (botPhone) COMPANY_CONFIG.botPhone = botPhone.replace(/[^0-9]/g, '');
        if (companyName) COMPANY_CONFIG.companyName = companyName;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, config: COMPANY_CONFIG }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid config' }));
      }
    });
    return;
  }

  // 3. Scan Attendance (Web Scan or Reverse Camera Scan)
  if (pathname === '/api/attendance/scan' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { userId, token, method = 'WEB_SCAN' } = data;

        let user = DB.users.find(u => u.id === userId || u.username === userId || u.phone === userId);
        if (!user) {
          // Auto-register guest if not found
          user = {
            id: `usr-${Date.now()}`,
            name: data.userName || `User ${userId}`,
            username: userId,
            phone: userId,
            department: 'General',
            shiftStart: '09:00',
            status: 'OUT'
          };
          DB.users.push(user);
        }

        if (method !== 'REVERSE_SCAN') {
          const verifyResult = verifyTOTP(COMPANY_CONFIG.kioskSecret, token);
          if (!verifyResult.valid) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'QR Code Expired. Please scan the current code.' }));
            return;
          }
        }

        const eventType = user.status === 'IN' ? 'CHECK_OUT' : 'CHECK_IN';
        user.status = eventType === 'CHECK_IN' ? 'IN' : 'OUT';

        const logEntry = {
          id: `log-${Date.now()}`,
          userId: user.id,
          userName: user.name,
          eventType,
          time: new Date().toISOString(),
          method,
          isLate: false
        };

        DB.logs.unshift(logEntry);
        const hoursData = calculateHoursForUser(user.id);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: `${eventType === 'CHECK_IN' ? '✅ Clocked In' : '🔴 Clocked Out'} Successfully!`,
          eventType,
          userName: user.name,
          time: logEntry.time,
          method,
          totalHours: hoursData.hours
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Server error' }));
      }
    });
    return;
  }

  // 4. WhatsApp Webhook (Meta Official Cloud API & Webhook Verification)
  if (pathname === '/api/whatsapp/webhook') {
    // Meta Webhook Verification (GET)
    if (req.method === 'GET') {
      const mode = parsedUrl.query['hub.mode'];
      const verifyToken = parsedUrl.query['hub.verify_token'];
      const challenge = parsedUrl.query['hub.challenge'];

      if (mode === 'subscribe' && verifyToken === (process.env.WHATSAPP_VERIFY_TOKEN || 'smartattend_verify_123')) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(challenge);
        return;
      }
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // Meta Webhook Inbound Message (POST)
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          let senderPhone = payload.senderPhone;
          let messageText = payload.messageText;

          // Parse Meta Cloud API standard JSON payload if received from real Meta
          if (payload.entry && payload.entry[0]?.changes[0]?.value?.messages) {
            const msg = payload.entry[0].changes[0].value.messages[0];
            senderPhone = msg.from;
            messageText = msg.text?.body || '';
          }

          if (!senderPhone || !messageText) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ignored' }));
            return;
          }

          let user = DB.users.find(u => u.phone === senderPhone || u.phone.includes(senderPhone) || senderPhone.includes(u.phone));
          if (!user) {
            user = {
              id: `usr-${Date.now()}`,
              name: `WhatsApp (${senderPhone})`,
              username: senderPhone,
              phone: senderPhone,
              department: 'General',
              shiftStart: '09:00',
              status: 'OUT'
            };
            DB.users.push(user);
          }

          const cleanToken = messageText.replace(/[^A-Za-z0-9]/g, '').toUpperCase().replace(/^IN/, '').replace(/^OUT/, '');
          const verifyResult = verifyTOTP(COMPANY_CONFIG.kioskSecret, cleanToken);

          if (!verifyResult.valid) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              replyMessage: '⚠️ Expired or Invalid QR Code. Please scan the current code on the kiosk screen.'
            }));
            return;
          }

          const eventType = user.status === 'IN' ? 'CHECK_OUT' : 'CHECK_IN';
          user.status = eventType === 'CHECK_IN' ? 'IN' : 'OUT';

          const logEntry = {
            id: `log-${Date.now()}`,
            userId: user.id,
            userName: user.name,
            eventType,
            time: new Date().toISOString(),
            method: 'WHATSAPP',
            isLate: false
          };

          DB.logs.unshift(logEntry);
          const hoursData = calculateHoursForUser(user.id);

          const replyMessage = eventType === 'CHECK_IN'
            ? `✅ *Attendance Recorded!*\nHi ${user.name}, you clocked IN at ${new Date().toLocaleTimeString()}.\nHave a productive day! 🚀`
            : `🔴 *Clocked Out!*\nHi ${user.name}, you clocked OUT at ${new Date().toLocaleTimeString()}.\nToday's Total: ${hoursData.hours}. See you tomorrow! 👋`;

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, replyMessage, logEntry }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        }
      });
      return;
    }
  }

  // 5. Admin Data
  if (pathname === '/api/admin/data' && req.method === 'GET') {
    const totalUsers = DB.users.length;
    const checkedInUsers = DB.users.filter(u => u.status === 'IN').length;
    const userSummary = DB.users.map(u => ({
      ...u,
      hours: calculateHoursForUser(u.id).hours
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      metrics: {
        totalEmployees: totalUsers,
        currentlyCheckedIn: checkedInUsers,
        currentlyCheckedOut: totalUsers - checkedInUsers,
        todayLateCount: DB.logs.filter(l => l.isLate).length
      },
      config: COMPANY_CONFIG,
      users: userSummary,
      logs: DB.logs.slice(0, 50)
    }));
    return;
  }

  // 6. User Management API
  if (pathname === '/api/admin/users' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { name, username, phone, department, shiftStart } = JSON.parse(body);
        const newUser = {
          id: `usr-${Date.now()}`,
          name,
          username: username || name.toLowerCase().replace(/\s+/g, ''),
          phone: phone.replace(/[^0-9+]/g, ''),
          department: department || 'General',
          shiftStart: shiftStart || '09:00',
          status: 'OUT'
        };
        DB.users.push(newUser);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, user: newUser }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Invalid payload' }));
      }
    });
    return;
  }

  // --- STATIC FILES ---
  let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  const extname = path.extname(filePath);
  let contentType = 'text/html';

  if (extname === '.js') contentType = 'text/javascript';
  if (extname === '.css') contentType = 'text/css';
  if (extname === '.json') contentType = 'application/json';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (error, defaultContent) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(defaultContent || '', 'utf-8');
      });
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
