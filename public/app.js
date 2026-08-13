// --- GLOBAL STATE & PERSISTENCE ---
let currentActiveTab = 'kiosk';
let kioskQRCodeObj = null;
let bindQRCodeObj = null;
let currentKioskToken = '';
let kioskTimerInterval = null;
let liveClockInterval = null;
let activeBindingUserId = null;

// LocalStorage Persistent Stores
let localEmployees = JSON.parse(localStorage.getItem('smartattend_employees') || '[]');
let localLogs = JSON.parse(localStorage.getItem('smartattend_logs') || '[]');

// --- INIT APP ---
document.addEventListener('DOMContentLoaded', () => {
  initLiveClock();
  initKioskLoop();
  syncLocalDataToServer();
  fetchAdminData();
  setInterval(fetchAdminData, 4000);
});

// --- TOAST NOTIFICATION ---
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
  } else {
    icon.className = "w-9 h-9 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-lg";
    icon.innerHTML = '<i class="fa-solid fa-check"></i>';
  }

  toast.className = "fixed top-5 right-5 z-50 transform translate-y-0 opacity-100 bg-slate-900 border border-slate-700 shadow-2xl rounded-2xl p-4 flex items-center space-x-3 max-w-sm pointer-events-auto transition-all";

  setTimeout(() => {
    toast.className = "fixed top-5 right-5 z-50 transform translate-y-[-150%] opacity-0 bg-slate-900 border border-slate-700 shadow-2xl rounded-2xl p-4 flex items-center space-x-3 max-w-sm pointer-events-none transition-all";
  }, 3500);
}

// --- TAB SWITCHER ---
function switchTab(tabName) {
  currentActiveTab = tabName;
  ['kiosk', 'dashboard'].forEach(t => {
    const viewEl = document.getElementById(`view-${t}`);
    const tabBtn = document.getElementById(`tab-${t}`);
    if (t === tabName) {
      viewEl.classList.remove('hidden');
      tabBtn.className = "px-3.5 py-1.5 text-xs sm:text-sm font-semibold rounded-lg transition-all flex items-center space-x-2 text-emerald-400 bg-slate-800/90 shadow-sm border border-emerald-500/30";
    } else {
      viewEl.classList.add('hidden');
      tabBtn.className = "px-3.5 py-1.5 text-xs sm:text-sm font-medium text-slate-400 hover:text-white rounded-lg transition-all flex items-center space-x-2";
    }
  });
}

// --- SYNC LOCAL STORAGE TO SERVER ---
async function syncLocalDataToServer() {
  if (localEmployees.length > 0 || localLogs.length > 0) {
    try {
      await fetch('/api/admin/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initialEmployees: localEmployees,
          initialLogs: localLogs
        })
      });
    } catch (e) {}
  }
}

// --- CLOCK & KIOSK 30s TOTP LOOP ---
function initLiveClock() {
  updateClock();
  liveClockInterval = setInterval(updateClock, 1000);
}

