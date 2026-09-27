/*
 * 辅导工作流的错误约定和「读外部对象」小工具（#36，#19 Phase 6）。
 * 复用 lib/ai/memory/errors.js 的严格读取（纯对象、只认自有可枚举数据属性、getter 不执行、Proxy 异常收口），
 * 只把错误类型换成 WorkflowError；message 只提字段名，不回显调用方文本。
 */
"use strict";

const mem = require("../memory/errors.js");

class WorkflowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
  }
}

/* memory 的读取器失败时只会抛它自己的 MemoryError(code)（外部抛出的任何东西都已被它收口），这里原样换成 WorkflowError(code) */
function readPlain(value, allowed, code, what) {
  try { return mem.readRecord(value, allowed, code, what); } catch (_) {
    throw new WorkflowError(code, `${what} must be a plain object with only: ${allowed.join(", ")}`);
  }
}
function readMethods(obj, names, code, what) {
  try { return mem.readMethods(obj, names, code, what); } catch (_) {
    throw new WorkflowError(code, `${what} must be an object with methods: ${names.join(", ")}`);
  }
}

const hasOwn = mem.hasOwn;

module.exports = { WorkflowError, readPlain, readMethods, hasOwn };
