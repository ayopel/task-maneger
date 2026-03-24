/**
 * ============================================================
 * Team Task Tracker — Notification Script
 * Google Apps Script (bound to the Spreadsheet)
 *
 * Setup:
 *  1. Open the spreadsheet → Extensions → Apps Script
 *  2. Paste this entire file
 *  3. Set APP_URL below to your GitHub Pages URL
 *  4. Run createTrigger() once to register the time trigger
 *  5. Authorise the required scopes when prompted
 * ============================================================
 */

// ── Configuration ─────────────────────────────────────────
var APP_URL = 'https://your-username.github.io/your-repo';

// Sheet names (must match app.js)
var SHEET_NOTIFICATIONS = 'NotificationQueue';
var SHEET_CONFIG        = 'Config';

// NotificationQueue column indices (0-based)
var COL_ID            = 0;
var COL_RECIPIENT     = 1;
var COL_TASK_ID       = 2;
var COL_TASK_TITLE    = 3;
var COL_PROJECT_NAME  = 4;
var COL_ASSIGNER      = 5;
var COL_CREATED_AT    = 6;
var COL_SENT          = 7;
var COL_SENT_AT       = 8;


// ── Main trigger function ──────────────────────────────────

/**
 * Reads the NotificationQueue sheet and sends pending emails.
 * Register this as a time-driven trigger (every 5 minutes).
 */
function sendPendingNotifications() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NOTIFICATIONS);

  if (!sheet) {
    Logger.log('NotificationQueue sheet not found');
    return;
  }

  var appName = getConfigValue(ss, 'app_name') || 'Task Tracker';

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('No notifications in queue');
    return;
  }

  // Read all data rows (skip header row 1)
  var data = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
  var sent = 0;
  var failed = 0;

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var notificationId = row[COL_ID];
    var sentFlag       = String(row[COL_SENT]).toUpperCase();

    // Skip already-sent or empty rows
    if (!notificationId || sentFlag === 'TRUE') continue;

    var recipientEmail = row[COL_RECIPIENT];
    var taskId         = row[COL_TASK_ID];
    var taskTitle      = row[COL_TASK_TITLE];
    var projectName    = row[COL_PROJECT_NAME];
    var assignerEmail  = row[COL_ASSIGNER];
    var sheetRowNumber = i + 2; // 1-based, +1 for header

    try {
      sendTaskAssignmentEmail(
        recipientEmail,
        taskId,
        taskTitle,
        projectName,
        assignerEmail,
        appName
      );

      // Mark as sent
      sheet.getRange(sheetRowNumber, COL_SENT   + 1).setValue('TRUE');
      sheet.getRange(sheetRowNumber, COL_SENT_AT + 1).setValue(new Date().toISOString());

      Logger.log('Sent notification to ' + recipientEmail + ' for task: ' + taskTitle);
      sent++;

    } catch (err) {
      // Leave row pending for retry on next run
      Logger.log('Failed to send to ' + recipientEmail + ': ' + err.message);
      failed++;

      // If this looks like a MailApp quota error, stop processing
      // to avoid burning the daily quota further.
      if (err.message && err.message.toLowerCase().indexOf('quota') !== -1) {
        Logger.log('MailApp quota exceeded — stopping early. ' + failed + ' failed so far.');
        break;
      }
    }
  }

  Logger.log('Notification run complete. Sent: ' + sent + ', Failed/pending: ' + failed);
}


// ── Email builder ──────────────────────────────────────────

/**
 * Sends a task assignment email to a single recipient.
 *
 * @param {string} recipientEmail
 * @param {string} taskId
 * @param {string} taskTitle
 * @param {string} projectName
 * @param {string} assignerEmail
 * @param {string} appName
 */
