/**
 * GRAVITY ANNUAL DAY 2026 — RSVP backend
 * Receives form submissions from the HTML form and writes them to the sheet,
 * then independently queues email and WhatsApp PDF delivery in the background.
 *
 * SETUP:
 *  1. Create a Google Sheet. Open Extensions > Apps Script. Paste this file.
 *  2. Services (left sidebar) > + > "Google Slides API" > Add.
 *  3. Make a blank Slides file, set File > Page setup > Custom > 5.33 x 8 in,
 *     and put its ID in SLIDE_TEMPLATE_ID below. Verify with checkSlideTemplate().
 *  4. Run setupSheet() once to append the WhatsApp columns without clearing data.
 *  5. Add EVOLUTION_BASE_URL, EVOLUTION_API_KEY and EVOLUTION_INSTANCE_NAME
 *     in Project Settings > Script properties.
 *  6. Run installSweepTrigger() once — the safety net that retries failures.
 *     Run installWhatsAppRetryTrigger() once for the one-minute WhatsApp recovery worker.
 *  7. Deploy > New deployment > type "Web app".
 *       - Execute as: Me
 *       - Who has access: Anyone
 *     Copy the Web App URL — paste it into the .env file.
 *
 * Delivery is designed to survive Google's transient Drive/Slides errors:
 *   - doPost saves the row as "Pending" and returns immediately.
 *   - A one-off trigger fires seconds later and tries to send.
 *   - Each build is retried in-process up to BUILD_ATTEMPTS times.
 *   - A row that still fails becomes "Retry N: ..." and is picked up again,
 *     both by a rescheduled run and by the 5-minute sweep, until it either
 *     sends or exhausts MAX_ATTEMPTS. No manual intervention needed.
 */

var SHEET_NAME = 'RSVPs';
var SPREADSHEET_ID = '1M0GjRKU_9rNOMZqZnSqDeac7vyYbOmBxiYFRmZHGUI4';
// Exact "LAST TEMPLATE.png" artwork supplied for emailed and WhatsApp passes.
// Keep a version query so Apps Script never reuses an older cached background.
var TEMPLATE_IMAGE_URL = 'https://gravity-rsvp.vercel.app/LAST%20TEMPLATE.png?v=20260910-foundation-day-v2';

// A blank Slides file whose page setup is 5.33 x 8 in (the artwork's 2:3 shape).
// Slides.Presentations.create() ignores any pageSize you pass and the API cannot
// resize a deck afterwards, so each pass is built by copying this one.
var SLIDE_TEMPLATE_ID = '1HeoEKmXJ5xsTvUQNXWR8akHyGxISaCBnk7lGwVTwUNw';

var STATUS_COL = 10;          // Existing email "Ticket Status" — retained for compatibility
var WHATSAPP_CONSENT_COL = 11;
var WHATSAPP_NUMBER_COL = 12;
var WHATSAPP_STATUS_COL = 13;
var WHATSAPP_MESSAGE_ID_COL = 14;
var WHATSAPP_ATTEMPTS_COL = 15;
var WHATSAPP_LAST_ERROR_COL = 16;
var WHATSAPP_UPDATED_AT_COL = 17;
var TOTAL_COLS = 17;

var TICKET_HANDLER = 'processPendingTickets';   // one-off, fires ~5s after an RSVP
var WHATSAPP_HANDLER = 'processPendingWhatsApp'; // separate so email retries never duplicate WhatsApp
var SWEEP_HANDLER  = 'sweepPendingTickets';     // recurring safety net
var MAX_RUN_MS = 4.5 * 60 * 1000;   // leave headroom under the 6-minute cap

var BUILD_ATTEMPTS = 3;   // in-process retries around a single PDF build
var MAX_ATTEMPTS = 5;     // how many separate runs a row gets before giving up
var WHATSAPP_MAX_ATTEMPTS = 3;
var DEFAULT_WHATSAPP_BATCH_SIZE = 10;
var GENERATED_PDF_FOLDER_PROPERTY = 'GENERATED_TICKET_FOLDER_ID';
// Rotate this namespace whenever RSVP rows are intentionally reset so reused
// ticket IDs can never resolve to a previous guest's cached pass.
var GENERATED_PDF_PROPERTY_PREFIX = 'GENERATED_TICKET_FILE_FRESH_20260917_';
var DUPLICATE_REGISTRATION_MESSAGE = 'This person is already registered.';

var BASE_HEADERS = [
  'Timestamp', 'Unique ID', 'Full Name', 'Email Address',
  'Mobile Number', 'Attending', 'Guest Count', 'Meal Preference',
  'Special Requirements', 'Ticket Status'
];
var WHATSAPP_HEADERS = [
  'WhatsApp Consent', 'WhatsApp Number', 'WhatsApp Status',
  'WhatsApp Message ID', 'WhatsApp Attempts', 'WhatsApp Last Error',
  'WhatsApp Updated At'
];

// The approved artwork is 1024 x 1536 (2:3). Overlay positions below use this
// same coordinate space, then scale automatically to the Slides page.
var TICKET_W_PX = 1024;
var TICKET_H_PX = 1536;

/** Helper to get Spreadsheet by ID or active context */
function getSpreadsheet() {
  if (!SPREADSHEET_ID) {
    throw new Error('SPREADSHEET_ID is not configured.');
  }
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

/**
 * Run this once after deploying this version. Existing columns and rows are
 * never cleared; only the new WhatsApp columns are appended.
 */
function setupSheet() {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  ensureSheetSchema_(sheet);
  backfillWhatsAppDefaults_(sheet);
  sheet.getRange(1, 1, 1, TOTAL_COLS)
    .setFontWeight('bold').setBackground('#D32030').setFontColor('#ffffff');
  sheet.setFrozenRows(1);
}

/** Adds missing headers, but refuses to overwrite an unexpected existing layout. */
function ensureSheetSchema_(sheet) {
  if (sheet.getMaxColumns() < TOTAL_COLS) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), TOTAL_COLS - sheet.getMaxColumns());
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, TOTAL_COLS)
      .setValues([BASE_HEADERS.concat(WHATSAPP_HEADERS)]);
    return;
  }

  var currentBase = sheet.getRange(1, 1, 1, STATUS_COL).getValues()[0];
  for (var i = 0; i < BASE_HEADERS.length; i++) {
    if (String(currentBase[i] || '').trim() !== BASE_HEADERS[i]) {
      throw new Error('Unexpected spreadsheet header in column ' + (i + 1) +
                      '. Existing RSVP data was not changed.');
    }
  }

  var currentWhatsApp = sheet.getRange(1, WHATSAPP_CONSENT_COL, 1, WHATSAPP_HEADERS.length)
    .getValues()[0];
  for (var j = 0; j < WHATSAPP_HEADERS.length; j++) {
    var existing = String(currentWhatsApp[j] || '').trim();
    if (existing && existing !== WHATSAPP_HEADERS[j]) {
      throw new Error('Column ' + (WHATSAPP_CONSENT_COL + j) +
                      ' already contains "' + existing + '". Nothing was overwritten.');
    }
  }
  sheet.getRange(1, WHATSAPP_CONSENT_COL, 1, WHATSAPP_HEADERS.length)
    .setValues([WHATSAPP_HEADERS]);
}

