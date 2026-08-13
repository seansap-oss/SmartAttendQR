// --- GLOBAL STATE & PERSISTENCE ---
let currentActiveTab = 'kiosk';
let kioskQRCodeObj = null;
let badgeQRCodeObj = null;
let currentKioskToken = '';
let kioskTimerInterval = null;
let liveClockInterval = null;
let punchMode = 'AUTO'; // 'AUTO', 'IN', 'OUT'

// LocalStorage Persistent Stores
let localUsers = JSON.parse(localStorage.getItem('smartattend_users') || '[]');
let localLogs = JSON.parse(localStorage.getItem('smartattend_logs') || '[]');
let configuredBotPhone = localStorage.getItem('smartattend_bot_phone') || '';

// --- INIT APP ---
document.addEventListener('DOMContentLoaded', () => {
  initLiveClock();
  initKioskLoop();
  syncLocalDataToServer();
  fetchAdminData();
  setInterval(fetchAdminData, 4000);

  // Sync initial bot phone input
  if (configuredBotPhone) {
    const input = document.getElementById('kiosk-bot-phone-input');
    if (input) input.value = configuredBotPhone;
    const badge = document.getElementById('active-bot-badge');
    if (badge) badge.textContent = `+${configuredBotPhone}`;
    const kpiBot = document.getElementById('kpi-bot-status');
    if (kpiBot) kpiBot.textContent = `+${configuredBotPhone}`;
  }
});

// --- TOAST NOTIFICATIONS ---
function showToast(title, message, isError = false) {
  const toast = document.getElementById('toast-notification');
  const icon = document.getElementById('toast-icon');
  const tTitle = document.getElementById('toast-title');
  const tMsg = document.getElementById('toast-message');

  tTitle.textContent = title;
  tMsg.textContent = message;

  if (isError) {
    icon.className = "w-9 h-9 rounded-xl bg-rose-500/20 text-rose-400 flex items-center justify-center text-lg";
    icon.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i>';
    toast.className = "fixed top-5 right-5 z-50 transform translate-y-0 opacity-100 bg-slate-900 border border-rose-500/50 shadow-2xl rounded-2xl p-4 flex items-center space-x-3 max-w-sm pointer-events-auto transition-all";
  } else {
    icon.className = "w-9 h-9 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-lg";
    icon.innerHTML = '<i class="fa-solid fa-check"></i>';
    toast.className = "fixed top-5 right-5 z-50 transform translate-y-0 opacity-100 bg-slate-900 border border-emerald-500/50 shadow-2xl rounded-2xl p-4 flex items-center space-x-3 max-w-sm pointer-events-auto transition-all";
  }

  setTimeout(() => {
    toast.className = "fixed top-5 right-5 z-50 transform translate-y-[-150%] opacity-0 bg-slate-900 border border-emerald-500/50 shadow-2xl rounded-2xl p-4 flex items-center space-x-3 max-w-sm pointer-events-none transition-all";
  }, 3500);
}

// --- TAB SWITCHER ---
function switchTab(tabName) {
  currentActiveTab = tabName;
  ['kiosk', 'dashboard', 'mobile', 'badge'].forEach(t => {
    const viewEl = document.getElementById(`view-${t}`);
    const tabBtn = document.getElementById(`tab-${t}`);
    if (t === tabName) {
      viewEl.classList.remove('hidden');
      tabBtn.className = "px-3 py-1.5 text-xs sm:text-sm font-semibold rounded-lg transition-all flex items-center space-x-2 text-emerald-400 bg-slate-800 shadow-sm border border-emerald-500/30";
    } else {
      viewEl.classList.add('hidden');
      tabBtn.className = "px-3 py-1.5 text-xs sm:text-sm font-medium text-slate-400 hover:text-white rounded-lg transition-all flex items-center space-x-2";
    }
  });

  if (tabName === 'badge') {
    populateBadgeSelect();
    renderEmployeeBadge();
  }
}

