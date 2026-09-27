/*
 * 测试用故障注入（只给 tools/test_golden_gate.mjs 用）：用 `node --require` 预载进 golden_cases.mjs 的**测试进程**，
 * 包一层 globalThis.fetch，把打到某条 /api 路由的响应换掉。server.js 子进程不加载它，服务端代码一行不动。
 *
 *   YY_FAULT_FETCH='{"path":"/api/quiz/answer","status":500}'          整条路由直接回 500
 *   YY_FAULT_FETCH='{"path":"/api/quiz/answer","flip":"correct"}'      照常请求，把响应里的 correct 取反（判题错配）
 *   YY_FAULT_FETCH='{"path":"/api/quiz/session","status":503,"body":{"needsEngine":true}}'   缺 fixture
 *   YY_FAULT_FETCH='{"path":"/api/progress","method":"POST","status":403}'   加 method 只打这个方法，同路径的 GET 照常
 *
 * 思路来自 Codex 复审（20260925-9c0a8d8）的 rereview-golden.cjs，那份是改写源码后 import；这里换成预载，不依赖源码字符串。
 */
"use strict";
const spec = process.env.YY_FAULT_FETCH ? JSON.parse(process.env.YY_FAULT_FETCH) : null;
if (spec) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async function (input, init) {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = String(init && init.method || "GET").toUpperCase();
    if (url.pathname !== spec.path || (spec.method && method !== spec.method)) return realFetch(input, init);
    process.stderr.write(`[fault_fetch] ${spec.method ? spec.method + " " : ""}${spec.path} ${spec.status ? "-> " + spec.status : "flip " + spec.flip}\n`);
    if (spec.status) {
      return new Response(JSON.stringify(spec.body || { error: "injected test failure" }), { status: spec.status, headers: { "content-type": "application/json" } });
    }
    const r = await realFetch(input, init);
    const body = await r.json();
    if (spec.flip && spec.flip in body) body[spec.flip] = !body[spec.flip];
    return new Response(JSON.stringify(body), { status: r.status, headers: { "content-type": "application/json" } });
  };
}
