const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const appsScript = fs.readFileSync(path.join(root, 'gravity-rsvp-appsscript.gs'), 'utf8');
const form = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const proxy = fs.readFileSync(path.join(root, 'api', 'rsvp.js'), 'utf8');
const render = fs.readFileSync(path.join(root, 'evolution-deploy', 'render.yaml'), 'utf8');
const evolutionEnv = fs.readFileSync(path.join(root, 'evolution-deploy', 'example.env'), 'utf8');
const supabaseSetup = fs.readFileSync(path.join(root, 'evolution-deploy', 'supabase-setup.sql'), 'utf8');
const dockerfile = fs.readFileSync(path.join(root, 'evolution-deploy', 'Dockerfile'), 'utf8');

test('spreadsheet migration preserves A:J and appends the WhatsApp audit columns', () => {
  const setup = appsScript.match(/function setupSheet[\s\S]*?\n}/)[0];
  assert.doesNotMatch(setup, /\.clear\s*\(/);
  assert.match(appsScript, /var STATUS_COL = 10/);
  assert.match(appsScript, /var WHATSAPP_CONSENT_COL = 11/);
  assert.match(appsScript, /var WHATSAPP_UPDATED_AT_COL = 17/);
  for (const heading of [
    'WhatsApp Consent', 'WhatsApp Number', 'WhatsApp Status',
    'WhatsApp Message ID', 'WhatsApp Attempts', 'WhatsApp Last Error',
    'WhatsApp Updated At'
  ]) {
    assert.ok(appsScript.includes(`'${heading}'`), `missing ${heading}`);
  }
  assert.match(appsScript, /Existing RSVP data was not changed/);
});

test('WhatsApp consent is optional, explicit, and submitted with the RSVP', () => {
  assert.match(form, /id="whatsapp-consent"/);
  assert.match(form, /I agree to receive my Gravity Foundation Day invitation and event updates on WhatsApp/);
  assert.match(form, /var whatsappConsent = document\.getElementById\('whatsapp-consent'\)\.checked/g);
  assert.match(form, /whatsappConsent:\s*whatsappConsent/g);
  assert.match(appsScript, /var whatsappConsent = parseBoolean_\(data\.whatsappConsent\)/);
  assert.match(appsScript, /!whatsappConsent\s*\? 'No consent'/);
});

test('phone normalization uses international digits and defaults valid Indian mobiles to 91', () => {
  const functionSource = appsScript.match(/function normalizeWhatsAppNumber[\s\S]*?\n}/)[0];
  const normalize = Function(`return (${functionSource})`)();
  assert.equal(normalize('98765 43210'), '919876543210');
  assert.equal(normalize('+91 98765-43210'), '919876543210');
  assert.equal(normalize('0044 7700 900123'), '447700900123');
  assert.equal(normalize('1234567890'), '');
  assert.equal(normalize('not-a-number'), '');
});

test('email and WhatsApp have independent queues and status fields', () => {
  assert.match(appsScript, /var TICKET_HANDLER = 'processPendingTickets'/);
  assert.match(appsScript, /var WHATSAPP_HANDLER = 'processPendingWhatsApp'/);
  assert.match(appsScript, /function sweepPendingTickets\(\)\s*{\s*processPendingTickets\(\);\s*processPendingWhatsApp\(\);/);
  assert.match(appsScript, /needsTicket \? 'Pending' : 'Not required'/);
  assert.match(appsScript, /if \(whatsappStatus === 'Pending'\)/);
});

test('PDF uploads preserve numeric Sheet phone cells as JSON strings and encode PDF bytes', () => {
  const normalizeSource = appsScript.match(/function normalizeWhatsAppNumber[\s\S]*?\n}/)[0];
  const normalize = Function(`return (${normalizeSource})`)();
  const sendSource = appsScript.match(/function sendTicketWhatsApp[\s\S]*?\n}/)[0];
  const requests = [];
  const attendees = [];
  const pdfBytes = [37, 80, 68, 70, 45];
  const blob = { copyBlob() { return this; }, setName() { return this; }, getBytes() { return pdfBytes; } };
  const send = Function(
    'normalizeWhatsAppNumber', 'getWhatsAppDefaultCountryCode_',
    'getOrCreateTicketPdf_', 'UrlFetchApp', 'extractEvolutionMessageId_', 'evolutionError_', 'Utilities',
    'Logger', 'ScriptApp',
    `return (${sendSource})`
  )(
    normalize, () => '91', (name, count) => { attendees.push(count); return blob; },
    { fetch(url, options) {
      requests.push(options);
      return { getResponseCode: () => 201, getContentText: () => '{"key":{"id":"test-message"}}' };
    } },
    data => data.key.id, message => new Error(message),
    { base64Encode: bytes => Buffer.from(bytes).toString('base64') },
    { log() {} }, { getScriptId: () => 'test-project' }
  );
  for (const [number, guests] of [[919876543210, '0'], [919876543210, '1'], ['919876543210', '1'], [919876543210, '3']]) {
    send('Test Guest', number, guests, 'TEST-ID', {
      baseUrl: 'https://example.test', apiKey: 'test-key', instanceName: 'test'
    });
    assert.equal(requests.at(-1).contentType, 'application/json');
    const payload = JSON.parse(requests.at(-1).payload);
    assert.equal(payload.number, '919876543210');
    assert.equal(payload.mimetype, 'application/pdf');
    assert.deepEqual([...Buffer.from(payload.media, 'base64')], pdfBytes);
    assert.equal(payload.file, undefined);
    assert.equal(payload.caption, 'Hello Test Guest👋\n\n' +
      'Thank you for confirming your RSVP for 12th Gravity Foundation Day! 🎉 ' +
      'We’re delighted to have you join us for the celebration. ✨\n\n' +
      '🎟️ Your personalised entry pass is attached. Please keep it handy for a smooth entry.\n\n' +
      'Ticket ID: TEST-ID\n\n' +
      '📍 Venue Location: https://maps.app.goo.gl/J7xcZGSBWMUaD1v86?g_st=ic\n\n' +
      'We can’t wait to celebrate this special evening with you! 🌟');
  }
  assert.throws(() => send('Test Guest', 'invalid', '0', 'TEST-ID', {}), /Invalid WhatsApp/);
  assert.equal(requests.length, 4);
  assert.deepEqual(attendees, ['1', '2', '2', '4']);
});