function setPunchMode(mode) {
  punchMode = mode;
  ['AUTO', 'IN', 'OUT'].forEach(m => {
    const btn = document.getElementById(`btn-mode-${m.toLowerCase()}`);
    if (m === mode) {
      btn.className = "px-3 py-1 text-xs font-bold rounded-lg text-emerald-400 bg-slate-800 border border-emerald-500/30";
    } else {
      btn.className = "px-3 py-1 text-xs font-medium text-slate-400 hover:text-white rounded-lg";
    }
  });
  updateKioskToken();
}

// --- SYNC LOCAL STORAGE TO SERVER ---
async function syncLocalDataToServer() {
  if (localUsers.length > 0 || configuredBotPhone) {
    try {
      await fetch('/api/admin/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          botPhone: configuredBotPhone,
          initialUsers: localUsers,
          initialLogs: localLogs
        })
      });
    } catch (e) {
      console.warn("Could not sync local cache to server", e);
    }
  }
}

// --- CLOCK & KIOSK TOTP LOOP ---
function initLiveClock() {
  updateClock();
  liveClockInterval = setInterval(updateClock, 1000);
}

function updateClock() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour12: true });
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' });
  const clockEl = document.getElementById('live-clock');
  const dateEl = document.getElementById('live-date');
  if (clockEl) clockEl.textContent = timeStr;
  if (dateEl) dateEl.textContent = dateStr;
}

function initKioskLoop() {
  updateKioskToken();
  kioskTimerInterval = setInterval(updateKioskToken, 1000);
}

async function updateKioskToken() {
  try {
    const res = await fetch('/api/kiosk/token');
    const data = await res.json();

    currentKioskToken = data.token;
    if (data.botPhone && !configuredBotPhone) {
      configuredBotPhone = data.botPhone;
      localStorage.setItem('smartattend_bot_phone', configuredBotPhone);
    }

    document.getElementById('kiosk-token-code').textContent = data.token;
    document.getElementById('kiosk-seconds').textContent = `${data.secondsRemaining}s`;

    const percent = (data.secondsRemaining / 30) * 100;
    document.getElementById('kiosk-timer-bar').style.width = `${percent}%`;

    // Render QR Code pointing to WhatsApp
    const qrContainer = document.getElementById('kiosk-qrcode');
    if (qrContainer) {
      const activeBotNumber = configuredBotPhone || data.botPhone || '61400000000';
      const cleanPhone = activeBotNumber.replace(/[^0-9]/g, '');

      // Mode prefix
      const modePrefix = punchMode === 'IN' ? 'IN' : punchMode === 'OUT' ? 'OUT' : 'ATTEND';
      const qrTargetUrl = `https://wa.me/${cleanPhone}?text=${modePrefix}-${data.token}`;

      if (!kioskQRCodeObj) {
        qrContainer.innerHTML = '';
        kioskQRCodeObj = new QRCode(qrContainer, {
          text: qrTargetUrl,
          width: 210,
          height: 210,
          colorDark : "#020617",
          colorLight : "#ffffff",
          correctLevel : QRCode.CorrectLevel.H
        });
      } else if (data.secondsRemaining === 30 || data.secondsRemaining === 29) {
        kioskQRCodeObj.clear();
        kioskQRCodeObj.makeCode(qrTargetUrl);
      }
    }
  } catch (e) {
    console.error("Error updating kiosk token", e);
  }
}

// --- SAVE WHATSAPP BOT PHONE NUMBER ---
async function saveBotPhoneSetting(source = 'kiosk') {
  const input = document.getElementById('kiosk-bot-phone-input');
  const phone = input.value.trim().replace(/[^0-9]/g, '');

  if (!phone || phone.length < 7) {
    showToast('Invalid Phone', 'Please enter a valid WhatsApp phone number with country code (e.g. 61412345678)', true);
    return;
  }

  configuredBotPhone = phone;
  localStorage.setItem('smartattend_bot_phone', phone);

  document.getElementById('active-bot-badge').textContent = `+${phone}`;
  document.getElementById('kpi-bot-status').textContent = `+${phone}`;

  await fetch('/api/admin/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ botPhone: phone })
  });

  if (kioskQRCodeObj) {
    kioskQRCodeObj = null; // Recreate QR with new number
  }
  updateKioskToken();
  showToast('Number Saved!', `WhatsApp Business Number updated to +${phone}. Scans will now open your chat.`);
}

