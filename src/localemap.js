'use strict';
/**
 * Map ISO country code to a likely browser locale.
 * Used when profile.locale is 'auto' (follow proxy region).
 */
const COUNTRY_LOCALE = {
  US: 'en-US', GB: 'en-GB', CA: 'en-CA', AU: 'en-AU', NZ: 'en-NZ', IE: 'en-IE',
  CN: 'zh-CN', TW: 'zh-TW', HK: 'zh-HK',
  JP: 'ja-JP', KR: 'ko-KR',
  DE: 'de-DE', FR: 'fr-FR', ES: 'es-ES', IT: 'it-IT', PT: 'pt-PT', BR: 'pt-BR',
  NL: 'nl-NL', SE: 'sv-SE', NO: 'nb-NO', DK: 'da-DK', FI: 'fi-FI',
  PL: 'pl-PL', RU: 'ru-RU', UA: 'uk-UA', TR: 'tr-TR',
  IN: 'en-IN', SG: 'en-SG', MY: 'ms-MY', TH: 'th-TH', VN: 'vi-VN', ID: 'id-ID', PH: 'en-PH',
  MX: 'es-MX', AR: 'es-AR', CL: 'es-CL', CO: 'es-CO',
  AE: 'ar-AE', SA: 'ar-SA', EG: 'ar-EG', IL: 'he-IL',
  ZA: 'en-ZA', NG: 'en-NG',
};

function localeForCountry(countryCode) {
  if (!countryCode) return null;
  return COUNTRY_LOCALE[countryCode.toUpperCase()] || null;
}

module.exports = { localeForCountry, COUNTRY_LOCALE };
