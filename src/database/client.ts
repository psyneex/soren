import { createClient } from '@supabase/supabase-js';
import { loadEnvironment } from '../config/env.js';

export function createDatabaseClient() {
  const environment = loadEnvironment();
  return createClient(environment.SUPABASE_URL, environment.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
