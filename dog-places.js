const {
  readRegistry, validateRegistry, normalizeRegistryPlace, mergeRegistryAndOsm
} = require("../scripts/dog-services-registry.cjs");

const OVERPASS_URLS = Object.freeze([
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
]);
const CACHE_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 90000;
const MAX_BBOX_AREA = 0.35;
const MAX_BBOX_SPAN = 1;

const CATEGORY_DEFINITIONS = Object.freeze({
  veterinary: { type: "veterinary", category: "health", filters: ['["amenity"="veterinary"]'] },
  emergency_veterinary: {
    type: "emergency_veterinary", category: "health", emergency: true,
    filters: [
      '["amenity"="veterinary"]["emergency"="yes"]',
      '["amenity"="veterinary"]["emergency"="24/7"]',
      '["amenity"="veterinary"]["veterinary:emergency"="yes"]',
      '["amenity"="veterinary"]["healthcare:speciality"~"(^|;)emergency(;|$)",i]'
    ]
  },
  pet_shop: { type: "pet_shop", category: "retail", filters: ['["shop"="pet"]'] },
  grooming: { type: "grooming", category: "care", filters: ['["shop"="pet_grooming"]'] },
  boarding: { type: "boarding", category: "care", filters: ['["amenity"="animal_boarding"]'] },
  training: { type: "training", category: "activity", filters: ['["amenity"="animal_training"]'] }
});

const cache = new Map();

function parseBbox(value) {
  if (typeof value !== "string") return null;
  const parts = value.split(",").map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return null;
  const [south, west, north, east] = parts;
  if (south < -90 || north > 90 || west < -180 || east > 180 || south >= north || west >= east) return null;
  if (north - south > MAX_BBOX_SPAN || east - west > MAX_BBOX_SPAN) return null;
  if ((north - south) * (east - west) > MAX_BBOX_AREA) return null;
  return { south, west, north, east, value: parts.join(",") };
}

function buildOverpassQuery(category, bbox) {
  const definition = CATEGORY_DEFINITIONS[category];
  if (!definition) return null;
  const selectors = definition.filters.map(function(filter) { return `nwr${filter}(${bbox.value});`; }).join("");
  return `[out:json][timeout:20];(${selectors});out tags center;`;
}

function firstTag(tags, keys) {
  for (const key of keys) {
    if (typeof tags[key] === "string" && tags[key].trim()) return tags[key].trim();
  }
  return null;
}

function emergencyFromTags(tags) {
  const emergency = String(tags.emergency || "").toLowerCase();
  const veterinaryEmergency = String(tags["veterinary:emergency"] || "").toLowerCase();
  const speciality = String(tags["healthcare:speciality"] || "").toLowerCase().split(";");
  return emergency === "yes" || emergency === "24/7" || veterinaryEmergency === "yes" || speciality.includes("emergency");
}

function addressFromTags(tags) {
  const street = firstTag(tags, ["addr:street", "addr:place"]);
  const houseNumber = firstTag(tags, ["addr:housenumber"]);
  const postcode = firstTag(tags, ["addr:postcode"]);
  const city = firstTag(tags, ["addr:city", "addr:municipality"]);
  const firstLine = [street, houseNumber].filter(Boolean).join(" ");
  const secondLine = [postcode, city].filter(Boolean).join(" ");
  return [firstLine, secondLine].filter(Boolean).join(", ") || null;
}

function normalizeElement(element, requestedCategory) {
  if (!element || !["node", "way", "relation"].includes(element.type)) return null;
  const latitude = element.type === "node" ? element.lat : element.center?.lat;
  const longitude = element.type === "node" ? element.lon : element.center?.lon;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const tags = element.tags && typeof element.tags === "object" ? element.tags : {};
  const definition = CATEGORY_DEFINITIONS[requestedCategory];
  const emergency = emergencyFromTags(tags);
  const emergencyTag = String(tags.emergency || "").toLowerCase();
  const veterinaryEmergencyTag = String(tags["veterinary:emergency"] || "").toLowerCase();
  if (requestedCategory === "emergency_veterinary" && !emergency) return null;
  return {
    id: `osm:${element.type}:${element.id}`,
    type: definition.type,
    category: definition.category,
    subtype: firstTag(tags, ["animal_boarding", "animal_training", "pet"]),
    name: firstTag(tags, ["name", "brand", "operator"]),
    latitude,
    longitude,
    address: addressFromTags(tags),
    municipality: firstTag(tags, ["addr:city", "addr:municipality"]),
    region: firstTag(tags, ["addr:state", "addr:region"]),
    countryCode: firstTag(tags, ["addr:country"]),
    countryName: null,
    phone: firstTag(tags, ["contact:phone", "phone"]),
    website: firstTag(tags, ["contact:website", "website"]),
    openingHours: firstTag(tags, ["opening_hours"]),
    emergency,
    timeZone: firstTag(tags, ["timezone"]),
    weeklyHours: null,
    specialHours: [],
    openingHoursText: firstTag(tags, ["opening_hours"]),
    emergencyLevel: emergencyTag === "24/7" || veterinaryEmergencyTag === "24/7" ? "24_7" : emergency ? "limited_hours" : null,
    emergencyHours: null,
    emergencyOpeningHours: firstTag(tags, ["emergency:opening_hours", "opening_hours:emergency"]),
    callBeforeArrival: ["yes", "true", "1"].includes(String(tags["emergency:call_before_arrival"] || "").toLowerCase()),
    emergencyPhone: firstTag(tags, ["emergency:phone", "contact:emergency"]),
    sourceType: "openstreetmap",
    sourceName: "OpenStreetMap contributors",
    sourceId: `${element.type}/${element.id}`,
    tags
  };
}

