const fs = require("node:fs");
const path = require("node:path");

const ALLOWED_TYPES = Object.freeze(["emergency_veterinary", "grooming", "boarding", "training", "dog_swimming_official", "dog_swimming_community", "dog_forest"]);
const ALLOWED_SOURCE_TYPES = Object.freeze(["business", "official", "municipality"]);
const ALLOWED_VERIFICATION_STATUSES = Object.freeze(["unverified", "source_confirmed", "needs_review", "expired"]);
const REVIEW_INTERVAL_DAYS = Object.freeze({ emergency: 30, openingHours: 90, existence: 180 });
const DAY_KEYS = Object.freeze(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
const EMERGENCY_LEVELS = Object.freeze(["24_7", "night", "weekend", "limited_hours", "municipal_on_call"]);
const BUSINESS_TYPES = Object.freeze(["salon", "clinic", "pet_store", "mobile", "training", "boarding", "swimming_place", "dog_forest"]);
const SERVICE_SCOPES = Object.freeze(["local", "regional", "destination"]);
const VERIFICATION_LEVELS = Object.freeze(["official", "verified", "community_verified", "pending"]);
const RECORD_STATUSES = Object.freeze(["active", "temporarily_closed", "permanently_closed", "pending_review"]);
const DEFAULT_DATA_FILE = path.resolve(__dirname, "..", "data", "dog-services-tampere.json");

function normalizeText(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizePhone(value) {
  if (!value) return null;
  const phone = String(value).replace(/[^+\d]/g, "");
  return phone || null;
}

function websiteDomain(value) {
  if (!value) return null;
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); }
  catch (_) { return null; }
}

