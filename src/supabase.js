// Optional Supabase integration. The app works without it; when
// VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are set it loads
// assumption overrides (tariffs etc.) and can save shortlists.
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = url && key ? createClient(url, key) : null;

export async function loadAssumptionOverrides() {
  if (!supabase) return null;
  const { data, error } = await supabase.from('assumptions').select('key, value');
  if (error) throw error;
  return Object.fromEntries(data.map((r) => [r.key, Number(r.value)]));
}

export async function saveShortlist(township, sites) {
  if (!supabase) throw new Error('Supabase not configured');
  const rows = sites.map((s, i) => ({
    township,
    rank: i + 1,
    osm_id: s.id,
    name: s.name,
    category: s.category,
    longitude: s.position[0],
    latitude: s.position[1],
    system_kwp: Math.round(s.kwp * 10) / 10,
    annual_kwh: Math.round(s.kwh),
    payback_years: Number.isFinite(s.payback) ? Math.round(s.payback * 10) / 10 : null,
    co2_tonnes: Math.round(s.co2 * 10) / 10,
    score: Math.round(s.score),
    flags: s.flags
  }));
  const { error } = await supabase.from('shortlist_sites').insert(rows);
  if (error) throw error;
}