/** Marks untouched historical rows as not consented without changing A:J. */
function backfillWhatsAppDefaults_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var range = sheet.getRange(2, WHATSAPP_CONSENT_COL,
                             lastRow - 1, WHATSAPP_HEADERS.length);
  var values = range.getValues();
  var changed = false;
  for (var i = 0; i < values.length; i++) {
    var untouched = values[i].every(function (value) {
      return value === '' || value == null;
    });
    if (!untouched) continue;
    values[i][0] = 'No';
    values[i][2] = 'No consent';
    values[i][4] = 0;
    values[i][6] = new Date();
    changed = true;
  }
  if (changed) range.setValues(values);
}

/**
 * Handles POST requests from the HTML form.
 * Saves the row and returns immediately — the e-pass is mailed by a trigger.
 */
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    verifyProxySecret_(data);
    if (String(data._website || '').trim()) throw new Error('Invalid request body.');

    var fullName    = String(data.fullName || '').trim();
    var email       = String(data.email || '').trim();
    var mobile      = String(data.mobile || '').trim();
    var attending   = String(data.attending || '').trim();
    var guestCount  = String(data.guestCount == null ? '0' : data.guestCount).trim();
    var meal        = String(data.meal || '').trim();
    var specialRequirements = String(data.specialRequirements || '').trim();
    validateRsvpData_(fullName, email, mobile, attending, guestCount, specialRequirements);
    var whatsappConsent = parseBoolean_(data.whatsappConsent);
    var whatsappNumber = normalizeWhatsAppNumber(mobile, getWhatsAppDefaultCountryCode_());

    var needsTicket = attending === 'Attending' && !!email;
    var whatsappStatus = attending !== 'Attending'
      ? 'Not required'
      : !whatsappConsent
        ? 'No consent'
        : !whatsappNumber
          ? 'Invalid number'
          : 'Pending';
    var saved = appendRsvp([fullName, email, mobile, attending,
                            guestCount, meal, specialRequirements], needsTicket, {
                              consent: whatsappConsent,
                              number: whatsappNumber,
                              status: whatsappStatus
                            });

    if (needsTicket) {
      scheduleTicketRun(5000);
    }
    if (whatsappStatus === 'Pending') {
      scheduleWhatsAppRun(15000);
    }

    return ContentService
      .createTextOutput(JSON.stringify({
        result: 'success',
        id: saved.uniqueID,
        spreadsheetId: saved.spreadsheetId,
        spreadsheetUrl: saved.spreadsheetUrl,
        sheetName: SHEET_NAME,
        row: saved.row,
        ticket: needsTicket ? 'queued' : 'not required',
        email: needsTicket ? 'queued' : 'not required',
        whatsapp: whatsappStatus.toLowerCase()
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    var message = err && err.message ? err.message : String(err);
    return ContentService
      .createTextOutput(JSON.stringify({
        result: 'error',
        code: message === DUPLICATE_REGISTRATION_MESSAGE ? 'DUPLICATE_REGISTRATION' : 'RSVP_ERROR',
        message: message
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/** Optional shared secret. Enforcement begins only after the Script Property is set. */
function verifyProxySecret_(data) {
  var expected = String(PropertiesService.getScriptProperties()
    .getProperty('APPS_SCRIPT_SHARED_SECRET') || '');
  if (expected && String(data && data._proxySecret || '') !== expected) {
    throw new Error('Unauthorised RSVP submission.');
  }
}

/** Re-validates browser data at the trusted Apps Script boundary. */
function validateRsvpData_(fullName, email, mobile, attending, guestCount, specialRequirements) {
  if (!fullName || fullName.length > 120) throw new Error('Invalid full name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid email address.');
  if (!mobile || mobile.length > 30) throw new Error('Invalid mobile number.');
  if (attending !== 'Attending' && attending !== 'Not Attending') {
    throw new Error('Invalid attendance value.');
  }
  if (!/^\d+$/.test(guestCount) || parseInt(guestCount, 10) < 0 || parseInt(guestCount, 10) > 20) {
    throw new Error('Invalid guest count.');
  }
  if (specialRequirements.length > 1000) {
    throw new Error('Special requirements are too long.');
  }
}

/**
 * Appends one RSVP under a lock, so two submissions landing together can't
 * be handed the same ticket ID.
 */
function appendRsvp(fields, needsTicket, whatsapp) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = getSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
    ensureSheetSchema_(sheet);

    // Check under the append lock so two identical submissions arriving at
    // the same time cannot both pass the check and create separate tickets.
    if (hasDuplicateRegistration_(sheet, fields[1], fields[2], whatsapp && whatsapp.number)) {
      throw new Error(DUPLICATE_REGISTRATION_MESSAGE);
    }

    var row = sheet.getLastRow() + 1;
    var uniqueID = 'GRV-2026-' + (1000 + row);
    var whatsappValues = [
      whatsapp && whatsapp.consent ? 'Yes' : 'No',
      whatsapp ? whatsapp.number : '',
      whatsapp ? whatsapp.status : 'No consent',
      '',
      0,
      '',
      new Date()
    ];

    // Keep phone digits as text when a later worker reads the saved row.
    sheet.getRange(row, WHATSAPP_NUMBER_COL).setNumberFormat('@');
    sheet.getRange(row, 1, 1, TOTAL_COLS).setValues([
      [new Date(), uniqueID].concat(fields)
        .concat([needsTicket ? 'Pending' : 'Not required'])
        .concat(whatsappValues)
    ]);
    SpreadsheetApp.flush();

    return {
      uniqueID: uniqueID,
      row: row,
      spreadsheetId: ss.getId(),
      spreadsheetUrl: ss.getUrl()
    };
  } finally {
    lock.releaseLock();
  }
}

/** A registration is a duplicate only when both email and WhatsApp match. */
function hasDuplicateRegistration_(sheet, email, mobile, normalizedNumber) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;

  var wantedEmail = String(email || '').trim().toLowerCase();
  var wantedNumber = String(normalizedNumber || normalizeWhatsAppNumber(
    mobile, getWhatsAppDefaultCountryCode_()
  ) || '');
  if (!wantedEmail || !wantedNumber) return false;

  var rows = sheet.getRange(2, 1, lastRow - 1, TOTAL_COLS).getValues();
  return rows.some(function (row) {
    var existingEmail = String(row[3] || '').trim().toLowerCase();
    var existingNumber = String(row[WHATSAPP_NUMBER_COL - 1] || '') ||
      normalizeWhatsAppNumber(row[4], getWhatsAppDefaultCountryCode_());
    return existingEmail === wantedEmail && String(existingNumber) === wantedNumber;
  });
}

/**
 * Queues a background run to mail any outstanding e-passes.
 *
 * A one-off trigger stays listed in the project after it fires — spent, but
 * still counted. Clearing them first is what keeps them from accumulating and
 * silently blocking new ones. One pending trigger is always enough, because
 * the run it starts drains every outstanding row.
 */
function scheduleTicketRun(delayMs) {
  clearTicketTriggers();
  ScriptApp.newTrigger(TICKET_HANDLER)
    .timeBased().after(delayMs || 5000).create();
}

/** Queues WhatsApp independently so a delivery failure cannot resend email. */
function scheduleWhatsAppRun(delayMs) {
  clearWhatsAppTriggers();
  ScriptApp.newTrigger(WHATSAPP_HANDLER)
    .timeBased().after(delayMs || 15000).create();
}

/** Removes spent one-off triggers so they don't pile up against the quota. */
function clearTicketTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === TICKET_HANDLER) ScriptApp.deleteTrigger(t);
  });
}