// --- FETCH ADMIN DATA & UPDATE TABLE ---
async function fetchAdminData() {
  try {
    const res = await fetch('/api/admin/data');
    const data = await res.json();

    // Merge server users with local persistent store if server restarted
    if (data.users && data.users.length > 0) {
      localUsers = data.users;
      localStorage.setItem('smartattend_users', JSON.stringify(localUsers));
    }
    if (data.logs && data.logs.length > 0) {
      localLogs = data.logs;
      localStorage.setItem('smartattend_logs', JSON.stringify(localLogs));
    }

    const displayUsers = data.users && data.users.length > 0 ? data.users : localUsers;
    const displayLogs = data.logs && data.logs.length > 0 ? data.logs : localLogs;

    // Update KPIs
    const checkedInCount = displayUsers.filter(u => u.status === 'IN').length;
    document.getElementById('kpi-total-emp').textContent = displayUsers.length;
    document.getElementById('kpi-checked-in').textContent = checkedInCount;
    document.getElementById('kpi-checked-out').textContent = displayUsers.length - checkedInCount;

    if (configuredBotPhone) {
      document.getElementById('kpi-bot-status').textContent = `+${configuredBotPhone}`;
    }

    // Render Tables & Feeds
    renderAdminRoster(displayUsers);
    renderAdminLogs(displayLogs);
    renderKioskTicker(displayLogs);
    populateSimUserSelect(displayUsers);
    populateManualUserSelect(displayUsers);
  } catch (e) {
    console.error("Error fetching admin data", e);
  }
}

