import { describe, it, expect } from 'vitest';
import { InMemoryRepository } from '../src/data/repository.js';
import { BATCHES, WAREHOUSES, CROPS, GRADES, SUPPLIERS, CUSTOMERS, PRODUCTS } from '../src/data/seed.js';

/**
 * The bundled dataset has to hang together.
 *
 * It is a fixture rather than a database, so nothing enforces a foreign key:
 * a batch could name a godown the warehouse master has never heard of, and for
 * a long time one did. That is invisible until a screen reads the two together
 * -- the Inventory screen showed stock sitting in "Jashore Cold Store" while
 * the Warehouses screen listed no such place, which reads as a bug in the
 * application rather than in the sample data.
 *
 * These assert the references the screens actually follow. They are cheap, and
 * they fail the moment somebody adds a record pointing at nothing.
 */

/** Names in `values` that are missing from `master`. */
const dangling = (values, master) => [...new Set(values)].filter((v) => !master.includes(v));

describe('the bundled dataset', () => {
  it('holds every batch in a warehouse the master lists', () => {
    // The one this test was written for: stock cannot be somewhere the
    // business does not have.
    expect(dangling(BATCHES.map((b) => b.wh), WAREHOUSES)).toEqual([]);
  });

  it('names a crop, a grade and a supplier that exist for every batch', () => {
    expect(dangling(BATCHES.map((b) => b.crop), CROPS)).toEqual([]);
    expect(dangling(BATCHES.map((b) => b.grade), GRADES)).toEqual([]);
    expect(dangling(BATCHES.map((b) => b.sup), SUPPLIERS.map((s) => s.name))).toEqual([]);
  });

  it('lists no warehouse twice, so a picker cannot offer one twice', () => {
    expect(new Set(WAREHOUSES).size).toBe(WAREHOUSES.length);
  });

  it('gives every party and product a code of its own', () => {
    // A duplicate code makes two records indistinguishable to every screen
    // that selects one by it, which is all of them.
    const unique = (rows) => new Set(rows.map((r) => r.code)).size === rows.length;

    expect(unique(CUSTOMERS), 'customers').toBe(true);
    expect(unique(SUPPLIERS), 'suppliers').toBe(true);
    expect(unique(PRODUCTS), 'products').toBe(true);
  });

  it('reaches the screens with the same integrity it has on disk', async () => {
    // What the app actually boots on, rather than the modules behind it: the
    // repository clones and reshapes, and the reshaping is what a screen reads.
    const data = await new InMemoryRepository({ latency: 0 }).load();

    expect(dangling(data.batches.map((b) => b.wh), data.warehouses)).toEqual([]);
    expect(dangling(data.batches.map((b) => b.crop), data.crops)).toEqual([]);
  });

  it('agrees with itself about how many godowns hold stock', () => {
    // Every warehouse a batch names is on the master, so the count of godowns
    // holding stock can never exceed the master.
    const holding = new Set(BATCHES.map((b) => b.wh));
    expect(holding.size).toBeLessThanOrEqual(WAREHOUSES.length);
  });
});
