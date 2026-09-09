const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// Exercise the actual inline form logic without sending RSVPs or emails.
function setup() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        value: '', checked: false, disabled: false, style: {},
        classList: {
          add: (...names) => names.forEach(name => classes.add(name)),
          remove: (...names) => names.forEach(name => classes.delete(name)),
          contains: name => classes.has(name),
          toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
        },
        setAttribute() {},
      });
    }
    return elements.get(id);
  }
  const context = vm.createContext({
    document: { getElementById: element, querySelector: element },
    window: { innerWidth: 1024 },
    console,
  });
  vm.runInContext(script, context);
  let submitted;
  context.postToSheet = async payload => { submitted = payload; };
  context.launchConfetti = () => {};
  return { context, element, payload: () => submitted };
}

test('fields are separated into four distinct steps with unique IDs', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  const expected = [['fullname', 'email'], ['mobile', 'whatsapp-consent'], ['guest-question'], ['guest-value']];
  const steps = html.split(/<div class="step(?: active)?" id="step-\d">/).slice(1);
  assert.equal(steps.length, 4);
  expected.forEach((fields, index) => {
    fields.forEach(id => assert.ok(steps[index].includes(`id="${id}"`)));
    expected.flat().filter(id => !fields.includes(id)).forEach(id => {
      assert.ok(!steps[index].includes(`id="${id}"`));
    });
  });
});

for (const guest of ['yes', 'no']) {
  test(`Submit advances and validates each step; guest=${guest}`, async () => {
    const { context: c, element: el, payload } = setup();
    c.goNext();
    assert.equal(c.currentStep, 1);
    assert.ok(!el('err-mobile').classList.contains('show'));
    assert.ok(!el('err-guest').classList.contains('show'));
    el('fullname').value = 'Test Attendee';
    el('email').value = 'invalid';
    c.goNext();
    assert.equal(c.currentStep, 1);
    el('email').value = 'test@example.com';
    c.goNext();
    assert.equal(c.currentStep, 2);
    c.goNext();
    assert.equal(c.currentStep, 2);
    el('mobile').value = '+91 98765 43210';
    c.goNext();
    assert.equal(c.currentStep, 3);
    c.goNext();
    assert.equal(c.currentStep, 3);
    c.radioValues.guest = guest;
    c.updateProgress(c.currentStep);
    c.updateNavigation();
    if (guest === 'yes') {
      c.goNext();
      assert.equal(c.currentStep, 4);
      c.changeGuests(2);
    }
    assert.equal(c.currentStep, guest === 'yes' ? 4 : 3);
    assert.match(el('btn-next').innerHTML, /Submit RSVP/);
    assert.equal(el('progress-fill').style.width, '100%');
    c.goNext();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(payload().fullName, 'Test Attendee');
    assert.equal(payload().mobile, '+91 98765 43210');
    assert.equal(payload().guestCount, guest === 'yes' ? '3' : '0');
    assert.equal(payload().whatsappConsent, false);
    assert.equal(el('form-card').style.display, 'none');
  });
}

test('changing guest answer skips count without losing contact details', () => {
  const { context: c, element: el } = setup();
  el('fullname').value = 'Test Attendee';
  el('email').value = 'test@example.com';
  el('mobile').value = '9876543210';
  c.goNext(); c.goNext();
  c.radioValues.guest = 'yes';
  c.goNext(); c.changeGuests(1); c.goBack();
  c.radioValues.guest = 'no';
  c.updateProgress(c.currentStep);
  c.updateNavigation();
  assert.equal(c.currentStep, 3);
  c.goBack(); c.goBack();
  assert.equal(c.currentStep, 1);
  assert.equal(el('fullname').value, 'Test Attendee');
  assert.equal(el('mobile').value, '9876543210');
  assert.match(el('btn-next').innerHTML, /Submit/);
});

test('WhatsApp consent is explicit and phone numbers are normalized safely', async () => {
  const { context: c, element: el, payload } = setup();
  assert.equal(c.normalizeWhatsAppNumber('98765 43210'), '919876543210');
  assert.equal(c.normalizeWhatsAppNumber('+91 98765-43210'), '919876543210');
  assert.equal(c.normalizeWhatsAppNumber('+44 7700 900123'), '447700900123');
  assert.equal(c.normalizeWhatsAppNumber('12345'), '');
  assert.equal(c.normalizeWhatsAppNumber('1234567890'), '');

  el('fullname').value = 'WhatsApp Test';
  el('email').value = 'whatsapp@example.com';
  el('mobile').value = '+91 98765 43210';
  el('whatsapp-consent').checked = true;
  c.radioValues.guest = 'no';
  await c.submitForm();
  assert.equal(payload().whatsappConsent, true);
});
