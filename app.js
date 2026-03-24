/* ============================================================
   Team Task Tracker — app.js
   Pure vanilla JS + Alpine.js + SortableJS + Google Sheets API
   ============================================================ */

'use strict';

/* ────────────────────────────────────────────────────────────
   CONFIGURATION  (replace with real values before deploying)
──────────────────────────────────────────────────────────── */
const GOOGLE_CLIENT_ID  = '223779188444-5h4c4k6h9jcj9usvnqm36lucr7o7fe9d.apps.googleusercontent.com';
const GOOGLE_API_KEY    = 'AIzaSyAm8EAM7YtNTgbnNLgL1QlkNkhsYCBWlq8';
const SPREADSHEET_ID    = '1whnfKvVknzPfxJwNGIPD6ooJ-b0DGe_u-FnCjL_x4Gw';
const APP_URL           = 'https://ayopel.github.io/task-maneger';

/* ────────────────────────────────────────────────────────────
   CONSTANTS
──────────────────────────────────────────────────────────── */
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.readonly',
].join(' ');

const SHEETS = {
  PROJECTS:           'Projects',
  TASKS:              'Tasks',
  ACTIVITY:           'ActivityLog',
  USERS:              'AllowedUsers',
  CONFIG:             'Config',
  NOTIFICATIONS:      'NotificationQueue',
};

const STATUS = { TODO: 'todo', IN_PROGRESS: 'in_progress', DONE: 'done' };
const STATUS_LABEL = { todo: 'To Do', in_progress: 'In Progress', done: 'Done' };
const PRIORITY = { LOW: 'low', MEDIUM: 'medium', HIGH: 'high' };

const ACTIVITY_PAGE_SIZE = 50;

/* ────────────────────────────────────────────────────────────
   IN-MEMORY STATE
──────────────────────────────────────────────────────────── */
const State = {
  accessToken:  null,   // never persisted
  tokenClient:  null,
  currentUser:  null,   // { email, name }
  isOnline:     navigator.onLine,
  appName:      'Task Tracker',

  // Cached sheet data
  projects:     [],
  tasks:        [],
  users:        [],
  config:       {},

  // Kanban drag-drop undo state
  _dragSnapshot: null,
};

/* ────────────────────────────────────────────────────────────
   UTILITIES
──────────────────────────────────────────────────────────── */

/**
 * Sleep for `ms` milliseconds.
 */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Generate a UUID suitable for use as a row ID.
 */
function uuid() {
  return crypto.randomUUID();
}

/**
 * Format a timestamp for display.
 * @param {string} iso
 */
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Format a full ISO timestamp.
 */
function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Relative time — e.g. "5 minutes ago"
 */
function relativeTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000)  return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff/60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff/3_600_000)}h ago`;
  return formatDate(iso);
}

/**
 * Get user initials for avatar.
 */
function initials(nameOrEmail) {
  if (!nameOrEmail) return '?';
  const parts = nameOrEmail.split(/[\s@]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return nameOrEmail.slice(0, 2).toUpperCase();
}

/**
 * Today's date in YYYY-MM-DD.
 */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Is `dateStr` (YYYY-MM-DD) before today?
 */
function isOverdue(dateStr, status) {
  if (!dateStr || status === STATUS.DONE) return false;
  return dateStr < today();
}

/**
 * Parse a comma/semi-colon separated list into an array.
 */
function parseList(str) {
  if (!str) return [];
  return str.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
}

/**
 * Serialise an array back to comma string.
 */
function serializeList(arr) {
  return (arr || []).join(', ');
}

/**
 * Deep clone an object via JSON.
 */
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/* ────────────────────────────────────────────────────────────
   TOAST NOTIFICATIONS
──────────────────────────────────────────────────────────── */
const Toast = {
  show(message, type = 'info', duration = 3500) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const icons = {
      success: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
      error:   `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-danger)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
      warning: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-warning)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m10.29 3.86-8.27 14.28A1 1 0 0 0 2.91 20h16.18a1 1 0 0 0 .89-1.45L11.71 3.86a1 1 0 0 0-1.77 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
      info:    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-info)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    };

    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `
      ${icons[type] || icons.info}
      <span style="flex:1;">${message}</span>
      <button onclick="this.closest('.toast').remove()" style="background:none;border:none;cursor:pointer;color:var(--color-text-faint);padding:2px;display:flex;align-items:center;" aria-label="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    `;

    container.appendChild(el);

    setTimeout(() => {
      el.classList.add('toast-out');
      setTimeout(() => el.remove(), 250);
    }, duration);
  },

  success(msg) { this.show(msg, 'success'); },
  error(msg)   { this.show(msg, 'error', 5000); },
  warning(msg) { this.show(msg, 'warning', 4500); },
  info(msg)    { this.show(msg, 'info'); },
};

/* ────────────────────────────────────────────────────────────
   OFFLINE / ONLINE DETECTION
──────────────────────────────────────────────────────────── */
function updateOnlineStatus() {
  State.isOnline = navigator.onLine;
  const banner = document.getElementById('offline-banner');
  if (banner) banner.style.display = State.isOnline ? 'none' : 'flex';
  // Disable all write buttons when offline
  document.querySelectorAll('.write-action').forEach(el => {
    el.disabled = !State.isOnline;
  });
}

