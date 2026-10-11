# Sample gap-analysis report

Generated 2026-10-11 from `docs/sample-cameras.csv` (12 cameras) by `npm run registry-gap-report`. A sample: the data is the sample dataset, not a real deployment.

## Summary

| Finding | Count |
|---|---|
| Cameras in the registry | 12 |
| Without coordinates (not on the map) | 2 |
| Offline or degraded | 4 |
| Ageing (installed more than 5 years ago) | 5 |
| With incomplete metadata | 2 |
| Uncovered squares (no camera within 300 m) | 2430 of 2520 (96.4%) |

## Cameras by department (fewest first)

| Department | Cameras |
|---|---|
| Traffic Police | 1 |
| Health Department | 1 |
| Railway Police | 1 |
| Heritage Department | 1 |
| Municipal Corporation | 2 |
| Industrial Estate Authority | 2 |
| Transport Department | 4 |

## Not on the map

- Railway Overbridge (Railway Police)
- Old Town Square (Heritage Department)

## Offline or degraded

- Central Bus Stand Gate 2: degraded, needs_maintenance
- Railway Overbridge: offline, needs_maintenance
- Old Town Square: offline, decommissioned
- Warehouse Perimeter: degraded, needs_maintenance

## Ageing infrastructure

- Central Bus Stand Gate 2: installed 2018-03-10
- Railway Overbridge: installed 2017-08-05
- Industrial Gate A: installed 2021-09-12
- Old Town Square: installed 2015-01-01
- Warehouse Perimeter: installed 2019-04-22

## Incomplete metadata

- Railway Overbridge (Railway Police): missing location
- Old Town Square (Heritage Department): missing location

## Uncovered zones

The area the located cameras span (their bounding box plus one radius) was cut into 2520 squares of 170 m; 3.6% are within 300 m of a camera. The 10 emptiest uncovered squares (centre, and the distance to the nearest camera):

- 13.04317, 77.55802: 4122 m from the nearest camera
- 13.04317, 77.55959: 4049 m from the nearest camera
- 13.04317, 77.56115: 3982 m from the nearest camera
- 13.04164, 77.55802: 3970 m from the nearest camera
- 13.04317, 77.56272: 3921 m from the nearest camera
- 13.04164, 77.55959: 3895 m from the nearest camera
- 13.04317, 77.56429: 3867 m from the nearest camera
- 13.04317, 77.58466: 3834 m from the nearest camera
- 13.04164, 77.56115: 3825 m from the nearest camera
- 13.04011, 77.55802: 3821 m from the nearest camera

## What this report cannot say

- It shows where the registry has **no camera**, not where a camera is needed: roads, buildings, crowds and risk are not in the data.
- Coverage is a circle of fixed radius around each camera; real fields of view depend on lens, mounting height and obstructions.
- A camera with no coordinates cannot be counted as covering anything.
- Connectivity status here is what the registry record says, not a live check (see the Feed for live state).