/** Removes spent WhatsApp one-off triggers without touching the sweep trigger. */
function clearWhatsAppTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === WHATSAPP_HANDLER) ScriptApp.deleteTrigger(t);
  });
}

/**
 * Run ONCE. Installs the recurring safety net that catches anything the
 * one-off triggers miss, so a stuck row always resolves on its own.
 */
function installSweepTrigger() {
  var existing = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === SWEEP_HANDLER;
  });
  if (existing.length) {
    Logger.log('Sweep trigger already installed.');
    return;
  }
  ScriptApp.newTrigger(SWEEP_HANDLER).timeBased().everyMinutes(5).create();
  Logger.log('Sweep trigger installed — runs every 5 minutes.');
}

/** The recurring safety net. Kept separate so clearTicketTriggers can't delete it. */
function sweepPendingTickets() {
  processPendingTickets();
  processPendingWhatsApp();
}

/** Run once after pasting this version. Never schedules the attempt-reset helper. */
function installWhatsAppRetryTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'sweepPendingWhatsApp') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger('sweepPendingWhatsApp').timeBased().everyMinutes(1).create();
  Logger.log('WhatsApp recovery installed: every minute, at most 3 attempts per ticket.');
}

/** Treats explicit booleans and common form strings as consent. */
function parseBoolean_(value) {
  if (value === true) return true;
  var normal = String(value == null ? '' : value).trim().toLowerCase();
  return normal === 'true' || normal === 'yes' || normal === '1';
}

/**
 * Returns a digits-only international WhatsApp number or an empty string.
 * Ten-digit Indian mobile numbers receive the 91 country code.
 */
function normalizeWhatsAppNumber(rawNumber, defaultCountryCode) {
  var value = String(rawNumber == null ? '' : rawNumber).trim();
  if (!value || /[a-z]/i.test(value)) return '';

  var defaultCode = String(defaultCountryCode || '91').replace(/\D/g, '');
  if (!/^[1-9]\d{0,3}$/.test(defaultCode)) defaultCode = '91';

  var digits = value.replace(/\D/g, '');
  if (digits.indexOf('00') === 0) digits = digits.substring(2);
  if (digits.length === 11 && digits.charAt(0) === '0') digits = digits.substring(1);
  if (digits.length === 10) {
    if (!/^[6-9]/.test(digits)) return '';
    digits = defaultCode + digits;
  }

  if (!/^[1-9]\d{7,14}$/.test(digits)) return '';
  if (digits.indexOf('91') === 0 &&
      (digits.length !== 12 || !/^[6-9]/.test(digits.substring(2)))) return '';
  return digits;
}

/** Reads the local default without requiring it to be exposed to the browser. */
function getWhatsAppDefaultCountryCode_() {
  return String(PropertiesService.getScriptProperties()
    .getProperty('WHATSAPP_DEFAULT_COUNTRY_CODE') || '91');
}

/** Returns true only for an attending, explicitly consented, valid recipient. */
function isWhatsAppEligible(row) {
  var attending;
  var consent;
  var number;
  if (Array.isArray(row)) {
    attending = row[5];
    consent = row[WHATSAPP_CONSENT_COL - 1];
    number = row[WHATSAPP_NUMBER_COL - 1] || row[4];
  } else {
    attending = row && row.attending;
    consent = row && row.whatsappConsent;
    number = row && (row.whatsappNumber || row.mobile);
  }
  return String(attending) === 'Attending' && parseBoolean_(consent) &&
         !!normalizeWhatsAppNumber(number);
}

/** "Pending" or "Retry N: ..." both mean the row still needs sending. */
function isOutstanding(status) {
  status = String(status);
  return status === 'Pending' || status.indexOf('Retry ') === 0;
}