function renderAdminRoster(users) {
  const tbody = document.getElementById('admin-user-tbody');
  if (!tbody) return;

  if (users.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="px-4 py-8 text-center text-xs text-slate-500">
          No employees registered yet. Click <strong class="text-emerald-400">"Register Employee"</strong> above to add your first team member.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = users.map(u => {
    const isIn = u.status === 'IN';
    const clockInVal = u.clockIn || '--';
    const clockOutVal = u.clockOut || (isIn ? '<span class="text-emerald-400 font-semibold animate-pulse">Active (Open)</span>' : '--');
    const hoursVal = u.hoursToday || '0h 0m 0s';

    return `
      <tr class="hover:bg-slate-800/40 transition cursor-pointer" onclick="openTimesheetModal('${u.id}')">
        <td class="px-4 py-3.5 font-medium text-white flex items-center space-x-3">
          <div class="w-8 h-8 rounded-xl bg-slate-800 text-slate-300 border border-slate-700 flex items-center justify-center font-bold text-xs">
            ${u.name.charAt(0)}
          </div>
          <div>
            <div class="font-bold text-slate-100">${u.name}</div>
            <div class="text-[11px] text-slate-400 font-mono">+${u.phone.replace(/[^0-9]/g, '')}</div>
          </div>
        </td>
        <td class="px-4 py-3.5 text-slate-300">${u.department || 'General'}</td>
        <td class="px-4 py-3.5">
          <span class="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold ${isIn ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-slate-800 text-slate-400'}">
            <span class="w-1.5 h-1.5 rounded-full ${isIn ? 'bg-emerald-400 mr-1.5 pulse-green' : 'bg-slate-500 mr-1.5'}"></span>
            ${isIn ? 'Checked In' : 'Checked Out'}
          </span>
        </td>
        <td class="px-4 py-3.5 font-mono text-xs text-slate-300">${clockInVal}</td>
        <td class="px-4 py-3.5 font-mono text-xs text-slate-300">${clockOutVal}</td>
        <td class="px-4 py-3.5 font-mono font-bold text-xs text-emerald-400">${hoursVal}</td>
        <td class="px-4 py-3.5 text-right space-x-2" onclick="event.stopPropagation()">
          <button onclick="openTimesheetModal('${u.id}')" class="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-semibold rounded-lg border border-slate-700">
            <i class="fa-solid fa-chart-simple text-blue-400 mr-1"></i> Timesheet
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function renderAdminLogs(logs) {
  const container = document.getElementById('admin-logs-list');
  if (!container) return;

  if (logs.length === 0) {
    container.innerHTML = `<div class="text-xs text-slate-500 py-3 text-center">No attendance logs yet</div>`;
    return;
  }

  container.innerHTML = logs.map(l => {
    const isIn = l.eventType === 'CHECK_IN';
    const timeFormatted = l.formattedTime || new Date(l.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

    return `
      <div class="p-3 bg-slate-950/70 rounded-xl border border-slate-800/80 flex items-center justify-between text-xs">
        <div class="flex items-center space-x-2.5">
          <div class="w-2 h-2 rounded-full ${isIn ? 'bg-emerald-400' : 'bg-rose-400'}"></div>
          <div>
            <span class="font-bold text-slate-200">${l.userName}</span>
            <span class="text-slate-500 text-[11px] ml-2 font-mono">${timeFormatted}</span>
          </div>
        </div>
        <div>
          <span class="px-2 py-0.5 rounded text-[10px] font-bold ${isIn ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-300'}">
            ${l.eventType === 'CHECK_IN' ? 'CLOCK IN' : 'CLOCK OUT'}
          </span>
        </div>
      </div>
    `;
  }).join('');
}

function renderKioskTicker(logs) {
  const tickerList = document.getElementById('kiosk-ticker-list');
  if (!tickerList) return;

  const recentLogs = logs.slice(0, 5);
  if (recentLogs.length === 0) {
    tickerList.innerHTML = `<div class="text-xs text-slate-500 py-4 text-center">Waiting for first scan...</div>`;
    return;
  }

  tickerList.innerHTML = recentLogs.map(log => {
    const isIn = log.eventType === 'CHECK_IN';
    const timeFormatted = log.formattedTime || new Date(log.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

    return `
      <div class="bg-slate-950/80 p-3.5 rounded-2xl border border-slate-800 flex items-center justify-between shadow">
        <div class="flex items-center space-x-3">
          <div class="w-9 h-9 rounded-xl ${isIn ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'} flex items-center justify-center font-bold text-sm">
            <i class="fa-solid ${isIn ? 'fa-arrow-right-to-bracket' : 'fa-arrow-right-from-bracket'}"></i>
          </div>
          <div>
            <div class="text-sm font-bold text-white">${log.userName}</div>
            <div class="text-[10px] text-emerald-400 flex items-center gap-1 mt-0.5">
              <i class="fa-brands fa-whatsapp"></i> WhatsApp Verified
            </div>
          </div>
        </div>
        <div class="text-right">
          <div class="text-xs font-bold ${isIn ? 'text-emerald-400' : 'text-slate-400'}">${isIn ? 'CLOCK IN' : 'CLOCK OUT'}</div>
          <div class="text-[11px] text-slate-400 font-mono">${timeFormatted}</div>
        </div>
      </div>
    `;
  }).join('');
}

// --- EMPLOYEE TIMESHEET DETAIL MODAL ---
function openTimesheetModal(userId) {
  const user = localUsers.find(u => u.id === userId);
  if (!user) return;

  document.getElementById('detail-name').textContent = user.name;
  document.getElementById('detail-phone').textContent = `+${user.phone.replace(/[^0-9]/g, '')} • ${user.department || 'General'}`;
  document.getElementById('detail-avatar').textContent = user.name.charAt(0);

  document.getElementById('detail-today-hours').textContent = user.hoursToday || '0h 0m 0s';
  document.getElementById('detail-weekly-hours').textContent = user.hoursWeekly || '0h 0m 0s';
  document.getElementById('detail-monthly-hours').textContent = user.hoursMonthly || '0h 0m 0s';

  // Render Punch History
  const historyContainer = document.getElementById('detail-punch-history');
  const userPunches = localLogs.filter(l => l.userId === userId);

  if (userPunches.length === 0) {
    historyContainer.innerHTML = `<div class="text-xs text-slate-500 py-3 text-center">No punch history recorded yet</div>`;
  } else {
    historyContainer.innerHTML = userPunches.map(p => {
      const isIn = p.eventType === 'CHECK_IN';
      const timeStr = p.formattedTime || new Date(p.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
      const dateStr = new Date(p.time).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

      return `
        <div class="p-2.5 bg-slate-950 rounded-xl border border-slate-800 flex items-center justify-between text-xs font-mono">
          <div class="flex items-center space-x-2">
            <span class="w-2 h-2 rounded-full ${isIn ? 'bg-emerald-400' : 'bg-rose-400'}"></span>
            <span class="text-slate-200 font-bold">${isIn ? 'CLOCK IN' : 'CLOCK OUT'}</span>
            <span class="text-slate-500">(${dateStr})</span>
          </div>
          <div class="text-emerald-400 font-bold">${timeStr}</div>
        </div>
      `;
    }).join('');
  }

  // Set Delete button action
  const deleteBtn = document.getElementById('detail-delete-btn');
  deleteBtn.onclick = () => deleteEmployee(userId, user.name);

  document.getElementById('timesheet-modal').classList.remove('hidden');
}

function closeTimesheetModal() {
  document.getElementById('timesheet-modal').classList.add('hidden');
}

async function deleteEmployee(userId, userName) {
  if (!confirm(`Are you sure you want to delete employee "${userName}"?`)) return;

  localUsers = localUsers.filter(u => u.id !== userId);
  localLogs = localLogs.filter(l => l.userId !== userId);
  localStorage.setItem('smartattend_users', JSON.stringify(localUsers));
  localStorage.setItem('smartattend_logs', JSON.stringify(localLogs));

  await fetch('/api/admin/users/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId })
  });

  closeTimesheetModal();
  fetchAdminData();
  showToast('Employee Deleted', `"${userName}" has been removed.`);
}

// --- ADD USER FORM (BUG FIX: Reset & Validation) ---
function openAddUserModal() {
  document.getElementById('add-user-modal').classList.remove('hidden');
}

function closeAddUserModal() {
  document.getElementById('add-user-modal').classList.add('hidden');
}

async function handleAddUserSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('new-name').value.trim();
  const phone = document.getElementById('new-phone').value.trim().replace(/[^0-9+]/g, '');
  const department = document.getElementById('new-dept').value.trim();

  if (!name || !phone) {
    showToast('Missing Fields', 'Please provide a name and WhatsApp phone number', true);
    return;
  }

  const newUser = {
    id: `usr-${Date.now()}`,
    name,
    phone,
    department: department || 'General',
    status: 'OUT',
    clockIn: '--',
    clockOut: '--',
    hoursToday: '0h 0m 0s'
  };

  localUsers.push(newUser);
  localStorage.setItem('smartattend_users', JSON.stringify(localUsers));

  try {
    await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, department })
    });
  } catch (err) {}

  const form = document.getElementById('add-user-form');
  if (form) form.reset();
  closeAddUserModal();

  fetchAdminData();
  showToast('Employee Registered', `"${name}" (+${phone}) registered successfully.`);
}

// --- MANUAL PUNCH MODAL ---
function openManualPunchModal() {
  populateManualUserSelect(localUsers);
  document.getElementById('manual-punch-modal').classList.remove('hidden');
}

function closeManualPunchModal() {
  document.getElementById('manual-punch-modal').classList.add('hidden');
}

function populateManualUserSelect(users) {
  const select = document.getElementById('manual-user-select');
  if (!select) return;
  if (users.length === 0) {
    select.innerHTML = '<option value="">No registered employees</option>';
    return;
  }
  select.innerHTML = users.map(u => `
    <option value="${u.id}">${u.name} (+${u.phone})</option>
  `).join('');
}

async function handleManualPunchSubmit(e) {
  e.preventDefault();
  const userId = document.getElementById('manual-user-select').value;
  const forcedType = document.querySelector('input[name="manual-type"]:checked').value;

  if (!userId) {
    showToast('Error', 'Please select an employee', true);
    return;
  }

  const user = localUsers.find(u => u.id === userId);
  const now = new Date();
  const timeFormatted = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

  const logEntry = {
    id: `log-${Date.now()}`,
    userId,
    userName: user ? user.name : 'Employee',
    eventType: forcedType,
    time: now.toISOString(),
    formattedTime: timeFormatted,
    method: 'MANUAL_ADMIN'
  };

  localLogs.unshift(logEntry);
  if (user) {
    user.status = forcedType === 'CHECK_IN' ? 'IN' : 'OUT';
  }
  localStorage.setItem('smartattend_users', JSON.stringify(localUsers));
  localStorage.setItem('smartattend_logs', JSON.stringify(localLogs));

  await fetch('/api/attendance/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, method: 'REVERSE_SCAN', forcedType })
  });

  const form = document.getElementById('manual-punch-form');
  if (form) form.reset();
  closeManualPunchModal();

  fetchAdminData();
  showToast('Attendance Recorded', `${user ? user.name : 'Employee'} marked as ${forcedType === 'CHECK_IN' ? 'Clocked IN' : 'Clocked OUT'}`);
}

// --- SEARCH & SIMULATOR ---
function handleEmployeeSearch() {
  const query = document.getElementById('employee-search-input').value.toLowerCase();
  const filtered = localUsers.filter(u => u.name.toLowerCase().includes(query) || u.phone.includes(query));
  renderAdminRoster(filtered);
}

function clearLogsAudit() {
  if (!confirm('Clear all timestamp audit logs?')) return;
  localLogs = [];
  localStorage.setItem('smartattend_logs', JSON.stringify([]));
  fetchAdminData();
  showToast('Logs Cleared', 'Audit log history has been reset.');
}

function populateSimUserSelect(users) {
  const select = document.getElementById('sim-user-select');
  if (!select) return;
  if (users.length === 0) {
    select.innerHTML = '<option value="">No registered employees</option>';
    return;
  }
  select.innerHTML = users.map(u => `
    <option value="${u.phone}">${u.name} (+${u.phone})</option>
  `).join('');
  syncKioskTokenToForm();
}

function syncKioskTokenToForm() {
  const input = document.getElementById('sim-token-input');
  if (input && currentKioskToken) {
    input.value = currentKioskToken;
  }
}

async function handleMobileScanSubmit(e) {
  e.preventDefault();
  const phone = document.getElementById('sim-user-select').value;
  const token = document.getElementById('sim-token-input').value.trim();

  const responseBox = document.getElementById('sim-response-box');
  const bubble = document.getElementById('sim-whatsapp-bubble');

  const res = await fetch('/api/whatsapp/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senderPhone: phone, messageText: `IN-${token}` })
  });
  const data = await res.json();
  responseBox.classList.remove('hidden');
  bubble.textContent = data.replyMessage;

  fetchAdminData();
}

// --- OFFLINE BADGE ---
function populateBadgeSelect() {
  const select = document.getElementById('badge-user-select');
  if (!select || localUsers.length === 0) return;
  select.innerHTML = localUsers.map(u => `
    <option value="${u.id}">${u.name} - ${u.department}</option>
  `).join('');
}

function renderEmployeeBadge() {
  const select = document.getElementById('badge-user-select');
  if (!select) return;
  const userId = select.value || (localUsers[0] && localUsers[0].id);
  const user = localUsers.find(u => u.id === userId) || localUsers[0];

  if (!user) return;

  document.getElementById('badge-emp-id').textContent = user.id;
  document.getElementById('badge-emp-phone').textContent = user.phone;

  const badgeContainer = document.getElementById('badge-qrcode');
  if (badgeContainer) {
    badgeContainer.innerHTML = '';
    badgeQRCodeObj = new QRCode(badgeContainer, {
      text: JSON.stringify({ employeeId: user.id, phone: user.phone }),
      width: 180,
      height: 180,
      colorDark : "#581c87",
      colorLight : "#ffffff",
      correctLevel : QRCode.CorrectLevel.H
    });
  }
}

async function simulateReverseScan() {
  const select = document.getElementById('badge-user-select');
  const userId = select.value;

  const res = await fetch('/api/attendance/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, method: 'REVERSE_SCAN' })
  });
  const data = await res.json();
  showToast('Camera Scan Success', `${data.message} (${data.userName})`);
  fetchAdminData();
}
