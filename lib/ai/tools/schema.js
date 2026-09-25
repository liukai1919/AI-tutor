/*
 * JSON Schema 子集校验器（#26，#19 Phase 2）。零依赖，只够描述 Tool 的参数：
 *   type: object / string / number / integer / boolean / array / null
 *   properties / required / additionalProperties(false 表示禁止多余键)
 *   enum / minimum / maximum / minLength / maxLength / minItems / maxItems / items
 *   anyOf（给「数字或字符串」这种小场景）
 * 返回 { ok, errors:[ "path: message" ] }。不做 $ref、不做 format、不做默认值填充。
 */
"use strict";

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function validate(schema, value, path, errors) {
  path = path || "$"; errors = errors || [];
  if (!schema || typeof schema !== "object") return errors;
  if (schema.anyOf) {
    const ok = schema.anyOf.some(s => validate(s, value, path, []).length === 0);
    if (!ok) errors.push(`${path}: matches none of anyOf`);
    return errors;
  }
  if (schema.type) {
    const t = typeOf(value);
    const want = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = want.some(w => w === "integer" ? (t === "number" && Number.isInteger(value)) : w === t);
    if (!ok) { errors.push(`${path}: expected ${want.join("|")}, got ${t}`); return errors; }
  }
  if (schema.enum && !schema.enum.some(e => e === value)) errors.push(`${path}: must be one of ${schema.enum.map(e => JSON.stringify(e)).join(", ")}`);
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: must be <= ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => validate(schema.items, v, `${path}[${i}]`, errors));
  }
  if (typeOf(value) === "object" && (schema.properties || schema.required || schema.additionalProperties === false)) {
    const props = schema.properties || {};
    for (const k of schema.required || []) if (!(k in value)) errors.push(`${path}.${k}: required`);
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) validate(props[k], v, `${path}.${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${k}: not allowed`);
    }
  }
  return errors;
}

function check(schema, value) {
  const errors = validate(schema, value);
  return { ok: errors.length === 0, errors };
}

module.exports = { check, validate };