test('email uses the Foundation Day message with personalized details and attached PDF', () => {
  const source = appsScript.match(/function sendTicketEmail[\s\S]*?\n}/)[0];
  const messages = [];
  const pdf = {};
  const send = Function('getOrCreateTicketPdf_', 'MailApp', `return (${source})`)(
    (name, count, id) => {
      assert.equal(name, 'Test Guest');
      assert.equal(count, '3');
      assert.equal(id, 'TEST-ID');
      return pdf;
    },
    { sendEmail: message => messages.push(message) }
  );
  send('Test Guest', 'guest@example.test', '2', 'TEST-ID');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, 'guest@example.test');
  assert.equal(messages[0].subject, 'Your Official Entry Pass — 12th Gravity Foundation Day');
  assert.equal(messages[0].body, 'Hello Test Guest👋\n\n' +
    'Thank you for confirming your RSVP for 12th Gravity Foundation Day! 🎉 ' +
    'We’re delighted to have you join us for the celebration. ✨\n\n' +
    '🎟️ Your personalised entry pass is attached. Please keep it handy for a smooth entry.\n\n' +
    'Ticket ID: TEST-ID\n\n' +
    '📍 Venue Location: https://maps.app.goo.gl/J7xcZGSBWMUaD1v86?g_st=ic\n\n' +
    'We can’t wait to celebrate this special evening with you! 🌟');
  assert.deepEqual(messages[0].attachments, [pdf]);
});

test('email and WhatsApp reuse one privately cached generated PDF', () => {
  const email = appsScript.match(/function sendTicketEmail[\s\S]*?\n}/)[0];
  const whatsapp = appsScript.match(/function sendTicketWhatsApp[\s\S]*?\n}/)[0];
  assert.match(email, /getOrCreateTicketPdf_/);
  assert.match(whatsapp, /getOrCreateTicketPdf_/);
  assert.doesNotMatch(email, /buildTicketPdf\(/);
  assert.doesNotMatch(whatsapp, /buildTicketPdf\(/);
  assert.match(appsScript, /GENERATED_TICKET_FILE_/);
  assert.match(appsScript, /DriveApp\.createFolder\('Gravity RSVP 2026 Generated Passes'\)/);
  assert.doesNotMatch(appsScript, /setSharing|Access\.ANYONE/);
});

