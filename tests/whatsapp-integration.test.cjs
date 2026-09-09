const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const appsScript = fs.readFileSync(path.join(root, 'gravity-rsvp-appsscript.gs'), 'utf8');
const form = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const proxy = fs.readFileSync(path.join(root, 'api', 'rsvp.js'), 'utf8');
const render = fs.readFileSync(path.join(root, 'evolution-deploy', 'render.yaml'), 'utf8');
const evolutionEnv = fs.readFileSync(path.join(root, 'evolution-deploy', 'example.env'), 'utf8');
const supabaseSetup = fs.readFileSync(path.join(root, 'evolution-deploy', 'supabase-setup.sql'), 'utf8');

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
  assert.match(form, /I agree to receive my Gravity Annual Day invitation and event updates on WhatsApp/);
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
