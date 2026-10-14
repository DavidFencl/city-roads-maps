# Draw every road

[city-roads-maps](https://davidfencl.github.io/city-roads-maps/) draws every road in a city as line art. Name a place, and the app looks it up, downloads its streets from OpenStreetMap, and paints them on a square plate. You can change the colors, zoom in, include a band of roads outside the city, and save a PNG or SVG poster of the full map.

## Why this exists

This app follows [city-roads](https://github.com/anvaka/city-roads) by Andrei Kashcha, which you can use at [anvaka.github.io/city-roads](https://anvaka.github.io/city-roads/). That project is the original: type a city, and it renders every road from OpenStreetMap. It is MIT licensed, and it is the reason this repository exists.

The code here is a separate Vite and TypeScript site, written while using that idea. It keeps the same basic act, drawing a whole city’s streets as a picture, and adds the pieces that came up along the way:

- Roads appear as each map tile arrives, with a badge while later tiles are still loading.
- A margin adds roads outside the city boundary.
- You can zoom, pan, and pinch, then fit the city again. Export saves the full map, not the current zoom.
- Presets and a custom background and road color.
- This browser keeps a finished city and its tiles for 12 hours. The same tiles are stored for two weeks in a shared cache, so another visitor does not download them from Overpass again.

A large city such as Prague is split into tiles. One OpenStreetMap query for the whole city times out. The public Overpass servers are often busy, so the first load of a big city can take minutes. A city this browser has already stored opens from that local copy.

city-roads remains the project to use and cite for the idea. This repository is David Fencl’s own version, left public so the page and the source stay available.

## Run the app

Install dependencies.

```sh
npm install
```

Start the local server.

```sh
npm run dev
```

Open the URL Vite prints, usually http://localhost:5173. Type a city in the search box and press **Draw**.

Scroll or pinch the map to zoom, and drag to move it. **Fit** shows the whole city again. **Outside the city** sets the margin, in kilometres. **Custom** keeps a background and road color you pick under Custom colors.

Build the production bundle.

```sh
npm run build
```

Fetch Prague from OpenStreetMap and write SVG plus PNG samples.

```sh
npm run verify
```

`npm run verify` asks Nominatim and Overpass. Large cities can take a few minutes. Files land in `verify-output/`, which git ignores.

The shared cache is a Cloudflare Worker in `worker/`, at `https://city-roads-maps.david-fencl98.workers.dev`. It stores a successful tile for two weeks. If that Worker is down, the app asks Overpass directly.

## Credits

Inspired by [city-roads](https://github.com/anvaka/city-roads), MIT, Copyright (c) 2020-2026 Andrei Kashcha. The city-roads license text is in NOTICE.

Map data © OpenStreetMap contributors, ODbL. See the [OpenStreetMap copyright page](https://www.openstreetmap.org/copyright).

This repository is MIT, Copyright (c) 2026 David Fencl. See LICENSE.
