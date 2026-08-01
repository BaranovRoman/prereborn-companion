# Anti-snipe minimap references

These are the intended kind of anti-streamsniping preset: a believable Dota 2
minimap covered with fake Observer Wards so the real ward positions cannot be
identified from the broadcast.

The freshest confirmed clean base is `dota-7.40-minimap.png` (1024×1024). A
public 7.41 version was requested in the source discussion after that patch was
released, but was not published there. If the 7.41 series did not alter terrain,
the 7.40 asset is the appropriate current geometry to build on.

## Collected references

| File | Coverage | Notes |
| --- | --- | --- |
| `dota-7.40-minimap.png` | Clean current base | Freshest confirmed public game asset; use this to create the real presets. |
| `dota-7.40-fake-wards-dense-a.png` | Full, opaque | Dense layout A for a static preset or cross-fade rotation. |
| `dota-7.40-fake-wards-dense-b.png` | Full, opaque | Dense layout B for a static preset or cross-fade rotation. |
| `dota-7.40-fake-wards-dense-c.png` | Full, opaque | Dense layout C for a static preset or cross-fade rotation. |
| `dota-7.40-fake-wards-balanced-a.png` | Full, 90% opacity | Viewer-friendly layout A with 44 fake wards. |
| `dota-7.40-fake-wards-balanced-b.png` | Full, 90% opacity | Viewer-friendly layout B with 44 fake wards. |
| `dota-7.27-full.png` | Full, opaque | Includes both bases and blocks almost all live minimap information. |
| `dota-7.27-full-90.png` | Full, 90% opacity | Lets attentive viewers retain a small amount of live context. |
| `dota-7.27-rounded.png` | Rounded/no bases, opaque | Leaves base corners available while hiding common warding areas. |
| `dota-7.27-rounded-90.png` | Rounded/no bases, 90% opacity | Less destructive viewer experience, but leaks more information. |
| `dota-7.29-75.png` | Approx. 75% cover | Denser fake wards and a more organic partially transparent silhouette. |

The files are historical patch references, not production-ready current-map
assets. The final presets should be recreated on the current Dota map source
and exported as original project derivatives with documented provenance.

## Product direction

Recommended preset family:

1. **Dense** — 100% opacity, fake wards across the whole playable map. Three
   ready layouts (`dense-a` through `dense-c`) can be rotated later.
2. **Balanced** — 90% opacity, fake wards across the whole map. Two ready
   layouts (`balanced-a` and `balanced-b`) are included.
3. **Core vision** — cover jungle, river, Roshan and Tormentor approaches while
   leaving base corners less obstructed.
4. **Shifting wards** — several believable ward layouts cross-faded every
   20–40 seconds so a sniper cannot memorize which icons are part of the mask.

For animation, ward changes should be slow and infrequent. A hard jump every
few seconds would distract viewers; a short opacity cross-fade between static
layouts preserves the illusion of a real minimap.

Regenerate all five current-map presets with:

```sh
python3 scripts/generate-anti-snipe-presets.py
```
