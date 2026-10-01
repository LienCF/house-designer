'use strict';
const fs = require('fs');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert');

const file = process.env.HTML || '/Users/liencf/Projects/House/3D/designer/house-designer.html';
const html = fs.readFileSync(file, 'utf8');
const data = JSON.parse(html.match(/<script id="plan-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
const coreSrc = html.match(/<script id="core">([\s\S]*?)<\/script>/)[1];
const sandbox = { module: { exports: {} } };
sandbox.globalThis = sandbox;
vm.runInNewContext(coreSrc, sandbox);
const Core = sandbox.module.exports;

const byName = (rooms, n) => rooms.regions.find(r => r.names.includes(n));

test('every named room gets its own region in the default plan', () => {
  const s = Core.defaultState(data);
  const rooms = Core.computeRooms(s, data);
  for (const n of ['玄關', '客餐廳', '廚房', '彈性空間', '更衣室', '臥室', '客浴', '主浴', '陽台', '後陽台']) {
    const r = byName(rooms, n);
    assert.ok(r, n + ' missing');
    assert.strictEqual(r.names.join(','), n, n + ' merged with ' + r.names.join(','));
  }
});

test('guest bath area matches the drawing (2.448 x 1.401 m)', () => {
  const s = Core.defaultState(data);
  const r = byName(Core.computeRooms(s, data), '客浴');
  const expected = (2523 - 75) * (8371 - 6971) / 1e6;
  assert.ok(Math.abs(r.area - expected) / expected < 0.03, `area ${r.area} vs ${expected}`);
});

test('rooms plus walls cover the outline area', () => {
  const s = Core.defaultState(data);
  const rooms = Core.computeRooms(s, data);
  const roomSum = rooms.all.reduce((a, r) => a + r.area, 0);
  let wallCells = 0;
  for (let i = 0; i < rooms.grid.length; i++) if (rooms.grid[i] === -1) wallCells++;
  const total = roomSum + wallCells * rooms.cell * rooms.cell / 1e6;
  const outline = Core.polygonArea(data.outline) / 1e6;
  assert.ok(Math.abs(total - outline) / outline < 0.01, `${total} vs ${outline}`);
});

test('removing the bedroom west partition merges bedroom with living room', () => {
  const s = Core.defaultState(data);
  Core.toggleWall(s, 'P01');
  const rooms = Core.computeRooms(s, data);
  const r = byName(rooms, '臥室');
  assert.ok(r.names.includes('客餐廳'), r.names.join(','));
});

test('removing a host partition removes its slider', () => {
  const s = Core.defaultState(data);
  Core.toggleWall(s, 'P07');
  assert.ok(!Core.activeOpenings(s).some(o => o.id === 'O10'));
  const r = byName(Core.computeRooms(s, data), '客浴');
  assert.ok(r.names.includes('玄關') || r.names.includes('客餐廳'), r.names.join(','));
  Core.toggleWall(s, 'P07');
  assert.ok(Core.activeOpenings(s).some(o => o.id === 'O10'));
});

test('bearing walls, columns and shafts cannot be removed', () => {
  const s = Core.defaultState(data);
  for (const id of ['S05', 'C01', 'H01']) assert.throws(() => Core.toggleWall(s, id));
  assert.strictEqual(Core.activeWalls(s).length, data.walls.length);
});

test('added wall splits a room and toggling deletes it', () => {
  const s = Core.defaultState(data);
  const w = Core.addWall(s, 4923, 5000, 7321, 5000);
  assert.strictEqual(w.y2 - w.y1, 100);
  const rooms = Core.computeRooms(s, data);
  const flex = byName(rooms, '彈性空間');
  assert.ok(rooms.regions.some(r => r.names.length === 0 && r.area > 1), 'expected new unnamed room');
  assert.ok(flex.area < 5, String(flex.area));
  assert.strictEqual(Core.toggleWall(s, w.id), 'deleted');
  assert.ok(!s.walls.some(x => x.id === w.id));
});

test('undo and redo restore snapshots', () => {
  const s = Core.defaultState(data);
  const h = new Core.History();
  h.push(s);
  s.furniture[0].x += 500; h.push(s);
  Core.toggleWall(s, 'P01'); h.push(s);
  assert.ok(!h.canRedo());
  const u1 = h.undo();
  assert.ok(!u1.walls.find(w => w.id === 'P01').removed);
  assert.strictEqual(u1.furniture[0].x, data.furniture[0].x + 500);
  const u2 = h.undo();
  assert.strictEqual(u2.furniture[0].x, data.furniture[0].x);
  assert.strictEqual(h.undo(), null);
  const r1 = h.redo();
  assert.strictEqual(r1.furniture[0].x, data.furniture[0].x + 500);
  h.push(Object.assign(r1, { measures: [{ x1: 0, y1: 0, x2: 1, y2: 1 }] }));
  assert.ok(!h.canRedo());
});

test('furniture snaps to the nearest wall face within tolerance, using rotated extents', () => {
  const wall = { x1: 0, y1: 0, x2: 100, y2: 3000 };
  const f = { x: 100 + 300 + 120, y: 1500, w: 2000, d: 600, h: 800, rot: 0 };
  // rot 0: half width 1000 -> left edge at -480, overlaps wall; no snap expected on x within 150
  let r = Core.snapFurniture(f, [wall], 150);
  assert.strictEqual(r.x, f.x);
  const g = Object.assign({}, f, { rot: 90 }); // half x-extent 300 -> left edge at 220, gap 120
  r = Core.snapFurniture(g, [wall], 150);
  assert.strictEqual(r.x, 100 + 300);
  assert.strictEqual(r.guideX, 100);
  const far = Object.assign({}, g, { x: 100 + 300 + 400 });
  assert.strictEqual(Core.snapFurniture(far, [wall], 150).x, far.x);
});

test('circle collision blocks walls but not open doors', () => {
  const s = Core.defaultState(data);
  const b = Core.blockers(s);
  assert.ok(Core.circleHits(800, 3000, 200, b));          // inside west wall S05
  assert.ok(!Core.circleHits(0, 6300, 200, b));           // entry door opening
  assert.ok(!Core.circleHits(2300, 1050, 200, b));         // french door is walkable
});

test('sanitizeState rejects non-state input', () => {
  for (const raw of [null, 'x', {}, { walls: [], openings: [], furniture: [] }, { walls: 1, openings: [], furniture: [], floors: {} }]) {
    assert.strictEqual(Core.sanitizeState(raw, data), null);
  }
});

test('sanitizeState drops malformed elements and fills furniture defaults', () => {
  const s = Core.defaultState(data);
  s.walls.push(null, { id: 'X', x1: 'a' });
  s.furniture.push(null, { id: 'bad' });
  delete s.furniture[0].rot;
  s.measures = [null, { x1: 0, y1: 0, x2: 10, y2: 0 }];
  s.viewer = null;
  const r = Core.sanitizeState(JSON.parse(JSON.stringify(s)), data);
  assert.ok(r);
  assert.strictEqual(r.state.walls.length, data.walls.length);
  assert.strictEqual(r.state.furniture.length, data.furniture.length);
  assert.strictEqual(r.state.furniture[0].rot, 0);
  assert.strictEqual(r.state.measures.length, 1);
  assert.ok(Number.isFinite(r.state.viewer.x));
  assert.doesNotThrow(() => Core.computeRooms(r.state, data));
});

test('sanitizeState migrates stale plan geometry but keeps user edits', () => {
  const s = Core.defaultState(data);
  Core.toggleWall(s, 'P01');
  const u = Core.addWall(s, 4923, 5000, 7321, 5000);
  s.walls.find(w => w.id === 'S05').x1 -= 300;
  s.openings.pop();
  const r = Core.sanitizeState(JSON.parse(JSON.stringify(s)), data);
  assert.strictEqual(r.migrated, true);
  const d05 = data.walls.find(w => w.id === 'S05');
  assert.strictEqual(r.state.walls.find(w => w.id === 'S05').x1, d05.x1);
  assert.strictEqual(r.state.openings.length, data.openings.length);
  assert.ok(r.state.walls.find(w => w.id === 'P01').removed);
  assert.ok(r.state.walls.some(w => w.id === u.id && w.added));
  assert.ok(r.state.nextId > Number(u.id.slice(1)));
  const same = Core.sanitizeState(JSON.parse(JSON.stringify(Core.defaultState(data))), data);
  assert.strictEqual(same.migrated, false);
});

test('a viewer stuck inside an obstacle can walk out but not into new obstacles', () => {
  const rects = [{ x1: 0, y1: 0, x2: 1000, y2: 1000, soft: true }, { x1: 1300, y1: 0, x2: 1400, y2: 1000 }];
  let p = Core.slideCircle(900, 500, 100, 0, 200, rects);   // inside the first box, moving out
  assert.strictEqual(p.x, 1000);
  p = Core.slideCircle(1100, 500, 50, 0, 200, rects);        // overlaps box 1 only, would touch box 2
  assert.strictEqual(p.x, 1100);
  p = Core.slideCircle(2000, 500, -100, 0, 200, rects);      // free space, normal move
  assert.strictEqual(p.x, 1900);
  p = Core.slideCircle(1650, 500, -100, 0, 200, rects);      // blocked by box 2
  assert.strictEqual(p.x, 1650);
});

test('a room keeps its name when an added wall covers its seed point', () => {
  const s = Core.defaultState(data);
  const seed = data.seeds.find(x => x.name === '客餐廳');
  Core.addWall(s, seed.x - 700, seed.y, seed.x + 700, seed.y);
  assert.ok(byName(Core.computeRooms(s, data), '客餐廳'));
});

test('unnamed regions keep separate floor materials', () => {
  const s = Core.defaultState(data);
  Core.addWall(s, 4923, 5000, 7321, 5000);
  const flexSeed = data.seeds.find(x => x.name === '彈性空間');
  Core.addWall(s, 4923, 4300, 7321, 4300);
  Core.addWall(s, 4923, 5600, 7321, 5600);
  const rooms = Core.computeRooms(s, data);
  const unnamed = rooms.regions.filter(r => !r.names.length);
  assert.ok(unnamed.length >= 2, 'need two unnamed regions, got ' + unnamed.length);
  assert.notStrictEqual(unnamed[0].key, unnamed[1].key);
  Core.setRegionMaterial(s, unnamed[0], 'walnut');
  assert.strictEqual(Core.regionMaterial(unnamed[0], s.floors), 'walnut');
  assert.notStrictEqual(Core.regionMaterial(unnamed[1], s.floors), 'walnut');
  assert.ok(flexSeed);
});

test('a viewer overlapping a wall cannot slide through it', () => {
  const wall = [{ x1: 1000, y1: 0, x2: 1100, y2: 3000 }];
  const p = Core.slideCircle(1000, 1500, 150, 0, 200, wall);
  assert.strictEqual(p.x, 1000);
  const s = Core.defaultState(data);
  const b = Core.blockers(s);
  assert.ok(b.some(r => r.soft) && b.some(r => !r.soft), 'furniture blockers are soft, walls are not');
});

test('sanitizeState nextId stays above existing furniture ids', () => {
  const s = Core.defaultState(data);
  s.furniture[0].id = 'n7';
  delete s.nextId;
  const r = Core.sanitizeState(JSON.parse(JSON.stringify(s)), data);
  assert.ok(r.state.nextId > 7, String(r.state.nextId));
});
