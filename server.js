const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const PORT = process.env.PORT || 3000;

// --- IN-MEMORY DATABASE & CONFIG ---
const DB = {
  tenants: [
    { id: 'tenant-001', name: 'Acme Corp SaaS' }
  ],
  kiosks: [
    { id: 'kiosk-001', tenantId: 'tenant-001', name: 'Main Reception Screen', secret: 'kiosk_super_secret_key_8899', isActive: true }
  ],
  users: [
    { id: 'usr-101', tenantId: 'tenant-001', name: 'Alex Johnson', username: 'alex', phone: '+15550192834', department: 'Engineering', shiftStart: '09:00', status: 'OUT' },
    { id: 'usr-102', tenantId: 'tenant-001', name: 'Sarah Miller', username: 'sarah', phone: '+15550183742', department: 'Design', shiftStart: '09:00', status: 'IN' },
    { id: 'usr-103', tenantId: 'tenant-001', name: 'David Chen', username: 'david', phone: '+15550172635', department: 'Operations', shiftStart: '09:30', status: 'OUT' },
    { id: 'usr-104', tenantId: 'tenant-001', name: 'Emma Watson', username: 'emma', phone: '+15550163524', department: 'Marketing', shiftStart: '09:00', status: 'IN' },
    { id: 'usr-105', tenantId: 'tenant-001', name: 'Michael Brown', username: 'michael', phone: '+15550154321', department: 'Sales', shiftStart: '08:30', status: 'OUT' }
  ],
  // Seed initial attendance logs for demo/dashboard
  logs: [
    { id: 'log-001', tenantId: 'tenant-001', userId: 'usr-102', userName: 'Sarah Miller', kioskId: 'kiosk-001', eventType: 'CHECK_IN', time: new Date(Date.now() - 4 * 3600 * 1000).toISOString(), method: 'WHATSAPP', isLate: false },
    { id: 'log-002', tenantId: 'tenant-001', userId: 'usr-104', userName: 'Emma Watson', kioskId: 'kiosk-001', eventType: 'CHECK_IN', time: new Date(Date.now() - 3.5 * 3600 * 1000).toISOString(), method: 'WEB_SCAN', isLate: true },
    { id: 'log-003', tenantId: 'tenant-001', userId: 'usr-101', userName: 'Alex Johnson', kioskId: 'kiosk-001', eventType: 'CHECK_IN', time: new Date(Date.now() - 8 * 3600 * 1000).toISOString(), method: 'REVERSE_SCAN', isLate: false },
    { id: 'log-004', tenantId: 'tenant-001', userId: 'usr-101', userName: 'Alex Johnson', kioskId: 'kiosk-001', eventType: 'CHECK_OUT', time: new Date(Date.now() - 0.5 * 3600 * 1000).toISOString(), method: 'REVERSE_SCAN', isLate: false }
  ],
  usedTokens: new Set() // Replay prevention cache
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
  // Check current window and -1 window (grace for network latency)
  const current = generateTOTP(secret, 0);
  const previous = generateTOTP(secret, -1);
  if (inputCode.toUpperCase() === current.code) return { valid: true, window: current.timeWindow };
  if (inputCode.toUpperCase() === previous.code) return { valid: true, window: previous.timeWindow };
  return { valid: false };
}

// --- HOURS CALCULATOR HELPER ---
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
      const outTime = new Date(log.time);
      const diffMs = outTime - lastInTime;
      totalMinutes += Math.floor(diffMs / (1000 * 60));
      lastInTime = null;
    }
  }

  // If currently checked in, add ongoing elapsed time
  if (lastInTime) {
    const now = new Date();
    totalMinutes += Math.floor((now - lastInTime) / (1000 * 60));
  }

  const hours = (totalMinutes / 60).toFixed(1);
  return { minutes: totalMinutes, hours: `${hours} hrs` };
}

