const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());

app.get("/", (req,res)=>{
  res.send("KaupunginSyke API toimii");
});

app.get("/api/tapahtumat", async (req, res) => {

  try {

    const vastaus = await fetch(
      "https://tapahtumat.tampere.fi/api/collection/634844c32f41a024ee51a234/content?lang=fi&country=FI&e=24.02&n=61.71&s=61.36&w=23.54&sort=startDate"
    );

    const data = await vastaus.json();

    res.json(data);

  } catch (error) {

    console.error(error);
    res.status(500).send("Virhe tapahtumissa");

  }

});

