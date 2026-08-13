const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const PORT = process.env.PORT || 3000;

let SYSTEM_CONFIG = {
  companyName: 'SmartAttend Reception',
  kioskSecret: process.env.KIOSK_SECRET || 'smartattend_kiosk_secret_2026'
};

let DB = {
  employees: [],
  logs: [],
  activationKeys: new Map(),
  usedTokens: new Set()
};

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

function calculateEmployeeTimesheets(userId) {
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
      if (isToday && !todayFirstIn) todayFirstIn = logTime;
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

  if (lastInTime) {
    const elapsedSec = Math.floor((now - lastInTime) / 1000);
    todaySeconds += elapsedSec;
    weeklySeconds += elapsedSec;
    monthlySeconds += elapsedSec;
  }

  return {
    todayFormatted: formatDuration(todaySeconds),
    todayFirstIn: todayFirstIn ? formatTimeWithSeconds(todayFirstIn) : '--',
    todayLastOut: todayLastOut ? formatTimeWithSeconds(todayLastOut) : (lastInTime ? 'Active (Open)' : '--'),
    weeklyFormatted: formatDuration(weeklySeconds),
    monthlyFormatted: formatDuration(monthlySeconds)
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

  // 1. Kiosk Dynamic Token Polling
  if (pathname === '/api/kiosk/token' && req.method === 'GET') {
    const totp = generateTOTP(SYSTEM_CONFIG.kioskSecret);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      token: totp.code,
      secondsRemaining: totp.secondsRemaining,
      companyName: SYSTEM_CONFIG.companyName
    }));
    return;
  }

  // 2. Generate / Register Device Activation Key
  if (pathname === '/api/devices/generate-activation' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { userId, userName, activationCode: clientCode } = JSON.parse(body);
        let emp = DB.employees.find(e => e.id === userId);
        if (!emp && userName) {
          emp = {
            id: userId,
            name: userName,
            phone: '',
            department: 'General',
            status: 'OUT',
            deviceToken: null
          };
          DB.employees.push(emp);
        }

        const activationCode = clientCode || `ACT-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        DB.activationKeys.set(activationCode, {
          userId: emp ? emp.id : userId,
          userName: emp ? emp.name : (userName || 'Employee'),
          expiresAt: Date.now() + 48 * 3600 * 1000
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          activationCode,
          userId: emp ? emp.id : userId,
          userName: emp ? emp.name : userName
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
    return;
  }

  // 3. Complete Device Binding
  if (pathname === '/api/devices/bind' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { activationCode, deviceToken, deviceName, userId: fallbackUserId, userName: fallbackUserName } = JSON.parse(body);
        const activation = DB.activationKeys.get(activationCode);

        let targetUserId = activation ? activation.userId : fallbackUserId;
        let targetUserName = activation ? activation.userName : fallbackUserName;

        let emp = DB.employees.find(e => e.id === targetUserId);
        if (!emp && targetUserId) {
          emp = {
            id: targetUserId,
            name: targetUserName || 'Employee',
            phone: '',
            department: 'General',
            status: 'OUT',
            deviceToken: null
          };
          DB.employees.push(emp);
        }

        if (emp) {
          emp.deviceToken = deviceToken;
          emp.deviceName = deviceName || 'Personal Phone';
          emp.boundAt = new Date().toISOString();
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: `Phone successfully locked to ${emp ? emp.name : 'Employee'}!`,
          employee: {
            id: emp ? emp.id : targetUserId,
            name: emp ? emp.name : targetUserName,
            department: emp ? emp.department : 'General'
          }
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Server error binding device' }));
      }
    });
    return;
  }

  // 4. Verify Bound Device & Load Employee Status
  if (pathname === '/api/devices/verify' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { deviceToken } = JSON.parse(body);
        const emp = DB.employees.find(e => e.deviceToken === deviceToken);

        if (!emp) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ bound: false, message: 'Unregistered Device' }));
          return;
        }

        const timesheet = calculateEmployeeTimesheets(emp.id);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          bound: true,
          employee: {
            id: emp.id,
            name: emp.name,
            department: emp.department,
            status: emp.status,
            todayFirstIn: timesheet.todayFirstIn,
            todayLastOut: timesheet.todayLastOut,
            hoursToday: timesheet.todayFormatted
          }
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ bound: false }));
      }
    });
    return;
  }

  // 5. Punch Attendance
  if (pathname === '/api/attendance/punch' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { deviceToken, kioskToken, forcedType, method = 'DEVICE_SCAN', userId: fallbackUserId, userName: fallbackName } = JSON.parse(body);

        let emp = DB.employees.find(e => e.deviceToken === deviceToken || e.id === fallbackUserId);
        if (!emp && (deviceToken || fallbackUserId)) {
          emp = {
            id: fallbackUserId || `emp-${Date.now()}`,
            name: fallbackName || 'Employee',
            phone: '',
            department: 'General',
            status: 'OUT',
            deviceToken: deviceToken || null
          };
          DB.employees.push(emp);
        }

        if (!emp) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Device not authorized' }));
          return;
        }

        if (method === 'DEVICE_SCAN') {
          const verifyResult = verifyTOTP(SYSTEM_CONFIG.kioskSecret, kioskToken);
          if (!verifyResult.valid) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'QR Code Expired. Please scan the current code on the kiosk monitor.' }));
            return;
          }
        }

        const eventType = forcedType || (emp.status === 'IN' ? 'CHECK_OUT' : 'CHECK_IN');
        emp.status = eventType === 'CHECK_IN' ? 'IN' : 'OUT';

        const now = new Date();
        const formattedTime = formatTimeWithSeconds(now);

        const logEntry = {
          id: `log-${Date.now()}`,
          userId: emp.id,
          userName: emp.name,
          eventType,
          time: now.toISOString(),
          formattedTime,
          dateStr: now.toISOString().split('T')[0],
          method
        };

        DB.logs.unshift(logEntry);
        const timesheet = calculateEmployeeTimesheets(emp.id);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: `${eventType === 'CHECK_IN' ? '✅ Clocked In' : '🔴 Clocked Out'} Successfully!`,
          eventType,
          userName: emp.name,
          time: formattedTime,
          totalHoursToday: timesheet.todayFormatted,
          clockIn: timesheet.todayFirstIn,
          clockOut: timesheet.todayLastOut
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Server error' }));
      }
    });
    return;
  }

  // 6. Admin Data
  if (pathname === '/api/admin/data' && req.method === 'GET') {
    const totalEmployees = DB.employees.length;
    const checkedInCount = DB.employees.filter(e => e.status === 'IN').length;
    const boundDevicesCount = DB.employees.filter(e => !!e.deviceToken).length;

    const employeesWithTimesheets = DB.employees.map(e => {
      const timesheet = calculateEmployeeTimesheets(e.id);
      return {
        ...e,
        clockIn: timesheet.todayFirstIn,
        clockOut: timesheet.todayLastOut,
        hoursToday: timesheet.todayFormatted,
        hoursWeekly: timesheet.weeklyFormatted,
        hoursMonthly: timesheet.monthlyFormatted,
        isDeviceBound: !!e.deviceToken
      };
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      metrics: {
        totalEmployees,
        currentlyCheckedIn: checkedInCount,
        currentlyCheckedOut: totalEmployees - checkedInCount,
        boundDevicesCount
      },
      employees: employeesWithTimesheets,
      logs: DB.logs.slice(0, 50),
      config: SYSTEM_CONFIG
    }));
    return;
  }

  // 7. Register Employee
  if (pathname === '/api/admin/employees' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { name, phone, department, id } = JSON.parse(body);
        const newEmp = {
          id: id || `emp-${Date.now()}`,
          name,
          phone: phone ? phone.replace(/[^0-9+]/g, '') : '',
          department: department || 'General',
          status: 'OUT',
          deviceToken: null
        };
        DB.employees.push(newEmp);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, employee: newEmp }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false }));
      }
    });
    return;
  }

  // 8. Delete / Unbind Device
  if (pathname === '/api/admin/employees/unbind' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { userId } = JSON.parse(body);
        const emp = DB.employees.find(e => e.id === userId);
        if (emp) {
          emp.deviceToken = null;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unbind error' }));
      }
    });
    return;
  }

  // 9. Sync Inbound Storage
  if (pathname === '/api/admin/sync' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { initialEmployees, initialLogs } = JSON.parse(body);
        if (Array.isArray(initialEmployees)) {
          // Merge employees
          initialEmployees.forEach(ie => {
            if (!DB.employees.find(e => e.id === ie.id)) {
              DB.employees.push(ie);
            }
          });
        }
        if (Array.isArray(initialLogs)) {
          initialLogs.forEach(il => {
            if (!DB.logs.find(l => l.id === il.id)) {
              DB.logs.push(il);
            }
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Sync error' }));
      }
    });
    return;
  }

  // Static Files
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