/** Pulls the attempt count back out of a "Retry N: ..." status. */
function attemptsSoFar(status) {
  var m = String(status).match(/^Retry (\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Runs an operation that may hit a transient Google error, backing off
 * between tries. Drive and Slides both fail intermittently under triggers.
 */
function withRetry(label, fn) {
  var lastErr;
  for (var attempt = 1; attempt <= BUILD_ATTEMPTS; attempt++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      Logger.log(label + ': attempt ' + attempt + '/' + BUILD_ATTEMPTS + ' failed — ' + err);
      if (attempt < BUILD_ATTEMPTS) Utilities.sleep(attempt * 2000);
    }
  }
  throw lastErr;
}

/**
 * Mails every RSVP still outstanding. Runs from a trigger, so nobody is
 * waiting on it. Safe to run manually too.
 */
function processPendingTickets() {
  clearTicketTriggers();

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    // WhatsApp and email are deliberately queued as independent one-off
    // triggers, but Apps Script can start both at nearly the same time. If
    // WhatsApp is still building/uploading its PDF, it may hold the shared
    // script lock longer than this wait. Do not silently strand the email row:
    // replace the spent one-off trigger with a delayed retry.
    Logger.log('Another run holds the lock; retrying email in 60 seconds.');
    scheduleTicketRun(60000);
    return;
  }

  var startedAt = Date.now();
  var leftover = false;
  var sent = 0, retried = 0, gaveUp = 0, seen = 0;

  try {
    var sheet = getSpreadsheet().getSheetByName(SHEET_NAME);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) { Logger.log('No RSVP rows exist yet.'); return; }

    var rows = sheet.getRange(2, 1, lastRow - 1, STATUS_COL).getValues();

    for (var i = 0; i < rows.length; i++) {
      var status = rows[i][STATUS_COL - 1];
      if (!isOutstanding(status)) continue;
      seen++;

      if (Date.now() - startedAt > MAX_RUN_MS) { leftover = true; break; }

      var rowNum = i + 2;
      var uniqueID   = rows[i][1];
      var fullName   = rows[i][2];
      var email      = rows[i][3];
      var guestCount = rows[i][6];
      var meal       = rows[i][7];

      try {
        sendTicketEmail(fullName, email, guestCount, uniqueID, meal);
        sheet.getRange(rowNum, STATUS_COL).setValue('Sent ' + new Date().toLocaleString());
        sent++;
        Logger.log('Sent row ' + rowNum + ' (' + uniqueID + ') to ' + email);
      } catch (err) {
        var n = attemptsSoFar(status) + 1;
        if (n < MAX_ATTEMPTS) {
          sheet.getRange(rowNum, STATUS_COL).setValue('Retry ' + n + ': ' + err.message);
          retried++;
          leftover = true;
          Logger.log('Row ' + rowNum + ' (' + uniqueID + ') failed, will retry (' +
                     n + '/' + MAX_ATTEMPTS + ') — ' + err);
        } else {
          sheet.getRange(rowNum, STATUS_COL)
               .setValue('Failed after ' + n + ' attempts: ' + err.message);
          gaveUp++;
          Logger.log('Row ' + rowNum + ' (' + uniqueID + ') GAVE UP after ' + n + ' — ' + err);
        }
      }
      SpreadsheetApp.flush();
    }

    Logger.log('processPendingTickets: ' + seen + ' outstanding, sent ' + sent +
               ', queued for retry ' + retried + ', gave up ' + gaveUp + '.');
  } finally {
    lock.releaseLock();
  }

  // Back off a little before the next attempt rather than hammering Google.
  if (leftover) scheduleTicketRun(60000);
}

/** "Pending", "Retry N", and "Disconnected" rows remain eligible for WhatsApp. */
function isWhatsAppOutstanding_(status) {
  status = String(status || '');
  return status === 'Pending' || status === 'Disconnected' || status.indexOf('Retry ') === 0;
}

/** Reads Evolution secrets from Script Properties without exposing them in source. */
function getEvolutionConfig_() {
  var props = PropertiesService.getScriptProperties();
  var baseUrl = String(props.getProperty('EVOLUTION_BASE_URL') || '').trim().replace(/\/+$/, '');
  var apiKey = String(props.getProperty('EVOLUTION_API_KEY') || '').trim();
  var instanceName = String(props.getProperty('EVOLUTION_INSTANCE_NAME') || '').trim();
  var requestedBatch = parseInt(props.getProperty('WHATSAPP_BATCH_SIZE'), 10);

  if (!baseUrl || !apiKey || !instanceName) {
    throw new Error('Evolution is not configured. Add EVOLUTION_BASE_URL, ' +
                    'EVOLUTION_API_KEY and EVOLUTION_INSTANCE_NAME in Script Properties.');
  }
  if (baseUrl.indexOf('https://') !== 0) {
    throw new Error('EVOLUTION_BASE_URL must use HTTPS.');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(instanceName)) {
    throw new Error('EVOLUTION_INSTANCE_NAME contains unsupported characters.');
  }

  return {
    baseUrl: baseUrl,
    apiKey: apiKey,
    instanceName: instanceName,
    batchSize: Math.max(1, Math.min(25, requestedBatch || DEFAULT_WHATSAPP_BATCH_SIZE))
  };
}

/** Reads the linked-device state before attempting any queued media sends. */
function getEvolutionConnectionState_(config) {
  var url = config.baseUrl + '/instance/connectionState/' + encodeURIComponent(config.instanceName);
  var response;
  try {
    response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { apikey: config.apiKey },
      muteHttpExceptions: true,
      followRedirects: true
    });
  } catch (err) {
    throw new Error('Evolution connection check failed: ' + err.message);
  }

  var code = response.getResponseCode();
  var text = response.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('Evolution connection check returned HTTP ' + code + ': ' + text.slice(0, 180));
  }

  var data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error('Evolution connection check returned invalid JSON.');
  }
  return String(data && data.instance && data.instance.state || '').toLowerCase();
}

/** Manual diagnostic that never logs the Evolution API key. */
function checkEvolutionConnection() {
  var state = getEvolutionConnectionState_(getEvolutionConfig_());
  Logger.log('Evolution instance state: ' + (state || 'unknown'));
  return state;
}

/** Public helper retained for operator use from the Apps Script editor. */
function getEvolutionConnectionState() {
  return checkEvolutionConnection();
}

/** Sends a simple internal test message; this is never called by form submission. */
function testEvolutionText() {
  var props = PropertiesService.getScriptProperties();
  var number = normalizeWhatsAppNumber(props.getProperty('WHATSAPP_TEST_NUMBER'));
  if (!number) throw new Error('Set a valid WHATSAPP_TEST_NUMBER in Script Properties.');
  var config = getEvolutionConfig_();
  var state = getEvolutionConnectionState_(config);
  if (state !== 'open' && state !== 'connected') {
    throw new Error('Evolution instance is not connected. Current state: ' + state);
  }

  var response = UrlFetchApp.fetch(
    config.baseUrl + '/message/sendText/' + encodeURIComponent(config.instanceName),
    {
      method: 'post',
      contentType: 'application/json',
      headers: { apikey: config.apiKey },
      payload: JSON.stringify({
        number: number,
        text: 'Gravity RSVP Evolution API connection test.'
      }),
      muteHttpExceptions: true,
      followRedirects: true
    }
  );
  var code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Evolution text test returned HTTP ' + code + ': ' +
                    response.getContentText().slice(0, 180));
  }
  var data = JSON.parse(response.getContentText());
  var messageId = extractEvolutionMessageId_(data);
  Logger.log('Evolution text test accepted. Message ID: ' + (messageId || 'not returned'));
  return messageId;
}

/** Extracts the message identifier across common Evolution v2 response shapes. */
function extractEvolutionMessageId_(data) {
  if (!data) return '';
  if (data.key && data.key.id) return String(data.key.id);
  if (data.message && data.message.key && data.message.key.id) return String(data.message.key.id);
  if (data.messageId) return String(data.messageId);
  if (data.id) return String(data.id);
  return '';
}

