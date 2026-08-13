const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const PORT = process.env.PORT || 3000;

// Configurable Company Settings
let COMPANY_CONFIG = {
  botPhone: process.env.WHATSAPP_BOT_PHONE || '',
  companyName: 'SmartAttend Reception',
  kioskSecret: process.env.KIOSK_SECRET || 'smartattend_kiosk_secret_2026'
};

// CLEAN DATABASE (No demo accounts)
let DB = {
  users: [],
  logs: [],
  usedTokens: new Set()
};

// TOTP 30s HMAC Engine
function generateTOTP(secret, timeWindowOffset = 0) {
  const timeStep = 30;
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

function formatTimeWithSeconds(dateObj) {
  return dateObj.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
}

function formatDuration(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

function calculateDetailedHours(userId) {
  const userLogs = DB.logs
    .filter(l => l.userId === userId)
    .sort((a, b) => new Date(a.time) - new Date(b.time));

  const now = new Date();
  const todayStr = now.toDateString();

  let todaySeconds = 0;
  let weeklySeconds = 0;
  let monthlySeconds = 0;

  let todayFirstIn = null;
  let todayLastOut = null;
  let lastInTime = null;

  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  for (const log of userLogs) {
    const logTime = new Date(log.time);
    const isToday = logTime.toDateString() === todayStr;
    const isThisWeek = logTime >= oneWeekAgo;
    const isThisMonth = logTime.getMonth() === currentMonth && logTime.getFullYear() === currentYear;

    if (log.eventType === 'CHECK_IN') {
      lastInTime = logTime;
      if (isToday && !todayFirstIn) {
        todayFirstIn = logTime;
      }
    } else if (log.eventType === 'CHECK_OUT' && lastInTime) {
      const diffSec = Math.floor((logTime - lastInTime) / 1000);
      if (isToday) {
        todaySeconds += diffSec;
        todayLastOut = logTime;
      }
      if (isThisWeek) weeklySeconds += diffSec;
      if (isThisMonth) monthlySeconds += diffSec;
      lastInTime = null;
    }
  }

  // If currently checked in, add ongoing elapsed time
  if (lastInTime) {
    const elapsedSec = Math.floor((now - lastInTime) / 1000);
    todaySeconds += elapsedSec;
    weeklySeconds += elapsedSec;
    monthlySeconds += elapsedSec;
  }

  return {
    todaySeconds,
    todayFormatted: formatDuration(todaySeconds),
    todayFirstIn: todayFirstIn ? formatTimeWithSeconds(todayFirstIn) : '--',
    todayLastOut: todayLastOut ? formatTimeWithSeconds(todayLastOut) : (lastInTime ? 'Active (Open)' : '--'),
    weeklyFormatted: formatDuration(weeklySeconds),
    monthlyFormatted: formatDuration(monthlySeconds),
    rawHours: (todaySeconds / 3600).toFixed(1) + ' hrs'
  };
}

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

  // 1. Kiosk Token
  if (pathname === '/api/kiosk/token' && req.method === 'GET') {
    const totp = generateTOTP(COMPANY_CONFIG.kioskSecret);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      token: totp.code,
      secondsRemaining: totp.secondsRemaining,
      botPhone: COMPANY_CONFIG.botPhone,
      companyName: COMPANY_CONFIG.companyName
    }));
    return;
  }

  // 2. Set Config
  if (pathname === '/api/admin/config' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { botPhone, companyName, initialUsers, initialLogs } = JSON.parse(body);
        if (botPhone) COMPANY_CONFIG.botPhone = botPhone.replace(/[^0-9]/g, '');
        if (companyName) COMPANY_CONFIG.companyName = companyName;

        // Allow syncing local persistent data to server
        if (Array.isArray(initialUsers) && DB.users.length === 0) {
          DB.users = initialUsers;
        }
        if (Array.isArray(initialLogs) && DB.logs.length === 0) {
          DB.logs = initialLogs;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, config: COMPANY_CONFIG }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid payload' }));
      }
    });
    return;
  }

  // 3. Scan & Attendance Processing
  if (pathname === '/api/attendance/scan' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { userId, token, method = 'WEB_SCAN', forcedType } = data;

        let user = DB.users.find(u => u.id === userId || u.phone === userId);
        if (!user) {
          user = {
            id: `usr-${Date.now()}`,
            name: data.userName || `User (${userId})`,
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

        const eventType = forcedType || (user.status === 'IN' ? 'CHECK_OUT' : 'CHECK_IN');
        user.status = eventType === 'CHECK_IN' ? 'IN' : 'OUT';

        const now = new Date();
        const logEntry = {
          id: `log-${Date.now()}`,
          userId: user.id,
          userName: user.name,
          eventType,
          time: now.toISOString(),
          formattedTime: formatTimeWithSeconds(now),
          method,
          isLate: false
        };

        DB.logs.unshift(logEntry);
        const hoursData = calculateDetailedHours(user.id);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: `${eventType === 'CHECK_IN' ? '✅ Clocked In' : '🔴 Clocked Out'} Successfully!`,
          eventType,
          userName: user.name,
          time: logEntry.formattedTime,
          totalHoursToday: hoursData.todayFormatted,
          clockIn: hoursData.todayFirstIn,
          clockOut: hoursData.todayLastOut
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Server error' }));
      }
    });
    return;
  }

  // 4. WhatsApp Webhook (Meta Inbound Message & Response)
  if (pathname === '/api/whatsapp/webhook') {
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

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          let senderPhone = payload.senderPhone;
          let messageText = payload.messageText;

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
              name: `Employee (${senderPhone})`,
              phone: senderPhone,
              department: 'General',
              shiftStart: '09:00',
              status: 'OUT'
            };
            DB.users.push(user);
          }

          // Clean token
          const cleanToken = messageText.replace(/[^A-Za-z0-9]/g, '').toUpperCase().replace(/^IN/, '').replace(/^OUT/, '');
          const verifyResult = verifyTOTP(COMPANY_CONFIG.kioskSecret, cleanToken);

          if (!verifyResult.valid) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              replyMessage: '⚠️ Expired or Invalid QR Code. Please scan the latest code on the kiosk monitor.'
            }));
            return;
          }

          const eventType = user.status === 'IN' ? 'CHECK_OUT' : 'CHECK_IN';
          user.status = eventType === 'CHECK_IN' ? 'IN' : 'OUT';

          const now = new Date();
          const timestampFormatted = formatTimeWithSeconds(now);
          const dateFormatted = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });

          const logEntry = {
            id: `log-${Date.now()}`,
            userId: user.id,
            userName: user.name,
            eventType,
            time: now.toISOString(),
            formattedTime: timestampFormatted,
            method: 'WHATSAPP',
            isLate: false
          };

          DB.logs.unshift(logEntry);
          const hoursData = calculateDetailedHours(user.id);

          // Professional Detailed WhatsApp Message
          const replyMessage = eventType === 'CHECK_IN'
            ? `✅ *CLOCK-IN RECORDED*\n━━━━━━━━━━━━━━━━━━━━━\n👤 *Employee:* ${user.name}\n⏰ *Time:* ${timestampFormatted}\n📅 *Date:* ${dateFormatted}\n🏢 *Status:* Checked IN (Shift Active)\n━━━━━━━━━━━━━━━━━━━━━\nHave a great shift! 🚀`
            : `🔴 *CLOCK-OUT RECORDED*\n━━━━━━━━━━━━━━━━━━━━━\n👤 *Employee:* ${user.name}\n⏰ *Clock-In:* ${hoursData.todayFirstIn}\n⏰ *Clock-Out:* ${timestampFormatted}\n⏱️ *Today's Duration:* ${hoursData.todayFormatted}\n📅 *Date:* ${dateFormatted}\n━━━━━━━━━━━━━━━━━━━━━\nSee you next shift! 👋`;

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, replyMessage, logEntry, user }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        }
      });
      return;
    }
  }

  // 5. Admin Data (With Detailed Timesheet Breakdown per User)
  if (pathname === '/api/admin/data' && req.method === 'GET') {
    const totalUsers = DB.users.length;
    const checkedInUsers = DB.users.filter(u => u.status === 'IN').length;

    const userSummary = DB.users.map(u => {
      const detailed = calculateDetailedHours(u.id);
      return {
        ...u,
        clockIn: detailed.todayFirstIn,
        clockOut: detailed.todayLastOut,
        hoursToday: detailed.todayFormatted,
        hoursWeekly: detailed.weeklyFormatted,
        hoursMonthly: detailed.monthlyFormatted
      };
    });

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
        const { name, phone, department } = JSON.parse(body);
        const newUser = {
          id: `usr-${Date.now()}`,
          name,
          phone: phone.replace(/[^0-9+]/g, ''),
          department: department || 'General',
          shiftStart: '09:00',
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

  // 7. Delete User API
  if (pathname === '/api/admin/users/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { userId } = JSON.parse(body);
        DB.users = DB.users.filter(u => u.id !== userId);
        DB.logs = DB.logs.filter(l => l.userId !== userId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Delete error' }));
      }
    });
    return;
  }

  // Static File Serving
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