// --- HTTP REQUEST HANDLER ---
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- API ENDPOINTS ---

  // 1. Get Dynamic Kiosk Token (For Kiosk Display)
  if (pathname === '/api/kiosk/token' && req.method === 'GET') {
    const kioskId = parsedUrl.query.kiosk_id || 'kiosk-001';
    const kiosk = DB.kiosks.find(k => k.id === kioskId);
    if (!kiosk) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Kiosk not found' }));
      return;
    }

    const totp = generateTOTP(kiosk.secret);
    const qrPayload = JSON.stringify({
      tenantId: kiosk.tenantId,
      kioskId: kiosk.id,
      token: totp.code,
      ts: Date.now()
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      kioskId: kiosk.id,
      kioskName: kiosk.name,
      token: totp.code,
      qrPayload,
      secondsRemaining: totp.secondsRemaining,
      expiresAt: totp.expiresAt
    }));
    return;
  }

  // 2. Process Scan (Web Scan or Reverse Scan)
  if (pathname === '/api/attendance/scan' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { userId, token, method, kioskId = 'kiosk-001', forcedEventType } = data;

        const user = DB.users.find(u => u.id === userId || u.username === userId || u.phone === userId);
        if (!user) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Invalid user or employee ID' }));
          return;
        }

        const kiosk = DB.kiosks.find(k => k.id === kioskId);
        if (!kiosk) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Invalid kiosk' }));
          return;
        }

        // Validate Token unless method is REVERSE_SCAN
        if (method !== 'REVERSE_SCAN') {
          const verifyResult = verifyTOTP(kiosk.secret, token);
          if (!verifyResult.valid) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'QR Code Expired or Invalid! Please scan the latest code.' }));
            return;
          }

          // Anti-replay check
          const tokenKey = `${kioskId}_${token}_${verifyResult.window}`;
          if (DB.usedTokens.has(tokenKey)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Token already used! Please wait for next QR.' }));
            return;
          }
          DB.usedTokens.add(tokenKey);
        }

        // Toggle Event Type (CHECK_IN vs CHECK_OUT)
        const eventType = forcedEventType || (user.status === 'IN' ? 'CHECK_OUT' : 'CHECK_IN');
        user.status = eventType === 'CHECK_IN' ? 'IN' : 'OUT';

        // Check Late Entry (Shift start e.g. 09:00 AM)
        const now = new Date();
        const currentHoursMinutes = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const isLate = eventType === 'CHECK_IN' && currentHoursMinutes > user.shiftStart;

        const logEntry = {
          id: `log-${Date.now()}`,
          tenantId: user.tenantId,
          userId: user.id,
          userName: user.name,
          kioskId: kiosk.id,
          eventType,
          time: now.toISOString(),
          method: method || 'WEB_SCAN',
          isLate
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
          method: logEntry.method,
          isLate,
          totalHours: hoursData.hours
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Server error parsing request' }));
      }
    });
    return;
  }

  // 3. WhatsApp Cloud API Webhook Simulation
  if (pathname === '/api/whatsapp/webhook' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { senderPhone, messageText } = data; // e.g. "IN-A8F3K1" or "OUT-A8F3K1"

        const user = DB.users.find(u => u.phone === senderPhone);
        if (!user) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            replyMessage: '❌ Phone number not registered in attendance system. Please contact HR.'
          }));
          return;
        }

        const parts = messageText.trim().split('-');
        const token = parts[1] || parts[0];
        const kiosk = DB.kiosks[0];

        const verifyResult = verifyTOTP(kiosk.secret, token);
        if (!verifyResult.valid) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            replyMessage: '⚠️ Expired or Invalid QR token. Please scan the current code displayed at reception.'
          }));
          return;
        }

        const eventType = user.status === 'IN' ? 'CHECK_OUT' : 'CHECK_IN';
        user.status = eventType === 'CHECK_IN' ? 'IN' : 'OUT';

        const logEntry = {
          id: `log-${Date.now()}`,
          tenantId: user.tenantId,
          userId: user.id,
          userName: user.name,
          kioskId: kiosk.id,
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
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid webhook payload' }));
      }
    });
    return;
  }

  // 4. Admin Dashboard Metrics & Logs API
  if (pathname === '/api/admin/data' && req.method === 'GET') {
    const totalUsers = DB.users.length;
    const checkedInUsers = DB.users.filter(u => u.status === 'IN').length;
    const checkedOutUsers = totalUsers - checkedInUsers;
    const todayLateCount = DB.logs.filter(l => l.isLate && new Date(l.time).toDateString() === new Date().toDateString()).length;

    // Enhance users with computed hours
    const userSummary = DB.users.map(u => ({
      ...u,
      hours: calculateHoursForUser(u.id).hours
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      metrics: {
        totalEmployees: totalUsers,
        currentlyCheckedIn: checkedInUsers,
        currentlyCheckedOut: checkedOutUsers,
        todayLateCount,
        activeKiosks: DB.kiosks.length
      },
      users: userSummary,
      logs: DB.logs.slice(0, 50),
      kiosks: DB.kiosks
    }));
    return;
  }

  // 5. User Management API (Add new user)
  if (pathname === '/api/admin/users' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { name, username, phone, department, shiftStart } = JSON.parse(body);
        const newUser = {
          id: `usr-${Date.now()}`,
          tenantId: 'tenant-001',
          name,
          username,
          phone,
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

  // --- STATIC FILE SERVER ---
  let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  const extname = path.extname(filePath);
  let contentType = 'text/html';

  if (extname === '.js') contentType = 'text/javascript';
  if (extname === '.css') contentType = 'text/css';
  if (extname === '.json') contentType = 'application/json';
  if (extname === '.png') contentType = 'image/png';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        fs.readFile(path.join(__dirname, 'public', 'index.html'), (error, defaultContent) => {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(defaultContent, 'utf-8');
        });
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, () => {
  console.log(`Attendance SaaS Server running on http://localhost:${PORT}`);
});
