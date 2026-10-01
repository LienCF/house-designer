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

test('default plan has a cabinet filling the east end of the flex space, between the wardrobe row and the south wall S16', () => {
  const s = Core.defaultState(data);
  const inside = (f, px, py) => {
    const r = (f.rot || 0) * Math.PI / 180;
    const dx = px - f.x, dy = py - f.y;
    const lx = dx * Math.cos(r) - dy * Math.sin(r), ly = dx * Math.sin(r) + dy * Math.cos(r);
    return Math.abs(lx) <= f.w / 2 && Math.abs(ly) <= f.d / 2;
  };
  const cabinets = s.furniture.filter(f => f.type === 'cabinet' || f.type === 'wardrobe');
  for (const [px, py] of [[7400, 4100], [7531, 4408], [7700, 4750]]) {
    assert.ok(cabinets.some(f => inside(f, px, py)), `no cabinet covers (${px}, ${py})`);
  }
  // front must face west (door swing in the 0104 plan opens into the flex space)
  const c = cabinets.find(f => inside(f, 7531, 4560));
  assert.strictEqual(((c.rot % 360) + 360) % 360, 270);
});

const opening = (id) => data.openings.find((o) => o.id === id);
const furn = (id) => data.furniture.find((f) => f.id === id);
const overlap = (a, b) => Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > 0 && Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) > 0;

test('every slider door is one thin leaf riding on a declared side of its wall', () => {
  const expected = { O10: 'hi', O11: 'hi', O12: 'lo', O13: 'hi' };
  for (const id of Object.keys(expected)) {
    const o = opening(id);
    assert.strictEqual(o.side, expected[id], id + ' side');
    const leaf = Core.sliderLeaf(o);
    const horiz = (o.x2 - o.x1) >= (o.y2 - o.y1);
    const span = horiz ? o.x2 - o.x1 : o.y2 - o.y1;
    const len = horiz ? leaf.x2 - leaf.x1 : leaf.y2 - leaf.y1;
    const thick = horiz ? leaf.y2 - leaf.y1 : leaf.x2 - leaf.x1;
    assert.ok(len >= span * 0.85 && len <= span * 1.1, id + ' leaf length ' + len + ' vs span ' + span);
    assert.strictEqual(thick, 35, id + ' thickness');
    if (horiz) {
      if (o.side === 'lo') assert.ok(leaf.y2 <= o.y1, id + ' leaf must sit below the wall');
      else assert.ok(leaf.y1 >= o.y2, id + ' leaf must sit above the wall');
    } else if (o.side === 'lo') assert.ok(leaf.x2 <= o.x1, id + ' leaf must sit west of the wall');
    else assert.ok(leaf.x1 >= o.x2, id + ' leaf must sit east of the wall');
  }
});

test('slider leaves match the parked positions in the 0104 drawing', () => {
  const near = (a, b, id) => assert.ok(Math.abs(a - b) <= 3, `${id}: ${a} vs ${b}`);
  let l = Core.sliderLeaf(opening('O10')); near(l.x1, 1320, 'O10 x1'); near(l.x2, 2060, 'O10 x2');
  l = Core.sliderLeaf(opening('O11')); near(l.y1, 2316, 'O11 y1'); near(l.y2, 3056, 'O11 y2');
  l = Core.sliderLeaf(opening('O12')); near(l.x1, 3634, 'O12 x1'); near(l.x2, 4466, 'O12 x2');
  l = Core.sliderLeaf(opening('O13')); near(l.x1, 5028, 'O13 x1'); near(l.x2, 5768, 'O13 x2');
  assert.strictEqual(opening('O11').park, 'start');
});

test('no slider leaf collides with furniture', () => {
  for (const id of ['O10', 'O11', 'O12', 'O13']) {
    const leaf = Core.sliderLeaf(opening(id));
    for (const f of data.furniture) {
      assert.ok(!overlap(leaf, Core.furnitureAABB(f)), `${id} leaf hits ${f.id} ${f.name}`);
    }
  }
});