window.addEventListener('online',  updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();

/* ────────────────────────────────────────────────────────────
   GOOGLE API / AUTH
──────────────────────────────────────────────────────────── */
const Auth = {
  _resolveTokenReady: null,
  _tokenReadyPromise: null,

  init() {
    this._tokenReadyPromise = new Promise(resolve => {
      this._resolveTokenReady = resolve;
    });
  },

  /**
   * Initialise the GIS token client and attempt silent token acquisition.
   */
  async setup() {
    // Wait for GSI library
    await this._waitForGsi();

    State.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES,
      callback: (response) => {
        if (response.error) {
          console.error('OAuth error:', response.error);
          this._showSignInButton();
          return;
        }
        State.accessToken = response.access_token;
        this._resolveTokenReady(true);
        this._onTokenAcquired();
      },
    });

    // Try silent refresh
    State.tokenClient.requestAccessToken({ prompt: '' });
  },

  _waitForGsi() {
    return new Promise(resolve => {
      const check = () => {
        if (typeof google !== 'undefined' && google.accounts) {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  },

  /**
   * Called after a token is successfully acquired.
   * Verifies the user against AllowedUsers.
   */
  async _onTokenAcquired() {
    document.getElementById('signin-loading').style.display = 'flex';
    document.getElementById('signin-error').style.display   = 'none';

    try {
      // Load gapi client
      await this._loadGapiClient();

      // Get the user email from tokeninfo
      const email = await this._getTokenEmail();
      if (!email) throw new Error('Could not determine user email');

      // Check AllowedUsers
      const users = await Sheets.getUsers();
      const match = users.find(u => u.email.toLowerCase() === email.toLowerCase());

      if (!match) {
        this._showAccessDenied(email);
        State.accessToken = null;
        return;
      }

      State.currentUser = { email: match.email, name: match.name || email };

      // Load config
      await Config.load();

      // Show main app
      this._showMainApp();

    } catch (err) {
      console.error('Auth error:', err);
      document.getElementById('signin-loading').style.display = 'none';
      this._showSignInButton();
      const errEl = document.getElementById('signin-error');
      errEl.textContent = 'Authentication failed. Please try again.';
      errEl.style.display = 'block';
    }
  },

  _loadGapiClient() {
    return new Promise((resolve, reject) => {
      if (typeof gapi !== 'undefined' && gapi.client) {
        gapi.client.setApiKey(GOOGLE_API_KEY);
        gapi.client.setToken({ access_token: State.accessToken });
        resolve();
        return;
      }
      const check = () => {
        if (typeof gapi !== 'undefined') {
          gapi.load('client', async () => {
            await gapi.client.init({ apiKey: GOOGLE_API_KEY });
            gapi.client.setToken({ access_token: State.accessToken });
            resolve();
          });
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  },

  async _getTokenEmail() {
    try {
      const resp = await fetch(
        `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${State.accessToken}`
      );
      const data = await resp.json();
      return data.email || null;
    } catch {
      return null;
    }
  },

  _showSignInButton() {
    document.getElementById('signin-screen').style.display = 'flex';
    document.getElementById('main-app').style.display       = 'none';
    document.getElementById('signin-loading').style.display = 'none';

    // Render Google Sign In button
    const btnDiv = document.getElementById('google-signin-btn');
    btnDiv.innerHTML = '';
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: (credResponse) => {
        // We use implicit flow via tokenClient; GIS button just triggers token request
      },
    });

    // Use a custom button that triggers tokenClient
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary';
    btn.style.cssText = 'gap:10px;padding:10px 20px;font-size:0.9375rem;';
    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
      </svg>
      Sign in with Google
    `;
    btn.addEventListener('click', () => {
      State.tokenClient.requestAccessToken({ prompt: 'consent' });
    });
    btnDiv.appendChild(btn);
  },

  _showAccessDenied(email) {
    document.getElementById('signin-loading').style.display = 'none';
    const errEl = document.getElementById('signin-error');
    errEl.textContent = `Access denied for ${email}. Contact your team admin to be added.`;
    errEl.style.display = 'block';
  },

  _showMainApp() {
    document.getElementById('signin-screen').style.display = 'none';
    const mainApp = document.getElementById('main-app');
    mainApp.style.display = 'flex';

    // Update nav avatar
    const avatar = document.getElementById('user-avatar');
    if (avatar && State.currentUser) {
      avatar.textContent = initials(State.currentUser.name || State.currentUser.email);
      avatar.title = `${State.currentUser.name} (${State.currentUser.email})`;
    }

    // Update brand name
    const brandEl = document.getElementById('app-name-link');
    if (brandEl) brandEl.textContent = State.appName;
    document.title = State.appName + ' — Task Tracker';

    // Start router
    Router.init();
  },

  /**
   * Silent token refresh — retried on expiry.
   */
  async refresh() {
    return new Promise((resolve, reject) => {
      if (!State.tokenClient) { reject(new Error('No token client')); return; }
      const original = State.tokenClient.callback;
      State.tokenClient.callback = (response) => {
        State.tokenClient.callback = original;
        if (response.error) {
          reject(new Error(response.error));
        } else {
          State.accessToken = response.access_token;
          gapi.client.setToken({ access_token: State.accessToken });
          resolve();
        }
      };
      State.tokenClient.requestAccessToken({ prompt: '' });
    });
  },

  signOut() {
    State.accessToken = null;
    State.currentUser = null;
    google.accounts.oauth2.revoke(State.accessToken ?? '', () => {});
    document.getElementById('main-app').style.display   = 'none';
    this._showSignInButton();
  },
};

/* ────────────────────────────────────────────────────────────
   SHEETS API WRAPPER
──────────────────────────────────────────────────────────── */
const Sheets = {
  BASE: 'https://sheets.googleapis.com/v4/spreadsheets',

  /**
   * Authenticated fetch with exponential backoff on 429.
   */
  async _fetch(url, options = {}, retries = 3) {
    if (!State.isOnline) throw new Error('OFFLINE');

    options.headers = {
      ...(options.headers || {}),
      Authorization: `Bearer ${State.accessToken}`,
      'Content-Type': 'application/json',
    };

    let attempt = 0;
    while (attempt <= retries) {
      const resp = await fetch(url, options);

      if (resp.status === 401) {
        // Token expired — refresh silently
        try {
          await Auth.refresh();
          options.headers.Authorization = `Bearer ${State.accessToken}`;
          attempt++;
          continue;
        } catch {
          Auth._showSignInButton();
          throw new Error('Session expired — please sign in again');
        }
      }

      if (resp.status === 429) {
        if (attempt >= retries) {
          throw new Error('Rate limit reached. Please wait a moment and try again.');
        }
        const delay = Math.pow(2, attempt) * 1000;
        await sleep(delay);
        attempt++;
        continue;
      }

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error?.message || `HTTP ${resp.status}`);
      }

      return resp.json();
    }
  },

  /**
   * Read all values from a sheet range.
   */
  async get(range) {
    const url = `${this.BASE}/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}`;
    const data = await this._fetch(url);
    return data.values || [];
  },

  /**
   * Append rows to a sheet.
   */
  async append(range, rows) {
    const url = `${this.BASE}/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    return this._fetch(url, {
      method: 'POST',
      body: JSON.stringify({ values: rows }),
    });
  },

  /**
   * Batch update multiple ranges.
   */
  async batchUpdate(data) {
    const url = `${this.BASE}/${SPREADSHEET_ID}/values:batchUpdate`;
    return this._fetch(url, {
      method: 'POST',
      body: JSON.stringify({
        valueInputOption: 'RAW',
        data,
      }),
    });
  },

  /**
   * Update a single range.
   */
  async update(range, values) {
    const url = `${this.BASE}/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
    return this._fetch(url, {
      method: 'PUT',
      body: JSON.stringify({ range, values }),
    });
  },

  /* ── Domain-specific reads ── */

  async getProjects() {
    const rows = await this.get(`${SHEETS.PROJECTS}!A:F`);
    const [, ...data] = rows; // skip header
    State.projects = (data || []).map(row => ({
      project_id:  row[0] || '',
      name:        row[1] || '',
      description: row[2] || '',
      created_by:  row[3] || '',
      created_at:  row[4] || '',
      archived:    (row[5] || '').toUpperCase() === 'TRUE',
    })).filter(p => p.project_id);
    return State.projects;
  },

  async getTasks(projectId = null) {
    const rows = await this.get(`${SHEETS.TASKS}!A:N`);
    const [, ...data] = rows;
    let tasks = (data || []).map((row, idx) => ({
      _rowIndex:   idx + 2, // 1-based, header is row 1
      task_id:     row[0]  || '',
      project_id:  row[1]  || '',
      title:       row[2]  || '',
      description: row[3]  || '',
      status:      row[4]  || STATUS.TODO,
      priority:    row[5]  || PRIORITY.MEDIUM,
      due_date:    row[6]  || '',
      labels:      row[7]  || '',
      assignees:   row[8]  || '',
      position:    parseInt(row[9] || '0', 10),
      created_by:  row[10] || '',
      created_at:  row[11] || '',
      updated_at:  row[12] || '',
      deleted:     (row[13] || '').toUpperCase() === 'TRUE',
    })).filter(t => t.task_id && !t.deleted);

    if (projectId) tasks = tasks.filter(t => t.project_id === projectId);
    State.tasks = tasks;
    return tasks;
  },

  async getActivity(projectId = null, taskId = null) {
    const rows = await this.get(`${SHEETS.ACTIVITY}!A:G`);
    const [, ...data] = rows;
    let logs = (data || []).map(row => ({
      log_id:      row[0] || '',
      project_id:  row[1] || '',
      task_id:     row[2] || '',
      actor_email: row[3] || '',
      action_type: row[4] || '',
      description: row[5] || '',
      timestamp:   row[6] || '',
    })).filter(l => l.log_id);

    if (projectId) logs = logs.filter(l => l.project_id === projectId);
    if (taskId)    logs = logs.filter(l => l.task_id    === taskId);
    return logs.reverse(); // newest first
  },

  async getUsers() {
    const rows = await this.get(`${SHEETS.USERS}!A:D`);
    const [, ...data] = rows;
    State.users = (data || []).map(row => ({
      email:    row[0] || '',
      name:     row[1] || '',
      added_at: row[2] || '',
      added_by: row[3] || '',
    })).filter(u => u.email);
    return State.users;
  },

  async getConfig() {
    const rows = await this.get(`${SHEETS.CONFIG}!A:B`);
    const [, ...data] = rows;
    const cfg = {};
    (data || []).forEach(row => {
      if (row[0]) cfg[row[0]] = row[1] || '';
    });
    State.config = cfg;
    return cfg;
  },

  /* ── Domain-specific writes ── */

  async appendProject(project) {
    return this.append(`${SHEETS.PROJECTS}!A:F`, [[
      project.project_id,
      project.name,
      project.description,
      project.created_by,
      project.created_at,
      'FALSE',
    ]]);
  },

  async appendTask(task) {
    return this.append(`${SHEETS.TASKS}!A:N`, [[
      task.task_id,
      task.project_id,
      task.title,
      task.description,
      task.status,
      task.priority,
      task.due_date,
      task.labels,
      task.assignees,
      task.position,
      task.created_by,
      task.created_at,
      task.updated_at,
      'FALSE',
    ]]);
  },

  async updateTask(task) {
    // Find actual row index from fresh read
    const rows = await this.get(`${SHEETS.TASKS}!A:N`);
    const rowIdx = rows.findIndex((r, i) => i > 0 && r[0] === task.task_id);
    if (rowIdx < 0) throw new Error('Task row not found');
    const sheetRow = rowIdx + 1;

    return this.update(`${SHEETS.TASKS}!A${sheetRow}:N${sheetRow}`, [[
      task.task_id,
      task.project_id,
      task.title,
      task.description,
      task.status,
      task.priority,
      task.due_date,
      task.labels,
      task.assignees,
      task.position,
      task.created_by,
      task.created_at,
      new Date().toISOString(),
      task.deleted ? 'TRUE' : 'FALSE',
    ]]);
  },

  /**
   * Batch update multiple task rows (for drag-drop reorder).
   */
  async batchUpdateTasks(tasks) {
    const rows = await this.get(`${SHEETS.TASKS}!A:N`);
    const data = tasks.map(task => {
      const rowIdx = rows.findIndex((r, i) => i > 0 && r[0] === task.task_id);
      if (rowIdx < 0) return null;
      const sheetRow = rowIdx + 1;
      return {
        range: `${SHEETS.TASKS}!A${sheetRow}:N${sheetRow}`,
        values: [[
          task.task_id,
          task.project_id,
          task.title,
          task.description,
          task.status,
          task.priority,
          task.due_date,
          task.labels,
          task.assignees,
          task.position,
          task.created_by,
          task.created_at,
          new Date().toISOString(),
          task.deleted ? 'TRUE' : 'FALSE',
        ]],
      };
    }).filter(Boolean);

    if (data.length === 0) return;
    return this.batchUpdate(data);
  },

  async updateProjectArchived(projectId, archived) {
    const rows = await this.get(`${SHEETS.PROJECTS}!A:F`);
    const rowIdx = rows.findIndex((r, i) => i > 0 && r[0] === projectId);
    if (rowIdx < 0) throw new Error('Project not found');
    const sheetRow = rowIdx + 1;
    // Only update column F (archived)
    const existing = rows[rowIdx];
    return this.update(`${SHEETS.PROJECTS}!F${sheetRow}`, [[archived ? 'TRUE' : 'FALSE']]);
  },

  async appendActivity(log) {
    return this.append(`${SHEETS.ACTIVITY}!A:G`, [[
      log.log_id,
      log.project_id,
      log.task_id,
      log.actor_email,
      log.action_type,
      log.description,
      log.timestamp,
    ]]);
  },

  async appendUser(user) {
    return this.append(`${SHEETS.USERS}!A:D`, [[
      user.email,
      user.name,
      user.added_at,
      user.added_by,
    ]]);
  },

  async removeUser(email) {
    const rows = await this.get(`${SHEETS.USERS}!A:D`);
    const rowIdx = rows.findIndex((r, i) => i > 0 && r[0]?.toLowerCase() === email.toLowerCase());
    if (rowIdx < 0) throw new Error('User not found');
    const sheetRow = rowIdx + 1;
    // Clear the row
    return this.update(`${SHEETS.USERS}!A${sheetRow}:D${sheetRow}`, [['', '', '', '']]);
  },

  async appendNotification(notif) {
    return this.append(`${SHEETS.NOTIFICATIONS}!A:I`, [[
      notif.notification_id,
      notif.recipient_email,
      notif.task_id,
      notif.task_title,
      notif.project_name,
      notif.assigner_email,
      notif.created_at,
      'FALSE',
      '',
    ]]);
  },
};

/* ────────────────────────────────────────────────────────────
   CONFIG
──────────────────────────────────────────────────────────── */
const Config = {
  async load() {
    try {
      const cfg = await Sheets.getConfig();
      State.appName = cfg['app_name'] || 'Task Tracker';
      const brandEl = document.getElementById('app-name-link');
      if (brandEl) brandEl.textContent = State.appName;
      document.title = State.appName + ' — Task Tracker';
    } catch (err) {
      console.warn('Config load failed:', err.message);
    }
  },
};

/* ────────────────────────────────────────────────────────────
   ACTIVITY LOGGING
──────────────────────────────────────────────────────────── */
const Activity = {
  async log(projectId, taskId, actionType, description) {
    try {
      await Sheets.appendActivity({
        log_id:      uuid(),
        project_id:  projectId || '',
        task_id:     taskId    || '',
        actor_email: State.currentUser?.email || '',
        action_type: actionType,
        description,
        timestamp:   new Date().toISOString(),
      });
    } catch (err) {
      console.warn('Activity log failed:', err.message);
    }
  },
};

/* ────────────────────────────────────────────────────────────
   NOTIFICATION QUEUE
──────────────────────────────────────────────────────────── */
const Notifications = {
  async queue(taskId, taskTitle, projectName, assigneeEmails) {
    const assignerEmail = State.currentUser?.email || '';
    for (const email of assigneeEmails) {
      try {
        await Sheets.appendNotification({
          notification_id: uuid(),
          recipient_email: email,
          task_id:         taskId,
          task_title:      taskTitle,
          project_name:    projectName,
          assigner_email:  assignerEmail,
          created_at:      new Date().toISOString(),
        });
      } catch (err) {
        console.warn(`Failed to queue notification for ${email}:`, err.message);
      }
    }
  },
};

/* ────────────────────────────────────────────────────────────
   ROUTING
──────────────────────────────────────────────────────────── */
const Router = {
  _handlers: {},
  _current:  null,

  init() {
    window.addEventListener('hashchange', () => this._dispatch());
    this._dispatch();
  },

  navigate(hash) {
    window.location.hash = hash;
  },

  _dispatch() {
    const hash = window.location.hash || '#/';
    this._updateNavActive(hash);

    // Parse route
    if (hash === '#/' || hash === '#')                         return Pages.dashboard();
    if (hash === '#/projects/new')                             return Pages.newProject();
    if (hash === '#/settings')                                 return Pages.settings();

    const boardMatch    = hash.match(/^#\/projects\/([^/]+)\/board/);
    if (boardMatch)                                            return Pages.board(boardMatch[1], hash);

    const activityMatch = hash.match(/^#\/projects\/([^/]+)\/activity/);
    if (activityMatch)                                         return Pages.activity(activityMatch[1]);

    const taskMatch     = hash.match(/^#\/tasks\/([^?]+)/);
    const newTaskMatch  = hash.match(/^#\/tasks\/new/);
    if (newTaskMatch)                                          return Pages.newTask(hash);
    if (taskMatch)                                             return Pages.taskDetail(taskMatch[1]);

    // 404 fallback
    Pages.dashboard();
  },

  _updateNavActive(hash) {
    document.querySelectorAll('.nav-link').forEach(el => el.classList.remove('active'));
    if (hash === '#/' || hash === '#')          document.getElementById('nav-dashboard')?.classList.add('active');
    if (hash.startsWith('#/settings'))          document.getElementById('nav-settings')?.classList.add('active');
  },
};

/* ────────────────────────────────────────────────────────────
   DOM HELPERS
──────────────────────────────────────────────────────────── */
function renderPage(templateId) {
  const tpl = document.getElementById(templateId);
  if (!tpl) return null;
  const content = document.getElementById('page-content');
  content.innerHTML = '';
  const clone = tpl.content.cloneNode(true);
  content.appendChild(clone);
  return content;
}

function loadingPage() {
  const content = document.getElementById('page-content');
  content.innerHTML = `
    <div class="empty-state" style="padding:80px 0;">
      <div class="spinner lg"></div>
      <p style="color:var(--color-text-faint);font-size:0.875rem;margin-top:12px;">Loading…</p>
    </div>`;
}

function errorPage(message, retryFn) {
  const content = document.getElementById('page-content');
  content.innerHTML = `
    <div class="empty-state" style="padding:80px 0;">
      <svg xmlns="http://www.w3.org/2000/svg" class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <p class="empty-state-title">Something went wrong</p>
      <p class="empty-state-desc">${message}</p>
      ${retryFn ? '<button class="btn btn-secondary" onclick="window.__retryFn && window.__retryFn()">Retry</button>' : ''}
    </div>`;
  if (retryFn) window.__retryFn = retryFn;
}

/* ────────────────────────────────────────────────────────────
   TAG INPUT WIDGET
──────────────────────────────────────────────────────────── */
function createTagInput(containerId, inputId, initialValues = []) {
  const container = document.getElementById(containerId);
  const input     = document.getElementById(inputId);
  if (!container || !input) return { getValues: () => [] };

  let tags = [...initialValues];

  function renderTags() {
    // Remove existing tag elements
    container.querySelectorAll('.tag').forEach(t => t.remove());
    tags.forEach((tag, i) => {
      const el = document.createElement('span');
      el.className = 'tag';
      el.innerHTML = `${escapeHtml(tag)}<button class="tag-remove" aria-label="Remove ${escapeHtml(tag)}">×</button>`;
      el.querySelector('.tag-remove').addEventListener('click', () => {
        tags.splice(i, 1);
        renderTags();
      });
      container.insertBefore(el, input);
    });
  }

  function addTag(value) {
    const v = value.trim();
    if (v && !tags.includes(v)) {
      tags.push(v);
      renderTags();
    }
    input.value = '';
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(input.value);
    }
    if (e.key === 'Backspace' && input.value === '' && tags.length > 0) {
      tags.pop();
      renderTags();
    }
  });

  input.addEventListener('blur', () => {
    if (input.value.trim()) addTag(input.value);
  });

  container.addEventListener('click', () => input.focus());

  renderTags();

  return {
    getValues:  () => [...tags],
    setValues:  (v) => { tags = [...v]; renderTags(); },
  };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ────────────────────────────────────────────────────────────
   PAGE: DASHBOARD
──────────────────────────────────────────────────────────── */
const Pages = {

  async dashboard() {
    loadingPage();
    try {
      const [projects, tasks] = await Promise.all([
        Sheets.getProjects(),
        Sheets.getTasks(),
      ]);

      renderPage('tpl-dashboard');
      const grid = document.getElementById('project-grid');
      const active = projects.filter(p => !p.archived);

      if (active.length === 0) {
        grid.innerHTML = `
          <div class="empty-state" style="grid-column:1/-1;padding:60px 0;">
            <svg xmlns="http://www.w3.org/2000/svg" class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
            <p class="empty-state-title">No projects yet</p>
            <p class="empty-state-desc">Create your first project to get started.</p>
            <a href="#/projects/new" class="btn btn-primary" style="margin-top:12px;">New Project</a>
          </div>`;
        return;
      }

      active.forEach(project => {
        const projectTasks = tasks.filter(t => t.project_id === project.project_id);
        const counts = {
          todo:        projectTasks.filter(t => t.status === STATUS.TODO).length,
          in_progress: projectTasks.filter(t => t.status === STATUS.IN_PROGRESS).length,
          done:        projectTasks.filter(t => t.status === STATUS.DONE).length,
        };

        const card = document.createElement('a');
        card.className = 'project-card';
        card.href = `#/projects/${project.project_id}/board`;
        card.innerHTML = `
          <h2 style="font-size:1rem;font-weight:600;margin-bottom:6px;">${escapeHtml(project.name)}</h2>
          ${project.description ? `<p style="color:var(--color-text-muted);font-size:0.8125rem;margin-bottom:12px;line-height:1.5;">${escapeHtml(project.description)}</p>` : '<div style="height:8px;"></div>'}
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <span class="badge badge-todo">
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>
              ${counts.todo} todo
            </span>
            <span class="badge badge-inprogress">
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.18-3.56"/></svg>
              ${counts.in_progress} in progress
            </span>
            <span class="badge badge-done">
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              ${counts.done} done
            </span>
          </div>
          <p style="color:var(--color-text-faint);font-size:0.75rem;margin-top:10px;">${projectTasks.length} task${projectTasks.length !== 1 ? 's' : ''} total</p>
        `;
        grid.appendChild(card);
      });

    } catch (err) {
      errorPage(err.message, () => this.dashboard());
    }
  },

  /* ── KANBAN BOARD ── */

  async board(projectId, fullHash) {
    loadingPage();

    // Parse filters from hash query string
    const queryStr = fullHash.includes('?') ? fullHash.split('?')[1] : '';
    const params   = new URLSearchParams(queryStr);

    let filters = {
      search:   params.get('search')   || '',
      assignee: params.get('assignee') || '',
      priority: params.get('priority') || '',
      label:    params.get('label')    || '',
      dueFrom:  params.get('dueFrom')  || '',
      dueTo:    params.get('dueTo')    || '',
    };

    try {
      const [projects, allTasks] = await Promise.all([
        Sheets.getProjects(),
        Sheets.getTasks(projectId),
      ]);

      const project = projects.find(p => p.project_id === projectId);
      if (!project) { errorPage('Project not found.'); return; }

      renderPage('tpl-board');

      // Populate project info
      document.getElementById('board-project-name').textContent = project.name;
      document.getElementById('board-project-desc').textContent = project.description || '';
      document.getElementById('board-activity-link').href = `#/projects/${projectId}/activity`;
      document.getElementById('board-add-task-btn').addEventListener('click', () => {
        Router.navigate(`#/tasks/new?project=${projectId}`);
      });

      // Populate filter bar
      this._initBoardFilters(projectId, allTasks, filters);

      // Build board
      this._renderKanban(projectId, allTasks, filters, project);

    } catch (err) {
      errorPage(err.message, () => this.board(projectId, fullHash));
    }
  },

  _initBoardFilters(projectId, tasks, filters) {
    const searchEl    = document.getElementById('filter-search');
    const assigneeEl  = document.getElementById('filter-assignee');
    const priorityEl  = document.getElementById('filter-priority');
    const labelEl     = document.getElementById('filter-label');
    const dueFromEl   = document.getElementById('filter-due-from');
    const dueToEl     = document.getElementById('filter-due-to');
    const clearBtn    = document.getElementById('filter-clear-btn');

    if (!searchEl) return;

    // Populate assignee options
    const allAssignees = new Set();
    tasks.forEach(t => parseList(t.assignees).forEach(a => allAssignees.add(a)));
    allAssignees.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a; opt.textContent = a;
      assigneeEl.appendChild(opt);
    });

    // Set initial values
    searchEl.value   = filters.search;
    assigneeEl.value = filters.assignee;
    priorityEl.value = filters.priority;
    labelEl.value    = filters.label;
    dueFromEl.value  = filters.dueFrom;
    dueToEl.value    = filters.dueTo;

    const update = () => {
      filters.search   = searchEl.value;
      filters.assignee = assigneeEl.value;
      filters.priority = priorityEl.value;
      filters.label    = labelEl.value;
      filters.dueFrom  = dueFromEl.value;
      filters.dueTo    = dueToEl.value;
      this._applyFilters(projectId, filters);
    };

    [searchEl, assigneeEl, priorityEl, labelEl, dueFromEl, dueToEl].forEach(el => {
      el.addEventListener('input', update);
      el.addEventListener('change', update);
    });

    clearBtn.addEventListener('click', () => {
      searchEl.value = assigneeEl.value = priorityEl.value = labelEl.value = dueFromEl.value = dueToEl.value = '';
      filters = { search: '', assignee: '', priority: '', label: '', dueFrom: '', dueTo: '' };
      this._applyFilters(projectId, filters);
    });

    // Sync global search bar
    const globalSearch = document.getElementById('global-search');
    if (globalSearch) {
      globalSearch.value = filters.search;
      globalSearch.addEventListener('input', () => {
        searchEl.value = globalSearch.value;
        update();
      });
    }
  },

  _applyFilters(projectId, filters) {
    // Update URL without page reload
    const parts = [];
    if (filters.search)   parts.push(`search=${encodeURIComponent(filters.search)}`);
    if (filters.assignee) parts.push(`assignee=${encodeURIComponent(filters.assignee)}`);
    if (filters.priority) parts.push(`priority=${encodeURIComponent(filters.priority)}`);
    if (filters.label)    parts.push(`label=${encodeURIComponent(filters.label)}`);
    if (filters.dueFrom)  parts.push(`dueFrom=${encodeURIComponent(filters.dueFrom)}`);
    if (filters.dueTo)    parts.push(`dueTo=${encodeURIComponent(filters.dueTo)}`);
    const qs = parts.length ? '?' + parts.join('&') : '';
    history.replaceState(null, '', `#/projects/${projectId}/board${qs}`);

    // Re-render cards with filter
    const filtered = this._filterTasks(State.tasks, filters);
    ['todo', 'in_progress', 'done'].forEach(status => {
      const list = document.querySelector(`[data-status="${status}"] .kanban-list`);
      if (!list) return;
      list.innerHTML = '';
      const colTasks = filtered.filter(t => t.status === status)
                                .sort((a, b) => a.position - b.position);
      if (colTasks.length === 0) {
        list.innerHTML = this._emptyColHtml();
      } else {
        colTasks.forEach(t => list.appendChild(this._buildTaskCard(t)));
      }
    });
  },

  _filterTasks(tasks, filters) {
    return tasks.filter(task => {
      if (filters.search) {
        const q = filters.search.toLowerCase();
        if (!task.title.toLowerCase().includes(q) && !task.description.toLowerCase().includes(q)) return false;
      }
      if (filters.assignee && !parseList(task.assignees).includes(filters.assignee)) return false;
      if (filters.priority && task.priority !== filters.priority) return false;
      if (filters.label && !parseList(task.labels).some(l => l.toLowerCase().includes(filters.label.toLowerCase()))) return false;
      if (filters.dueFrom && task.due_date && task.due_date < filters.dueFrom) return false;
      if (filters.dueTo   && task.due_date && task.due_date > filters.dueTo)   return false;
      return true;
    });
  },

  _renderKanban(projectId, tasks, filters, project) {
    const board = document.getElementById('kanban-board');
    if (!board) return;
    board.innerHTML = '';

    const columns = [
      { status: STATUS.TODO,        label: 'To Do',       color: 'var(--color-text-muted)' },
      { status: STATUS.IN_PROGRESS, label: 'In Progress', color: 'var(--color-info)' },
      { status: STATUS.DONE,        label: 'Done',        color: 'var(--color-success)' },
    ];

    const filtered = this._filterTasks(tasks, filters);

    columns.forEach(col => {
      const colTasks = filtered.filter(t => t.status === col.status)
                                .sort((a, b) => a.position - b.position);

      const colEl = document.createElement('div');
      colEl.className = 'kanban-col';
      colEl.dataset.status = col.status;

      const count = tasks.filter(t => t.status === col.status).length;

      colEl.innerHTML = `
        <div class="kanban-col-header">
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="kanban-col-title" style="color:${col.color};">${col.label}</span>
            <span style="background:var(--color-surface-3);color:var(--color-text-muted);font-size:0.7rem;font-weight:600;padding:1px 7px;border-radius:99px;">${count}</span>
          </div>
          <div style="display:flex;align-items:center;gap:4px;">
            <button class="btn btn-ghost btn-icon" style="padding:4px;" title="Add task to ${col.label}" data-status="${col.status}" data-project="${projectId}" onclick="Pages._addTaskForColumn(this)">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <button class="btn btn-ghost btn-icon col-collapse-btn" style="padding:4px;" title="Collapse column" aria-label="Collapse" onclick="Pages._toggleColCollapse(this)">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="chevron-icon"><path d="m18 15-6-6-6 6"/></svg>
            </button>
          </div>
        </div>
        <div class="kanban-list" data-status="${col.status}">
          ${colTasks.length === 0 ? this._emptyColHtml() : ''}
        </div>
      `;

      if (colTasks.length > 0) {
        const list = colEl.querySelector('.kanban-list');
        colTasks.forEach(t => list.appendChild(this._buildTaskCard(t)));
      }

      board.appendChild(colEl);

      // Init SortableJS
      this._initSortable(colEl.querySelector('.kanban-list'), projectId, project);
    });
  },

  _addTaskForColumn(btn) {
    const status    = btn.dataset.status;
    const projectId = btn.dataset.project;
    Router.navigate(`#/tasks/new?project=${projectId}&status=${status}`);
  },

  _toggleColCollapse(btn) {
    const col = btn.closest('.kanban-col');
    col.classList.toggle('collapsed');
    const icon = btn.querySelector('.chevron-icon');
    if (icon) icon.style.transform = col.classList.contains('collapsed') ? 'rotate(180deg)' : '';
  },

  _emptyColHtml() {
    return `<div class="empty-state" style="padding:24px 16px;pointer-events:none;">
      <p style="color:var(--color-text-faint);font-size:0.8125rem;">No tasks here</p>
    </div>`;
  },

  _buildTaskCard(task) {
    const overdue   = isOverdue(task.due_date, task.status);
    const assignees = parseList(task.assignees);
    const labels    = parseList(task.labels);

    const card = document.createElement('div');
    card.className = `task-card${overdue ? ' overdue' : ''}`;
    card.dataset.taskId = task.task_id;

    const priorityColors = { low: 'var(--pri-low)', medium: 'var(--pri-medium)', high: 'var(--pri-high)' };
    const priColor = priorityColors[task.priority] || priorityColors.medium;

    card.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px;">
        <p class="task-card-title">${escapeHtml(task.title)}</p>
        <span style="width:8px;height:8px;border-radius:50%;background:${priColor};flex-shrink:0;margin-top:5px;" title="Priority: ${task.priority}"></span>
      </div>
      ${labels.length > 0 ? `
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;">
          ${labels.map(l => `<span class="badge badge-label">${escapeHtml(l)}</span>`).join('')}
        </div>` : ''}
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:6px;">
        <div style="display:flex;align-items:center;gap:-4px;">
          ${assignees.slice(0, 3).map(a => `<div class="avatar sm" title="${escapeHtml(a)}" style="margin-right:-6px;border-color:var(--color-surface-2);">${initials(a)}</div>`).join('')}
          ${assignees.length > 3 ? `<span style="font-size:0.7rem;color:var(--color-text-faint);margin-left:10px;">+${assignees.length - 3}</span>` : ''}
        </div>
        ${task.due_date ? `
          <span style="font-size:0.7rem;${overdue ? 'color:var(--color-danger);font-weight:600;' : 'color:var(--color-text-faint);'}">
            ${overdue ? '⚠ ' : ''}${formatDate(task.due_date)}
          </span>` : ''}
      </div>
    `;

    card.addEventListener('click', () => Router.navigate(`#/tasks/${task.task_id}`));
    return card;
  },

  _initSortable(listEl, projectId, project) {
    new Sortable(listEl, {
      group:     'kanban',
      animation: 150,
      ghostClass:    'sortable-ghost',
      dragClass:     'sortable-drag',
      chosenClass:   'sortable-chosen',
      handle:        '.task-card',
      onStart: () => {
        // Snapshot current task order for rollback
        State._dragSnapshot = State.tasks.map(t => ({ ...t }));
      },
      onEnd: async (evt) => {
        const taskId    = evt.item.dataset.taskId;
        const newStatus = evt.to.dataset.status;
        const task      = State.tasks.find(t => t.task_id === taskId);
        if (!task) return;

        const oldStatus = task.status;

        // Collect new order in each affected column
        const tasksToUpdate = [];

        [evt.from, evt.to].filter((el, i, arr) => arr.indexOf(el) === i).forEach(col => {
          const status    = col.dataset.status;
          const cardEls   = Array.from(col.querySelectorAll('.task-card'));
          cardEls.forEach((card, i) => {
            const t = State.tasks.find(t => t.task_id === card.dataset.taskId);
            if (t) {
              t.status   = status;
              t.position = (i + 1) * 10;
              tasksToUpdate.push({ ...t });
            }
          });
        });

        // Also update the moved task's status
        task.status = newStatus;

        // Remove empty state placeholders
        [evt.from, evt.to].forEach(col => {
          col.querySelectorAll('.empty-state').forEach(e => e.remove());
          if (col.querySelectorAll('.task-card').length === 0) {
            col.innerHTML = Pages._emptyColHtml();
          }
        });

        // Update column header counts
        ['todo', 'in_progress', 'done'].forEach(s => {
          const countEl = document.querySelector(`[data-status="${s}"]`)
            ?.closest('.kanban-col')
            ?.querySelector('.kanban-col-header span:nth-child(2)');
          if (countEl) countEl.textContent = State.tasks.filter(t => t.status === s).length;
        });

        if (!State.isOnline) {
          Toast.warning('You are offline. Changes will not be saved.');
          this._rollbackDrag();
          return;
        }

        try {
          await Sheets.batchUpdateTasks(tasksToUpdate);
          await Activity.log(
            projectId,
            taskId,
            'task_moved',
            `Task "${task.title}" moved from ${STATUS_LABEL[oldStatus] || oldStatus} to ${STATUS_LABEL[newStatus] || newStatus}`
          );
        } catch (err) {
          Toast.error(`Failed to update — please try again`);
          this._rollbackDrag();
          // Visual snap-back
          evt.item.classList.add('snap-back');
          setTimeout(() => evt.item.classList.remove('snap-back'), 300);
        }
      },
    });
  },

  _rollbackDrag() {
    if (!State._dragSnapshot) return;
    State.tasks = State._dragSnapshot;
    State._dragSnapshot = null;
    // Re-render the page using the current hash (restores board with original task positions)
    Router._dispatch();
  },

  /* ── TASK DETAIL ── */

  async taskDetail(taskId) {
    loadingPage();
    try {
      const tasks = await Sheets.getTasks();
      const task  = tasks.find(t => t.task_id === taskId);

      if (!task) {
        // Check if deleted
        const allRows = await Sheets.get(`${SHEETS.TASKS}!A:N`);
        const found   = allRows.find((r, i) => i > 0 && r[0] === taskId);
        if (found && (found[13] || '').toUpperCase() === 'TRUE') {
          renderPage('tpl-deleted-task');
          const project = State.projects.find(p => p.project_id === found[1]);
          const boardLink = document.getElementById('deleted-task-board-link');
          if (boardLink) boardLink.href = project ? `#/projects/${project.project_id}/board` : '#/';
          return;
        }
        errorPage('Task not found.', () => Router.navigate('#/'));
        return;
      }

      renderPage('tpl-task');

      // Back link
      const project  = State.projects.find(p => p.project_id === task.project_id);
      const backLink = document.getElementById('task-back-link');
      if (backLink) backLink.href = project ? `#/projects/${project.project_id}/board` : '#/';

      // Populate fields
      document.getElementById('task-title-input').value  = task.title;
      document.getElementById('task-desc-input').value   = task.description;
      document.getElementById('task-status-input').value = task.status;
      document.getElementById('task-priority-input').value = task.priority;
      document.getElementById('task-due-input').value    = task.due_date;

      const labelsWidget    = createTagInput('task-labels-container',    'task-labels-input',    parseList(task.labels));
      const assigneesWidget = createTagInput('task-assignees-container', 'task-assignees-input', parseList(task.assignees));

      // Load activity
      this._loadTaskActivity(task.project_id, taskId);

      // Save
      const saveBtn = document.getElementById('task-save-btn');
      saveBtn.addEventListener('click', async () => {
        const title = document.getElementById('task-title-input').value.trim();
        if (!title) {
          const errEl = document.getElementById('task-title-error');
          errEl.textContent = 'Title is required';
          errEl.style.display = 'block';
          return;
        }
        document.getElementById('task-title-error').style.display = 'none';

        if (!State.isOnline) { Toast.warning('You are offline.'); return; }

        saveBtn.disabled = true;
        saveBtn.innerHTML = `<span class="spinner sm"></span> Saving…`;

        const newAssignees = assigneesWidget.getValues();
        const oldAssignees = parseList(task.assignees);
        const addedAssignees = newAssignees.filter(a => !oldAssignees.includes(a));

        const updated = {
          ...task,
          title:       title,
          description: document.getElementById('task-desc-input').value,
          status:      document.getElementById('task-status-input').value,
          priority:    document.getElementById('task-priority-input').value,
          due_date:    document.getElementById('task-due-input').value,
          labels:      serializeList(labelsWidget.getValues()),
          assignees:   serializeList(newAssignees),
          updated_at:  new Date().toISOString(),
        };

        try {
          await Sheets.updateTask(updated);
          await Activity.log(task.project_id, taskId, 'task_updated', `Task "${updated.title}" updated`);

          // Queue notifications for new assignees
          if (addedAssignees.length > 0 && project) {
            await Notifications.queue(taskId, updated.title, project.name, addedAssignees);
          }

          // Update local cache
          const idx = State.tasks.findIndex(t => t.task_id === taskId);
          if (idx >= 0) State.tasks[idx] = updated;

          Toast.success('Task saved');
          saveBtn.disabled = false;
          saveBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save Changes`;
        } catch (err) {
          Toast.error(`Failed to save: ${err.message}`);
          saveBtn.disabled = false;
          saveBtn.innerHTML = 'Save Changes';
        }
      });

      // Delete (soft)
      document.getElementById('task-delete-btn').addEventListener('click', () => {
        showConfirmModal('Delete Task', `Are you sure you want to delete "${task.title}"? This cannot be undone.`, async () => {
          if (!State.isOnline) { Toast.warning('You are offline.'); return; }
          try {
            await Sheets.updateTask({ ...task, deleted: true, updated_at: new Date().toISOString() });
            await Activity.log(task.project_id, taskId, 'task_deleted', `Task "${task.title}" deleted`);
            Toast.success('Task deleted');
            Router.navigate(project ? `#/projects/${project.project_id}/board` : '#/');
          } catch (err) {
            Toast.error(`Failed to delete: ${err.message}`);
          }
        });
      });

    } catch (err) {
      errorPage(err.message, () => this.taskDetail(taskId));
    }
  },

  async _loadTaskActivity(projectId, taskId) {
    try {
      const logs = await Sheets.getActivity(projectId, taskId);
      const listEl = document.getElementById('task-activity-list');
      if (!listEl) return;

      if (logs.length === 0) {
        listEl.innerHTML = `<div class="empty-state" style="padding:24px;"><p class="text-faint" style="font-size:0.875rem;">No activity yet</p></div>`;
        return;
      }

      listEl.innerHTML = '';
      logs.slice(0, 20).forEach(log => {
        const el = document.createElement('div');
        el.className = 'activity-item';
        el.innerHTML = `
          <div class="activity-dot"></div>
          <div style="flex:1;min-width:0;">
            <p style="font-size:0.8125rem;margin:0;">
              <strong style="color:var(--color-text);">${escapeHtml(log.actor_email)}</strong>
              <span class="text-muted"> ${escapeHtml(log.description)}</span>
            </p>
            <p style="font-size:0.75rem;color:var(--color-text-faint);margin:2px 0 0;" title="${escapeHtml(log.timestamp)}">${relativeTime(log.timestamp)}</p>
          </div>
        `;
        listEl.appendChild(el);
      });
    } catch (err) {
      console.warn('Failed to load task activity:', err.message);
    }
  },

  /* ── NEW PROJECT ── */

  newProject() {
    renderPage('tpl-new-project');

    const form    = document.getElementById('new-project-form');
    const nameEl  = document.getElementById('np-name');
    const descEl  = document.getElementById('np-desc');
    const submitBtn = document.getElementById('np-submit-btn');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = nameEl.value.trim();
      if (!name) {
        const errEl = document.getElementById('np-name-error');
        errEl.textContent = 'Project name is required';
        errEl.style.display = 'block';
        nameEl.focus();
        return;
      }
      document.getElementById('np-name-error').style.display = 'none';

      if (!State.isOnline) { Toast.warning('You are offline.'); return; }

      submitBtn.disabled = true;
      submitBtn.innerHTML = `<span class="spinner sm"></span> Creating…`;

      const projectId = uuid();
      const now       = new Date().toISOString();

      try {
        await Sheets.appendProject({
          project_id:  projectId,
          name,
          description: descEl.value.trim(),
          created_by:  State.currentUser?.email || '',
          created_at:  now,
        });
        await Activity.log(projectId, '', 'project_created', `Project "${name}" created`);
        State.projects = []; // invalidate cache
        Toast.success(`Project "${name}" created`);
        Router.navigate(`#/projects/${projectId}/board`);
      } catch (err) {
        Toast.error(`Failed to create project: ${err.message}`);
        submitBtn.disabled = false;
        submitBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Create Project`;
      }
    });
  },

  /* ── NEW TASK ── */

  newTask(fullHash) {
    const queryStr  = fullHash.includes('?') ? fullHash.split('?')[1] : '';
    const params    = new URLSearchParams(queryStr);
    const projectId = params.get('project') || '';
    const initStatus = params.get('status') || STATUS.TODO;

    renderPage('tpl-new-task');

    // Back link
    const backLink   = document.getElementById('nt-back-link');
    const cancelLink = document.getElementById('nt-cancel-link');
    const backHref   = projectId ? `#/projects/${projectId}/board` : '#/';
    if (backLink)   backLink.href   = backHref;
    if (cancelLink) cancelLink.href = backHref;

    // Set default status
    const statusEl = document.getElementById('nt-status');
    if (statusEl) statusEl.value = initStatus;

    const labelsWidget    = createTagInput('nt-labels-container',    'nt-labels-input');
    const assigneesWidget = createTagInput('nt-assignees-container', 'nt-assignees-input');

    const form      = document.getElementById('new-task-form');
    const submitBtn = document.getElementById('nt-submit-btn');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = document.getElementById('nt-title').value.trim();
      if (!title) {
        const errEl = document.getElementById('nt-title-error');
        errEl.textContent = 'Title is required';
        errEl.style.display = 'block';
        document.getElementById('nt-title').focus();
        return;
      }
      document.getElementById('nt-title-error').style.display = 'none';

      if (!State.isOnline) { Toast.warning('You are offline.'); return; }

      submitBtn.disabled = true;
      submitBtn.innerHTML = `<span class="spinner sm"></span> Creating…`;

      const taskId   = uuid();
      const now      = new Date().toISOString();
      const assignees = assigneesWidget.getValues();

      // Compute position: max position in status column + 10
      const status   = statusEl.value;
      const existing = State.tasks.filter(t => t.project_id === projectId && t.status === status);
      const position = existing.length > 0
        ? Math.max(...existing.map(t => t.position)) + 10
        : 10;

      const task = {
        task_id:     taskId,
        project_id:  projectId,
        title,
        description: document.getElementById('nt-desc').value.trim(),
        status,
        priority:    document.getElementById('nt-priority').value,
        due_date:    document.getElementById('nt-due').value,
        labels:      serializeList(labelsWidget.getValues()),
        assignees:   serializeList(assignees),
        position,
        created_by:  State.currentUser?.email || '',
        created_at:  now,
        updated_at:  now,
        deleted:     false,
      };

      try {
        await Sheets.appendTask(task);
        await Activity.log(projectId, taskId, 'task_created', `Task "${title}" created`);

        const project = State.projects.find(p => p.project_id === projectId);
        if (assignees.length > 0 && project) {
          await Notifications.queue(taskId, title, project.name, assignees);
        }

        State.tasks.push(task);
        Toast.success(`Task "${title}" created`);
        Router.navigate(projectId ? `#/projects/${projectId}/board` : '#/');
      } catch (err) {
        Toast.error(`Failed to create task: ${err.message}`);
        submitBtn.disabled = false;
        submitBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Create Task`;
      }
    });
  },

  /* ── ACTIVITY LOG ── */

  async activity(projectId) {
    loadingPage();
    try {
      const [projects, logs] = await Promise.all([
        Sheets.getProjects(),
        Sheets.getActivity(projectId),
      ]);

      const project = projects.find(p => p.project_id === projectId);
      renderPage('tpl-activity');

      const backLink = document.getElementById('activity-back-link');
      if (backLink) backLink.href = `#/projects/${projectId}/board`;

      const pageTitle = document.querySelector('#page-content .page-title');
      if (pageTitle && project) pageTitle.textContent = `${project.name} — Activity`;

      let offset = 0;
      const listEl   = document.getElementById('activity-list');
      const moreWrap = document.getElementById('activity-load-more');
      const loadBtn  = document.getElementById('activity-load-btn');

      const renderPage_ = (items) => {
        if (items.length === 0 && offset === 0) {
          listEl.innerHTML = `<div class="empty-state" style="padding:40px;"><p class="empty-state-title">No activity yet</p></div>`;
          return;
        }
        items.forEach(log => {
          const el = document.createElement('div');
          el.className = 'activity-item';
          el.innerHTML = `
            <div class="activity-dot"></div>
            <div style="flex:1;min-width:0;">
              <p style="margin:0;font-size:0.875rem;">
                <strong style="color:var(--color-text);">${escapeHtml(log.actor_email)}</strong>
                <span class="badge" style="margin-left:6px;background:var(--color-surface-3);color:var(--color-text-faint);">${escapeHtml(log.action_type)}</span>
              </p>
              <p style="color:var(--color-text-muted);font-size:0.8125rem;margin:2px 0 4px;">${escapeHtml(log.description)}</p>
              <p style="color:var(--color-text-faint);font-size:0.75rem;margin:0;" title="${escapeHtml(log.timestamp)}">${formatDateTime(log.timestamp)}</p>
            </div>
          `;
          listEl.appendChild(el);
        });
      };

      renderPage_(logs.slice(0, ACTIVITY_PAGE_SIZE));
      offset = ACTIVITY_PAGE_SIZE;

      if (logs.length > offset) {
        moreWrap.style.display = 'block';
      }

      loadBtn?.addEventListener('click', () => {
        const next = logs.slice(offset, offset + ACTIVITY_PAGE_SIZE);
        renderPage_(next);
        offset += ACTIVITY_PAGE_SIZE;
        if (offset >= logs.length) moreWrap.style.display = 'none';
      });

    } catch (err) {
      errorPage(err.message, () => this.activity(projectId));
    }
  },

  /* ── SETTINGS ── */

  async settings() {
    loadingPage();
    try {
      const [users, projects] = await Promise.all([
        Sheets.getUsers(),
        Sheets.getProjects(),
      ]);

      renderPage('tpl-settings');

      this._renderUsersTable(users);
      this._renderSettingsProjects(projects);

      // Add user form toggle
      const addBtn = document.getElementById('settings-add-user-btn');
      const formWrap = document.getElementById('add-user-form-wrap');
      addBtn?.addEventListener('click', () => {
        const visible = formWrap.style.display !== 'none';
        formWrap.style.display = visible ? 'none' : 'block';
        if (!visible) document.getElementById('new-user-email').focus();
      });

      // Add user submit
      document.getElementById('add-user-submit-btn')?.addEventListener('click', async () => {
        const email = document.getElementById('new-user-email').value.trim();
        const name  = document.getElementById('new-user-name').value.trim();
        const errEl = document.getElementById('add-user-error');

        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          errEl.textContent = 'Please enter a valid email address';
          errEl.style.display = 'block';
          return;
        }
        errEl.style.display = 'none';

        if (!State.isOnline) { Toast.warning('You are offline.'); return; }

        const submitBtn = document.getElementById('add-user-submit-btn');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Adding…';

        try {
          await Sheets.appendUser({
            email,
            name,
            added_at: new Date().toISOString(),
            added_by: State.currentUser?.email || '',
          });
          await Sheets.getUsers(); // refresh cache

          Toast.success(`${email} added to team`);
          formWrap.style.display = 'none';
          document.getElementById('new-user-email').value = '';
          document.getElementById('new-user-name').value  = '';
          this._renderUsersTable(State.users);
        } catch (err) {
          Toast.error(`Failed to add user: ${err.message}`);
        } finally {
          submitBtn.disabled  = false;
          submitBtn.textContent = 'Add';
        }
      });

    } catch (err) {
      errorPage(err.message, () => this.settings());
    }
  },

  _renderUsersTable(users) {
    const wrap = document.getElementById('users-table-wrap');
    if (!wrap) return;

    if (users.length === 0) {
      wrap.innerHTML = `<div class="empty-state" style="padding:32px;"><p class="empty-state-title">No team members yet</p></div>`;
      return;
    }

    const rows = users.filter(u => u.email).map(user => `
      <tr>
        <td data-label="Member">
          <div style="display:flex;align-items:center;gap:10px;">
            <div class="avatar sm">${initials(user.name || user.email)}</div>
            <div>
              <p style="font-weight:500;margin:0;">${escapeHtml(user.name || '—')}</p>
              <p style="color:var(--color-text-faint);font-size:0.75rem;margin:0;">${escapeHtml(user.email)}</p>
            </div>
          </div>
        </td>
        <td data-label="Added">${formatDate(user.added_at)}</td>
        <td data-label="Added By">${escapeHtml(user.added_by || '—')}</td>
        <td data-label="Actions" style="text-align:right;">
          <button class="btn btn-ghost btn-sm" style="color:var(--color-danger);" data-email="${escapeHtml(user.email)}" onclick="Pages._removeUser(this)">
            Remove
          </button>
        </td>
      </tr>
    `).join('');

    wrap.innerHTML = `
      <table class="data-table">
        <thead><tr><th>Member</th><th>Added</th><th>Added By</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  },

  async _removeUser(btn) {
    const email = btn.dataset.email;
    if (!confirm(`Remove ${email} from the team?`)) return;
    if (!State.isOnline) { Toast.warning('You are offline.'); return; }

    btn.disabled = true;
    try {
      await Sheets.removeUser(email);
      await Sheets.getUsers();
      this._renderUsersTable(State.users);
      Toast.success(`${email} removed`);
    } catch (err) {
      Toast.error(`Failed to remove user: ${err.message}`);
      btn.disabled = false;
    }
  },

  _renderSettingsProjects(projects) {
    const wrap = document.getElementById('settings-projects-list');
    if (!wrap) return;

    if (projects.length === 0) {
      wrap.innerHTML = `<div class="empty-state" style="padding:32px;"><p class="empty-state-title">No projects yet</p></div>`;
      return;
    }

    const rows = projects.map(project => `
      <tr>
        <td data-label="Project">
          <div>
            <p style="font-weight:500;margin:0;">${escapeHtml(project.name)}</p>
            ${project.description ? `<p style="color:var(--color-text-faint);font-size:0.75rem;margin:2px 0 0;">${escapeHtml(project.description)}</p>` : ''}
          </div>
        </td>
        <td data-label="Status">
          <span class="badge ${project.archived ? 'badge-todo' : 'badge-done'}">${project.archived ? 'Archived' : 'Active'}</span>
        </td>
        <td data-label="Created">${formatDate(project.created_at)}</td>
        <td data-label="Actions" style="text-align:right;">
          <div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;">
            ${!project.archived ? `
              <a href="#/projects/${project.project_id}/board" class="btn btn-secondary btn-sm">Open</a>
              <button class="btn btn-ghost btn-sm" data-project-id="${escapeHtml(project.project_id)}" data-project-name="${escapeHtml(project.name)}" onclick="Pages._archiveProject(this, true)">Archive</button>
            ` : `
              <button class="btn btn-secondary btn-sm" data-project-id="${escapeHtml(project.project_id)}" data-project-name="${escapeHtml(project.name)}" onclick="Pages._archiveProject(this, false)">Unarchive</button>
            `}
          </div>
        </td>
      </tr>
    `).join('');

    wrap.innerHTML = `
      <table class="data-table">
        <thead><tr><th>Project</th><th>Status</th><th>Created</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  },

  async _archiveProject(btn, archive) {
    const projectId   = btn.dataset.projectId;
    const projectName = btn.dataset.projectName;
    if (!State.isOnline) { Toast.warning('You are offline.'); return; }

    btn.disabled = true;
    try {
      await Sheets.updateProjectArchived(projectId, archive);
      await Activity.log(projectId, '', archive ? 'project_archived' : 'project_unarchived', `Project "${projectName}" ${archive ? 'archived' : 'unarchived'}`);
      const projects = await Sheets.getProjects();
      this._renderSettingsProjects(projects);
      Toast.success(`Project "${projectName}" ${archive ? 'archived' : 'unarchived'}`);
    } catch (err) {
      Toast.error(`Failed: ${err.message}`);
      btn.disabled = false;
    }
  },
};

