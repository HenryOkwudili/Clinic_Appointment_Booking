const apiKeyInput = document.querySelector('#api-key');
const keyToggle = document.querySelector('#key-toggle');
const loadSlotsButton = document.querySelector('#load-slots');
const keyState = document.querySelector('#key-state');
const slotList = document.querySelector('#slot-list');
const slotsStatus = document.querySelector('#slots-status');
const form = document.querySelector('#booking-form');
const nameInput = document.querySelector('#patient-name');
const emailInput = document.querySelector('#patient-email');
const formMessage = document.querySelector('#form-message');
const submitButton = document.querySelector('#submit-booking');
const selectionSummary = document.querySelector('#selection-summary');
const confirmation = document.querySelector('#confirmation');
const lookupDialog = document.querySelector('#lookup-dialog');
const lookupInput = document.querySelector('#lookup-id');
const lookupButton = document.querySelector('#lookup-booking');
const lookupResult = document.querySelector('#lookup-result');

let slots = [];
let selectedSlotId = '';
let retryKey = '';
let retryFingerprint = '';
let lookupEmail = '';
let lookupCursor = null;

try {
  apiKeyInput.value = sessionStorage.getItem('clinic-api-key') || '';
} catch {
  apiKeyInput.value = '';
}

function apiKey() {
  return apiKeyInput.value.trim();
}

function updateKey(value) {
  try {
    if (value) sessionStorage.setItem('clinic-api-key', value);
    else sessionStorage.removeItem('clinic-api-key');
    keyState.textContent = 'API key stored for this browser tab.';
  } catch {
    keyState.textContent = 'API key could not be stored for this tab.';
  }
}

apiKeyInput.addEventListener('input', () => {
  updateKey(apiKeyInput.value.trim());
  if (!apiKey()) {
    slotsStatus.textContent = 'Enter your API key to load available times.';
    slotList.replaceChildren();
  }
});

apiKeyInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && apiKey()) {
    event.preventDefault();
    loadSlots();
  }
});

keyToggle.addEventListener('click', () => {
  const reveal = apiKeyInput.type === 'password';
  apiKeyInput.type = reveal ? 'text' : 'password';
  keyToggle.textContent = reveal ? 'Hide' : 'Show';
  keyToggle.setAttribute('aria-label', `${reveal ? 'Hide' : 'Show'} API key`);
});

function friendlyDate(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit'
  }).format(date);
}

function selectedSlot() {
  return slots.find((slot) => slot.id === selectedSlotId && slot.available);
}

function updateSelection() {
  const slot = selectedSlot();
  if (!slot) {
    selectedSlotId = '';
    selectionSummary.replaceChildren();
    const marker = document.createElement('span');
    marker.className = 'summary-marker';
    marker.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.textContent = 'No appointment selected';
    selectionSummary.append(marker, text);
    submitButton.disabled = true;
    return;
  }
  selectionSummary.replaceChildren();
  const marker = document.createElement('span');
  marker.className = 'summary-marker selected';
  marker.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.textContent = `${slot.provider} · ${friendlyDate(slot.start)}`;
  selectionSummary.append(marker, text);
  submitButton.disabled = false;
}

function renderSlots() {
  slotList.replaceChildren();
  for (const slot of slots) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'slot-option';
    button.disabled = !slot.available;
    button.setAttribute('aria-pressed', String(slot.id === selectedSlotId));
    if (!slot.available) button.classList.add('is-unavailable');
    if (slot.id === selectedSlotId) button.classList.add('is-selected');

    const provider = document.createElement('span');
    provider.className = 'slot-provider';
    provider.textContent = slot.provider;
    const date = document.createElement('span');
    date.className = 'slot-date';
    date.textContent = friendlyDate(slot.start);
    const affordance = document.createElement('span');
    affordance.className = 'slot-affordance';
    affordance.textContent = !slot.available ? 'Booked' : slot.id === selectedSlotId ? 'Selected' : 'Select';
    button.append(provider, date, affordance);
    button.addEventListener('click', () => {
      if (!slot.available) return;
      selectedSlotId = slot.id;
      formMessage.textContent = '';
      confirmation.hidden = true;
      renderSlots();
      updateSelection();
    });
    slotList.append(button);
  }
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('X-API-Key', apiKey());
  if (options.body) headers.set('Content-Type', 'application/json');
  return fetch(path, { ...options, headers });
}

async function loadSlots() {
  if (!apiKey()) {
    slotsStatus.textContent = 'Enter your API key to load available times.';
    return;
  }
  slotsStatus.textContent = 'Loading available times…';
  document.querySelector('#refresh-slots').disabled = true;
  try {
    const response = await request('/slots');
    const data = await response.json();
    if (response.status === 401) throw new Error('The API key was not accepted. Check it and try again.');
    if (!response.ok) throw new Error(data.error || 'Available times could not be loaded.');
    slots = data.slots;
    if (!slots.some((slot) => slot.id === selectedSlotId && slot.available)) selectedSlotId = '';
    renderSlots();
    updateSelection();
    slotsStatus.textContent = slots.length === 0 ? 'There are no appointment times available right now.' : '';
  } catch (error) {
    slotsStatus.textContent = error.message || 'Could not reach the booking service. Try again.';
    slotList.replaceChildren();
    slots = [];
    updateSelection();
  } finally {
    document.querySelector('#refresh-slots').disabled = false;
  }
}