function updateClock() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
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
    document.getElementById('kiosk-token-code').textContent = data.token;
    document.getElementById('kiosk-seconds').textContent = `${data.secondsRemaining}s`;

    const percent = (data.secondsRemaining / 30) * 100;
    document.getElementById('kiosk-timer-bar').style.width = `${percent}%`;

    const qrContainer = document.getElementById('kiosk-qrcode');
    if (qrContainer) {
      const origin = window.location.origin;
      const qrTargetUrl = `${origin}/scan.html?token=${data.token}`;

      if (!kioskQRCodeObj) {
        qrContainer.innerHTML = '';
        kioskQRCodeObj = new QRCode(qrContainer, {
          text: qrTargetUrl,
          width: 220,
          height: 220,
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

// --- FETCH ADMIN DATA & UPDATE ROSTER ---
async function fetchAdminData() {
  try {
    const res = await fetch('/api/admin/data');
    const data = await res.json();

    if (data.employees && data.employees.length > 0) {
      // Merge with local device binding flags
      localEmployees = data.employees.map(de => {
        const local = localEmployees.find(le => le.id === de.id);
        return {
          ...de,
          deviceToken: de.deviceToken || (local && local.deviceToken) || null,
          isDeviceBound: de.isDeviceBound || (local && local.isDeviceBound) || false
        };
      });
      localStorage.setItem('smartattend_employees', JSON.stringify(localEmployees));
    }
    if (data.logs && data.logs.length > 0) {
      localLogs = data.logs;
      localStorage.setItem('smartattend_logs', JSON.stringify(localLogs));
    }

    const displayEmployees = localEmployees;
    const displayLogs = data.logs && data.logs.length > 0 ? data.logs : localLogs;

    const checkedInCount = displayEmployees.filter(e => e.status === 'IN').length;
    const boundDevicesCount = displayEmployees.filter(e => e.isDeviceBound || !!e.deviceToken).length;

    document.getElementById('kpi-total-emp').textContent = displayEmployees.length;
    document.getElementById('kpi-checked-in').textContent = checkedInCount;
    document.getElementById('kpi-checked-out').textContent = displayEmployees.length - checkedInCount;
    document.getElementById('kpi-bound-devices').textContent = `${boundDevicesCount} / ${displayEmployees.length}`;

    renderAdminRoster(displayEmployees);
    renderAdminLogs(displayLogs);
    renderKioskTicker(displayLogs);
    populateManualUserSelect(displayEmployees);
  } catch (e) {
    console.error("Error fetching admin data", e);
  }
}

function renderAdminRoster(employees) {
  const tbody = document.getElementById('admin-user-tbody');
  if (!tbody) return;

  if (employees.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="px-4 py-8 text-center text-xs text-slate-500">
          No employees registered yet. Click <strong class="text-emerald-400">"Register Employee"</strong> above to add your team.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = employees.map(e => {
    const isIn = e.status === 'IN';
    const clockInVal = e.clockIn || '--';
    const clockOutVal = e.clockOut || (isIn ? '<span class="text-emerald-400 font-semibold animate-pulse">Active (Open)</span>' : '--');
    const hoursVal = e.hoursToday || '0h 0m 0s';
    const isBound = e.isDeviceBound || !!e.deviceToken;

    const deviceBadge = isBound
      ? `<button onclick="handleRebindClick('${e.id}', '${e.name}')" class="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 transition"><i class="fa-solid fa-mobile-screen-button mr-1"></i> Phone Linked</button>`
      : `<button onclick="openBindModal('${e.id}', '${e.name}')" class="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 transition"><i class="fa-solid fa-qrcode mr-1"></i> Bind Phone</button>`;

    return `
      <tr class="hover:bg-slate-800/40 transition cursor-pointer" onclick="openTimesheetModal('${e.id}')">
        <td class="px-4 py-3.5 font-medium text-white flex items-center space-x-3">
          <div class="w-8 h-8 rounded-xl bg-slate-800 text-slate-300 border border-slate-700 flex items-center justify-center font-bold text-xs">
            ${e.name.charAt(0)}
          </div>
          <div>
            <div class="font-bold text-slate-100">${e.name}</div>
            <div class="text-[11px] text-slate-400 font-mono">${e.phone ? '+' + e.phone.replace(/[^0-9]/g, '') : 'No Phone'}</div>
          </div>
        </td>
        <td class="px-4 py-3.5 text-slate-300">${e.department || 'General'}</td>
        <td class="px-4 py-3.5" onclick="event.stopPropagation()">${deviceBadge}</td>
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
          <button onclick="openTimesheetModal('${e.id}')" class="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-semibold rounded-lg border border-slate-700">
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
    container.innerHTML = `<div class="text-xs text-slate-500 py-3 text-center">No attendance logs recorded yet</div>`;
    return;
  }

  container.innerHTML = logs.map(l => {
    const isIn = l.eventType === 'CHECK_IN';
    const timeFormatted = l.formattedTime || new Date(l.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

    return `
      <div class="p-3 bg-slate-950/70 rounded-xl border border-slate-800/80 flex items-center justify-between text-xs font-mono">
        <div class="flex items-center space-x-2.5">
          <div class="w-2 h-2 rounded-full ${isIn ? 'bg-emerald-400' : 'bg-rose-400'}"></div>
          <div>
            <span class="font-bold text-slate-200">${l.userName}</span>
            <span class="text-slate-500 text-[11px] ml-2">${timeFormatted}</span>
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
            <div class="text-[10px] text-emerald-400 flex items-center gap-1 mt-0.5 font-mono">
              <i class="fa-solid fa-mobile-screen-button"></i> Device Verified
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

// --- ONE-TIME DEVICE ACTIVATION MODAL ---
function openBindModal(userId, userName) {
  activeBindingUserId = userId;
  document.getElementById('bind-modal-emp-name').textContent = userName;
  document.getElementById('bind-device-modal').classList.remove('hidden');

  const activationCode = 'ACT-' + Math.random().toString(36).substring(2, 10).toUpperCase();
  const origin = window.location.origin;
  const bindUrl = `${origin}/bind.html?key=${activationCode}&uid=${userId}&name=${encodeURIComponent(userName)}`;

  document.getElementById('bind-url-input').value = bindUrl;

  const qrContainer = document.getElementById('bind-qrcode');
  qrContainer.innerHTML = '';
  try {
    bindQRCodeObj = new QRCode(qrContainer, {
      text: bindUrl,
      width: 200,
      height: 200,
      colorDark : "#020617",
      colorLight : "#ffffff",
      correctLevel : QRCode.CorrectLevel.H
    });
  } catch (err) {
    console.error("QR render error", err);
  }
}

function handleRebindClick(userId, userName) {
  if (confirm(`A phone is already bound to "${userName}".\n\nDo you want to reset and generate a new QR code to link a new phone?`)) {
    openBindModal(userId, userName);
  }
}

function copyBindUrl() {
  const input = document.getElementById('bind-url-input');
  input.select();
  navigator.clipboard.writeText(input.value);
  showToast('Link Copied!', 'Activation link copied. Send it to the employee or scan the QR.');
}

function closeBindModal() {
  // Update local binding state to Phone Linked
  if (activeBindingUserId) {
    const emp = localEmployees.find(e => e.id === activeBindingUserId);
    if (emp) {
      emp.isDeviceBound = true;
      emp.deviceToken = emp.deviceToken || `DEV-${activeBindingUserId}`;
      localStorage.setItem('smartattend_employees', JSON.stringify(localEmployees));
    }
  }

  document.getElementById('bind-device-modal').classList.add('hidden');
  activeBindingUserId = null;
  fetchAdminData();
  showToast('Binding Complete', 'Phone binding registered. Employee can now scan reception kiosk.');
}

// --- TIMESHEET MODAL ---
function openTimesheetModal(userId) {
  const emp = localEmployees.find(e => e.id === userId);
  if (!emp) return;

  document.getElementById('detail-name').textContent = emp.name;
  document.getElementById('detail-phone').textContent = `${emp.department || 'General'} • ${emp.phone ? '+' + emp.phone.replace(/[^0-9]/g, '') : 'No Phone'}`;
  document.getElementById('detail-avatar').textContent = emp.name.charAt(0);

  document.getElementById('detail-today-hours').textContent = emp.hoursToday || '0h 0m 0s';
  document.getElementById('detail-weekly-hours').textContent = emp.hoursWeekly || '0h 0m 0s';
  document.getElementById('detail-monthly-hours').textContent = emp.hoursMonthly || '0h 0m 0s';

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

  const unbindBtn = document.getElementById('detail-unbind-btn');
  unbindBtn.onclick = () => unbindDevice(userId, emp.name);

  document.getElementById('timesheet-modal').classList.remove('hidden');
}

function closeTimesheetModal() {
  document.getElementById('timesheet-modal').classList.add('hidden');
}

async function unbindDevice(userId, userName) {
  if (!confirm(`Reset and unbind phone for "${userName}"? The employee will need to scan a new activation QR.`)) return;

  const emp = localEmployees.find(e => e.id === userId);
  if (emp) {
    emp.deviceToken = null;
    emp.isDeviceBound = false;
  }
  localStorage.setItem('smartattend_employees', JSON.stringify(localEmployees));

  await fetch('/api/admin/employees/unbind', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId })
  });

  closeTimesheetModal();
  fetchAdminData();
  showToast('Phone Unbound', `Device reset for "${userName}".`);
}

// --- ADD EMPLOYEE FORM ---
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

  if (!name) {
    showToast('Missing Field', 'Please provide employee name', true);
    return;
  }

  const newEmp = {
    id: `emp-${Date.now()}`,
    name,
    phone,
    department: department || 'General',
    status: 'OUT',
    clockIn: '--',
    clockOut: '--',
    hoursToday: '0h 0m 0s',
    deviceToken: null,
    isDeviceBound: false
  };

  localEmployees.push(newEmp);
  localStorage.setItem('smartattend_employees', JSON.stringify(localEmployees));

  try {
    await fetch('/api/admin/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, department, id: newEmp.id })
    });
  } catch (err) {}

  const form = document.getElementById('add-user-form');
  if (form) form.reset();
  closeAddUserModal();

  fetchAdminData();
  showToast('Employee Registered', `"${name}" registered. Click "Bind Phone" to link their device.`);
}

// --- MANUAL PUNCH MODAL ---
function openManualPunchModal() {
  populateManualUserSelect(localEmployees);
  document.getElementById('manual-punch-modal').classList.remove('hidden');
}

function closeManualPunchModal() {
  document.getElementById('manual-punch-modal').classList.add('hidden');
}

function populateManualUserSelect(employees) {
  const select = document.getElementById('manual-user-select');
  if (!select) return;
  if (employees.length === 0) {
    select.innerHTML = '<option value="">No registered employees</option>';
    return;
  }
  select.innerHTML = employees.map(e => `
    <option value="${e.id}">${e.name} (${e.department || 'General'})</option>
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

  const emp = localEmployees.find(e => e.id === userId);
  const now = new Date();
  const timeFormatted = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

  const logEntry = {
    id: `log-${Date.now()}`,
    userId,
    userName: emp ? emp.name : 'Employee',
    eventType: forcedType,
    time: now.toISOString(),
    formattedTime: timeFormatted,
    method: 'MANUAL_ADMIN'
  };

  localLogs.unshift(logEntry);
  if (emp) {
    emp.status = forcedType === 'CHECK_IN' ? 'IN' : 'OUT';
  }
  localStorage.setItem('smartattend_employees', JSON.stringify(localEmployees));
  localStorage.setItem('smartattend_logs', JSON.stringify(localLogs));

  await fetch('/api/attendance/punch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, method: 'MANUAL_ADMIN', forcedType })
  });

  const form = document.getElementById('manual-punch-form');
  if (form) form.reset();
  closeManualPunchModal();

  fetchAdminData();
  showToast('Attendance Recorded', `${emp ? emp.name : 'Employee'} marked as ${forcedType === 'CHECK_IN' ? 'Clocked IN' : 'Clocked OUT'}`);
}

function handleEmployeeSearch() {
  const query = document.getElementById('employee-search-input').value.toLowerCase();
  const filtered = localEmployees.filter(e => e.name.toLowerCase().includes(query) || (e.department && e.department.toLowerCase().includes(query)));
  renderAdminRoster(filtered);
}

function clearLogsAudit() {
  if (!confirm('Clear all timestamp audit logs?')) return;
  localLogs = [];
  localStorage.setItem('smartattend_logs', JSON.stringify([]));
  fetchAdminData();
  showToast('Logs Cleared', 'Audit log history has been reset.');
}