/* ────────────────────────────────────────────────────────────
   CONFIRM MODAL
──────────────────────────────────────────────────────────── */
function showConfirmModal(title, message, onConfirm) {
  const modal  = document.getElementById('confirm-modal');
  const titleEl = document.getElementById('confirm-modal-title');
  const msgEl  = document.getElementById('confirm-modal-message');
  const okBtn  = document.getElementById('confirm-ok-btn');
  const cancelBtn = document.getElementById('confirm-cancel-btn');

  titleEl.textContent = title;
  msgEl.textContent   = message;
  modal.style.display = 'flex';

  function close() {
    modal.style.display = 'none';
    okBtn.removeEventListener('click', handleOk);
    cancelBtn.removeEventListener('click', handleCancel);
    modal.removeEventListener('click', handleOverlay);
  }

  function handleOk() { close(); onConfirm(); }
  function handleCancel() { close(); }
  function handleOverlay(e) { if (e.target === modal) close(); }

  okBtn.addEventListener('click', handleOk);
  cancelBtn.addEventListener('click', handleCancel);
  modal.addEventListener('click', handleOverlay);

  // Keyboard
  function handleKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', handleKey); }
    if (e.key === 'Enter')  { close(); onConfirm(); document.removeEventListener('keydown', handleKey); }
  }
  document.addEventListener('keydown', handleKey);
}

