/**
 * Reverse-auction matching helpers (pure, testable).
 *
 * The rider sees two headline offers — the CHEAPEST and the FASTEST (shortest
 * ETA to the pickup) — plus the full list ("more drivers"). Ties break by the
 * other dimension (cheapest ties on lower ETA; fastest ties on lower price).
 */

/**
 * @param {Array<{_id:any, priceCents:number, etaMinutes:number, status?:string}>} offers
 * @returns {{cheapestId:string|null, fastestId:string|null}}
 */
function pickHeadlineOffers(offers = []) {
  const open = offers.filter((o) => !o.status || o.status === 'offered');
  if (open.length === 0) return { cheapestId: null, fastestId: null };

  let cheapest = open[0];
  let fastest = open[0];

  for (const o of open) {
    const eta = o.etaMinutes ?? Infinity;
    const cEta = cheapest.etaMinutes ?? Infinity;
    const fEta = fastest.etaMinutes ?? Infinity;

    if (o.priceCents < cheapest.priceCents ||
        (o.priceCents === cheapest.priceCents && eta < cEta)) {
      cheapest = o;
    }
    if (eta < fEta ||
        (eta === fEta && o.priceCents < fastest.priceCents)) {
      fastest = o;
    }
  }

  return { cheapestId: String(cheapest._id), fastestId: String(fastest._id) };
}

module.exports = { pickHeadlineOffers };