/** Creates a classified error without putting credentials into the message. */
function evolutionError_(message, retryable, deliveryUnknown) {
  var err = new Error(message);
  err.retryable = retryable;
  err.deliveryUnknown = deliveryUnknown;
  return err;
}

/** Removes credentials and full phone numbers before an error reaches the Sheet. */
function sanitizeEvolutionError_(value, config) {
  var text = String(value == null ? '' : value);
  if (config && config.apiKey) text = text.split(config.apiKey).join('[redacted]');
  return text.replace(/\b\d{8,15}\b/g, function (number) {
    return '****' + number.slice(-4);
  }).slice(0, 500);
}

/** Sends the existing personalised PDF Blob as a WhatsApp document. */
function sendTicketWhatsApp(fullName, number, guestCount, uniqueID, config) {
  // Sheets can return existing phone cells as numbers. Normalize before JSON
  // serialization so every recipient is sent as a plain digit string.
  number = normalizeWhatsAppNumber(number, getWhatsAppDefaultCountryCode_());
  if (!number) {
    throw evolutionError_('Invalid WhatsApp recipient number.', false, false);
  }
  var additionalGuests = Math.max(0, parseInt(guestCount, 10) || 0);
  var attendeeCount = String(1 + additionalGuests);
  var pdfAttachment = getOrCreateTicketPdf_(fullName, attendeeCount, uniqueID);
  var safeName = String(fullName || 'Guest')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'Guest';
  var fileName = 'Gravity_Pass_' + safeName + '_' + uniqueID + '.pdf';
  var mediaBlob = pdfAttachment.copyBlob().setName(fileName);
  var caption = 'Hello ' + fullName + '👋\n\n' +
    'Thank you for confirming your RSVP for 12th Gravity Foundation Day! 🎉 ' +
    'We’re delighted to have you join us for the celebration. ✨\n\n' +
    '🎟️ Your personalised entry pass is attached. Please keep it handy for a smooth entry.\n\n' +
    'Ticket ID: ' + uniqueID + '\n\n' +
    '📍 Venue Location: https://maps.app.goo.gl/J7xcZGSBWMUaD1v86?g_st=ic\n\n' +
    'We can’t wait to celebrate this special evening with you! 🌟';
  var url = config.baseUrl + '/message/sendMedia/' + encodeURIComponent(config.instanceName);
  var response;

  // Identifies this sender in manual and trigger executions without logging
  // phone numbers, API keys, or the invitation PDF.
  Logger.log('WA_JSON_V3 | ticket=' + uniqueID +
             ' | project=' + ScriptApp.getScriptId() +
             ' | numberType=' + typeof number);

  try {
    response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { apikey: config.apiKey },
      payload: JSON.stringify({
        number: String(number),
        mediatype: 'document',
        mimetype: 'application/pdf',
        // JSON preserves phone digits and Evolution accepts base64 media.
        media: Utilities.base64Encode(mediaBlob.getBytes()),
        caption: caption,
        fileName: fileName
      }),
      muteHttpExceptions: true,
      followRedirects: true
    });
  } catch (err) {
    // A transport timeout can happen after the provider accepted the message.
    // Mark it Unknown instead of risking an automatic duplicate.
    throw evolutionError_('Evolution request did not return: ' + err.message, false, true);
  }

  var code = response.getResponseCode();
  var responseText = response.getContentText();
  if (code < 200 || code >= 300) {
    var retryable = code === 408 || code === 429 || code >= 500;
    throw evolutionError_('Evolution returned HTTP ' + code + ': ' +
                          sanitizeEvolutionError_(responseText, config).slice(0, 220),
                          retryable, false);
  }

  var data;
  try {
    data = JSON.parse(responseText);
  } catch (err) {
    throw evolutionError_('Evolution returned invalid JSON after accepting the request.', false, true);
  }

  var messageId = extractEvolutionMessageId_(data);
  if (!messageId) {
    throw evolutionError_('Evolution accepted the request but returned no message ID.', false, true);
  }
  return {
    messageId: messageId,
    response: data
  };
}

/** Writes columns M:Q together so a row never exposes a half-updated state. */
function updateWhatsAppState_(sheet, rowNum, status, messageId, attempts, lastError) {
  sheet.getRange(rowNum, WHATSAPP_STATUS_COL, 1, 5).setValues([[
    status,
    messageId || '',
    attempts || 0,
    lastError ? String(lastError).slice(0, 500) : '',
    new Date()
  ]]);
  SpreadsheetApp.flush();
}

/** Only recover the known malformed-recipient rejection, not every HTTP 400. */
function isScientificPhoneFailure_(message) {
  var text = String(message || '');
  return /Evolution returned HTTP 400\b/.test(text) &&
    /"exists"\s*:\s*false/.test(text) &&
    /"number"\s*:\s*"\d+(?:\.\d+)?[eE]\+?\d+"/.test(text);
}

/** The attempt count is retained across manual, one-off and recurring runs. */
function isWhatsAppWorkCandidate_(row) {
  if (!isWhatsAppEligible(row) || row[WHATSAPP_MESSAGE_ID_COL - 1]) return false;
  var attempts = parseInt(row[WHATSAPP_ATTEMPTS_COL - 1], 10) || 0;
  if (attempts >= WHATSAPP_MAX_ATTEMPTS) return false;
  var status = String(row[WHATSAPP_STATUS_COL - 1] || '');
  return isWhatsAppOutstanding_(status) ||
    (status === 'Failed' && isScientificPhoneFailure_(row[WHATSAPP_LAST_ERROR_COL - 1]));
}

/**
 * Processes WhatsApp separately from email. A successful email is never
 * repeated merely because Evolution is unavailable.
 */
