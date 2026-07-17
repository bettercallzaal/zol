'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { safeParse } = require('../agent-gateway');

// ---------------------------------------------------------------------------
// safeParse — route input validation (cross-repo T1 0833d573)
// ---------------------------------------------------------------------------

describe('safeParse — route input validation', () => {
  const SCHEMA = {
    type: 'object',
    required: ['title', 'description', 'type'],
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      type: { type: 'string' },
      priority: { type: 'string' },
      count: { type: 'number' },
      tags: { type: 'array' },
      meta: { type: 'object' },
    },
  };

  test('returns ok:true with data when all required fields present', () => {
    const result = safeParse(SCHEMA, { title: 'T', description: 'D', type: 'task' });
    assert.equal(result.ok, true);
    assert.ok(result.data, 'data must be present on success');
    assert.equal(result.data.title, 'T');
  });

  test('returns ok:false with issues when required field is missing', () => {
    const result = safeParse(SCHEMA, { title: 'T', description: 'D' });
    assert.equal(result.ok, false);
    assert.ok(Array.isArray(result.issues) && result.issues.length > 0, 'must have issues');
    assert.ok(result.issues.some(i => i.field === 'type'), 'issue must name the missing field');
    assert.ok(!result.data, 'data must be absent on failure');
  });

  test('returns ok:false when required field is null', () => {
    const result = safeParse(SCHEMA, { title: 'T', description: 'D', type: null });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(i => i.field === 'type'));
  });

  test('returns ok:false with all missing required fields listed', () => {
    const result = safeParse(SCHEMA, {});
    assert.equal(result.ok, false);
    const fields = result.issues.map(i => i.field);
    assert.ok(fields.includes('title'), 'title must be listed');
    assert.ok(fields.includes('description'), 'description must be listed');
    assert.ok(fields.includes('type'), 'type must be listed');
  });

  test('returns ok:false when property type is wrong (string field gets number)', () => {
    const result = safeParse(SCHEMA, { title: 42, description: 'D', type: 'task' });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(i => i.field === 'title'));
  });

  test('accepts array type correctly', () => {
    const result = safeParse(SCHEMA, { title: 'T', description: 'D', type: 'task', tags: ['a'] });
    assert.equal(result.ok, true);
  });

  test('rejects non-array for array type', () => {
    const result = safeParse(SCHEMA, { title: 'T', description: 'D', type: 'task', tags: 'bad' });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(i => i.field === 'tags'));
  });

  test('accepts nested object type', () => {
    const result = safeParse(SCHEMA, { title: 'T', description: 'D', type: 'task', meta: { k: 'v' } });
    assert.equal(result.ok, true);
  });

  test('rejects string where object expected', () => {
    const result = safeParse(SCHEMA, { title: 'T', description: 'D', type: 'task', meta: 'bad' });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(i => i.field === 'meta'));
  });

  test('optional fields may be absent without error', () => {
    const result = safeParse(SCHEMA, { title: 'T', description: 'D', type: 'task' });
    assert.equal(result.ok, true);
  });

  test('returns ok:false for non-object input (array)', () => {
    const result = safeParse(SCHEMA, []);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(i => i.field === '$root'));
  });

  test('returns ok:false for null input', () => {
    const result = safeParse(SCHEMA, null);
    assert.equal(result.ok, false);
  });

  test('enforces enum constraint on string field', () => {
    const schema = {
      type: 'object',
      required: ['mode'],
      properties: { mode: { type: 'string', enum: ['mock', 'dry-run'] } },
    };
    assert.equal(safeParse(schema, { mode: 'mock' }).ok, true);
    assert.equal(safeParse(schema, { mode: 'dry-run' }).ok, true);
    const bad = safeParse(schema, { mode: 'live' });
    assert.equal(bad.ok, false);
    assert.ok(bad.issues.some(i => i.field === 'mode'));
  });

  test('schema with no required fields accepts any object', () => {
    const result = safeParse({ type: 'object', properties: { x: { type: 'string' } } }, {});
    assert.equal(result.ok, true);
  });
});
