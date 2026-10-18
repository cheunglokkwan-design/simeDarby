# Team tasks that need a person

Work on branch `ccr-75323f55-j99ri8` (it already contains everything from `solar-demo`).

## 1. Car-park detector: allow network access, or run it on a laptop

**Option A: let Claude run it in the cloud session.**
1. In the Claude Code session, open the cloud environment menu in the session's title bar and choose **Edit**.
2. Under **Network access**, use the *Limited* (or *Custom*) level and add these to **Allowed domains**,
   leaving *Allow package managers* ticked:
   ```
   server.arcgisonline.com
   github.com
   objects.githubusercontent.com
   release-assets.githubusercontent.com
   download.pytorch.org
   ```
3. Save, then tell Claude "hosts allowed". If the session still can't reach them, start a new session
   on the same environment.

Docs: https://code.claude.com/docs/en/cloud-environments#network-access

**Option B: run it on a laptop** (Python 3.11+, git; roughly 10–30 min of CPU per township).
```bash
git clone https://github.com/cheunglokkwan-design/simeDarby && cd simeDarby
git checkout ccr-75323f55-j99ri8
cd pipeline
python -m venv .venv && source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install -e ".[dev,detect]"
for t in elmina ara-damansara bandar-bukit-raja; do
  solar-mapper run --township $t                  # downloads Overture data the detector needs
  solar-mapper detect-carparks --township $t      # add --max-chips 5 first for a quick test
  solar-mapper export-app --township $t
done
cd .. && git add data/processed public/data && git commit -m "Add AI-detected car parks" && git push
```
Each township's `data/processed/<id>/carpark_detection_summary.json` shows how many vehicles and
car parks were found, and how many already-mapped car parks the detector confirmed.

## 2. Solar yield (PVOUT) from Global Solar Atlas, about 5 minutes

1. Open https://globalsolaratlas.info.
2. Paste each coordinate into the search box and press Enter:

   | Township | Coordinates |
   |---|---|
   | City of Elmina | `3.190, 101.513` |
   | Ara Damansara | `3.110, 101.583` |
   | Bandar Bukit Raja | `3.094, 101.440` |

3. In the left panel, under **Map data**, read **Specific photovoltaic power output (PVOUT specific)**,
   making sure the unit says *kWh/kWp per year* (switch from *per day* if needed).
4. Send the three numbers, or a screenshot, to Claude. It updates `specificYield` in
   `src/solar.js` and `pipeline/config/assumptions.yaml` and regenerates the outputs.

## 3. Height spot-checks, about 20–30 minutes per township

Files: `data/processed/<township>/spotcheck_heights.csv`, one per township, 20 rows each.

1. Open the CSV in Google Sheets (*File → Import → Upload*) or Excel.
2. For each row, open `street_view_url`. Count the building's storeys above ground and type the
   number in `observed_storeys`. If Street View can't see it, use `map_url` (satellite or 3D view),
   or leave it blank and write why in `notes`.
   - Factory and warehouse sheds count as 1 storey, however tall.
   - Most terrace and semi-detached houses are 2.
   - Shop-offices are usually 3–4.
3. Download as CSV with the same columns. Upload it to the same path on the branch (GitHub web:
   *Add file → Upload files*, branch `ccr-75323f55-j99ri8`) or commit it.
4. Tell Claude. It runs `solar-mapper spotcheck-score`. The target is at least 16 of 20 within ±1 storey.

## 4. Shortlist labelling (Phase 7), about 30 minutes per township

`data/processed/<township>/validation_sheet.csv` lists 40 shuffled sites with no scores. For each,
open `satellite_url` and set `label` to `good`, `maybe` or `poor`, answering: *"Would I shortlist this
roof or car park for a solar feasibility study?"* Then fill in `labeller` and save and upload as above.
Claude runs `npm run validate`. Ideally an SDP mentor labels at least one township. See
[validation.md](validation.md).

## 5. Live link on Vercel, about 10 minutes

1. Go to https://vercel.com, click **Sign Up**, then **Continue with GitHub**. Use an account that can see
   `cheunglokkwan-design/simeDarby`.
2. Click **Add New… → Project**, then **Import** next to `simeDarby` (grant Vercel access to the repo if asked).
3. Check the settings. These are the defaults Vercel detects for Vite:

   | Setting | Value |
   |---|---|
   | Framework preset | Vite |
   | Root directory | `./` |
   | Build command | `npm run build` |
   | Output directory | `dist` |

4. Optional: add environment variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`
   (publishable key only, never the secret).
5. Click **Deploy**.
6. Vercel's production deployment follows `main`, but our work is on `ccr-75323f55-j99ri8`. Either:
   - ask Claude to open a pull request into `main` and merge it; or
   - set **Project → Settings → Git → Production Branch** to `ccr-75323f55-j99ri8`, then **Redeploy**.
7. Send the `https://….vercel.app` link to Claude to test. Every later push redeploys automatically.

Vercel's free Hobby plan is meant for non-commercial projects, which suits a university prototype.
Netlify works the same way if you prefer it.