function processPendingWhatsApp() {
  clearWhatsAppTriggers();

  var config;
  try {
    config = getEvolutionConfig_();
  } catch (err) {
    Logger.log('WhatsApp worker is waiting for configuration: ' + err.message);
    return;
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log('Another delivery worker holds the lock; WhatsApp will run on the next sweep.');
    return;
  }

  var leftover = false;
  var retryDelayMs = 60000;
  var sent = 0, retried = 0, failed = 0, unknown = 0;

  try {
    var sheet = getSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 2) return;
    ensureSheetSchema_(sheet);

    var lastRow = sheet.getLastRow();
    var rows = sheet.getRange(2, 1, lastRow - 1, TOTAL_COLS).getValues();
    var outstanding = rows.filter(isWhatsAppWorkCandidate_);
    if (!outstanding.length) return;

    var connectionState;
    try {
      connectionState = getEvolutionConnectionState_(config);
    } catch (err) {
      Logger.log(err.message + ' Pending rows remain safely queued.');
      return;
    }
    if (connectionState !== 'open' && connectionState !== 'connected') {
      Logger.log('Evolution is ' + (connectionState || 'unknown') +
                 '. Pending rows remain safely queued.');
      return;
    }

    var processed = 0;
    var startedAt = Date.now();
    for (var i = 0; i < rows.length; i++) {
      if (!isWhatsAppWorkCandidate_(rows[i])) continue;
      if (processed >= config.batchSize || Date.now() - startedAt >= MAX_RUN_MS) {
        leftover = true;
        break;
      }

      var rowNum = i + 2;
      var uniqueID = rows[i][1];
      var fullName = rows[i][2];
      var number = rows[i][WHATSAPP_NUMBER_COL - 1];
      var guestCount = rows[i][6];
      var existingMessageId = rows[i][WHATSAPP_MESSAGE_ID_COL - 1];
      var attempts = parseInt(rows[i][WHATSAPP_ATTEMPTS_COL - 1], 10) || 0;

      if (existingMessageId) {
        updateWhatsAppState_(sheet, rowNum, 'Sent', existingMessageId, attempts, '');
        continue;
      }
      if (!normalizeWhatsAppNumber(number)) {
        updateWhatsAppState_(sheet, rowNum, 'Invalid number', '', attempts,
                              'The stored WhatsApp number is invalid.');
        failed++;
        continue;
      }

      processed++;
      attempts++;
      updateWhatsAppState_(sheet, rowNum, 'Sending', '', attempts, '');

      try {
        var result = sendTicketWhatsApp(fullName, number, guestCount, uniqueID, config);
        updateWhatsAppState_(sheet, rowNum, 'Sent', result.messageId, attempts, '');
        sent++;
      } catch (err) {
        var message = err && err.message ? err.message : String(err);
        if (err && err.deliveryUnknown) {
          updateWhatsAppState_(sheet, rowNum, 'Unknown', '', attempts, message);
          unknown++;
        } else if ((!err || err.retryable !== false || isScientificPhoneFailure_(message)) &&
                   attempts < WHATSAPP_MAX_ATTEMPTS) {
          updateWhatsAppState_(sheet, rowNum, 'Retry ' + attempts, '', attempts, message);
          retried++;
          leftover = true;
          retryDelayMs = Math.max(retryDelayMs,
            Math.min(15 * 60 * 1000, 60000 * Math.pow(2, attempts - 1)));
        } else {
          updateWhatsAppState_(sheet, rowNum, 'Failed', '', attempts, message);
          failed++;
        }
      }
    }
  } finally {
    lock.releaseLock();
  }

  Logger.log('processPendingWhatsApp: sent ' + sent + ', retry ' + retried +
             ', failed ' + failed + ', unknown ' + unknown + '.');
  if (leftover) scheduleWhatsAppRun(retryDelayMs);
}

/** Manual/trigger-friendly alias for processing only the WhatsApp queue. */
function sweepPendingWhatsApp() {
  processPendingWhatsApp();
}

/**
 * Builds the e-pass by copying the correctly-sized Slides template, then
 * exports it as a full-bleed PDF and bins the copy.
 *
 * The layout is derived from the copy's real page size rather than assumed,
 * so the artwork always fills the page it is actually drawn on.
 */
function buildTicketPdf(fullName, attendeeCount, uniqueID) {
  if (!SLIDE_TEMPLATE_ID || SLIDE_TEMPLATE_ID.indexOf('PASTE_') === 0) {
    throw new Error('SLIDE_TEMPLATE_ID is not configured.');
  }

  var copy = DriveApp.getFileById(SLIDE_TEMPLATE_ID)
    .makeCopy('Gravity_Pass_tmp_' + uniqueID);
  var pdf = null;

  try {
    // Drive needs a moment before Slides can reliably open a fresh copy.
    Utilities.sleep(1200);

    var presentation = SlidesApp.openById(copy.getId());

    // Start from a genuinely blank first slide.
    var slides = presentation.getSlides();
    for (var i = slides.length - 1; i >= 1; i--) slides[i].remove();
    var slide = slides[0];
    slide.getPageElements().forEach(function (el) { el.remove(); });

    var pageW = presentation.getPageWidth();
    var pageH = presentation.getPageHeight();

    // Fit the artwork to the page without distorting it, and centre any slack.
    var scale = Math.min(pageW / TICKET_W_PX, pageH / TICKET_H_PX);
    var drawW = TICKET_W_PX * scale;
    var drawH = TICKET_H_PX * scale;
    var offX = (pageW - drawW) / 2;
    var offY = (pageH - drawH) / 2;
    var at = function (xPx, yPx) {
      return { x: offX + xPx * scale, y: offY + yPx * scale };
    };

    slide.insertImage(getTicketArtworkBlob(), offX, offY, drawW, drawH);

    // Fill the four blanks in the supplied artwork. Font sizes are calculated
    // from the available line width so even long names remain on one line.
    var guestFieldWidth = 518 * scale;
    var attendeeFieldWidth = 518 * scale;
    var ticketFieldWidth = 356 * scale;
    var guestNameSize = fitSingleLineFontSize(fullName, 12, 6.5, guestFieldWidth, 0.56);
    var attendeeSize = fitSingleLineFontSize(attendeeCount, 12, 8, attendeeFieldWidth, 0.56);
    var ticketIdSize = fitSingleLineFontSize(uniqueID, 13, 8, ticketFieldWidth, 0.58);

    var guestNamePos = positionTextAboveLine(at(326, 682), guestNameSize, 2);
    var attendeePos = positionTextAboveLine(at(326, 862), attendeeSize, 2);
    var ticketIdPos = positionTextAboveLine(at(448, 1002), ticketIdSize, 2);
    addTicketField(slide, fullName,      guestNamePos, guestNameSize, '#171717', pageW, guestFieldWidth);
    addTicketField(slide, attendeeCount, attendeePos, attendeeSize, '#171717', pageW, attendeeFieldWidth);
    addTicketField(slide, uniqueID,      ticketIdPos, ticketIdSize, '#9f1118', pageW, ticketFieldWidth);
    addWelcomeName(slide, fullName, at(449, 1137), 268 * scale, 64 * scale);

    presentation.saveAndClose();

    pdf = DriveApp.getFileById(copy.getId())
      .getAs('application/pdf')
      .setName('Gravity_Pass_' + String(fullName).replace(/\s+/g, '_') + '.pdf');
  } finally {
    try { copy.setTrashed(true); } catch (e) { /* nothing useful to do */ }
  }

  return pdf;
}

/**
 * Keeps each generated pass privately in Drive so email and WhatsApp attach
 * the exact same PDF bytes. The saved file ID is an internal cache pointer;
 * neither the file nor its folder is made public.
 */
