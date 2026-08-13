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

// Clean unified store with enterprise roster support
let DB = {
  employees: [],
  logs: [],
  usedTokens: new Set()
};

// --- TOTP 30s HMAC ENGINE ---
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

function calculateEmployeeTimesheets(emp) {
  const userLogs = DB.logs
    .filter(l => l.userId === emp.id)
    .sort((a, b) => new Date(a.time) - new Date(b.time));

  const now = new Date();
  const todayStr = now.toDateString();

  let todaySeconds = 0;
  let weeklySeconds = 0;
  let monthlySeconds = 0;

  let todayFirstIn = null;
  let todayLastOut = null;
  let lastInTime = null;
  let isLateToday = false;
  let lateMinutes = 0;

  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  // Shift start calculation (e.g. "09:00")
  const shiftStartStr = emp.shiftStart || '09:00';
  const [shiftHours, shiftMins] = shiftStartStr.split(':').map(Number);

  for (const log of userLogs) {
    const logTime = new Date(log.time);
    const isToday = logTime.toDateString() === todayStr;
    const isThisWeek = logTime >= oneWeekAgo;
    const isThisMonth = logTime.getMonth() === currentMonth && logTime.getFullYear() === currentYear;

    if (log.eventType === 'CHECK_IN') {
      lastInTime = logTime;
      if (isToday && !todayFirstIn) {
        todayFirstIn = logTime;
        // Check if arrived after shift start (grace period 5 mins)
        const scheduledTime = new Date(logTime);
        scheduledTime.setHours(shiftHours, shiftMins + 5, 0, 0);
        if (logTime > scheduledTime) {
          isLateToday = true;
          lateMinutes = Math.max(1, Math.round((logTime - scheduledTime) / 60000));
        }
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

  // If currently clocked in, add ongoing elapsed time
  if (lastInTime) {
    const elapsedSec = Math.floor((now - lastInTime) / 1000);
    todaySeconds += elapsedSec;
    weeklySeconds += elapsedSec;
    monthlySeconds += elapsedSec;
  }

  // Overtime Calculation: Compare with Target Daily Hours (Default 8.0 or 4.0 for PT)
  const targetSeconds = (emp.targetDailyHours || (emp.employmentType === 'PART_TIME' ? 4 : 8)) * 3600;
  const regularSeconds = Math.min(todaySeconds, targetSeconds);
  const overtimeSeconds = Math.max(0, todaySeconds - targetSeconds);

  return {
    todayFormatted: formatDuration(todaySeconds),
    regularFormatted: formatDuration(regularSeconds),
    overtimeFormatted: formatDuration(overtimeSeconds),
    hasOvertime: overtimeSeconds > 0,
    todayFirstIn: todayFirstIn ? formatTimeWithSeconds(todayFirstIn) : '--',
    todayLastOut: todayLastOut ? formatTimeWithSeconds(todayLastOut) : (lastInTime ? 'Active (Open)' : '--'),
    weeklyFormatted: formatDuration(weeklySeconds),
    monthlyFormatted: formatDuration(monthlySeconds),
    isLateToday,
    lateMinutes,
    rawSecondsToday: todaySeconds
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

  // 2. Complete Device Binding
  if (pathname === '/api/devices/bind' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { userId, userName, deviceToken, deviceName } = JSON.parse(body);

        let emp = DB.employees.find(e => e.id === userId);
        if (!emp) {
          emp = {
            id: userId || `emp-${Date.now()}`,
            name: userName || 'Employee',
            phone: '',
            department: 'General',
            employmentType: 'FULL_TIME',
            targetDailyHours: 8,
            shiftStart: '09:00',
            shiftEnd: '17:00',
            status: 'OUT',
            deviceToken: deviceToken,
            deviceName: deviceName || 'Personal Phone',
            boundAt: new Date().toISOString()
          };
          DB.employees.push(emp);
        } else {
          emp.deviceToken = deviceToken;
          emp.deviceName = deviceName || 'Personal Phone';
          emp.boundAt = new Date().toISOString();
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: `Phone successfully locked to ${emp.name}!`,
          employee: {
            id: emp.id,
            name: emp.name,
            department: emp.department
          }
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Server error binding device' }));
      }
    });
    return;
  }

  // 3. Verify Bound Device & Load Employee Status
  if (pathname === '/api/devices/verify' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { deviceToken, fallbackUserId, fallbackUserName } = JSON.parse(body);

        let emp = DB.employees.find(e => e.deviceToken === deviceToken || (fallbackUserId && e.id === fallbackUserId));
        if (!emp && fallbackUserId && fallbackUserName) {
          emp = {
            id: fallbackUserId,
            name: fallbackUserName,
            phone: '',
            department: 'General',
            employmentType: 'FULL_TIME',
            targetDailyHours: 8,
            shiftStart: '09:00',
            shiftEnd: '17:00',
            status: 'OUT',
            deviceToken: deviceToken
          };
          DB.employees.push(emp);
        }

        if (!emp || !emp.deviceToken) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ bound: false, message: 'Unregistered Device' }));
          return;
        }

        const timesheet = calculateEmployeeTimesheets(emp);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          bound: true,
          employee: {
            id: emp.id,
            name: emp.name,
            department: emp.department,
            employmentType: emp.employmentType || 'FULL_TIME',
            targetHours: emp.targetDailyHours || 8,
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

  // 4. Punch Attendance
  if (pathname === '/api/attendance/punch' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { deviceToken, kioskToken, forcedType, method = 'DEVICE_SCAN', userId: fallbackUserId, userName: fallbackName } = JSON.parse(body);

        let emp = DB.employees.find(e => (deviceToken && e.deviceToken === deviceToken) || (fallbackUserId && e.id === fallbackUserId));
        if (!emp && (fallbackUserId || deviceToken)) {
          emp = {
            id: fallbackUserId || `emp-${Date.now()}`,
            name: fallbackName || 'Employee',
            phone: '',
            department: 'General',
            employmentType: 'FULL_TIME',
            targetDailyHours: 8,
            shiftStart: '09:00',
            shiftEnd: '17:00',
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

        // Verify Kiosk 30s TOTP Token
        if (method === 'DEVICE_SCAN') {
          const verifyResult = verifyTOTP(SYSTEM_CONFIG.kioskSecret, kioskToken);
          if (!verifyResult.valid) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'QR Code Expired. Please scan the current code on the kiosk screen.' }));
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
        const timesheet = calculateEmployeeTimesheets(emp);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: `${eventType === 'CHECK_IN' ? '✅ Clocked In' : '🔴 Clocked Out'} Successfully!`,
          eventType,
          userName: emp.name,
          time: formattedTime,
          totalHoursToday: timesheet.todayFormatted,
          clockIn: timesheet.todayFirstIn,
          clockOut: timesheet.todayLastOut,
          employee: emp,
          logEntry
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Server error processing punch' }));
      }
    });
    return;
  }

  // 5. Admin Data API
  if (pathname === '/api/admin/data' && req.method === 'GET') {
    const totalEmployees = DB.employees.length;
    const checkedInCount = DB.employees.filter(e => e.status === 'IN').length;
    const boundDevicesCount = DB.employees.filter(e => !!e.deviceToken).length;
    let lateArrivalsCount = 0;
    let overtimeStaffCount = 0;

    const employeesWithTimesheets = DB.employees.map(e => {
      const timesheet = calculateEmployeeTimesheets(e);
      if (timesheet.isLateToday) lateArrivalsCount++;
      if (timesheet.hasOvertime) overtimeStaffCount++;

      return {
        ...e,
        employmentType: e.employmentType || 'FULL_TIME',
        targetDailyHours: e.targetDailyHours || (e.employmentType === 'PART_TIME' ? 4 : 8),
        shiftStart: e.shiftStart || '09:00',
        shiftEnd: e.shiftEnd || '17:00',
        clockIn: timesheet.todayFirstIn,
        clockOut: timesheet.todayLastOut,
        hoursToday: timesheet.todayFormatted,
        regularHours: timesheet.regularFormatted,
        overtimeHours: timesheet.overtimeFormatted,
        hasOvertime: timesheet.hasOvertime,
        hoursWeekly: timesheet.weeklyFormatted,
        hoursMonthly: timesheet.monthlyFormatted,
        isLateToday: timesheet.isLateToday,
        lateMinutes: timesheet.lateMinutes,
        isDeviceBound: !!e.deviceToken
      };
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      metrics: {
        totalEmployees,
        currentlyCheckedIn: checkedInCount,
        currentlyCheckedOut: totalEmployees - checkedInCount,
        boundDevicesCount,
        lateArrivalsCount,
        overtimeStaffCount
      },
      employees: employeesWithTimesheets,
      logs: DB.logs.slice(0, 100),
      config: SYSTEM_CONFIG
    }));
    return;
  }

  // 6. Register Employee with Roster Settings
  if (pathname === '/api/admin/employees' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { name, phone, department, employmentType, targetDailyHours, shiftStart, shiftEnd, id } = JSON.parse(body);
        const empType = employmentType || 'FULL_TIME';
        const targetHours = parseFloat(targetDailyHours) || (empType === 'PART_TIME' ? 4 : 8);

        const newEmp = {
          id: id || `emp-${Date.now()}`,
          name,
          phone: phone ? phone.replace(/[^0-9+]/g, '') : '',
          department: department || 'General',
          employmentType: empType,
          targetDailyHours: targetHours,
          shiftStart: shiftStart || '09:00',
          shiftEnd: shiftEnd || (empType === 'PART_TIME' ? '13:00' : '17:00'),
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

  // 7. Update Employee Roster & Details
  if (pathname === '/api/admin/employees/update' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { id, name, phone, department, employmentType, targetDailyHours, shiftStart, shiftEnd } = JSON.parse(body);
        const emp = DB.employees.find(e => e.id === id);
        if (!emp) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Employee not found' }));
          return;
        }

        if (name) emp.name = name;
        if (phone !== undefined) emp.phone = phone.replace(/[^0-9+]/g, '');
        if (department) emp.department = department;
        if (employmentType) emp.employmentType = employmentType;
        if (targetDailyHours !== undefined) emp.targetDailyHours = parseFloat(targetDailyHours);
        if (shiftStart) emp.shiftStart = shiftStart;
        if (shiftEnd) emp.shiftEnd = shiftEnd;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, employee: emp }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Update error' }));
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

  // 9. Delete Employee API
  if (pathname === '/api/admin/employees/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { userId } = JSON.parse(body);
        DB.employees = DB.employees.filter(e => e.id !== userId);
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

  // 10. Sync Inbound Storage
  if (pathname === '/api/admin/sync' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { initialEmployees, initialLogs } = JSON.parse(body);
        if (Array.isArray(initialEmployees)) {
          initialEmployees.forEach(ie => {
            const existing = DB.employees.find(e => e.id === ie.id);
            if (!existing) {
              DB.employees.push(ie);
            } else {
              if (ie.deviceToken && !existing.deviceToken) existing.deviceToken = ie.deviceToken;
              if (ie.employmentType) existing.employmentType = ie.employmentType;
              if (ie.targetDailyHours) existing.targetDailyHours = ie.targetDailyHours;
              if (ie.shiftStart) existing.shiftStart = ie.shiftStart;
              if (ie.shiftEnd) existing.shiftEnd = ie.shiftEnd;
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
  console.log(`SmartAttend Server running on port ${PORT}`);
});
