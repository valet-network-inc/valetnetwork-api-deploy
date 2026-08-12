/**
 * Unit tests for the Chauffeur pricing engine (services/chauffeurPricing.js)
 * and the async quote orchestrator. Run: npx jest chauffeurPricing
 */

const {
  computeFloorCents,
  computeBaseRateCents,
  computeSurgeMultiplier,
  computeSuggestedCents,
  computeSoftwareFeeCents,
  resolveFeeMode,
  validateQuote,
  quoteRide,
  _config,
} = require('../services/chauffeurPricing');

describe('floor', () => {
  test('standard rate = 1.283/mi + 0.681/min', () => {
    // 5mi, 20min => 6.415 + 13.62 = 20.035 => 2004c
    expect(computeFloorCents({ miles: 5, minutes: 20 })).toBe(2004);
  });

  test('zero trip => 0', () => {
    expect(computeFloorCents({ miles: 0, minutes: 0 })).toBe(0);
  });

  test('WAV mileage rate is higher than standard', () => {
    const std = computeFloorCents({ miles: 10, minutes: 0 });
    const wav = computeFloorCents({ miles: 10, minutes: 0, wav: true });
    expect(wav).toBeGreaterThan(std);
    expect(wav).toBe(1601); // 1.601 * 10
  });

  test('out-of-NYC portion priced at the out-of-NYC rate', () => {
    // 10mi total, 4 outside, 0 min: in 6*1.283=7.698 ; out 4*1.757=7.028 => 1473c
    expect(computeFloorCents({ miles: 10, minutes: 0, outOfNyc: { miles: 4, minutes: 0 } })).toBe(1473);
  });

  test('out-of-NYC portion cannot exceed total', () => {
    expect(computeFloorCents({ miles: 5, minutes: 0, outOfNyc: { miles: 99, minutes: 0 } }))
      .toBe(Math.round(5 * 1.757 * 100));
  });
});

describe('base rate', () => {
  test('base + per_mile*mi + per_min*min', () => {
    // 3.00 + 2.10*5 + 0.45*20 = 22.50 => 2250c
    expect(computeBaseRateCents({ miles: 5, minutes: 20 })).toBe(2250);
  });
});

describe('surge', () => {
  test('balanced (rho = target) => 1.0', () => {
    expect(computeSurgeMultiplier({ openRequests: 4, availableDrivers: 4 })).toBeCloseTo(1.0, 6);
  });

  test('no demand => 1.0', () => {
    expect(computeSurgeMultiplier({ openRequests: 0, availableDrivers: 5 })).toBe(1);
  });

  test('no drivers but demand => caps at mMax', () => {
    expect(computeSurgeMultiplier({ openRequests: 3, availableDrivers: 0 })).toBe(_config.surge.mMax);
  });

  test('high demand clamps to mMax', () => {
    expect(computeSurgeMultiplier({ openRequests: 100, availableDrivers: 1 })).toBe(2.0);
  });

  test('moderate demand: rho=2, gamma=0.5 => ~1.414', () => {
    expect(computeSurgeMultiplier({ openRequests: 2, availableDrivers: 1 })).toBeCloseTo(Math.sqrt(2), 6);
  });
});

describe('suggested', () => {
  test('floor wins when baseRate*surge is below floor', () => {
    expect(computeSuggestedCents({ floorCents: 3000, baseRateCents: 1000, surgeMultiplier: 1 })).toBe(3000);
  });

  test('baseRate*surge wins when above floor', () => {
    expect(computeSuggestedCents({ floorCents: 2000, baseRateCents: 2250, surgeMultiplier: 1.2 })).toBe(2700);
  });
});

describe('software fee', () => {
  test('per_ride = stripe pct + fixed + infra', () => {
    // 2500 * 0.029 = 72.5 -> 73 ; +30 +5 = 108
    expect(computeSoftwareFeeCents({ riderPriceCents: 2500 })).toBe(108);
  });

  test('subscription feeMode => 0', () => {
    expect(computeSoftwareFeeCents({ riderPriceCents: 2500, feeMode: 'subscription' })).toBe(0);
  });
});

describe('per-driver fee mode', () => {
  test('no driver => global default (per_ride)', () => {
    expect(resolveFeeMode(undefined)).toBe('per_ride');
  });

  test('active subscription => subscription', () => {
    expect(resolveFeeMode({ chauffeurSubscription: { active: true } })).toBe('subscription');
  });

  test('inactive subscription => per_ride', () => {
    expect(resolveFeeMode({ chauffeurSubscription: { active: false } })).toBe('per_ride');
  });

  test('subscription zeroes the fee in quoteRide', () => {
    const sub = quoteRide({ miles: 5, minutes: 20, feeMode: 'subscription' });
    expect(sub.softwareFeeCents).toBe(0);
    expect(sub.driverNetCents).toBe(sub.suggestedCents);
  });
});