test('the living-room balcony door and the bedroom window each carry a double-layer curtain', () => {
  assert.ok(Array.isArray(data.curtains) && data.curtains.length === 2);
  const want = { O02: 'living', O03: 'bedroom' };
  for (const c of data.curtains) {
    const o = opening(c.opening);
    assert.ok(o && want[o.id], 'curtain host ' + c.opening);
    assert.strictEqual(c.ys.length, 2, 'two layers');
    assert.ok(c.ys[0] < c.ys[1], 'sheer layer is nearer the glass');
    assert.ok(c.ys.every((y) => y > o.y2), 'layers hang on the room side of the wall');
    assert.ok(c.stack >= 300 && c.stack <= 600, 'stack length');
    assert.ok(c.x1 >= o.x1 - 500 && c.x2 <= o.x2, 'rail stays within the opening span');
    assert.ok(c.x1 + c.stack <= c.x2, 'stack fits on the rail');
    assert.ok(c.rail <= 2595, 'rail clears the 800 mm beam soffit at 2600');
    assert.ok(c.rail >= 2200, 'rail is above the opening head');
  }
  assert.deepStrictEqual(data.curtains.map((c) => c.opening).sort(), ['O02', 'O03']);
});

test('curtain stacks do not collide with furniture', () => {
  for (const c of data.curtains) {
    const r = { x1: c.x1, x2: c.x1 + c.stack, y1: Math.min(...c.ys) - 30, y2: Math.max(...c.ys) + 30 };
    for (const f of data.furniture) assert.ok(!overlap(r, Core.furnitureAABB(f)), `${c.id} hits ${f.id}`);
  }
});

test('the living-room west wall furniture row is one continuous run like the drawing', () => {
  const a = (id) => Core.furnitureAABB(furn(id));
  assert.ok(furn('f08').h >= 2200, 'side cabinet is full height');
  assert.ok(Math.abs(a('f08').x1 - a('f04').x1) <= 2, 'side cabinet sits on the same wall face as the TV cabinet');
  const chain = [['f08', 'f04'], ['f04', 'f06'], ['f06', 'f07']];
  for (const [lo, hi] of chain) assert.ok(Math.abs(a(lo).y2 - a(hi).y1) <= 5, `${lo} to ${hi} gap ${a(hi).y1 - a(lo).y2}`);
  assert.strictEqual(furn('f05').y, furn('f04').y, 'TV is centered on its cabinet');
  assert.strictEqual(furn('f08').w, 600);
  assert.strictEqual(furn('f04').w, 2400);
  assert.strictEqual(furn('f06').w, 900);
  assert.strictEqual(furn('f07').w, 450);
});

test('the bedroom wardrobe matches the drawing and clears the entrance slider', () => {
  const f = furn('f23');
  assert.strictEqual(f.w, 880);
  assert.strictEqual(f.d, 600);
  assert.ok(Core.furnitureAABB(f).y2 <= 960, 'wardrobe ends before the slider track');
});

test('a saved state from an older furniture layout is refreshed once and keeps user-added pieces', () => {
  const s = Core.defaultState(data);
  delete s.furnSig;                                        // legacy save, written before furnSig existed
  s.furniture = s.furniture.filter(f => f.id !== 'f25b'); // old layout lacked this cabinet
  const f08 = s.furniture.find(f => f.id === 'f08');
  f08.y -= 300;                                            // old position
  s.furniture.push({ id: 'n3', type: 'table', name: '自訂桌', x: 3000, y: 3000, w: 800, d: 600, h: 750, rot: 0 });
  const r = Core.sanitizeState(JSON.parse(JSON.stringify(s)), data);
  assert.strictEqual(r.furnitureRefreshed, true);
  const want = data.furniture.find(f => f.id === 'f08');
  assert.strictEqual(r.state.furniture.find(f => f.id === 'f08').y, want.y);
  assert.ok(r.state.furniture.some(f => f.id === 'f25b'), 'new default cabinet must appear');
  assert.ok(r.state.furniture.some(f => f.id === 'n3'), 'user-added furniture must survive');
  assert.strictEqual(r.state.furniture.length, data.furniture.length + 1);
  const again = Core.sanitizeState(JSON.parse(JSON.stringify(r.state)), data);
  assert.strictEqual(again.furnitureRefreshed, false);
});

test('a saved state with the current furniture layout keeps the user moves', () => {
  const s = Core.defaultState(data);
  s.furniture.find(f => f.id === 'f08').y += 250;
  const r = Core.sanitizeState(JSON.parse(JSON.stringify(s)), data);
  assert.strictEqual(r.furnitureRefreshed, false);
  assert.strictEqual(r.state.furniture.find(f => f.id === 'f08').y, data.furniture.find(f => f.id === 'f08').y + 250);
});

