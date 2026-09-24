import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { setLanguage, t } from '../i18n/i18n'

type ProfileSummary = { display_name: string; language?: string | null }
type AuthContextValue = { session: Session | null; user: User | null; profile: ProfileSummary | null; loading: boolean; error: string; signOut: () => Promise<void> }
const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<ProfileSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void supabase.auth.getSession().then(async ({ data, error: sessionError }) => {
      if (!active) return
      if (sessionError) setError(t('errors.server'))
      setSession(data.session)
      if (data.session?.user) {
        const { data: profileData } = await supabase.from('profiles').select('display_name, language').eq('user_id', data.session.user.id).maybeSingle()
        if (active) { setProfile(profileData); if (profileData?.language) setLanguage(profileData.language) }
      }
      setLoading(false)
    }).catch(() => {
      if (active) { setError(t('errors.server')); setLoading(false) }
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setProfile(null)
      if (nextSession?.user) void supabase.from('profiles').select('display_name, language').eq('user_id', nextSession.user.id).maybeSingle().then(({ data: profileData }) => { if (active) { setProfile(profileData); if (profileData?.language) setLanguage(profileData.language) } })
      setError('')
      setLoading(false)
    })
    return () => { active = false; listener.subscription.unsubscribe() }
  }, [])
  const signOut = async () => { const result = await supabase.auth.signOut(); if (result.error) throw result.error }
  return <AuthContext.Provider value={{ session, user: session?.user ?? null, profile, loading, error, signOut }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth doit être utilisé dans AuthProvider.')
  return context
}