function getTicketPdfCacheKey_(uniqueID) {
  // Changing the artwork URL (including its version query) invalidates cached
  // passes without deleting old Drive files or changing ticket IDs.
  return GENERATED_PDF_PROPERTY_PREFIX + encodeURIComponent(TEMPLATE_IMAGE_URL) + '_' + uniqueID;
}

function getOrCreateTicketPdf_(fullName, attendeeCount, uniqueID) {
  var props = PropertiesService.getScriptProperties();
  var propertyKey = getTicketPdfCacheKey_(uniqueID);
  var existingId = String(props.getProperty(propertyKey) || '');

  if (existingId) {
    try {
      var existing = DriveApp.getFileById(existingId);
      if (!existing.isTrashed()) return existing.getBlob().setName(existing.getName());
    } catch (err) {
      // The cache pointer is stale; rebuild below and replace it.
    }
    props.deleteProperty(propertyKey);
  }

  var pdf = withRetry('buildTicketPdf ' + uniqueID, function () {
    return buildTicketPdf(fullName, attendeeCount, uniqueID);
  });
  var folder = getGeneratedTicketFolder_();
  var file = folder.createFile(pdf);
  file.setDescription('Private generated entry pass for ticket ' + uniqueID + '.');
  props.setProperty(propertyKey, file.getId());
  return file.getBlob().setName(file.getName());
}

/** Creates one private Drive folder and remembers it across trigger runs. */
function getGeneratedTicketFolder_() {
  var props = PropertiesService.getScriptProperties();
  var folderId = String(props.getProperty(GENERATED_PDF_FOLDER_PROPERTY) || '');
  if (folderId) {
    try {
      var existingFolder = DriveApp.getFolderById(folderId);
      if (!existingFolder.isTrashed()) return existingFolder;
    } catch (err) {
      props.deleteProperty(GENERATED_PDF_FOLDER_PROPERTY);
    }
  }

  var folder = DriveApp.createFolder('Gravity RSVP 2026 Generated Passes');
  props.setProperty(GENERATED_PDF_FOLDER_PROPERTY, folder.getId());
  return folder;
}

/** Downloads the exact approved artwork. Fail instead of silently using an old design. */
function getTicketArtworkBlob() {
  var response = UrlFetchApp.fetch(TEMPLATE_IMAGE_URL, {
    muteHttpExceptions: true,
    followRedirects: true
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('Artwork download returned HTTP ' + response.getResponseCode());
  }
  return response.getBlob();
}

/** Places one non-empty line of guest data. Slides text boxes pad their contents, so back that out. */
function addTicketField(slide, text, pos, sizePt, color, pageW, requestedWidth) {
  var value = String(text == null ? '' : text).trim();
  if (!value) return null;

  var INSET_X_PT = 7.2;   // Slides' own text-box padding, in points
  var INSET_Y_PT = 3.6;

  var left = pos.x - INSET_X_PT;
  var box = slide.insertTextBox(
    value,
    left,
    pos.y - INSET_Y_PT,
    Math.min(requestedWidth || 220, pageW - left),
    24
  );
  box.getText().getTextStyle()
    .setFontFamily('Arial')
    .setFontSize(sizePt)
    .setBold(true)
    .setForegroundColor(color);
  return box;
}

/** Estimates a conservative single-line font size for a fixed-width artwork blank. */
function fitSingleLineFontSize(text, maxSizePt, minSizePt, widthPt, averageEm) {
  var value = String(text == null ? '' : text).trim();
  if (!value) return maxSizePt;

  // Wide capitals count more than spaces and narrow punctuation. The safety
  // factor leaves room for Slides' font metrics and prevents last-letter wrap.
  var weightedLength = 0;
  for (var i = 0; i < value.length; i++) {
    var ch = value.charAt(i);
    if (/\s/.test(ch)) weightedLength += 0.45;
    else if (/[MW@#%&]/.test(ch)) weightedLength += 1.25;
    else if (/[ilI1.,'`|]/.test(ch)) weightedLength += 0.5;
    else weightedLength += 1;
  }

  var fitted = (widthPt * 0.9) / (Math.max(1, weightedLength) * (averageEm || 0.56));
  return Math.max(minSizePt, Math.min(maxSizePt, Math.floor(fitted * 2) / 2));
}

/** Anchors the bottom of a fitted name a small, consistent distance above its line. */
function positionTextAboveLine(linePos, sizePt, gapPt) {
  return {
    x: linePos.x,
    y: linePos.y - sizePt * 1.15 - (gapPt == null ? 2 : gapPt)
  };
}

/** Places the submitted guest name inside the artwork's "Welcome, ____ !" line. */
function addWelcomeName(slide, fullName, pos, requestedWidth, requestedHeight) {
  var name = String(fullName || '').trim();
  if (!name) return null;
  var fontSize = fitSingleLineFontSize(name, 11.5, 5.5, requestedWidth, 0.56);
  var textPos = positionTextAboveLine(pos, fontSize, 2);
  var insetX = 7.2;
  var insetY = 3.6;
  var box = slide.insertTextBox(
    name,
    textPos.x - insetX,
    textPos.y - insetY,
    requestedWidth + insetX * 2,
    requestedHeight + insetY * 2
  );
  box.getText().getTextStyle()
    .setFontFamily('Arial')
    .setFontSize(fontSize)
    .setBold(true)
    .setItalic(true)
    .setForegroundColor('#a71018');
  box.getText().getParagraphStyle()
    .setParagraphAlignment(SlidesApp.ParagraphAlignment.CENTER);
  return box;
}

/** Emails one guest their PDF e-pass, retrying transient build failures. */
function sendTicketEmail(fullName, email, guestCount, uniqueID, meal) {
  var additionalGuests = Math.max(0, parseInt(guestCount, 10) || 0);
  var attendeeCount = String(1 + additionalGuests);
  var pdfAttachment = getOrCreateTicketPdf_(fullName, attendeeCount, uniqueID);

  MailApp.sendEmail({
    to: email,
    subject: 'Your Official Entry Pass — 12th Gravity Foundation Day',
    body: 'Hello ' + fullName + '👋\n\n' +
          'Thank you for confirming your RSVP for 12th Gravity Foundation Day! 🎉 ' +
          'We’re delighted to have you join us for the celebration. ✨\n\n' +
          '🎟️ Your personalised entry pass is attached. Please keep it handy for a smooth entry.\n\n' +
          'Ticket ID: ' + uniqueID + '\n\n' +
          '📍 Venue Location: https://maps.app.goo.gl/J7xcZGSBWMUaD1v86?g_st=ic\n\n' +
          'We can’t wait to celebrate this special evening with you! 🌟',
    attachments: [pdfAttachment]
  });
}

/**
 * Resets rows that gave up back to "Pending" and reprocesses immediately.
 * With the sweep trigger installed you shouldn't need this, but it's here
 * for when you've fixed an underlying cause and want everything resent.
 */
function retryFailedTickets() {
  var sheet = getSpreadsheet().getSheetByName(SHEET_NAME);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('No RSVP rows yet.'); return; }

  var statuses = sheet.getRange(2, STATUS_COL, lastRow - 1, 1).getValues();
  var reset = 0;

  for (var i = 0; i < statuses.length; i++) {
    var s = String(statuses[i][0]);
    if (s.indexOf('Failed') === 0 || s.indexOf('Retry ') === 0) {
      sheet.getRange(i + 2, STATUS_COL).setValue('Pending');
      reset++;
    }
  }

  Logger.log('Reset ' + reset + ' row(s) to Pending.');
  if (reset > 0) processPendingTickets();
}

/** Resets known failed WhatsApp rows. Unknown rows are intentionally excluded. */
function retryFailedWhatsAppRows() {
  var sheet = getSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) { Logger.log('No RSVP rows yet.'); return; }
  ensureSheetSchema_(sheet);

  var lastRow = sheet.getLastRow();
  var values = sheet.getRange(2, WHATSAPP_STATUS_COL, lastRow - 1, 5).getValues();
  var reset = 0;
  for (var i = 0; i < values.length; i++) {
    var status = String(values[i][0] || '');
    if (status === 'Failed' || status === 'Disconnected' || status.indexOf('Retry ') === 0) {
      values[i] = ['Pending', '', 0, '', new Date()];
      reset++;
    }
  }
  if (reset) sheet.getRange(2, WHATSAPP_STATUS_COL, lastRow - 1, 5).setValues(values);
  Logger.log('Reset ' + reset + ' WhatsApp row(s) to Pending. Unknown rows were not changed.');
  if (reset > 0) processPendingWhatsApp();
}

/** Shows WhatsApp state without exposing full phone numbers. */
function whatsappStatusReport() {
  var sheet = getSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) { Logger.log('No RSVP rows yet.'); return; }
  ensureSheetSchema_(sheet);

  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, TOTAL_COLS).getValues();
  rows.forEach(function (row, i) {
    var number = String(row[WHATSAPP_NUMBER_COL - 1] || '');
    var masked = number.length > 4 ? new Array(number.length - 3).join('*') + number.slice(-4) : number;
    Logger.log('row ' + (i + 2) + ' | ' + row[1] + ' | ' + masked + ' | ' +
               row[WHATSAPP_STATUS_COL - 1] + ' | attempts ' +
               (row[WHATSAPP_ATTEMPTS_COL - 1] || 0));
  });
}

/** Manual live test. Set WHATSAPP_TEST_NUMBER in Script Properties first. */
function testWhatsAppPdf() {
  var props = PropertiesService.getScriptProperties();
  var number = normalizeWhatsAppNumber(props.getProperty('WHATSAPP_TEST_NUMBER'));
  if (!number) throw new Error('Set a valid WHATSAPP_TEST_NUMBER in Script Properties.');
  var config = getEvolutionConfig_();
  var state = getEvolutionConnectionState_(config);
  if (state !== 'open' && state !== 'connected') {
    throw new Error('Evolution instance is not connected. Current state: ' + state);
  }
  var testId = 'GRV-2026-TEST-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HHmmss');
  var result = sendTicketWhatsApp('Gravity Test Guest', number, '0', testId, config);
  Logger.log('WhatsApp test accepted. Message ID: ' + (result.messageId || 'not returned'));
}

