# Third-party notices

Logic Importer's own code is Apache-2.0 (see LICENSE). These parts keep their own terms.

## In the released Add On (`.lunaaddon`)

| Component | Version | Terms |
|---|---|---|
| [LUNA Builder SDK](https://github.com/uaudio-labs/luna-builder-sdk) (`vendor/luna.global.js`), © 2026 Universal Audio, Inc. | 3.1.2 Update 1, commit `62b8d38` | Apache-2.0 **plus Universal Audio's Supplemental Terms**. Copies of LICENSE, NOTICE and SUPPLEMENTAL-TERMS.md are in `licenses/`. |

`add-on/.npmrc`, `add-on/vitest.config.js` and parts of the page's connection code started from
the SDK's Add On template.

## In the helper installer (`.pkg`)

| Component | Version | Licence |
|---|---|---|
| [logicxkit](https://github.com/phierceweb/logicxkit), © 2026 Mike Farr | commit `d2af856` | Apache-2.0 (LICENSE and NOTICE installed) |
| groovebin | 0.6.0 | Apache-2.0 |
| pw-foundation | 1.0.0 | Apache-2.0 |
| PyYAML | 6.0.4 | MIT |
| rich | 15.0.0 | MIT |
| structlog | 26.1.0 | MIT or Apache-2.0 |
| nanoid (Python) | 2.0.0 | MIT |
| markdown-it-py, mdurl | 4.3.0, 0.1.2 | MIT |
| Pygments | 2.21.0 | BSD-2-Clause |
| python-dotenv | 1.2.4 | BSD-3-Clause |
| Python (CPython) and the libraries shipped with it | the building Mac's version | PSF License and the licences it lists |
| PyInstaller bootloader | 6.22.3 | GPL-2.0-or-later with an exception that allows distributing the built application |

The installer places the licence files it finds in
`/Library/Application Support/Logic Importer/licenses`.

## Test data

`add-on/tests/fixtures/*.json` were produced by converting sample Logic projects from
logicxkit's test corpus (Apache-2.0, © 2026 Mike Farr). They were modified: converted to this
project's format and audio paths replaced. Their audio refers to generated test tones, which
are not included. `converter/test_helper.py` reads one corpus sample, fetched by `setup.sh`.