describe('validate', () => {
  test('valid when above floor and fee fits', () => {
    expect(validateQuote({ priceCents: 2500, floorCents: 2000, softwareFeeCents: 108 }).valid).toBe(true);
  });

  test('below floor flagged', () => {
    expect(validateQuote({ priceCents: 1500, floorCents: 2000, softwareFeeCents: 50 }).errors)
      .toContain('below_floor');
  });

  test('fee exceeding (price - floor) flagged', () => {
    expect(validateQuote({ priceCents: 2050, floorCents: 2000, softwareFeeCents: 100 }).errors)
      .toContain('fee_exceeds_budget');
  });
});

describe('orchestrator (quoteRide)', () => {
  test('typical NYC ride yields a valid, well-formed quote', () => {
    const q = quoteRide({ miles: 5, minutes: 20, openRequests: 1, availableDrivers: 1 });
    expect(q.floorCents).toBe(2004);
    expect(q.baseRateCents).toBe(2250);
    expect(q.surgeMultiplier).toBe(1);
    expect(q.suggestedCents).toBe(2250);
    expect(q.driverNetCents).toBe(q.suggestedCents - q.softwareFeeCents);
    expect(q.validation.valid).toBe(true);
  });

  test('surge lifts the suggested price', () => {
    const calm = quoteRide({ miles: 5, minutes: 20, openRequests: 1, availableDrivers: 1 });
    const busy = quoteRide({ miles: 5, minutes: 20, openRequests: 4, availableDrivers: 1 });
    expect(busy.surgeMultiplier).toBeGreaterThan(1);
    expect(busy.suggestedCents).toBeGreaterThan(calm.suggestedCents);
  });
});

describe('reverse-auction headline offers', () => {
  const { pickHeadlineOffers } = require('../services/chauffeurMatch');

  test('empty -> nulls', () => {
    expect(pickHeadlineOffers([])).toEqual({ cheapestId: null, fastestId: null });
  });

  test('picks lowest price and lowest ETA', () => {
    const offers = [
      { _id: 'a', priceCents: 2500, etaMinutes: 9 },
      { _id: 'b', priceCents: 2100, etaMinutes: 6 }, // cheapest AND fastest
      { _id: 'c', priceCents: 2300, etaMinutes: 7 },
    ];
    expect(pickHeadlineOffers(offers)).toEqual({ cheapestId: 'b', fastestId: 'b' });
  });

  test('cheapest and fastest can be different drivers', () => {
    const offers = [
      { _id: 'a', priceCents: 1900, etaMinutes: 12 }, // cheapest
      { _id: 'b', priceCents: 2600, etaMinutes: 3 },  // fastest
    ];
    expect(pickHeadlineOffers(offers)).toEqual({ cheapestId: 'a', fastestId: 'b' });
  });

  test('ignores non-offered statuses', () => {
    const offers = [
      { _id: 'a', priceCents: 1800, etaMinutes: 5, status: 'rejected' },
      { _id: 'b', priceCents: 2200, etaMinutes: 8, status: 'offered' },
    ];
    expect(pickHeadlineOffers(offers)).toEqual({ cheapestId: 'b', fastestId: 'b' });
  });
});

describe('async quote service + reference signal', () => {
  const { getRideQuote } = require('../services/chauffeurQuoteService');

  test('reference is null when disabled; price is our own equation', async () => {
    const q = await getRideQuote({ miles: 5, minutes: 20, openRequests: 1, availableDrivers: 1 });
    expect(q.referenceCompetitorCents).toBeNull();
    expect(q.suggestedCents).toBe(2250);
    expect(q.validation.valid).toBe(true);
  });

  test('a live reference is attached but does NOT change the price', async () => {
    const cfg = require('../config/chauffeurPricing');
    const ref = require('../services/chauffeurReference');
    const origEnabled = cfg.reference.enabled;
    const origFetch = ref.fetchScrapedEstimateCents;
    try {
      cfg.reference.enabled = true;
      ref.fetchScrapedEstimateCents = async () => 3000; // live Uber = $30.00
      const q = await getRideQuote({ miles: 5, minutes: 20, openRequests: 1, availableDrivers: 1 });
      expect(q.referenceCompetitorCents).toBe(3000); // captured for data/display
      expect(q.suggestedCents).toBe(2250);           // price unaffected by reference
    } finally {
      cfg.reference.enabled = origEnabled;
      ref.fetchScrapedEstimateCents = origFetch;
      ref._cache.clear();
    }
  });
});
