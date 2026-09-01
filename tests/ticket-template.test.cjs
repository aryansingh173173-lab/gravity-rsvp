const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'gravity-rsvp-appsscript.gs'), 'utf8');
const artwork = fs.readFileSync(path.join(root, 'gravity-annual-day-pass-template.png'));

test('approved artwork is the expected 1024 × 1535 PNG', () => {
  assert.equal(artwork.subarray(1, 4).toString(), 'PNG');
  assert.equal(artwork.readUInt32BE(16), 1024);
  assert.equal(artwork.readUInt32BE(20), 1535);
});

test('ticket generator fills only the three artwork fields', () => {
  const build = source.match(/function buildTicketPdf[\s\S]*?\n}\n\n\/\*\*/)[0];
  const calls = [...build.matchAll(/addTicketField\(slide,/g)];
  assert.equal(calls.length, 3);
  assert.match(build, /fullName/);
  assert.match(build, /attendeeCount/);
  assert.match(build, /uniqueID/);
  assert.doesNotMatch(build, /quickchart|guestText|\bmeal\b/);
});

test('attendees includes the registrant plus additional guests', () => {
  assert.match(source, /var additionalGuests = Math\.max\(0, parseInt\(guestCount, 10\) \|\| 0\);/);
  assert.match(source, /var attendeeCount = String\(1 \+ additionalGuests\);/);
  assert.match(source, /buildTicketPdf\(fullName, attendeeCount, uniqueID\)/);
  assert.match(source, /buildTicketPdf\('Aryan Singh', '3', 'GRV-2026-TEST'\)/);
});
