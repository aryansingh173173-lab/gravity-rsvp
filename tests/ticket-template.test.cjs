const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'gravity-rsvp-appsscript.gs'), 'utf8');
const artwork = fs.readFileSync(path.join(root, 'Gravity rsvp invitation.png'));

test('emailed artwork is the supplied 1024 x 1536 Gravity RSVP invitation PNG', () => {
  assert.equal(artwork.subarray(1, 4).toString(), 'PNG');
  assert.equal(artwork.readUInt32BE(16), 1024);
  assert.equal(artwork.readUInt32BE(20), 1536);
  assert.match(source, /Gravity%20rsvp%20invitation\.png\?v=20260908-rsvp-invitation/);
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

test('long names shrink while every dynamic value stays on a single artwork line', () => {
  const fitSource = source.match(/function fitSingleLineFontSize[\s\S]*?\n}/)[0];
  const fitSingleLineFontSize = Function(`return (${fitSource})`)();
  const shortNameSize = fitSingleLineFontSize('Aryan Singh', 12, 6.5, 194.25, 0.56);
  const longNameSize = fitSingleLineFontSize('Dakshayani Venkataraman Subramaniam', 12, 6.5, 194.25, 0.56);

  assert.equal(shortNameSize, 12);
  assert.ok(longNameSize < shortNameSize);
  assert.ok(longNameSize >= 6.5);
  assert.match(source, /addWelcomeName\(slide, fullName, at\(449, 1101\), 268 \* scale, 64 \* scale\)/);
});
