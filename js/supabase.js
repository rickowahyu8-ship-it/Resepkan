
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Ganti dengan Project URL milikmu dari dashboard Supabase.
const SUPABASE_URL = 'https://hhzlgamhnewevndcpzln.supabase.co';

// Ganti dengan Publishable Key milikmu.
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_7YlpgqR5KScdVG9sgA_dJA_rdoCO9ux';

export const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY
);