test('editing a default furniture piece in the plan data invalidates old saves', () => {
  const s = Core.defaultState(data);
  const d2 = JSON.parse(JSON.stringify(data));
  d2.furniture.find(f => f.id === 'f08').w += 10;
  const r = Core.sanitizeState(JSON.parse(JSON.stringify(s)), d2);
  assert.strictEqual(r.furnitureRefreshed, true);
  assert.strictEqual(r.state.furniture.find(f => f.id === 'f08').w, d2.furniture.find(f => f.id === 'f08').w);
});

test('both bathrooms use the non-slip tile by default', () => {
  assert.strictEqual(data.floors['客浴'], 'balcony');
  assert.strictEqual(data.floors['主浴'], 'balcony');
  assert.strictEqual(Core.defaultState(data).floors['客浴'], 'balcony');
});

test('the sofa back sits against the desk and the desk is 750 mm from the bedroom wall', () => {
  const f = id => data.furniture.find(x => x.id === id);
  const ext = o => (Math.abs(o.rot) === 90 ? { ex: o.d, ey: o.w } : { ex: o.w, ey: o.d });
  const sofa = f('f02'), desk = f('f09'), desk2 = f('f09b'), p01 = data.walls.find(w => w.id === 'P01');
  const sofaEast = sofa.x + ext(sofa).ex / 2;
  const deskWest = desk.x - ext(desk).ex / 2, deskEast = desk.x + ext(desk).ex / 2;
  assert.ok(Math.abs(sofaEast - deskWest) <= 1, `sofa back ${sofaEast} vs desk ${deskWest}`);
  assert.strictEqual(p01.x1 - deskEast, 750);
  assert.strictEqual(desk2.x, desk.x);
  assert.ok(Math.abs(sofa.y - (desk.y + desk2.y) / 2) <= 1, 'sofa is centred on the joined desks');
  for (const id of ['f10', 'f11']) assert.ok(f(id).x + ext(f(id)).ex / 2 < p01.x1, id + ' chair clears the bedroom wall');
});

test('legacy saves without a floor baseline pick up the new default floors', () => {
  const s = Core.defaultState(data);
  delete s.floorsBase; delete s.furnSig;
  s.floors['客浴'] = 'tile80'; s.floors['主浴'] = 'tile80';
  const r = Core.sanitizeState(JSON.parse(JSON.stringify(s)), data);
  assert.strictEqual(r.floorsRefreshed, true);
  assert.strictEqual(r.state.floors['客浴'], 'balcony');
  assert.strictEqual(r.state.floors['主浴'], 'balcony');
});

test('a changed default floor reaches saves that never touched it but spares user choices', () => {
  const s = Core.defaultState(data);
  s.floors['臥室'] = 'walnut';                       // user choice
  const d2 = JSON.parse(JSON.stringify(data));
  d2.floors['玄關'] = 'oak';                         // new default for an untouched room
  d2.floors['臥室'] = 'slate';                       // new default for a user-customised room
  const r = Core.sanitizeState(JSON.parse(JSON.stringify(s)), d2);
  assert.strictEqual(r.floorsRefreshed, true);
  assert.strictEqual(r.state.floors['玄關'], 'oak');
  assert.strictEqual(r.state.floors['臥室'], 'walnut');
  const again = Core.sanitizeState(JSON.parse(JSON.stringify(r.state)), d2);
  assert.strictEqual(again.floorsRefreshed, false);
  assert.strictEqual(again.state.floors['臥室'], 'walnut');
});

test('saves on the current default floors keep user floor choices', () => {
  const s = Core.defaultState(data);
  s.floors['客餐廳'] = 'oak';
  const r = Core.sanitizeState(JSON.parse(JSON.stringify(s)), data);
  assert.strictEqual(r.floorsRefreshed, false);
  assert.strictEqual(r.state.floors['客餐廳'], 'oak');
});

