/**
 * A-114 / D-55 — ONE CLIENT, HOWEVER TWO PEOPLE TYPE HER.
 *
 * Every equality in this file has a DIFFERENT string on each side. The test
 * this replaces typed `(512) 555-0101` and asserted `5125550101` back: the same
 * literal twice, which proves the normaliser is deterministic and says nothing
 * about whether the record the desk wrote is the one the website finds. It
 * passed while a blocked client booked past CLIENT-04 by writing brackets.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/client/index.js';
import { resetDatabase } from '../testing';
import { findReturningClient, findSplitRecords, mergeClients, searchClients } from './clients';

const prisma = new PrismaClient();
let businessId: string;

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDatabase(prisma);
  businessId = (await prisma.business.create({ data: { name: 'Shear Genius', timezone: 'America/Chicago' } })).id;
});

/** Written the way a person at the desk (or a seed, or a fixture) writes it. */
const desk = (name: string, phone: string, business = businessId) =>
  prisma.client.create({ data: { businessId: business, name, phone }, select: { id: true, phone: true, nameFolded: true } });

/** "Núñez" DECOMPOSED — a letter followed by U+0303, which is what several
 *  phone keyboards send. Looks identical on screen; is a different string. */
const DECOMPOSED = 'Rae Nu\u0303n\u0303ez';

describe('the phone the database stores (D-55)', () => {
  it('is one number however a person writes it', async () => {
    const written = ['(512) 555-0101', '512.555.0101', '1 512 555 0101', '+1 512 555 0101', ' 5125550101 '];
    const stored = [];
    for (const [index, phone] of written.entries()) stored.push((await desk(`Person ${index}`, phone)).phone);
    expect(new Set(stored)).toEqual(new Set(['+15125550101']));
  });

  it('keeps a number written with + as given, and canonicalises without refusing anything', async () => {
    expect((await desk('Abroad', '+44 20 7946 0958')).phone).toBe('+442079460958');
    expect((await desk('Local', '555-0101')).phone).toBe('5550101');
    expect((await desk('Wordy', 'ask Dana')).phone).toBeNull();
  });
});

describe('the name the database compares (D-55)', () => {
  it('folds accents, case, Unicode form and spacing, whoever writes the row', async () => {
    expect((await desk('Rae Núñez', '5125550104')).nameFolded).toBe('rae nunez');
    expect((await desk(DECOMPOSED, '5125550104')).nameFolded).toBe('rae nunez');
    expect((await desk('  RAE   NÚÑEZ ', '5125550104')).nameFolded).toBe('rae nunez');
  });

  it('cannot be written by hand to a fold the name does not have', async () => {
    const { id } = await desk('Rae Núñez', '5125550104');
    const forged = await prisma.client.update({ where: { id }, data: { nameFolded: 'somebody else' } });
    expect(forged.nameFolded).toBe('rae nunez');
  });
});

describe('findReturningClient — the website finds the record the desk wrote', () => {
  it('across phone formats and name forms', async () => {
    const { id } = await desk('Rae Núñez', '+1 512 555 0104');
    const typed = [
      { phone: '(512) 555-0104', name: 'rae nunez' },
      { phone: '512.555.0104', name: DECOMPOSED },
      { phone: '1 512 555 0104', name: '  RAE   NÚÑEZ ' },
    ];
    for (const attempt of typed) expect(await findReturningClient(prisma, businessId, attempt)).toBe(id);
  });

  it('never makes one person of a household on one number (D-17)', async () => {
    await desk('Marcy Dunn', '+15125550107');
    expect(await findReturningClient(prisma, businessId, { phone: '(512) 555-0107', name: 'Leo Dunn' })).toBeNull();
  });

  it('never crosses a business boundary', async () => {
    const rival = (await prisma.business.create({ data: { name: 'Rival', timezone: 'America/Chicago' } })).id;
    await desk('Rae Núñez', '+15125550104', rival);
    expect(await findReturningClient(prisma, businessId, { phone: '(512) 555-0104', name: 'Rae Nunez' })).toBeNull();
  });

  /** The recovery for rows already split must not reopen the hole: the
   *  tombstone keeps her name and number, and here it is the OLDER row. */
  it('lands on the survivor of a merge, never on the tombstone', async () => {
    const original = await desk('Alice Hall', '+15125550101');
    const duplicate = await desk('alice hall', '(512) 555-0101');
    await mergeClients(prisma, { businessId, survivorId: duplicate.id, losingId: original.id });

    expect(await findReturningClient(prisma, businessId, { phone: '512 555 0101', name: 'Alice Hall' })).toBe(duplicate.id);
  });

  it('follows an old identity that only the tombstone still carries to its survivor', async () => {
    const old = await desk('Ada Chenn', '5125559999');
    const survivor = await desk('Ada Chen-Marsh', '5125550199');
    await mergeClients(prisma, { businessId, survivorId: survivor.id, losingId: old.id });

    expect(await findReturningClient(prisma, businessId, { phone: '(512) 555-9999', name: 'ada chenn' })).toBe(survivor.id);
  });
});

describe('searchClients — the desk finds her the way the website does', () => {
  it('matches an accented name from a plain query, and a decomposed one from an accented query', async () => {
    await desk('Rae Núñez', '5125550104');
    await desk('Nils Ångström', '5125550108');
    await desk('Zoë Nunn', '5125550109');

    expect((await searchClients(prisma, businessId, 'nunez')).map((c) => c.name)).toEqual(['Rae Núñez']);
    expect((await searchClients(prisma, businessId, 'ANGSTROM')).map((c) => c.name)).toEqual(['Nils Ångström']);

    await prisma.client.deleteMany({ where: { name: 'Rae Núñez' } });
    await desk(DECOMPOSED, '5125550104');
    expect((await searchClients(prisma, businessId, 'Núñez')).map((c) => c.name)).toEqual([DECOMPOSED]);
  });
});

describe('findSplitRecords — the rows A-114 made, named on the record', () => {
  it('lists the same person typed another way, and nobody else', async () => {
    const seeded = await desk('Alice Hall', '+15125550101');
    const typed = await desk('alice hall', '(512) 555-0101');
    await desk('Bob Hall', '5125550101'); // the household (D-17)
    await desk('Alice Hall', '5125550199'); // a different Alice

    expect((await findSplitRecords(prisma, businessId, seeded.id)).map((c) => c.id)).toEqual([typed.id]);
    expect((await findSplitRecords(prisma, businessId, typed.id)).map((c) => c.id)).toEqual([seeded.id]);
  });

  it('stops naming it once it has been merged', async () => {
    const seeded = await desk('Alice Hall', '+15125550101');
    const typed = await desk('Alice Hall', '(512) 555-0101');
    await mergeClients(prisma, { businessId, survivorId: seeded.id, losingId: typed.id });

    expect(await findSplitRecords(prisma, businessId, seeded.id)).toEqual([]);
  });
});