test('Evolution configuration stays in Script Properties and media delivery is idempotency-aware', () => {
  for (const property of [
    'EVOLUTION_BASE_URL', 'EVOLUTION_API_KEY', 'EVOLUTION_INSTANCE_NAME'
  ]) {
    assert.match(appsScript, new RegExp(`getProperty\\('${property}'\\)`));
  }
  assert.match(appsScript, /\/instance\/connectionState\//);
  assert.match(appsScript, /\/message\/sendMedia\//);
  assert.match(appsScript, /headers: \{ apikey: config\.apiKey \}/g);
  assert.match(appsScript, /if \(existingMessageId\)/);
  assert.match(appsScript, /accepted the request but returned no message ID/);
  assert.match(appsScript, /function sanitizeEvolutionError_/);
  assert.match(appsScript, /'Unknown'/);
  assert.doesNotMatch(appsScript, /evoapicloud\.com|AUTHENTICATION_API_KEY\s*=|EVOLUTION_API_KEY\s*=/);
});

test('public RSVP proxy validates submissions, rate limits, and can authenticate to Apps Script', () => {
  assert.match(proxy, /const RATE_LIMIT = 30/);
  assert.match(proxy, /validatePayload\(payload\)/);
  assert.match(proxy, /APPS_SCRIPT_SHARED_SECRET/);
  assert.match(form, /id="company-website"/);
  assert.match(proxy, /payload\._website/);
  assert.doesNotMatch(proxy, /console\.(?:log|error)\([^\n]*(?:payload|req\.body)/);
});

test('Render blueprint pins Evolution and keeps Supabase and API secrets external', () => {
  assert.match(render, /docker\.io\/evoapicloud\/evolution-api:v2\.3\.7/);
  assert.match(render, /key: DATABASE_CONNECTION_URI\s+sync: false/);
  assert.match(render, /key: AUTHENTICATION_API_KEY\s+generateValue: true/);
  assert.match(render, /key: DATABASE_SAVE_DATA_INSTANCE\s+value: "true"/);
  assert.match(render, /key: DATABASE_SAVE_DATA_NEW_MESSAGE\s+value: "false"/);
  assert.doesNotMatch(render, /postgres(?:ql)?:\/\/[^\s]+:[^\s]+@/);
});

test('deployment examples isolate Evolution in Supabase without storing RSVP records', () => {
  assert.match(evolutionEnv, /DATABASE_CONNECTION_URI=.*schema=evolution_api&sslmode=require/);
  assert.match(evolutionEnv, /EVOLUTION_API_KEY=<same value as AUTHENTICATION_API_KEY>/);
  assert.match(evolutionEnv, /APPS_SCRIPT_URL=https:\/\/script\.google\.com\/macros\/s\/DEPLOYMENT_ID\/exec/);
  assert.match(supabaseSetup, /create schema if not exists evolution_api authorization postgres/i);
  assert.match(supabaseSetup, /revoke all on schema evolution_api from anon, authenticated/i);
  assert.doesNotMatch(supabaseSetup, /create table/i);
  assert.doesNotMatch(evolutionEnv, /SUPABASE_(?:ANON|SERVICE_ROLE)_KEY=/);
});

test('Git-backed Render deployment inherits the pinned Evolution image', () => {
  assert.match(dockerfile, /FROM docker\.io\/evoapicloud\/evolution-api:v2\.3\.7/);
  assert.match(dockerfile, /SERVER_PORT=10000/);
  assert.match(dockerfile, /EXPOSE 10000/);
  assert.doesNotMatch(dockerfile, /CMD|ENTRYPOINT/);
});

const scientificPhoneError = 'Evolution returned HTTP 400: {"response":{"message":[{"exists":false,"number":"9.19876543210E11"}]}}';

function recoveryContext() {
  const context = vm.createContext({ Logger: { log() {} } });
  vm.runInContext(appsScript, context);
  return context;
}

function recoveryRow(status = 'Failed', attempts = 1, error = scientificPhoneError) {
  const row = Array(17).fill('');
  row[1] = 'TEST-TICKET'; row[2] = 'Test Guest'; row[4] = '919876543210';
  row[5] = 'Attending'; row[6] = 3; row[10] = 'Yes'; row[11] = 919876543210;
  row[12] = status; row[14] = attempts; row[15] = error;
  return row;
}

test('automatic recovery excludes unrelated failures, unknown sends, no consent and exhausted attempts', () => {
  const ctx = recoveryContext();
  assert.equal(ctx.isWhatsAppWorkCandidate_(recoveryRow()), true);
  assert.equal(ctx.isWhatsAppWorkCandidate_(recoveryRow('Failed', 2)), true);
  for (const status of ['Sent', 'Unknown', 'Sending', 'No consent', 'Invalid number']) {
    assert.equal(ctx.isWhatsAppWorkCandidate_(recoveryRow(status)), false, status);
  }
  assert.equal(ctx.isWhatsAppWorkCandidate_(recoveryRow('Failed', 3)), false);
  assert.equal(ctx.isWhatsAppWorkCandidate_(recoveryRow('Pending', 3)), false);
  assert.equal(ctx.isWhatsAppWorkCandidate_(recoveryRow('Failed', 1,
    'Evolution returned HTTP 400: {"exists":false,"number":"919876543210"}')), false);
  const noConsent = recoveryRow(); noConsent[10] = 'No';
  assert.equal(ctx.isWhatsAppWorkCandidate_(noConsent), false);
  const sent = recoveryRow(); sent[13] = 'provider-message-id';
  assert.equal(ctx.isWhatsAppWorkCandidate_(sent), false);
});

test('repeated workers retain attempts, stop at three, and never call email delivery', () => {
  const ctx = recoveryContext();
  const row = recoveryRow();
  let sends = 0;
  let released = 0;
  const sheet = { getLastRow: () => 2, getRange: () => ({ getValues: () => [row] }) };
  Object.assign(ctx, {
    clearWhatsAppTriggers() {}, ensureSheetSchema_() {}, scheduleWhatsAppRun() {},
    getEvolutionConfig_: () => ({ batchSize: 10 }),
    getEvolutionConnectionState_: () => 'open',
    getSpreadsheet: () => ({ getSheetByName: () => sheet }),
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() { released++; } }) },
    updateWhatsAppState_(sheet, rowNum, status, id, attempts, error) {
      row[12] = status; row[13] = id; row[14] = attempts; row[15] = error;
    },
    sendTicketWhatsApp() { sends++; throw ctx.evolutionError_(scientificPhoneError, false, false); },
    sendTicketEmail() { assert.fail('Recovery must not resend email'); }
  });
  ctx.processPendingWhatsApp();
  assert.equal(row[14], 2);
  assert.equal(row[12], 'Retry 2');
  ctx.processPendingWhatsApp();
  assert.equal(row[14], 3);
  assert.equal(row[12], 'Failed');
  ctx.processPendingWhatsApp();
  assert.equal(sends, 2);
  assert.equal(released, 3);
});

