#!/usr/bin/env node
/**
 * The client half's own test.
 *
 * `client.js` is not a normal module: the harness's web app loads client plugins through
 * `window.__ModuleLoader__.load({ id, factory })` and hands the factory a `require` for React. That
 * shape is reproduced here with stubs, which checks everything except the GUI actually mounting the
 * bar: the module registers under the right id, exposes `apply`/`inject`, contributes to the
 * `conversation.input.dock` slot, and renders the projection's line — while rendering nothing (and
 * throwing nothing) when the projection is absent.
 *
 * Run: node test/client.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, '..', 'client.js'), 'utf8');

/** Load `client.js` the way the web app does, with stubs for `window` and React. */
function loadClientHalf() {
  let registration;
  const window = { __ModuleLoader__: { load: (entry) => { registration = entry; } } };
  const context = vm.createContext({ window, console });
  vm.runInContext(SOURCE, context);
  assert.ok(registration !== undefined, 'the module loader entry must be registered');
  const jsxRuntime = { jsx: (type, props) => ({ type, props }) };
  const modules = { 'react/jsx-runtime': jsxRuntime, react: {} };
  const factoryRequire = (name) => {
    if (modules[name] === undefined) throw new Error(`unexpected require: ${name}`);
    return modules[name];
  };
  return { id: registration.id, exports: registration.factory(factoryRequire) };
}

let passed = 0;
let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${String(error.message).split('\n').join('\n        ')}`);
  }
};

check('registers under the plugin id the server half uses', () => {
  assert.equal(loadClientHalf().id, 'dsgs-statusline');
});

check('exposes the plugin surface the client runtime looks for', () => {
  const { exports } = loadClientHalf();
  // Realm-safe comparisons: the module runs inside a vm context, so its arrays do not share this
  // realm's prototypes and a strict deepEqual would fail for the wrong reason.
  assert.equal(exports.inject.length, 1);
  assert.equal(exports.inject[0], 'slots');
  assert.equal(typeof exports.apply, 'function');
  assert.equal(typeof exports.DgsStatuslineBar, 'function');
});

check('contributes to the input dock with the verified payload shape', () => {
  const { exports } = loadClientHalf();
  let injectedInto;
  let contribution;
  const ctx = {
    slots: {
      inject: (slot, register) => { injectedInto = slot; register(); },
      register: (meta, component) => { contribution = { meta, component }; },
    },
  };
  exports.apply(ctx);
  assert.equal(injectedInto, 'conversation.input.dock');
  assert.equal(contribution.meta.name, 'conversation.input.dock');
  assert.equal(contribution.meta.id, 'dsgs-statusline');
  assert.equal(typeof contribution.meta.order, 'number');
  assert.equal(typeof contribution.component, 'function');
});

check('renders the line from the session projection', () => {
  const { exports } = loadClientHalf();
  const session = {
    projections: {
      faceOf: (key) => (key === 'dgsStatusline' ? { getSnapshot: () => ({ line: 'ctx: 42% | model | Production' }) } : undefined),
    },
  };
  const rendered = exports.DgsStatuslineBar({ session });
  assert.equal(rendered.type, 'div');
  assert.equal(rendered.props.children, 'ctx: 42% | model | Production');
});

check('renders nothing — and throws nothing — without a projection', () => {
  const { exports } = loadClientHalf();
  assert.equal(exports.DgsStatuslineBar({}), null);
  assert.equal(exports.DgsStatuslineBar({ session: { projections: {} } }), null);
  assert.equal(exports.DgsStatuslineBar({ value: { line: '' } }), null);
});

console.log(`\nclient.test.mjs: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

