/* 配图契约校验器 —— 浏览器和 node 共用同一份实现，别再各写一遍。
 *
 * 契约本体在 data/curriculum/visual-contract.json（唯一事实源）；这里只有解释规则的代码。
 * 消费方：
 *   - public/index.html 的 renderVisual：违约就不画（降级成无图），和 Apple 端 LessonValidator 一致；
 *   - tools/curriculum/visual_check.mjs：内容入库前的 preflight / CI 门禁。
 * 之所以单独一个文件而不是各端各抄一份：抄两份就一定会漂（36 / 39 / 41 那次就是）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YYVisualCheck = api;
})(typeof self !== "undefined" ? self : this, function () {
  const isInt = v => Number.isFinite(v) && Math.abs(v - Math.round(v)) < 1e-9;
  const EPS = 1e-6;

  /* 和 public/index.html 的 parseStatSeries 同一套四条规则 */
  function parseStatSeries(nums, labels, allowNeg) {
    const vals = (nums || []).map(Number).filter(n => Number.isFinite(n) && (allowNeg || n >= 0));
    const rawLabs = (labels || []).map(String);
    const L = rawLabs.length;
    if (vals.length && vals.length === L && L <= 8) return { s1: vals, s2: null };
    if (L >= 4 && L <= 10 && vals.length === 2 * (L - 2)) return { s1: vals.slice(0, L - 2), s2: vals.slice(L - 2) };
    if (L >= 2 && L <= 8 && vals.length === 2 * L) return { s1: vals.slice(0, L), s2: vals.slice(L, 2 * L) };
    return { s1: vals.slice(0, 8), s2: null };
  }

  /**
   * @param {object} contract  visual-contract.json 的内容；null / undefined = 放行（拿不到契约就别乱拦）
   * @returns {{ok:boolean, why?:string}}
   */
  function checkVisual(contract, type, nums, labels) {
    if (!type || type === "none") return { ok: true };
    if (!contract || !contract.types) return { ok: true };
    const spec = contract.types[type];
    if (!spec) return { ok: false, why: '图型 "' + type + '" 不在白名单里' };
    if (spec.unchecked || !spec.check) return { ok: true };

    const n = (nums || []).map(Number);
    const bad = why => ({ ok: false, why: why });

    for (const r of spec.check) {
      if (r.ifLen !== undefined && n.length !== r.ifLen) continue;
      switch (r.t) {
        case "lenIn":
          if (r.values.indexOf(n.length) < 0) return bad("nums 有 " + n.length + " 个数，只接受 " + r.values.join(" / ") + " 个");
          break;
        case "int": {
          const idx = r.idx === "all" ? n.map((_, i) => i) : r.idx;
          for (const i of idx)
            if (i < n.length && Number.isFinite(n[i]) && !isInt(n[i])) return bad("nums[" + i + "] = " + n[i] + " 必须是整数");
          break;
        }
        case "range": {
          const v = n[r.idx];
          if (!Number.isFinite(v)) break;                        // 可选位，没给就不管
          if (r.min !== null && r.min !== undefined && v < r.min) return bad("nums[" + r.idx + "] = " + v + " 小于下限 " + r.min);
          if (r.max !== null && r.max !== undefined && v > r.max) return bad("nums[" + r.idx + "] = " + v + " 超过上限 " + r.max);
          break;
        }
        case "rangeAll":
          for (let i = r.from; i < n.length; i++) {
            const v = n[i];
            if (!Number.isFinite(v)) continue;
            if (r.min !== null && r.min !== undefined && v < r.min) return bad("nums[" + i + "] = " + v + " 小于下限 " + r.min);
            if (r.max !== null && r.max !== undefined && v > r.max) return bad("nums[" + i + "] = " + v + " 超过上限 " + r.max);
          }
          break;
        case "positive":
          for (let i = r.from; i < n.length; i++)
            if (Number.isFinite(n[i]) && n[i] <= 0) return bad("nums[" + i + "] = " + n[i] + " 必须大于 0");
          break;
        case "le":
          if (Number.isFinite(n[r.idx]) && Number.isFinite(n[r.ofIdx]) && n[r.idx] > n[r.ofIdx])
            return bad("nums[" + r.idx + "] = " + n[r.idx] + " 不能大于 nums[" + r.ofIdx + "] = " + n[r.ofIdx]);
          break;
        case "lt":
          if (Number.isFinite(n[r.idx]) && Number.isFinite(n[r.ofIdx]) && n[r.idx] >= n[r.ofIdx])
            return bad("nums[" + r.idx + "] = " + n[r.idx] + " 必须小于 nums[" + r.ofIdx + "] = " + n[r.ofIdx]);
          break;
        case "inSpan": {
          const lo = n[0], hi = n[1];
          if (!Number.isFinite(lo) || !Number.isFinite(hi)) break;
          for (const i of r.idx) {
            const v = n[i];
            if (Number.isFinite(v) && (v < lo - EPS || v > hi + EPS))
              return bad("标记点 nums[" + i + "] = " + v + " 落在数轴 [" + lo + ", " + hi + "] 外面，画出来会凭空消失");
          }
          break;
        }
        case "wholes": {
          const d = n[r.denIdx], v = n[r.numIdx];
          if (!Number.isFinite(d) || !Number.isFinite(v) || d <= 0) break;
          const w = Math.ceil(v / d);
          if (w > r.max) return bad(v + "/" + d + " 要占 " + w + " 个整体，超过上限 " + r.max + " 个，画不下");
          break;
        }
        case "count": {
          const c = n.filter(v => Number.isFinite(v) && v > 0).length;
          if (c > r.max) return bad("给了 " + c + " 项，最多只画 " + r.max + " 项");
          if (r.min && c < r.min) return bad("给了 " + c + " 项，至少要 " + r.min + " 项");
          break;
        }
        case "sum": {
          const s = n.filter(Number.isFinite).reduce((a, b) => a + b, 0);
          if (s > r.max) return bad("合计 " + s + " 超过上限 " + r.max);
          break;
        }
        case "snapFrac": {
          const den = n[r.denIdx];
          if (!Number.isFinite(den)) break;                      // 没给分母就是老写法，按老样子画
          const lo = n[r.minIdx];
          for (const i of r.ptIdx) {
            const v = n[i];
            if (!Number.isFinite(v)) continue;
            const k = (v - lo) * den;
            if (Math.abs(k - Math.round(k)) > 1e-6)
              return bad("标记点 " + v + " 落不到 1/" + den + " 的刻度上——图注说的分数在图上没有对应的格子");
          }
          break;
        }
        case "statSeries": {
          const s1 = parseStatSeries(n, labels, r.allowNeg).s1;
          if (!s1.length) return bad("没有可画的数值");
          if (r.min && s1.length < r.min) return bad("只有 " + s1.length + " 个点，至少要 " + r.min + " 个");
          if (s1.length > r.max) return bad(s1.length + " 个类别超过上限 " + r.max);
          break;
        }
        default:
          return bad('契约里有没实现的规则 "' + r.t + '"');
      }
    }
    return { ok: true };
  }

  return { checkVisual: checkVisual, parseStatSeries: parseStatSeries };
});