/* ────────────────────────────────────────────────────────────
   MOBILE NAV HELPERS
──────────────────────────────────────────────────────────── */
function toggleMobileNav() {
  const nav = document.getElementById('mobile-nav');
  if (nav) nav.style.display = nav.style.display === 'none' ? 'block' : 'none';
}

function closeMobileNav() {
  const nav = document.getElementById('mobile-nav');
  if (nav) nav.style.display = 'none';
}

// Show hamburger on mobile
function updateNavLayout() {
  const hamburger = document.getElementById('hamburger-btn');
  const desktopNav = document.getElementById('desktop-nav');
  const searchWrap = document.getElementById('nav-search-wrap');
  if (!hamburger) return;

  if (window.innerWidth < 768) {
    hamburger.style.display = 'flex';
    if (desktopNav) desktopNav.style.display = 'none';
    if (searchWrap) searchWrap.style.display = 'none';
  } else {
    hamburger.style.display = 'none';
    if (desktopNav) desktopNav.style.display = 'flex';
    if (searchWrap) searchWrap.style.display = 'flex';
  }
}

window.addEventListener('resize', updateNavLayout);

/* ────────────────────────────────────────────────────────────
   ALPINE.JS — App Shell Component
──────────────────────────────────────────────────────────── */
function appShell() {
  return {
    init() {
      // Alpine init — delegated to main App.init()
    },
  };
}

/* ────────────────────────────────────────────────────────────
   MAIN APP ENTRY POINT
──────────────────────────────────────────────────────────── */
const App = {
  async init() {
    Auth.init();
    updateNavLayout();

    // Show sign-in screen immediately while auth loads
    document.getElementById('signin-screen').style.display  = 'flex';
    document.getElementById('main-app').style.display        = 'none';

    try {
      await Auth.setup();
    } catch (err) {
      console.error('Auth setup failed:', err);
      Auth._showSignInButton();
    }
  },

  signOut() {
    Auth.signOut();
  },
};

// Expose to global for inline HTML event handlers
window.App   = App;
window.Pages = Pages;
window.toggleMobileNav = toggleMobileNav;
window.closeMobileNav  = closeMobileNav;

// Bootstrap on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
