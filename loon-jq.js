// loon-jq.js — 通用 jq 子集解释器，供 Surge 模块使用。
// 把 Loon 插件里的 response.json.jq("...") 规则转成 Surge 脚本时调用：
//   脚本参数 argument=<encodeURIComponent 后的 jq filter>
// 在 Surge 里：$argument 是 filter，$response.body 是待改的 JSON。
// 不支持完整 jq，只覆盖 aduItraplus 插件里实际用到的 52 条 filter 的语法。
// 任何解析/执行错误都原样返回，不破坏响应。

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') {
      let j = i + 1, s = '';
      while (j < src.length) {
        if (src[j] === '\\' && j + 1 < src.length) { s += src[j] + src[j + 1]; j += 2; }
        else if (src[j] === '"') { j++; break; }
        else { s += src[j]; j++; }
      }
      tokens.push({ t: 'str', v: JSON.parse('"' + s + '"') });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
      tokens.push({ t: 'num', v: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if (src.startsWith('|=', i)) { tokens.push({ t: 'op', v: '|=' }); i += 2; continue; }
    if (src.startsWith('==', i)) { tokens.push({ t: 'op', v: '==' }); i += 2; continue; }
    if (src.startsWith('!=', i)) { tokens.push({ t: 'op', v: '!=' }); i += 2; continue; }
    if ('|=@!?:;,()[]{}'.indexOf(c) >= 0) { tokens.push({ t: 'op', v: c }); i++; continue; }
    if (c === '.') { tokens.push({ t: 'dot', v: '.' }); i++; continue; }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      tokens.push({ t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    throw new Error('Unexpected char "' + c + '" at ' + i);
  }
  tokens.push({ t: 'eof', v: null });
  return tokens;
}

function Parser(tokens) {
  this.toks = tokens;
  this.pos = 0;
}
Parser.prototype.peek = function (n) { return this.toks[this.pos + (n || 0)]; };
Parser.prototype.next = function () { return this.toks[this.pos++]; };
Parser.prototype.expectOp = function (v) {
  const t = this.next();
  if (t.t !== 'op' || t.v !== v) throw new Error('Expected "' + v + '" got ' + JSON.stringify(t));
};
Parser.prototype.expectId = function (v) {
  const t = this.next();
  if (t.t !== 'id' || (v && t.v !== v)) throw new Error('Expected "' + v + '" got ' + JSON.stringify(t));
  return t.v;
};

Parser.prototype.parsePipe = function () {
  let left = this.parseOr();
  while (this.peek().t === 'op' && this.peek().v === '|') {
    this.next();
    const right = this.parseOr();
    left = { kind: 'pipe', left: left, right: right };
  }
  return left;
};
Parser.prototype.parseOr = function () {
  let left = this.parseAnd();
  while (this.peek().t === 'id' && this.peek().v === 'or') {
    this.next();
    const right = this.parseAnd();
    left = { kind: 'or', left: left, right: right };
  }
  return left;
};
Parser.prototype.parseAnd = function () {
  let left = this.parseCmp();
  while (this.peek().t === 'id' && this.peek().v === 'and') {
    this.next();
    const right = this.parseCmp();
    left = { kind: 'and', left: left, right: right };
  }
  return left;
};
Parser.prototype.parseCmp = function () {
  const left = this.parseTerm();
  const t = this.peek();
  if (t.t === 'op' && (t.v === '==' || t.v === '!=')) {
    this.next();
    const right = this.parseTerm();
    return { kind: 'cmp', op: t.v, left: left, right: right };
  }
  return left;
};

const KEYWORDS = new Set(['then', 'else', 'end']);

Parser.prototype.parsePathSegments = function () {
  // 解析 .a.b["k"].[0][]? 这样的路径段；'[' 段前面可以没有 '.'
  const segs = [];
  for (;;) {
    const t = this.peek();
    if (t.t === 'dot') {
      this.next();
      const n = this.peek();
      // 关键字不能做字段名：'. else' 里的 '.' 是 identity，else 是关键字
      if (n.t === 'id' && !KEYWORDS.has(n.v)) { this.next(); segs.push({ seg: 'key', name: n.v }); continue; }
      if (n.t === 'op' && n.v === '[') continue; // '.' 后直接跟 '['，下一轮处理
      break; // 单独的 '.' = identity
    }
    if (t.t === 'op' && t.v === '[') {
      this.next();
      const inner = this.next();
      if (inner.t === 'str') {
        this.expectOp(']');
        segs.push({ seg: 'key', name: inner.v });
        continue;
      }
      if (inner.t === 'num') {
        this.expectOp(']');
        segs.push({ seg: 'index', n: inner.v });
        continue;
      }
      if (inner.t === 'op' && inner.v === ']') {
        // [] 或 []?
        if (this.peek().t === 'op' && this.peek().v === '?') { this.next(); segs.push({ seg: 'iterOpt' }); }
        else segs.push({ seg: 'iter' });
        continue;
      }
      throw new Error('Bad bracket in path: ' + JSON.stringify(inner));
    }
    break;
  }
  return segs;
};

Parser.prototype.parseTerm = function () {
  const t = this.peek();
  if (t.t === 'id' && t.v === 'if') {
    this.next();
    const cond = this.parsePipe();
    this.expectId('then');
    const a = this.parsePipe();
    this.expectId('else');
    const b = this.parsePipe();
    this.expectId('end');
    return { kind: 'if', cond: cond, a: a, b: b };
  }
  if (t.t === 'id' && t.v === 'del') {
    this.next();
    this.expectOp('(');
    const paths = [this.parsePathOnly()];
    while (this.peek().t === 'op' && this.peek().v === ',') { this.next(); paths.push(this.parsePathOnly()); }
    this.expectOp(')');
    return { kind: 'del', paths: paths };
  }
  if (t.t === 'id' && t.v === 'map') {
    this.next();
    this.expectOp('(');
    const f = this.parsePipe();
    this.expectOp(')');
    return { kind: 'map', f: f };
  }
  if (t.t === 'id' && t.v === 'select') {
    this.next();
    this.expectOp('(');
    const c = this.parsePipe();
    this.expectOp(')');
    return { kind: 'select', c: c };
  }
  if (t.t === 'id' && (t.v === 'has' || t.v === 'contains' || t.v === 'test' || t.v === 'IN')) {
    const fn = t.v;
    this.next();
    this.expectOp('(');
    const args = [];
    if (!(this.peek().t === 'op' && this.peek().v === ')')) {
      args.push(this.parsePipe());
      while (this.peek().t === 'op' && (this.peek().v === ',' || this.peek().v === ';')) {
        this.next();
        args.push(this.parsePipe());
      }
    }
    this.expectOp(')');
    return { kind: 'fn', fn: fn, args: args };
  }
  if (t.t === 'id' && t.v === 'type') { this.next(); return { kind: 'fn', fn: 'type', args: [] }; }
  if (t.t === 'id' && t.v === 'not') { this.next(); return { kind: 'fn', fn: 'not', args: [] }; }
  if (t.t === 'dot') {
    const segs = this.parsePathSegments();
    const nt = this.peek();
    if (nt.t === 'op' && nt.v === '=') {
      this.next();
      // jq 里 = 的 RHS 绑定比 | 紧，只解析到 or 层，不吞掉后面的 | 阶段
      const rhs = this.parseOr();
      return { kind: 'assign', path: segs, rhs: rhs };
    }
    if (nt.t === 'op' && nt.v === '|=') {
      this.next();
      const rhs = this.parseOr();
      return { kind: 'update', path: segs, rhs: rhs };
    }
    return { kind: 'path', path: segs };
  }
  if (t.t === 'op' && t.v === '(') {
    this.next();
    const e = this.parsePipe();
    this.expectOp(')');
    return e;
  }
  if (t.t === 'str') { this.next(); return { kind: 'lit', v: t.v }; }
  if (t.t === 'num') { this.next(); return { kind: 'lit', v: t.v }; }
  if (t.t === 'id' && (t.v === 'true' || t.v === 'false')) { this.next(); return { kind: 'lit', v: t.v === 'true' }; }
  if (t.t === 'id' && t.v === 'null') { this.next(); return { kind: 'lit', v: null }; }
  if (t.t === 'op' && t.v === '{') {
    this.next();
    const entries = [];
    if (!(this.peek().t === 'op' && this.peek().v === '}')) {
      for (;;) {
        const kt = this.next();
        let key;
        if (kt.t === 'str') key = kt.v;
        else if (kt.t === 'id') key = kt.v;
        else throw new Error('Bad object key: ' + JSON.stringify(kt));
        this.expectOp(':');
        const val = this.parsePipe();
        entries.push({ key: key, val: val });
        if (this.peek().t === 'op' && this.peek().v === ',') { this.next(); continue; }
        break;
      }
    }
    this.expectOp('}');
    return { kind: 'obj', entries: entries };
  }
  if (t.t === 'op' && t.v === '[') {
    this.next();
    const elems = [];
    if (!(this.peek().t === 'op' && this.peek().v === ']')) {
      for (;;) {
        elems.push(this.parsePipe());
        if (this.peek().t === 'op' && this.peek().v === ',') { this.next(); continue; }
        break;
      }
    }
    this.expectOp(']');
    return { kind: 'arr', elems: elems };
  }
  throw new Error('Unexpected token: ' + JSON.stringify(t));
};

Parser.prototype.parsePathOnly = function () {
  if (this.peek().t !== 'dot') throw new Error('Expected path');
  return this.parsePathSegments();
};

function parseFilter(src) {
  const p = new Parser(tokenize(src));
  const ast = p.parsePipe();
  if (p.peek().t !== 'eof') throw new Error('Trailing tokens after filter');
  return ast;
}

// ---------- 求值 ----------
function isTruthy(v) { return v !== false && v !== null && v !== undefined; }
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === undefined || b === undefined) return a === b;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}
function jqType(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

// 路径取值，返回值的数组（[] 迭代会产生多个）
function pathGet(segs, input) {
  let vals = [input];
  for (const s of segs) {
    const next = [];
    for (const v of vals) {
      if (s.seg === 'key') next.push(v !== null && typeof v === 'object' ? v[s.name] : undefined);
      else if (s.seg === 'index') next.push(Array.isArray(v) ? v[s.n] : undefined);
      else if (s.seg === 'iter' || s.seg === 'iterOpt') {
        if (Array.isArray(v)) for (const el of v) next.push(el);
      }
    }
    vals = next;
  }
  return vals;
}

// 路径赋值/更新。fn(oldValue) -> newValue；返回更新后的根对象（原地修改）。
function pathSet(segs, root, fn) {
  if (segs.length === 0) return fn(root);
  // 路径里含 [] / []? 时，先确认迭代器前面的前缀真实存在且是数组；
  // 前缀缺失时 jq 的 []? 会静默跳过，整个更新是 no-op，不能凭空造出中间对象
  const iterIdx = segs.findIndex(s => s.seg === 'iter' || s.seg === 'iterOpt');
  if (iterIdx >= 0) {
    let cur = root;
    for (let i = 0; i < iterIdx; i++) {
      const s = segs[i];
      if (cur === null || typeof cur !== 'object') return root;
      cur = s.seg === 'key' ? cur[s.name] : cur[s.n];
      if (cur === undefined) return root;
    }
    if (!Array.isArray(cur)) return root;
  }
  return pathSetInner(segs, root, fn);
}

function pathSetInner(segs, root, fn) {
  const s = segs[0];
  const rest = segs.slice(1);
  if (s.seg === 'key' || s.seg === 'index') {
    if (root === null || typeof root !== 'object') return root;
    if (rest.length === 0) {
      root[s.seg === 'key' ? s.name : s.n] = fn(root[s.seg === 'key' ? s.name : s.n]);
    } else {
      const k = s.seg === 'key' ? s.name : s.n;
      if (root[k] === undefined || root[k] === null) root[k] = {};
      root[k] = pathSet(rest, root[k], fn);
    }
    return root;
  }
  if (s.seg === 'iter' || s.seg === 'iterOpt') {
    if (!Array.isArray(root)) return root;
    for (let i = 0; i < root.length; i++) root[i] = pathSet(rest, root[i], fn);
    return root;
  }
  return root;
}

function pathDel(segs, root) {
  if (segs.length === 0) return;
  const s = segs[0];
  const rest = segs.slice(1);
  if (root === null || typeof root !== 'object') return;
  if (s.seg === 'key' || s.seg === 'index') {
    const k = s.seg === 'key' ? s.name : s.n;
    if (rest.length === 0) {
      if (Array.isArray(root) && s.seg === 'index') root.splice(k, 1);
      else delete root[k];
    } else pathDel(rest, root[k]);
  } else if (s.seg === 'iter' || s.seg === 'iterOpt') {
    if (Array.isArray(root)) for (const el of root) pathDel(rest, el);
  }
}

// 求值返回“值数组”（一般 1 个；含 [] 迭代的路径求值会产生多个）
function evalNode(node, input) {
  switch (node.kind) {
    case 'pipe': {
      const mid = evalNode(node.left, input);
      // 管道：左边的每个输出依次进入右边；这里左值一般是单个
      let out = [];
      for (const v of mid) out = out.concat(evalNode(node.right, v));
      return out;
    }
    case 'or': {
      const l = evalNode(node.left, input);
      const r = evalNode(node.right, input);
      return [l.some(isTruthy) || r.some(isTruthy)];
    }
    case 'and': {
      const l = evalNode(node.left, input);
      const r = evalNode(node.right, input);
      return [l.some(isTruthy) && r.some(isTruthy)];
    }
    case 'cmp': {
      const l = evalNode(node.left, input);
      const r = evalNode(node.right, input);
      const res = [];
      for (const a of l) for (const b of r) {
        res.push(node.op === '==' ? deepEqual(a === undefined ? null : a, b === undefined ? null : b)
          : !deepEqual(a === undefined ? null : a, b === undefined ? null : b));
      }
      return res;
    }
    case 'if': {
      const c = evalNode(node.cond, input);
      return evalNode(c.some(isTruthy) ? node.a : node.b, input);
    }
    case 'del': {
      for (const p of node.paths) pathDel(p, input);
      return [input];
    }
    case 'map': {
      if (!Array.isArray(input)) return [input];
      const out = [];
      for (const el of input) out.push(...evalNode(node.f, el));
      return [out];
    }
    case 'select': {
      const c = evalNode(node.c, input);
      return c.some(isTruthy) ? [input] : [];
    }
    case 'fn': {
      if (node.fn === 'type') return [jqType(input)];
      if (node.fn === 'not') return [!isTruthy(input)];
      if (node.fn === 'has') {
        const k = evalNode(node.args[0], input)[0];
        return [input !== null && typeof input === 'object' && !Array.isArray(input) &&
          Object.prototype.hasOwnProperty.call(input, k)];
      }
      if (node.fn === 'contains') {
        const s = evalNode(node.args[0], input)[0];
        return [typeof input === 'string' && typeof s === 'string' && input.indexOf(s) >= 0];
      }
      if (node.fn === 'test') {
        const re = evalNode(node.args[0], input)[0];
        const flags = node.args.length > 1 ? evalNode(node.args[1], input)[0] : '';
        return [typeof input === 'string' && new RegExp(re, flags || '').test(input)];
      }
      if (node.fn === 'IN') {
        const vals = [];
        for (const a of node.args) vals.push(...evalNode(a, input));
        return [vals.some(v => deepEqual(v, input))];
      }
      throw new Error('Unknown fn ' + node.fn);
    }
    case 'path': {
      return pathGet(node.path, input);
    }
    case 'assign': {
      const rhs = evalNode(node.rhs, input);
      const v = rhs.length ? rhs[rhs.length - 1] : null;
      if (node.path.length === 0) return [v];
      pathSet(node.path, input, () => v);
      return [input];
    }
    case 'update': {
      if (node.path.length === 0) {
        const r = evalNode(node.rhs, input);
        return [r.length ? r[r.length - 1] : input];
      }
      pathSet(node.path, input, old => {
        const r = evalNode(node.rhs, old);
        return r.length ? r[r.length - 1] : old;
      });
      return [input];
    }
    case 'lit': return [node.v];
    case 'obj': {
      const o = {};
      for (const e of node.entries) {
        const r = evalNode(e.val, input);
        o[e.key] = r.length ? r[r.length - 1] : null;
      }
      return [o];
    }
    case 'arr': {
      const a = [];
      for (const e of node.elems) {
        const r = evalNode(e, input);
        a.push(r.length ? r[r.length - 1] : null);
      }
      return [a];
    }
    default: throw new Error('Unknown node ' + node.kind);
  }
}

function evaluateFilter(filter, input) {
  const ast = parseFilter(filter);
  const data = JSON.parse(JSON.stringify(input));
  const out = evalNode(ast, data);
  return out.length ? out[out.length - 1] : data;
}

// ---- Surge 入口 ----
if (typeof $response !== 'undefined' && typeof $done !== 'undefined') {
  try {
    let filter = '';
    try { filter = decodeURIComponent($argument || ''); } catch (e) { filter = $argument || ''; }
    const body = JSON.parse($response.body);
    const out = evaluateFilter(filter, body);
    $done({ body: JSON.stringify(out) });
  } catch (e) {
    $done({});
  }
}

if (typeof module !== 'undefined') module.exports = { evaluateFilter: evaluateFilter, parseFilter: parseFilter };
