const express = require("express");
const cors = require("cors");

const app = express();

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


// Render käyttää omaa porttia
const PORT = process.env.PORT || 3000;


app.listen(PORT, () => {

  console.log(
    "Serveri käynnissä portissa " + PORT
  );

});