function websiteIdentity(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.hostname.toLowerCase().replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "").toLowerCase() || "/"}`;
  } catch (_) { return null; }
}

function validHttpUrl(value) {
  if (value === null || value === undefined || value === "") return true;
  try { return ["http:", "https:"].includes(new URL(value).protocol); }
  catch (_) { return false; }
}

function validIsoDate(value, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validTimeZone(value) {
  try { new Intl.DateTimeFormat("fi-FI", { timeZone: value }).format(); return typeof value === "string" && Boolean(value); }
  catch (_) { return false; }
}

function validIntervals(intervals) {
  return Array.isArray(intervals) && intervals.every(function(interval) {
    if (typeof interval === "string") return /^([01]?\d|2[0-3]):[0-5]\d\s*[-–]\s*(?:(?:[01]?\d|2[0-3]):[0-5]\d|24:00)$/.test(interval);
    return interval && typeof interval === "object" && typeof (interval.open || interval.start) === "string" && typeof (interval.close || interval.end) === "string";
  });
}

function validWeeklyHours(value) {
  return value === null || (value && typeof value === "object" && DAY_KEYS.every(function(day) { return validIntervals(value[day]); }));
}

function validSpecialHours(value) {
  return Array.isArray(value) && value.every(function(item) {
    return item && validIsoDate(item.date) && (item.closed === true || validIntervals(item.intervals));
  });
}

function validateRecord(record, index = 0) {
  const errors = [];
  const prefix = `Tietue ${index + 1}`;
  if (!record || typeof record !== "object" || Array.isArray(record)) return [`${prefix}: tietue ei ole objekti`];
  if (typeof record.id !== "string" || !record.id.trim()) errors.push(`${prefix}: id puuttuu`);
  if (!ALLOWED_TYPES.includes(record.type)) errors.push(`${prefix}: type ei ole sallittu`);
  if (typeof record.name !== "string" || !record.name.trim()) errors.push(`${prefix}: nimi puuttuu`);
  const coordinatesRequired = record.isPublished === true;
  if ((coordinatesRequired || record.latitude !== null) && (!Number.isFinite(record.latitude) || record.latitude < -90 || record.latitude > 90)) errors.push(`${prefix}: latitude ei ole kelvollinen`);
  if ((coordinatesRequired || record.longitude !== null) && (!Number.isFinite(record.longitude) || record.longitude < -180 || record.longitude > 180)) errors.push(`${prefix}: longitude ei ole kelvollinen`);
  if (typeof record.countryCode !== "string" || !/^[A-Za-z]{2}$/.test(record.countryCode)) errors.push(`${prefix}: countryCode ei ole kaksikirjaiminen`);
  if (!ALLOWED_SOURCE_TYPES.includes(record.sourceType)) errors.push(`${prefix}: sourceType ei ole sallittu`);
  if (!validHttpUrl(record.sourceUrl)) errors.push(`${prefix}: sourceUrl ei ole HTTP/HTTPS-osoite`);
  if (!validHttpUrl(record.website)) errors.push(`${prefix}: website ei ole HTTP/HTTPS-osoite`);
  if (!ALLOWED_VERIFICATION_STATUSES.includes(record.verificationStatus)) errors.push(`${prefix}: verificationStatus ei ole sallittu`);
  if (!validIsoDate(record.lastCheckedAt)) errors.push(`${prefix}: lastCheckedAt ei ole ISO-päivä`);
  if (!validIsoDate(record.nextReviewAt, true)) errors.push(`${prefix}: nextReviewAt ei ole ISO-päivä tai null`);
  if (!validTimeZone(record.timeZone)) errors.push(`${prefix}: timeZone ei ole kelvollinen`);
  if (!BUSINESS_TYPES.includes(record.businessType)) errors.push(`${prefix}: businessType ei ole sallittu`);
  if (typeof record.isPhysicalLocation !== "boolean") errors.push(`${prefix}: isPhysicalLocation ei ole boolean`);
  if (!validWeeklyHours(record.weeklyHours)) errors.push(`${prefix}: weeklyHours ei ole kelvollinen`);
  if (!validSpecialHours(record.specialHours)) errors.push(`${prefix}: specialHours ei ole kelvollinen`);
  if (record.emergency === true && !EMERGENCY_LEVELS.includes(record.emergencyLevel)) errors.push(`${prefix}: emergencyLevel ei ole sallittu`);
  if (record.emergencyHours !== undefined && record.emergencyHours !== null
    && (!validWeeklyHours(record.emergencyHours.weeklyHours || record.emergencyHours)
      || !validSpecialHours(record.emergencyHours.specialHours || []))) errors.push(`${prefix}: emergencyHours ei ole kelvollinen`);
  if (record.callBeforeArrival !== undefined && typeof record.callBeforeArrival !== "boolean") errors.push(`${prefix}: callBeforeArrival ei ole boolean`);
  if (typeof record.isPublished !== "boolean") errors.push(`${prefix}: isPublished ei ole boolean`);
  if (record.serviceScope !== undefined && !SERVICE_SCOPES.includes(record.serviceScope)) errors.push(`${prefix}: serviceScope ei ole sallittu`);
  if (record.verificationLevel !== undefined && !VERIFICATION_LEVELS.includes(record.verificationLevel)) errors.push(`${prefix}: verificationLevel ei ole sallittu`);
  if (record.status !== undefined && !RECORD_STATUSES.includes(record.status)) errors.push(`${prefix}: status ei ole sallittu`);
  if (record.lastVerifiedBy !== undefined && record.lastVerifiedBy !== "zyke") errors.push(`${prefix}: lastVerifiedBy ei ole zyke`);
  if (record.secondarySources !== undefined && (!Array.isArray(record.secondarySources) || !record.secondarySources.every(function(source) {
    return source && typeof source.sourceName === "string" && validHttpUrl(source.sourceUrl);
  }))) errors.push(`${prefix}: secondarySources ei ole kelvollinen`);
  if (record.priceInfo !== undefined && record.priceInfo !== null) errors.push(`${prefix}: priceInfo pitÃ¤Ã¤ olla ensimmÃ¤isessÃ¤ versiossa null`);
  if (record.bookingUrl !== undefined && record.bookingUrl !== null && !validHttpUrl(record.bookingUrl)) errors.push(`${prefix}: bookingUrl ei ole kelvollinen`);
  if (record.supportsOnlineBooking !== undefined && typeof record.supportsOnlineBooking !== "boolean") errors.push(`${prefix}: supportsOnlineBooking ei ole boolean`);
  if ((record.images !== undefined && !Array.isArray(record.images)) || (record.socialLinks !== undefined && !Array.isArray(record.socialLinks)) || (record.accessibility !== undefined && (!record.accessibility || typeof record.accessibility !== "object" || Array.isArray(record.accessibility)))) errors.push(`${prefix}: tulevien ominaisuuksien kentÃ¤t eivÃ¤t ole kelvollisia`);
  if (record.isPublished && (!record.sourceName || !record.lastCheckedAt || record.verificationStatus !== "source_confirmed")) {
    errors.push(`${prefix}: julkaistu kohde vaatii vahvistetun lähteen ja tarkistuspäivän`);
  }
  if (record.isPublished && (record.verificationLevel === "pending" || record.status === "pending_review")) errors.push(`${prefix}: keskenerÃ¤istÃ¤ kohdetta ei voi julkaista`);
  return errors;
}

function distanceMeters(a, b) {
  const radians = Math.PI / 180;
  const lat1 = a.latitude * radians;
  const lat2 = b.latitude * radians;
  const dLat = (b.latitude - a.latitude) * radians;
  const dLng = (b.longitude - a.longitude) * radians;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const value = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function duplicateReasons(a, b) {
  const reasons = [];
  if (a.id && b.id && a.id === b.id) reasons.push("same_id");
  const name = normalizeText(a.name);
  const address = normalizeText(a.address);
  if (name && address && name === normalizeText(b.name) && address === normalizeText(b.address)) reasons.push("same_name_address");
  const phone = normalizePhone(a.phone);
  if (phone && phone === normalizePhone(b.phone)) reasons.push("same_phone");
  const website = websiteIdentity(a.website);
  if (website && website === websiteIdentity(b.website)) reasons.push("same_website");
  if (a.type === b.type && [a.latitude, a.longitude, b.latitude, b.longitude].every(Number.isFinite) && distanceMeters(a, b) < 50) reasons.push("nearby_same_type");
  return reasons;
}

function findDuplicates(records) {
  const duplicates = [];
  for (let left = 0; left < records.length; left += 1) {
    for (let right = left + 1; right < records.length; right += 1) {
      const reasons = duplicateReasons(records[left], records[right]);
      if (reasons.length) duplicates.push({ firstId: records[left].id || null, secondId: records[right].id || null, reasons });
    }
  }
  return duplicates;
}

function validateRegistry(records) {
  if (!Array.isArray(records)) return { valid: false, errors: ["Rekisterin juuren pitää olla lista"], duplicates: [] };
  const errors = records.flatMap(validateRecord);
  const idCounts = new Map();
  records.forEach(function(record) { if (record?.id) idCounts.set(record.id, (idCounts.get(record.id) || 0) + 1); });
  idCounts.forEach(function(count, id) { if (count > 1) errors.push(`id ei ole yksilöllinen: ${id}`); });
  return { valid: errors.length === 0, errors, duplicates: findDuplicates(records) };
}

function normalizeRegistryPlace(record) {
  const categories = { emergency_veterinary: "health", grooming: "care", boarding: "care", training: "activity", dog_swimming_official: "outdoors", dog_swimming_community: "outdoors", dog_forest: "outdoors" };
  return {
    id: record.id, type: record.type, category: categories[record.type], subtype: null,
    name: record.name.trim(), latitude: record.latitude, longitude: record.longitude, address: record.address || null,
    postalCode: record.postalCode || null, municipality: record.municipality || null, region: record.region || null,
    countryCode: record.countryCode.toUpperCase(), countryName: record.countryName || null, phone: record.phone || null,
    website: record.website || null, openingHours: record.openingHours || null, emergency: record.emergency === true,
    timeZone: record.timeZone, weeklyHours: record.weeklyHours, specialHours: record.specialHours,
    openingHoursText: record.openingHoursText || null, emergencyLevel: record.emergencyLevel || null,
    emergencyHours: record.emergencyHours || null, callBeforeArrival: record.callBeforeArrival === true,
    emergencyPhone: record.emergencyPhone || null,
    businessType: record.businessType, isPhysicalLocation: record.isPhysicalLocation === true,
    sourceType: record.sourceType, sourceName: record.sourceName || null, sourceUrl: record.sourceUrl || null,
    sourceId: record.id, verificationStatus: record.verificationStatus, lastCheckedAt: record.lastCheckedAt,
    nextReviewAt: record.nextReviewAt || null, isPublished: record.isPublished === true,
    serviceScope: record.serviceScope, verificationLevel: record.verificationLevel, lastVerifiedBy: record.lastVerifiedBy,
    status: record.status, secondarySources: record.secondarySources, serviceDetails: record.serviceDetails || {},
    priceInfo: record.priceInfo, bookingUrl: record.bookingUrl, supportsOnlineBooking: record.supportsOnlineBooking,
    images: record.images, socialLinks: record.socialLinks, accessibility: record.accessibility, tags: {}
  };
}

function mergeRegistryAndOsm(registryItems, osmItems) {
  const published = registryItems.filter(function(item) { return item.isPublished && item.verificationStatus === "source_confirmed"; });
  const merged = published.slice();
  osmItems.forEach(function(osmItem) {
    const duplicate = published.some(function(registryItem) { return duplicateReasons(registryItem, osmItem).length > 0; });
    if (!duplicate) merged.push(osmItem);
  });
  return merged;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function staleChecks(record, now = new Date()) {
  if (!validIsoDate(record.lastCheckedAt)) return ["lastCheckedAt_missing"];
  const checks = [{ field: "existence", days: REVIEW_INTERVAL_DAYS.existence }];
  if (record.emergency || record.type === "emergency_veterinary") checks.push({ field: "emergency", days: REVIEW_INTERVAL_DAYS.emergency });
  if (record.openingHours || record.openingHoursText || record.weeklyHours) checks.push({ field: "openingHours", days: REVIEW_INTERVAL_DAYS.openingHours });
  const stale = checks.filter(function(check) { return addDays(record.lastCheckedAt, check.days) < now; }).map(function(check) { return check.field; });
  if (record.nextReviewAt && validIsoDate(record.nextReviewAt, true) && new Date(`${record.nextReviewAt}T00:00:00Z`) < now) stale.push("nextReviewAt");
  return stale;
}

function readRegistry(filePath = DEFAULT_DATA_FILE) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

module.exports = {
  ALLOWED_TYPES, ALLOWED_SOURCE_TYPES, ALLOWED_VERIFICATION_STATUSES, REVIEW_INTERVAL_DAYS, DAY_KEYS, EMERGENCY_LEVELS, BUSINESS_TYPES,
  SERVICE_SCOPES, VERIFICATION_LEVELS, RECORD_STATUSES, DEFAULT_DATA_FILE,
  normalizeText, normalizePhone, websiteDomain, validateRecord, validateRegistry, duplicateReasons, findDuplicates,
  normalizeRegistryPlace, mergeRegistryAndOsm, staleChecks, readRegistry
};