function normalizeOverpassResponse(data, category) {
  if (!data || !Array.isArray(data.elements)) throw new Error("Overpass-vastaus ei sisällä elements-listaa");
  const unique = new Map();
  data.elements.forEach(function(element) {
    const place = normalizeElement(element, category);
    if (place && !unique.has(place.sourceId)) unique.set(place.sourceId, place);
  });
  return Array.from(unique.values());
}

function registryPlaces(category, bbox, registryReader = readRegistry) {
  const records = registryReader();
  const validation = validateRegistry(records);
  if (!validation.valid) throw new Error(`Zyke-rekisteri ei läpäissyt validointia: ${validation.errors.join("; ")}`);
  return records.filter(function(record) {
    return record.type === category && record.isPublished === true && record.verificationStatus === "source_confirmed"
      && record.isPhysicalLocation === true
      && record.latitude >= bbox.south && record.latitude <= bbox.north
      && record.longitude >= bbox.west && record.longitude <= bbox.east;
  }).map(normalizeRegistryPlace);
}

async function fetchPlaces(category, bbox, fetchImpl = fetch) {
  const key = `${category}:${bbox.value}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.savedAt < CACHE_MS) return cached.data;
  const controllers = OVERPASS_URLS.map(function() { return new AbortController(); });
  const timeout = setTimeout(function() { controllers.forEach(function(controller) { controller.abort(); }); }, REQUEST_TIMEOUT_MS);
  try {
    const places = await Promise.any(OVERPASS_URLS.map(async function(overpassUrl, index) {
      const controller = controllers[index];
      const response = await fetchImpl(overpassUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          "user-agent": "KaupunginSyke/1.0 (OpenStreetMap place lookup)"
        },
        body: new URLSearchParams({ data: buildOverpassQuery(category, bbox) }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Overpass vastasi tilakoodilla ${response.status}`);
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("json")) throw new Error("Overpass ei palauttanut JSON-dataa");
      return normalizeOverpassResponse(await response.json(), category);
    }));
    controllers.forEach(function(controller) { controller.abort(); });
    cache.set(key, { savedAt: Date.now(), data: places });
    return places;
  } catch (error) {
    const reasons = error instanceof AggregateError ? error.errors : [error];
    throw reasons.find(function(reason) { return reason?.name !== "AbortError"; }) || reasons[0] || error;
  } finally {
    clearTimeout(timeout);
  }
}

function createDogPlacesHandler(placeFetcher = fetchPlaces, registryFetcher = registryPlaces) {
  return function dogPlacesHandler(req, res) {
    const category = String(req.query.category || "");
    const bbox = parseBbox(req.query.bbox);
    if (!CATEGORY_DEFINITIONS[category]) return res.status(400).json({ error: "Tuntematon koirapalvelukategoria" });
    if (!bbox) return res.status(400).json({ error: "Virheellinen tai liian suuri bbox" });
    return Promise.allSettled([
      Promise.resolve().then(function() { return registryFetcher(category, bbox); }),
      placeFetcher(category, bbox)
    ]).then(function(results) {
      const registryResult = results[0];
      const osmResult = results[1];
      if (registryResult.status === "rejected") console.error("Zyke-koirapalvelurekisterin luku epäonnistui:", registryResult.reason);
      if (osmResult.status === "rejected") console.error("OpenStreetMap-koirapalvelujen haku epäonnistui:", osmResult.reason);
      if (registryResult.status === "rejected" && osmResult.status === "rejected") {
        return res.status(502).json({ error: "Koirapalvelutietoja ei voitu hakea" });
      }
      const registryItems = registryResult.status === "fulfilled" ? registryResult.value : [];
      const osmItems = osmResult.status === "fulfilled" ? osmResult.value : [];
      return res.json({ items: mergeRegistryAndOsm(registryItems, osmItems) });
    });
  };
}

const dogPlacesHandler = createDogPlacesHandler();

module.exports = { CATEGORY_DEFINITIONS, parseBbox, buildOverpassQuery, normalizeElement, normalizeOverpassResponse, registryPlaces, fetchPlaces, createDogPlacesHandler, dogPlacesHandler };
