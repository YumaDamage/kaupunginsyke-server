const test = require("node:test");
const assert = require("node:assert/strict");
const { parseBbox, registryPlaces, createDogPlacesHandler } = require("../dog-places.js");

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test("server-repon oma rekisteri latautuu ilman ulkopuolisia polkuja", function() {
  const bbox = parseBbox("61.36,23.54,61.71,24.02");
  const items = registryPlaces("dog_forest", bbox);
  assert.equal(items.length, 2);
  assert.ok(items.every(function(item) { return item.type === "dog_forest"; }));
});

test("kaikki rekisterikategoriat säilyttävät items-vastaussopimuksen ilman Overpass-hakua", async function() {
  const expectedCounts = { dog_swimming_official: 1, dog_swimming_community: 0, dog_forest: 2 };
  for (const [category, expectedCount] of Object.entries(expectedCounts)) {
    const res = response();
    let externalFetches = 0;
    const handler = createDogPlacesHandler(async function() { externalFetches += 1; return []; });
    await handler({ query: { category, bbox: "61.36,23.54,61.71,24.02" } }, res);
    assert.equal(res.statusCode, 200, category);
    assert.ok(Array.isArray(res.body.items), category);
    assert.equal(res.body.items.length, expectedCount, category);
    assert.equal(externalFetches, 0, category);
  }
});
