# Dynasty GM

A browser app for a Sleeper dynasty fantasy football team. It loads your league live from the Sleeper API, values every player and pick with FantasyCalc dynasty values for your league's format, and suggests trades depending on whether you're contending or rebuilding.

There is no server and no build step. It's static HTML and JavaScript, hosted on GitHub Pages.

## What it shows
- **Roster:** every player with lineup slot, age and stage on the age curve, points per game in your league's scoring, dynasty value, 30-day value trend, and a buy/hold/sell call for your chosen direction.
- **Starter strength:** the value of your starters at each position compared with the league median.
- **Draft picks:** picks for the next three drafts, including traded picks. Next year's picks get a projected slot based on the original team's strength.
- **Contention window:** projected roster value for this season and the next three, using position-specific age curves.
- **Trade ideas:** in contend mode, starters on non-contending teams who would improve your lineup, paid for with picks and bench players. In rebuild mode, your players at or past their prime, sold to contenders who would start them, for young players and picks. Press **Try it** to see your team with the trade made.
- **League:** standings, team values, starter age and each team's likely direction.

## Settings
The defaults are Sleeper user `komestat` and the league whose name contains "Happy Hour". You can change both in the Settings tab. Settings are saved in your browser.

## Development
Serve the folder with any static server, for example `python3 -m http.server`, and open http://localhost:8000.

`node test/smoke.mjs` runs a headless smoke test against generated league data (needs Playwright). Add `--no-values` to test the fallback used when FantasyCalc is unreachable.
