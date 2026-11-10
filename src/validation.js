import { Buffer } from 'node:buffer';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const dateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateSlots(body) {
  if (!isRecord(body) || !Array.isArray(body.slots)) return 'slots must be an array';
  const ids = new Set();
  for (const slot of body.slots) {
    if (!isRecord(slot)) return 'each slot must be an object';
    if (typeof slot.id !== 'string' || slot.id.length === 0) return 'slot id must be a non-empty string';
    if (typeof slot.provider !== 'string') return 'slot provider must be a string';
    if (typeof slot.start !== 'string' || !dateTimePattern.test(slot.start) || Number.isNaN(Date.parse(slot.start))) {
      return 'slot start must be a valid date-time';
    }
    if (typeof slot.end !== 'string' || !dateTimePattern.test(slot.end) || Number.isNaN(Date.parse(slot.end))) {
      return 'slot end must be a valid date-time';
    }
    if (ids.has(slot.id)) return 'slot ids must be unique';
    ids.add(slot.id);
  }
  return null;
}

export function validateBooking(body) {
  if (!isRecord(body)) return { error: 'request body must be an object' };
  if (typeof body.slot_id !== 'string' || body.slot_id.trim() === '') return { error: 'slot_id is required' };
  if (typeof body.name !== 'string' || body.name.trim() === '') return { error: 'name is required' };
  if (typeof body.email !== 'string' || body.email.trim() === '') return { error: 'email is required' };
  const name = body.name.trim();
  const email = body.email.trim().toLowerCase();
  if (!emailPattern.test(email)) return { error: 'email is invalid' };
  return { value: { slot_id: body.slot_id, name, email } };
}

export function parseLimit(value) {
  if (value === undefined) return 10;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 1 && limit <= 50 ? limit : null;
}

export function decodeCursor(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 512) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(decoded) || decoded.length !== 2 || typeof decoded[0] !== 'string' || typeof decoded[1] !== 'string') return undefined;
    if (Number.isNaN(Date.parse(decoded[0])) || decoded[1].length === 0) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

export function encodeCursor(booking) {
  return Buffer.from(JSON.stringify([booking.cursor_created_at, booking.id])).toString('base64url');
}