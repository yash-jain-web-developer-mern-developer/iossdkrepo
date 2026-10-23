// Tax on invoices: a deliberately small, explicit mechanism. It is NOT tax advice; rates and rules come from configuration.
// Model ("inclusive"): everything an advertiser pays is gross. The invoice shows the net amount and the tax contained in it,
// computed at the buyer country's rate. Reverse charge (B2B sale abroad with a tax id) is optional and shows 0% with a note.
// All arithmetic is in integer micro-dollars.

export function taxFor(cfg, buyer = {}) {
  if (cfg.taxMode === 'none') return { rateBp: 0, label: null, note: null };
  const seller = cfg.taxSeller || {}, country = String(buyer.country || '').toUpperCase(), label = cfg.taxLabel || 'VAT';
  if (cfg.taxReverseCharge && buyer.taxId && country && seller.country && country !== seller.country) {
    return { rateBp: 0, label, note: `Reverse charge: the buyer (${buyer.taxId}) accounts for ${label} on this supply.` };
  }
  const rates = cfg.taxRates || {};
  const pct = Object.prototype.hasOwnProperty.call(rates, country) ? rates[country] : (rates.DEFAULT ?? 0);
  return { rateBp: Math.round(pct * 100), label, note: pct === 0 ? `No ${label} charged for ${country || 'this buyer country'}.` : null };
}

// gross -> { net, tax } with tax = gross * rate / (100 + rate), rounded to the nearest micro; net is the remainder so net + tax === gross.
export function splitInclusive(grossMicros, rateBp) {
  const tax = Math.round((grossMicros * rateBp) / (10000 + rateBp));
  return { netMicros: grossMicros - tax, taxMicros: tax };
}

export const sanitizeProfile = (b = {}) => {
  const legalName = String(b.legalName || '').trim().slice(0, 120), address = String(b.address || '').trim().slice(0, 300), country = String(b.country || '').trim().toUpperCase(), taxId = String(b.taxId || '').trim().slice(0, 40);
  const errors = [];
  if (!legalName) errors.push('legalName is required');
  if (address.length < 5) errors.push('address is required (street, city, postcode)');
  if (!/^[A-Z]{2}$/.test(country)) errors.push('country must be a 2-letter code like GB or IN');
  if (taxId && !/^[A-Za-z0-9][A-Za-z0-9 .\-/]{2,39}$/.test(taxId)) errors.push('taxId may contain only letters, digits, spaces and . - /');
  return { legalName, address, country, taxId, errors };
};