test('living room sofa, desk, chair and TV stand sizes match the space plan drawing', () => {
  const f = id => data.furniture.find(x => x.id === id);
  const size = o => [o.w, o.d, o.h].slice(0, 2).join('x');
  assert.strictEqual(size(f('f02')), '2100x900');         // sofa 909 x 2105 in the drawing
  assert.strictEqual(size(f('f09')), '1050x600');         // joined desks 609 x 2104 in total
  assert.strictEqual(size(f('f09b')), '1050x600');
  assert.strictEqual(size(f('f04')), '2400x450');         // TV stand outline 459 x 2402
  for (const id of ['f10', 'f11']) {                       // chair symbol 516 (x) x 452 (y)
    assert.strictEqual(size(f(id)), '452x516', id);
    assert.strictEqual(f(id).x, 4507, id);
  }
  assert.strictEqual(f('f10').y - f('f11').y, 876);        // chairs sit closer together than the desks
  assert.strictEqual((f('f10').y + f('f11').y) / 2, f('f09').y / 2 + f('f09b').y / 2);
});

test('furniture leaves at least 600 mm clear in front of every door and slider opening', () => {
  const ext = o => (Math.abs(o.rot) % 180 === 90 ? { ex: o.d, ey: o.w } : { ex: o.w, ey: o.d });
  const DEPTH = 600, MIN_CLEAR = 600, MIN_INTRUSION = 100;
  const problems = [];
  for (const op of data.openings.filter(o => o.kind === 'door' || o.kind === 'slider')) {
    const horiz = op.x2 - op.x1 > op.y2 - op.y1;            // opening runs along x
    const a = horiz ? op.x1 : op.y1, b = horiz ? op.x2 : op.y2;
    for (const side of [-1, 1]) {
      const lo = horiz ? (side < 0 ? op.y1 - DEPTH : op.y2) : (side < 0 ? op.x1 - DEPTH : op.x2);
      const hi = lo + DEPTH;
      const spans = [];
      for (const f of data.furniture) {
        if (f.type === 'rug') continue;
        const e = ext(f);
        const [f1, f2] = horiz ? [f.x - e.ex / 2, f.x + e.ex / 2] : [f.y - e.ey / 2, f.y + e.ey / 2];
        const [p1, p2] = horiz ? [f.y - e.ey / 2, f.y + e.ey / 2] : [f.x - e.ex / 2, f.x + e.ex / 2];
        const depth = Math.min(hi, p2) - Math.max(lo, p1);
        const s1 = Math.max(a, f1), s2 = Math.min(b, f2);
        if (depth >= MIN_INTRUSION && s2 > s1) spans.push([s1, s2, f.id]);
      }
      spans.sort((x, y) => x[0] - y[0]);
      let blocked = 0, end = -Infinity;
      for (const [s1, s2] of spans) { blocked += Math.max(0, s2 - Math.max(s1, end)); end = Math.max(end, s2); }
      if (b - a - blocked < MIN_CLEAR) problems.push(`${op.id} ${op.name} side ${side}: ${spans.map(s => s[2]).join(',')} leave ${b - a - blocked} mm`);
    }
  }
  assert.deepStrictEqual(problems, []);
});

test('the living-room TV centre sits at seated eye level and clears the TV stand', () => {
  const tv = data.furniture.find(f => f.id === 'f05');
  const stand = data.furniture.find(f => f.id === 'f04');
  const centre = tv.elev + tv.h / 2;
  assert.ok(centre >= 950 && centre <= 1200, `TV centre ${centre} mm should be 950-1200 mm (seated eye level)`);
  assert.ok(tv.elev >= stand.h + 100, `TV bottom ${tv.elev} mm should clear the stand top (${stand.h} mm) by 100 mm`);
});

test('clear ceiling height is the 3.4 m storey minus the slab, and nothing reaches above it', () => {
  assert.strictEqual(data.storeyHeight, 3400, 'storey height from the user');
  assert.strictEqual(data.wallHeight, 3200, 'clear height is at least 3.2 m once the slab is subtracted');
  for (const f of data.furniture) assert.ok((f.elev || 0) + f.h <= data.wallHeight, `${f.id} top is below the ceiling`);
  for (const o of data.openings) if (o.head) assert.ok(o.head <= data.wallHeight, `${o.id} head is below the ceiling`);
  for (const c of data.curtains) assert.ok(c.rail <= data.wallHeight, `${c.id} rail is below the ceiling`);
  // beam depth is the structural depth measured from the storey level, so the soffits stay put
  const soffits = data.beams.map(b => data.storeyHeight - b.depth);
  assert.deepStrictEqual(soffits, [2600, 2600, 2600, 2750, 2750, 2750, 2750]);
  assert.ok(soffits.every(s => s < data.wallHeight), 'every beam hangs below the ceiling plane');
});

