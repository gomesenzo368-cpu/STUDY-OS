import { createClient } from '@supabase/supabase-js'

const rawUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseUrl = rawUrl?.replace(/\/+$/, '').replace(/\/rest\/v1$/, '')
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Configuration Supabase manquante. Vérifie VITE_SUPABASE_URL et VITE_SUPABASE_PUBLISHABLE_KEY.')
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
})
