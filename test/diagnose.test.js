import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseSeries } from '../src/observe.js';

const ev = (ms, extra = {}) => ({ at: new Date().toISOString(), ms, ...extra });
const kinds = (events) => diagnoseSeries(events).map((d) => d.kind);
const textFor = (events, kind) => diagnoseSeries(events).find((d) => d.kind === kind)?.text || '';

test('fewer than three runs cannot be diagnosed', () => {
  assert.deepEqual(diagnoseSeries([]), []);
  assert.deepEqual(diagnoseSeries([ev(10)]), []);
  assert.deepEqual(diagnoseSeries([ev(10), ev(20)]), []);
});

test('a cold first run is named as warm-up, not as a regression', () => {
  const events = [ev(5000), ev(100), ev(110), ev(105), ev(108)];
  assert.ok(kinds(events).includes('cold-start'));
  const text = textFor(events, 'cold-start');
  assert.match(text, /first run was/);
  assert.match(text, /warm-up/);
});

test('a rising second half is reported as a trend with numbers', () => {
  const events = [ev(100), ev(105), ev(110), ev(400), ev(420), ev(430)];
  assert.ok(kinds(events).includes('trend-up'));
  const text = textFor(events, 'trend-up');
  assert.match(text, /trending slower/);
  assert.match(text, /early vs .* recent/);
});

test('a falling second half is reported as faster', () => {
  const events = [ev(500), ev(520), ev(510), ev(100), ev(110), ev(105)];
  assert.ok(kinds(events).includes('trend-down'));
});

test('one outlier far above the p90 is called out', () => {
  const events = Array.from({ length: 9 }, () => ev(100)).concat([ev(900)]);
  assert.ok(kinds(events).includes('outlier'));
  assert.match(textFor(events, 'outlier'), /single outlier/);
});

test('two clusters are detected and both are described', () => {
  const events = [ev(100), ev(105), ev(110), ev(102), ev(800), ev(820), ev(810), ev(830)];
  assert.ok(kinds(events).includes('bimodal'));
  const text = textFor(events, 'bimodal');
  assert.match(text, /two clusters/);
  assert.match(text, /4 runs/);
});

test('slow runs with less free memory are attributed to the machine', () => {
  const events = [
    ev(100, { freemem_mb: 3000 }), ev(110, { freemem_mb: 2900 }), ev(105, { freemem_mb: 2950 }),
    ev(900, { freemem_mb: 200 }), ev(950, { freemem_mb: 180 }), ev(880, { freemem_mb: 220 }),
  ];
  assert.ok(kinds(events).includes('memory-correlation'));
  assert.match(textFor(events, 'memory-correlation'), /the machine, not the code/);
});

test('slow runs under higher load are attributed to load', () => {
  const events = [
    ev(100, { freemem_mb: 3000, loadavg1: 0.2 }), ev(110, { freemem_mb: 3000, loadavg1: 0.3 }),
    ev(105, { freemem_mb: 3000, loadavg1: 0.25 }), ev(400, { freemem_mb: 3000, loadavg1: 8 }),
    ev(420, { freemem_mb: 3000, loadavg1: 9 }), ev(410, { freemem_mb: 3000, loadavg1: 7.5 }),
  ];
  assert.ok(kinds(events).includes('load-correlation'));
  assert.match(textFor(events, 'load-correlation'), /higher load/);
});

test('a run dominated by one test names that test', () => {
  const events = [
    ev(1000, { slowest_test: 'suite > big query', slowest_ms: 900, test_count: 40, test_total_ms: 1000 }),
    ev(1100, { slowest_test: 'suite > big query', slowest_ms: 1000, test_count: 40, test_total_ms: 1100 }),
    ev(1050, { slowest_test: 'suite > big query', slowest_ms: 950, test_count: 40, test_total_ms: 1050 }),
  ];
  assert.ok(kinds(events).includes('dominant-test'));
  const text = textFor(events, 'dominant-test');
  assert.match(text, /one test dominates/);
  assert.match(text, /big query/);
  assert.match(text, /90%|91%/);
});

test('a suite spread evenly across its tests is not blamed on one test', () => {
  const events = [
    ev(1000, { slowest_test: 'a', slowest_ms: 30, test_count: 40, test_total_ms: 1000 }),
    ev(1010, { slowest_test: 'b', slowest_ms: 31, test_count: 40, test_total_ms: 1010 }),
    ev(1005, { slowest_test: 'a', slowest_ms: 29, test_count: 40, test_total_ms: 1005 }),
  ];
  assert.ok(!kinds(events).includes('dominant-test'));
});

test('spikes right after the evidence changed are attributed to cold caches', () => {
  const events = [
    ev(120, { digest_changed: 1 }), ev(700, { digest_changed: 1 }), ev(680, { digest_changed: 1 }),
    ev(110, { digest_changed: 0 }), ev(115, { digest_changed: 0 }), ev(112, { digest_changed: 0 }),
  ];
  assert.ok(kinds(events).includes('cold-cache'));
  assert.match(textFor(events, 'cold-cache'), /cache or artifact rebuild/);
});

test('a genuinely flat series is called stable rather than diagnosed', () => {
  const events = [ev(100), ev(101), ev(99), ev(100), ev(102)];
  assert.deepEqual(kinds(events), ['stable']);
  assert.match(textFor(events, 'stable'), /no structure/);
});

test('diagnosis never invents a correlation without environment data', () => {
  const events = [ev(100), ev(900), ev(110), ev(105)];
  const ks = kinds(events);
  assert.ok(!ks.includes('memory-correlation'));
  assert.ok(!ks.includes('load-correlation'));
});