test('recovery records acceptance and does not resend it on the next run', () => {
  const ctx = recoveryContext();
  const row = recoveryRow();
  let sends = 0;
  Object.assign(ctx, {
    clearWhatsAppTriggers() {}, ensureSheetSchema_() {},
    getEvolutionConfig_: () => ({ batchSize: 10 }), getEvolutionConnectionState_: () => 'open',
    getSpreadsheet: () => ({ getSheetByName: () => ({ getLastRow: () => 2,
      getRange: () => ({ getValues: () => [row] }) }) }),
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    updateWhatsAppState_(sheet, rowNum, status, id, attempts, error) {
      row[12] = status; row[13] = id; row[14] = attempts; row[15] = error;
    },
    sendTicketWhatsApp() { sends++; return { messageId: 'accepted-id' }; }
  });
  ctx.processPendingWhatsApp();
  ctx.processPendingWhatsApp();
  assert.equal(sends, 1);
  assert.equal(row[12], 'Sent');
  assert.equal(row[14], 2);
});

test('one-minute recovery trigger installation preserves other handlers and avoids duplicates', () => {
  const ctx = recoveryContext();
  let triggers = ['sweepPendingTickets', 'processPendingWhatsApp', 'sweepPendingWhatsApp']
    .map(name => ({ getHandlerFunction: () => name }));
  ctx.ScriptApp = {
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger(trigger) { triggers = triggers.filter(item => item !== trigger); },
    newTrigger(name) { return { timeBased() { return this; }, everyMinutes(minutes) {
      assert.equal(minutes, 1); return this;
    }, create() { triggers.push({ getHandlerFunction: () => name }); } }; }
  };
  ctx.installWhatsAppRetryTrigger();
  ctx.installWhatsAppRetryTrigger();
  assert.deepEqual(triggers.map(t => t.getHandlerFunction()),
    ['sweepPendingTickets', 'processPendingWhatsApp', 'sweepPendingWhatsApp']);
});

test('PDF cache skips legacy tickets and reuses only PDFs for the current artwork', () => {
  const ctx = recoveryContext();
  const props = { GENERATED_TICKET_FILE_TEST: 'old-pdf-id' };
  const reads = [];
  let builds = 0;
  const blob = { setName() { return this; } };
  Object.assign(ctx, {
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => props[key] || '', setProperty(key, value) { props[key] = value; },
      deleteProperty(key) { delete props[key]; }
    }) },
    DriveApp: { getFileById(id) { reads.push(id); return {
      isTrashed: () => false, getBlob: () => blob, getName: () => 'pass.pdf'
    }; } },
    withRetry: (label, callback) => callback(),
    buildTicketPdf() { builds++; return blob; },
    getGeneratedTicketFolder_: () => ({ createFile: () => ({
      setDescription() {}, getId: () => 'new-pdf-id', getBlob: () => blob, getName: () => 'pass.pdf'
    }) })
  });
  ctx.getOrCreateTicketPdf_('Test Guest', '2', 'TEST');
  ctx.getOrCreateTicketPdf_('Test Guest', '2', 'TEST');
  assert.equal(builds, 1);
  assert.deepEqual(reads, ['new-pdf-id']);
  assert.equal(props.GENERATED_TICKET_FILE_TEST, 'old-pdf-id');
  ctx.TEMPLATE_IMAGE_URL += '&revision=next';
  ctx.getOrCreateTicketPdf_('Test Guest', '2', 'TEST');
  assert.equal(builds, 2);
});
