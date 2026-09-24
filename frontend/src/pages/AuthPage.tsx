import { FormEvent, useState } from 'react'
import { ArrowRight, CheckCircle2, Eye, EyeOff, LockKeyhole, Mail, Moon, Sun } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useI18n } from '../i18n/i18n'

type Props = { dark: boolean; onToggleTheme: () => void }

export default function AuthPage({ dark, onToggleTheme }: Props) {
  const { t } = useI18n()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setMessage('')
    if (!email.trim()) return setError(t('auth.emailRequired'))
    if (!/^\S+@\S+\.\S+$/.test(email)) return setError(t('auth.emailInvalid'))
    if (password.length < 6) return setError(t('auth.passwordShort'))
    if (mode === 'signup' && password !== confirmation) return setError(t('auth.passwordMismatch'))
    setLoading(true)
    try {
      const result = mode === 'login' ? await supabase.auth.signInWithPassword({ email: email.trim(), password }) : await supabase.auth.signUp({ email: email.trim(), password })
      if (result.error) throw result.error
      if (mode === 'signup' && !result.data.session) setMessage(t('auth.accountCreated'))
    } catch (err) {
      setError(err instanceof Error && err.message.includes('Invalid login') ? t('auth.invalidLogin') : err instanceof Error ? err.message : t('auth.genericError'))
    } finally { setLoading(false) }
  }

  return <main className="auth-shell"><div className="auth-top"><div className="brand"><div className="brand-mark">S</div><div><strong>STUDY OS</strong><span>{t('brand.tagline')}</span></div></div><button className="icon-button" aria-label={t('top.theme')} onClick={onToggleTheme}>{dark ? <Sun size={18} /> : <Moon size={18} />}</button></div><section className="auth-card"><div className="auth-intro"><span className="auth-eyebrow">{t('brand.study')}</span><h1>{mode === 'login' ? t('auth.loginTitle') : t('auth.signupTitle')}</h1><p>{mode === 'login' ? t('auth.loginIntro') : t('auth.signupIntro')}</p></div><div className="auth-tabs"><button className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError(''); setMessage('') }}>{t('auth.login')}</button><button className={mode === 'signup' ? 'active' : ''} onClick={() => { setMode('signup'); setError(''); setMessage('') }}>{t('auth.signup')}</button></div><form className="auth-form" onSubmit={submit}><label>{t('auth.email')}<div className="input-wrap"><Mail size={17} /><input type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" /></div></label><label>{t('auth.password')}<div className="input-wrap"><LockKeyhole size={17} /><input type={showPassword ? 'text' : 'password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={event => setPassword(event.target.value)} placeholder={t('auth.passwordHint')} /><button type="button" aria-label={showPassword ? t('auth.hidePassword') : t('auth.showPassword')} onClick={() => setShowPassword(value => !value)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>{mode === 'signup' && <label>{t('auth.confirmPassword')}<div className="input-wrap"><LockKeyhole size={17} /><input type={showPassword ? 'text' : 'password'} autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} placeholder={t('auth.passwordHint')} /></div></label>}{error && <div className="auth-error" role="alert">{error}</div>}{message && <div className="auth-success" role="status"><CheckCircle2 size={16} />{message}</div>}<button className="primary-button auth-submit" disabled={loading}>{loading ? t('loading.space') : mode === 'login' ? t('auth.submitLogin') : t('auth.submitSignup')}<ArrowRight size={17} /></button></form></section></main>
}
