# HungerConnect: setup and deployment

## What is here
- `../hungerconnect.html`: the working front end demo (browser-only data).
- `schema.sql`, `seed.sql`: PostgreSQL / Supabase database, access policies, sample data.
- `server/`: Express API (JWT auth via Supabase, role checks, atomic claiming, validation, expiry).

## 1. Database
1. Create a Supabase project. In **SQL editor** run `schema.sql`.
2. In **Authentication** create four users (donor, NGO, volunteer, admin). Put their UUIDs into `seed.sql` and run it.
3. In **Storage** create a private bucket `food-images`; allow only `image/jpeg, image/png, image/webp`, max 5 MB.
4. Optional: enable `pg_cron` and schedule the expiry job in `schema.sql` (the API also expires listings every 5 min).

## 2. API
```
cd server && cp ../.env.example .env   # fill in SUPABASE_* and FRONTEND_URL
npm install && npm run dev             # http://localhost:4000/api/health
```
Never expose `SUPABASE_SERVICE_ROLE_KEY` outside the server. Deploy `server/` to Render, Railway or Fly.io with the same variables.

## 3. Front end
The supplied page is a static demo. For production, port its screens to React + Vite + Tailwind, call the API above with the user's Supabase access token in `Authorization: Bearer ...`, and deploy to Vercel (`VITE_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`). Use Leaflet with OpenStreetMap tiles for the map from each listing's `lat`/`lng`.

## Impact method
Meals = donor-declared servings on delivered donations. Kilograms use measured weights where given, otherwise 0.4 kg per serving (an estimate). The API reports measured and estimated kg separately.

## Food safety
Listings require preparation time, storage info and a safety confirmation. Cooked food must be donated within 24 h of preparation. Expired listings cannot be requested. Only admin-verified NGOs can request. Donors must follow local food-safety law; the platform does not certify food.

## Known limits
Not yet built: React/Vite port, Leaflet map, edit-listing endpoint, automated tests. Review RLS policies before launch.
