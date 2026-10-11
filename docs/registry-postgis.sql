-- Registry in PostgreSQL + PostGIS (Model 1's suggested store).
-- STATUS: a design and a set of queries. NOT wired into the app (the registry is read and written in Firestore today) and NOT run against any
-- database. Run it on a database where the PostGIS extension is allowed (Neon supports it) after reading it once.

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS registry_cameras (
  id                  text PRIMARY KEY,
  user_id             text NOT NULL,
  name                text NOT NULL,
  department          text,
  ownership           text,
  camera_type         text,
  connectivity_status text NOT NULL DEFAULT 'unknown',
  maintenance_status  text NOT NULL DEFAULT 'operational',
  install_date        date,
  storage_details     text,
  onboarded_via       text,
  geom                geography(Point, 4326),          -- lng, lat; null while the camera has no coordinates
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS registry_cameras_geom_idx ON registry_cameras USING gist (geom);
CREATE INDEX IF NOT EXISTS registry_cameras_dept_idx ON registry_cameras (department);
CREATE INDEX IF NOT EXISTS registry_cameras_status_idx ON registry_cameras (connectivity_status);

-- Insert or update one camera (lng first: PostGIS takes x, y).
-- INSERT INTO registry_cameras (id, user_id, name, department, geom) VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography)
--   ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, department = EXCLUDED.department, geom = EXCLUDED.geom, updated_at = now();

-- Cameras inside a bounding box (what GET /api/registry/cameras?bbox= does in application code).
-- SELECT id, name FROM registry_cameras WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)::geography;

-- Cameras within 500 m of a point.
-- SELECT id, name, ST_Distance(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS metres
--   FROM registry_cameras WHERE ST_DWithin(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 500) ORDER BY metres;

-- Uncovered zones: squares of a grid over an area (here a bounding box, 150 m squares) with no camera within 300 m.
-- The application does the same in memory (src/lib/registryReport.ts); in PostGIS it scales to a whole State.
-- WITH area AS (SELECT ST_Transform(ST_MakeEnvelope(77.50, 12.90, 77.70, 13.05, 4326), 3857) AS g),
--      grid AS (SELECT (ST_SquareGrid(150, g)).geom AS cell FROM area)
-- SELECT ST_Y(ST_Transform(ST_Centroid(cell), 4326)) AS lat, ST_X(ST_Transform(ST_Centroid(cell), 4326)) AS lng
--   FROM grid
--  WHERE NOT EXISTS (SELECT 1 FROM registry_cameras c WHERE c.geom IS NOT NULL
--          AND ST_DWithin(c.geom, ST_Transform(ST_Centroid(cell), 4326)::geography, 300));
-- (3857 distorts distances away from the equator: for a precise report use a local projection, e.g. UTM 43N = EPSG:32643 for Gujarat.)

-- Ageing infrastructure.
-- SELECT id, name, install_date FROM registry_cameras WHERE install_date < now() - interval '5 years' ORDER BY install_date;
