/**
 * GRAVITY ANNUAL DAY 2026 — RSVP backend
 * Receives form submissions from the HTML form and writes them to the sheet,
 * then builds + emails the PDF e-pass in the background.
 *
 * SETUP:
 *  1. Create a Google Sheet. Open Extensions > Apps Script. Paste this file.
 *  2. Services (left sidebar) > + > "Google Slides API" > Add.
 *  3. Make a blank Slides file, set File > Page setup > Custom > 5.33 x 8 in,
 *     and put its ID in SLIDE_TEMPLATE_ID below. Verify with checkSlideTemplate().
 *  4. Run setupSheet() once to create the header row.
 *  5. Run installSweepTrigger() once — the safety net that retries failures.
 *  6. Deploy > New deployment > type "Web app".
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
var SPREADSHEET_ID = '18tuY1IeFRz2XenryFE3kfXTiZxUbNa7Cs_4kExr9JU0';
var TEMPLATE_IMAGE_ID = '12CI_jNF7hBoHpv-BTBqcQqLSELuloAE4';

// A blank Slides file whose page setup is 5.33 x 8 in (the artwork's 2:3 shape).
// Slides.Presentations.create() ignores any pageSize you pass and the API cannot
// resize a deck afterwards, so each pass is built by copying this one.
var SLIDE_TEMPLATE_ID = '1W3KZYUnmOSLEY6_uLb1vZZ5Vq-W8qAEcTpgmUKAgiVM';

var STATUS_COL = 10;          // "Ticket Status"
var TICKET_HANDLER = 'processPendingTickets';   // one-off, fires ~5s after an RSVP
var SWEEP_HANDLER  = 'sweepPendingTickets';     // recurring safety net
var MAX_RUN_MS = 4.5 * 60 * 1000;   // leave headroom under the 6-minute cap

var BUILD_ATTEMPTS = 3;   // in-process retries around a single PDF build
var MAX_ATTEMPTS = 5;     // how many separate runs a row gets before giving up

// The ticket artwork is 2:3. Field positions below are in the same 512x768
// coordinate space used to lay out the preview.
var TICKET_W_PX = 512;
var TICKET_H_PX = 768;
var PX_TO_PT = 0.75;

/** Helper to get Spreadsheet by ID or active context */
function getSpreadsheet() {
  if (!SPREADSHEET_ID) {
    throw new Error('SPREADSHEET_ID is not configured.');
  }
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

/** Run this ONCE to set up the header row. */
function setupSheet() {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  sheet.clear();
  sheet.getRange(1, 1, 1, STATUS_COL).setValues([[
    'Timestamp', 'Unique ID', 'Full Name', 'Email Address',
    'Mobile Number', 'Attending', 'Guest Count', 'Meal Preference',
    'Special Requirements', 'Ticket Status'
  ]]);
  sheet.getRange(1, 1, 1, STATUS_COL)
    .setFontWeight('bold').setBackground('#D32030').setFontColor('#ffffff');
  sheet.setFrozenRows(1);
}

/**
 * Handles POST requests from the HTML form.
 * Saves the row and returns immediately — the e-pass is mailed by a trigger.
 */
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    var fullName    = data.fullName    || '';
    var email       = data.email       || '';
    var mobile      = data.mobile      || '';
    var attending   = data.attending   || '';
    var guestCount  = data.guestCount  || '0';
    var meal        = data.meal        || '';
    var specialRequirements = data.specialRequirements || '';

    var needsTicket = attending === 'Attending' && !!email;
    var saved = appendRsvp([fullName, email, mobile, attending,
                            guestCount, meal, specialRequirements], needsTicket);

    if (needsTicket) {
      scheduleTicketRun(5000);
    }

    return ContentService
      .createTextOutput(JSON.stringify({
        result: 'success',
        id: saved.uniqueID,
        spreadsheetId: saved.spreadsheetId,
        spreadsheetUrl: saved.spreadsheetUrl,
        sheetName: SHEET_NAME,
        row: saved.row,
        ticket: needsTicket ? 'queued' : 'not required'
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ result: 'error', message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Appends one RSVP under a lock, so two submissions landing together can't
 * be handed the same ticket ID.
 */
function appendRsvp(fields, needsTicket) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = getSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);

    var row = sheet.getLastRow() + 1;
    var uniqueID = 'GRV-2026-' + (1000 + row);

    sheet.getRange(row, 1, 1, STATUS_COL).setValues([
      [new Date(), uniqueID].concat(fields).concat([needsTicket ? 'Pending' : 'Not required'])
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

/** Removes spent one-off triggers so they don't pile up against the quota. */
function clearTicketTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === TICKET_HANDLER) ScriptApp.deleteTrigger(t);
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
    Logger.log('Another run holds the lock; leaving this one to it.');
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

/**
 * Builds the e-pass by copying the correctly-sized Slides template, then
 * exports it as a full-bleed PDF and bins the copy.
 *
 * The layout is derived from the copy's real page size rather than assumed,
 * so the artwork always fills the page it is actually drawn on.
 */
function buildTicketPdf(fullName, guestText, meal, uniqueID) {
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

    slide.insertImage(
      DriveApp.getFileById(TEMPLATE_IMAGE_ID).getBlob(),
      offX, offY, drawW, drawH
    );

    var qrAt = at(178, 460);
    slide.insertImage(
      UrlFetchApp.fetch(
        'https://quickchart.io/qr?text=' + encodeURIComponent(uniqueID) + '&size=400&margin=1'
      ).getBlob(),
      qrAt.x, qrAt.y, 156 * scale, 156 * scale
    );

    addTicketField(slide, fullName,             at(173, 284), 15 * scale, '#2b2320', pageW);
    addTicketField(slide, 'You + ' + guestText, at(173, 354), 15 * scale, '#2b2320', pageW);
    addTicketField(slide, meal,                 at(173, 421), 15 * scale, '#2b2320', pageW);
    addTicketField(slide, uniqueID,             at(234, 618), 13 * scale, '#b01020', pageW);

    presentation.saveAndClose();

    pdf = DriveApp.getFileById(copy.getId())
      .getAs('application/pdf')
      .setName('Gravity_Pass_' + String(fullName).replace(/\s+/g, '_') + '.pdf');
  } finally {
    try { copy.setTrashed(true); } catch (e) { /* nothing useful to do */ }
  }

  return pdf;
}

/** Places one non-empty line of guest data. Slides text boxes pad their contents, so back that out. */
function addTicketField(slide, text, pos, sizePt, color, pageW) {
  var value = String(text == null ? '' : text).trim();
  if (!value) return null;

  var INSET_X_PT = 7.2;   // Slides' own text-box padding, in points
  var INSET_Y_PT = 3.6;

  var left = pos.x - INSET_X_PT;
  var box = slide.insertTextBox(
    value,
    left,
    pos.y - INSET_Y_PT,
    Math.min(220, pageW - left),
    24
  );
  box.getText().getTextStyle()
    .setFontFamily('Arial')
    .setFontSize(sizePt)
    .setBold(true)
    .setForegroundColor(color);
  return box;
}

/** Emails one guest their PDF e-pass, retrying transient build failures. */
function sendTicketEmail(fullName, email, guestCount, uniqueID, meal) {
  var count = String(guestCount || '0');
  var guestText = (count && count !== '0')
    ? (count + ' guest' + (count === '1' ? '' : 's'))
    : 'No additional guests';

  var pdfAttachment = withRetry('buildTicketPdf ' + uniqueID, function () {
    return buildTicketPdf(fullName, guestText, meal, uniqueID);
  });

  MailApp.sendEmail({
    to: email,
    subject: 'Your Official Entry Pass — Gravity Annual Day 2026',
    body: 'Dear ' + fullName + ',\n\n' +
          'Thank you for your RSVP. Please find your attached designer entry PDF ticket ' +
          'and QR code for the Gravity Annual Day 2026 celebration.\n\n' +
          'We look forward to welcoming you.\n\n' +
          'Warm regards,\nTeam Gravity',
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
  var pdf = buildTicketPdf('Aryan Singh', '3 guests', 'Vegetarian', 'GRV-2026-TEST');
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
