import { positive } from '../config.mjs';
import { field } from '../http.mjs';
import { check, fail, pass, warn, when } from '../result.mjs';

export const validOffer = (offer) => offer.active === true && offer.blacklisted === false;
const validRows = (offers) => offers.rows.filter(validOffer);

export function checkMarket(sources, selection) {
  const run = (id, evaluate, subject = null) => check(`market.${id}`, subject, evaluate);
  const listed = field(sources.models, 'listed');
  const catalog = field(sources.models, 'catalog');
  const offers = sources.offers;
  const selected = new Map(selection.map((value) => [value.toLowerCase(), value]));
  const seen = new Set();
  const results = [
    run('models.listed', () => when(listed, (rows) => rows.length ? pass({ models: rows.length }) : fail('empty_catalog', { models: 0 }))),
    run('offers.present', () => when(offers, (page) => {
      const valid = validRows(page);
      const evidence = { valid_offers: valid.length, expiry: valid.map((offer) => offer.expiry), truncated: page.truncated };
      return valid.length ? pass(evidence) : fail('no_valid_offers', evidence);
    })),
    run('catalog_offer_overlap', () => when(catalog, (rows) => when(offers, (page) => {
      const valid = new Set(validRows(page).map((offer) => offer.modelHash.toLowerCase()));
      const matched = rows.filter((model) => valid.has(model.hash.data.toLowerCase())).length;
      const evidence = { models: rows.length, matched, truncated: page.truncated };
      if (matched === rows.length) return pass(evidence);
      if (matched) return warn('partial', evidence);
      return page.truncated ? warn('disjoint_truncated', evidence) : fail('disjoint', evidence);
    }))),
    run('faucet.cap', () => when(field(sources.limits, 'cap'), (cap) => positive(cap) ?
      pass({ remaining_flop: cap }) : warn('cap_exhausted', { remaining_flop: cap }))),
    run('sponsor.slots', () => when(field(sources.limits, 'sponsor'), ({ open, uncalibrated, max }) => {
      const evidence = { open, uncalibrated, max };
      return !open ? warn('closed', evidence) : uncalibrated >= max ? warn('full', evidence) : pass(evidence);
    })),
  ];

  for (const model of listed.ok ? listed.data : []) {
    if (model.id === null) continue;
    const hash = model.hash.data?.toLowerCase();
    const keys = [model.id.toLowerCase(), hash].filter(Boolean);
    const explicit = keys.some((key) => selected.has(key));
    for (const key of keys) seen.add(key);
    results.push(
      run('model.has_offer', () => when(model.hash, (originalHash) => when(offers, (page) => {
        const matched = validRows(page).filter((offer) => offer.modelHash.toLowerCase() === hash);
        const evidence = { model_hash: originalHash, valid_offers: matched.length,
          expiry: matched.map((offer) => offer.expiry), truncated: page.truncated };
        if (matched.length) return pass(evidence);
        if (!explicit) return warn('no_offer', evidence);
        return page.truncated ? warn('no_offer_truncated', evidence) : fail('no_offer', evidence);
      })), model.id),
      run('model.capacity', () => when(model.capacity, (evidence) => {
        if (positive(evidence.capacity_tpm) && evidence.price_sources) return pass(evidence);
        return explicit ? fail('no_capacity', evidence) : warn('no_capacity', evidence);
      }), model.id),
    );
  }
  for (const [key, subject] of selected) {
    if (!seen.has(key)) results.push(run('model.has_offer', () => when(catalog, () => fail('not_in_catalog')), subject));
  }
  return results;
}
