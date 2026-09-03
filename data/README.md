# data/

This directory holds the self-hosted geolocation database used by
`lib/geolocation.js` (v1.1.9+).

Download `GeoLite2-Country.mmdb` from your MaxMind account and place it
here — see the "Self-hosted geolocation" section of the root `README.md`
for the exact steps. The app runs fine without it (every visitor just
sees USD pricing until the file is added), so this placeholder file
exists only so the `data/` directory itself is tracked by git before the
real database file is added.

Expected path: `data/GeoLite2-Country.mmdb`