function sendTaskAssignmentEmail(recipientEmail, taskId, taskTitle, projectName, assignerEmail, appName) {
  var taskUrl = APP_URL + '#/tasks/' + encodeURIComponent(taskId);

  var subject = '[' + appName + '] You were assigned: ' + taskTitle;

  var plainText = [
    'Hi there,',
    '',
    assignerEmail + ' assigned you to a task in ' + appName + '.',
    '',
    'Task:    ' + taskTitle,
    'Project: ' + projectName,
    '',
    'View the task: ' + taskUrl,
    '',
    '---',
    'You are receiving this because you were added as an assignee.',
    'Reply to this email is not monitored.',
  ].join('\n');

  var htmlBody = [
    '<!DOCTYPE html>',
    '<html>',
    '<head><meta charset="UTF-8"></head>',
    '<body style="font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', sans-serif; background:#f5f5f5; margin:0; padding:32px 0;">',
    '  <div style="max-width:520px; margin:0 auto; background:#fff; border-radius:12px; overflow:hidden; box-shadow:0 2px 12px rgba(0,0,0,.08);">',
    '    <!-- Header -->',
    '    <div style="background:#0f1117; padding:24px 32px; text-align:center;">',
    '      <span style="font-size:1.25rem; font-weight:700; color:#4f8ef7; letter-spacing:-0.03em;">' + escapeHtmlGs(appName) + '</span>',
    '    </div>',
    '    <!-- Body -->',
    '    <div style="padding:32px;">',
    '      <h2 style="font-size:1.125rem; font-weight:600; color:#0f1117; margin:0 0 8px;">You\'ve been assigned a task</h2>',
    '      <p style="color:#555; font-size:0.9375rem; margin:0 0 24px;">',
    '        <strong>' + escapeHtmlGs(assignerEmail) + '</strong> assigned you to a task.',
    '      </p>',
    '      <!-- Task card -->',
    '      <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:18px 20px; margin-bottom:24px;">',
    '        <p style="font-size:0.75rem; font-weight:600; text-transform:uppercase; letter-spacing:0.06em; color:#94a3b8; margin:0 0 6px;">Task</p>',
    '        <p style="font-size:1rem; font-weight:600; color:#0f1117; margin:0 0 10px;">' + escapeHtmlGs(taskTitle) + '</p>',
    '        <p style="font-size:0.75rem; font-weight:600; text-transform:uppercase; letter-spacing:0.06em; color:#94a3b8; margin:0 0 4px;">Project</p>',
    '        <p style="font-size:0.875rem; color:#475569; margin:0;">' + escapeHtmlGs(projectName) + '</p>',
    '      </div>',
    '      <a href="' + taskUrl + '" style="display:inline-block; background:#4f8ef7; color:#fff; text-decoration:none; font-weight:600; font-size:0.9375rem; padding:12px 24px; border-radius:8px;">',
    '        View Task &rarr;',
    '      </a>',
    '    </div>',
    '    <!-- Footer -->',
    '    <div style="border-top:1px solid #e2e8f0; padding:16px 32px; text-align:center;">',
    '      <p style="font-size:0.75rem; color:#94a3b8; margin:0;">',
    '        You received this because you were added as an assignee in ' + escapeHtmlGs(appName) + '.',
    '      </p>',
    '    </div>',
    '  </div>',
    '</body>',
    '</html>',
  ].join('\n');

  MailApp.sendEmail({
    to:       recipientEmail,
    subject:  subject,
    body:     plainText,
    htmlBody: htmlBody,
    noReply:  true,
  });
}


// ── Config helper ──────────────────────────────────────────

/**
 * Reads a key from the Config sheet.
 *
 * @param {Spreadsheet} ss
 * @param {string}      key
 * @return {string|null}
 */
function getConfigValue(ss, key) {
  var sheet = ss.getSheetByName(SHEET_CONFIG);
  if (!sheet) return null;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() === key) return String(data[i][1]);
  }
  return null;
}


// ── HTML escape (Apps Script doesn't have browser APIs) ───

/**
 * Escape characters that are special in HTML.
 * @param {string} str
 * @return {string}
 */
function escapeHtmlGs(str) {
  return String(str || '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}


// ── Trigger management ─────────────────────────────────────

/**
 * Creates a time-driven trigger that runs every 5 minutes.
 * Run this function ONCE from the Apps Script editor.
 */
function createTrigger() {
  // Remove existing triggers for this function first
  deleteTrigger();

  ScriptApp.newTrigger('sendPendingNotifications')
    .timeBased()
    .everyMinutes(5)
    .create();

  Logger.log('Trigger created: sendPendingNotifications every 5 minutes.');
}

/**
 * Removes all existing triggers for sendPendingNotifications.
 * Safe to call multiple times.
 */
function deleteTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendPendingNotifications') {
      ScriptApp.deleteTrigger(triggers[i]);
      Logger.log('Deleted existing trigger.');
    }
  }
}

/**
 * Lists all project triggers. Useful for debugging.
 */
function listTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  if (triggers.length === 0) {
    Logger.log('No triggers found.');
    return;
  }
  triggers.forEach(function(t) {
    Logger.log(
      'Function: ' + t.getHandlerFunction() +
      ' | Type: ' + t.getTriggerSource() +
      ' | ID: ' + t.getUniqueId()
    );
  });
}


// ── Manual test ────────────────────────────────────────────

/**
 * Send a test notification email to yourself.
 * Change testEmail below and run from Apps Script editor.
 */
function testNotification() {
  var ss       = SpreadsheetApp.getActiveSpreadsheet();
  var appName  = getConfigValue(ss, 'app_name') || 'Task Tracker';
  var testEmail = Session.getActiveUser().getEmail();

  sendTaskAssignmentEmail(
    testEmail,
    'test-task-id-123',
    'Sample Task Title',
    'Sample Project',
    testEmail,
    appName
  );

  Logger.log('Test notification sent to ' + testEmail);
}
