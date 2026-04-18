// test.js — quick smoke test outside of Nuvio
// Usage: bun test.js

import { getStreams } from "./src/vixsrc/index.js";

const TESTS = [
  { label: "Oppenheimer (movie)",     tmdbId: "872585", mediaType: "movie" },
  { label: "Breaking Bad S01E01 (tv)", tmdbId: "1396",  mediaType: "tv", season: 1, episode: 1 },
];

for (const t of TESTS) {
  console.log(`\n--- ${t.label} ---`);
  getStreams(t.tmdbId, t.mediaType, t.season, t.episode)
    .then(streams => {
      if (!streams.length) {
        console.log("No streams returned");
        return;
      }
      streams.forEach(s => {
        console.log(`name:    ${s.name}`);
        console.log(`title:   ${s.title}`);
        console.log(`quality: ${s.quality}`);
        console.log(`url:     ${s.url}`);
      });
    })
    .catch(err => console.error("Error:", err.message));
}
