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
        },
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

test('fields are separated into six distinct steps with unique IDs', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  const expected = [['fullname', 'email'], ['mobile'], ['guest-question'], ['guest-value'], ['special'], ['confirm']];
  const steps = html.split(/<div class="step(?: active)?" id="step-\d">/).slice(1);
  assert.equal(steps.length, 6);
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
    c.goNext();
    if (guest === 'yes') {
      assert.equal(c.currentStep, 4);
      c.changeGuests(2);
      c.goNext();
    }
    assert.equal(c.currentStep, 5);
    c.goBack();
    assert.equal(c.currentStep, guest === 'yes' ? 4 : 3);
    c.goNext();
    assert.equal(c.currentStep, 5);
    c.goNext(); // Optional special requirements can be left blank.
    assert.equal(c.currentStep, 6);
    assert.equal(el('progress-fill').style.width, '100%');
    assert.match(el('btn-next').innerHTML, /Submit RSVP/);
    c.goNext();
    assert.equal(payload(), undefined);
    el('confirm').checked = true;
    c.goNext();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(payload().fullName, 'Test Attendee');
    assert.equal(payload().mobile, '+91 98765 43210');
    assert.equal(payload().guestCount, guest === 'yes' ? '3' : '0');
    assert.equal(el('form-card').style.display, 'none');
  });
}

test('changing guest answer skips count without losing contact details', () => {
  const { context: c, element: el } = setup();
  el('fullname').value = 'Test Attendee';
  el('email').value = 'test@example.com';
  el('mobile').value = '1234567890';
  c.goNext(); c.goNext();
  c.radioValues.guest = 'yes';
  c.goNext(); c.changeGuests(1); c.goBack();
  c.radioValues.guest = 'no';
  c.goNext();
  assert.equal(c.currentStep, 5);
  c.goBack(); c.goBack(); c.goBack();
  assert.equal(c.currentStep, 1);
  assert.equal(el('fullname').value, 'Test Attendee');
  assert.equal(el('mobile').value, '1234567890');
  assert.match(el('btn-next').innerHTML, /Submit/);
});