function bookingCard(booking) {
  const card = document.createElement('article');
  card.className = 'lookup-card';
  const label = document.createElement('span');
  label.className = 'lookup-label';
  label.textContent = 'Booking ID';
  const id = document.createElement('strong');
  id.className = 'lookup-id';
  id.textContent = booking.id;
  const details = document.createElement('div');
  details.className = 'lookup-meta';
  for (const [labelText, value] of [
    ['Name', booking.name],
    ['Email', booking.email],
    ['Status', booking.status],
    ['Slot', booking.slot_id]
  ]) {
    const detail = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = `${labelText}: `;
    detail.append(name, document.createTextNode(value));
    details.append(detail);
  }
  card.append(label, id, details);
  return card;
}

async function lookupBooking(loadMore = false) {
  const query = loadMore ? lookupEmail : lookupInput.value.trim();
  if (!query) {
    lookupResult.textContent = 'Enter a booking ID or email address to look up an appointment.';
    lookupResult.classList.add('is-error');
    return;
  }
  const isEmail = loadMore || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query);
  if (!loadMore) {
    lookupEmail = isEmail ? query : '';
    lookupCursor = null;
    lookupResult.replaceChildren();
    lookupResult.textContent = isEmail ? 'Looking up bookings…' : 'Looking up booking…';
  } else {
    lookupResult.querySelector('.lookup-more')?.remove();
  }
  lookupResult.classList.remove('is-error');
  lookupResult.classList.remove('is-success');
  try {
    const path = isEmail
      ? `/bookings?email=${encodeURIComponent(lookupEmail)}&limit=50${loadMore && lookupCursor ? `&cursor=${encodeURIComponent(lookupCursor)}` : ''}`
      : `/bookings/${encodeURIComponent(query)}`;
    const response = await request(path);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Booking lookup failed.');
    }
    lookupResult.classList.add('is-success');
    if (!loadMore) lookupResult.replaceChildren();
    const bookings = isEmail ? data.bookings : [data];
    if (bookings.length === 0 && !loadMore) {
      lookupResult.textContent = 'No bookings were found for that email address.';
      return;
    }
    for (const booking of bookings) lookupResult.append(bookingCard(booking));
    lookupCursor = isEmail ? data.next_cursor : null;
    if (lookupCursor) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'lookup-more';
      more.textContent = 'Load more bookings';
      more.addEventListener('click', () => lookupBooking(true));
      lookupResult.append(more);
    }
  } catch (error) {
    lookupResult.classList.add('is-error');
    lookupResult.textContent = error.message || 'Could not find that booking.';
  }
}

document.querySelector('#refresh-slots').addEventListener('click', loadSlots);
loadSlotsButton.addEventListener('click', loadSlots);
document.querySelector('#open-lookup').addEventListener('click', () => {
  lookupDialog.showModal();
  lookupInput.focus();
});
document.querySelector('#close-lookup').addEventListener('click', () => lookupDialog.close());

lookupInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    lookupBooking();
  }
});

lookupButton.addEventListener('click', () => lookupBooking());

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  formMessage.textContent = '';
  confirmation.hidden = true;
  const slot = selectedSlot();
  if (!apiKey()) {
    formMessage.textContent = 'Enter your API key before booking.';
    apiKeyInput.focus();
    return;
  }
  if (!slot) {
    formMessage.textContent = 'Choose an available appointment first.';
    return;
  }
  if (!form.reportValidity()) return;

  const payload = { slot_id: slot.id, name: nameInput.value.trim(), email: emailInput.value.trim() };
  const fingerprint = JSON.stringify(payload);
  if (fingerprint !== retryFingerprint) {
    retryFingerprint = fingerprint;
    retryKey = crypto.randomUUID();
  }
  submitButton.disabled = true;
  submitButton.querySelector('span').textContent = 'Booking…';
  try {
    const response = await request('/bookings', {
      method: 'POST',
      headers: { 'Idempotency-Key': retryKey },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (response.status === 201) {
      retryFingerprint = '';
      retryKey = '';
      form.reset();
      selectedSlotId = '';
      await loadSlots();
      confirmation.replaceChildren();
      const heading = document.createElement('h3');
      heading.textContent = 'Appointment confirmed';
      const detail = document.createElement('p');
      detail.textContent = `${data.name}, your visit with ${slot.provider} is booked for ${friendlyDate(slot.start)}.`;
      const id = document.createElement('p');
      id.className = 'confirmation-id';
      const label = document.createElement('strong');
      label.textContent = 'Booking ID';
      const code = document.createElement('span');
      code.className = 'booking-code';
      code.textContent = data.id;
      id.append(label, code);
      confirmation.append(heading, detail, id);
      confirmation.hidden = false;
      confirmation.focus();
      return;
    }
    if (response.status === 409) {
      formMessage.textContent = 'This appointment was booked by someone else while you were entering your details. It is now marked as booked; please choose another time.';
      retryFingerprint = '';
      retryKey = '';
      await loadSlots();
      return;
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get('Retry-After')) || 60;
      formMessage.textContent = `Too many booking attempts. Please wait ${seconds} seconds and try again.`;
      retryFingerprint = '';
      retryKey = '';
      return;
    }
    formMessage.textContent = response.status === 401
      ? 'The API key was not accepted. Check it and try again.'
      : data.error || 'Your appointment could not be booked. Check your details and try again.';
    if (response.status !== 422) {
      retryFingerprint = '';
      retryKey = '';
    }
  } catch {
    formMessage.textContent = 'We could not confirm the response. Submit again to safely retry this booking.';
  } finally {
    submitButton.querySelector('span').textContent = 'Confirm appointment';
    submitButton.disabled = !selectedSlot();
  }
});

if (apiKey()) loadSlots();