# Draw every road

The site is published at [https://davidfencl.github.io/city-roads-maps/](https://davidfencl.github.io/city-roads-maps/).

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

Build the production bundle.

```sh
npm run build
```

Fetch Prague from OpenStreetMap and write SVG plus PNG samples.

```sh
npm run verify
```

`npm run verify` asks Nominatim and Overpass. Large cities can take a few minutes. Files land in `verify-output/`, which git ignores.

## Credits

Inspired by [city-roads](https://github.com/anvaka/city-roads), MIT, Copyright (c) 2020-2026 Andrei Kashcha. The city-roads license text is in NOTICE.

Map data © OpenStreetMap contributors, ODbL. See the [OpenStreetMap copyright page](https://www.openstreetmap.org/copyright).

This repository is MIT, Copyright (c) 2026 David Fencl. See LICENSE.
