// @ts-nocheck — test file, vitest uses esbuild transform
import { describe, it, expect } from 'vitest';
import { validateToken, validateFieldsObject } from '../validation.js';

describe('validateToken', () => {
  it('should accept valid alphanumeric tokens', () => {
    expect(() => validateToken('abc123', 'test')).not.toThrow();
    expect(() => validateToken('ABC_def-456', 'test')).not.toThrow();
  });

  it('should reject tokens with special characters', () => {
    expect(() => validateToken('abc/123', 'test')).toThrow('无效的 test');
    expect(() => validateToken('abc..123', 'test')).toThrow('无效的 test');
    expect(() => validateToken('../etc/passwd', 'test')).toThrow('无效的 test');
    expect(() => validateToken('abc 123', 'test')).toThrow('无效的 test');
  });

  it('should reject empty string', () => {
    expect(() => validateToken('', 'test')).toThrow('无效的 test');
  });
});

describe('validateFieldsObject', () => {
  it('should accept valid object', () => {
    const result = validateFieldsObject({ name: '张三', age: 25 });
    expect(result).toEqual({ name: '张三', age: 25 });
  });

  it('should reject null', () => {
    expect(() => validateFieldsObject(null)).toThrow('fields 必须是 JSON 对象');
  });

  it('should reject array', () => {
    expect(() => validateFieldsObject([1, 2, 3])).toThrow('fields 必须是 JSON 对象');
  });

  it('should reject string', () => {
    expect(() => validateFieldsObject('hello')).toThrow('fields 必须是 JSON 对象');
  });

  it('should reject number', () => {
    expect(() => validateFieldsObject(42)).toThrow('fields 必须是 JSON 对象');
  });

  it('should reject __proto__ key (prototype pollution)', () => {
    // Using JSON.parse to create an object with __proto__ as an own key
    // (JS literal { __proto__: {} } sets the prototype, not an own property)
    const obj = JSON.parse('{"__proto__": {"admin": true}}');
    expect(() => validateFieldsObject(obj)).toThrow('不允许的 key: __proto__');
  });

  it('should reject constructor key (prototype pollution)', () => {
    expect(() => validateFieldsObject({ constructor: {} })).toThrow('不允许的 key: constructor');
  });

  it('should reject prototype key (prototype pollution)', () => {
    expect(() => validateFieldsObject({ prototype: {} })).toThrow('不允许的 key: prototype');
  });

  it('should accept object with normal keys', () => {
    const result = validateFieldsObject({ field1: 'value1', field2: 123 });
    expect(result).toEqual({ field1: 'value1', field2: 123 });
  });
});
