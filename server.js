const express = require("express");
const cors = require("cors");
const { dogPlacesHandler } = require("./dog-places");

const app = express();

const DOG_PARKS_URL = "https://geodata.tampere.fi/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature&outputFormat=json&typeName=locus%3Alocus_t_RpaParkPart_Polygon_koirapuisto_gsview";
const DOG_BINS_URL = "https://geodata.tampere.fi/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature&outputFormat=json&typeName=locus%3Av_RpaEquipment_JATE_point_gsview";
const DOG_DATA_CACHE_MS = 15 * 60 * 1000;
const dogDataCache = new Map();

async function fetchGeoJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`WFS vastasi tilakoodilla ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("json")) {
      throw new Error("WFS ei palauttanut GeoJSON-dataa");
    }
    const data = await response.json();
    if (data.type !== "FeatureCollection" || !Array.isArray(data.features)) {
      throw new Error("WFS-vastaus ei ole kelvollinen FeatureCollection");
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function getCachedGeoJson(cacheKey, url) {
  const cached = dogDataCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < DOG_DATA_CACHE_MS) {
    return cached.data;
  }

  const data = await fetchGeoJson(url);
  dogDataCache.set(cacheKey, { savedAt: Date.now(), data });
  return data;
}

app.use(cors());
app.use(express.json());


// Palvelun terveystarkistus
app.get("/", (req, res) => {
  res.send("KaupunginSyke API toimii");
});


// Tapahtumat API
app.get("/api/tapahtumat", async (req, res) => {

  try {

    const vastaus = await fetch(
      "https://tapahtumat.tampere.fi/api/collection/634844c32f41a024ee51a234/content?lang=fi&country=FI&e=24.02&n=61.71&s=61.36&w=23.54&sort=startDate"
    );


    if (!vastaus.ok) {
      throw new Error(`Tapahtuma-API vastasi tilakoodilla ${vastaus.status}`);
    }

    const data = await vastaus.json();


    res.json(data);


  } catch (error) {

    console.error("Tapahtuma API virhe:", error);

    res.status(500).json({
      error: "Virhe tapahtumien haussa"
    });

  }

});

// Tampereen viralliset koirapuistot. GeoJSON palautetaan alkuperäisessä
// EPSG:3878-muodossa; selain muuntaa koordinaatit Leafletille.
app.get("/api/koirapuistot", async (req, res) => {
  try {
    res.json(await getCachedGeoJson("parks", DOG_PARKS_URL));
  } catch (error) {
    console.error("Koirapuistot API virhe:", error);
    res.status(502).json({
      error: "Koirapuistojen haku Tampereen WFS-palvelusta epäonnistui"
    });
  }
});

// Tampereen roska-astia-aineisto. Selain suodattaa koiriin liittyvät palvelut.
app.get("/api/koirapalvelut", async (req, res) => {
  try {
    res.json(await getCachedGeoJson("services", DOG_BINS_URL));
  } catch (error) {
    console.error("Koirapalvelut API virhe:", error);
    res.status(502).json({
      error: "Koirapalvelujen haku Tampereen WFS-palvelusta epäonnistui"
    });
  }
});

// OpenStreetMapista haettavat, ennalta rajatut Zyke Dogs -palvelukategoriat.
app.get("/api/dogs/places", dogPlacesHandler);


// Render käyttää omaa porttia
const PORT = process.env.PORT || 3000;


app.listen(PORT, () => {

  console.log(
    "Serveri käynnissä portissa " + PORT
  );

});
