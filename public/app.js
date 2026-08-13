// --- GLOBAL APP STATE ---
let currentActiveTab = 'kiosk';
let kioskQRCodeObj = null;
let badgeQRCodeObj = null;
let currentKioskToken = '';
let kioskTimerInterval = null;
let liveClockInterval = null;
let globalDataCache = { users: [], logs: [], metrics: {} };

// --- INIT APP ---
document.addEventListener('DOMContentLoaded', () => {
  initLiveClock();
  initKioskLoop();
  fetchAdminData();
  setInterval(fetchAdminData, 5000); // Poll dashboard data every 5s
});

// --- TAB SWITCHER ---
function switchTab(tabName) {
  currentActiveTab = tabName;
  ['kiosk', 'mobile', 'dashboard', 'badge'].forEach(t => {
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

// --- CLOCK & KIOSK DYNAMIC TOTP ENGINE ---
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
    const res = await fetch('/api/kiosk/token?kiosk_id=kiosk-001');
    const data = await res.json();

    currentKioskToken = data.token;
    document.getElementById('kiosk-token-code').textContent = data.token;
    document.getElementById('kiosk-seconds').textContent = `${data.secondsRemaining}s`;

    // Update progress bar
    const percent = (data.secondsRemaining / 30) * 100;
    document.getElementById('kiosk-timer-bar').style.width = `${percent}%`;

    // Render or update QR Code
    const qrContainer = document.getElementById('kiosk-qrcode');
    if (qrContainer) {
      const qrText = `https://wa.me/15550192834?text=IN-${data.token}`;
      if (!kioskQRCodeObj) {
        qrContainer.innerHTML = '';
        kioskQRCodeObj = new QRCode(qrContainer, {
          text: qrText,
          width: 200,
          height: 200,
          colorDark : "#0f172a",
          colorLight : "#ffffff",
          correctLevel : QRCode.CorrectLevel.H
        });
      } else if (data.secondsRemaining === 30 || data.secondsRemaining === 29) {
        kioskQRCodeObj.clear();
        kioskQRCodeObj.makeCode(qrText);
      }
    }
  } catch (e) {
    console.error("Error fetching kiosk token", e);
  }
}

// --- FETCH ADMIN DATA & UPDATE TICKER & DASHBOARD ---
async function fetchAdminData() {
  try {
    const res = await fetch('/api/admin/data');
    const data = await res.json();
    globalDataCache = data;

    // Update KPIs
    document.getElementById('kpi-total-emp').textContent = data.metrics.totalEmployees;
    document.getElementById('kpi-checked-in').textContent = data.metrics.currentlyCheckedIn;
    document.getElementById('kpi-checked-out').textContent = data.metrics.currentlyCheckedOut;
    document.getElementById('kpi-late-count').textContent = data.metrics.todayLateCount;

    // Render Kiosk Live Ticker
    renderKioskTicker(data.logs);

    // Render Admin Roster & Logs
    renderAdminRoster(data.users);
    renderAdminLogs(data.logs);

    // Populate Mobile Sim Select
    populateSimUserSelect(data.users);
  } catch (e) {
    console.error("Error fetching admin data", e);
  }
}

function renderKioskTicker(logs) {
  const tickerList = document.getElementById('kiosk-ticker-list');
  if (!tickerList) return;

  const recentLogs = logs.slice(0, 5);
  if (recentLogs.length === 0) {
    tickerList.innerHTML = `<div class="text-xs text-slate-500 py-4 text-center">No recent scan activity</div>`;
    return;
  }

  tickerList.innerHTML = recentLogs.map(log => {
    const isIn = log.eventType === 'CHECK_IN';
    const methodBadge = log.method === 'WHATSAPP'
      ? `<span class="text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded text-[10px]"><i class="fa-brands fa-whatsapp"></i> WhatsApp</span>`
      : log.method === 'REVERSE_SCAN'
      ? `<span class="text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded text-[10px]"><i class="fa-solid fa-camera"></i> Kiosk Cam</span>`
      : `<span class="text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded text-[10px]"><i class="fa-solid fa-globe"></i> Web Scan</span>`;

    const formattedTime = new Date(log.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    return `
      <div class="bg-slate-900/80 p-3 rounded-2xl border border-slate-700/60 flex items-center justify-between">
        <div class="flex items-center space-x-3">
          <div class="w-9 h-9 rounded-xl ${isIn ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-700 text-slate-400'} flex items-center justify-center font-bold text-sm">
            <i class="fa-solid ${isIn ? 'fa-arrow-right-to-bracket' : 'fa-arrow-right-from-bracket'}"></i>
          </div>
          <div>
            <div class="text-sm font-bold text-white">${log.userName}</div>
            <div class="flex items-center space-x-2 mt-0.5">
              ${methodBadge}
              ${log.isLate ? `<span class="text-rose-400 bg-rose-500/10 px-1.5 py-0.5 rounded text-[10px]">Late Entry</span>` : ''}
            </div>
          </div>
        </div>
        <div class="text-right">
          <div class="text-xs font-bold ${isIn ? 'text-emerald-400' : 'text-slate-400'}">${isIn ? 'CHECK IN' : 'CHECK OUT'}</div>
          <div class="text-[11px] text-slate-400 font-mono">${formattedTime}</div>
        </div>
      </div>
    `;
  }).join('');
}

function renderAdminRoster(users) {
  const tbody = document.getElementById('admin-user-tbody');
  if (!tbody) return;

  tbody.innerHTML = users.map(u => {
    const isIn = u.status === 'IN';
    return `
      <tr class="hover:bg-slate-800/40 transition">
        <td class="px-4 py-3 font-medium text-white flex items-center space-x-2">
          <div class="w-7 h-7 rounded-full bg-slate-700 flex items-center justify-center text-xs text-slate-300 font-bold">
            ${u.name.charAt(0)}
          </div>
          <div>
            <div>${u.name}</div>
            <div class="text-[10px] text-slate-400 font-mono">${u.phone}</div>
          </div>
        </td>
        <td class="px-4 py-3 text-slate-400">${u.department}</td>
        <td class="px-4 py-3">
          <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${isIn ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-slate-700 text-slate-400'}">
            <span class="w-1.5 h-1.5 rounded-full ${isIn ? 'bg-emerald-400 mr-1.5 pulse-green' : 'bg-slate-500 mr-1.5'}"></span>
            ${isIn ? 'Checked In' : 'Checked Out'}
          </span>
        </td>
        <td class="px-4 py-3 font-mono font-semibold text-emerald-400">${u.hours || '0.0 hrs'}</td>
      </tr>
    `;
  }).join('');
}

function renderAdminLogs(logs) {
  const logContainer = document.getElementById('admin-logs-list');
  if (!logContainer) return;

  logContainer.innerHTML = logs.map(l => {
    const isIn = l.eventType === 'CHECK_IN';
    const methodTag = l.method === 'WHATSAPP' ? 'WhatsApp' : l.method === 'REVERSE_SCAN' ? 'Badge Cam' : 'Web Scan';
    const timeStr = new Date(l.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    return `
      <div class="p-3 bg-slate-900/60 rounded-xl border border-slate-700/50 flex items-center justify-between text-xs">
        <div>
          <div class="font-bold text-slate-200">${l.userName}</div>
          <div class="text-[10px] text-slate-400 space-x-1.5">
            <span class="text-slate-300 font-semibold">${methodTag}</span>
            <span>•</span>
            <span class="font-mono text-slate-400">${timeStr}</span>
          </div>
        </div>
        <div class="text-right">
          <span class="px-2 py-0.5 rounded text-[10px] font-bold ${isIn ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-300'}">
            ${l.eventType}
          </span>
        </div>
      </div>
    `;
  }).join('');
}

// --- WHATSAPP SIMULATOR FORM ---
function populateSimUserSelect(users) {
  const select = document.getElementById('sim-user-select');
  if (!select) return;
  const currentVal = select.value;
  select.innerHTML = users.map(u => `
    <option value="${u.phone}">${u.name} (${u.department}) - Phone: ${u.phone}</option>
  `).join('');
  if (currentVal) select.value = currentVal;
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
  const method = document.querySelector('input[name="sim-method"]:checked').value;

  const responseBox = document.getElementById('sim-response-box');
  const bubble = document.getElementById('sim-whatsapp-bubble');

  if (method === 'WHATSAPP') {
    // Call WhatsApp Cloud API Webhook
    const res = await fetch('/api/whatsapp/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senderPhone: phone, messageText: `IN-${token}` })
    });
    const data = await res.json();
    responseBox.classList.remove('hidden');
    bubble.textContent = data.replyMessage;
  } else {
    // Call Direct Web Scan
    const userObj = globalDataCache.users.find(u => u.phone === phone);
    const res = await fetch('/api/attendance/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: userObj ? userObj.id : phone, token, method: 'WEB_SCAN' })
    });
    const data = await res.json();
    responseBox.classList.remove('hidden');
    if (data.success) {
      bubble.textContent = `🌐 WEB CHECK-IN CONFIRMED!\nName: ${data.userName}\nStatus: ${data.message}\nTotal Hours Today: ${data.totalHours}`;
    } else {
      bubble.textContent = `❌ WEB SCAN ERROR: ${data.message}`;
    }
  }

  fetchAdminData();
}

// --- OFFLINE BADGE MODE (REVERSE SCANNING) ---
function populateBadgeSelect() {
  const select = document.getElementById('badge-user-select');
  if (!select || globalDataCache.users.length === 0) return;
  select.innerHTML = globalDataCache.users.map(u => `
    <option value="${u.id}">${u.name} - ${u.department}</option>
  `).join('');
}

function renderEmployeeBadge() {
  const select = document.getElementById('badge-user-select');
  if (!select) return;
  const userId = select.value || (globalDataCache.users[0] && globalDataCache.users[0].id);
  const user = globalDataCache.users.find(u => u.id === userId) || globalDataCache.users[0];

  if (!user) return;

  document.getElementById('badge-emp-id').textContent = user.id;
  document.getElementById('badge-emp-phone').textContent = user.phone;

  const badgeContainer = document.getElementById('badge-qrcode');
  if (badgeContainer) {
    const badgePayload = JSON.stringify({ employeeId: user.id, phone: user.phone, tenantId: user.tenantId });
    badgeContainer.innerHTML = '';
    badgeQRCodeObj = new QRCode(badgeContainer, {
      text: badgePayload,
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

  if (data.success) {
    alert(`📷 KIOSK CAMERA REVERSE SCAN SUCCESSFUL!\n\n${data.message}\nEmployee: ${data.userName}\nTotal Hours: ${data.totalHours}`);
  } else {
    alert(`❌ Camera Scan Failed: ${data.message}`);
  }

  fetchAdminData();
}

// --- ADD USER MODAL ---
function openAddUserModal() {
  document.getElementById('add-user-modal').classList.remove('hidden');
}

function closeAddUserModal() {
  document.getElementById('add-user-modal').classList.add('hidden');
}

async function handleAddUserSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('new-name').value;
  const username = document.getElementById('new-username').value;
  const phone = document.getElementById('new-phone').value;
  const department = document.getElementById('new-dept').value;

  const res = await fetch('/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, username, phone, department })
  });

  const data = await res.json();
  if (data.success) {
    closeAddUserModal();
    document.getElementById('add-user-form').reset();
    fetchAdminData();
    alert(`✅ Employee "${name}" added successfully!`);
  }
}