test('the bird view wall cut height defaults to 2500 mm in the state, the slider and its label', () => {
  const opts = html.match(/opts:\s*\{[^}]*\bcut:\s*(\d+)/);
  const slider = html.match(/<input[^>]*id="cutH"[^>]*>/)[0];
  const label = html.match(/<span id="cutHVal">(\d+)<\/span>/);
  const attr = (n) => Number(slider.match(new RegExp('\\b' + n + '="(\\d+)"'))[1]);
  assert.ok(opts && label, 'cut default and label are present');
  assert.strictEqual(Number(opts[1]), 2500, 'App.opts.cut');
  assert.strictEqual(attr('value'), 2500, 'slider value');
  assert.strictEqual(Number(label[1]), 2500, 'slider label');
  assert.ok(2500 >= attr('min') && 2500 <= attr('max') && (2500 - attr('min')) % attr('step') === 0, '2500 is reachable on the slider');
});

test('each shower set is wall mounted on a non-glass side at the plumbing point of the 2026-05-21 plan', () => {
  // Same wall points as the Blender model (guest: north wall, shower centre; master: east wall, south half).
  const planPoint = { f30: [550, 8290], f33: [9200, 1550] };
  for (const id of ['f30', 'f33']) {
    const f = data.furniture.find(x => x.id === id);
    assert.ok(f.mount, `${id} declares where its shower set is mounted`);
    assert.ok(['back', 'left'].includes(f.mount.side), `${id}: the glass is on the front and right sides, so the set cannot be there`);
    const along = f.mount.side === 'back' ? f.w : f.d;
    assert.ok(Math.abs(f.mount.at) <= along / 2 - 140, `${id}: the 280 mm mixer stays inside the shower footprint`);
    // Item-local plan frame: x to the right, z toward the front (south at rot 0); rot turns counter-clockwise with y north.
    const lx = f.mount.side === 'back' ? f.mount.at : -f.w / 2;
    const lz = f.mount.side === 'back' ? -f.d / 2 : f.mount.at;
    const a = f.rot * Math.PI / 180;
    const wx = f.x + lx * Math.cos(a) + lz * Math.sin(a);
    const wy = f.y + lx * Math.sin(a) - lz * Math.cos(a);
    assert.ok(Math.abs(wx - planPoint[id][0]) <= 100 && Math.abs(wy - planPoint[id][1]) <= 100,
      `${id}: wall point (${Math.round(wx)}, ${Math.round(wy)}) should be near ${planPoint[id]}`);
  }
});

test('a two-finger pinch keeps the plan point under the midpoint and clamps the scale', () => {
  const view = { s: 0.1, ox: 100, oy: 500 };
  const limits = { min: 0.012, max: 1.2 };
  const plan = (v, sx, sy) => ({ x: (sx - v.ox) / v.s, y: (v.oy - sy) / v.s });
  // Fingers spread from 100 px to 200 px apart while the midpoint moves from (300, 300) to (320, 280).
  const next = Core.pinchView(view, { sx: 250, sy: 300 }, { sx: 350, sy: 300 }, { sx: 220, sy: 280 }, { sx: 420, sy: 280 }, limits);
  assert.ok(Math.abs(next.s - 0.2) < 1e-9, 'scale follows the finger distance ratio');
  const before = plan(view, 300, 300), after = plan(next, 320, 280);
  assert.ok(Math.abs(before.x - after.x) < 1e-6 && Math.abs(before.y - after.y) < 1e-6, 'the plan point under the midpoint follows the fingers');
  const pan = Core.pinchView(view, { sx: 250, sy: 300 }, { sx: 350, sy: 300 }, { sx: 270, sy: 310 }, { sx: 370, sy: 310 }, limits);
  assert.strictEqual(pan.s, view.s);
  assert.ok(Math.abs(pan.ox - (view.ox + 20)) < 1e-9 && Math.abs(pan.oy - (view.oy + 10)) < 1e-9, 'equal distance is a pure two-finger pan');
  const huge = Core.pinchView(view, { sx: 290, sy: 300 }, { sx: 310, sy: 300 }, { sx: 0, sy: 300 }, { sx: 600, sy: 300 }, limits);
  assert.strictEqual(huge.s, limits.max);
  const tiny = Core.pinchView(view, { sx: 0, sy: 300 }, { sx: 600, sy: 300 }, { sx: 299, sy: 300 }, { sx: 301, sy: 300 }, limits);
  assert.strictEqual(tiny.s, limits.min);
  const same = Core.pinchView(view, { sx: 100, sy: 100 }, { sx: 100, sy: 100 }, { sx: 120, sy: 100 }, { sx: 140, sy: 100 }, limits);
  assert.ok(Number.isFinite(same.s) && Number.isFinite(same.ox), 'two fingers on the same spot do not divide by zero');
});