/** Alias matching the deployment runbook terminology. */
function testEvolutionPdf() {
  return testWhatsAppPdf();
}

/** Safe local diagnostic for the phone normaliser. */
function testPhoneNumberNormalization() {
  var cases = [
    ['98765 43210', '919876543210'],
    ['+91 98765-43210', '919876543210'],
    ['0091 98765 43210', '919876543210'],
    ['+44 7700 900123', '447700900123'],
    ['12345', ''],
    ['not-a-phone', '']
  ];
  cases.forEach(function (item) {
    var actual = normalizeWhatsAppNumber(item[0]);
    if (actual !== item[1]) {
      throw new Error('Normalisation failed for ' + item[0] + ': got ' + actual);
    }
  });
  Logger.log('Phone number normalisation tests passed.');
}

/** Shows what state every RSVP row is in, without opening the sheet. */
function ticketStatusReport() {
  var sheet = getSpreadsheet().getSheetByName(SHEET_NAME);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('No RSVP rows yet.'); return; }

  var rows = sheet.getRange(2, 1, lastRow - 1, STATUS_COL).getValues();
  rows.forEach(function (r, i) {
    Logger.log('row ' + (i + 2) + ' | ' + r[1] + ' | ' + r[3] + ' | ' + r[STATUS_COL - 1]);
  });

  var triggers = ScriptApp.getProjectTriggers().map(function (t) {
    return t.getHandlerFunction();
  });
  Logger.log('Active triggers: ' + (triggers.length ? triggers.join(', ') : 'none'));
}

/** Run this manually to grant permissions and preview a sample pass in your Drive. */
function testTicketPdf() {
  var pdf = buildTicketPdf('Aryan Singh', '3', 'GRV-2026-TEST');
  var file = DriveApp.createFile(pdf);
  Logger.log('Sample pass created: ' + file.getUrl());
}

/** Diagnostic: confirms the Slides template is set to the ticket's 2:3 page. */
function checkSlideTemplate() {
  var presentation = SlidesApp.openById(SLIDE_TEMPLATE_ID);
  var w = presentation.getPageWidth();
  var h = presentation.getPageHeight();

  Logger.log('Template page: ' + w + ' x ' + h + ' pt  (' +
             (w / 72).toFixed(2) + ' x ' + (h / 72).toFixed(2) + ' in)');
  Logger.log('Aspect ratio : ' + (w / h).toFixed(4) + '   wanted ' +
             (TICKET_W_PX / TICKET_H_PX).toFixed(4));

  var off = Math.abs(w / h - TICKET_W_PX / TICKET_H_PX);
  Logger.log(off < 0.01
    ? 'OK — the artwork will fill the page edge to edge.'
    : 'MISMATCH — File > Page setup > Custom > 5.33 x 8 inches.');
}

/** Optional: lets you test the GET URL in a browser. */
function doGet() {
  try {
    var ss = getSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME);
    return ContentService
      .createTextOutput(JSON.stringify({
        result: 'success',
        spreadsheetId: ss.getId(),
        spreadsheetUrl: ss.getUrl(),
        sheetName: SHEET_NAME,
        lastRow: sheet ? sheet.getLastRow() : 0
      }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ result: 'error', message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