test('the virtual walk pad has a dead zone, maps up to forward and saturates at the rim', () => {
  const R = 48, dead = 0.2;
  const zero = Core.padVector(3, -4, R, dead);
  assert.deepStrictEqual([zero.fw, zero.st], [0, 0]);
  const up = Core.padVector(0, -R, R, dead);
  assert.ok(Math.abs(up.fw - 1) < 1e-9 && Math.abs(up.st) < 1e-9, 'rim straight up is full forward');
  const right = Core.padVector(R, 0, R, dead);
  assert.ok(Math.abs(right.st - 1) < 1e-9 && Math.abs(right.fw) < 1e-9, 'rim to the right is full strafe right');
  const down = Core.padVector(0, R / 2, R, dead);
  assert.ok(down.fw < 0 && down.fw > -1, 'half way down walks backwards at part speed');
  const far = Core.padVector(300, -400, R, dead);
  assert.ok(Math.abs(Math.hypot(far.fw, far.st) - 1) < 1e-9, 'beyond the rim the magnitude stays at 1');
  const justOut = Core.padVector(R * 0.21, 0, R, dead);
  assert.ok(justOut.st > 0 && justOut.st < 0.05, 'speed ramps up from zero at the dead zone edge');
});

test('walk steps keep the keyboard speed and scale with how far the pad is pushed', () => {
  const speed = 1300, dt = 0.016;
  const fwd = Core.walkDelta(1, 0, 0, speed, dt);
  assert.ok(Math.abs(fwd.dx - speed * dt) < 1e-9 && Math.abs(fwd.dy) < 1e-9, 'forward at heading 0 goes east at full speed');
  const north = Core.walkDelta(1, 0, Math.PI / 2, speed, dt);
  assert.ok(Math.abs(north.dy - speed * dt) < 1e-9 && Math.abs(north.dx) < 1e-9, 'heading pi/2 walks north');
  const diag = Core.walkDelta(1, 1, 0, speed, dt);
  assert.ok(Math.abs(Math.hypot(diag.dx, diag.dy) - speed * dt) < 1e-9, 'W and D together are not faster than W alone');
  const half = Core.walkDelta(0.5, 0, 0, speed, dt);
  assert.ok(Math.abs(half.dx - speed * dt / 2) < 1e-9, 'half deflection walks at half speed');
  const right = Core.walkDelta(0, 1, 0, speed, dt);
  assert.ok(Math.abs(right.dy + speed * dt) < 1e-9 && Math.abs(right.dx) < 1e-9, 'strafe right at heading 0 goes south');
  const idle = Core.walkDelta(0, 0, 1, speed, dt);
  assert.deepStrictEqual([idle.dx, idle.dy], [0, 0]);
});

test('touch devices get a 2D canvas that owns its gestures, a walk pad, a legend toggle and 16 px inputs', () => {
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(css, /#c2d\s*\{[^}]*touch-action:\s*none/, 'the 2D canvas must not let Safari scroll or zoom the page under a drag');
  assert.match(css, /html\.touch\s+(input|select)[^{]*\{[^}]*font-size:\s*16px/, 'iOS zooms the page when a smaller input is focused');
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*#legend\.hide\s*\{\s*display:\s*none/, 'the legend can be hidden on a phone');
  for (const id of ['fpPad', 'fpKnob', 'fpRun', 'legendBtn', 'zoomIn', 'zoomOut', 'zoomFit']) assert.match(html, new RegExp('id="' + id + '"'), id + ' exists');
  assert.match(html, /<div id="legend" class="hide">/, 'the legend starts hidden on a phone');
  assert.match(html, /any-pointer: coarse/, 'the touch UI switches on for coarse pointers');
});
